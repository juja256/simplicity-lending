use simplex::{
    program::Program,
    provider::SimplicityNetwork,
    simplicityhl::elements::{LockTime, Script, Sequence, bitcoin::PublicKey},
    transaction::{PartialInput, PartialOutput, RequiredSignature, UTXO},
};

use crate::{
    artifacts::private_lending::PrivateLendingProgram,
    programs::{
        private_lending::{PrivateLendingParameters, PrivateLendingWitnessBranch},
        program::SimplexProgram,
        script_auth::{ScriptAuth, ScriptAuthWitnessParams},
    },
    utils::confidential::ConfidentialTransaction,
};

/// A private lending offer. Its storage holds the status only: the debt is either whole (active)
/// or repaid at once.
pub struct PrivateLendingOffer {
    program: PrivateLendingProgram,
    parameters: PrivateLendingParameters,
    is_active: bool,
}

impl PrivateLendingOffer {
    pub fn new_pending(parameters: PrivateLendingParameters) -> Self {
        Self::new(parameters, false)
    }

    pub fn new_active(parameters: PrivateLendingParameters) -> Self {
        Self::new(parameters, true)
    }

    fn new(parameters: PrivateLendingParameters, is_active: bool) -> Self {
        let mut program =
            PrivateLendingProgram::new(parameters.build_arguments()).with_storage_capacity(1);

        #[allow(unused_must_use)]
        program.set_storage_at(0, Self::get_is_active_slot_value(is_active));

        Self {
            program,
            parameters,
            is_active,
        }
    }

    fn get_is_active_slot_value(is_active: bool) -> [u8; 32] {
        let mut slot = [0u8; 32];
        slot[31] = u8::from(is_active);

        slot
    }

    pub fn get_parameters(&self) -> &PrivateLendingParameters {
        &self.parameters
    }

    pub fn is_active_offer(&self) -> bool {
        self.is_active
    }

    /// The collateral this offer holds in its current state.
    pub fn get_collateral(&self) -> crate::utils::confidential::PinnedOutput {
        if self.is_active {
            self.parameters.terms.active_collateral
        } else {
            self.parameters.terms.pending_collateral
        }
    }

    /// Locks the lender NFT to this offer (pending offers) and adds the pinned collateral,
    /// rewindable with `collateral_blinding_key`. No creation metadata: the terms reach the
    /// lender off chain.
    pub fn attach_creation(
        &self,
        ctx: &mut ConfidentialTransaction,
        collateral_blinding_key: PublicKey,
    ) {
        if !self.is_active {
            let lender_nft_script_auth = ScriptAuth::from_simplex_program(self);

            lender_nft_script_auth.attach_creation(ctx, self.parameters.lender_nft_asset_id, 1);
        }

        ctx.add_pinned_output(
            self.get_script_pubkey(),
            self.get_collateral(),
            collateral_blinding_key,
        );
    }

    /// Spends the pending offer and the locked lender NFT (inputs 0 and 1) into the active offer
    /// (output 0) and the pinned principal (output 1). The caller adds the lender NFT output
    /// (output 2).
    ///
    /// # Panics
    /// Panics if the transaction already has inputs or outputs.
    pub fn attach_acceptance(
        &mut self,
        ctx: &mut ConfidentialTransaction,
        pending_offer_utxo: UTXO,
        lender_nft_utxo: UTXO,
        borrower_blinding_key: PublicKey,
    ) {
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "Acceptance must be the first attachment"
        );

        self.add_program_input(
            ctx,
            pending_offer_utxo,
            PrivateLendingWitnessBranch::OfferAcceptance.build_witness(),
        );

        self.attach_lender_nft_unlocking(ctx, lender_nft_utxo, 0);

        *self = Self::new_active(self.parameters);

        self.attach_creation(ctx, borrower_blinding_key);

        ctx.add_pinned_output(
            self.parameters
                .get_principal_output_asset_auth()
                .get_script_pubkey(),
            self.parameters.terms.principal,
            borrower_blinding_key,
        );
    }

    /// Spends the pending offer and the locked lender NFT (inputs 0 and 1) and burns the lender
    /// NFT (output 0) and the borrower NFT (output 1). The caller adds the borrower NFT input
    /// (input 2) and takes the collateral.
    ///
    /// # Panics
    /// Panics if the transaction already has inputs or outputs.
    pub fn attach_cancellation(
        &self,
        ctx: &mut ConfidentialTransaction,
        pending_offer_utxo: UTXO,
        lender_nft_utxo: UTXO,
    ) {
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "Cancellation must be the first attachment"
        );

        self.add_program_input(
            ctx,
            pending_offer_utxo,
            PrivateLendingWitnessBranch::OfferCancellation.build_witness(),
        );

        self.attach_lender_nft_unlocking(ctx, lender_nft_utxo, 0);

        ctx.add_output(PartialOutput::new(
            Script::new_op_return(b"burn"),
            1,
            self.parameters.lender_nft_asset_id,
        ));
        ctx.add_output(PartialOutput::new(
            Script::new_op_return(b"burn"),
            1,
            self.parameters.borrower_nft_asset_id,
        ));
    }

    /// Burns the borrower NFT (input 0, output 0), spends the active offer (input 1) and pays
    /// the pinned repayment (output 1) and protocol fee (output 2). The caller adds the
    /// principal to repay and takes the collateral.
    ///
    /// # Panics
    /// Panics if the offer is pending or the transaction already has inputs or outputs.
    pub fn attach_full_repayment(
        &self,
        ctx: &mut ConfidentialTransaction,
        borrower_nft_utxo: UTXO,
        active_offer_utxo: UTXO,
        lender_blinding_key: PublicKey,
        protocol_fee_blinding_key: PublicKey,
    ) {
        assert!(self.is_active, "Only an active offer can be repaid");
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "Repayment must be the first attachment"
        );

        ctx.add_input(
            PartialInput::new(borrower_nft_utxo),
            RequiredSignature::NativeEcdsa,
        );
        ctx.add_output(PartialOutput::new(
            Script::new_op_return(b"burn"),
            1,
            self.parameters.borrower_nft_asset_id,
        ));

        self.add_program_input(
            ctx,
            active_offer_utxo,
            PrivateLendingWitnessBranch::FullRepayment.build_witness(),
        );

        ctx.add_pinned_output(
            self.parameters
                .get_repayment_output_asset_auth()
                .get_script_pubkey(),
            self.parameters.terms.repayment,
            lender_blinding_key,
        );
        ctx.add_pinned_output(
            self.parameters
                .get_protocol_fee_output_asset_auth()
                .get_script_pubkey(),
            self.parameters.terms.protocol_fee,
            protocol_fee_blinding_key,
        );
    }

    /// Spends the active offer after its expiration (input 0) and burns the lender NFT
    /// (output 0). The caller adds the lender NFT input (input 1) and takes the collateral.
    ///
    /// # Panics
    /// Panics if the offer is pending or the transaction already has inputs or outputs.
    pub fn attach_liquidation(&self, ctx: &mut ConfidentialTransaction, active_offer_utxo: UTXO) {
        assert!(self.is_active, "Only an active offer can be liquidated");
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "Liquidation must be the first attachment"
        );

        let locktime =
            LockTime::from_height(self.parameters.terms.offer_parameters.loan_expiration_time)
                .unwrap();

        let active_offer_input = PartialInput::new(active_offer_utxo)
            .with_sequence(Sequence::ENABLE_LOCKTIME_NO_RBF)
            .with_locktime(locktime);

        self.add_program_input_from_partial_input(
            ctx,
            active_offer_input,
            PrivateLendingWitnessBranch::Liquidation.build_witness(),
        );

        ctx.add_output(PartialOutput::new(
            Script::new_op_return(b"burn"),
            1,
            self.parameters.lender_nft_asset_id,
        ));
    }

    fn attach_lender_nft_unlocking(
        &self,
        ctx: &mut ConfidentialTransaction,
        lender_nft_utxo: UTXO,
        offer_input_index: u32,
    ) {
        let lender_nft_script_auth = ScriptAuth::from_simplex_program(self);

        lender_nft_script_auth.attach_unlocking(
            ctx,
            lender_nft_utxo,
            ScriptAuthWitnessParams::new(offer_input_index),
        );
    }
}

impl SimplexProgram for PrivateLendingOffer {
    fn get_program_source_code() -> &'static str {
        PrivateLendingProgram::SOURCE
    }

    fn get_program(&self) -> &Program {
        self.program.as_ref()
    }

    fn get_network(&self) -> &SimplicityNetwork {
        &self.parameters.network
    }
}
