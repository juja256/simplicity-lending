//! WebAssembly module for Simplicity Lending private offers: the cryptography of
//! [`private_lending_core`] for the browser.
//!
//! Exported functions return `Result<_, String>`; an error string is `<code>: <message>` (see
//! [`error`]). They never build a `JsValue` or `JsError`, which panic outside wasm, so native
//! tests can call them.

use elements::hashes::{Hash, sha256};

mod error;
mod keys;
mod scan;

pub use keys::{LendingKey, key_fingerprint};
pub use scan::{is_own_candidate, private_lending_program_id, view_tag_matches};

/// The private lending program source, the same file the contracts crate compiles.
const PROGRAM_SOURCE: &str = include_str!("../../contracts/simf/private_lending.simf");

/// The program id as 8 hex characters: the first 4 bytes of the SHA-256 of the source.
pub(crate) fn program_id_hex() -> String {
    let hash = sha256::Hash::hash(PROGRAM_SOURCE.as_bytes());
    error::encode_hex(&hash.as_byte_array()[..4])
}
