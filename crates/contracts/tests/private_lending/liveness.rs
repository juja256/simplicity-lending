//! Each party keeps its exit whatever installments come first: the borrower can repay what is left,
//! and the lender can liquidate after the term. Random installment sequences, on loans whose term
//! has already passed, check that a full repayment and a liquidation of every state the sequence
//! reaches both finalize, so that the program runs on each.

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use simplex::simplicityhl::elements::confidential::ValueBlindingFactor;

use private_lending_core::DebtOpening;

use super::offer_liquidation_success_flows::build_liquidation_at;
use super::setup::{
    accepted_loan, broadcast, build_full_repayment, lender_blinding_key, mine_until,
    pay_installment,
};

/// How many loans the property runs.
const LOANS: usize = 3;
/// The most installments a loan takes.
const MAX_INSTALLMENTS: usize = 5;

/// The seed of the run: `LIVENESS_SEED` replays a run, otherwise a random one.
fn liveness_seed() -> anyhow::Result<u64> {
    Ok(match std::env::var("LIVENESS_SEED") {
        Ok(seed) => seed.parse()?,
        Err(_) => rand::random(),
    })
}

#[simplex::test]
fn liveness_after_random_installments(context: simplex::TestContext) -> anyhow::Result<()> {
    let seed = liveness_seed()?;
    println!("liveness seed {seed}: replay with LIVENESS_SEED={seed}");
    let mut rng = StdRng::seed_from_u64(seed);
    let borrower = context.get_default_signer();

    // the offers first: creating one spends explicit coins, which the confidential transactions of
    // the installments turn into confidential change
    let loans = (0..LOANS)
        .map(|_| accepted_loan(&context))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let last_expiry = loans
        .iter()
        .map(|(setup, _, _)| setup.parameters.loan_expiration_time)
        .max()
        .expect("some loans");
    mine_until(&context, last_expiry + 1)?;

    for (setup, lender, mut loan) in loans {
        let lender_key = lender_blinding_key(&setup);
        let installments = rng.gen_range(0..=MAX_INSTALLMENTS);
        println!(
            "a loan of {} with {installments} installments",
            loan.opening.amount
        );

        for paid in 0..=installments {
            // both exits go through the program from this state
            build_full_repayment(&loan, borrower, lender_key)?.finalize(borrower)?;
            build_liquidation_at(&loan, &lender)?.finalize(&lender)?;

            // each installment pays less than what is left
            if paid == installments || loan.opening.amount < 2 {
                break;
            }
            let payment = DebtOpening {
                amount: rng.gen_range(1..loan.opening.amount),
                blinder: ValueBlindingFactor::new(&mut rng),
            };
            println!("an installment of {}", payment.amount);
            loan = pay_installment(&setup, &loan, borrower, payment)?.1;
        }

        // the last state repays on chain
        let repayment_tx = broadcast(
            &build_full_repayment(&loan, borrower, lender_key)?,
            borrower,
        )?;
        assert_eq!(
            repayment_tx.output[1].value,
            loan.opening.commitment(&setup.parameters.pinned.repayment)
        );
    }

    Ok(())
}
