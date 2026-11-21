//! Each party keeps its exit whatever installments come first: the borrower can repay what is left,
//! and the lender can liquidate after the term, by a search for the collateral it cannot read.
//! Random installment sequences that release collateral, on loans whose term has already passed,
//! check that a full repayment and a liquidation of every state the sequence reaches both
//! finalize, so that the program runs on each, and that the releases add up exactly.

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use simplex::simplicityhl::elements::confidential::{self, ValueBlindingFactor};
use simplex::simplicityhl::elements::{OutPoint, Transaction};
use simplex::transaction::UTXO;

use lending_contracts::programs::private_lending::{PrivateLendingOffer, PrivateLendingParameters};
use lending_contracts::programs::program::SimplexProgram;
use private_lending_core::{DebtOpening, debt_after};

use super::offer_liquidation_success_flows::build_liquidation_of;
use super::setup::{
    INSTALLMENT_OUTPUT, OfferParameters, SUCCESSOR_OUTPUT, accepted_loan_with, broadcast,
    build_full_repayment, default_offer_parameters, lender_blinding_key, lender_view, mine_until,
    pay_installment,
};

/// How many loans the property runs.
const LOANS: usize = 3;
/// The most installments a loan takes.
const MAX_INSTALLMENTS: usize = 5;
/// The largest collateral of a loan: the lender's search takes about `2·sqrt(C)` steps, in this
/// unoptimized build.
const MAX_COLLATERAL: u64 = 1 << 32;
/// The largest principal of a loan: the borrower repays it with 10% interest from the principal
/// the setup issues it.
const MAX_PRINCIPAL: u64 = 50_000;

/// The seed of the run: `LIVENESS_SEED` replays a run, otherwise a random one.
fn liveness_seed() -> anyhow::Result<u64> {
    Ok(match std::env::var("LIVENESS_SEED") {
        Ok(seed) => seed.parse()?,
        Err(_) => rand::random(),
    })
}

/// `floor(paid·C/R)`, the collateral released once `paid` of `R` is paid.
fn released_after(paid: u64, collateral: u64, repayment: u64) -> u64 {
    (u128::from(paid) * u128::from(collateral) / u128::from(repayment)) as u64
}

/// The loan as a lender that reads no installment sees it after the installments `txs`: the debt
/// `D₀ − ΣV` from the installments' value commitments, the step, and the last loan output, not
/// opened: the acceptance's `accepted`, or the last installment's output 1.
fn lender_loan(
    parameters: PrivateLendingParameters,
    accepted: &UTXO,
    txs: &[Transaction],
) -> anyhow::Result<(PrivateLendingOffer, UTXO)> {
    let debt = txs.iter().try_fold(
        parameters.pinned.repayment.value_commitment(),
        |debt: confidential::Value, tx| debt_after(&debt, &tx.output[INSTALLMENT_OUTPUT].value),
    )?;
    let utxo = match txs.last() {
        Some(tx) => UTXO {
            outpoint: OutPoint::new(tx.txid(), SUCCESSOR_OUTPUT as u32),
            txout: tx.output[SUCCESSOR_OUTPUT].clone(),
            secrets: None,
        },
        None => UTXO {
            secrets: None,
            ..accepted.clone()
        },
    };

    Ok((
        PrivateLendingOffer::new_active_at(parameters, debt, txs.len() as u32),
        utxo,
    ))
}

#[simplex::test]
fn liveness_after_random_installments(context: simplex::TestContext) -> anyhow::Result<()> {
    let seed = liveness_seed()?;
    println!("liveness seed {seed}: replay with LIVENESS_SEED={seed}");
    let mut rng = StdRng::seed_from_u64(seed);
    let borrower = context.get_default_signer();

    // the offers first: creating one spends explicit coins, which the confidential transactions of
    // the installments turn into confidential change
    let mut loans = Vec::new();
    for _ in 0..LOANS {
        let offer_parameters = OfferParameters {
            collateral_amount: rng.gen_range(1..=MAX_COLLATERAL),
            principal_amount: rng.gen_range(1..=MAX_PRINCIPAL),
            ..default_offer_parameters(&context)?
        };
        let (setup, lender, loan) = accepted_loan_with(&context, offer_parameters)?;
        loans.push((setup, lender, loan));
    }
    let last_expiry = loans
        .iter()
        .map(|(setup, ..)| setup.parameters.loan_expiration_time)
        .max()
        .expect("some loans");
    mine_until(&context, last_expiry + 1)?;

    for (setup, lender, mut loan) in loans {
        let pinned = setup.parameters.pinned;
        let (collateral, full) = (pinned.active_collateral.amount, pinned.repayment.amount);
        let lender_key = lender_blinding_key(&setup);
        let (lender_parameters, lender_secrets) = lender_view(&setup)?;
        let accepted = loan.utxo.clone();
        let installments = rng.gen_range(0..=MAX_INSTALLMENTS);
        println!("a loan of C = {collateral}, R = {full}, with {installments} installments");

        let mut txs = Vec::new();
        let mut released = 0;
        for paid in 0..=installments {
            // the borrower's exit goes through the program from this state
            build_full_repayment(&setup, &loan, borrower, lender_key)?.finalize(borrower)?;

            // the lender's: from the chain and its secrets alone, the search opens the collateral
            // the borrower's loan holds
            let (offer, loan_utxo) = lender_loan(lender_parameters, &accepted, &txs)?;
            assert_eq!(offer.get_script_pubkey(), loan.offer.get_script_pubkey());
            let started = std::time::Instant::now();
            let (ctx, opened) = build_liquidation_of(&offer, loan_utxo, &lender, &lender_secrets)?;
            println!(
                "the lender's search at step {}: {} in {:?}",
                txs.len(),
                opened.amount,
                started.elapsed()
            );
            assert_eq!(Some(opened.secrets()), loan.utxo.secrets);
            assert!(opened.matches(&loan.utxo.txout));
            ctx.finalize(&lender)?;

            // each installment pays less than what is left
            if paid == installments || loan.opening.amount < 2 {
                break;
            }
            let payment = DebtOpening {
                amount: rng.gen_range(1..loan.opening.amount),
                blinder: ValueBlindingFactor::new(&mut rng),
            };
            let before = full - loan.opening.amount;
            println!("an installment of {}", payment.amount);
            let held = loan.collateral();
            let (tx, next) = pay_installment(&setup, &loan, borrower, payment)?;

            // the release is floor(paid_k·C/R) − floor(paid_(k−1)·C/R), in 128 bits
            let release = held - next.collateral();
            assert_eq!(
                release,
                released_after(before + payment.amount, collateral, full)
                    - released_after(before, collateral, full)
            );
            released += release;
            txs.push(tx);
            loan = next;
        }

        // the last state repays on chain, and the releases and the collateral returned are C
        let repayment_tx = broadcast(
            &build_full_repayment(&setup, &loan, borrower, lender_key)?,
            borrower,
        )?;
        assert_eq!(
            repayment_tx.output[1].value,
            loan.opening.commitment(&pinned.repayment)
        );
        assert_eq!(released + loan.collateral(), collateral);
    }

    Ok(())
}
