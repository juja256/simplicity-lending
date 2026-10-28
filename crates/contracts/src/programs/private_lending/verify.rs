//! Finding a private offer on chain, and the lender's check of an opened offer before accepting
//! it.

use private_lending_core::{Marker, OpenedOffer};
use simplex::{
    provider::SimplicityNetwork,
    simplicityhl::elements::{
        AssetId, OutPoint, Transaction, TxIn, TxOut, confidential, locktime::LOCK_TIME_THRESHOLD,
        secp256k1_zkp::ZERO_TWEAK,
    },
};

use crate::{
    programs::{
        private_lending::{PrivateLendingOffer, PrivateLendingParameters},
        program::SimplexProgram,
    },
    utils::op_return_payload,
};

/// The input of a creation transaction that issues the lender NFT.
const LENDER_NFT_INPUT_INDEX: usize = 1;
/// The output of a creation transaction that carries the marker.
const MARKER_OUTPUT_INDEX: usize = 2;
/// The output of a creation transaction that holds the pending offer.
const OFFER_OUTPUT_INDEX: usize = 3;

/// Why a lender must not accept an opened offer.
#[derive(thiserror::Error, Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    /// The terms lend nothing, ask back less than they lend, or expire at a lock time from
    /// 500 000 000 on, a timestamp, which a block height never reaches: the lender could never
    /// liquidate.
    #[error(
        "The principal is zero, the repayment is below the principal or the expiration is not a \
         block height"
    )]
    InvalidTerms,
    /// Input 1 of the creation transaction does not newly issue exactly one unit of the lender
    /// NFT without a reissuance token. Another unit could claim the repayment or liquidate.
    #[error("The creation transaction does not issue the lender NFT as a single unit")]
    LenderNftNotUnique,
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

/// The lender's check of `opened`, the offer it opened from output 3 of `creation_tx`, before
/// accepting it. Returns the offer's parameters.
///
/// Opening already checked the borrower's signature and that the collateral is the pinned one.
/// This checks that:
/// - the terms lend something, ask back at least as much, and expire at a block height;
/// - input 1 of `creation_tx` newly issues exactly one unit of the terms' lender NFT and no
///   reissuance token, so the lender NFT that unlocks the repayment and the liquidation has no
///   other copy;
/// - the pending offer address that the parameters, rebuilt from the opened terms (NFTs,
///   expiration) and pinned outputs, give is output 3's script pubkey: otherwise the borrower
///   pinned other outputs, such as a smaller repayment, than the terms show.
///
/// # Errors
/// Returns [`VerifyError::InvalidTerms`], [`VerifyError::LenderNftNotUnique`] or
/// [`VerifyError::AddressMismatch`], in this order, for the first check that fails.
pub fn verify_pending_offer(
    opened: &OpenedOffer,
    creation_tx: &Transaction,
    network: SimplicityNetwork,
) -> Result<PrivateLendingParameters, VerifyError> {
    let terms = &opened.signed_terms.terms;
    if terms.principal_amount == 0
        || terms.repayment_amount < terms.principal_amount
        || terms.loan_expiration_time >= LOCK_TIME_THRESHOLD
    {
        return Err(VerifyError::InvalidTerms);
    }

    let lender_nft_input = creation_tx.input.get(LENDER_NFT_INPUT_INDEX);
    if !lender_nft_input.is_some_and(|input| issues_single_unit(input, terms.lender_nft)) {
        return Err(VerifyError::LenderNftNotUnique);
    }

    let parameters = PrivateLendingParameters {
        borrower_nft_asset_id: terms.borrower_nft,
        lender_nft_asset_id: terms.lender_nft,
        pinned: opened.pinned,
        loan_expiration_time: terms.loan_expiration_time,
        network,
    };

    let offer = creation_tx
        .output
        .get(OFFER_OUTPUT_INDEX)
        .ok_or(VerifyError::AddressMismatch)?;
    if PrivateLendingOffer::new_pending(parameters).get_script_pubkey() != offer.script_pubkey {
        return Err(VerifyError::AddressMismatch);
    }

    Ok(parameters)
}

/// Whether `input` issues `asset_id` for the first time (a new issuance, not a reissuance), one
/// explicit unit and no reissuance token: then that unit is the asset's whole supply.
fn issues_single_unit(input: &TxIn, asset_id: AssetId) -> bool {
    let issuance = &input.asset_issuance;

    issuance.asset_blinding_nonce == ZERO_TWEAK
        && issuance.amount == confidential::Value::Explicit(1)
        && matches!(
            issuance.inflation_keys,
            confidential::Value::Null | confidential::Value::Explicit(0)
        )
        && input.issuance_ids().0 == asset_id
}
