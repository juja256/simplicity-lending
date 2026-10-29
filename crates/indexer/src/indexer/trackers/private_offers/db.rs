use sqlx::{PgPool, Row};

use simplex::simplicityhl::elements::{AssetId, OutPoint, Txid, hashes::Hash, hex::ToHex};

use crate::{
    db::DbTx,
    indexer::{PrivateOfferWatchEntry, WatchCache},
    models::{PrivateOfferModel, PrivateOfferStatus, PrivateOfferUtxoModel, PrivateUtxoType},
};

#[tracing::instrument(name = "Loading unspent private offer UTXOs from DB", skip(db))]
pub async fn load_private_offer_utxos_cache(
    db: &PgPool,
) -> anyhow::Result<WatchCache<PrivateOfferWatchEntry>> {
    let rows = sqlx::query(
        r#"
        SELECT
            u.offer_id,
            u.utxo_type,
            u.txid,
            u.vout,
            o.borrower_nft_asset_id,
            o.lender_nft_asset_id
        FROM private_offer_utxos u
        JOIN private_offers o ON o.id = u.offer_id
        WHERE u.spent_txid IS NULL
        "#,
    )
    .fetch_all(db)
    .await
    .map_err(|e| {
        tracing::error!("Failed to load unspent private offer UTXOs from DB: {e:?}");
        e
    })?;

    let mut cache = WatchCache::with_capacity(rows.len());

    for row in &rows {
        let txid: Vec<u8> = row.try_get("txid")?;
        let vout: i32 = row.try_get("vout")?;
        let borrower_nft: Vec<u8> = row.try_get("borrower_nft_asset_id")?;
        let lender_nft: Vec<u8> = row.try_get("lender_nft_asset_id")?;

        cache.insert(
            OutPoint {
                txid: Txid::from_slice(&txid)?,
                vout: vout as u32,
            },
            PrivateOfferWatchEntry {
                offer_id: row.try_get("offer_id")?,
                utxo_type: row.try_get::<PrivateUtxoType, _>("utxo_type")?,
                borrower_nft: AssetId::from_slice(&borrower_nft)?,
                lender_nft: AssetId::from_slice(&lender_nft)?,
            },
        );
    }

    tracing::info!(
        utxos = rows.len(),
        "Warm-up: PrivateOffers WatchCache populated"
    );

    Ok(cache)
}

#[tracing::instrument(
    name = "Inserting private offer into DB",
    skip(sql_tx, offer, creation_tx),
    fields(created_at_height = %offer.created_at_height, txid = %offer.creation_txid.to_hex())
)]
pub async fn insert_private_offer(
    sql_tx: &mut DbTx<'_>,
    offer: &PrivateOfferModel,
    creation_tx: &[u8],
) -> Result<Option<i64>, sqlx::Error> {
    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO private_offers (
            creation_txid, creation_tx, nonce, view_tag, encrypted_lender_key,
            first_input_txid, first_input_vout, borrower_nft_asset_id, lender_nft_asset_id,
            current_status, created_at_height, updated_at_height
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (creation_txid) DO NOTHING
        RETURNING id
        "#,
    )
    .bind(&offer.creation_txid)
    .bind(creation_tx)
    .bind(&offer.nonce)
    .bind(offer.view_tag)
    .bind(&offer.encrypted_lender_key)
    .bind(&offer.first_input_txid)
    .bind(offer.first_input_vout)
    .bind(&offer.borrower_nft_asset_id)
    .bind(&offer.lender_nft_asset_id)
    .bind(offer.current_status)
    .bind(offer.created_at_height)
    .bind(offer.updated_at_height)
    .fetch_optional(&mut **sql_tx)
    .await
    .map_err(|e| {
        tracing::error!("Failed to insert private offer to the DB: {e:?}");
        e
    })?;

    Ok(id)
}

#[tracing::instrument(
    name = "Inserting private offer UTXO into DB",
    skip(sql_tx, utxo),
    fields(offer_id = %utxo.offer_id, txid = %utxo.txid.to_hex(), vout = %utxo.vout)
)]
pub async fn insert_private_offer_utxo(
    sql_tx: &mut DbTx<'_>,
    utxo: &PrivateOfferUtxoModel,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO private_offer_utxos (
            offer_id, utxo_type, txid, vout, created_at_height, spent_txid, spent_at_height
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(utxo.offer_id)
    .bind(utxo.utxo_type)
    .bind(&utxo.txid)
    .bind(utxo.vout)
    .bind(utxo.created_at_height)
    .bind(&utxo.spent_txid)
    .bind(utxo.spent_at_height)
    .execute(&mut **sql_tx)
    .await
    .map_err(|e| {
        tracing::error!("Failed to insert private offer UTXO to the DB: {e:?}");
        e
    })?;

    Ok(())
}

#[tracing::instrument(
    name = "Marking private offer UTXO as spent",
    skip(sql_tx),
    fields(outpoint = %outpoint, block_height = %block_height, spent_txid = %txid)
)]
pub async fn spend_private_offer_utxo(
    sql_tx: &mut DbTx<'_>,
    outpoint: &OutPoint,
    block_height: u64,
    txid: Txid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE private_offer_utxos
        SET spent_txid = $1, spent_at_height = $2
        WHERE txid = $3 AND vout = $4
        "#,
    )
    .bind(txid.to_byte_array().to_vec())
    .bind(block_height as i64)
    .bind(outpoint.txid.to_byte_array().to_vec())
    .bind(outpoint.vout as i32)
    .execute(&mut **sql_tx)
    .await
    .map_err(|e| {
        tracing::error!("Failed to mark private offer UTXO as spent: {e:?}");
        e
    })?;

    Ok(())
}

#[tracing::instrument(
    name = "Updating private offer status in DB",
    skip(sql_tx),
    fields(offer_id = %offer_id, status = ?status, block_height = %block_height)
)]
pub async fn update_private_offer_status(
    sql_tx: &mut DbTx<'_>,
    offer_id: i64,
    status: PrivateOfferStatus,
    block_height: u64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE private_offers
        SET current_status = $1, updated_at_height = $2
        WHERE id = $3
        "#,
    )
    .bind(status)
    .bind(block_height as i64)
    .bind(offer_id)
    .execute(&mut **sql_tx)
    .await
    .map_err(|e| {
        tracing::error!("Failed to update private offer status: {e:?}");
        e
    })?;

    Ok(())
}
