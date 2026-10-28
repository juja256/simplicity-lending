use private_lending_core::{NewOffer, OfferSecrets, lift_lending_key};
use simplex::{
    program::Program,
    provider::SimplicityNetwork,
    simplicityhl::elements::{AssetId, LockTime, OutPoint, Script, Sequence, bitcoin::PublicKey},
    transaction::{
        PartialInput, PartialOutput, RequiredSignature, UTXO, partial_input::IssuanceInput,
    },
};

use crate::{
    artifacts::private_lending::PrivateLendingProgram,
    programs::{
        private_lending::{PrivateLendingParameters, PrivateLendingWitnessBranch},
        program::SimplexProgram,
        script_auth::{ScriptAuth, ScriptAuthWitnessParams},
    },
    utils::{confidential::ConfidentialTransaction, get_random_seed},
};

/// Adds the issuance inputs of an offer's creation transaction: `borrower_coin` (input 0, the
/// offer's first input) issues the borrower NFT and `lender_coin` (input 1) the lender NFT, one
/// unit each and no reissuance token. Returns the asset ids of the borrower NFT and of the lender
/// NFT.
///
/// The issuance entropy is fresh randomness on every call, and it must be: the offer's secrets
/// derive from the borrower, the first input and the NFT ids, so a second creation transaction
/// from the same coins with the same NFT ids would leak the collateral amount, the difference of
/// the amounts or the XOR of the lenders' keys. A retry rebroadcasts the byte-identical
/// transaction; a new build calls this again and builds a new
/// [`NewOffer`](private_lending_core::NewOffer). The asset ids travel in the offer's terms and
/// outputs 0 and 1, so the borrower recovers them from the chain.
///
/// # Panics
/// Panics if the transaction already has inputs.
pub fn add_nft_issuances(
    ctx: &mut ConfidentialTransaction,
    borrower_coin: UTXO,
    lender_coin: UTXO,
) -> (AssetId, AssetId) {
    assert!(
        ctx.n_inputs() == 0,
        "The NFT issuances must be the first inputs"
    );

    let mut issue_nft = |coin| {
        ctx.add_issuance_input(
            PartialInput::new(coin),
            IssuanceInput::new_issuance(1, 0, get_random_seed()),
            RequiredSignature::NativeEcdsa,
        )
        .asset_id
    };

    (issue_nft(borrower_coin), issue_nft(lender_coin))
}

/// A private lending offer. Its storage holds the status (slot 0) and the outstanding debt as the
/// hash of its commitment (slot 1). Without partial repayment, the debt is the pinned repayment
/// from creation until the full repayment.
pub struct PrivateLendingOffer {
    program: PrivateLendingProgram,
    parameters: PrivateLendingParameters,
    is_active: bool,
}

impl PrivateLendingOffer {
    pub fn new_pending(parameters: PrivateLendingParameters) -> Self {
        Self::new_with_storage(
            parameters,
            false,
            parameters.pinned.repayment.commitment_hash(),
        )
    }

    pub fn new_active(parameters: PrivateLendingParameters) -> Self {
        Self::new_with_storage(
            parameters,
            true,
            parameters.pinned.repayment.commitment_hash(),
        )
    }

    /// The offer whose storage holds `is_active` and `debt_slot`. The program only accepts
    /// `debt_slot` equal to the repayment's commitment hash, as in [`Self::new_pending`] and
    /// [`Self::new_active`].
    pub fn new_with_storage(
        parameters: PrivateLendingParameters,
        is_active: bool,
        debt_slot: [u8; 32],
    ) -> Self {
        let mut program =
            PrivateLendingProgram::new(parameters.build_arguments()).with_storage_capacity(2);

        #[allow(unused_must_use)]
        program.set_storage_at(0, Self::get_is_active_slot_value(is_active));
        #[allow(unused_must_use)]
        program.set_storage_at(1, debt_slot);

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
            self.parameters.pinned.active_collateral
        } else {
            self.parameters.pinned.pending_collateral
        }
    }

    /// Adds the outputs of the offer's creation transaction: the borrower NFT to
    /// `borrower_nft_receiver` (output 0), the lender NFT locked to this offer (output 1), the
    /// marker (output 2) and the pending collateral (output 3). The collateral is blinded to the
    /// lending key of `new_offer.lender`, with the ephemeral public key of `new_offer` as its
    /// nonce and the signed terms in its range proof, so the lender and the borrower can open it
    /// from the chain.
    ///
    /// The inputs come first from [`add_nft_issuances`]; the collateral, the change and the fee
    /// follow. Before broadcasting the finished transaction, the borrower checks it with
    /// [`verify_offer_as_borrower`](crate::programs::private_lending::verify_offer_as_borrower):
    /// an offer that does not verify would never be accepted, and the borrower could not rebuild
    /// it from the chain to cancel it.
    ///
    /// # Panics
    /// Panics if the offer is active, the transaction already has outputs, its input 0 is not
    /// `new_offer.first_input`, this offer's parameters are not
    /// [`PrivateLendingParameters::from_terms`] of `new_offer`'s terms and pinned outputs, or
    /// `new_offer`'s secrets are not those of its lender.
    pub fn attach_creation(
        &self,
        ctx: &mut ConfidentialTransaction,
        new_offer: &NewOffer,
        borrower_nft_receiver: Script,
    ) {
        assert!(!self.is_active, "Only a pending offer can be created");
        assert!(
            ctx.n_outputs() == 0,
            "The creation outputs must be the first outputs"
        );
        // the offer's secrets and signature depend on input 0
        let first_input = ctx.inputs().first().map(|input| {
            OutPoint::new(
                input.partial_input.witness_txid,
                input.partial_input.witness_output_index,
            )
        });
        assert!(
            first_input == Some(new_offer.first_input),
            "Input 0 is not the new offer's first input"
        );
        // with other parameters the offer would not be at the address of its terms: the lender
        // would refuse it and the borrower could not recover it
        let expected = PrivateLendingParameters::from_terms(
            &new_offer.signed_terms.terms,
            new_offer.pinned,
            self.parameters.network,
        );
        assert!(
            self.parameters == expected,
            "The offer's parameters are not those of the new offer's terms"
        );
        // with other secrets nobody could rewind the collateral
        assert!(
            OfferSecrets::for_borrower(&new_offer.ephemeral_sk, &new_offer.lender)
                == new_offer.secrets,
            "The new offer's secrets are not those of its lender"
        );

        ctx.add_output(PartialOutput::new(
            borrower_nft_receiver,
            1,
            self.parameters.borrower_nft_asset_id,
        ));

        ScriptAuth::from_simplex_program(self).attach_creation(
            ctx,
            self.parameters.lender_nft_asset_id,
            1,
        );

        ctx.add_output(PartialOutput::new_metadata(&new_offer.marker.encode()));

        ctx.add_pinned_output_with(
            self.get_script_pubkey(),
            self.parameters.pinned.pending_collateral,
            PublicKey::new(lift_lending_key(&new_offer.lender)),
            new_offer.ephemeral_sk,
            new_offer.signed_terms.encode(),
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

        ctx.add_pinned_output(
            self.get_script_pubkey(),
            self.parameters.pinned.active_collateral,
            borrower_blinding_key,
        );

        ctx.add_pinned_output(
            self.parameters
                .get_principal_output_asset_auth()
                .get_script_pubkey(),
            self.parameters.pinned.principal,
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
    /// the pinned repayment (output 1). The caller adds the principal to repay and takes the
    /// collateral.
    ///
    /// # Panics
    /// Panics if the offer is pending or the transaction already has inputs or outputs.
    pub fn attach_full_repayment(
        &self,
        ctx: &mut ConfidentialTransaction,
        borrower_nft_utxo: UTXO,
        active_offer_utxo: UTXO,
        lender_blinding_key: PublicKey,
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
            self.parameters.pinned.repayment,
            lender_blinding_key,
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

        let locktime = LockTime::from_height(self.parameters.loan_expiration_time).unwrap();

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
