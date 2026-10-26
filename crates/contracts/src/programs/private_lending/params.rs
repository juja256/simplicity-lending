use simplex::{provider::SimplicityNetwork, simplicityhl::elements::AssetId};

use crate::{
    artifacts::private_lending::derived_private_lending::PrivateLendingArguments,
    programs::{
        asset_auth::{AssetAuth, AssetAuthParameters},
        lending::OfferParameters,
        program::SimplexProgram,
    },
    utils::confidential::PinnedOutput,
};

/// The terms of a private offer: the economic parameters and the pinned outputs that carry them.
/// The borrower chooses every blinding factor and sends the whole struct to the chosen lender off
/// chain; the program sees only the commitments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrivateLendingTerms {
    pub offer_parameters: OfferParameters,
    /// The collateral of the pending offer.
    pub pending_collateral: PinnedOutput,
    /// The same collateral once the offer is accepted, under other blinding factors.
    pub active_collateral: PinnedOutput,
    /// The principal paid to the borrower on acceptance.
    pub principal: PinnedOutput,
    /// Principal and interest minus the protocol fee, paid to the lender on full repayment.
    pub repayment: PinnedOutput,
    /// The protocol's share of the interest, paid on full repayment.
    pub protocol_fee: PinnedOutput,
}

impl PrivateLendingTerms {
    /// Terms with fresh random blinding factors.
    ///
    /// # Panics
    /// Panics if an amount (collateral, principal, repayment or protocol fee) is zero: confidential
    /// amounts must be positive.
    pub fn new(
        collateral_asset_id: AssetId,
        principal_asset_id: AssetId,
        offer_parameters: OfferParameters,
    ) -> Self {
        let total_amount_to_repay = offer_parameters.get_total_amount_to_repay();
        let protocol_fee = offer_parameters.get_total_protocol_fee();

        Self {
            offer_parameters,
            pending_collateral: PinnedOutput::new_random(
                collateral_asset_id,
                offer_parameters.collateral_amount,
            ),
            active_collateral: PinnedOutput::new_random(
                collateral_asset_id,
                offer_parameters.collateral_amount,
            ),
            principal: PinnedOutput::new_random(
                principal_asset_id,
                offer_parameters.principal_amount,
            ),
            repayment: PinnedOutput::new_random(
                principal_asset_id,
                total_amount_to_repay - protocol_fee,
            ),
            protocol_fee: PinnedOutput::new_random(principal_asset_id, protocol_fee),
        }
    }

    pub fn get_total_amount_to_repay(&self) -> u64 {
        self.offer_parameters.get_total_amount_to_repay()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PrivateLendingParameters {
    pub borrower_nft_asset_id: AssetId,
    pub lender_nft_asset_id: AssetId,
    pub protocol_fee_keeper_asset_id: AssetId,
    pub terms: PrivateLendingTerms,
    pub network: SimplicityNetwork,
}

impl PrivateLendingParameters {
    /// The principal, unlocked by the borrower NFT (kept).
    pub fn get_principal_output_asset_auth(&self) -> AssetAuth {
        AssetAuth::new(AssetAuthParameters {
            asset_id: self.borrower_nft_asset_id,
            asset_amount: 1,
            with_asset_burn: false,
            network: self.network,
        })
    }

    /// The repayment, unlocked by burning the lender NFT.
    pub fn get_repayment_output_asset_auth(&self) -> AssetAuth {
        AssetAuth::new(AssetAuthParameters {
            asset_id: self.lender_nft_asset_id,
            asset_amount: 1,
            with_asset_burn: true,
            network: self.network,
        })
    }

    /// The protocol fee, unlocked by the protocol fee keeper asset (kept).
    pub fn get_protocol_fee_output_asset_auth(&self) -> AssetAuth {
        AssetAuth::new(AssetAuthParameters {
            asset_id: self.protocol_fee_keeper_asset_id,
            asset_amount: 1,
            with_asset_burn: false,
            network: self.network,
        })
    }

    pub fn build_arguments(&self) -> PrivateLendingArguments {
        PrivateLendingArguments {
            borrower_nft_asset_id: self.borrower_nft_asset_id.into_inner().0,
            lender_nft_asset_id: self.lender_nft_asset_id.into_inner().0,
            pending_collateral_commitment: self.terms.pending_collateral.commitment_hash(),
            active_collateral_commitment: self.terms.active_collateral.commitment_hash(),
            principal_commitment: self.terms.principal.commitment_hash(),
            repayment_commitment: self.terms.repayment.commitment_hash(),
            protocol_fee_commitment: self.terms.protocol_fee.commitment_hash(),
            loan_expiration_time: self.terms.offer_parameters.loan_expiration_time,
            principal_output_script_hash: self.get_principal_output_asset_auth().get_script_hash(),
            repayment_output_script_hash: self.get_repayment_output_asset_auth().get_script_hash(),
            protocol_fee_output_script_hash: self
                .get_protocol_fee_output_asset_auth()
                .get_script_hash(),
        }
    }
}
