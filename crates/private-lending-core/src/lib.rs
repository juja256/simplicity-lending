//! Cryptography of Simplicity Lending private offers: lending keys, per-offer secrets, signed
//! terms, the marker, pinned outputs, building offers, and finding, opening and checking them in
//! their creation transactions; a loan's debt as a curve point, with the installments that pay it;
//! the release of collateral by installments, with the derived values of the liquidation repair
//! and the borrower's proof of each release; the private messages of a loan's parties; and the
//! terms lenders publish in the directory, with the check of a proposal against them.
//!
//! The crate depends only on `elements`, `rand` and `k256` (whose field arithmetic tells whether a
//! commitment's `y` is a square, and whose group arithmetic proves and verifies the releases), so
//! the contracts crate and the browser's wasm module run the same code.
//!
//! Signing the terms ([`SignedTerms::sign`]) or a message ([`SignedMessage::sign`]) draws its
//! auxiliary randomness from `rand`'s thread RNG, as does a caller that passes `rand::thread_rng()`
//! to [`blind_pset`]. The thread RNG seeds from the operating system through `getrandom`, which on
//! `wasm32-unknown-unknown` has no source unless its `js` feature is enabled: a wasm build must
//! depend on `getrandom` 0.2 (the version `rand` 0.8 uses) with `features = ["js"]`.

mod blind;
mod creation;
mod debt;
mod directory;
mod keys;
mod lender_terms;
mod marker;
mod message;
mod offer;
mod pinned;
mod release;
mod release_proof;
mod secrets;
mod terms;

use elements::hashes::{Hash, HashEngine, sha256};

pub use blind::{BlindPsetError, PinnedBlinding, RewindError, blind_pset, rewind};
pub use creation::{
    CreationError, FoundOffer, find_offer, open_creation_as_borrower, open_creation_as_lender,
};
pub use debt::{
    DebtError, DebtOpening, InstallmentError, asset_plus_generator, asset_point, debt_after,
    debt_hash, open_installment, open_installment_with_extra_data, sweep_opening, value_point,
    zero_debt_blinder, zero_debt_key,
};
pub use directory::{
    DIRECTORY_TAG, DirectoryAction, DirectorySignError, directory_message, sign_directory_action,
    verify_directory_action,
};
pub use keys::{LendingKey, ephemeral_key, installment_ephemeral_key, lift_lending_key};
pub use lender_terms::{
    BLOCKS_PER_DAY, BLOCKS_PER_YEAR, COLLATERAL_SCALE, LENDER_TERMS_VERSION, LenderTerms,
    LenderTermsError, MAX_PAIRS, MAX_TERM_DAYS, PairTerms, Proposal, TermBreach, apr_bps,
    min_collateral, min_repayment, principal_per_collateral,
};
pub use marker::Marker;
pub use message::{
    MAX_CREATION_MESSAGE_BYTES, MAX_SIGNED_MESSAGE_BYTES, MESSAGE_ROOM, Message, MessageError,
    MessageKind, MessagePhase, SignedMessage,
};
pub use offer::{NewOffer, OfferError, OfferPinned, OpenError, OpenedOffer};
pub use pinned::PinnedOutput;
pub use release::{
    BlinderTree, CARRY_SUPPLY, LEAF_IV, MAX_COLLATERAL, MAX_REPAYMENT, MAX_STEPS, NODE_IV,
    ReleaseError, carry_remainder, check_bounds, collateral_at, fold_path, fs_iv, release_j,
    release_of,
};
pub use release_proof::{ReleaseProof, ReleaseSecrets, ReleaseStatement, challenge, prove, verify};
pub use secrets::{OfferSecrets, PinnedRole, expiry_hash};
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
