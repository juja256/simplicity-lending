use simplex::program::ProgramError;
use simplex::signer::Signer;
use simplex::simplicityhl::elements::bitcoin::PublicKey;
use simplex::simplicityhl::elements::confidential;
use simplex::simplicityhl::elements::encode::serialize;
use simplex::simplicityhl::elements::secp256k1_zkp::Secp256k1;
use simplex::simplicityhl::elements::{
    AssetId, OutPoint, Script, Transaction, TxOut, TxOutSecrets,
};
use simplex::simplicityhl::simplicity::jet::Elements;
use simplex::simplicityhl::simplicity::{BitIter, Cost, RedeemNode};
use simplex::transaction::{
    FinalTransaction, PartialInput, PartialOutput, RequiredSignature, UTXO,
};

use lending_contracts::programs::asset_auth::{AssetAuth, AssetAuthWitnessParams};
use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingParameters, PrivateLendingWitnessBranch, add_nft_issuances,
    verify_offer_as_borrower,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::{
    ConfidentialTransaction, ConfidentialTransactionError, PinnedOutput, PinnedOutputExt,
};
use private_lending_core::{
    DebtOpening, LendingKey, NewOffer, OfferTerms, debt_after, installment_ephemeral_key,
    lift_lending_key,
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
}

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
    let borrower = context.get_default_signer();
    let network = *context.get_network();
    let policy_asset = network.policy_asset();
    let borrower_lending_key = LendingKey::from_master_blinding_key(&[1; 32]);
    let lender_lending_key = LendingKey::from_master_blinding_key(&[2; 32]);
    let lender = lender_lending_key.x_only_public_key();

    split_first_signer_utxo(context, vec![5000, 10000])?;

    let principal_asset_id = issue_asset(context, TOTAL_PRINCIPAL_AMOUNT)?;

    // the two smallest explicit coins issue the NFTs: fund_lender takes the largest one
    let mut coins =
        borrower.get_utxos_filter(&|utxo| utxo.explicit_asset() == policy_asset, &|_| false)?;
    coins.sort_by_key(UTXO::explicit_amount);
    let [borrower_coin, lender_coin, ..] = coins.as_slice() else {
        anyhow::bail!("the borrower needs two explicit coins to issue the NFTs");
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
    )?;

    let parameters =
        PrivateLendingParameters::from_terms(&terms, new_offer.pinned, &new_offer.secrets, network);

    let offer = PrivateLendingOffer::new_pending(parameters);

    // the collateral comes from the finalizer's coin selection
    offer.attach_creation(&mut ctx, &new_offer, borrower.get_address().script_pubkey());

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
    })
}

/// The acceptance transaction, before finalization (the lender's view of the terms).
pub(super) fn build_acceptance(
    context: &simplex::TestContext,
    setup: &mut PrivateOfferSetup,
    lender: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    let borrower = context.get_default_signer();
    let parameters = setup.parameters;

    let pending_offer_utxo =
        find_pinned_utxo(&setup.creation_tx, &parameters.pinned.pending_collateral);
    let lender_nft_utxo = find_explicit_utxo(&setup.creation_tx, parameters.lender_nft_asset_id);

    let mut ctx = ConfidentialTransaction::new();

    setup.offer.attach_acceptance(
        &mut ctx,
        pending_offer_utxo,
        lender_nft_utxo,
        borrower.get_blinding_public_key(),
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
    fund_lender(
        context,
        lender,
        setup.parameters.pinned.principal.asset_id,
        setup.parameters.pinned.principal.amount,
    )?;

    let ctx = build_acceptance(context, setup, lender)?;

    broadcast(&ctx, lender)
}

/// A loan between two of its transactions: the offer in its current state, the output that holds
/// it, and the opening of its debt, which the borrower tracks.
pub(super) struct Loan {
    pub offer: PrivateLendingOffer,
    pub utxo: UTXO,
    pub opening: DebtOpening,
}

impl Loan {
    /// The loan that `acceptance_tx` starts, whose debt is the pinned repayment.
    pub(super) fn accepted(
        parameters: PrivateLendingParameters,
        acceptance_tx: &Transaction,
    ) -> Loan {
        let offer = PrivateLendingOffer::new_active(parameters);
        let utxo = find_pinned_utxo(acceptance_tx, &offer.get_collateral());

        Loan {
            offer,
            utxo,
            opening: DebtOpening::of(&parameters.pinned.repayment),
        }
    }

    pub(super) fn parameters(&self) -> PrivateLendingParameters {
        *self.offer.get_parameters()
    }
}

/// A fresh offer accepted by a fresh lender: the offer's setup, the lender and the loan.
pub(super) fn accepted_loan(
    context: &simplex::TestContext,
) -> anyhow::Result<(PrivateOfferSetup, Signer, Loan)> {
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(context, default_offer_parameters(context)?)?;
    let acceptance_tx = accept_private_offer(context, &mut setup, &lender)?;
    let loan = Loan::accepted(setup.parameters, &acceptance_tx);

    Ok((setup, lender, loan))
}

/// The lender's lifted lending key: the blinding key of the installments and the repayment, which
/// the lender opens with its lending key, as the app blinds them.
pub(super) fn lender_blinding_key(setup: &PrivateOfferSetup) -> PublicKey {
    PublicKey::new(lift_lending_key(
        &setup.lender_lending_key.x_only_public_key(),
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

/// The collateral back to `borrower`, blinded to its wallet.
pub(super) fn collateral_to(
    borrower: &Signer,
    parameters: &PrivateLendingParameters,
) -> PartialOutput {
    PartialOutput::new(
        borrower.get_confidential_address().script_pubkey(),
        parameters.pinned.active_collateral.amount,
        parameters.pinned.active_collateral.asset_id,
    )
    .with_blinding_key(borrower.get_blinding_public_key())
}

/// The installment of `payment` on `loan`, before finalization, built with `attach_installment`:
/// the borrower NFT returns to the borrower's address, and a principal coin of the borrower pays,
/// its change back to the borrower. Returns the transaction and the offer it leaves.
pub(super) fn build_installment(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    payment: DebtOpening,
) -> anyhow::Result<(ConfidentialTransaction, PrivateLendingOffer)> {
    let parameters = loan.parameters();
    let installment = repayment_output(&parameters, payment);
    let coin = coin_of(borrower, installment.asset_id, installment.amount)?;
    let nft_receiver = borrower.get_address().script_pubkey();
    let ephemeral_sk = installment_ephemeral_key(
        &setup.borrower_lending_key,
        loan.utxo.outpoint,
        coin.outpoint,
        &nft_receiver,
    );

    let mut ctx = ConfidentialTransaction::new();

    let successor = loan.offer.attach_installment(
        &mut ctx,
        borrower_nft(borrower, &parameters)?,
        loan.utxo.clone(),
        nft_receiver,
        installment,
        lender_blinding_key(setup),
        ephemeral_sk,
    );

    add_coin_and_change(&mut ctx, borrower, coin, installment.amount);

    Ok((ctx, successor))
}

/// Broadcasts the installment of `payment` on `loan`; returns the transaction and the loan it
/// leaves.
pub(super) fn pay_installment(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    payment: DebtOpening,
) -> anyhow::Result<(Transaction, Loan)> {
    let (ctx, successor) = build_installment(setup, loan, borrower, payment)?;
    let tx = broadcast(&ctx, borrower)?;

    let utxo = find_pinned_utxo(&tx, &successor.get_collateral());
    let opening = loan
        .opening
        .after(payment)
        .expect("an installment leaves part of the debt");

    Ok((
        tx,
        Loan {
            offer: successor,
            utxo,
            opening,
        },
    ))
}

/// The witness, the first input and the outputs of an installment, which its failure tests
/// change. [`InstallmentParts::honest`] gives those of [`build_installment`], with the successor's
/// storage and collateral from the core's `debt_after` and `collateral_after`.
#[derive(Clone)]
pub(super) struct InstallmentParts {
    /// The debt the loan input's witness claims: the loan's.
    pub debt: confidential::Value,
    /// Input 0 and output 0: the borrower NFT, back to the borrower.
    pub first_input: UTXO,
    pub first_output: PartialOutput,
    /// Output 1: the successor loan.
    pub successor_script: Script,
    pub successor_collateral: PinnedOutput,
    /// Output 2: the installment.
    pub installment_script: Script,
    pub installment: PinnedOutput,
}

impl InstallmentParts {
    pub(super) fn honest(
        loan: &Loan,
        borrower: &Signer,
        payment: DebtOpening,
    ) -> anyhow::Result<InstallmentParts> {
        let parameters = loan.parameters();
        let installment = repayment_output(&parameters, payment);
        let next = loan.offer.get_installments() + 1;
        let left = debt_after(&loan.offer.get_debt(), &installment.value_commitment())?;

        Ok(InstallmentParts {
            debt: loan.offer.get_debt(),
            first_input: borrower_nft(borrower, &parameters)?,
            first_output: PartialOutput::new(
                borrower.get_address().script_pubkey(),
                1,
                parameters.borrower_nft_asset_id,
            ),
            successor_script: PrivateLendingOffer::new_active_at(parameters, left, next)
                .get_script_pubkey(),
            successor_collateral: parameters.pinned.collateral_after(next),
            installment_script: parameters
                .get_installment_output_asset_auth()
                .get_script_pubkey(),
            installment,
        })
    }
}

/// An installment on `loan` built by hand from `parts`, before finalization, where
/// [`build_installment`] uses `attach_installment`: the loan input takes the installment witness
/// of `parts.debt`, and a principal coin of the borrower pays what output 2 holds of the principal
/// asset.
pub(super) fn build_installment_with(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    parts: &InstallmentParts,
    borrower: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    let principal_asset = loan.parameters().pinned.repayment.asset_id;
    let paid = if parts.installment.asset_id == principal_asset {
        parts.installment.amount
    } else {
        0
    };
    let coin = coin_of(borrower, principal_asset, paid)?;
    let ephemeral_sk = installment_ephemeral_key(
        &setup.borrower_lending_key,
        loan.utxo.outpoint,
        coin.outpoint,
        &parts.first_output.script_pubkey,
    );

    let mut ctx = ConfidentialTransaction::new();

    ctx.add_input(
        PartialInput::new(parts.first_input.clone()),
        RequiredSignature::NativeEcdsa,
    );
    ctx.add_output(parts.first_output.clone());

    loan.offer.add_program_input(
        &mut ctx,
        loan.utxo.clone(),
        PrivateLendingWitnessBranch::Installment { debt: parts.debt }.build_witness(),
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

    add_coin_and_change(&mut ctx, borrower, coin, paid);

    Ok(ctx)
}

/// The full repayment of `loan`, before finalization, built with `attach_full_repayment`: the
/// borrower pays the rest of the debt from a principal coin and takes the collateral back
/// (output 2).
pub(super) fn build_full_repayment(
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

    ctx.add_output(collateral_to(borrower, &parameters));
    add_coin_and_change(&mut ctx, borrower, coin, loan.opening.amount);

    Ok(ctx)
}

/// A full repayment of `loan` built by hand, before finalization: the loan input takes the full
/// repayment witness of `debt_hash` and the lender is paid `repayment`, where
/// `attach_full_repayment` takes the loan's debt hash and pays the opening of its debt.
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

    ctx.add_output(collateral_to(borrower, &parameters));
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

/// Spends the asset_auth output `locked_utxo` with `keeper`'s auth asset (input 1, output 0) and
/// sends the unlocked amount to `keeper`. Returns the claim transaction.
pub(super) fn claim_asset_auth_output(
    keeper: &Signer,
    asset_auth: &AssetAuth,
    locked_utxo: UTXO,
) -> anyhow::Result<Transaction> {
    let auth_parameters = *asset_auth.get_parameters();
    let secrets = locked_utxo.secrets.expect("a pinned output");

    let auth_asset_utxo = keeper.get_utxos_asset(auth_parameters.asset_id)?[0].clone();

    let mut ctx = ConfidentialTransaction::new();

    asset_auth.attach_unlocking(&mut ctx, locked_utxo, AssetAuthWitnessParams::new(1, 0));

    ctx.add_input(
        PartialInput::new(auth_asset_utxo),
        RequiredSignature::NativeEcdsa,
    );

    let auth_asset_destination = if auth_parameters.with_asset_burn {
        simplex::simplicityhl::elements::Script::new_op_return(b"burn")
    } else {
        keeper.get_address().script_pubkey()
    };
    ctx.add_output(PartialOutput::new(
        auth_asset_destination,
        auth_parameters.asset_amount,
        auth_parameters.asset_id,
    ));

    ctx.add_output(
        PartialOutput::new(
            keeper.get_confidential_address().script_pubkey(),
            secrets.value,
            secrets.asset,
        )
        .with_blinding_key(keeper.get_blinding_public_key()),
    );

    broadcast(&ctx, keeper)
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
