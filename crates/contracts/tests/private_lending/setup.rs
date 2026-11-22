use simplex::program::ProgramError;
use simplex::signer::Signer;
use simplex::simplicityhl::elements::bitcoin::PublicKey;
use simplex::simplicityhl::elements::confidential;
use simplex::simplicityhl::elements::encode::serialize;
use simplex::simplicityhl::elements::secp256k1_zkp::{
    self, SECP256K1, Scalar, Secp256k1, SecretKey,
};
use simplex::simplicityhl::elements::{
    AssetId, OutPoint, Script, Transaction, TxOut, TxOutSecrets,
};
use simplex::simplicityhl::simplicity::jet::Elements;
use simplex::simplicityhl::simplicity::{BitIter, Cost, RedeemNode};
use simplex::transaction::{
    FinalTransaction, PartialInput, PartialOutput, RequiredSignature, UTXO,
};

use lending_contracts::programs::asset_auth::{
    AssetAuth, AssetAuthParameters, AssetAuthWitnessParams,
};
use lending_contracts::programs::private_lending::{
    InstallmentOutputs, InstallmentRelease, PrivateLendingOffer, PrivateLendingParameters,
    PrivateLendingWitnessBranch, add_nft_issuances, verify_offer_as_borrower,
    verify_offer_as_lender,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::{
    ConfidentialTransaction, ConfidentialTransactionError, PinnedOutput, PinnedOutputExt,
};
use private_lending_core::{
    BlinderTree, DebtOpening, LendingKey, Message, NewOffer, OfferSecrets, OfferTerms,
    ReleaseProof, ReleaseSecrets, ReleaseStatement, SignedMessage, asset_point, carry_remainder,
    collateral_at, debt_after, installment_ephemeral_key, lift_lending_key, prove, release_j,
    rewind, value_point,
};

use lending_contracts::utils::confidential::wait_for_confirmation;
use lending_contracts::utils::{apply_basis_points, get_random_seed};
use simplex::transaction::partial_input::IssuanceInput;

use super::common::wallet::get_split_utxo_ft;

pub(super) const COLLATERAL_AMOUNT: u64 = 3_000;
pub(super) const PRINCIPAL_AMOUNT: u64 = 10_000;
pub(super) const PRINCIPAL_INTEREST_RATE: u16 = 1_000; // 10%
pub(super) const TOTAL_PRINCIPAL_AMOUNT: u64 = 200_000;

/// The terms the tests create an offer with: the repayment amount is the principal plus its
/// interest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct OfferParameters {
    pub collateral_amount: u64,
    pub principal_amount: u64,
    pub loan_expiration_time: u32,
    pub principal_interest_rate: u16,
}

impl OfferParameters {
    pub(super) fn get_total_amount_to_repay(&self) -> u64 {
        let interest = apply_basis_points(self.principal_amount, self.principal_interest_rate)
            .expect("the interest fits in a u64");

        self.principal_amount + interest
    }
}

pub(super) struct PrivateOfferSetup {
    pub offer: PrivateLendingOffer,
    pub parameters: PrivateLendingParameters,
    pub creation_tx: Transaction,
    pub borrower_lending_key: LendingKey,
    pub lender_lending_key: LendingKey,
    /// The offer's secrets, as the borrower built them.
    pub secrets: OfferSecrets,
}

/// The output of a creation transaction that holds the carry supply.
pub(super) const CARRY_SUPPLY_OUTPUT: usize = 4;
/// The outputs of an installment that hold the successor loan, the installment and the carries.
pub(super) const SUCCESSOR_OUTPUT: usize = 1;
pub(super) const INSTALLMENT_OUTPUT: usize = 2;
pub(super) const CARRY_OUTPUTS: [usize; 2] = [3, 4];
/// The amount of the policy asset in the extra confidential output an installment that releases
/// nothing gives the borrower (proofs, R2).
const EXTRA_OUTPUT_AMOUNT: u64 = 1_000;

pub(super) fn default_offer_parameters(
    context: &simplex::TestContext,
) -> anyhow::Result<OfferParameters> {
    let current_height = context.get_default_provider().fetch_tip_height()?;

    Ok(OfferParameters {
        collateral_amount: COLLATERAL_AMOUNT,
        principal_amount: PRINCIPAL_AMOUNT,
        loan_expiration_time: current_height + 60,
        principal_interest_rate: PRINCIPAL_INTEREST_RATE,
    })
}

/// How many times [`mine_until`] polls the tip, every 100 ms, once the blocks are mined.
const TIP_POLLS: usize = 600;

/// Mines blocks until the tip is at `height`, and waits until esplora reports it. Simplex's
/// `mine_until_height` waits 5 s for esplora, which tens of parallel regtest nodes can outlast.
pub(super) fn mine_until(context: &simplex::TestContext, height: u32) -> anyhow::Result<()> {
    // its error is that wait running out: the blocks are mined, and the polls below wait longer
    let _ = context
        .get_network_utils()
        .mine_until_height(u64::from(height));

    for _ in 0..TIP_POLLS {
        if context.get_default_provider().fetch_tip_height()? >= height {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    anyhow::bail!("esplora does not report the tip at {height}")
}

/// Broadcasts `ctx` signed by `signer` and waits until `signer`'s wallet lists the
/// confidential change of the transaction, so that the next transaction can spend it (the
/// indexer may lag behind the confirmation).
pub(super) fn broadcast(
    ctx: &ConfidentialTransaction,
    signer: &Signer,
) -> anyhow::Result<Transaction> {
    let tx = ctx.finalize(signer)?;

    broadcast_finalized(&tx, signer)?;

    Ok(tx)
}

/// Broadcasts `tx`, finalized by `signer`, and waits as [`broadcast`] does.
fn broadcast_finalized(tx: &Transaction, signer: &Signer) -> anyhow::Result<()> {
    let provider = signer.get_provider();
    provider.broadcast_transaction(tx)?;
    wait_for_confirmation(provider, &tx.txid())?;

    // the finalizer's change precedes the fee, the last output
    let change_vout = (tx.output.len() - 2) as u32;

    for _ in 0..100 {
        let listed = signer.get_utxos_txid(tx.txid())?;
        if listed.iter().any(|utxo| utxo.outpoint.vout == change_vout) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    anyhow::bail!("the wallet does not list its change from {}", tx.txid())
}

/// The output of `tx` that carries `pinned`, as a spendable UTXO.
pub(super) fn find_pinned_utxo(tx: &Transaction, pinned: &PinnedOutput) -> UTXO {
    let (vout, txout) = tx
        .output
        .iter()
        .enumerate()
        .find(|(_, txout)| pinned.matches(txout))
        .expect("The transaction has no output with this pinned commitment");

    pinned.to_utxo(OutPoint::new(tx.txid(), vout as u32), txout.clone())
}

/// The explicit output of `tx` that carries `asset_id`.
pub(super) fn find_explicit_utxo(tx: &Transaction, asset_id: AssetId) -> UTXO {
    let (vout, txout) = tx
        .output
        .iter()
        .enumerate()
        .find(|(_, txout)| txout.asset.explicit() == Some(asset_id))
        .expect("The transaction has no explicit output of this asset");

    UTXO {
        outpoint: OutPoint::new(tx.txid(), vout as u32),
        txout: txout.clone(),
        secrets: None,
    }
}

/// What `signer` recovers by rewinding the range proof of `txout` with its blinding key.
pub(super) fn unblind_with(signer: &Signer, txout: &TxOut) -> anyhow::Result<TxOutSecrets> {
    let secp = Secp256k1::new();

    Ok(txout.unblind(&secp, signer.get_blinding_private_key().inner)?)
}

/// What the holder of `key` recovers by rewinding the range proof of `txout`, blinded to the key's
/// lifted public key: the carries and their burns are blinded to the borrower's lending key.
pub(super) fn open_with_lending_key(
    key: &LendingKey,
    txout: &TxOut,
) -> anyhow::Result<TxOutSecrets> {
    let nonce = txout
        .nonce
        .commitment()
        .ok_or_else(|| anyhow::anyhow!("the output has no nonce"))?;
    let shared_secret = OfferSecrets::for_lender(key, &nonce).shared_secret();

    Ok(rewind(txout, shared_secret)?.0)
}

pub(super) fn fund_lender(
    context: &simplex::TestContext,
    lender: &Signer,
    principal_asset_id: AssetId,
    principal_to_send: u64,
) -> anyhow::Result<()> {
    let signer = context.get_default_signer();

    let principal_utxo = signer.get_utxos_asset(principal_asset_id)?[0].clone();
    // the largest explicit coin: the lender pays the fees of several confidential transactions
    let policy_asset = context.get_network().policy_asset();
    let policy_utxo = signer
        .get_utxos_filter(&|utxo| utxo.explicit_asset() == policy_asset, &|_| false)?
        .into_iter()
        .max_by_key(UTXO::explicit_amount)
        .expect("the default signer has an explicit policy coin");

    let principal_utxo_amount = principal_utxo.explicit_amount();
    let policy_amount_to_send = policy_utxo.explicit_amount() / 2;

    let mut ft = FinalTransaction::new();

    ft.add_input(
        PartialInput::new(principal_utxo),
        RequiredSignature::NativeEcdsa,
    );
    ft.add_input(
        PartialInput::new(policy_utxo),
        RequiredSignature::NativeEcdsa,
    );

    ft.add_output(PartialOutput::new(
        lender.get_address().script_pubkey(),
        principal_to_send,
        principal_asset_id,
    ));
    ft.add_output(PartialOutput::new(
        lender.get_address().script_pubkey(),
        policy_amount_to_send,
        context.get_network().policy_asset(),
    ));

    if principal_utxo_amount > principal_to_send {
        ft.add_output(PartialOutput::new(
            signer.get_address().script_pubkey(),
            principal_utxo_amount - principal_to_send,
            principal_asset_id,
        ));
    }

    broadcast_explicit(context, &ft)?;

    Ok(())
}

/// Broadcasts `ft` from the default signer and waits for it to confirm. The common helpers wait
/// once, a short poll that eight parallel tests can outlast.
fn broadcast_explicit(context: &simplex::TestContext, ft: &FinalTransaction) -> anyhow::Result<()> {
    let txid = context.get_default_signer().broadcast(ft)?.txid();

    Ok(wait_for_confirmation(
        context.get_default_provider(),
        &txid,
    )?)
}

/// The largest explicit coin of the policy asset that `signer` holds. The explicit transactions of
/// the setup spend only explicit coins, and after a confidential transaction a wallet holds both.
fn largest_explicit_policy_coin(
    context: &simplex::TestContext,
    signer: &Signer,
) -> anyhow::Result<UTXO> {
    let policy_asset = context.get_network().policy_asset();

    signer
        .get_utxos_filter(&|utxo| utxo.explicit_asset() == policy_asset, &|_| false)?
        .into_iter()
        .max_by_key(UTXO::explicit_amount)
        .ok_or_else(|| anyhow::anyhow!("the signer has no explicit policy coin"))
}

/// Splits the default signer's largest explicit coin: the fresh wallet holds a single coin, and an
/// issuance spends one and pays its fee with another.
fn split_first_signer_utxo(
    context: &simplex::TestContext,
    amounts: Vec<u64>,
) -> anyhow::Result<()> {
    let signer = context.get_default_signer();
    let signer_utxo = largest_explicit_policy_coin(context, signer)?;

    let ft = get_split_utxo_ft(signer_utxo, amounts, signer, *context.get_network());

    broadcast_explicit(context, &ft)
}

/// Issues `asset_amount` of a new asset to the default signer.
fn issue_asset(context: &simplex::TestContext, asset_amount: u64) -> anyhow::Result<AssetId> {
    let signer = context.get_default_signer();
    let coin = largest_explicit_policy_coin(context, signer)?;

    let mut ft = FinalTransaction::new();

    let issuance_details = ft.add_issuance_input(
        PartialInput::new(coin),
        IssuanceInput::new_issuance(asset_amount, 0, get_random_seed()),
        RequiredSignature::NativeEcdsa,
    );

    ft.add_output(PartialOutput::new(
        signer.get_address().script_pubkey(),
        asset_amount,
        issuance_details.asset_id,
    ));

    // the coin's amount returns as the change, which pays the fee: the signer's fee coin could be
    // confidential, which an explicit transaction cannot balance
    broadcast_explicit(context, &ft)?;

    Ok(issuance_details.asset_id)
}

/// The borrower (the default signer) issues the principal asset, then creates the pending offer
/// for the test lender's lending key: the creation transaction issues both NFTs from two of the
/// borrower's coins, and the offer's blinding factors derive from the borrower and lender's
/// shared secret. The borrower verifies the finished creation transaction before broadcasting
/// it, as part C's front end must.
pub(super) fn setup_pending_private_offer(
    context: &simplex::TestContext,
    offer_parameters: OfferParameters,
) -> anyhow::Result<PrivateOfferSetup> {
    setup_pending_private_offer_with(context, offer_parameters, None)
}

/// [`setup_pending_private_offer`] with the borrower's `message` to the lender in the terms.
pub(super) fn setup_pending_private_offer_with(
    context: &simplex::TestContext,
    offer_parameters: OfferParameters,
    message: Option<Message>,
) -> anyhow::Result<PrivateOfferSetup> {
    let borrower = context.get_default_signer();
    let network = *context.get_network();
    let policy_asset = network.policy_asset();
    let borrower_lending_key = LendingKey::from_master_blinding_key(&[1; 32]);
    let lender_lending_key = LendingKey::from_master_blinding_key(&[2; 32]);
    let lender = lender_lending_key.x_only_public_key();

    // the third coin issues the carry token and funds the collateral, so that the creation leaves
    // the largest explicit coin to fund_lender
    split_first_signer_utxo(
        context,
        vec![5000, 10000, 15000 + offer_parameters.collateral_amount],
    )?;

    let principal_asset_id = issue_asset(context, TOTAL_PRINCIPAL_AMOUNT)?;

    // the three smallest explicit coins issue the NFTs and the carry token: fund_lender takes the
    // largest one
    let mut coins =
        borrower.get_utxos_filter(&|utxo| utxo.explicit_asset() == policy_asset, &|_| false)?;
    coins.sort_by_key(UTXO::explicit_amount);
    let [borrower_coin, lender_coin, carry_coin, ..] = coins.as_slice() else {
        anyhow::bail!("the borrower needs three explicit coins to issue the NFTs and the carries");
    };
    // input 0 of the creation transaction, the offer's first input
    let first_input = borrower_coin.outpoint;

    let mut ctx = ConfidentialTransaction::new();

    let (borrower_nft_asset_id, lender_nft_asset_id) =
        add_nft_issuances(&mut ctx, borrower_coin.clone(), lender_coin.clone());

    let terms = OfferTerms {
        principal_asset: principal_asset_id,
        principal_amount: offer_parameters.principal_amount,
        repayment_amount: offer_parameters.get_total_amount_to_repay(),
        interest_rate_bps: offer_parameters.principal_interest_rate,
        loan_expiration_time: offer_parameters.loan_expiration_time,
        borrower_nft: borrower_nft_asset_id,
        lender_nft: lender_nft_asset_id,
    };
    let new_offer = NewOffer::build(
        &borrower_lending_key,
        &lender,
        &first_input,
        PrivateLendingOffer::get_program_id(),
        policy_asset,
        offer_parameters.collateral_amount,
        terms,
        message,
    )?;

    let parameters =
        PrivateLendingParameters::from_terms(&terms, new_offer.pinned, &new_offer.secrets, network);

    let offer = PrivateLendingOffer::new_pending(parameters);

    // the collateral comes from the carry coin and the finalizer's coin selection
    offer.attach_creation(
        &mut ctx,
        &new_offer,
        borrower.get_address().script_pubkey(),
        carry_coin.clone(),
    );

    // an offer that does not verify would strand the collateral: check before broadcasting
    let creation_tx = ctx.finalize(borrower)?;
    let (_, verified) = verify_offer_as_borrower(&borrower_lending_key, &creation_tx, network)?;
    anyhow::ensure!(
        verified == parameters,
        "the creation transaction does not create the offer"
    );

    broadcast_finalized(&creation_tx, borrower)?;

    Ok(PrivateOfferSetup {
        offer,
        parameters,
        creation_tx,
        borrower_lending_key,
        lender_lending_key,
        secrets: new_offer.secrets,
    })
}

/// What the lender knows of the offer from the creation transaction and its lending key alone:
/// the parameters and the offer's secrets.
pub(super) fn lender_view(
    setup: &PrivateOfferSetup,
) -> anyhow::Result<(PrivateLendingParameters, OfferSecrets)> {
    let (opened, parameters) = verify_offer_as_lender(
        &setup.lender_lending_key,
        &setup.creation_tx,
        setup.parameters.network,
    )?;

    Ok((parameters, opened.secrets))
}

/// The acceptance transaction, before finalization (the lender's view of the terms), its
/// outputs blinded to `borrower_blinding_key` and its principal carrying the lender's `message`.
pub(super) fn build_acceptance(
    setup: &mut PrivateOfferSetup,
    lender: &Signer,
    borrower_blinding_key: PublicKey,
    message: Option<&SignedMessage>,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = setup.parameters;

    let pending_offer_utxo =
        find_pinned_utxo(&setup.creation_tx, &parameters.pinned.pending_collateral);
    let lender_nft_utxo = find_explicit_utxo(&setup.creation_tx, parameters.lender_nft_asset_id);

    let mut ctx = ConfidentialTransaction::new();

    setup.offer.attach_acceptance(
        &mut ctx,
        pending_offer_utxo,
        lender_nft_utxo,
        borrower_blinding_key,
        message,
    );

    ctx.add_output(PartialOutput::new(
        lender.get_address().script_pubkey(),
        1,
        parameters.lender_nft_asset_id,
    ));

    add_lender_principal(&mut ctx, lender, parameters)?;

    Ok(ctx)
}

pub(super) fn add_lender_principal(
    ctx: &mut ConfidentialTransaction,
    lender: &Signer,
    parameters: PrivateLendingParameters,
) -> anyhow::Result<()> {
    let principal_amount = parameters.pinned.principal.amount;
    let lender_principal_utxo = lender.get_utxos_filter(
        &|utxo| {
            utxo.explicit_asset() == parameters.pinned.principal.asset_id
                && utxo.explicit_amount() >= principal_amount
        },
        &|_| true,
    )?[0]
        .clone();
    let principal_utxo_amount = lender_principal_utxo.explicit_amount();

    ctx.add_input(
        PartialInput::new(lender_principal_utxo),
        RequiredSignature::NativeEcdsa,
    );

    if principal_utxo_amount > principal_amount {
        ctx.add_output(
            PartialOutput::new(
                lender.get_confidential_address().script_pubkey(),
                principal_utxo_amount - principal_amount,
                parameters.pinned.principal.asset_id,
            )
            .with_blinding_key(lender.get_blinding_public_key()),
        );
    }

    Ok(())
}

/// Funds a fresh lender and accepts the pending offer; returns the acceptance transaction.
pub(super) fn accept_private_offer(
    context: &simplex::TestContext,
    setup: &mut PrivateOfferSetup,
    lender: &Signer,
) -> anyhow::Result<Transaction> {
    let borrower_blinding_key = context.get_default_signer().get_blinding_public_key();

    accept_private_offer_with(context, setup, lender, borrower_blinding_key, None)
}

/// [`accept_private_offer`] with the outputs blinded to `borrower_blinding_key` and the
/// principal carrying the lender's `message`.
pub(super) fn accept_private_offer_with(
    context: &simplex::TestContext,
    setup: &mut PrivateOfferSetup,
    lender: &Signer,
    borrower_blinding_key: PublicKey,
    message: Option<&SignedMessage>,
) -> anyhow::Result<Transaction> {
    fund_lender(
        context,
        lender,
        setup.parameters.pinned.principal.asset_id,
        setup.parameters.pinned.principal.amount,
    )?;

    let ctx = build_acceptance(setup, lender, borrower_blinding_key, message)?;

    broadcast(&ctx, lender)
}

/// A loan between two of its transactions: the offer in its current state, the output that holds
/// it, opened as the collateral it holds, the opening of its debt, and its carries, which the
/// borrower tracks.
pub(super) struct Loan {
    pub offer: PrivateLendingOffer,
    pub utxo: UTXO,
    pub opening: DebtOpening,
    /// The carries, opened: the creation's carry supply until the first installment, then the
    /// last installment's outputs 3 and 4.
    pub carries: Vec<UTXO>,
}

impl Loan {
    /// The loan that `acceptance_tx` starts, whose debt is the pinned repayment and whose carry is
    /// the creation's supply.
    pub(super) fn accepted(setup: &PrivateOfferSetup, acceptance_tx: &Transaction) -> Loan {
        let parameters = setup.parameters;
        let offer = PrivateLendingOffer::new_active(parameters);
        let utxo = find_pinned_utxo(acceptance_tx, &parameters.pinned.active_collateral);

        Loan {
            offer,
            utxo,
            opening: DebtOpening::of(&parameters.pinned.repayment),
            carries: vec![carry_supply(&setup.creation_tx)],
        }
    }

    pub(super) fn parameters(&self) -> PrivateLendingParameters {
        *self.offer.get_parameters()
    }

    /// The collateral the loan holds, `c_k`.
    pub(super) fn collateral(&self) -> u64 {
        self.utxo.amount()
    }

    /// The loan that the installment `tx` of `payment` leaves, with the outputs `outputs`.
    pub(super) fn after_installment(
        &self,
        tx: &Transaction,
        outputs: InstallmentOutputs,
        payment: DebtOpening,
    ) -> Loan {
        let opening = self
            .opening
            .after(payment)
            .expect("an installment leaves part of the debt");

        Loan {
            utxo: find_pinned_utxo(tx, &outputs.collateral),
            offer: outputs.successor,
            opening,
            carries: outputs
                .carries
                .iter()
                .map(|carry| find_pinned_utxo(tx, carry))
                .collect(),
        }
    }
}

/// The carry supply of the creation transaction `creation_tx`, explicit.
pub(super) fn carry_supply(creation_tx: &Transaction) -> UTXO {
    UTXO {
        outpoint: OutPoint::new(creation_tx.txid(), CARRY_SUPPLY_OUTPUT as u32),
        txout: creation_tx.output[CARRY_SUPPLY_OUTPUT].clone(),
        secrets: None,
    }
}

/// A fresh offer accepted by a fresh lender: the offer's setup, the lender and the loan.
pub(super) fn accepted_loan(
    context: &simplex::TestContext,
) -> anyhow::Result<(PrivateOfferSetup, Signer, Loan)> {
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(context, default_offer_parameters(context)?)?;
    let acceptance_tx = accept_private_offer(context, &mut setup, &lender)?;
    let loan = Loan::accepted(&setup, &acceptance_tx);

    Ok((setup, lender, loan))
}

/// [`accepted_loan`] of an offer with `offer_parameters`.
pub(super) fn accepted_loan_with(
    context: &simplex::TestContext,
    offer_parameters: OfferParameters,
) -> anyhow::Result<(PrivateOfferSetup, Signer, Loan)> {
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(context, offer_parameters)?;
    let acceptance_tx = accept_private_offer(context, &mut setup, &lender)?;
    let loan = Loan::accepted(&setup, &acceptance_tx);

    Ok((setup, lender, loan))
}

/// The lender's lifted lending key: the blinding key of the installments and the repayment, which
/// the lender opens with its lending key, as the app blinds them.
pub(super) fn lender_blinding_key(setup: &PrivateOfferSetup) -> PublicKey {
    PublicKey::new(lift_lending_key(
        &setup.lender_lending_key.x_only_public_key(),
    ))
}

/// The borrower's lifted lending key: the blinding key of the acceptance's outputs as the app
/// blinds them, with which the borrower reads the lender's message on the principal, and of the
/// carries and their burns.
pub(super) fn borrower_blinding_key(setup: &PrivateOfferSetup) -> PublicKey {
    PublicKey::new(lift_lending_key(
        &setup.borrower_lending_key.x_only_public_key(),
    ))
}

/// The output of the repayment asset `A` that carries `opening`: an installment, or the full
/// repayment of a debt.
pub(super) fn repayment_output(
    parameters: &PrivateLendingParameters,
    opening: DebtOpening,
) -> PinnedOutput {
    PinnedOutput {
        amount: opening.amount,
        value_blinding_factor: opening.blinder,
        ..parameters.pinned.repayment
    }
}

/// A coin of `asset` that `signer` holds, explicit or confidential, with at least `amount`.
pub(super) fn coin_of(signer: &Signer, asset: AssetId, amount: u64) -> anyhow::Result<UTXO> {
    let enough = |utxo: &UTXO| utxo.asset() == asset && utxo.amount() >= amount;

    signer
        .get_utxos_filter(&enough, &enough)?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no coin of {asset} with at least {amount}"))
}

/// Spends `coin` and gives what `spent` leaves of it back to `signer`, blinded.
pub(super) fn add_coin_and_change(
    ctx: &mut ConfidentialTransaction,
    signer: &Signer,
    coin: UTXO,
    spent: u64,
) {
    let (asset, amount) = (coin.asset(), coin.amount());

    ctx.add_input(PartialInput::new(coin), RequiredSignature::NativeEcdsa);

    if amount > spent {
        ctx.add_output(
            PartialOutput::new(
                signer.get_confidential_address().script_pubkey(),
                amount - spent,
                asset,
            )
            .with_blinding_key(signer.get_blinding_public_key()),
        );
    }
}

/// The borrower NFT, which the borrower holds.
pub(super) fn borrower_nft(
    borrower: &Signer,
    parameters: &PrivateLendingParameters,
) -> anyhow::Result<UTXO> {
    Ok(borrower.get_utxos_asset(parameters.borrower_nft_asset_id)?[0].clone())
}

/// `amount` of the collateral to `receiver`, blinded to its wallet.
pub(super) fn collateral_to(
    receiver: &Signer,
    parameters: &PrivateLendingParameters,
    amount: u64,
) -> PartialOutput {
    PartialOutput::new(
        receiver.get_confidential_address().script_pubkey(),
        amount,
        parameters.pinned.active_collateral.asset_id,
    )
    .with_blinding_key(receiver.get_blinding_public_key())
}

/// `amount` of `asset` back to `signer`, blinded, if it is not 0.
pub(super) fn add_change(
    ctx: &mut ConfidentialTransaction,
    signer: &Signer,
    asset: AssetId,
    amount: u64,
) {
    if amount > 0 {
        ctx.add_output(
            PartialOutput::new(
                signer.get_confidential_address().script_pubkey(),
                amount,
                asset,
            )
            .with_blinding_key(signer.get_blinding_public_key()),
        );
    }
}

/// The proofs' R2: an installment that releases nothing gives the borrower one more confidential
/// output in the release's place, here of the policy asset, so that the number of outputs does not
/// tell whether it released collateral.
fn add_extra_borrower_output(ctx: &mut ConfidentialTransaction, borrower: &Signer) {
    let policy_asset = borrower.get_provider().get_network().policy_asset();

    add_change(ctx, borrower, policy_asset, EXTRA_OUTPUT_AMOUNT);
}

/// The installment of `payment` on `loan`, before finalization, built with `attach_installment`:
/// the borrower NFT returns to the borrower's address, a principal coin of the borrower pays
/// (input 2), the loan's carries follow, the release goes to the borrower's wallet (or, when
/// nothing is released, an extra output of R2), and the principal's change returns to the
/// borrower. The installment carries the borrower's `message`. Returns the transaction and the
/// outputs it leaves.
pub(super) fn build_installment(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    payment: DebtOpening,
    message: Option<&SignedMessage>,
) -> anyhow::Result<(ConfidentialTransaction, InstallmentOutputs)> {
    build_installment_to(
        setup,
        loan,
        borrower,
        payment,
        message,
        lender_blinding_key(setup),
    )
}

/// [`build_installment`] with the installment and the successor blinded to `lender_key`, with the
/// installment's nonce derived for it only when `lender_key` is the lender's: a borrower who builds
/// its own transactions can blind them to a stranger.
pub(super) fn build_installment_to(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    payment: DebtOpening,
    message: Option<&SignedMessage>,
    lender_key: PublicKey,
) -> anyhow::Result<(ConfidentialTransaction, InstallmentOutputs)> {
    let parameters = loan.parameters();
    let installment = repayment_output(&parameters, payment);
    let coin = coin_of(borrower, installment.asset_id, installment.amount)?;
    let change = coin.amount() - installment.amount;
    let nft_receiver = borrower.get_address().script_pubkey();
    let ephemeral_sk = if lender_key == lender_blinding_key(setup) {
        installment_ephemeral_key(
            &setup.borrower_lending_key,
            loan.utxo.outpoint,
            coin.outpoint,
            &nft_receiver,
        )
    } else {
        SecretKey::new(&mut rand::thread_rng())
    };

    let mut ctx = ConfidentialTransaction::new();

    let outputs = loan.offer.attach_installment(
        &mut ctx,
        borrower_nft(borrower, &parameters)?,
        loan.utxo.clone(),
        nft_receiver,
        installment,
        lender_key,
        ephemeral_sk,
        message,
        InstallmentRelease {
            borrower: &setup.borrower_lending_key,
            secrets: &setup.secrets,
            debt: loan.opening,
            principal_coins: vec![coin],
            carries: loan.carries.clone(),
            release_receiver: borrower.get_confidential_address().script_pubkey(),
            release_blinding_key: borrower.get_blinding_public_key(),
        },
    );

    if outputs.release == 0 {
        add_extra_borrower_output(&mut ctx, borrower);
    }
    add_change(&mut ctx, borrower, installment.asset_id, change);

    Ok((ctx, outputs))
}

/// Broadcasts the installment of `payment` on `loan`; returns the transaction and the loan it
/// leaves.
pub(super) fn pay_installment(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    payment: DebtOpening,
) -> anyhow::Result<(Transaction, Loan)> {
    pay_installment_with(setup, loan, borrower, payment, None)
}

/// [`pay_installment`] with the borrower's `message` on the installment.
pub(super) fn pay_installment_with(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    payment: DebtOpening,
    message: Option<&SignedMessage>,
) -> anyhow::Result<(Transaction, Loan)> {
    let (ctx, outputs) = build_installment(setup, loan, borrower, payment, message)?;
    let tx = broadcast(&ctx, borrower)?;
    let next = loan.after_installment(&tx, outputs, payment);

    Ok((tx, next))
}

/// `Y = x·G + y·J`, the blinder commitment of the blinders `x` and `y`.
pub(super) fn blinder_commitment(x: &SecretKey, y: &SecretKey) -> secp256k1_zkp::PublicKey {
    let y_j = release_j()
        .mul_tweak(SECP256K1, &Scalar::from(*y))
        .expect("a nonzero multiple of a curve point");

    secp256k1_zkp::PublicKey::from_secret_key(SECP256K1, x)
        .combine(&y_j)
        .expect("not the point at infinity")
}

/// The witness, the first input and the outputs of an installment, which its failure tests
/// change. [`InstallmentParts::honest`] gives those of [`build_installment`], computed here from
/// the core's arithmetic and derivations, so the core and the covenant check each other.
#[derive(Clone)]
pub(super) struct InstallmentParts {
    /// The debt the loan input's witness claims: the loan's.
    pub debt: confidential::Value,
    /// The step the witness claims, the loan's.
    pub step: u32,
    /// The leaf whose Merkle path the witness carries: the step's.
    pub leaf: u32,
    /// `Y`, the blinder commitment the witness carries: `Y_(step + 1)`.
    pub blinder_commitment: secp256k1_zkp::PublicKey,
    /// The release proof of the honest outputs.
    pub proof: ReleaseProof,
    /// Input 0 and output 0: the borrower NFT, back to the borrower.
    pub first_input: UTXO,
    pub first_output: PartialOutput,
    /// Output 1: the successor loan.
    pub successor_script: Script,
    pub successor_collateral: PinnedOutput,
    /// Output 2: the installment.
    pub installment_script: Script,
    pub installment: PinnedOutput,
    /// Outputs 3 and 4: the carries.
    pub carry_scripts: [Script; 2],
    pub carries: [PinnedOutput; 2],
    /// Whether output 3 is explicit.
    pub explicit_carry: bool,
}

impl InstallmentParts {
    /// The parts of the honest installment of `payment` on `loan`.
    pub(super) fn honest(
        setup: &PrivateOfferSetup,
        loan: &Loan,
        borrower: &Signer,
        payment: DebtOpening,
    ) -> anyhow::Result<InstallmentParts> {
        let parameters = loan.parameters();
        let pinned = parameters.pinned;
        let (collateral, full) = (pinned.active_collateral.amount, pinned.repayment.amount);
        let installment = repayment_output(&parameters, payment);
        let step = loan.offer.get_installments();
        let left = debt_after(&loan.offer.get_debt(), &installment.value_commitment())?;
        let debt_left = loan
            .opening
            .after(payment)
            .expect("part of the debt is left");
        let held = collateral_at(debt_left.amount, collateral, full);
        let e = carry_remainder(debt_left.amount, collateral, full);
        let carry_asset = loan.carries[0].asset();
        let carry_lock = parameters
            .get_principal_output_asset_auth()
            .get_script_pubkey();
        let (x, y) = setup.secrets.release_blinders(step + 1);

        let mut parts = InstallmentParts {
            debt: loan.offer.get_debt(),
            step,
            leaf: step,
            blinder_commitment: blinder_commitment(&x, &y),
            proof: ReleaseProof {
                t: [blinder_commitment(&x, &y); 7],
                z: [Scalar::ZERO; 11],
            },
            first_input: borrower_nft(borrower, &parameters)?,
            first_output: PartialOutput::new(
                borrower.get_address().script_pubkey(),
                1,
                parameters.borrower_nft_asset_id,
            ),
            successor_script: PrivateLendingOffer::new_active_at(parameters, left, step + 1)
                .get_script_pubkey(),
            successor_collateral: parameters.loan_collateral(&setup.secrets, step + 1, held),
            installment_script: parameters
                .get_installment_output_asset_auth()
                .get_script_pubkey(),
            installment,
            carry_scripts: [carry_lock.clone(), carry_lock],
            carries: [e + 1, full - e].map(|amount| PinnedOutput::new_random(carry_asset, amount)),
            explicit_carry: false,
        };
        let secrets = parts.honest_secrets(setup, loan, (x, y));
        parts.prove(setup, &secrets);

        Ok(parts)
    }

    /// The secrets of these parts as an honest borrower computes them, with the blinders
    /// `blinders` of the successor's step: `c'` and `e` from the debt that output 2 leaves, the
    /// carries' value blinders from outputs 3 and 4.
    pub(super) fn honest_secrets(
        &self,
        setup: &PrivateOfferSetup,
        loan: &Loan,
        blinders: (SecretKey, SecretKey),
    ) -> ReleaseSecrets {
        let pinned = setup.parameters.pinned;
        let debt_left = loan
            .opening
            .after(DebtOpening::of(&self.installment))
            .expect("part of the debt is left");

        ReleaseSecrets::new(
            &pinned.active_collateral,
            &pinned.repayment,
            debt_left,
            blinders,
            (
                self.carries[0].value_blinding_factor,
                self.carries[1].value_blinding_factor,
            ),
        )
    }

    /// The statement of these parts, every point read from their commitments as the program
    /// reads them ([`statement_of`]).
    pub(super) fn statement(&self, parameters: &PrivateLendingParameters) -> ReleaseStatement {
        let [first, second] = self.carries;

        statement_of(
            parameters,
            &self.debt,
            &self.installment.value_commitment(),
            &self.successor_collateral.value_commitment(),
            [
                (first.asset_commitment(), first.value_commitment()),
                (second.asset_commitment(), second.value_commitment()),
            ],
            self.blinder_commitment,
        )
    }

    /// Replaces the proof with the borrower's proof of these parts' statement with `secrets`.
    pub(super) fn prove(&mut self, setup: &PrivateOfferSetup, secrets: &ReleaseSecrets) {
        let statement = self.statement(&setup.parameters);

        self.proof = prove(&statement, secrets, &setup.borrower_lending_key);
    }

    /// The installment witness of these parts.
    pub(super) fn witness(&self, setup: &PrivateOfferSetup) -> PrivateLendingWitnessBranch {
        PrivateLendingWitnessBranch::Installment {
            debt: self.debt,
            step: self.step,
            blinder_commitment: self.blinder_commitment,
            path: BlinderTree::new(&setup.secrets).path(self.leaf),
            proof: self.proof,
        }
    }
}

/// The release proof's statement of an installment, every point read from the commitments as the
/// program reads them: `D' = D − V` from the witness's debt `debt` and output 2's `installment`,
/// `V_s` from output 1's `successor`, `W1`, `A_w1`, `W2` and `A_w2` from outputs 3 and 4's
/// `carries`, each `(asset, value)`, and `Y` from the witness. The loan's points are the
/// parameters'.
pub(super) fn statement_of(
    parameters: &PrivateLendingParameters,
    debt: &confidential::Value,
    installment: &confidential::Value,
    successor: &confidential::Value,
    carries: [(confidential::Asset, confidential::Value); 2],
    y: secp256k1_zkp::PublicKey,
) -> ReleaseStatement {
    let points = parameters.statement_points();
    let value = |value: &confidential::Value| value_point(value).expect("a value commitment");
    let asset = |asset: &confidential::Asset| asset_point(asset).expect("an asset commitment");
    let debt_left = debt_after(debt, installment).expect("the installment leaves a debt");
    let [(first_asset, first_value), (second_asset, second_value)] = carries;

    ReleaseStatement {
        a: points.repayment_asset,
        a_c: points.collateral_asset,
        v_c0: points.collateral_value,
        d0: points.starting_debt,
        d_next: value(&debt_left),
        v_s: value(successor),
        w1: value(&first_value),
        a_w1: asset(&first_asset),
        w2: value(&second_value),
        a_w2: asset(&second_asset),
        y,
    }
}

/// An installment on `loan` built by hand from `parts`, before finalization, where
/// [`build_installment`] uses `attach_installment`: the loan input takes the installment witness
/// of `parts`, a principal coin of the borrower pays what output 2 holds of the principal asset
/// (input 2), and the loan's carries follow. The free outputs balance the parts: the collateral
/// that output 1 does not hold goes to the borrower, and the carry units outputs 3 and 4 do not
/// hold are burned.
pub(super) fn build_installment_with(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    parts: &InstallmentParts,
    borrower: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = loan.parameters();
    let principal_asset = parameters.pinned.repayment.asset_id;
    let paid = if parts.installment.asset_id == principal_asset {
        parts.installment.amount
    } else {
        0
    };
    let coin = coin_of(borrower, principal_asset, paid)?;
    let change = coin.amount() - paid;
    let ephemeral_sk = installment_ephemeral_key(
        &setup.borrower_lending_key,
        loan.utxo.outpoint,
        coin.outpoint,
        &parts.first_output.script_pubkey,
    );
    let borrower_key = borrower_blinding_key(setup);

    let mut ctx = ConfidentialTransaction::new();

    ctx.add_input(
        PartialInput::new(parts.first_input.clone()),
        RequiredSignature::NativeEcdsa,
    );
    ctx.add_output(parts.first_output.clone());

    loan.offer.add_program_input(
        &mut ctx,
        loan.utxo.clone(),
        parts.witness(setup).build_witness(),
    );
    ctx.add_pinned_output(
        parts.successor_script.clone(),
        parts.successor_collateral,
        lender_blinding_key(setup),
    );
    ctx.add_pinned_output_with(
        parts.installment_script.clone(),
        parts.installment,
        lender_blinding_key(setup),
        ephemeral_sk,
        Vec::new(),
    );
    for (index, (script, carry)) in parts.carry_scripts.iter().zip(parts.carries).enumerate() {
        if index == 0 && parts.explicit_carry {
            ctx.add_output(PartialOutput::new(
                script.clone(),
                carry.amount,
                carry.asset_id,
            ));
        } else {
            ctx.add_pinned_output(script.clone(), carry, borrower_key);
        }
    }

    ctx.add_input(PartialInput::new(coin), RequiredSignature::NativeEcdsa);
    add_carry_inputs(&mut ctx, &parameters, loan.carries.clone());

    let released = loan.collateral() - parts.successor_collateral.amount;
    add_change(
        &mut ctx,
        borrower,
        parameters.pinned.active_collateral.asset_id,
        released,
    );
    let carried: u64 = loan.carries.iter().map(UTXO::amount).sum();
    let leftover = carried - parts.carries.iter().map(|carry| carry.amount).sum::<u64>();
    if leftover > 0 {
        ctx.add_pinned_output(
            Script::new_op_return(b"burn"),
            PinnedOutput::new_random(loan.carries[0].asset(), leftover),
            borrower_key,
        );
    }
    add_change(&mut ctx, borrower, principal_asset, change);

    Ok(ctx)
}

/// Adds `carries` as inputs, each unlocked by the borrower NFT at input 0 and output 0.
fn add_carry_inputs(
    ctx: &mut ConfidentialTransaction,
    parameters: &PrivateLendingParameters,
    carries: Vec<UTXO>,
) {
    let carry_lock = parameters.get_principal_output_asset_auth();

    for carry in carries {
        carry_lock.attach_unlocking(ctx, carry, AssetAuthWitnessParams::new(0, 0));
    }
}

/// The full repayment of `loan`, before finalization, built with `attach_full_repayment`: the
/// borrower pays the rest of the debt from a principal coin (input 2), takes the collateral back
/// (output 2) and sweeps the carries (inputs 3 on) into a confidential burn.
pub(super) fn build_full_repayment(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    lender_blinding_key: PublicKey,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = loan.parameters();
    let coin = coin_of(
        borrower,
        parameters.pinned.repayment.asset_id,
        loan.opening.amount,
    )?;

    let mut ctx = ConfidentialTransaction::new();

    loan.offer.attach_full_repayment(
        &mut ctx,
        borrower_nft(borrower, &parameters)?,
        loan.utxo.clone(),
        loan.opening,
        lender_blinding_key,
    );

    ctx.add_output(collateral_to(borrower, &parameters, loan.collateral()));
    add_coin_and_change(&mut ctx, borrower, coin, loan.opening.amount);
    loan.offer
        .attach_carry_sweep(&mut ctx, loan.carries.clone(), borrower_blinding_key(setup));

    Ok(ctx)
}

/// A full repayment of `loan` built by hand, before finalization: the loan input takes the full
/// repayment witness of `debt_hash` and the lender is paid `repayment`, where
/// `attach_full_repayment` takes the loan's debt hash and pays the opening of its debt. The carries
/// are not swept.
pub(super) fn build_full_repayment_with(
    loan: &Loan,
    borrower: &Signer,
    lender_blinding_key: PublicKey,
    debt_hash: [u8; 32],
    repayment: PinnedOutput,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = loan.parameters();
    let coin = coin_of(borrower, repayment.asset_id, repayment.amount)?;

    let mut ctx = ConfidentialTransaction::new();

    ctx.add_input(
        PartialInput::new(borrower_nft(borrower, &parameters)?),
        RequiredSignature::NativeEcdsa,
    );
    ctx.add_output(PartialOutput::new(
        Script::new_op_return(b"burn"),
        1,
        parameters.borrower_nft_asset_id,
    ));
    loan.offer.add_program_input(
        &mut ctx,
        loan.utxo.clone(),
        PrivateLendingWitnessBranch::FullRepayment { debt_hash }.build_witness(),
    );
    ctx.add_pinned_output(
        parameters
            .get_repayment_output_asset_auth()
            .get_script_pubkey(),
        repayment,
        lender_blinding_key,
    );

    ctx.add_output(collateral_to(borrower, &parameters, loan.collateral()));
    add_coin_and_change(&mut ctx, borrower, coin, repayment.amount);

    Ok(ctx)
}

/// The Simplicity spend of an input: the weight of its script witness (the witness data, the
/// program, the CMR and the control block, with their length prefixes, one weight unit a byte)
/// and the cost of the program it reveals, with whether the cost is within the input's budget.
pub(super) struct SimplicitySpend {
    pub weight: usize,
    pub cost: Cost,
    pub within_budget: bool,
}

/// The Simplicity spend of input `index` of `tx`, printed with `branch`: the measure the web's
/// `PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY` takes for the branch.
pub(super) fn simplicity_spend(
    branch: &str,
    tx: &Transaction,
    index: usize,
) -> anyhow::Result<SimplicitySpend> {
    let stack = &tx.input[index].witness.script_witness;
    let [witness_bytes, program_bytes, ..] = stack.as_slice() else {
        anyhow::bail!("input {index} is not a Simplicity spend");
    };
    let program = RedeemNode::<Elements>::decode(
        BitIter::from(program_bytes.as_slice()),
        BitIter::from(witness_bytes.as_slice()),
    )
    .map_err(|e| anyhow::anyhow!("the program does not decode: {e}"))?;
    let cost = program.bounds().cost;

    let spend = SimplicitySpend {
        weight: serialize(stack).len(),
        cost,
        within_budget: cost.is_budget_valid(stack),
    };
    println!(
        "{branch}: script witness {} WU (witness {} B, program {} B), cost {cost} mWU, budget {} \
         mWU",
        spend.weight,
        witness_bytes.len(),
        program_bytes.len(),
        (spend.weight + 50) * 1000,
    );

    Ok(spend)
}

/// Claims `locked_utxo`, an output of `asset_auth` that carries its secrets, with
/// [`claim_locked_outputs`]: `keeper`'s auth asset returns to it or is burned, as `asset_auth`
/// says.
pub(super) fn claim_asset_auth_output(
    keeper: &Signer,
    asset_auth: &AssetAuth,
    locked_utxo: UTXO,
) -> anyhow::Result<Transaction> {
    let secrets = locked_utxo
        .secrets
        .ok_or_else(|| anyhow::anyhow!("the locked output is not opened"))?;
    let burn = asset_auth.get_parameters().with_asset_burn;

    claim_locked_outputs(keeper, asset_auth, &[(locked_utxo, secrets)], burn)
}

/// Claims the outputs `locked` with the NFT that `nft` names: the NFT (input 0) unlocks them
/// (inputs 1…) and returns to `keeper` (output 0), or is burned with `burn`, and their total goes
/// to `keeper` (output 1). Each output takes the input secrets it is paired with, which need not
/// open it (see [`add_locked_outputs`]). Returns the claim, confirmed.
pub(super) fn claim_locked_outputs(
    keeper: &Signer,
    nft: &AssetAuth,
    locked: &[(UTXO, TxOutSecrets)],
    burn: bool,
) -> anyhow::Result<Transaction> {
    let auth = *nft.get_parameters();
    let nft_utxo = keeper
        .get_utxos_asset(auth.asset_id)?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("the keeper does not hold the NFT"))?;
    let nft_receiver = if burn {
        Script::new_op_return(b"burn")
    } else {
        keeper.get_address().script_pubkey()
    };

    let mut ctx = ConfidentialTransaction::new();

    ctx.add_input(PartialInput::new(nft_utxo), RequiredSignature::NativeEcdsa);
    ctx.add_output(PartialOutput::new(
        nft_receiver,
        auth.asset_amount,
        auth.asset_id,
    ));
    add_locked_outputs(
        &mut ctx,
        keeper,
        nft,
        locked,
        AssetAuthWitnessParams::new(0, 0),
    )?;

    broadcast(&ctx, keeper)
}

/// Spends the outputs `locked`, each held by the lock of the NFT that `nft` names, with burn or
/// without (an installment or a repayment), whichever its script is. `witness` names where the
/// transaction carries the NFT. Their total, of the one asset they all hold, goes to `keeper` as
/// the next output.
///
/// Each output takes the input secrets it is paired with. Blinding balances with the sum of the
/// secrets, so their amounts and value blinders need not open each output, only add up to the sum
/// of the outputs' openings: the final claim gives one swept output the combined opening and the
/// others zero (see `sweep_opening`). The asset ids and asset blinders must be the outputs' own,
/// because the surjection proofs are built from them.
pub(super) fn add_locked_outputs(
    ctx: &mut ConfidentialTransaction,
    keeper: &Signer,
    nft: &AssetAuth,
    locked: &[(UTXO, TxOutSecrets)],
    witness: AssetAuthWitnessParams,
) -> anyhow::Result<()> {
    let auth = *nft.get_parameters();
    let locks = [false, true].map(|with_asset_burn| {
        AssetAuth::new(AssetAuthParameters {
            with_asset_burn,
            ..auth
        })
    });
    let [(_, first), ..] = locked else {
        anyhow::bail!("there is nothing to claim");
    };

    let mut total = 0;
    for (utxo, secrets) in locked {
        anyhow::ensure!(
            secrets.asset == first.asset,
            "the locked outputs hold several assets"
        );
        let lock = locks
            .iter()
            .find(|lock| lock.get_script_pubkey() == utxo.txout.script_pubkey)
            .ok_or_else(|| anyhow::anyhow!("{} is not locked to the NFT", utxo.outpoint))?;
        let utxo = UTXO {
            secrets: Some(*secrets),
            ..utxo.clone()
        };

        lock.attach_unlocking(ctx, utxo, witness);
        total += secrets.value;
    }

    ctx.add_output(
        PartialOutput::new(
            keeper.get_confidential_address().script_pubkey(),
            total,
            first.asset,
        )
        .with_blinding_key(keeper.get_blinding_public_key()),
    );

    Ok(())
}

/// Asserts that the program of one of the transaction's inputs rejects it: running the program
/// fails, not loading it, matching its witness or finding its address.
pub(super) fn assert_program_rejects(result: Result<impl Sized, ConfidentialTransactionError>) {
    match result {
        Err(ConfidentialTransactionError::Program(
            ProgramError::Pruning(_) | ProgramError::Execution(_),
        )) => {}
        Err(error) => panic!("expected the program to reject the transaction, got: {error}"),
        Ok(_) => panic!("expected the program to reject the transaction"),
    }
}

pub(super) fn get_active_offer(setup: &PrivateOfferSetup) -> PrivateLendingOffer {
    PrivateLendingOffer::new_active(setup.parameters)
}

pub(super) fn assert_confidential(tx: &Transaction, utxo: &UTXO) {
    let txout = &tx.output[utxo.outpoint.vout as usize];

    assert!(txout.asset.is_confidential(), "the asset is visible");
    assert!(txout.value.is_confidential(), "the amount is visible");
}
