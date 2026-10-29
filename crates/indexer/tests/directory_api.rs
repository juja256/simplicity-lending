mod common;

use private_lending_core::{DirectoryAction, LendingKey, sign_directory_action};
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

fn put_body(key: &LendingKey, challenge: &[u8; 32], name: &str) -> Value {
    let signature = sign_directory_action(key, DirectoryAction::Put, challenge, name);
    json!({
        "display_name": name,
        "challenge": hex::encode(challenge),
        "signature": signature.to_string(),
    })
}

fn delete_body(key: &LendingKey, challenge: &[u8; 32]) -> Value {
    let signature = sign_directory_action(key, DirectoryAction::Delete, challenge, "");
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
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;
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

    let list = response_json(http.get(format!("{base}/private/directory")).send().await?).await?;
    assert_eq!(list["items"], json!([created.clone()]));
    assert_eq!(list["total"], 1);
    assert_eq!(list["limit"], 50);
    assert_eq!(list["offset"], 0);
    let fetched = response_json(http.get(&url).send().await?).await?;
    assert_eq!(fetched, created);

    let c = issue_challenge(&http, &base).await?;
    let response = send_json(
        &http,
        Method::PUT,
        url.clone(),
        put_body(&key, &c, "Acme Bank Ltd"),
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let updated = response_json(response).await?;
    assert_eq!(updated["display_name"], "Acme Bank Ltd");
    assert_eq!(updated["created_at"], created["created_at"]);
    assert!(updated["updated_at"].as_i64() >= updated["created_at"].as_i64());

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
    let put_signature = sign_directory_action(&key, DirectoryAction::Put, &c, "Acme").to_string();

    let as_delete = json!({ "challenge": hex::encode(c), "signature": put_signature });
    let response = send_json(&http, Method::DELETE, url.clone(), as_delete).await?;
    assert_error(
        response,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        Some("invalid signature"),
    )
    .await?;

    let renamed =
        json!({ "display_name": "Acne", "challenge": hex::encode(c), "signature": put_signature });
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
