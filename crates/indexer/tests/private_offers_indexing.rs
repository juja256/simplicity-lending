mod common;

use lending_indexer::models::{PrivateOfferStatus, PrivateUtxoType};
use private_lending_core::{Marker, find_offer};
use serial_test::serial;
use simplex::simplicityhl::elements::{
    Script,
    confidential::Nonce,
    hashes::Hash,
    secp256k1_zkp::{PublicKey, SECP256K1},
};

use crate::common::{
    block_processor, index_block, lending_key, normal_output, outpoint_with_txid_byte,
    private_creation, private_offer_count, private_offer_row, private_program_id,
    private_utxo_rows, test_pool, tx_with_input,
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
