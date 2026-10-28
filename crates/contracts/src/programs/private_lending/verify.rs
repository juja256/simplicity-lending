//! Finding a private offer on chain, and the lender's check of an opened offer before accepting
//! it.

use private_lending_core::{Marker, OpenedOffer};
use simplex::{
    provider::SimplicityNetwork,
    simplicityhl::elements::{OutPoint, Transaction, TxOut},
};

use crate::{
    programs::{
        private_lending::{PrivateLendingOffer, PrivateLendingParameters},
        program::SimplexProgram,
    },
    utils::op_return_payload,
};

/// The output of a creation transaction that carries the marker.
const MARKER_OUTPUT_INDEX: usize = 2;
/// The output of a creation transaction that holds the pending offer.
const OFFER_OUTPUT_INDEX: usize = 3;

/// Why a lender must not accept an opened offer.
#[derive(thiserror::Error, Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    /// The terms lend nothing or ask back less than they lend.
    #[error("The principal is zero or the repayment is below the principal")]
    InvalidTerms,
    /// The offer output is not at the pending offer address that the terms and the pinned outputs
    /// give: its program would enforce other terms than those the lender sees.
    #[error("The offer is not at the address of its terms")]
    AddressMismatch,
}

/// The private offer that `tx` creates: its marker (output 2), the outpoint and the output of the
/// pending offer (output 3), and the first input of `tx`, which the offer's secrets and signature
/// depend on.
///
/// Returns `None` if output 2 does not carry a marker of this program or `tx` has no output 3.
/// The offer is not opened, let alone verified.
pub fn find_private_offer(tx: &Transaction) -> Option<(Marker, OutPoint, TxOut, OutPoint)> {
    let marker_output = tx.output.get(MARKER_OUTPUT_INDEX)?;
    let marker = Marker::decode(op_return_payload(&marker_output.script_pubkey)?)?;
    if marker.program_id != PrivateLendingOffer::get_program_id() {
        return None;
    }

    let offer = tx.output.get(OFFER_OUTPUT_INDEX)?.clone();
    let offer_outpoint = OutPoint::new(tx.txid(), OFFER_OUTPUT_INDEX as u32);
    let first_input = tx.input.first()?.previous_output;

    Some((marker, offer_outpoint, offer, first_input))
}

/// The lender's check of `opened`, the offer it opened from `offer`, its pending offer output,
/// before accepting it. Returns the offer's parameters.
///
/// Opening already checked the borrower's signature and that the collateral is the pinned one.
/// This rebuilds the parameters from the opened terms (NFTs, expiration) and pinned outputs and
/// checks that the pending offer address they give is `offer`'s script pubkey: otherwise the
/// borrower pinned other outputs, such as a smaller repayment, than the terms show.
///
/// # Errors
/// Returns [`VerifyError::InvalidTerms`] if the principal is zero or the repayment is below it,
/// and [`VerifyError::AddressMismatch`] if `offer` is not at the address the terms give.
pub fn verify_pending_offer(
    opened: &OpenedOffer,
    offer: &TxOut,
    network: SimplicityNetwork,
) -> Result<PrivateLendingParameters, VerifyError> {
    let terms = &opened.signed_terms.terms;
    if terms.principal_amount == 0 || terms.repayment_amount < terms.principal_amount {
        return Err(VerifyError::InvalidTerms);
    }

    let parameters = PrivateLendingParameters {
        borrower_nft_asset_id: terms.borrower_nft,
        lender_nft_asset_id: terms.lender_nft,
        pinned: opened.pinned,
        loan_expiration_time: terms.loan_expiration_time,
        network,
    };

    if PrivateLendingOffer::new_pending(parameters).get_script_pubkey() != offer.script_pubkey {
        return Err(VerifyError::AddressMismatch);
    }

    Ok(parameters)
}
