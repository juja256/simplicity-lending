use sqlx::PgPool;

use crate::models::{PrivateOfferModel, PrivateOfferUtxoModel};

use super::dto::{
    PrivateCandidate, PrivateCandidateDetails, PrivateCandidateList, PrivateCreationTx,
    PrivateUtxoDto,
};

const OFFER_COLUMNS: &str = r#"
    id, creation_txid, nonce, view_tag, encrypted_lender_key, first_input_txid,
    first_input_vout, borrower_nft_asset_id, lender_nft_asset_id, current_status,
    created_at_height, updated_at_height
"#;

#[tracing::instrument(name = "Fetching private candidates from DB", skip(db))]
pub async fn fetch_candidates(
    db: &PgPool,
    from_height: u64,
    to_height: Option<u64>,
    limit: u64,
    offset: u64,
) -> Result<PrivateCandidateList, sqlx::Error> {
    // Read the sync height first: the `BETWEEN ... upper` bound excludes rows indexed
    // afterwards, so only the status of a listed row can be newer than this height.
    let last_indexed =
        sqlx::query_scalar::<_, i64>("SELECT last_indexed_height FROM sync_state WHERE id = 1")
            .fetch_optional(db)
            .await?;

    let Some(last_indexed) = last_indexed else {
        return Ok(PrivateCandidateList {
            items: Vec::new(),
            total: 0,
            limit,
            offset,
            last_indexed_height: None,
        });
    };

    let from = i64::try_from(from_height).unwrap_or(i64::MAX);
    let upper = to_height
        .map(|h| i64::try_from(h).unwrap_or(i64::MAX))
        .map_or(last_indexed, |h| h.min(last_indexed));

    let total = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)::BIGINT FROM private_offers WHERE created_at_height BETWEEN $1 AND $2",
    )
    .bind(from)
    .bind(upper)
    .fetch_one(db)
    .await?;

    let rows = sqlx::query_as::<_, PrivateOfferModel>(&format!(
        "SELECT {OFFER_COLUMNS} FROM private_offers \
         WHERE created_at_height BETWEEN $1 AND $2 \
         ORDER BY created_at_height, id LIMIT $3 OFFSET $4"
    ))
    .bind(from)
    .bind(upper)
    .bind(i64::try_from(limit).unwrap_or(i64::MAX))
    .bind(i64::try_from(offset).unwrap_or(i64::MAX))
    .fetch_all(db)
    .await?;

    Ok(PrivateCandidateList {
        items: rows.into_iter().map(PrivateCandidate::from).collect(),
        total: total as u64,
        limit,
        offset,
        last_indexed_height: Some(last_indexed as u64),
    })
}

async fn fetch_offer(
    db: &PgPool,
    creation_txid: &[u8],
) -> Result<Option<PrivateOfferModel>, sqlx::Error> {
    sqlx::query_as::<_, PrivateOfferModel>(&format!(
        "SELECT {OFFER_COLUMNS} FROM private_offers WHERE creation_txid = $1"
    ))
    .bind(creation_txid)
    .fetch_optional(db)
    .await
}

#[tracing::instrument(
    name = "Fetching private candidate details from DB",
    skip(db, creation_txid)
)]
pub async fn fetch_candidate_details(
    db: &PgPool,
    creation_txid: &[u8],
) -> Result<Option<PrivateCandidateDetails>, sqlx::Error> {
    let Some(offer) = fetch_offer(db, creation_txid).await? else {
        return Ok(None);
    };
    let offer_id = offer.id;

    let utxos = sqlx::query_as::<_, PrivateOfferUtxoModel>(
        "SELECT offer_id, txid, vout, utxo_type, created_at_height, spent_txid, spent_at_height \
         FROM private_offer_utxos WHERE offer_id = $1 \
         ORDER BY created_at_height, vout",
    )
    .bind(offer_id)
    .fetch_all(db)
    .await?;

    Ok(Some(PrivateCandidateDetails {
        candidate: offer.into(),
        utxos: utxos.into_iter().map(PrivateUtxoDto::from).collect(),
    }))
}

#[tracing::instrument(name = "Fetching private creation tx from DB", skip(db, creation_txid))]
pub async fn fetch_creation_tx(
    db: &PgPool,
    creation_txid: &[u8],
) -> Result<Option<PrivateCreationTx>, sqlx::Error> {
    let tx = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT creation_tx FROM private_offers WHERE creation_txid = $1",
    )
    .bind(creation_txid)
    .fetch_optional(db)
    .await?;

    Ok(tx.map(|bytes| PrivateCreationTx {
        tx_hex: hex::encode(bytes),
    }))
}
