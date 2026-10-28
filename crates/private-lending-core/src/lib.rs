//! Cryptography of Simplicity Lending private offers: lending keys and per-offer secrets.
//!
//! The crate depends only on `elements` and `rand`, so the contracts crate and the browser's wasm
//! module run the same code.

mod blind;
mod keys;
mod marker;
mod pinned;
mod secrets;
mod terms;

use elements::hashes::{Hash, HashEngine, sha256};

pub use blind::{BlindPsetError, PinnedBlinding, RewindError, blind_pset, rewind};
pub use keys::{LendingKey, ephemeral_key, lift_lending_key};
pub use marker::Marker;
pub use pinned::PinnedOutput;
pub use secrets::{OfferSecrets, PinnedRole};
pub use terms::{OfferTerms, SignedTerms, TERMS_VERSION, TermsError};

/// The BIP340-style tagged hash `SHA256(SHA256(tag) ‖ SHA256(tag) ‖ data)`, where `data` is the
/// concatenation of the given parts.
pub fn tagged_hash(tag: &str, data: &[&[u8]]) -> [u8; 32] {
    let tag_hash = sha256::Hash::hash(tag.as_bytes());

    let mut engine = sha256::Hash::engine();
    engine.input(tag_hash.as_byte_array());
    engine.input(tag_hash.as_byte_array());
    for part in data {
        engine.input(part);
    }

    sha256::Hash::from_engine(engine).to_byte_array()
}
