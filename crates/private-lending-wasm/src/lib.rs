//! WebAssembly module for Simplicity Lending private offers: the cryptography of
//! [`private_lending_core`] for the browser.
//!
//! Exported functions return `Result<_, String>`; an error string is `<code>: <message>` (see
//! [`error`]). They never build a `JsValue` or `JsError`, which panic outside wasm, so native
//! tests can call them.

use elements::hashes::{Hash, sha256};

mod blind;
mod build;
mod directory;
mod error;
mod keys;
mod open;
mod scan;

pub use blind::{InputSecret, PinnedBlinding, blind_pset};
pub use build::{NewOffer, OfferTermsInput, contract_hash_from_json, issued_asset_id};
pub use directory::{DirectoryAction, sign_directory_action};
pub use keys::{LendingKey, confidential_address, fresh_issuer_pubkey, key_fingerprint};
pub use open::{
    ContractArguments, OpenedOffer, PinnedOutputInfo, PinnedRole, open_creation_as_borrower_hex,
    open_creation_as_lender_hex,
};
pub use scan::{is_own_candidate, private_lending_program_id, view_tag_matches};

/// The private lending program source, the same file the contracts crate compiles.
const PROGRAM_SOURCE: &str = include_str!("../../contracts/simf/private_lending.simf");

/// The program id: the first 4 bytes of the SHA-256 of the source.
pub(crate) fn program_id() -> [u8; 4] {
    let hash = sha256::Hash::hash(PROGRAM_SOURCE.as_bytes());
    let mut id = [0; 4];
    id.copy_from_slice(&hash.as_byte_array()[..4]);
    id
}

/// The program id as 8 hex characters.
pub(crate) fn program_id_hex() -> String {
    error::encode_hex(&program_id())
}
