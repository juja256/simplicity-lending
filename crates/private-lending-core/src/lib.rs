//! Cryptography of Simplicity Lending private offers: lending keys, per-offer secrets, signed
//! terms, the marker, pinned outputs, building offers, and finding, opening and checking them in
//! their creation transactions.
//!
//! The crate depends only on `elements` and `rand`, so the contracts crate and the browser's wasm
//! module run the same code.
//!
//! Signing the terms ([`SignedTerms::sign`]) draws its auxiliary randomness from `rand`'s thread
//! RNG, as does a caller that passes `rand::thread_rng()` to [`blind_pset`]. The thread RNG seeds
//! from the operating system through `getrandom`, which on `wasm32-unknown-unknown` has no source
//! unless its `js` feature is enabled: a wasm build must depend on `getrandom` 0.2 (the version
//! `rand` 0.8 uses) with `features = ["js"]`.

mod blind;
mod creation;
mod directory;
mod keys;
mod marker;
mod offer;
mod pinned;
mod secrets;
mod terms;

use elements::hashes::{Hash, HashEngine, sha256};

pub use blind::{BlindPsetError, PinnedBlinding, RewindError, blind_pset, rewind};
pub use creation::{
    CreationError, FoundOffer, find_offer, open_creation_as_borrower, open_creation_as_lender,
};
pub use directory::{
    DIRECTORY_TAG, DirectoryAction, directory_message, sign_directory_action,
    verify_directory_action,
};
pub use keys::{LendingKey, ephemeral_key, lift_lending_key};
pub use marker::Marker;
pub use offer::{NewOffer, OfferError, OfferPinned, OpenError, OpenedOffer};
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

#[cfg(test)]
mod test_util {
    /// The 32 bytes `start..start + 32`, which no byte order mistake leaves unchanged.
    pub(crate) fn sequence(start: u8) -> [u8; 32] {
        std::array::from_fn(|i| start + i as u8)
    }
}
