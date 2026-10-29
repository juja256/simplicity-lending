mod common;

use std::str::FromStr;

use private_lending_core::{Marker, OfferSecrets, ephemeral_key};
use reqwest::StatusCode;
use serial_test::serial;
use simplex::simplicityhl::elements::encode::deserialize;
use simplex::simplicityhl::elements::secp256k1_zkp::{PublicKey, SECP256K1};
use simplex::simplicityhl::elements::{AssetId, OutPoint, Transaction, Txid};

use crate::common::{
    acceptance_tx, block_processor, get_json, index_block, lending_key, outpoint_with_txid_byte,
    private_creation, private_program_id, repayment_tx, response_json, start_api, test_pool,
};

#[tokio::test]
#[serial]
async fn light_candidate_lets_both_parties_recognize_the_offer() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (borrower, lender) = (lending_key(1), lending_key(2));
    let creation = private_creation(&borrower, &lender, outpoint_with_txid_byte(0x31, 7));
    let mut processor = block_processor(&pool).await?;
    index_block(&mut processor, 100, std::slice::from_ref(&creation.tx)).await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();

    let item = &get_json(&http, format!("{base}/private/candidates")).await?["items"][0];
    let nonce = PublicKey::from_str(item["nonce"].as_str().unwrap())?;
    let view_tag = item["view_tag"].as_u64().unwrap() as u8;
    assert_eq!(
        OfferSecrets::for_lender(&lender, &nonce).view_tag(),
        view_tag
    );

    let first_input = OutPoint::new(
        Txid::from_str(item["first_input"]["txid"].as_str().unwrap())?,
        item["first_input"]["vout"].as_u64().unwrap() as u32,
    );
    assert_eq!(first_input, outpoint_with_txid_byte(0x31, 7));
    let borrower_nft = AssetId::from_str(item["borrower_nft_asset_id"].as_str().unwrap())?;
    let lender_nft = AssetId::from_str(item["lender_nft_asset_id"].as_str().unwrap())?;
    let e = ephemeral_key(&borrower, &first_input, borrower_nft, lender_nft);
    assert_eq!(PublicKey::from_secret_key(SECP256K1, &e), nonce);

    let marker = Marker {
        program_id: private_program_id(),
        view_tag,
        encrypted_lender_key: hex::decode(item["encrypted_lender_key"].as_str().unwrap())?
            .try_into()
            .unwrap(),
    };
    assert_eq!(
        marker.decrypt_lender_key(&borrower, &first_input, borrower_nft, lender_nft),
        Some(lender.x_only_public_key())
    );
    assert_eq!(item["creation_txid"], creation.tx.txid().to_string());
    assert_eq!(item["status"], "pending");
    Ok(())
}

#[tokio::test]
#[serial]
async fn candidates_are_listed_by_height_range() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool.clone()).await?;
    let http = reqwest::Client::new();

    let empty = get_json(&http, format!("{base}/private/candidates")).await?;
    assert_eq!(empty["items"], serde_json::json!([]));
    assert!(empty["last_indexed_height"].is_null());

    let (borrower, lender) = (lending_key(1), lending_key(2));
    let mut processor = block_processor(&pool).await?;
    let mut txids = Vec::new();
    for (i, height) in [100u64, 101, 102].into_iter().enumerate() {
        let c = private_creation(
            &borrower,
            &lender,
            outpoint_with_txid_byte(0x40 + i as u8, 0),
        );
        index_block(&mut processor, height, std::slice::from_ref(&c.tx)).await?;
        txids.push(c.tx.txid().to_string());
    }
    let ids = |v: &serde_json::Value| -> Vec<String> {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["creation_txid"].as_str().unwrap().to_string())
            .collect()
    };

    let from = get_json(&http, format!("{base}/private/candidates?from_height=101")).await?;
    assert_eq!(ids(&from), txids[1..]);
    assert_eq!(from["total"], 2);
    assert_eq!(from["last_indexed_height"], 102);

    let only = get_json(
        &http,
        format!("{base}/private/candidates?from_height=101&to_height=101"),
    )
    .await?;
    assert_eq!(ids(&only), txids[1..2]);

    let page = get_json(&http, format!("{base}/private/candidates?limit=1&offset=1")).await?;
    assert_eq!(ids(&page), txids[1..2]);
    assert_eq!(page["total"], 3);

    for query in ["limit=501", "from_height=abc"] {
        let response = http
            .get(format!("{base}/private/candidates?{query}"))
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{query}");
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn candidate_details_include_its_utxos() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (borrower, lender) = (lending_key(1), lending_key(2));
    let creation = private_creation(&borrower, &lender, outpoint_with_txid_byte(0x31, 7));
    let accept = acceptance_tx(&creation);
    let repay = repayment_tx(&creation, OutPoint::new(accept.txid(), 0));
    let mut processor = block_processor(&pool).await?;
    index_block(&mut processor, 100, std::slice::from_ref(&creation.tx)).await?;
    index_block(&mut processor, 101, std::slice::from_ref(&accept)).await?;
    index_block(&mut processor, 102, std::slice::from_ref(&repay)).await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();

    let txid = creation.tx.txid();
    let details = get_json(&http, format!("{base}/private/candidates/{txid}")).await?;
    assert_eq!(details["status"], "repaid");
    assert_eq!(details["updated_at_height"], 102);
    assert_eq!(details["creation_txid"], txid.to_string());
    let utxos = details["utxos"].as_array().unwrap();
    let types: Vec<_> = utxos
        .iter()
        .map(|u| u["utxo_type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        ["pending_offer", "active_offer", "principal", "repayment"]
    );
    assert_eq!(utxos[0]["spent_txid"], accept.txid().to_string());
    assert_eq!(utxos[0]["spent_at_height"], 101);
    assert!(utxos[3]["spent_txid"].is_null());
    assert!(utxos[3]["spent_at_height"].is_null());
    Ok(())
}

#[tokio::test]
#[serial]
async fn creation_transaction_is_served_whole() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let creation = private_creation(
        &lending_key(1),
        &lending_key(2),
        outpoint_with_txid_byte(0x31, 7),
    );
    let mut processor = block_processor(&pool).await?;
    index_block(&mut processor, 100, std::slice::from_ref(&creation.tx)).await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();

    let body = get_json(
        &http,
        format!("{base}/private/candidates/{}/tx", creation.tx.txid()),
    )
    .await?;
    let tx: Transaction = deserialize(&hex::decode(body["tx_hex"].as_str().unwrap())?)?;
    assert_eq!(tx, creation.tx);
    Ok(())
}

#[tokio::test]
#[serial]
async fn unknown_and_malformed_txids_are_rejected() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let unknown = "ab".repeat(32);

    for suffix in ["", "/tx"] {
        let response = http
            .get(format!("{base}/private/candidates/{unknown}{suffix}"))
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{suffix}");
        let _ = response_json(response).await?;

        let response = http
            .get(format!("{base}/private/candidates/zz{suffix}"))
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{suffix}");
    }
    Ok(())
}
