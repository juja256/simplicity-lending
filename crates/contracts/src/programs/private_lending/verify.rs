//! Verifying a private offer in its creation transaction: the checks of
//! [`private_lending_core`], which run in the browser too, and the address checks, which need the
//! contract.

use private_lending_core::{
    CreationError, LendingKey, OpenedOffer, open_creation_as_borrower, open_creation_as_lender,
};
use simplex::{provider::SimplicityNetwork, simplicityhl::elements::Transaction};

use crate::programs::{
    private_lending::{PrivateLendingOffer, PrivateLendingParameters},
    program::SimplexProgram,
    script_auth::ScriptAuth,
};

/// The output of a creation transaction that locks the lender NFT to the offer.
const LENDER_NFT_OUTPUT_INDEX: usize = 1;
/// The output of a creation transaction that holds the pending offer.
const OFFER_OUTPUT_INDEX: usize = 3;

/// Why a creation transaction does not carry an offer to act on.
#[derive(thiserror::Error, Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    /// The offer is not found, does not open with this key, or fails a check of
    /// [`private_lending_core`]: its terms, the lender NFT's issuance or the NFT outputs.
    #[error(transparent)]
    Creation(#[from] CreationError),
    /// The offer output is not at the pending offer address that the terms and the pinned outputs
    /// give: its program would enforce other terms than those the lender sees.
    #[error("The offer is not at the address of its terms")]
    AddressMismatch,
    /// Output 1 does not lock the lender NFT to the offer: the acceptance, which must spend the
    /// lender NFT with the offer, could never happen.
    #[error("The lender NFT is not locked to the offer")]
    LenderNftNotLocked,
}

/// Finds, opens and verifies the offer that `creation_tx` creates, with the lender's key: what a
/// lender runs before accepting an offer. Returns the opened offer and its parameters.
///
/// [`open_creation_as_lender`] checks the borrower's signature, the pinned collateral, the terms,
/// the lender NFT's unique issuance at input 1 and the NFT outputs. This adds that:
/// - output 3 is at the pending offer address that the parameters, rebuilt with
///   [`PrivateLendingParameters::from_terms`] from the opened terms and pinned outputs, give:
///   otherwise the borrower pinned other outputs, such as a smaller repayment, than the terms show;
/// - output 1 locks the lender NFT to that offer (`script_auth` of its script hash), which the
///   acceptance unlocks.
///
/// # Errors
/// Returns [`VerifyError::Creation`], [`VerifyError::AddressMismatch`] or
/// [`VerifyError::LenderNftNotLocked`], in this order, for the first check that fails.
pub fn verify_offer_as_lender(
    lender: &LendingKey,
    creation_tx: &Transaction,
    network: SimplicityNetwork,
) -> Result<(OpenedOffer, PrivateLendingParameters), VerifyError> {
    let opened =
        open_creation_as_lender(lender, creation_tx, PrivateLendingOffer::get_program_id())?;

    verify_addresses(opened, creation_tx, network)
}

/// [`verify_offer_as_lender`] with the borrower's key, through [`open_creation_as_borrower`]:
/// the borrower recovers its offers from the chain with it.
///
/// The borrower also runs it on its finished creation transaction before broadcasting it (part
/// C's front end must too): an offer that does not verify would never be accepted, and the
/// borrower could not rebuild it from the chain to cancel it, which strands the collateral.
///
/// # Errors
/// As [`verify_offer_as_lender`].
pub fn verify_offer_as_borrower(
    borrower: &LendingKey,
    creation_tx: &Transaction,
    network: SimplicityNetwork,
) -> Result<(OpenedOffer, PrivateLendingParameters), VerifyError> {
    let opened =
        open_creation_as_borrower(borrower, creation_tx, PrivateLendingOffer::get_program_id())?;

    verify_addresses(opened, creation_tx, network)
}

/// The address checks of an offer that the core opened and checked from `creation_tx`.
fn verify_addresses(
    opened: OpenedOffer,
    creation_tx: &Transaction,
    network: SimplicityNetwork,
) -> Result<(OpenedOffer, PrivateLendingParameters), VerifyError> {
    let parameters =
        PrivateLendingParameters::from_terms(&opened.signed_terms.terms, opened.pinned, network);
    let offer = PrivateLendingOffer::new_pending(parameters);

    let script_at = |index: usize| {
        creation_tx
            .output
            .get(index)
            .map(|output| &output.script_pubkey)
    };

    if script_at(OFFER_OUTPUT_INDEX) != Some(&offer.get_script_pubkey()) {
        return Err(VerifyError::AddressMismatch);
    }
    let lender_nft_lock = ScriptAuth::from_simplex_program(&offer).get_script_pubkey();
    if script_at(LENDER_NFT_OUTPUT_INDEX) != Some(&lender_nft_lock) {
        return Err(VerifyError::LenderNftNotLocked);
    }

    Ok((opened, parameters))
}
