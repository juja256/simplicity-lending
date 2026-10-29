#![allow(dead_code)]

use anyhow::Context;
use lending_contracts::programs::{private_lending::PrivateLendingOffer, program::SimplexProgram};
use lending_indexer::esplora_client::EsploraClient;
use lending_indexer::indexer::{BlockProcessor, TrackerRegistry};
use lending_indexer::indexer::{
    insert_factory, insert_offer, insert_offer_utxo, insert_participant_utxo,
    update_factory_status, update_offer_status,
};
use lending_indexer::models::{
    FactoryModel, FactoryStatus, OfferModel, OfferParticipantModel, OfferStatus, OfferUtxoModel,
    ParticipantType, PrivateOfferModel, PrivateOfferUtxoModel, UtxoType,
};
use private_lending_core::{LendingKey, NewOffer, OfferTerms};
use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::secp256k1_zkp::{PublicKey, SECP256K1};
use simplex::simplicityhl::elements::{
    AssetId, LockTime, OutPoint, Script, Transaction, TxIn, TxOut, Txid, confidential, hashes::Hash,
};
use sqlx::PgPool;
use uuid::Uuid;

/// Returns a ready-to-use pool with migrations applied and domain tables
/// truncated. Panics (instead of silent-skip) when `DATABASE_URL` is not
/// configured. Silent-skip would mask a completely empty test run in CI.
pub async fn test_pool() -> anyhow::Result<PgPool> {
    let _ = dotenvy::dotenv();

    let database_url = std::env::var("DATABASE_URL")
        .context("DATABASE_URL must be set in the environment or .env for integration tests")?;

    let pool = PgPool::connect(&database_url).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    sqlx::query(
        r#"
        TRUNCATE TABLE
            private_offer_utxos,
            private_offers,
            offer_participants,
            offer_utxos,
            offers,
            sync_state
        RESTART IDENTITY CASCADE
        "#,
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

pub async fn seed_sync_state(pool: &PgPool, last_indexed_height: i64) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO sync_state (id, last_indexed_height, last_indexed_hash)
        VALUES (1, $1, $2)
        ON CONFLICT (id) DO UPDATE SET
            last_indexed_height = EXCLUDED.last_indexed_height,
            last_indexed_hash = EXCLUDED.last_indexed_hash
        "#,
    )
    .bind(last_indexed_height)
    .bind("test_hash")
    .execute(pool)
    .await?;

    Ok(())
}

/// Produces a deterministic 32-byte blob unique per integer seed. Handy for
/// `created_at_txid` (which has a UNIQUE constraint) when seeding several
/// offers in the same test.
pub fn unique_32_bytes_from_i64(seed: i64) -> Vec<u8> {
    let bytes = seed.to_be_bytes();
    let mut buf = [0_u8; 32];
    buf[..8].copy_from_slice(&bytes);
    buf[8..16].copy_from_slice(&bytes);
    buf.to_vec()
}

/// Produces a deterministic 32-byte blob unique per UUID. Handy for
/// `created_at_txid` (which has a UNIQUE constraint) when seeding several
/// factories in the same test.
pub fn unique_32_bytes_from_uuid(id: Uuid) -> Vec<u8> {
    let mut buf = [0_u8; 32];
    buf[..16].copy_from_slice(id.as_bytes());
    buf[16..].copy_from_slice(id.as_bytes());
    buf.to_vec()
}

pub fn factory_model(id: Uuid, created_at_height: i64, created_at_txid: Vec<u8>) -> FactoryModel {
    FactoryModel {
        id,
        factory_asset_id: vec![10; 32],
        program_script_pubkey: vec![11; 32],
        issuing_utxos_count: 2,
        reissuance_flags: 0,
        current_status: FactoryStatus::Active,
        created_at_height,
        created_at_txid,
    }
}

pub fn offer_model(
    txid_seed: i64,
    issuance_factory_id: Uuid,
    created_at_height: i64,
) -> OfferModel {
    OfferModel {
        id: 0,
        issuance_factory_id,
        collateral_asset_id: vec![1; 32],
        principal_asset_id: vec![2; 32],
        borrower_nft_asset_id: vec![7; 32],
        lender_nft_asset_id: vec![8; 32],
        protocol_fee_keeper_asset_id: vec![5; 32],
        collateral_amount: 1_000,
        principal_amount: 500,
        interest_rate: 120,
        loan_expiration_time: 1_234_567,
        current_status: OfferStatus::Pending,
        updated_at_height: created_at_height,
        created_at_height,
        created_at_txid: unique_32_bytes_from_i64(txid_seed),
    }
}

pub async fn seed_factory_row(pool: &PgPool, factory: &FactoryModel) -> anyhow::Result<()> {
    let mut sql_tx = pool.begin().await?;
    insert_factory(&mut sql_tx, factory).await?;
    if !matches!(factory.current_status, FactoryStatus::Removed) {
        update_factory_status(&mut sql_tx, factory.id, factory.current_status).await?;
    }
    sql_tx.commit().await?;
    Ok(())
}

pub async fn seed_offer_row(pool: &PgPool, offer: &mut OfferModel) -> anyhow::Result<i64> {
    let mut sql_tx = pool.begin().await?;
    let Some(id) = insert_offer(&mut sql_tx, offer).await? else {
        anyhow::bail!("offer with the same created_at_txid already exists");
    };
    offer.id = id;
    if !matches!(offer.current_status, OfferStatus::Pending) {
        let update_height = if offer.updated_at_height > offer.created_at_height {
            offer.updated_at_height
        } else {
            offer.created_at_height + 1
        };
        update_offer_status(
            &mut sql_tx,
            offer.id,
            offer.current_status,
            update_height as u64,
        )
        .await?;
        offer.updated_at_height = update_height;
    }
    sql_tx.commit().await?;
    Ok(id)
}

pub async fn seed_offer_utxo_row(pool: &PgPool, utxo: &OfferUtxoModel) -> anyhow::Result<()> {
    let mut sql_tx = pool.begin().await?;
    insert_offer_utxo(&mut sql_tx, utxo).await?;
    sql_tx.commit().await?;
    Ok(())
}

pub async fn seed_participant_utxo_row(
    pool: &PgPool,
    participant: &OfferParticipantModel,
) -> anyhow::Result<()> {
    let mut sql_tx = pool.begin().await?;
    insert_participant_utxo(&mut sql_tx, participant).await?;
    sql_tx.commit().await?;
    Ok(())
}

pub fn unspent_offer_utxo(
    offer_id: i64,
    outpoint: OutPoint,
    utxo_type: UtxoType,
    created_at_height: i64,
) -> OfferUtxoModel {
    OfferUtxoModel {
        offer_id,
        txid: outpoint.txid.as_byte_array().to_vec(),
        vout: outpoint.vout as i32,
        utxo_type,
        created_at_height,
        spent_txid: None,
        spent_at_height: None,
    }
}

pub fn spent_offer_utxo(
    offer_id: i64,
    outpoint: OutPoint,
    utxo_type: UtxoType,
    created_at_height: i64,
    spent_at_height: i64,
    spent_txid_byte: u8,
) -> OfferUtxoModel {
    OfferUtxoModel {
        offer_id,
        txid: outpoint.txid.as_byte_array().to_vec(),
        vout: outpoint.vout as i32,
        utxo_type,
        created_at_height,
        spent_txid: Some(vec![spent_txid_byte; 32]),
        spent_at_height: Some(spent_at_height),
    }
}

pub fn unspent_participant(
    offer_id: i64,
    participant_type: ParticipantType,
    outpoint: OutPoint,
    script_pubkey: Vec<u8>,
    created_at_height: i64,
) -> OfferParticipantModel {
    OfferParticipantModel {
        offer_id,
        participant_type,
        script_pubkey,
        txid: outpoint.txid.as_byte_array().to_vec(),
        vout: outpoint.vout as i32,
        created_at_height,
        spent_txid: None,
        spent_at_height: None,
    }
}

pub fn spent_participant(
    offer_id: i64,
    participant_type: ParticipantType,
    outpoint: OutPoint,
    script_pubkey: Vec<u8>,
    created_at_height: i64,
    spent_at_height: i64,
    spent_txid_byte: u8,
) -> OfferParticipantModel {
    OfferParticipantModel {
        offer_id,
        participant_type,
        script_pubkey,
        txid: outpoint.txid.as_byte_array().to_vec(),
        vout: outpoint.vout as i32,
        created_at_height,
        spent_txid: Some(vec![spent_txid_byte; 32]),
        spent_at_height: Some(spent_at_height),
    }
}

pub fn outpoint_with_txid_byte(txid_byte: u8, vout: u32) -> OutPoint {
    OutPoint {
        txid: Txid::from_slice(&[txid_byte; 32]).expect("valid txid bytes"),
        vout,
    }
}

pub fn outpoint_from_offer_id(offer_id: i64, vout: u32) -> OutPoint {
    let mut txid_bytes = [0_u8; 32];
    let seed_bytes = offer_id.to_be_bytes();
    txid_bytes[..8].copy_from_slice(&seed_bytes);
    txid_bytes[8..16].copy_from_slice(&seed_bytes);
    // Perturb first byte so UTXO txid differs from offer's created_at_txid.
    txid_bytes[0] ^= 0x5a;
    OutPoint {
        txid: Txid::from_slice(&txid_bytes).expect("valid txid bytes"),
        vout,
    }
}

pub fn normal_output() -> TxOut {
    TxOut::default()
}

pub fn null_data_output() -> TxOut {
    TxOut {
        script_pubkey: Script::new_op_return(b"burn"),
        ..Default::default()
    }
}

/// Concrete non-empty, non-OP_RETURN script. `Script::default()` is empty
/// and looks like a malformed output in participant-movement assertions.
pub fn non_op_return_script() -> Script {
    Script::from(vec![0x51_u8]) // OP_1
}

pub fn tx_with_input(spent: OutPoint, outputs: Vec<TxOut>) -> Transaction {
    Transaction {
        version: 2,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: spent,
            ..Default::default()
        }],
        output: outputs,
    }
}

pub fn tx_with_inputs(spent: Vec<OutPoint>, outputs: Vec<TxOut>) -> Transaction {
    Transaction {
        version: 2,
        lock_time: LockTime::ZERO,
        input: spent
            .into_iter()
            .map(|previous_output| TxIn {
                previous_output,
                ..Default::default()
            })
            .collect(),
        output: outputs,
    }
}

pub fn padded_tx_with_inputs(known_inputs: Vec<OutPoint>, outputs: Vec<TxOut>) -> Transaction {
    let mut inputs = known_inputs;
    let mut vout_counter = 1_000_u32;
    while inputs.len() < 7 {
        inputs.push(outpoint_with_txid_byte(0xff, vout_counter));
        vout_counter += 1;
    }
    tx_with_inputs(inputs, outputs)
}

pub fn explicit_asset_output(asset_byte: u8, script_pubkey: Script) -> TxOut {
    let mut output = TxOut {
        script_pubkey,
        ..Default::default()
    };
    let asset_id = AssetId::from_slice(&[asset_byte; 32]).expect("valid asset id");
    output.asset = confidential::Asset::Explicit(asset_id);
    output
}

pub fn private_program_id() -> [u8; 4] {
    PrivateLendingOffer::get_program_id()
}

pub fn lending_key(byte: u8) -> LendingKey {
    LendingKey::from_master_blinding_key(&[byte; 32])
}

pub struct PrivateCreation {
    pub tx: Transaction,
    pub offer: NewOffer,
}

/// A private offer's creation transaction in the layout the indexer reads: unblinded and
/// unsigned, since the indexer looks only at the layout, the marker and the nonce.
pub fn private_creation(
    borrower: &LendingKey,
    lender: &LendingKey,
    first_input: OutPoint,
) -> PrivateCreation {
    // Different first inputs give different NFT ids.
    let nft_id = |tag: u8| {
        let mut bytes = first_input.txid.to_byte_array();
        bytes[0] ^= tag;
        bytes[1..5].copy_from_slice(&first_input.vout.to_le_bytes());
        AssetId::from_slice(&bytes).expect("valid asset id")
    };
    let (borrower_nft, lender_nft) = (nft_id(0xb0), nft_id(0xa0));

    let offer = NewOffer::build(
        borrower,
        &lender.x_only_public_key(),
        &first_input,
        private_program_id(),
        AssetId::from_slice(&[9; 32]).expect("valid asset id"),
        5_000,
        OfferTerms {
            principal_asset: AssetId::from_slice(&[8; 32]).expect("valid asset id"),
            principal_amount: 10_000,
            repayment_amount: 11_000,
            interest_rate_bps: 1_000,
            loan_expiration_time: 1_000,
            borrower_nft,
            lender_nft,
        },
    )
    .expect("valid offer");

    let nft_output = |asset: AssetId| TxOut {
        asset: confidential::Asset::Explicit(asset),
        value: confidential::Value::Explicit(1),
        script_pubkey: non_op_return_script(),
        ..Default::default()
    };
    let marker_output = TxOut {
        script_pubkey: Script::new_op_return(&offer.marker.encode()),
        ..Default::default()
    };
    let collateral_output = TxOut {
        asset: confidential::Asset::Explicit(AssetId::from_slice(&[9; 32]).expect("asset")),
        value: confidential::Value::Explicit(5_000),
        nonce: confidential::Nonce::Confidential(PublicKey::from_secret_key(
            SECP256K1,
            &offer.ephemeral_sk,
        )),
        script_pubkey: non_op_return_script(),
        ..Default::default()
    };

    let tx = tx_with_inputs(
        vec![first_input, outpoint_with_txid_byte(0x42, 0)],
        vec![
            nft_output(borrower_nft),
            nft_output(lender_nft),
            marker_output,
            collateral_output,
        ],
    );

    PrivateCreation { tx, offer }
}

/// `OP_RETURN "burn"` with an explicit asset and value 1.
pub fn burn_output(asset: AssetId) -> TxOut {
    TxOut {
        asset: confidential::Asset::Explicit(asset),
        value: confidential::Value::Explicit(1),
        script_pubkey: Script::new_op_return(b"burn"),
        ..Default::default()
    }
}

pub fn explicit_output(asset: AssetId, amount: u64) -> TxOut {
    TxOut {
        asset: confidential::Asset::Explicit(asset),
        value: confidential::Value::Explicit(amount),
        script_pubkey: non_op_return_script(),
        ..Default::default()
    }
}

fn creation_outpoint(c: &PrivateCreation, vout: u32) -> OutPoint {
    OutPoint {
        txid: c.tx.txid(),
        vout,
    }
}

fn asset(byte: u8) -> AssetId {
    AssetId::from_slice(&[byte; 32]).expect("valid asset id")
}

/// Acceptance: spends the pending offer and the lender NFT coin; the lender NFT is not burned.
pub fn acceptance_tx(c: &PrivateCreation) -> Transaction {
    let terms = &c.offer.signed_terms.terms;
    tx_with_inputs(
        vec![creation_outpoint(c, 3), creation_outpoint(c, 1)],
        vec![
            explicit_output(asset(0x61), 1),
            explicit_output(terms.principal_asset, terms.principal_amount),
            explicit_output(terms.lender_nft, 1),
        ],
    )
}

/// Cancellation: burns both NFTs and returns the collateral.
pub fn cancellation_tx(c: &PrivateCreation) -> Transaction {
    let terms = &c.offer.signed_terms.terms;
    tx_with_inputs(
        vec![
            creation_outpoint(c, 3),
            creation_outpoint(c, 1),
            creation_outpoint(c, 0),
        ],
        vec![
            burn_output(terms.lender_nft),
            burn_output(terms.borrower_nft),
            explicit_output(asset(9), 5_000),
        ],
    )
}

/// Full repayment: burns the borrower NFT, pays the lender and returns the collateral.
pub fn repayment_tx(c: &PrivateCreation, active: OutPoint) -> Transaction {
    let terms = &c.offer.signed_terms.terms;
    tx_with_inputs(
        vec![creation_outpoint(c, 0), active],
        vec![
            burn_output(terms.borrower_nft),
            explicit_output(terms.principal_asset, terms.repayment_amount),
            explicit_output(asset(9), 5_000),
        ],
    )
}

/// Liquidation: burns the lender NFT and pays out the collateral.
pub fn liquidation_tx(c: &PrivateCreation, active: OutPoint) -> Transaction {
    let terms = &c.offer.signed_terms.terms;
    tx_with_inputs(
        vec![active, creation_outpoint(c, 1)],
        vec![
            burn_output(terms.lender_nft),
            explicit_output(asset(9), 5_000),
        ],
    )
}

/// A plain spend of a claimable output.
pub fn claim_tx(spent: OutPoint) -> Transaction {
    tx_with_input(spent, vec![explicit_output(asset(0x62), 1)])
}

pub async fn block_processor(pool: &PgPool) -> anyhow::Result<BlockProcessor> {
    let registry = TrackerRegistry::load(
        pool,
        AssetId::from_slice(&[5; 32])?,
        SimplicityNetwork::LiquidTestnet,
        None,
    )
    .await?;

    Ok(BlockProcessor::new(
        pool.clone(),
        EsploraClient::new(),
        registry,
    ))
}

pub async fn index_block(
    processor: &mut BlockProcessor,
    height: u64,
    txs: &[Transaction],
) -> anyhow::Result<()> {
    processor
        .index_block(height, format!("{height:064x}"), txs)
        .await
}

pub async fn private_offer_row(
    pool: &PgPool,
    creation_txid: Txid,
) -> anyhow::Result<Option<PrivateOfferModel>> {
    Ok(sqlx::query_as::<_, PrivateOfferModel>(
        r#"
        SELECT id, creation_txid, nonce, view_tag, encrypted_lender_key, first_input_txid,
               first_input_vout, borrower_nft_asset_id, lender_nft_asset_id, current_status,
               created_at_height, updated_at_height
        FROM private_offers
        WHERE creation_txid = $1
        "#,
    )
    .bind(creation_txid.to_byte_array().to_vec())
    .fetch_optional(pool)
    .await?)
}

pub async fn private_utxo_rows(
    pool: &PgPool,
    offer_id: i64,
) -> anyhow::Result<Vec<PrivateOfferUtxoModel>> {
    Ok(sqlx::query_as::<_, PrivateOfferUtxoModel>(
        r#"
        SELECT offer_id, utxo_type, txid, vout, created_at_height, spent_txid, spent_at_height
        FROM private_offer_utxos
        WHERE offer_id = $1
        ORDER BY created_at_height, vout
        "#,
    )
    .bind(offer_id)
    .fetch_all(pool)
    .await?)
}

pub async fn private_offer_count(pool: &PgPool) -> anyhow::Result<i64> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM private_offers")
            .fetch_one(pool)
            .await?,
    )
}
