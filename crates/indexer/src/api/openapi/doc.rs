use utoipa::OpenApi;

#[cfg(feature = "swagger-ui")]
use utoipa_swagger_ui::{Config, SwaggerUi};

use crate::api::directory::dto::{
    DeleteDirectoryEntry, DirectoryChallenge, DirectoryEntry, DirectoryList, LenderTermsDto,
    PairTermsDto, PutDirectoryEntry,
};
use crate::api::directory::handlers as directory_handlers;
use crate::api::events::handlers as event_handlers;
use crate::api::health::{self, HealthResponse};
use crate::api::private_offers::dto::{
    OutPointDto, PrivateCandidate, PrivateCandidateDetails, PrivateCandidateList,
    PrivateCreationTx, PrivateUtxoDto,
};
use crate::api::private_offers::handlers as private_handlers;
use crate::events::IndexerEvent;
use crate::models::{PrivateOfferStatus, PrivateUtxoType};

use super::schemas::{ErrorBody, ErrorResponse};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Simplicity Lending Indexer",
        version = env!("CARGO_PKG_VERSION"),
        description = "REST API for the Simplicity Lending protocol indexer."
    ),
    servers(
        (url = "/api", description = "Public API mount root")
    ),
    paths(
        private_handlers::list_candidates,
        private_handlers::get_candidate,
        private_handlers::get_candidate_tx,
        directory_handlers::issue_challenge,
        directory_handlers::list_entries,
        directory_handlers::get_entry,
        directory_handlers::put_entry,
        directory_handlers::delete_entry,
        event_handlers::subscribe_events,
        health::health,
        health::ready,
    ),
    components(schemas(
        ErrorBody,
        ErrorResponse,
        DeleteDirectoryEntry,
        DirectoryChallenge,
        DirectoryEntry,
        DirectoryList,
        LenderTermsDto,
        PairTermsDto,
        PutDirectoryEntry,
        HealthResponse,
        IndexerEvent,
        OutPointDto,
        PrivateCandidate,
        PrivateCandidateDetails,
        PrivateCandidateList,
        PrivateCreationTx,
        PrivateOfferStatus,
        PrivateUtxoDto,
        PrivateUtxoType,
    )),
    tags(
        (name = "private", description = "Private lending candidate scan"),
        (name = "directory", description = "Lender directory with signed writes"),
        (name = "events", description = "Server-Sent Events for indexer updates"),
        (name = "health", description = "Liveness and readiness checks"),
    )
)]
pub struct ApiDoc;

#[cfg(feature = "swagger-ui")]
pub fn swagger_routes() -> SwaggerUi {
    SwaggerUi::new("/swagger-ui")
        .url("/api-docs/openapi.json", ApiDoc::openapi())
        .config(Config::new(["../api-docs/openapi.json"]))
}

#[cfg(test)]
mod tests {
    use super::ApiDoc;
    use utoipa::OpenApi;

    #[test]
    fn openapi_spec_contains_all_endpoints() {
        let spec = ApiDoc::openapi();
        let paths = spec.paths.paths;

        assert!(paths.contains_key("/private/candidates"));
        assert!(paths.contains_key("/private/candidates/{creation_txid}"));
        assert!(paths.contains_key("/private/candidates/{creation_txid}/tx"));
        assert!(paths.contains_key("/private/directory"));
        assert!(paths.contains_key("/private/directory/{pubkey}"));
        assert!(paths.contains_key("/private/directory/challenges"));
        assert!(paths.contains_key("/health"));
        assert!(paths.contains_key("/ready"));
        assert!(paths.contains_key("/events"));
        assert_eq!(
            paths.len(),
            9,
            "only the private, event and health paths are listed"
        );
    }

    #[test]
    fn openapi_spec_uses_crate_version() {
        let spec = ApiDoc::openapi();
        assert_eq!(spec.info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn openapi_spec_serializes_to_json() {
        let json = serde_json::to_string(&ApiDoc::openapi()).expect("serialize openapi");
        assert!(json.contains("Simplicity Lending Indexer"));
        assert!(json.contains("creation_txid"));
    }

    #[test]
    fn openapi_spec_describes_lender_terms() {
        let spec = ApiDoc::openapi();
        let schemas = spec.components.expect("components").schemas;
        assert!(schemas.contains_key("LenderTermsDto"));
        assert!(schemas.contains_key("PairTermsDto"));
        let json = serde_json::to_string(&schemas["PutDirectoryEntry"]).expect("serialize");
        assert!(json.contains(r#""required":["display_name","challenge","terms","signature"]"#));
    }

    #[test]
    fn openapi_entry_carries_its_signature() {
        let spec = ApiDoc::openapi();
        let schemas = spec.components.expect("components").schemas;
        let entry = serde_json::to_value(&schemas["DirectoryEntry"]).expect("serialize");
        for field in ["signed_challenge", "signature"] {
            assert!(entry["properties"].get(field).is_some(), "{field}");
        }
    }

    #[test]
    fn openapi_operation_ids_are_unique() {
        let spec = ApiDoc::openapi();
        let mut seen = std::collections::HashMap::<String, String>::new();

        for (path, item) in &spec.paths.paths {
            let operations = [
                ("get", item.get.as_ref()),
                ("post", item.post.as_ref()),
                ("put", item.put.as_ref()),
                ("patch", item.patch.as_ref()),
                ("delete", item.delete.as_ref()),
            ];

            for (method, operation) in operations {
                let Some(operation) = operation else {
                    continue;
                };

                let operation_id = operation
                    .operation_id
                    .as_ref()
                    .unwrap_or_else(|| panic!("{method} {path} must declare operation_id"));

                if let Some(previous_path) = seen.insert(operation_id.clone(), path.clone()) {
                    panic!("duplicate operation_id `{operation_id}` on {path} and {previous_path}");
                }
            }
        }
    }
}
