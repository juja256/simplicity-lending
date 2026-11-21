use private_lending_core::{
    BlinderTree, CARRY_SUPPLY, DebtOpening, LendingKey, MAX_STEPS, NewOffer, OfferSecrets,
    ReleaseSecrets, ReleaseStatement, SignedMessage, asset_point, carry_remainder, check_bounds,
    collateral_at, debt_after, debt_hash, find_collateral, lift_lending_key, prove, release_j,
    value_point, verify,
};
use simplex::{
    program::Program,
    provider::SimplicityNetwork,
    simplicityhl::elements::{
        AssetId, LockTime, OutPoint, Script, Sequence,
        bitcoin::PublicKey,
        confidential,
        secp256k1_zkp::{self, SECP256K1, SecretKey},
    },
    transaction::{
        PartialInput, PartialOutput, RequiredSignature, UTXO, partial_input::IssuanceInput,
    },
};

use crate::{
    artifacts::private_lending::PrivateLendingProgram,
    programs::{
        asset_auth::AssetAuthWitnessParams,
        private_lending::{PrivateLendingParameters, PrivateLendingWitnessBranch},
        program::SimplexProgram,
        script_auth::{ScriptAuth, ScriptAuthWitnessParams},
    },
    utils::{
        confidential::{ConfidentialTransaction, PinnedOutput, PinnedOutputExt},
        get_random_seed,
    },
};

/// The input of a creation transaction that issues the carry token, after the two NFT issuances.
const CARRY_ISSUANCE_INPUT_INDEX: usize = 2;
/// The borrower NFT's input and output in the borrower's flows, where the carries' `asset_auth`
/// finds it: the installment passes it on, the full repayment burns it.
const BORROWER_NFT_INDEX: u32 = 0;
/// The borrower NFT's input and its burn's output in the cancellation.
const CANCELLATION_BORROWER_NFT_INDEXES: (u32, u32) = (2, 1);

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

/// What an installment needs beyond the transaction's first inputs and outputs: the borrower's
/// keys, which prove the release; the debt's opening; the coins that pay the installment and the
/// carries it spends; and where the released collateral goes.
pub struct InstallmentRelease<'a> {
    /// The borrower's lending key. The release proof's nonces derive from it, and the carries are
    /// blinded to it.
    pub borrower: &'a LendingKey,
    /// The offer's secrets, from which the successor's committed blinders and their Merkle path
    /// derive.
    pub secrets: &'a OfferSecrets,
    /// The opening of the loan's debt.
    pub debt: DebtOpening,
    /// The principal coins that pay the installment: inputs 2 on. Input 2, the first of them, is
    /// the first wallet input from which the installment's ephemeral key derives.
    pub principal_coins: Vec<UTXO>,
    /// The carries, opened: the last installment's outputs 3 and 4, or at the first installment
    /// the creation's carry supply. They follow the principal coins.
    pub carries: Vec<UTXO>,
    /// The borrower's output of the released collateral, and its blinding key.
    pub release_receiver: Script,
    pub release_blinding_key: PublicKey,
}

/// What an installment leaves: the successor loan and the openings of its new outputs.
pub struct InstallmentOutputs {
    /// The loan after the installment.
    pub successor: PrivateLendingOffer,
    /// Output 1, the successor's collateral.
    pub collateral: PinnedOutput,
    /// Outputs 3 and 4, the carries `W1` and `W2`, of `e + 1` and `R − e` units.
    pub carries: [PinnedOutput; 2],
    /// The collateral released, at output 5 when it is not 0.
    pub release: u64,
}

/// A private lending offer. Its storage holds the status (slot 0) and the debt (slot 1), the hash
/// `h(A, D)` of the repayment's asset commitment `A` and of the debt `D`, a value commitment under
/// `A`. The debt is the pinned repayment until the first installment, and every installment
/// replaces it with the debt it leaves.
///
/// The collateral a loan holds is not part of the offer: it is the pinned active collateral at
/// acceptance, and after the `k`-th installment
/// [`PrivateLendingParameters::loan_collateral`] of `c_k = ceil(d_k·C/R)`, which the borrower
/// computes from its debt and the lender finds by a search ([`Self::attach_liquidation`]).
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
    /// `h(A, debt)`.
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

    /// How many installments the loan has had: its step.
    pub fn get_installments(&self) -> u32 {
        self.installments
    }

    /// Adds the inputs and outputs of the offer's creation transaction that follow the NFT
    /// issuances of [`add_nft_issuances`]:
    /// - input 2, `carry_coin`, issues the loan's carry token: [`CARRY_SUPPLY`] units, no
    ///   reissuance token, fresh entropy;
    /// - output 0 is the borrower NFT to `borrower_nft_receiver`, output 1 the lender NFT locked
    ///   to this offer, output 2 the marker and output 3 the pending collateral;
    /// - output 4 is the carry supply, explicit, locked like the principal by `asset_auth` of the
    ///   borrower NFT without burn. The amount is the same for every loan, so it reveals nothing.
    ///
    /// The collateral is blinded to the lending key of `new_offer.lender`, with the ephemeral
    /// public key of `new_offer` as its nonce and the signed terms in its range proof, so the
    /// lender and the borrower can open it from the chain. Returns the carry token's asset id.
    ///
    /// The collateral, the change and the fee follow. Before broadcasting the finished
    /// transaction, the borrower checks it with
    /// [`verify_offer_as_borrower`](crate::programs::private_lending::verify_offer_as_borrower):
    /// an offer that does not verify would never be accepted, and the borrower could not rebuild
    /// it from the chain to cancel it.
    ///
    /// # Panics
    /// Panics if the offer is active, the transaction has other inputs than the two NFT issuances
    /// or any output, its input 0 is not `new_offer.first_input`, this offer's parameters are not
    /// [`PrivateLendingParameters::from_terms`] of `new_offer`'s terms and pinned outputs,
    /// `new_offer`'s secrets are not those of its lender, or the collateral or the repayment is
    /// outside the bounds of [`check_bounds`], which the lender refuses.
    pub fn attach_creation(
        &self,
        ctx: &mut ConfidentialTransaction,
        new_offer: &NewOffer,
        borrower_nft_receiver: Script,
        carry_coin: UTXO,
    ) -> AssetId {
        assert!(!self.is_active, "Only a pending offer can be created");
        assert!(
            ctx.n_inputs() == CARRY_ISSUANCE_INPUT_INDEX && ctx.n_outputs() == 0,
            "The creation must follow the two NFT issuances, before any output"
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
        let pinned = self.parameters.pinned;
        if let Err(error) = check_bounds(pinned.active_collateral.amount, pinned.repayment.amount) {
            panic!("The lender refuses this offer: {error}");
        }

        let carry_asset_id = ctx
            .add_issuance_input(
                PartialInput::new(carry_coin),
                IssuanceInput::new_issuance(CARRY_SUPPLY, 0, get_random_seed()),
                RequiredSignature::NativeEcdsa,
            )
            .asset_id;

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
            pinned.pending_collateral,
            PublicKey::new(lift_lending_key(&new_offer.lender)),
            new_offer.ephemeral_sk,
            new_offer.signed_terms.encode(),
        );

        ctx.add_output(PartialOutput::new(
            self.parameters
                .get_principal_output_asset_auth()
                .get_script_pubkey(),
            CARRY_SUPPLY,
            carry_asset_id,
        ));

        carry_asset_id
    }

    /// Spends the pending offer and the locked lender NFT (inputs 0 and 1) into the active offer
    /// (output 0) and the pinned principal (output 1), whose range proof carries the lender's
    /// `message` to the borrower, if any: signed by the lender's lending key for
    /// [`MessagePhase::Acceptance`](private_lending_core::MessagePhase::Acceptance) of this offer.
    /// The borrower reads it and checks the signature against the lender's key in the terms. The
    /// caller adds the lender NFT output (output 2).
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

    /// Spends the pending offer and the locked lender NFT (inputs 0 and 1), the borrower NFT
    /// (input 2) and the carry supply (input 3, the creation's output 4, unlocked by the borrower
    /// NFT), and burns the lender NFT (output 0), the borrower NFT (output 1) and the carry supply
    /// (output 2, an explicit `OP_RETURN`: the supply is the same for every loan). The caller takes
    /// the collateral.
    ///
    /// # Panics
    /// Panics if the transaction already has inputs or outputs.
    pub fn attach_cancellation(
        &self,
        ctx: &mut ConfidentialTransaction,
        pending_offer_utxo: UTXO,
        lender_nft_utxo: UTXO,
        borrower_nft_utxo: UTXO,
        carry_supply_utxo: UTXO,
    ) {
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "Cancellation must be the first attachment"
        );
        let (carry_asset, carry_amount) = (carry_supply_utxo.asset(), carry_supply_utxo.amount());

        self.add_program_input(
            ctx,
            pending_offer_utxo,
            PrivateLendingWitnessBranch::OfferCancellation.build_witness(),
        );

        self.attach_lender_nft_unlocking(ctx, lender_nft_utxo, 0);

        ctx.add_input(
            PartialInput::new(borrower_nft_utxo),
            RequiredSignature::NativeEcdsa,
        );
        let (nft_input, nft_output) = CANCELLATION_BORROWER_NFT_INDEXES;
        self.parameters
            .get_principal_output_asset_auth()
            .attach_unlocking(
                ctx,
                carry_supply_utxo,
                AssetAuthWitnessParams::new(nft_input, nft_output),
            );

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
        ctx.add_output(PartialOutput::new(
            Script::new_op_return(b"burn"),
            carry_amount,
            carry_asset,
        ));
    }

    /// Pays the installment `payment`, an output under the repayment's asset commitment `A`, and
    /// releases the collateral it pays for. The layout:
    /// - input 0 and output 0: the borrower NFT, from `borrower_nft_utxo` to
    ///   `borrower_nft_receiver`, explicit;
    /// - input 1: the loan, with the installment's witness and the release proof;
    /// - inputs 2 on: the principal coins of `release`, then its carries, each unlocked by the
    ///   borrower NFT. A carry is never input 2, the first wallet input from which the
    ///   installment's ephemeral key derives: every build at one step spends the same carries.
    /// - output 1: the successor loan, at the storage of the debt the installment leaves, holding
    ///   `c' = ceil(d'·C/R)` with the asset blinder `a_c + k + 1` and the value blinder
    ///   `x_(k+1) − c'·(k+1)`, where `k` is [`Self::get_installments`];
    /// - output 2: the installment, to the lender NFT's lock without burn;
    /// - outputs 3 and 4: the carries `W1` and `W2`, of `e + 1` and `R − e` units of the carry
    ///   token, with `e = c'·R − d'·C`, to the principal's lock, with random blinders and a random
    ///   nonce, blinded to the borrower's lending key;
    /// - output 5, when it is not 0, the release `c_k − c'` to the release receiver;
    /// - then, when the carries spent hold more than `R + 1` units (the creation's supply, at the
    ///   first installment), a confidential `OP_RETURN` that burns the rest, with the range proof
    ///   of every other confidential output, so that it does not reveal `R`.
    ///
    /// The caller adds the principal's change after them, and the fee follows. Returns the
    /// successor and the openings of its outputs.
    ///
    /// The installment's range proof is blinded to `lender_blinding_key` with the nonce
    /// `ephemeral_sk·G`, which the borrower derives with
    /// [`installment_ephemeral_key`](private_lending_core::installment_ephemeral_key) from input 2,
    /// so that both parties can rewind it and rebuild the debt from the chain. The successor's
    /// range proof is blinded to `lender_blinding_key` too. The installment's range proof carries
    /// the borrower's `message`, if any, signed by the borrower's lending key for
    /// [`MessagePhase::Installment`](private_lending_core::MessagePhase::Installment) of this
    /// installment, one more than [`Self::get_installments`].
    ///
    /// The release proof is verified before it is attached.
    ///
    /// # Panics
    /// Panics if the offer is pending, the transaction already has inputs or outputs, the loan has
    /// had 1024 installments, `payment` is not under the repayment's asset id and asset blinder,
    /// `release.debt` is not the debt's opening, `payment` is not below the debt's amount (the
    /// full repayment pays the rest), there is no principal coin or a principal coin is not of the
    /// repayment asset, the carries are missing, hold several assets or fewer than `R + 1` units,
    /// the loan's input is not opened as the collateral it holds, or `release.secrets` are not the
    /// offer's.
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
        release: InstallmentRelease<'_>,
    ) -> InstallmentOutputs {
        assert!(self.is_active, "Only an active offer takes installments");
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "The installment must be the first attachment"
        );
        assert!(
            self.installments < MAX_STEPS,
            "The loan has had {MAX_STEPS} installments: only the full repayment is left"
        );
        let parameters = self.parameters;
        let (repayment, active) = (
            parameters.pinned.repayment,
            parameters.pinned.active_collateral,
        );
        assert!(
            payment.asset_id == repayment.asset_id
                && payment.asset_blinding_factor == repayment.asset_blinding_factor,
            "The installment is not under the repayment's asset commitment"
        );
        assert!(
            release.debt.commitment(&repayment) == self.debt,
            "The opening is not the debt's"
        );
        assert!(
            payment.amount < release.debt.amount,
            "The installment pays the whole debt or more: the full repayment pays it"
        );
        assert!(
            !release.principal_coins.is_empty()
                && release
                    .principal_coins
                    .iter()
                    .all(|coin| coin.asset() == repayment.asset_id),
            "The principal coins pay the installment, from input 2"
        );
        let carry_asset = release
            .carries
            .first()
            .expect("An installment spends the loan's carries")
            .asset();
        assert!(
            release
                .carries
                .iter()
                .all(|carry| carry.asset() == carry_asset),
            "The carries hold several assets"
        );

        let step = self.installments;
        let (collateral, full) = (active.amount, repayment.amount);
        let held = collateral_at(release.debt.amount, collateral, full);
        assert!(
            loan_utxo
                .secrets
                .is_some_and(|secrets| secrets.asset == active.asset_id && secrets.value == held),
            "The loan's input is not opened as the collateral it holds"
        );
        let debt_left = release
            .debt
            .after(DebtOpening::of(&payment))
            .expect("an installment below the debt leaves part of it");
        let held_next = collateral_at(debt_left.amount, collateral, full);
        let remainder = carry_remainder(debt_left.amount, collateral, full);

        let tree = BlinderTree::new(release.secrets);
        assert!(
            tree.root() == parameters.blinder_root,
            "The secrets are not the offer's"
        );
        let (x, y) = release.secrets.release_blinders(step + 1);
        let successor_collateral = parameters.loan_collateral(release.secrets, step + 1, held_next);
        let carries = [remainder + 1, full - remainder]
            .map(|amount| PinnedOutput::new_random(carry_asset, amount));
        let carried: u64 = release.carries.iter().map(UTXO::amount).sum();
        let leftover = carried
            .checked_sub(full + 1)
            .expect("The carries hold fewer than R + 1 units");

        let blinder_commitment = blinder_commitment(&x, &y);
        let statement = release_statement(
            &parameters,
            &debt_left.commitment(&repayment),
            &successor_collateral,
            &carries,
            blinder_commitment,
        );
        let secrets = ReleaseSecrets::new(
            &active,
            &repayment,
            debt_left,
            (x, y),
            (
                carries[0].value_blinding_factor,
                carries[1].value_blinding_factor,
            ),
        );
        let proof = prove(&statement, &secrets, release.borrower);
        assert!(
            verify(&statement, &proof, &parameters.fs_iv()),
            "The release proof does not verify"
        );

        let successor = Self::new_active_at(
            parameters,
            debt_after(&self.debt, &payment.value_commitment())
                .expect("an installment below the debt leaves a debt"),
            step + 1,
        );

        ctx.add_input(
            PartialInput::new(borrower_nft_utxo),
            RequiredSignature::NativeEcdsa,
        );
        ctx.add_output(PartialOutput::new(
            borrower_nft_receiver,
            1,
            parameters.borrower_nft_asset_id,
        ));

        self.add_program_input(
            ctx,
            loan_utxo,
            PrivateLendingWitnessBranch::Installment {
                debt: self.debt,
                step,
                blinder_commitment,
                path: tree.path(step),
                proof,
            }
            .build_witness(),
        );

        ctx.add_pinned_output(
            successor.get_script_pubkey(),
            successor_collateral,
            lender_blinding_key,
        );
        ctx.add_pinned_output_with(
            parameters
                .get_installment_output_asset_auth()
                .get_script_pubkey(),
            payment,
            lender_blinding_key,
            ephemeral_sk,
            message.map(SignedMessage::encode).unwrap_or_default(),
        );

        let carry_lock = parameters.get_principal_output_asset_auth();
        let borrower_key = PublicKey::new(lift_lending_key(&release.borrower.x_only_public_key()));
        for carry in carries {
            ctx.add_pinned_output(carry_lock.get_script_pubkey(), carry, borrower_key);
        }

        for coin in release.principal_coins {
            ctx.add_input(PartialInput::new(coin), RequiredSignature::NativeEcdsa);
        }
        self.add_carry_inputs(ctx, release.carries);

        let released = held - held_next;
        if released > 0 {
            ctx.add_output(
                PartialOutput::new(release.release_receiver, released, active.asset_id)
                    .with_blinding_key(release.release_blinding_key),
            );
        }
        if leftover > 0 {
            add_confidential_burn(ctx, carry_asset, leftover, borrower_key);
        }

        InstallmentOutputs {
            successor,
            collateral: successor_collateral,
            carries,
            release: released,
        }
    }

    /// Burns the borrower NFT (input 0, output 0), spends the loan (input 1) and pays the debt
    /// (output 1): the repayment's asset commitment with `opening`'s amount and value blinder,
    /// whose value commitment is the debt itself. The caller adds the principal to repay, then
    /// sweeps the carries with [`Self::attach_carry_sweep`], and takes the collateral, which the
    /// loan holds at its step: [`PrivateLendingParameters::loan_collateral`].
    ///
    /// # Panics
    /// Panics if the offer is pending, the transaction already has inputs or outputs, or
    /// `opening` is not the debt's opening.
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

    /// Spends the loan's `carries`, opened, each unlocked by the borrower NFT at input 0 and
    /// output 0, and burns all they hold in one confidential `OP_RETURN` blinded to
    /// `burn_blinding_key`, with random blinders and the range proof of every other confidential
    /// output, so that it does not reveal the amount (`R + 1` after an installment). The full
    /// repayment burns the borrower NFT, so it sweeps the carries after its principal coins:
    /// otherwise they stay locked for ever.
    ///
    /// # Panics
    /// Panics if there is no carry or the carries hold several assets.
    pub fn attach_carry_sweep(
        &self,
        ctx: &mut ConfidentialTransaction,
        carries: Vec<UTXO>,
        burn_blinding_key: PublicKey,
    ) {
        let carry_asset = carries.first().expect("There is no carry to sweep").asset();
        assert!(
            carries.iter().all(|carry| carry.asset() == carry_asset),
            "The carries hold several assets"
        );
        let total = carries.iter().map(UTXO::amount).sum();

        self.add_carry_inputs(ctx, carries);
        add_confidential_burn(ctx, carry_asset, total, burn_blinding_key);
    }

    /// Spends the loan after its expiration (input 0) and burns the lender NFT (output 0). The
    /// loan input's witness carries the debt hash of the loan's storage and reveals the expiry
    /// salt and the expiration, and the transaction is locked to the expiration. The caller adds
    /// the lender NFT input (input 1) and takes the collateral, whose opening this returns.
    ///
    /// The lender opens the collateral from `secrets` and the chain alone, without reading any
    /// installment. At step 0 it is the active collateral. At step `k ≥ 1` its value commitment
    /// is `c_k·A_c + x_k·G`: [`find_collateral`] finds `c_k` in `[1, C]` from `loan_utxo`'s value
    /// commitment, and the opening is [`PrivateLendingParameters::loan_collateral`] of it.
    ///
    /// # Panics
    /// Panics if the offer is pending, the transaction already has inputs or outputs, or
    /// `loan_utxo` is not the collateral of this offer at its step: the search finds no amount,
    /// or the opening does not match it.
    pub fn attach_liquidation(
        &self,
        ctx: &mut ConfidentialTransaction,
        loan_utxo: UTXO,
        secrets: &OfferSecrets,
    ) -> PinnedOutput {
        assert!(self.is_active, "Only an active offer can be liquidated");
        assert!(
            ctx.n_inputs() == 0 && ctx.n_outputs() == 0,
            "Liquidation must be the first attachment"
        );

        let collateral = self.find_collateral(&loan_utxo, secrets);
        assert!(
            collateral.matches(&loan_utxo.txout),
            "The opening found is not the loan's"
        );

        let expiry = self.parameters.loan_expiration_time;
        let locktime = LockTime::from_height(expiry).unwrap();

        let loan_input = PartialInput::new(UTXO {
            secrets: Some(collateral.secrets()),
            ..loan_utxo
        })
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

        collateral
    }

    /// The collateral `loan_utxo` holds at this offer's step, found by the search from its value
    /// commitment.
    fn find_collateral(&self, loan_utxo: &UTXO, secrets: &OfferSecrets) -> PinnedOutput {
        let step = self.installments;
        let active = self.parameters.pinned.active_collateral;
        if step == 0 {
            return active;
        }

        let value = value_point(&loan_utxo.txout.value).expect("The loan's value is a commitment");
        let collateral_asset =
            asset_point(&active.asset_commitment()).expect("a pinned output is confidential");
        let (x, _) = secrets.release_blinders(step);
        let amount = find_collateral(&value, &collateral_asset, &x, active.amount)
            .expect("The loan holds no collateral of this offer at its step");

        self.parameters.loan_collateral(secrets, step, amount)
    }

    /// Adds `carries` as inputs, each unlocked by the borrower NFT at input 0 and output 0.
    fn add_carry_inputs(&self, ctx: &mut ConfidentialTransaction, carries: Vec<UTXO>) {
        let carry_lock = self.parameters.get_principal_output_asset_auth();

        for carry in carries {
            carry_lock.attach_unlocking(
                ctx,
                carry,
                AssetAuthWitnessParams::new(BORROWER_NFT_INDEX, BORROWER_NFT_INDEX),
            );
        }
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

/// `Y = x·G + y·J`, the blinder commitment of a step whose blinders are `x` and `y`.
pub(crate) fn blinder_commitment(x: &SecretKey, y: &SecretKey) -> secp256k1_zkp::PublicKey {
    let y_j = release_j()
        .mul_tweak(SECP256K1, &secp256k1_zkp::Scalar::from(*y))
        .expect("a nonzero multiple of a curve point is a curve point");

    secp256k1_zkp::PublicKey::from_secret_key(SECP256K1, x)
        .combine(&y_j)
        .expect("x·G + y·J is the point at infinity with negligible probability")
}

/// The release proof's statement for an installment of the loan of `parameters` that leaves the
/// debt `debt_left`, with the successor's collateral `successor`, the carries `carries` and the
/// blinder commitment `y`: every point as the program reads it from the commitments.
pub(crate) fn release_statement(
    parameters: &PrivateLendingParameters,
    debt_left: &confidential::Value,
    successor: &PinnedOutput,
    carries: &[PinnedOutput; 2],
    y: secp256k1_zkp::PublicKey,
) -> ReleaseStatement {
    let points = parameters.statement_points();
    let value = |value: confidential::Value| value_point(&value).expect("a commitment");
    let asset = |asset: confidential::Asset| asset_point(&asset).expect("a commitment");

    ReleaseStatement {
        a: points.repayment_asset,
        a_c: points.collateral_asset,
        v_c0: points.collateral_value,
        d0: points.starting_debt,
        d_next: value(*debt_left),
        v_s: value(successor.value_commitment()),
        w1: value(carries[0].value_commitment()),
        a_w1: asset(carries[0].asset_commitment()),
        w2: value(carries[1].value_commitment()),
        a_w2: asset(carries[1].asset_commitment()),
        y,
    }
}

/// Burns `amount` of `asset` in a confidential `OP_RETURN` blinded to `blinding_key`. Elements'
/// own blinding refuses an `OP_RETURN`, so the burn is pinned with random blinders: it gets the
/// range proof of every other confidential output, whose header does not depend on the amount.
fn add_confidential_burn(
    ctx: &mut ConfidentialTransaction,
    asset: AssetId,
    amount: u64,
    blinding_key: PublicKey,
) {
    ctx.add_pinned_output(
        Script::new_op_return(b"burn"),
        PinnedOutput::new_random(asset, amount),
        blinding_key,
    );
}

#[cfg(test)]
mod tests {
    use private_lending_core::{LEAF_IV, NODE_IV, release_j};
    use simplex::simplicityhl::elements::hex::ToHex;

    use super::PrivateLendingProgram;

    /// The program's constants are the core's: `J` and the tree's two chaining values.
    #[test]
    fn program_constants_are_the_cores() {
        let j = release_j().serialize_uncompressed();

        for constant in [
            format!(
                "fn get_release_j() -> Ge {{\n    (\n        0x{},\n        0x{}\n    )\n}}",
                j[1..33].to_hex(),
                j[33..].to_hex()
            ),
            format!(
                "fn get_leaf_iv() -> u256 {{\n    0x{}\n}}",
                LEAF_IV.to_hex()
            ),
            format!(
                "fn get_node_iv() -> u256 {{\n    0x{}\n}}",
                NODE_IV.to_hex()
            ),
        ] {
            assert!(
                PrivateLendingProgram::SOURCE.contains(&constant),
                "the program does not hold {constant}"
            );
        }
    }

    /// The program checks every point of the witness on the curve before it uses it (proofs, O2):
    /// `Y` first in equation M, and `T1 … T7` before the challenge. No transaction isolates these
    /// checks, since changing a point's bytes also changes the challenge or the leaf, so the
    /// source is checked.
    #[test]
    fn program_checks_the_witness_points_on_the_curve() {
        let source = PrivateLendingProgram::SOURCE;
        let check_m = source
            .find("fn check_blinder_commitment(")
            .expect("the program checks equation M");
        let leaf = source[check_m..]
            .find("let leaf: u256")
            .expect("equation M hashes the leaf");

        assert!(source[check_m..check_m + leaf].contains("check_on_curve(blinder_commitment);"));
        let challenge = source
            .find("    // 11. The challenge and V1 … V7")
            .expect("the installment checks the proof");
        for t in 1..=7 {
            let check = format!("    check_on_curve(t{t});\n");
            let at = source.find(&check).expect("each commitment is checked");
            assert!(at < challenge, "T{t} is checked after the challenge");
        }
    }
}
