use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use elements::secp256k1_zkp::{XOnlyPublicKey, schnorr};
use private_lending_core::{DirectoryAction, verify_directory_action};
use serde::Deserialize;
use utoipa::IntoParams;

use crate::api::openapi::ErrorResponse;
use crate::api::params::deserialize_optional_u64;
use crate::api::{ApiError, AppState};

use super::dto::{
    DeleteDirectoryEntry, DirectoryChallenge, DirectoryEntry, DirectoryList, PutDirectoryEntry,
};

const DEFAULT_DIRECTORY_LIMIT: u64 = 50;
const MAX_DIRECTORY_LIMIT: u64 = 100;
const MAX_NAME_CHARS: usize = 64;

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DirectoryQuery {
    /// Maximum records to return (default 50, max 100; larger values are rejected).
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub limit: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub offset: Option<u64>,
}

fn parse_pubkey(pubkey: &str) -> Result<(XOnlyPublicKey, Vec<u8>), ApiError> {
    let invalid = || ApiError::BadRequest("Invalid pubkey".to_string());
    let bytes = hex::decode(pubkey).map_err(|_| invalid())?;
    let key = XOnlyPublicKey::from_slice(&bytes).map_err(|_| invalid())?;
    Ok((key, bytes))
}

fn parse_challenge(challenge: &str) -> Result<[u8; 32], ApiError> {
    hex::decode(challenge)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| ApiError::BadRequest("Invalid challenge".to_string()))
}

fn parse_signature(signature: &str) -> Result<schnorr::Signature, ApiError> {
    hex::decode(signature)
        .ok()
        .and_then(|bytes| schnorr::Signature::from_slice(&bytes).ok())
        .ok_or_else(|| ApiError::BadRequest("Invalid signature encoding".to_string()))
}

fn validate_display_name(name: &str) -> Result<(), ApiError> {
    let chars = name.chars().count();
    if chars == 0 || chars > MAX_NAME_CHARS {
        return Err(ApiError::BadRequest(format!(
            "display_name must be 1 to {MAX_NAME_CHARS} characters"
        )));
    }
    if name.trim() != name {
        return Err(ApiError::BadRequest(
            "display_name must not have leading or trailing whitespace".to_string(),
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(ApiError::BadRequest(
            "display_name must not contain control characters".to_string(),
        ));
    }
    Ok(())
}

fn check_signature(
    key: &XOnlyPublicKey,
    action: DirectoryAction,
    challenge: &[u8; 32],
    display_name: &str,
    signature: &schnorr::Signature,
) -> Result<(), ApiError> {
    if verify_directory_action(key, action, challenge, display_name, signature) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized("invalid signature".to_string()))
    }
}

fn challenge_rejected() -> ApiError {
    ApiError::Unauthorized("unknown, used or expired challenge".to_string())
}

#[utoipa::path(
    post,
    path = "/private/directory/challenges",
    tag = "directory",
    operation_id = "issue_directory_challenge",
    responses(
        (status = 200, description = "A single-use challenge valid for 300 seconds", body = DirectoryChallenge),
        (status = 500, description = "Internal server error", body = ErrorResponse),
    )
)]
#[tracing::instrument(name = "Issuing directory challenge", skip(state))]
pub async fn issue_challenge(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DirectoryChallenge>, ApiError> {
    Ok(Json(super::db::issue_challenge(&state.db).await?))
}

#[utoipa::path(
    get,
    path = "/private/directory",
    tag = "directory",
    operation_id = "list_directory_entries",
    params(DirectoryQuery),
    responses(
        (status = 200, description = "Directory entries ordered by display name", body = DirectoryList),
        (status = 400, description = "Invalid query parameters", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse),
    )
)]
#[tracing::instrument(name = "Listing directory", skip(state, query))]
pub async fn list_entries(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DirectoryQuery>,
) -> Result<Json<DirectoryList>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_DIRECTORY_LIMIT);
    if limit > MAX_DIRECTORY_LIMIT {
        return Err(ApiError::BadRequest(format!(
            "limit must not exceed {MAX_DIRECTORY_LIMIT}"
        )));
    }
    let list = super::db::list_entries(&state.db, limit, query.offset.unwrap_or(0)).await?;
    Ok(Json(list))
}

#[utoipa::path(
    get,
    path = "/private/directory/{pubkey}",
    tag = "directory",
    operation_id = "get_directory_entry",
    params(("pubkey" = String, Path, description = "X-only lending key, 32 bytes, hex")),
    responses(
        (status = 200, description = "The directory entry", body = DirectoryEntry),
        (status = 400, description = "Malformed pubkey", body = ErrorResponse),
        (status = 404, description = "No such entry", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse),
    )
)]
#[tracing::instrument(name = "Fetching directory entry", skip(state))]
pub async fn get_entry(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
) -> Result<Json<DirectoryEntry>, ApiError> {
    let (_, bytes) = parse_pubkey(&pubkey)?;
    super::db::fetch_entry(&state.db, &bytes)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::NotFound(pubkey))
}

#[utoipa::path(
    put,
    path = "/private/directory/{pubkey}",
    tag = "directory",
    operation_id = "put_directory_entry",
    params(("pubkey" = String, Path, description = "X-only lending key, 32 bytes, hex")),
    request_body = PutDirectoryEntry,
    responses(
        (status = 200, description = "The created or updated entry", body = DirectoryEntry),
        (status = 400, description = "Malformed request", body = ErrorResponse),
        (status = 401, description = "Invalid signature, or unknown, used or expired challenge", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse),
    )
)]
#[tracing::instrument(name = "Putting directory entry", skip(state, body))]
pub async fn put_entry(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
    Json(body): Json<PutDirectoryEntry>,
) -> Result<Json<DirectoryEntry>, ApiError> {
    let (key, bytes) = parse_pubkey(&pubkey)?;
    let challenge = parse_challenge(&body.challenge)?;
    let signature = parse_signature(&body.signature)?;
    validate_display_name(&body.display_name)?;
    check_signature(
        &key,
        DirectoryAction::Put,
        &challenge,
        &body.display_name,
        &signature,
    )?;

    let mut tx = state.db.begin().await?;
    if !super::db::consume_challenge(&mut tx, &challenge).await? {
        return Err(challenge_rejected());
    }
    let entry = super::db::upsert_entry(&mut tx, &bytes, &body.display_name).await?;
    tx.commit().await?;
    Ok(Json(entry))
}

#[utoipa::path(
    delete,
    path = "/private/directory/{pubkey}",
    tag = "directory",
    operation_id = "delete_directory_entry",
    params(("pubkey" = String, Path, description = "X-only lending key, 32 bytes, hex")),
    request_body = DeleteDirectoryEntry,
    responses(
        (status = 204, description = "Entry deleted"),
        (status = 400, description = "Malformed request", body = ErrorResponse),
        (status = 401, description = "Invalid signature, or unknown, used or expired challenge", body = ErrorResponse),
        (status = 404, description = "No such entry", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse),
    )
)]
#[tracing::instrument(name = "Deleting directory entry", skip(state, body))]
pub async fn delete_entry(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
    Json(body): Json<DeleteDirectoryEntry>,
) -> Result<StatusCode, ApiError> {
    let (key, bytes) = parse_pubkey(&pubkey)?;
    let challenge = parse_challenge(&body.challenge)?;
    let signature = parse_signature(&body.signature)?;
    check_signature(&key, DirectoryAction::Delete, &challenge, "", &signature)?;

    let mut tx = state.db.begin().await?;
    if !super::db::consume_challenge(&mut tx, &challenge).await? {
        return Err(challenge_rejected());
    }
    if !super::db::delete_entry(&mut tx, &bytes).await? {
        // Dropping the transaction rolls back, so the challenge stays usable.
        return Err(ApiError::NotFound(pubkey));
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
