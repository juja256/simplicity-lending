use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use utoipa::IntoParams;

use crate::api::openapi::ErrorResponse;
use crate::api::params::deserialize_optional_u64;
use crate::api::utils::parse_filter_hex;
use crate::api::{ApiError, AppState};

use super::dto::{PrivateCandidateDetails, PrivateCandidateList, PrivateCreationTx};

const DEFAULT_CANDIDATE_LIMIT: u64 = 100;
const MAX_CANDIDATE_LIMIT: u64 = 500;

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct CandidateQuery {
    /// First block height to include (default 0).
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub from_height: Option<u64>,
    /// Last block height to include. Capped at the indexer's sync height.
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub to_height: Option<u64>,
    /// Maximum records to return (default 100, max 500; larger values are rejected).
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub limit: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub offset: Option<u64>,
}

fn parse_txid(txid: &str) -> Result<Vec<u8>, ApiError> {
    parse_filter_hex(txid)
        .filter(|bytes| bytes.len() == 32)
        .ok_or_else(|| ApiError::BadRequest("Invalid creation_txid".to_string()))
}

#[utoipa::path(
    get,
    path = "/private/candidates",
    tag = "private",
    operation_id = "list_private_candidates",
    params(CandidateQuery),
    responses(
        (status = 200, description = "Private offer candidates created in a height range, oldest first", body = PrivateCandidateList),
        (status = 400, description = "Invalid query parameters", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse),
    )
)]
#[tracing::instrument(name = "Listing private candidates", skip(state, query))]
pub async fn list_candidates(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CandidateQuery>,
) -> Result<Json<PrivateCandidateList>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_CANDIDATE_LIMIT);
    if limit > MAX_CANDIDATE_LIMIT {
        return Err(ApiError::BadRequest(format!(
            "limit must not exceed {MAX_CANDIDATE_LIMIT}"
        )));
    }

    let list = super::db::fetch_candidates(
        &state.db,
        query.from_height.unwrap_or(0),
        query.to_height,
        limit,
        query.offset.unwrap_or(0),
    )
    .await?;

    Ok(Json(list))
}

#[utoipa::path(
    get,
    path = "/private/candidates/{creation_txid}",
    tag = "private",
    operation_id = "get_private_candidate",
    params(("creation_txid" = String, Path, description = "Creation transaction id, display-order hex")),
    responses(
        (status = 200, description = "Candidate with its tracked UTXOs", body = PrivateCandidateDetails),
        (status = 400, description = "Malformed txid", body = ErrorResponse),
        (status = 404, description = "Unknown candidate", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse),
    )
)]
#[tracing::instrument(name = "Getting private candidate", skip(state))]
pub async fn get_candidate(
    State(state): State<Arc<AppState>>,
    Path(creation_txid): Path<String>,
) -> Result<Json<PrivateCandidateDetails>, ApiError> {
    let txid = parse_txid(&creation_txid)?;
    let details = super::db::fetch_candidate_details(&state.db, &txid)
        .await?
        .ok_or(ApiError::NotFound(creation_txid))?;

    Ok(Json(details))
}

#[utoipa::path(
    get,
    path = "/private/candidates/{creation_txid}/tx",
    tag = "private",
    operation_id = "get_private_candidate_tx",
    params(("creation_txid" = String, Path, description = "Creation transaction id, display-order hex")),
    responses(
        (status = 200, description = "Consensus-encoded creation transaction", body = PrivateCreationTx),
        (status = 400, description = "Malformed txid", body = ErrorResponse),
        (status = 404, description = "Unknown candidate", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse),
    )
)]
#[tracing::instrument(name = "Getting private creation tx", skip(state))]
pub async fn get_candidate_tx(
    State(state): State<Arc<AppState>>,
    Path(creation_txid): Path<String>,
) -> Result<Json<PrivateCreationTx>, ApiError> {
    let txid = parse_txid(&creation_txid)?;
    let tx = super::db::fetch_creation_tx(&state.db, &txid)
        .await?
        .ok_or(ApiError::NotFound(creation_txid))?;

    Ok(Json(tx))
}
