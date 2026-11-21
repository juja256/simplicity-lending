#![allow(dead_code)]

use anyhow::Context;
use lending_contracts::programs::{private_lending::PrivateLendingOffer, program::SimplexProgram};
use lending_indexer::api::server::run_server;
use lending_indexer::esplora_client::EsploraClient;
use lending_indexer::indexer::{BlockProcessor, TrackerRegistry};
use lending_indexer::models::{PrivateOfferModel, PrivateOfferUtxoModel};
use private_lending_core::{LendingKey, NewOffer, OfferTerms};
use serde_json::Value;
use simplex::simplicityhl::elements::secp256k1_zkp::{PublicKey, SECP256K1};
use simplex::simplicityhl::elements::{
    AssetId, LockTime, OutPoint, Script, Transaction, TxIn, TxOut, Txid, confidential, hashes::Hash,
};
use sqlx::PgPool;
use tokio::net::TcpListener;

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
            directory_entries,
            directory_challenges,
            private_offer_utxos,
            private_offers,
            sync_state
        RESTART IDENTITY CASCADE
        "#,
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

pub fn outpoint_with_txid_byte(txid_byte: u8, vout: u32) -> OutPoint {
    OutPoint {
        txid: Txid::from_slice(&[txid_byte; 32]).expect("valid txid bytes"),
        vout,
    }
}

pub fn normal_output() -> TxOut {
    TxOut::default()
}

/// A non-empty script that is not an `OP_RETURN`, so the output is never read as a burn.
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

/// Installment: spends the borrower NFT at `nft` and the loan at `active`, and returns the NFT
/// unburned at output 0, with the successor loan at output 1 and the installment at output 2.
pub fn installment_tx(c: &PrivateCreation, nft: OutPoint, active: OutPoint) -> Transaction {
    let terms = &c.offer.signed_terms.terms;
    tx_with_inputs(
        vec![nft, active, outpoint_with_txid_byte(0x43, 0)],
        vec![
            explicit_output(terms.borrower_nft, 1),
            explicit_output(asset(9), 5_000),
            explicit_output(terms.principal_asset, 1_000),
            explicit_output(terms.principal_asset, 500),
        ],
    )
}

/// Zero-debt close: burns the borrower NFT, reveals the debt's blinder in an `OP_RETURN` at output
/// 1 and returns the collateral.
pub fn zero_debt_close_tx(c: &PrivateCreation, nft: OutPoint, active: OutPoint) -> Transaction {
    let terms = &c.offer.signed_terms.terms;
    tx_with_inputs(
        vec![nft, active],
        vec![
            burn_output(terms.borrower_nft),
            TxOut {
                script_pubkey: Script::new_op_return(&[7; 32]),
                ..Default::default()
            },
            explicit_output(asset(9), 5_000),
        ],
    )
}

/// A claim of installments: spends the lender NFT at `nft` and the installments, and returns the
/// NFT to the lender at output 0 with what was claimed at output 1.
pub fn installment_claim_tx(
    c: &PrivateCreation,
    nft: OutPoint,
    installments: &[OutPoint],
) -> Transaction {
    let terms = &c.offer.signed_terms.terms;
    tx_with_inputs(
        std::iter::once(nft)
            .chain(installments.iter().copied())
            .collect(),
        vec![
            explicit_output(terms.lender_nft, 1),
            explicit_output(terms.principal_asset, 1_000),
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
    let registry = TrackerRegistry::load(pool).await?;

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

pub async fn start_api(pool: PgPool) -> anyhow::Result<(String, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let handle = tokio::spawn(async move {
        run_server(listener, pool).await;
    });
    // Socket is already listening after `bind`; kernel buffers early
    // connection attempts, so no startup sleep is required.
    Ok((format!("http://{addr}"), handle))
}

pub async fn response_json(response: reqwest::Response) -> anyhow::Result<Value> {
    // `reqwest::Response::json` needs the `json` feature which this crate
    // does not enable.
    let body = response.text().await?;
    Ok(serde_json::from_str(&body)?)
}

pub async fn get_json(http: &reqwest::Client, url: String) -> anyhow::Result<Value> {
    let response = http.get(url).send().await?.error_for_status()?;
    response_json(response).await
}

/// Inserts a directory challenge. A negative `expires_in_secs` gives one that has already expired.
pub async fn seed_directory_challenge(
    pool: &PgPool,
    challenge: [u8; 32],
    expires_in_secs: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO directory_challenges (challenge, expires_at)
         VALUES ($1, now() + make_interval(secs => $2::double precision))",
    )
    .bind(challenge.as_slice())
    .bind(expires_in_secs as f64)
    .execute(pool)
    .await?;
    Ok(())
}
