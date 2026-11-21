use private_lending_core::{
    BlinderTree, OfferPinned, OfferSecrets, OfferTerms, PinnedOutput, asset_point,
    collateral_opening, expiry_hash, fs_iv, value_point,
};
use simplex::{
    provider::SimplicityNetwork,
    simplicityhl::elements::{AssetId, secp256k1_zkp::PublicKey},
};

use crate::{
    artifacts::private_lending::derived_private_lending::PrivateLendingArguments,
    programs::{
        asset_auth::{AssetAuth, AssetAuthParameters},
        private_lending::witness::{commitment_witness, point_witness},
        program::SimplexProgram,
    },
};

/// The parameters of a private offer: its NFTs, its expiration, the pinned outputs that carry its
/// terms and the root of its blinder commitments. The program sees only the commitments of the
/// pinned outputs, the repayment's asset commitment `A`, under which every installment pays, the
/// points of the release proof's statement that are fixed for the loan, and the expiration only as
/// its salted hash.
///
/// Build them with [`PrivateLendingParameters::from_terms`], so the NFTs and the expiration are
/// those of the signed terms and the salt is the offer's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrivateLendingParameters {
    pub borrower_nft_asset_id: AssetId,
    pub lender_nft_asset_id: AssetId,
    pub pinned: OfferPinned,
    /// The block height at which the loan expires; the lender can liquidate after it.
    pub loan_expiration_time: u32,
    /// The salt of the expiry hash, [`OfferSecrets::expiry_salt`]: the liquidation's witness
    /// carries it with the expiration.
    pub expiry_salt: [u8; 32],
    /// `BLINDER_ROOT`, the root of the offer's [`BlinderTree`] of the blinder commitments
    /// `Y_1 … Y_1024`, from which the lender opens the collateral at liquidation.
    pub blinder_root: [u8; 32],
    pub network: SimplicityNetwork,
}

impl PrivateLendingParameters {
    /// The parameters of the offer of `terms` whose outputs `pinned` pins: the NFTs and the
    /// expiration come from the terms, and the expiry salt and the blinder root from `secrets`.
    /// The borrower creates the offer with them and the lender verifies it with them, so both reach
    /// the same address.
    pub fn from_terms(
        terms: &OfferTerms,
        pinned: OfferPinned,
        secrets: &OfferSecrets,
        network: SimplicityNetwork,
    ) -> PrivateLendingParameters {
        PrivateLendingParameters {
            borrower_nft_asset_id: terms.borrower_nft,
            lender_nft_asset_id: terms.lender_nft,
            pinned,
            loan_expiration_time: terms.loan_expiration_time,
            expiry_salt: secrets.expiry_salt(),
            blinder_root: BlinderTree::new(secrets).root(),
            network,
        }
    }

    /// The principal, unlocked by the borrower NFT (kept). The carries, the creation's carry supply
    /// and each installment's outputs 3 and 4, are locked by it too.
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

    /// An installment, unlocked by the lender NFT (kept), so that the lender can claim each
    /// installment and keep the NFT for the next.
    pub fn get_installment_output_asset_auth(&self) -> AssetAuth {
        AssetAuth::new(AssetAuthParameters {
            asset_id: self.lender_nft_asset_id,
            asset_amount: 1,
            with_asset_burn: false,
            network: self.network,
        })
    }

    /// The collateral of the loan at `step` holding `amount`, whose blinders derive from
    /// `secrets`: the active collateral at step 0, and after the `k`-th installment the asset
    /// blinder `a_c + k` and the value blinder `x_k − amount·k`
    /// ([`collateral_opening`]), so that its value commitment is `amount·A_c + x_k·G`.
    ///
    /// # Panics
    /// If `step` is 0 and `amount` is not the active collateral's, or `step` is above 1024.
    pub fn loan_collateral(&self, secrets: &OfferSecrets, step: u32, amount: u64) -> PinnedOutput {
        let active = self.pinned.active_collateral;
        if step == 0 {
            assert!(
                amount == active.amount,
                "The loan holds all its collateral until its first installment"
            );
            return active;
        }

        let (x, _) = secrets.release_blinders(step);
        let (asset_blinding_factor, value_blinding_factor) =
            collateral_opening(step, amount, &active.asset_blinding_factor, &x);

        PinnedOutput {
            amount,
            asset_blinding_factor,
            value_blinding_factor,
            ..active
        }
    }

    /// The release proof's points that are fixed for the loan, read from the pinned outputs'
    /// commitments as the program reads them: `A` of the repayment's asset commitment, `A_c` and
    /// `V_c0` of the active collateral's commitments, and `D₀` of the repayment's value
    /// commitment.
    pub fn statement_points(&self) -> StatementPoints {
        let (repayment, active) = (self.pinned.repayment, self.pinned.active_collateral);
        let point = |point: Result<PublicKey, _>| point.expect("a pinned output is confidential");

        StatementPoints {
            repayment_asset: point(asset_point(&repayment.asset_commitment())),
            collateral_asset: point(asset_point(&active.asset_commitment())),
            collateral_value: point(value_point(&active.value_commitment())),
            starting_debt: point(value_point(&repayment.value_commitment())),
        }
    }

    /// `FS_IV`, the chaining value of the release proof's challenge, over the
    /// [`Self::statement_points`] and `J`.
    pub fn fs_iv(&self) -> [u8; 32] {
        let points = self.statement_points();

        fs_iv(
            &points.repayment_asset,
            &points.collateral_asset,
            &points.collateral_value,
            &points.starting_debt,
        )
    }

    pub fn build_arguments(&self) -> PrivateLendingArguments {
        let points = self.statement_points();

        PrivateLendingArguments {
            borrower_nft_asset_id: self.borrower_nft_asset_id.into_inner().0,
            lender_nft_asset_id: self.lender_nft_asset_id.into_inner().0,
            pending_collateral_commitment: self.pinned.pending_collateral.commitment_hash(),
            active_collateral_commitment: self.pinned.active_collateral.commitment_hash(),
            principal_commitment: self.pinned.principal.commitment_hash(),
            repayment_commitment: self.pinned.repayment.commitment_hash(),
            expiry_hash: expiry_hash(&self.expiry_salt, self.loan_expiration_time),
            repayment_asset: commitment_witness(&self.pinned.repayment.asset_commitment()),
            principal_output_script_hash: self.get_principal_output_asset_auth().get_script_hash(),
            repayment_output_script_hash: self.get_repayment_output_asset_auth().get_script_hash(),
            installment_output_script_hash: self
                .get_installment_output_asset_auth()
                .get_script_hash(),
            repayment_asset_point: point_witness(&points.repayment_asset),
            collateral_asset_point: point_witness(&points.collateral_asset),
            collateral_value_point: point_witness(&points.collateral_value),
            starting_debt_point: point_witness(&points.starting_debt),
            fs_iv: self.fs_iv(),
            blinder_root: self.blinder_root,
        }
    }
}

/// The points of the release proof's statement that are fixed for a loan, which the program takes
/// as parameters ([`PrivateLendingParameters::statement_points`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatementPoints {
    /// `A`, `REPAYMENT_ASSET_POINT`.
    pub repayment_asset: PublicKey,
    /// `A_c`, `COLLATERAL_ASSET_POINT`.
    pub collateral_asset: PublicKey,
    /// `V_c0 = C·A_c + ρ·G`, `COLLATERAL_VALUE_POINT`.
    pub collateral_value: PublicKey,
    /// `D₀ = R·A + r₀·G`, `STARTING_DEBT_POINT`.
    pub starting_debt: PublicKey,
}
