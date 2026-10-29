use std::sync::Arc;

use axum::{
    Router,
    routing::{get, post},
};

use crate::api::AppState;

use super::handlers;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/private/directory", get(handlers::list_entries))
        .route(
            "/private/directory/challenges",
            post(handlers::issue_challenge),
        )
        .route(
            "/private/directory/{pubkey}",
            get(handlers::get_entry)
                .put(handlers::put_entry)
                .delete(handlers::delete_entry),
        )
}
