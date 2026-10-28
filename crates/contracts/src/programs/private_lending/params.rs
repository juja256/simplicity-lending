use private_lending_core::OfferPinned;
use simplex::{provider::SimplicityNetwork, simplicityhl::elements::AssetId};

use crate::{
    artifacts::private_lending::derived_private_lending::PrivateLendingArguments,
    programs::{
        asset_auth::{AssetAuth, AssetAuthParameters},
        program::SimplexProgram,
    },
};

/// The parameters of a private offer: its NFTs, its expiration and the pinned outputs that carry
/// its terms. The program sees only the commitments of the pinned outputs.
#[derive(Debug, Clone, Copy)]
pub struct PrivateLendingParameters {
    pub borrower_nft_asset_id: AssetId,
    pub lender_nft_asset_id: AssetId,
    pub pinned: OfferPinned,
    /// The block height at which the loan expires; the lender can liquidate after it.
    pub loan_expiration_time: u32,
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

    pub fn build_arguments(&self) -> PrivateLendingArguments {
        PrivateLendingArguments {
            borrower_nft_asset_id: self.borrower_nft_asset_id.into_inner().0,
            lender_nft_asset_id: self.lender_nft_asset_id.into_inner().0,
            pending_collateral_commitment: self.pinned.pending_collateral.commitment_hash(),
            active_collateral_commitment: self.pinned.active_collateral.commitment_hash(),
            principal_commitment: self.pinned.principal.commitment_hash(),
            repayment_commitment: self.pinned.repayment.commitment_hash(),
            loan_expiration_time: self.loan_expiration_time,
            principal_output_script_hash: self.get_principal_output_asset_auth().get_script_hash(),
            repayment_output_script_hash: self.get_repayment_output_asset_auth().get_script_hash(),
        }
    }
}
