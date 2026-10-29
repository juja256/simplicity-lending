mod common;

use lending_indexer::models::{PrivateOfferStatus, PrivateUtxoType};
use private_lending_core::{Marker, find_offer};
use serial_test::serial;
use simplex::simplicityhl::elements::{
    OutPoint, Script,
    confidential::Nonce,
    hashes::Hash,
    secp256k1_zkp::{PublicKey, SECP256K1},
};

use crate::common::{
    acceptance_tx, block_processor, cancellation_tx, claim_tx, index_block, lending_key,
    liquidation_tx, normal_output, outpoint_with_txid_byte, private_creation, private_offer_count,
    private_offer_row, private_program_id, private_utxo_rows, repayment_tx, test_pool,
    tx_with_input,
};

#[tokio::test]
#[serial]
async fn private_offer_creation_is_indexed() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let creation = private_creation(
        &lending_key(1),
        &lending_key(2),
        outpoint_with_txid_byte(0x31, 7),
    );
    index_block(&mut processor, 100, std::slice::from_ref(&creation.tx)).await?;

    let found = find_offer(&creation.tx, private_program_id()).unwrap();
    let row = private_offer_row(&pool, creation.tx.txid())
        .await?
        .expect("indexed");
    let nonce = PublicKey::from_secret_key(SECP256K1, &creation.offer.ephemeral_sk);
    assert_eq!(row.nonce, nonce.serialize().to_vec());
    assert_eq!(row.view_tag, i16::from(found.marker.view_tag));
    assert_eq!(
        row.encrypted_lender_key,
        found.marker.encrypted_lender_key.to_vec()
    );
    assert_eq!(
        row.first_input_txid,
        found.first_input.txid.to_byte_array().to_vec()
    );
    assert_eq!(row.first_input_vout, 7);
    assert_eq!(
        row.borrower_nft_asset_id,
        found.borrower_nft.into_inner().0.to_vec()
    );
    assert_eq!(
        row.lender_nft_asset_id,
        found.lender_nft.into_inner().0.to_vec()
    );
    assert_eq!(
        (
            row.current_status,
            row.created_at_height,
            row.updated_at_height
        ),
        (PrivateOfferStatus::Pending, 100, 100)
    );

    let utxos = private_utxo_rows(&pool, row.id).await?;
    assert_eq!(utxos.len(), 1);
    assert_eq!(
        (
            utxos[0].utxo_type,
            utxos[0].txid.clone(),
            utxos[0].vout,
            utxos[0].spent_txid.clone()
        ),
        (
            PrivateUtxoType::PendingOffer,
            creation.tx.txid().to_byte_array().to_vec(),
            3,
            None
        )
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn reindexing_a_creation_does_not_duplicate_it() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let creation = private_creation(
        &lending_key(1),
        &lending_key(2),
        outpoint_with_txid_byte(0x31, 7),
    );

    index_block(&mut processor, 100, std::slice::from_ref(&creation.tx)).await?;
    index_block(&mut processor, 101, std::slice::from_ref(&creation.tx)).await?;

    assert_eq!(private_offer_count(&pool).await?, 1);
    let row = private_offer_row(&pool, creation.tx.txid())
        .await?
        .expect("indexed");
    assert_eq!(row.created_at_height, 100);
    assert_eq!(private_utxo_rows(&pool, row.id).await?.len(), 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn transactions_without_a_private_offer_are_ignored() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let valid = private_creation(
        &lending_key(1),
        &lending_key(2),
        outpoint_with_txid_byte(0x31, 7),
    );
    let marker = valid.offer.marker;

    let mut other_program = valid.tx.clone();
    other_program.output[2].script_pubkey = Script::new_op_return(
        &Marker {
            program_id: [0; 4],
            ..marker
        }
        .encode(),
    );
    let mut null_nonce = valid.tx.clone();
    null_nonce.output[3].nonce = Nonce::Null;
    let mut truncated = valid.tx.clone();
    truncated.output.truncate(3);
    let unrelated = tx_with_input(outpoint_with_txid_byte(0x77, 0), vec![normal_output()]);

    index_block(
        &mut processor,
        100,
        &[other_program, null_nonce, truncated, unrelated],
    )
    .await?;

    assert_eq!(private_offer_count(&pool).await?, 0);
    Ok(())
}

fn outpoint(tx: &simplex::simplicityhl::elements::Transaction, vout: u32) -> OutPoint {
    OutPoint {
        txid: tx.txid(),
        vout,
    }
}

fn creation() -> crate::common::PrivateCreation {
    private_creation(
        &lending_key(1),
        &lending_key(2),
        outpoint_with_txid_byte(0x31, 7),
    )
}

/// Asserts `(type, txid, vout, spent_txid, spent_at_height)` of each UTXO row, in order.
type Expected = (PrivateUtxoType, OutPoint, Option<(OutPoint, i64)>);

async fn assert_utxos(pool: &sqlx::PgPool, offer_id: i64, expected: &[Expected]) {
    let rows = private_utxo_rows(pool, offer_id).await.unwrap();
    let actual: Vec<_> = rows
        .iter()
        .map(|r| {
            (
                r.utxo_type,
                r.txid.clone(),
                r.vout,
                r.spent_txid.clone(),
                r.spent_at_height,
            )
        })
        .collect();
    let wanted: Vec<_> = expected
        .iter()
        .map(|(t, o, spent)| {
            (
                *t,
                o.txid.to_byte_array().to_vec(),
                o.vout as i32,
                spent.map(|(s, _)| s.txid.to_byte_array().to_vec()),
                spent.map(|(_, h)| h),
            )
        })
        .collect();
    assert_eq!(actual, wanted);
}

#[tokio::test]
#[serial]
async fn accepted_offer_becomes_active() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let c = creation();
    let accept = acceptance_tx(&c);
    index_block(&mut processor, 100, std::slice::from_ref(&c.tx)).await?;
    index_block(&mut processor, 101, std::slice::from_ref(&accept)).await?;

    let row = private_offer_row(&pool, c.tx.txid()).await?.expect("row");
    assert_eq!(
        (row.current_status, row.updated_at_height),
        (PrivateOfferStatus::Active, 101)
    );
    let a = accept.txid();
    assert_utxos(
        &pool,
        row.id,
        &[
            (
                PrivateUtxoType::PendingOffer,
                outpoint(&c.tx, 3),
                Some((OutPoint { txid: a, vout: 0 }, 101)),
            ),
            (PrivateUtxoType::ActiveOffer, outpoint(&accept, 0), None),
            (PrivateUtxoType::Principal, outpoint(&accept, 1), None),
        ],
    )
    .await;
    Ok(())
}

#[tokio::test]
#[serial]
async fn cancelled_offer_is_cancelled() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let c = creation();
    let cancel = cancellation_tx(&c);
    index_block(&mut processor, 100, std::slice::from_ref(&c.tx)).await?;
    index_block(&mut processor, 101, std::slice::from_ref(&cancel)).await?;

    let row = private_offer_row(&pool, c.tx.txid()).await?.expect("row");
    assert_eq!(
        (row.current_status, row.updated_at_height),
        (PrivateOfferStatus::Cancelled, 101)
    );
    assert_utxos(
        &pool,
        row.id,
        &[(
            PrivateUtxoType::PendingOffer,
            outpoint(&c.tx, 3),
            Some((
                OutPoint {
                    txid: cancel.txid(),
                    vout: 0,
                },
                101,
            )),
        )],
    )
    .await;
    Ok(())
}

#[tokio::test]
#[serial]
async fn repaid_offer_and_both_claims() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let c = creation();
    let accept = acceptance_tx(&c);
    let repay = repayment_tx(&c, outpoint(&accept, 0));
    index_block(&mut processor, 100, std::slice::from_ref(&c.tx)).await?;
    index_block(&mut processor, 101, std::slice::from_ref(&accept)).await?;
    index_block(&mut processor, 102, std::slice::from_ref(&repay)).await?;

    let row = private_offer_row(&pool, c.tx.txid()).await?.expect("row");
    assert_eq!(row.current_status, PrivateOfferStatus::Repaid);
    let utxos = private_utxo_rows(&pool, row.id).await?;
    let repayment = utxos
        .iter()
        .find(|u| u.utxo_type == PrivateUtxoType::Repayment)
        .expect("repayment utxo");
    assert_eq!(
        (
            repayment.txid.clone(),
            repayment.vout,
            repayment.spent_txid.clone()
        ),
        (repay.txid().to_byte_array().to_vec(), 1, None)
    );

    let claim_principal = claim_tx(outpoint(&accept, 1));
    let claim_repayment = claim_tx(outpoint(&repay, 1));
    index_block(
        &mut processor,
        103,
        &[claim_principal.clone(), claim_repayment.clone()],
    )
    .await?;

    let row = private_offer_row(&pool, c.tx.txid()).await?.expect("row");
    assert_eq!(
        (row.current_status, row.updated_at_height),
        (PrivateOfferStatus::Repaid, 102)
    );
    let spent = |tx: &simplex::simplicityhl::elements::Transaction| {
        Some((
            OutPoint {
                txid: tx.txid(),
                vout: 0,
            },
            103,
        ))
    };
    let r = repay.txid();
    assert_utxos(
        &pool,
        row.id,
        &[
            (
                PrivateUtxoType::PendingOffer,
                outpoint(&c.tx, 3),
                Some((
                    OutPoint {
                        txid: accept.txid(),
                        vout: 0,
                    },
                    101,
                )),
            ),
            (
                PrivateUtxoType::ActiveOffer,
                outpoint(&accept, 0),
                Some((OutPoint { txid: r, vout: 0 }, 102)),
            ),
            (
                PrivateUtxoType::Principal,
                outpoint(&accept, 1),
                spent(&claim_principal),
            ),
            (
                PrivateUtxoType::Repayment,
                outpoint(&repay, 1),
                spent(&claim_repayment),
            ),
        ],
    )
    .await;
    Ok(())
}

#[tokio::test]
#[serial]
async fn liquidated_offer_is_liquidated() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let c = creation();
    let accept = acceptance_tx(&c);
    let liquidate = liquidation_tx(&c, outpoint(&accept, 0));
    index_block(&mut processor, 100, std::slice::from_ref(&c.tx)).await?;
    index_block(&mut processor, 101, std::slice::from_ref(&accept)).await?;
    index_block(&mut processor, 102, std::slice::from_ref(&liquidate)).await?;

    let row = private_offer_row(&pool, c.tx.txid()).await?.expect("row");
    assert_eq!(
        (row.current_status, row.updated_at_height),
        (PrivateOfferStatus::Liquidated, 102)
    );
    let utxos = private_utxo_rows(&pool, row.id).await?;
    let active = utxos
        .iter()
        .find(|u| u.utxo_type == PrivateUtxoType::ActiveOffer)
        .expect("active utxo");
    assert_eq!(
        (active.spent_txid.clone(), active.spent_at_height),
        (Some(liquidate.txid().to_byte_array().to_vec()), Some(102))
    );
    assert!(
        utxos
            .iter()
            .all(|u| u.utxo_type != PrivateUtxoType::Repayment)
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn offer_created_and_accepted_in_one_block_is_active() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let c = creation();
    let accept = acceptance_tx(&c);
    index_block(&mut processor, 100, &[c.tx.clone(), accept]).await?;

    let row = private_offer_row(&pool, c.tx.txid()).await?.expect("row");
    assert_eq!(row.current_status, PrivateOfferStatus::Active);
    assert_eq!(private_utxo_rows(&pool, row.id).await?.len(), 3);
    Ok(())
}

#[tokio::test]
#[serial]
async fn tracking_survives_restarts() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let c = creation();
    let accept = acceptance_tx(&c);
    let repay = repayment_tx(&c, outpoint(&accept, 0));

    let mut processor = block_processor(&pool).await?;
    index_block(&mut processor, 100, std::slice::from_ref(&c.tx)).await?;
    let mut processor = block_processor(&pool).await?;
    index_block(&mut processor, 101, std::slice::from_ref(&accept)).await?;
    let mut processor = block_processor(&pool).await?;
    index_block(&mut processor, 102, std::slice::from_ref(&repay)).await?;

    let row = private_offer_row(&pool, c.tx.txid()).await?.expect("row");
    assert_eq!(row.current_status, PrivateOfferStatus::Repaid);
    Ok(())
}
