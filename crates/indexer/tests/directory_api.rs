mod common;

use elements::AssetId;
use private_lending_core::{
    DirectoryAction, LenderTerms, LendingKey, PairTerms, sign_directory_action,
};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use serial_test::serial;

use crate::common::{lending_key, response_json, seed_directory_challenge, start_api, test_pool};

async fn send_json(
    http: &reqwest::Client,
    method: Method,
    url: String,
    body: Value,
) -> anyhow::Result<reqwest::Response> {
    Ok(http
        .request(method, url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&body)?)
        .send()
        .await?)
}

async fn issue_challenge(http: &reqwest::Client, base: &str) -> anyhow::Result<[u8; 32]> {
    let response = http
        .post(format!("{base}/private/directory/challenges"))
        .send()
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    Ok(hex::decode(body["challenge"].as_str().unwrap())?
        .try_into()
        .unwrap())
}

fn pubkey_hex(key: &LendingKey) -> String {
    key.x_only_public_key().to_string()
}

fn asset(byte: u8) -> AssetId {
    AssetId::from_slice(&[byte; 32]).expect("valid asset id")
}

fn pair(principal: u8, collateral: u8) -> PairTerms {
    PairTerms {
        principal_asset: asset(principal),
        collateral_asset: asset(collateral),
        min_apr_bps: 500,
        max_principal_per_collateral: 5_000_000_000,
        min_term_days: 1,
        max_term_days: 30,
        min_principal: 1_000,
        max_principal: 10_000_000,
    }
}

fn sample_terms() -> LenderTerms {
    LenderTerms {
        pairs: vec![pair(0x11, 0x22)],
    }
}

/// The terms in the API's JSON shape: amounts as decimal strings, asset ids as display hex.
fn terms_json(terms: &LenderTerms) -> Value {
    let pairs: Vec<Value> = terms
        .pairs
        .iter()
        .map(|pair| {
            json!({
                "principal_asset": pair.principal_asset.to_string(),
                "collateral_asset": pair.collateral_asset.to_string(),
                "min_apr_bps": pair.min_apr_bps,
                "max_principal_per_collateral": pair.max_principal_per_collateral.to_string(),
                "min_term_days": pair.min_term_days,
                "max_term_days": pair.max_term_days,
                "min_principal": pair.min_principal.to_string(),
                "max_principal": pair.max_principal.to_string(),
            })
        })
        .collect();
    json!({ "pairs": pairs })
}

fn put_body_with_terms(
    key: &LendingKey,
    challenge: &[u8; 32],
    name: &str,
    terms: &LenderTerms,
) -> Value {
    let signature =
        sign_directory_action(key, DirectoryAction::Put, challenge, name, Some(terms)).unwrap();
    json!({
        "display_name": name,
        "challenge": hex::encode(challenge),
        "terms": terms_json(terms),
        "signature": signature.to_string(),
    })
}

fn put_body(key: &LendingKey, challenge: &[u8; 32], name: &str) -> Value {
    put_body_with_terms(key, challenge, name, &sample_terms())
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after 1970")
        .as_secs() as i64
}

fn delete_body(key: &LendingKey, challenge: &[u8; 32]) -> Value {
    let signature =
        sign_directory_action(key, DirectoryAction::Delete, challenge, "", None).unwrap();
    json!({
        "challenge": hex::encode(challenge),
        "signature": signature.to_string(),
    })
}

async fn assert_error(
    response: reqwest::Response,
    status: StatusCode,
    code: &str,
    message: Option<&str>,
) -> anyhow::Result<()> {
    assert_eq!(response.status(), status);
    let body = response_json(response).await?;
    assert_eq!(body["error"]["code"], code);
    if let Some(message) = message {
        assert_eq!(body["error"]["message"], message);
    }
    Ok(())
}

const CHALLENGE_MESSAGE: &str = "unknown, used or expired challenge";

#[tokio::test]
#[serial]
async fn directory_entry_round_trip() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let pk = pubkey_hex(&key);
    let url = format!("{base}/private/directory/{pk}");

    let response = http
        .post(format!("{base}/private/directory/challenges"))
        .send()
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let issued = response_json(response).await?;
    let now = unix_now();
    let remaining = issued["expires_at"].as_i64().unwrap() - now;
    assert!((291..=300).contains(&remaining), "remaining {remaining}");
    let c: [u8; 32] = hex::decode(issued["challenge"].as_str().unwrap())?
        .try_into()
        .unwrap();

    let response = send_json(
        &http,
        Method::PUT,
        url.clone(),
        put_body(&key, &c, "Acme Bank"),
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let created = response_json(response).await?;
    assert_eq!(created["display_name"], "Acme Bank");
    assert_eq!(created["pubkey"], pk);
    assert_eq!(created["terms"], terms_json(&sample_terms()));
    let published = created["terms_published_at"].as_i64().unwrap();
    assert!(
        (now - 5..=now + 5).contains(&published),
        "published {published}"
    );

    let list = response_json(http.get(format!("{base}/private/directory")).send().await?).await?;
    assert_eq!(list["items"], json!([created.clone()]));
    assert_eq!(list["total"], 1);
    assert_eq!(list["limit"], 50);
    assert_eq!(list["offset"], 0);
    let fetched = response_json(http.get(&url).send().await?).await?;
    assert_eq!(fetched, created);

    let c = issue_challenge(&http, &base).await?;
    let new_terms = LenderTerms {
        pairs: vec![pair(0x11, 0x22), pair(0x33, 0x22)],
    };
    let response = send_json(
        &http,
        Method::PUT,
        url.clone(),
        put_body_with_terms(&key, &c, "Acme Bank Ltd", &new_terms),
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let updated = response_json(response).await?;
    assert_eq!(updated["display_name"], "Acme Bank Ltd");
    assert_eq!(updated["terms"], terms_json(&new_terms));
    assert_eq!(updated["created_at"], created["created_at"]);
    assert!(updated["updated_at"].as_i64() >= updated["created_at"].as_i64());
    assert!(updated["terms_published_at"].as_i64() >= created["terms_published_at"].as_i64());
    let fetched = response_json(http.get(&url).send().await?).await?;
    assert_eq!(fetched, updated);

    let c = issue_challenge(&http, &base).await?;
    let response = send_json(&http, Method::DELETE, url.clone(), delete_body(&key, &c)).await?;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = http.get(&url).send().await?;
    assert_error(response, StatusCode::NOT_FOUND, "not_found", None).await
}

#[tokio::test]
#[serial]
async fn bad_signature_is_rejected_and_keeps_the_challenge() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let (key, other) = (lending_key(5), lending_key(6));
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));
    let c = issue_challenge(&http, &base).await?;

    let forged = put_body(&other, &c, "Acme");
    let response = send_json(&http, Method::PUT, url.clone(), forged).await?;
    assert_error(
        response,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        Some("invalid signature"),
    )
    .await?;

    let response = send_json(&http, Method::PUT, url, put_body(&key, &c, "Acme")).await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
#[serial]
async fn replayed_challenge_is_rejected() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));
    let c = issue_challenge(&http, &base).await?;
    let body = put_body(&key, &c, "Acme");

    let response = send_json(&http, Method::PUT, url.clone(), body.clone()).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let response = send_json(&http, Method::PUT, url, body).await?;
    assert_error(
        response,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        Some(CHALLENGE_MESSAGE),
    )
    .await
}

#[tokio::test]
#[serial]
async fn expired_challenge_is_rejected() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let c = [9u8; 32];
    seed_directory_challenge(&pool, c, -60).await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));

    let response = send_json(&http, Method::PUT, url, put_body(&key, &c, "Acme")).await?;
    assert_error(
        response,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        Some(CHALLENGE_MESSAGE),
    )
    .await
}

#[tokio::test]
#[serial]
async fn signature_for_another_action_or_name_is_rejected() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));
    let c = issue_challenge(&http, &base).await?;
    let terms = sample_terms();
    let put_signature = sign_directory_action(&key, DirectoryAction::Put, &c, "Acme", Some(&terms))
        .unwrap()
        .to_string();

    let as_delete = json!({ "challenge": hex::encode(c), "signature": put_signature });
    let response = send_json(&http, Method::DELETE, url.clone(), as_delete).await?;
    assert_error(
        response,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        Some("invalid signature"),
    )
    .await?;

    let renamed = json!({
        "display_name": "Acne",
        "challenge": hex::encode(c),
        "terms": terms_json(&terms),
        "signature": put_signature,
    });
    let response = send_json(&http, Method::PUT, url, renamed).await?;
    assert_error(
        response,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        Some("invalid signature"),
    )
    .await
}

#[tokio::test]
#[serial]
async fn malformed_requests_are_rejected() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let pk = pubkey_hex(&key);
    let c = issue_challenge(&http, &base).await?;
    let good = put_body(&key, &c, "Acme");

    for bad_pk in ["zz".to_string(), "ff".repeat(32)] {
        let url = format!("{base}/private/directory/{bad_pk}");
        let response = send_json(&http, Method::PUT, url, good.clone()).await?;
        assert_error(response, StatusCode::BAD_REQUEST, "bad_request", None).await?;
    }

    let url = format!("{base}/private/directory/{pk}");
    let mut short_challenge = good.clone();
    short_challenge["challenge"] = json!(hex::encode([1u8; 31]));
    let mut short_signature = good.clone();
    short_signature["signature"] = json!(hex::encode([1u8; 63]));
    let mut bodies = vec![short_challenge, short_signature];
    for name in [
        String::new(),
        " Acme".to_string(),
        "a".repeat(65),
        "Ac\u{7}me".to_string(),
    ] {
        let mut body = good.clone();
        body["display_name"] = json!(name);
        bodies.push(body);
    }
    for body in bodies {
        let response = send_json(&http, Method::PUT, url.clone(), body).await?;
        assert_error(response, StatusCode::BAD_REQUEST, "bad_request", None).await?;
    }

    // None of the rejected requests consumed the challenge.
    let response = send_json(&http, Method::PUT, url, good).await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
#[serial]
async fn directory_list_pages_in_name_order_and_caps_limit() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    for (byte, name) in [(1u8, "Bravo"), (2, "Alpha"), (3, "Charlie")] {
        let key = lending_key(byte);
        let c = issue_challenge(&http, &base).await?;
        let url = format!("{base}/private/directory/{}", pubkey_hex(&key));
        let response = send_json(&http, Method::PUT, url, put_body(&key, &c, name)).await?;
        assert_eq!(response.status(), StatusCode::OK);
    }

    let page = response_json(
        http.get(format!("{base}/private/directory?limit=2&offset=1"))
            .send()
            .await?,
    )
    .await?;
    let names: Vec<_> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["display_name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Bravo", "Charlie"]);
    assert_eq!(page["total"], 3);

    let beyond = response_json(
        http.get(format!(
            "{base}/private/directory?offset=9223372036854775808"
        ))
        .send()
        .await?,
    )
    .await?;
    assert_eq!(beyond["items"], json!([]));
    assert_eq!(beyond["total"], 3);

    let response = http
        .get(format!("{base}/private/directory?limit=101"))
        .send()
        .await?;
    assert_error(response, StatusCode::BAD_REQUEST, "bad_request", None).await
}

#[tokio::test]
#[serial]
async fn deleting_a_missing_entry_is_not_found() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));
    let c = issue_challenge(&http, &base).await?;

    let response = send_json(&http, Method::DELETE, url, delete_body(&key, &c)).await?;
    assert_error(response, StatusCode::NOT_FOUND, "not_found", None).await
}

#[tokio::test]
#[serial]
async fn signature_over_other_terms_is_rejected() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));
    let c = issue_challenge(&http, &base).await?;

    // Signed over one set of terms, sent with another that differs in one byte of the encoding.
    let signed = put_body(&key, &c, "Acme");
    let mut changed_terms = sample_terms();
    changed_terms.pairs[0].min_apr_bps += 1;
    let mut tampered = signed.clone();
    tampered["terms"] = terms_json(&changed_terms);
    let response = send_json(&http, Method::PUT, url.clone(), tampered).await?;
    assert_error(
        response,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        Some("invalid signature"),
    )
    .await?;

    // A signature over no terms does not cover the terms sent with it.
    let unsigned = sign_directory_action(&key, DirectoryAction::Put, &c, "Acme", None)?;
    let mut without = signed.clone();
    without["signature"] = json!(unsigned.to_string());
    let response = send_json(&http, Method::PUT, url.clone(), without).await?;
    assert_error(
        response,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        Some("invalid signature"),
    )
    .await?;

    let response = send_json(&http, Method::PUT, url, signed).await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
#[serial]
async fn put_without_terms_is_unprocessable() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));
    let c = issue_challenge(&http, &base).await?;

    let signature = sign_directory_action(&key, DirectoryAction::Put, &c, "Acme", None)?;
    let body = json!({
        "display_name": "Acme",
        "challenge": hex::encode(c),
        "signature": signature.to_string(),
    });
    let response = send_json(&http, Method::PUT, url.clone(), body).await?;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["error"]["code"], "unprocessable_entity");
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.contains("terms"), "{message}");

    let mut null_terms = put_body(&key, &c, "Acme");
    null_terms["terms"] = Value::Null;
    let response = send_json(&http, Method::PUT, url.clone(), null_terms).await?;
    assert_error(
        response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "unprocessable_entity",
        None,
    )
    .await?;

    // The rejected puts did not consume the challenge.
    let response = send_json(&http, Method::PUT, url, put_body(&key, &c, "Acme")).await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
#[serial]
async fn invalid_terms_are_unprocessable() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));
    let c = issue_challenge(&http, &base).await?;
    let good = put_body(&key, &c, "Acme");

    let with_terms = |change: &dyn Fn(&mut Value)| {
        let mut body = good.clone();
        change(&mut body["terms"]);
        body
    };
    let cases: Vec<(Value, &str)> = vec![
        (
            with_terms(&|terms| {
                terms["pairs"][0]["min_principal"] = json!("10000001");
            }),
            "terms: bad lender terms principal range",
        ),
        (
            with_terms(&|terms| terms["pairs"] = json!([])),
            "terms: bad lender terms pair count 0",
        ),
        (
            with_terms(&|terms| {
                let first = terms["pairs"][0].clone();
                terms["pairs"] = json!([first.clone(), first]);
            }),
            "terms: two lender terms pairs have the same assets",
        ),
        (
            with_terms(&|terms| terms["pairs"][0]["max_term_days"] = json!(3651)),
            "terms: bad lender terms term range",
        ),
        (
            with_terms(&|terms| terms["pairs"][0]["min_principal"] = json!("")),
            "terms.pairs[0].min_principal is not a string of decimal digits",
        ),
        (
            with_terms(&|terms| terms["pairs"][0]["max_principal"] = json!("-1")),
            "terms.pairs[0].max_principal is not a string of decimal digits",
        ),
        (
            with_terms(&|terms| {
                terms["pairs"][0]["max_principal_per_collateral"] = json!("18446744073709551616");
            }),
            "terms.pairs[0].max_principal_per_collateral is above 18446744073709551615",
        ),
        (
            with_terms(&|terms| terms["pairs"][0]["collateral_asset"] = json!("22")),
            "terms.pairs[0].collateral_asset is not 64 hex characters",
        ),
    ];
    for (body, message) in cases {
        let response = send_json(&http, Method::PUT, url.clone(), body).await?;
        assert_error(
            response,
            StatusCode::UNPROCESSABLE_ENTITY,
            "unprocessable_entity",
            Some(message),
        )
        .await?;
    }

    // Shapes the JSON extractor refuses, naming the field by its path: an unknown key, an amount
    // as a number, a u32 as a string, a fraction, a negative number and a missing field.
    let shapes = [
        (
            with_terms(&|terms| terms["pairs"][0]["min_ltv_bps"] = json!(5000)),
            "min_ltv_bps",
        ),
        (with_terms(&|terms| terms["version"] = json!(1)), "version"),
        (
            with_terms(&|terms| terms["pairs"][0]["min_principal"] = json!(1000)),
            "terms.pairs[0].min_principal",
        ),
        (
            with_terms(&|terms| terms["pairs"][0]["min_apr_bps"] = json!("500")),
            "terms.pairs[0].min_apr_bps",
        ),
        (
            with_terms(&|terms| terms["pairs"][0]["min_term_days"] = json!(1.5)),
            "terms.pairs[0].min_term_days",
        ),
        (
            with_terms(&|terms| terms["pairs"][0]["max_term_days"] = json!(-30)),
            "terms.pairs[0].max_term_days",
        ),
        (
            with_terms(&|terms| {
                terms["pairs"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("principal_asset");
            }),
            "principal_asset",
        ),
    ];
    for (body, field) in shapes {
        let response = send_json(&http, Method::PUT, url.clone(), body).await?;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = response_json(response).await?;
        assert_eq!(body["error"]["code"], "unprocessable_entity");
        let message = body["error"]["message"].as_str().unwrap();
        assert!(message.contains(field), "{message}");
    }

    // None of the rejected requests consumed the challenge.
    let response = send_json(&http, Method::PUT, url, good).await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
#[serial]
async fn delete_with_terms_is_unprocessable() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let key = lending_key(5);
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));
    let c = issue_challenge(&http, &base).await?;
    let response = send_json(&http, Method::PUT, url.clone(), put_body(&key, &c, "Acme")).await?;
    assert_eq!(response.status(), StatusCode::OK);

    let c = issue_challenge(&http, &base).await?;
    let mut body = delete_body(&key, &c);
    body["terms"] = terms_json(&sample_terms());
    let response = send_json(&http, Method::DELETE, url.clone(), body).await?;
    assert_error(
        response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "unprocessable_entity",
        None,
    )
    .await?;

    let response = send_json(&http, Method::DELETE, url, delete_body(&key, &c)).await?;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    Ok(())
}

#[tokio::test]
#[serial]
async fn entry_without_terms_is_unlisted_until_a_put_with_terms() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    // An entry as written before the directory carried terms.
    let key = lending_key(5);
    sqlx::query(
        "INSERT INTO directory_entries (pubkey, display_name, created_at, updated_at)
         VALUES ($1, 'Old Acme', now() - interval '1 day', now() - interval '1 day')",
    )
    .bind(key.x_only_public_key().serialize().to_vec())
    .execute(&pool)
    .await?;
    let (base, _server) = start_api(pool).await?;
    let http = reqwest::Client::new();
    let url = format!("{base}/private/directory/{}", pubkey_hex(&key));

    let list = response_json(http.get(format!("{base}/private/directory")).send().await?).await?;
    assert_eq!(list["items"], json!([]));
    assert_eq!(list["total"], 0);

    let old = response_json(http.get(&url).send().await?).await?;
    assert_eq!(old["display_name"], "Old Acme");
    assert_eq!(old["terms"], Value::Null);
    assert_eq!(old["terms_published_at"], Value::Null);

    let c = issue_challenge(&http, &base).await?;
    let response = send_json(&http, Method::PUT, url.clone(), put_body(&key, &c, "Acme")).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let updated = response_json(response).await?;
    assert_eq!(updated["created_at"], old["created_at"]);
    assert_eq!(updated["terms"], terms_json(&sample_terms()));
    assert!(updated["terms_published_at"].as_i64().is_some());

    let list = response_json(http.get(format!("{base}/private/directory")).send().await?).await?;
    assert_eq!(list["items"], json!([updated]));
    assert_eq!(list["total"], 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn undecodable_stored_terms_are_served_as_none() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let (good, broken) = (lending_key(5), lending_key(6));
    let (base, _server) = start_api(pool.clone()).await?;
    let http = reqwest::Client::new();
    let c = issue_challenge(&http, &base).await?;
    let url = format!("{base}/private/directory/{}", pubkey_hex(&good));
    let response = send_json(&http, Method::PUT, url, put_body(&good, &c, "Bravo")).await?;
    assert_eq!(response.status(), StatusCode::OK);
    sqlx::query(
        "INSERT INTO directory_entries (pubkey, display_name, terms, terms_published_at)
         VALUES ($1, 'Alpha', $2, now())",
    )
    .bind(broken.x_only_public_key().serialize().to_vec())
    .bind(vec![2u8, 1])
    .execute(&pool)
    .await?;

    let list = response_json(http.get(format!("{base}/private/directory")).send().await?).await?;
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["display_name"], "Alpha");
    assert_eq!(items[0]["terms"], Value::Null);
    assert_eq!(items[0]["terms_published_at"], Value::Null);
    assert_eq!(items[1]["terms"], terms_json(&sample_terms()));
    Ok(())
}
