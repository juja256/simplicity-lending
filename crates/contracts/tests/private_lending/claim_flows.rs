//! The lender's claims. The lender presents the lender NFT to claim installments, one at a time,
//! and keeps it. The final claim, after the full repayment, burns it and sweeps every unclaimed
//! installment with the combined opening, so that the lender receives `R` whatever the borrower's
//! range proofs hold. A liquidation has no combined opening: the lender computes the loan's
//! storage from the chain, opens the collateral by the search, without opening any installment,
//! and sweeps the installments that open.

use simplex::signer::Signer;
use simplex::simplicityhl::elements::bitcoin::PublicKey;
use simplex::simplicityhl::elements::confidential::{self, ValueBlindingFactor};
use simplex::simplicityhl::elements::secp256k1_zkp::{SECP256K1, SecretKey};
use simplex::simplicityhl::elements::{AssetId, OutPoint, Transaction, TxOut, TxOutSecrets};
use simplex::transaction::UTXO;

use lending_contracts::programs::asset_auth::AssetAuthWitnessParams;
use lending_contracts::programs::private_lending::{PrivateLendingOffer, PrivateLendingParameters};
use lending_contracts::programs::program::SimplexProgram;
use private_lending_core::{DebtOpening, InstallmentError, debt_after, sweep_opening};

use super::offer_installment_flows::{open_as_lender, random_payment};
use super::offer_liquidation_success_flows::build_liquidation_of;
use super::setup::{
    Loan, PrivateOfferSetup, accepted_loan, add_locked_outputs, broadcast, build_full_repayment,
    build_installment_to, claim_locked_outputs, lender_blinding_key, lender_view, mine_until,
    pay_installment, repayment_output, unblind_with,
};

/// The output of an installment that pays the lender.
const INSTALLMENT_OUTPUT: u32 = 2;
/// The output of a full repayment that pays the lender.
const REPAYMENT_OUTPUT: u32 = 1;

/// What `signer` holds of `asset`.
fn balance(signer: &Signer, asset: AssetId) -> anyhow::Result<u64> {
    Ok(signer
        .get_utxos_asset(asset)?
        .iter()
        .map(UTXO::amount)
        .sum())
}

/// Output `vout` of `tx`, not opened.
fn output_of(tx: &Transaction, vout: u32) -> UTXO {
    UTXO {
        outpoint: OutPoint::new(tx.txid(), vout),
        txout: tx.output[vout as usize].clone(),
        secrets: None,
    }
}

/// The installment output of the installment `tx`.
fn installment_of(tx: &Transaction) -> UTXO {
    output_of(tx, INSTALLMENT_OUTPUT)
}

/// The input secrets of an output under the repayment asset `A` with `opening`: `A`'s asset id
/// and asset blinder, and `opening`'s amount and value blinder. No commitment is built, so the
/// zero opening is allowed.
fn under_a(parameters: &PrivateLendingParameters, opening: DebtOpening) -> TxOutSecrets {
    repayment_output(parameters, opening).secrets()
}

/// What the lender opens of `txout` with its lending key: `None` if its range proof does not
/// rewind with it.
fn lender_opening(setup: &PrivateOfferSetup, txout: &TxOut) -> anyhow::Result<Option<DebtOpening>> {
    match open_as_lender(setup, txout) {
        Ok(opening) => Ok(Some(opening)),
        Err(error) => match error.downcast_ref::<InstallmentError>() {
            Some(InstallmentError::Rewind(_)) => Ok(None),
            _ => Err(error),
        },
    }
}

/// Broadcasts an installment of `payment` on `loan` that the lender cannot open, as a borrower who
/// builds their own transactions can make: its range proof is blinded to a stranger's key with a
/// random nonce. So is the successor loan's, which nobody rewinds: both parties derive its
/// blinders. Returns the transaction and the loan it leaves.
fn pay_unopenable_installment(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    payment: DebtOpening,
) -> anyhow::Result<(Transaction, Loan)> {
    let stranger = PublicKey::new(SecretKey::new(&mut rand::thread_rng()).public_key(SECP256K1));

    let (ctx, outputs) = build_installment_to(setup, loan, borrower, payment, None, stranger)?;
    let tx = broadcast(&ctx, borrower)?;
    let next = loan.after_installment(&tx, outputs, payment);

    Ok((tx, next))
}

/// The debt that the lender computes after the installments `txs`, read from the chain: `D₀`,
/// the pinned repayment's value commitment, less each installment's value commitment, with no
/// installment opened.
fn lender_debt(
    parameters: &PrivateLendingParameters,
    txs: &[&Transaction],
) -> anyhow::Result<confidential::Value> {
    txs.iter().try_fold(
        parameters.pinned.repayment.value_commitment(),
        |debt, tx| {
            Ok(debt_after(
                &debt,
                &tx.output[INSTALLMENT_OUTPUT as usize].value,
            )?)
        },
    )
}

/// The inputs of a final claim that sweeps `outputs`, all under `A`: the first takes the combined
/// opening `sweep`, the others an amount and a value blinder of zero. Each keeps `A`'s asset id
/// and asset blinder, from which the surjection proofs are built.
fn swept(
    parameters: &PrivateLendingParameters,
    outputs: Vec<UTXO>,
    sweep: DebtOpening,
) -> Vec<(UTXO, TxOutSecrets)> {
    let zero = DebtOpening {
        amount: 0,
        blinder: ValueBlindingFactor::zero(),
    };

    outputs
        .into_iter()
        .enumerate()
        .map(|(index, utxo)| {
            let opening = if index == 0 { sweep } else { zero };
            (utxo, under_a(parameters, opening))
        })
        .collect()
}

/// The lender opens the installment `tx` and claims it, keeping the lender NFT; returns its
/// opening.
fn claim_one_installment(
    setup: &PrivateOfferSetup,
    lender: &Signer,
    tx: &Transaction,
) -> anyhow::Result<DebtOpening> {
    let parameters = setup.parameters;
    let opening = open_as_lender(setup, &tx.output[INSTALLMENT_OUTPUT as usize])?;

    claim_locked_outputs(
        lender,
        &parameters.get_installment_output_asset_auth(),
        &[(installment_of(tx), under_a(&parameters, opening))],
        false,
    )?;

    Ok(opening)
}

#[simplex::test]
fn lender_claims_one_installment_and_keeps_the_nft(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let provider = context.get_default_provider();
    let borrower = context.get_default_signer();
    let (setup, lender, loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let asset = parameters.pinned.repayment.asset_id;
    assert_eq!(balance(&lender, asset)?, 0);

    let (tx, _) = pay_installment(&setup, &loan, borrower, random_payment(2_000))?;
    let installment = installment_of(&tx);
    let opening = open_as_lender(&setup, &installment.txout)?;
    assert_eq!(opening.amount, 2_000);

    let claim_tx = claim_locked_outputs(
        &lender,
        &parameters.get_installment_output_asset_auth(),
        &[(installment.clone(), under_a(&parameters, opening))],
        false,
    )?;

    // the lender NFT (input 0) unlocks the installment (input 1) and returns to the lender
    assert_eq!(claim_tx.input[1].previous_output, installment.outpoint);
    assert_eq!(
        claim_tx.output[0].asset.explicit(),
        Some(parameters.lender_nft_asset_id)
    );
    assert_eq!(
        claim_tx.output[0].script_pubkey,
        lender.get_address().script_pubkey()
    );
    assert_eq!(
        lender
            .get_utxos_asset(parameters.lender_nft_asset_id)?
            .len(),
        1
    );
    // and the installment is the lender's
    assert_eq!(unblind_with(&lender, &claim_tx.output[1])?.value, 2_000);
    assert_eq!(balance(&lender, asset)?, 2_000);
    assert!(
        provider
            .fetch_scripthash_utxos(&installment.txout.script_pubkey)?
            .is_empty()
    );

    Ok(())
}

#[simplex::test]
fn final_claim_sweeps_unopenable_installments_after_full_repayment(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let provider = context.get_default_provider();
    let borrower = context.get_default_signer();
    let (setup, lender, loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let repayment = parameters.pinned.repayment;
    let installment_lock = parameters.get_installment_output_asset_auth();
    assert_eq!(balance(&lender, repayment.asset_id)?, 0);

    // an installment that the lender opens and claims
    let (opened, loan) = pay_installment(&setup, &loan, borrower, random_payment(1_500))?;
    let claimed = claim_one_installment(&setup, &lender, &opened)?;

    // two that it cannot open, then the full repayment of the rest
    let (first, loan) = pay_unopenable_installment(&setup, &loan, borrower, random_payment(2_000))?;
    let (second, loan) =
        pay_unopenable_installment(&setup, &loan, borrower, random_payment(3_000))?;
    for tx in [&first, &second] {
        assert_eq!(
            lender_opening(&setup, &tx.output[INSTALLMENT_OUTPUT as usize])?,
            None
        );
    }
    let repayment_tx = broadcast(
        &build_full_repayment(&setup, &loan, borrower, lender_blinding_key(&setup))?,
        borrower,
    )?;

    // the unclaimed installments and the repayment add up to the debt at acceptance less the
    // claimed installment
    let sweep = sweep_opening(DebtOpening::of(&repayment), &[claimed])
        .expect("the claimed installment is below the debt");
    assert_eq!(sweep.amount, repayment.amount - 1_500);
    let claim_tx = claim_locked_outputs(
        &lender,
        &installment_lock,
        &swept(
            &parameters,
            vec![
                installment_of(&first),
                installment_of(&second),
                output_of(&repayment_tx, REPAYMENT_OUTPUT),
            ],
            sweep,
        ),
        true,
    )?;

    // the lender NFT is burned, and the lender holds R
    assert!(claim_tx.output[0].script_pubkey.is_op_return());
    assert!(
        lender
            .get_utxos_asset(parameters.lender_nft_asset_id)?
            .is_empty()
    );
    assert_eq!(
        unblind_with(&lender, &claim_tx.output[1])?.value,
        sweep.amount
    );
    assert_eq!(balance(&lender, repayment.asset_id)?, repayment.amount);
    for lock in [
        installment_lock,
        parameters.get_repayment_output_asset_auth(),
    ] {
        assert!(
            provider
                .fetch_scripthash_utxos(&lock.get_script_pubkey())?
                .is_empty()
        );
    }

    Ok(())
}

#[simplex::test]
fn lender_liquidates_a_loan_it_cannot_open(context: simplex::TestContext) -> anyhow::Result<()> {
    let provider = context.get_default_provider();
    let borrower = context.get_default_signer();
    let (setup, lender, loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let pinned = parameters.pinned;
    let installment_lock = parameters.get_installment_output_asset_auth();
    assert_eq!(balance(&lender, pinned.repayment.asset_id)?, 0);

    let (first, loan) = pay_installment(&setup, &loan, borrower, random_payment(1_000))?;
    let (second, loan) =
        pay_unopenable_installment(&setup, &loan, borrower, random_payment(2_000))?;
    let (third, loan) = pay_installment(&setup, &loan, borrower, random_payment(1_500))?;
    let installments = [&first, &second, &third];

    // the lender's view, from `D₀` and the installments' value commitments alone: the loan's
    // storage after three installments, at the address of the loan's output
    let (lender_parameters, lender_secrets) = lender_view(&setup)?;
    let debt = lender_debt(&lender_parameters, &installments)?;
    let offer =
        PrivateLendingOffer::new_active_at(lender_parameters, debt, installments.len() as u32);
    assert_eq!(third.output[1].script_pubkey, offer.get_script_pubkey());
    let loan_utxo = UTXO {
        outpoint: OutPoint::new(third.txid(), 1),
        txout: third.output[1].clone(),
        secrets: None,
    };

    // the installments that open with the lender's key
    let mut opened = Vec::new();
    for tx in installments {
        if let Some(opening) = lender_opening(&setup, &tx.output[INSTALLMENT_OUTPUT as usize])? {
            opened.push((installment_of(tx), under_a(&parameters, opening)));
        }
    }
    assert_eq!(opened.len(), 2);

    // after the term, the liquidation burns the lender NFT (input 1, output 0), takes the
    // collateral (output 1), which the search opens, and sweeps the installments that open
    // (inputs 2…, output 2)
    mine_until(&context, parameters.loan_expiration_time + 1)?;
    let (mut ctx, collateral) = build_liquidation_of(&offer, loan_utxo, &lender, &lender_secrets)?;
    assert_eq!(Some(collateral.secrets()), loan.utxo.secrets);
    assert!(collateral.amount < pinned.active_collateral.amount);
    add_locked_outputs(
        &mut ctx,
        &lender,
        &installment_lock,
        &opened,
        AssetAuthWitnessParams::new(1, 0),
    )?;
    let liquidation_tx = broadcast(&ctx, &lender)?;

    assert!(liquidation_tx.output[0].script_pubkey.is_op_return());
    assert!(
        lender
            .get_utxos_asset(parameters.lender_nft_asset_id)?
            .is_empty()
    );
    let taken = unblind_with(&lender, &liquidation_tx.output[1])?;
    assert_eq!(
        (taken.asset, taken.value),
        (pinned.active_collateral.asset_id, loan.collateral())
    );
    assert_eq!(balance(&lender, pinned.repayment.asset_id)?, 2_500);
    // the installment that does not open stays, stranded now that the lender NFT is burned
    let stranded: Vec<_> = provider
        .fetch_scripthash_utxos(&installment_lock.get_script_pubkey())?
        .into_iter()
        .map(|utxo| utxo.outpoint)
        .collect();
    assert_eq!(stranded, [installment_of(&second).outpoint]);

    Ok(())
}
