use private_lending_core::{
    DebtOpening, NewOffer, OfferSecrets, SignedMessage, debt_after, debt_hash, lift_lending_key,
    zero_debt_key,
};
use simplex::{
    program::Program,
    provider::SimplicityNetwork,
    simplicityhl::elements::{
        AssetId, LockTime, OutPoint, Script, Sequence, bitcoin::PublicKey, confidential,
        secp256k1_zkp::SecretKey,
    },
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
    utils::{
        confidential::{ConfidentialTransaction, PinnedOutput},
        get_random_seed,
    },
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

/// A private lending offer. Its storage holds the status (slot 0) and the debt (slot 1), the hash
/// `h(A, D)` of the repayment's asset commitment `A` and of the debt `D`, a value commitment under
/// `A`. The debt is the pinned repayment until the first installment, and every installment
/// replaces it with the debt it leaves.
pub struct PrivateLendingOffer {
    program: PrivateLendingProgram,
    parameters: PrivateLendingParameters,
    is_active: bool,
    debt: confidential::Value,
    installments: u32,
}

impl PrivateLendingOffer {
    pub fn new_pending(parameters: PrivateLendingParameters) -> Self {
        Self::new_with_storage(
            parameters,
            false,
            parameters.pinned.repayment.value_commitment(),
            0,
        )
    }

    /// The loan at acceptance, whose debt is the pinned repayment:
    /// [`Self::new_active_at`] of `D₀` after no installment.
    pub fn new_active(parameters: PrivateLendingParameters) -> Self {
        Self::new_active_at(
            parameters,
            parameters.pinned.repayment.value_commitment(),
            0,
        )
    }

    /// The loan after `installments` installments, which left the debt `debt`: its storage holds
    /// `h(A, debt)`, and its collateral is
    /// [`collateral_after`](private_lending_core::OfferPinned::collateral_after) of the
    /// installments.
    pub fn new_active_at(
        parameters: PrivateLendingParameters,
        debt: confidential::Value,
        installments: u32,
    ) -> Self {
        Self::new_with_storage(parameters, true, debt, installments)
    }

    fn new_with_storage(
        parameters: PrivateLendingParameters,
        is_active: bool,
        debt: confidential::Value,
        installments: u32,
    ) -> Self {
        let debt_slot = debt_hash(&parameters.pinned.repayment.asset_commitment(), &debt);

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
            debt,
            installments,
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

    /// The debt still owed, `D`, a value commitment under the repayment's asset commitment.
    pub fn get_debt(&self) -> confidential::Value {
        self.debt
    }

    /// `h(A, D)`, which the storage holds.
    pub fn get_debt_hash(&self) -> [u8; 32] {
        debt_hash(
            &self.parameters.pinned.repayment.asset_commitment(),
            &self.debt,
        )
    }

    /// How many installments the loan has had.
    pub fn get_installments(&self) -> u32 {
        self.installments
    }

    /// The collateral this offer holds in its current state: once active, each installment moves
    /// its asset commitment by `G`.
    pub fn get_collateral(&self) -> PinnedOutput {
        if self.is_active {
            self.parameters.pinned.collateral_after(self.installments)
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
            &new_offer.secrets,
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
    /// (output 0) and the pinned principal (output 1), whose range proof carries the lender's
    /// `message` to the borrower, if any: signed by the lender's lending key for
    /// [`MessagePhase::Acceptance`](private_lending_core::MessagePhase::Acceptance) of this offer,
    /// which only the lender's key can check. The caller adds the lender NFT output (output 2).
    ///
    /// # Panics
    /// Panics if the transaction already has inputs or outputs.
    pub fn attach_acceptance(
        &mut self,
        ctx: &mut ConfidentialTransaction,
        pending_offer_utxo: UTXO,
        lender_nft_utxo: UTXO,
        borrower_blinding_key: PublicKey,
        message: Option<&SignedMessage>,
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

        let principal_script = self
            .parameters
            .get_principal_output_asset_auth()
            .get_script_pubkey();
        let principal = self.parameters.pinned.principal;
        match message {
            None => ctx.add_pinned_output(principal_script, principal, borrower_blinding_key),
            // the acceptance's nonce is random, with a message as without
            Some(message) => ctx.add_pinned_output_with(
                principal_script,
                principal,
                borrower_blinding_key,
                SecretKey::new(&mut rand::thread_rng()),
                message.encode(),
            ),
        }
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

    /// Passes the borrower NFT from input 0 to `borrower_nft_receiver` (output 0), explicit, spends
    /// the loan (input 1) and pays `payment` (output 2), an installment under the repayment's asset
    /// commitment `A`, to the lender NFT's lock without burn. The successor loan (output 1)
    /// holds the debt the installment leaves and the collateral re-blinded by one step. Returns
    /// the successor. The caller adds the principal that pays the installment.
    ///
    /// The installment's range proof is blinded to `lender_blinding_key` with the nonce
    /// `ephemeral_sk·G`, which the borrower derives with
    /// [`installment_ephemeral_key`](private_lending_core::installment_ephemeral_key), so that
    /// both parties can rewind it and rebuild the debt from the chain. The successor's range proof
    /// is blinded to `lender_blinding_key` too: both parties derive its blinders anyway. The
    /// installment's range proof carries the borrower's `message`, if any, signed by the
    /// borrower's lending key for
    /// [`MessagePhase::Installment`](private_lending_core::MessagePhase::Installment) of this
    /// installment, one more than [`Self::get_installments`].
    ///
    /// # Panics
    /// Panics if the offer is pending, the transaction already has inputs or outputs,
    /// `payment` is not under the repayment's asset id and asset blinder, or it pays the whole
    /// debt, amount and blinder: the debt left would be the point at infinity, which the program
    /// refuses.
    #[allow(clippy::too_many_arguments)]
    pub fn attach_installment(
        &self,
        ctx: &mut ConfidentialTransaction,
        borrower_nft_utxo: UTXO,
        loan_utxo: UTXO,
        borrower_nft_receiver: Script,
        payment: PinnedOutput,
        lender_blinding_key: PublicKey,
        ephemeral_sk: SecretKey,
        message: Option<&SignedMessage>,
    ) -> PrivateLendingOffer {
        assert!(self.is_active, "Only an active offer takes installments");
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "The installment must be the first attachment"
        );
        let repayment = self.parameters.pinned.repayment;
        assert!(
            payment.asset_id == repayment.asset_id
                && payment.asset_blinding_factor == repayment.asset_blinding_factor,
            "The installment is not under the repayment's asset commitment"
        );
        let debt_left = debt_after(&self.debt, &payment.value_commitment())
            .expect("The installment leaves no debt: the full repayment pays it");
        let successor = Self::new_active_at(self.parameters, debt_left, self.installments + 1);

        ctx.add_input(
            PartialInput::new(borrower_nft_utxo),
            RequiredSignature::NativeEcdsa,
        );
        ctx.add_output(PartialOutput::new(
            borrower_nft_receiver,
            1,
            self.parameters.borrower_nft_asset_id,
        ));

        self.add_program_input(
            ctx,
            loan_utxo,
            PrivateLendingWitnessBranch::Installment { debt: self.debt }.build_witness(),
        );

        ctx.add_pinned_output(
            successor.get_script_pubkey(),
            successor.get_collateral(),
            lender_blinding_key,
        );
        ctx.add_pinned_output_with(
            self.parameters
                .get_installment_output_asset_auth()
                .get_script_pubkey(),
            payment,
            lender_blinding_key,
            ephemeral_sk,
            message.map(SignedMessage::encode).unwrap_or_default(),
        );

        successor
    }

    /// Burns the borrower NFT (input 0, output 0), spends the loan (input 1) and pays the debt
    /// (output 1): the repayment's asset commitment with `opening`'s amount and value blinder,
    /// whose value commitment is the debt itself. The caller adds the principal to repay and takes
    /// the collateral.
    ///
    /// # Panics
    /// Panics if the offer is pending, the transaction already has inputs or outputs, or
    /// `opening` is not the debt's opening or owes no amount, which the zero-debt close closes.
    pub fn attach_full_repayment(
        &self,
        ctx: &mut ConfidentialTransaction,
        borrower_nft_utxo: UTXO,
        loan_utxo: UTXO,
        opening: DebtOpening,
        lender_blinding_key: PublicKey,
    ) {
        assert!(self.is_active, "Only an active offer can be repaid");
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "Repayment must be the first attachment"
        );
        assert!(
            opening.amount > 0,
            "A debt of no amount closes with the zero-debt close"
        );
        let repayment = self.parameters.pinned.repayment;
        assert!(
            opening.commitment(&repayment) == self.debt,
            "The opening is not the debt's"
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
            loan_utxo,
            PrivateLendingWitnessBranch::FullRepayment {
                debt_hash: self.get_debt_hash(),
            }
            .build_witness(),
        );

        ctx.add_pinned_output(
            self.parameters
                .get_repayment_output_asset_auth()
                .get_script_pubkey(),
            PinnedOutput {
                amount: opening.amount,
                value_blinding_factor: opening.blinder,
                ..repayment
            },
            lender_blinding_key,
        );
    }

    /// Closes a loan that owes no amount: burns the borrower NFT (input 0, output 0), spends the
    /// loan (input 1) and reveals the debt's blinder `k` in an `OP_RETURN` (output 1), which lets
    /// the lender sweep the installments it has not claimed. The caller takes the collateral.
    ///
    /// # Panics
    /// Panics if the offer is pending, the transaction already has inputs or outputs, or
    /// `opening` is not the debt's opening or owes an amount.
    pub fn attach_zero_debt_close(
        &self,
        ctx: &mut ConfidentialTransaction,
        borrower_nft_utxo: UTXO,
        loan_utxo: UTXO,
        opening: DebtOpening,
    ) {
        assert!(self.is_active, "Only an active offer can be closed");
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "The close must be the first attachment"
        );
        let key = zero_debt_key(&opening).expect("The debt owes an amount");
        assert!(
            opening.commitment(&self.parameters.pinned.repayment) == self.debt,
            "The opening is not the debt's"
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
            loan_utxo,
            PrivateLendingWitnessBranch::ZeroDebtClose {
                debt: self.debt,
                key,
            }
            .build_witness(),
        );

        ctx.add_output(PartialOutput::new_metadata(&key));
    }

    /// Spends the loan after its expiration (input 0) and burns the lender NFT (output 0). The loan
    /// input's witness carries the debt hash of the loan's storage and reveals the expiry salt and
    /// the expiration, and the transaction is locked to the expiration. The caller adds the lender
    /// NFT input (input 1) and takes the collateral.
    ///
    /// # Panics
    /// Panics if the offer is pending or the transaction already has inputs or outputs.
    pub fn attach_liquidation(&self, ctx: &mut ConfidentialTransaction, loan_utxo: UTXO) {
        assert!(self.is_active, "Only an active offer can be liquidated");
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "Liquidation must be the first attachment"
        );

        let expiry = self.parameters.loan_expiration_time;
        let locktime = LockTime::from_height(expiry).unwrap();

        let loan_input = PartialInput::new(loan_utxo)
            .with_sequence(Sequence::ENABLE_LOCKTIME_NO_RBF)
            .with_locktime(locktime);

        self.add_program_input_from_partial_input(
            ctx,
            loan_input,
            PrivateLendingWitnessBranch::Liquidation {
                debt_hash: self.get_debt_hash(),
                salt: self.parameters.expiry_salt,
                expiry,
            }
            .build_witness(),
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
