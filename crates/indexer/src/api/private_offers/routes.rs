use std::sync::Arc;

use axum::{Router, routing::get};

use crate::api::AppState;

use super::handlers;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/private/candidates", get(handlers::list_candidates))
        .route(
            "/private/candidates/{creation_txid}",
            get(handlers::get_candidate),
        )
        .route(
            "/private/candidates/{creation_txid}/tx",
            get(handlers::get_candidate_tx),
        )
}
