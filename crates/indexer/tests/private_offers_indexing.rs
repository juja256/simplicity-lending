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
    acceptance_tx, block_processor, burn_output, cancellation_tx, claim_tx, index_block,
    lending_key, liquidation_tx, normal_output, outpoint_with_txid_byte, private_creation,
    private_offer_count, private_offer_row, private_program_id, private_utxo_rows, repayment_tx,
    test_pool, tx_with_input, tx_with_inputs,
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

fn second_creation() -> crate::common::PrivateCreation {
    private_creation(
        &lending_key(1),
        &lending_key(2),
        outpoint_with_txid_byte(0x32, 8),
    )
}

async fn utxo_count(pool: &sqlx::PgPool, outpoint: OutPoint) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM private_offer_utxos WHERE txid = $1 AND vout = $2",
    )
    .bind(outpoint.txid.to_byte_array().to_vec())
    .bind(outpoint.vout as i32)
    .fetch_one(pool)
    .await?)
}

#[tokio::test]
#[serial]
async fn spending_two_candidates_in_one_transaction_does_not_halt_indexing() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let a = creation();
    let b = second_creation();
    index_block(&mut processor, 100, &[a.tx.clone(), b.tx.clone()]).await?;

    let t = tx_with_inputs(
        vec![outpoint(&a.tx, 3), outpoint(&b.tx, 3)],
        vec![normal_output(), normal_output()],
    );
    index_block(&mut processor, 101, std::slice::from_ref(&t)).await?;

    let row_a = private_offer_row(&pool, a.tx.txid()).await?.expect("a");
    let row_b = private_offer_row(&pool, b.tx.txid()).await?.expect("b");
    assert_eq!(row_a.current_status, PrivateOfferStatus::Active);
    assert_eq!(row_b.current_status, PrivateOfferStatus::Active);
    for vout in 0..2 {
        assert_eq!(utxo_count(&pool, outpoint(&t, vout)).await?, 1);
        assert!(
            private_utxo_rows(&pool, row_a.id)
                .await?
                .iter()
                .any(|u| u.txid == t.txid().to_byte_array().to_vec() && u.vout == vout as i32)
        );
    }

    let c = private_creation(
        &lending_key(1),
        &lending_key(2),
        outpoint_with_txid_byte(0x33, 9),
    );
    index_block(&mut processor, 102, std::slice::from_ref(&c.tx)).await?;
    assert!(private_offer_row(&pool, c.tx.txid()).await?.is_some());
    Ok(())
}

#[tokio::test]
#[serial]
async fn acceptance_and_repayment_colliding_in_one_transaction_does_not_halt_indexing()
-> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let a = creation();
    let b = second_creation();
    let accept = acceptance_tx(&a);
    index_block(&mut processor, 100, &[a.tx.clone(), b.tx.clone()]).await?;
    index_block(&mut processor, 101, std::slice::from_ref(&accept)).await?;

    let t = tx_with_inputs(
        vec![outpoint(&b.tx, 3), outpoint(&accept, 0)],
        vec![
            burn_output(a.offer.signed_terms.terms.borrower_nft),
            normal_output(),
            normal_output(),
        ],
    );
    index_block(&mut processor, 102, std::slice::from_ref(&t)).await?;

    let row_a = private_offer_row(&pool, a.tx.txid()).await?.expect("a");
    let row_b = private_offer_row(&pool, b.tx.txid()).await?.expect("b");
    assert_eq!(row_a.current_status, PrivateOfferStatus::Repaid);
    assert_eq!(row_b.current_status, PrivateOfferStatus::Active);
    assert_eq!(utxo_count(&pool, outpoint(&t, 1)).await?, 1);

    // The reverse order: the repayment is processed first and owns (T,1).
    let a2 = private_creation(
        &lending_key(1),
        &lending_key(2),
        outpoint_with_txid_byte(0x34, 1),
    );
    let b2 = private_creation(
        &lending_key(1),
        &lending_key(2),
        outpoint_with_txid_byte(0x35, 2),
    );
    let accept2 = acceptance_tx(&a2);
    index_block(&mut processor, 103, &[a2.tx.clone(), b2.tx.clone()]).await?;
    index_block(&mut processor, 104, std::slice::from_ref(&accept2)).await?;
    let t2 = tx_with_inputs(
        vec![outpoint(&accept2, 0), outpoint(&b2.tx, 3)],
        vec![
            burn_output(a2.offer.signed_terms.terms.borrower_nft),
            normal_output(),
            normal_output(),
        ],
    );
    index_block(&mut processor, 105, std::slice::from_ref(&t2)).await?;
    let row_a2 = private_offer_row(&pool, a2.tx.txid()).await?.expect("a2");
    let row_b2 = private_offer_row(&pool, b2.tx.txid()).await?.expect("b2");
    assert_eq!(row_a2.current_status, PrivateOfferStatus::Repaid);
    assert_eq!(row_b2.current_status, PrivateOfferStatus::Active);
    assert_eq!(utxo_count(&pool, outpoint(&t2, 1)).await?, 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_transition_does_not_record_outputs_the_transaction_lacks() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let a = creation();
    index_block(&mut processor, 100, std::slice::from_ref(&a.tx)).await?;
    let t = tx_with_input(outpoint(&a.tx, 3), vec![normal_output()]);
    index_block(&mut processor, 101, std::slice::from_ref(&t)).await?;

    let row = private_offer_row(&pool, a.tx.txid()).await?.expect("row");
    assert_eq!(row.current_status, PrivateOfferStatus::Active);
    let kinds: Vec<_> = private_utxo_rows(&pool, row.id)
        .await?
        .iter()
        .map(|u| (u.utxo_type, u.vout))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (PrivateUtxoType::PendingOffer, 3),
            (PrivateUtxoType::ActiveOffer, 0)
        ]
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn tracking_survives_a_restart_before_cancellation() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let c = creation();
    let cancel = cancellation_tx(&c);

    let mut processor = block_processor(&pool).await?;
    index_block(&mut processor, 100, std::slice::from_ref(&c.tx)).await?;
    let mut processor = block_processor(&pool).await?;
    index_block(&mut processor, 101, std::slice::from_ref(&cancel)).await?;

    let row = private_offer_row(&pool, c.tx.txid()).await?.expect("row");
    assert_eq!(row.current_status, PrivateOfferStatus::Cancelled);
    Ok(())
}
