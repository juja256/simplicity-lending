//! Item 3(a), installments: the installment branch computes the debt an installment leaves,
//! `D' = D − V`, on chain, requires the successor loan at the storage of `h(A, D')` and re-blinds
//! the collateral by `+G`; the full repayment then pays what is left, by equality with the stored
//! debt. The expected storage and collateral come from the core's `debt_after`, `debt_hash` and
//! `collateral_after`, so the core and the covenant check each other.

use std::collections::HashSet;

use simplex::simplicityhl::elements::confidential::{
    self, AssetBlindingFactor, ValueBlindingFactor,
};
use simplex::simplicityhl::elements::encode::{Encodable, deserialize, serialize};
use simplex::simplicityhl::elements::{Transaction, TxOut};
use simplex::transaction::{PartialOutput, UTXO};

use lending_contracts::programs::private_lending::PrivateLendingOffer;
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::PinnedOutput;
use private_lending_core::{DebtOpening, OfferSecrets, debt_after, debt_hash, open_installment};

use super::setup::{
    InstallmentParts, Loan, PrivateOfferSetup, accepted_loan, assert_program_rejects, broadcast,
    build_full_repayment, build_full_repayment_with, build_installment_with, find_pinned_utxo,
    lender_blinding_key, pay_installment, repayment_output, simplicity_spend, unblind_with,
};

/// The most installments `installments_cover_both_prefix_bits` makes before it gives up.
const MAX_INSTALLMENTS: u32 = 16;
/// The amount of each installment of `installments_cover_both_prefix_bits`: 16 of them stay below
/// the repayment of 11 000.
const SMALL_INSTALLMENT: u64 = 100;

/// The low bit of a commitment's prefix: 0 when its `y` is a square.
pub(super) fn prefix_bit(commitment: &impl Encodable) -> u8 {
    serialize(commitment)[0] & 1
}

/// The same commitment with the other prefix bit: the negated point.
fn negated(value: &confidential::Value) -> confidential::Value {
    let mut bytes = serialize(value);
    bytes[0] ^= 1;

    deserialize(&bytes).expect("the negation of a commitment is a commitment")
}

/// An installment of `amount` with a random blinder.
fn random_payment(amount: u64) -> DebtOpening {
    DebtOpening {
        amount,
        blinder: ValueBlindingFactor::new(&mut rand::thread_rng()),
    }
}

/// An installment of `amount` on `loan` whose blinder is searched off chain, so that its value
/// commitment `V` has the prefix bit `v_bit` and the debt it leaves, `D − V`, the bit `left_bit`.
fn payment_with_bits(loan: &Loan, amount: u64, v_bit: u8, left_bit: u8) -> DebtOpening {
    let parameters = loan.parameters();

    loop {
        let payment = random_payment(amount);
        let v = repayment_output(&parameters, payment).value_commitment();
        let left = debt_after(&loan.offer.get_debt(), &v).expect("an installment below the debt");

        if prefix_bit(&v) == v_bit && prefix_bit(&left) == left_bit {
            return payment;
        }
    }
}

/// What the lender opens of `txout`, an installment or a repayment blinded to its lending key.
fn open_as_lender(setup: &PrivateOfferSetup, txout: &TxOut) -> anyhow::Result<DebtOpening> {
    let nonce = txout
        .nonce
        .commitment()
        .ok_or_else(|| anyhow::anyhow!("the output has no nonce"))?;
    let shared_secret = OfferSecrets::for_lender(&setup.lender_lending_key, &nonce).shared_secret();

    Ok(open_installment(
        txout,
        shared_secret,
        &setup.parameters.pinned.repayment,
    )?)
}

/// The control of the failures below: `parts` as given goes through the program.
fn assert_honest_parts_pass(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    parts: &InstallmentParts,
    borrower: &simplex::signer::Signer,
) -> anyhow::Result<()> {
    build_installment_with(setup, loan, parts, borrower)?.finalize(borrower)?;

    Ok(())
}

#[simplex::test]
fn installments_cover_both_prefix_bits(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, mut loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let repayment_asset = parameters.pinned.repayment.asset_commitment();

    // the prefix bits seen of D, V, D', A_c and A_c + G
    let mut bits: [HashSet<u8>; 5] = Default::default();

    // The blinder of each installment fixes the bits of V and D', and D' is the next installment's
    // D, so two installments cover D, V and D'. The collateral's asset commitment moves by G at
    // each installment from blinders the offer derives, so only more installments cover its bits.
    for i in 0..MAX_INSTALLMENTS {
        let debt = loan.offer.get_debt();
        let payment = payment_with_bits(
            &loan,
            SMALL_INSTALLMENT,
            (i % 2) as u8,
            1 - prefix_bit(&debt),
        );
        let v = repayment_output(&parameters, payment).value_commitment();
        let expected_debt = debt_after(&debt, &v)?;
        let collateral = parameters.pinned.collateral_after(i);
        let next_collateral = parameters.pinned.collateral_after(i + 1);
        assert!(collateral.matches(&loan.utxo.txout));

        let (tx, next) = pay_installment(&setup, &loan, borrower, payment)?;

        // output 1 sits at the storage of the core's debt after the installment and holds the
        // core's collateral after it; output 2 pays V
        let expected = PrivateLendingOffer::new_active_at(parameters, expected_debt, i + 1);
        assert_eq!(
            expected.get_program().get_storage_at(1),
            debt_hash(&repayment_asset, &expected_debt)
        );
        assert_eq!(tx.output[1].script_pubkey, expected.get_script_pubkey());
        assert!(next_collateral.matches(&tx.output[1]));
        assert_eq!(tx.output[2].value, v);
        // the borrower's opening of the debt gives the same point as the lender's computation
        assert_eq!(
            next.opening.commitment(&parameters.pinned.repayment),
            expected_debt
        );

        for (seen, bit) in bits.iter_mut().zip([
            prefix_bit(&debt),
            prefix_bit(&v),
            prefix_bit(&expected_debt),
            prefix_bit(&collateral.asset_commitment()),
            prefix_bit(&next_collateral.asset_commitment()),
        ]) {
            seen.insert(bit);
        }

        loan = next;
        if bits.iter().all(|seen| seen.len() == 2) {
            println!(
                "both prefix bits of D, V, D', A_c and A_c + G after {} installments",
                i + 1
            );
            break;
        }
    }

    assert!(
        bits.iter().all(|seen| seen.len() == 2),
        "the prefix bits of D, V, D', A_c and A_c + G seen: {bits:?}"
    );

    Ok(())
}

#[simplex::test]
fn installment_fails_with_another_asset_on_output_2(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let honest = InstallmentParts::honest(&loan, borrower, random_payment(1_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;

    let policy_asset = context.get_network().policy_asset();
    for installment in [
        // the principal asset under another asset blinder than A's
        PinnedOutput {
            asset_blinding_factor: AssetBlindingFactor::new(&mut rand::thread_rng()),
            ..honest.installment
        },
        // another asset, under A's asset blinder
        PinnedOutput {
            asset_id: policy_asset,
            ..honest.installment
        },
    ] {
        let parts = InstallmentParts {
            installment,
            ..honest.clone()
        };

        assert_program_rejects(
            build_installment_with(&setup, &loan, &parts, borrower)?.finalize(borrower),
        );
    }

    Ok(())
}

#[simplex::test]
fn installment_fails_with_another_script_on_output_2(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let honest = InstallmentParts::honest(&loan, borrower, random_payment(1_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;

    for installment_script in [
        // back to the borrower
        borrower.get_address().script_pubkey(),
        // the full repayment's lock, which burns the lender NFT
        setup
            .parameters
            .get_repayment_output_asset_auth()
            .get_script_pubkey(),
    ] {
        let parts = InstallmentParts {
            installment_script,
            ..honest.clone()
        };

        assert_program_rejects(
            build_installment_with(&setup, &loan, &parts, borrower)?.finalize(borrower),
        );
    }

    Ok(())
}

#[simplex::test]
fn installment_fails_with_another_successor_storage(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let payment = random_payment(1_000);
    let honest = InstallmentParts::honest(&loan, borrower, payment)?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;

    let left = debt_after(
        &loan.offer.get_debt(),
        &repayment_output(&parameters, payment).value_commitment(),
    )?;
    for successor_script in [
        // the debt before the installment: the borrower pays and the debt stays
        loan.offer.get_script_pubkey(),
        // −D', the other prefix bit of D': the encoding of the point the covenant computes
        PrivateLendingOffer::new_active_at(parameters, negated(&left), 1).get_script_pubkey(),
    ] {
        let parts = InstallmentParts {
            successor_script,
            ..honest.clone()
        };

        assert_program_rejects(
            build_installment_with(&setup, &loan, &parts, borrower)?.finalize(borrower),
        );
    }

    Ok(())
}

/// The storage authenticates the witness's debt: a borrower cannot pay against a debt of its own
/// choosing, even with the successor at the storage the program computes from that debt, so that
/// every later check passes.
#[simplex::test]
fn installment_fails_with_another_debt_in_the_witness(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let honest = InstallmentParts::honest(&loan, borrower, random_payment(1_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;

    let v = honest.installment.value_commitment();
    for debt in [
        // −D, the other prefix bit of the loan's debt
        negated(&loan.offer.get_debt()),
        // a debt of one unit, which the installment more than pays
        repayment_output(&parameters, random_payment(1)).value_commitment(),
    ] {
        let left = debt_after(&debt, &v)?;
        let parts = InstallmentParts {
            debt,
            successor_script: PrivateLendingOffer::new_active_at(parameters, left, 1)
                .get_script_pubkey(),
            ..honest.clone()
        };

        assert_program_rejects(
            build_installment_with(&setup, &loan, &parts, borrower)?.finalize(borrower),
        );
    }

    Ok(())
}

#[simplex::test]
fn installment_fails_with_another_successor_collateral(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let pinned = setup.parameters.pinned;
    let honest = InstallmentParts::honest(&loan, borrower, random_payment(1_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;

    let next = pinned.collateral_after(1);
    for successor_collateral in [
        // the asset commitment plus 2G, the value commitment unchanged
        pinned.collateral_after(2),
        // the asset commitment plus G, the same amount under another value blinder
        PinnedOutput {
            value_blinding_factor: ValueBlindingFactor::new(&mut rand::thread_rng()),
            ..next
        },
        // the asset commitment plus G, one unit of collateral less
        next.with_amount(next.amount - 1),
    ] {
        let parts = InstallmentParts {
            successor_collateral,
            ..honest.clone()
        };

        assert_program_rejects(
            build_installment_with(&setup, &loan, &parts, borrower)?.finalize(borrower),
        );
    }

    Ok(())
}

#[simplex::test]
fn installment_fails_at_the_point_at_infinity(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let honest = InstallmentParts::honest(&loan, borrower, random_payment(1_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;

    // an installment of the debt itself, amount and blinder: D − V is the point at infinity, which
    // no storage encodes
    let parts = InstallmentParts {
        installment: repayment_output(&setup.parameters, loan.opening),
        ..honest
    };
    assert_eq!(parts.installment.value_commitment(), loan.offer.get_debt());

    assert_program_rejects(
        build_installment_with(&setup, &loan, &parts, borrower)?.finalize(borrower),
    );

    Ok(())
}

#[simplex::test]
fn installment_fails_without_the_borrower_nft(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let honest = InstallmentParts::honest(&loan, borrower, random_payment(1_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;

    // an explicit coin of the borrower's at input 0, passed on to output 0, in place of the NFT
    let policy_asset = context.get_network().policy_asset();
    let coin: UTXO = borrower
        .get_utxos_filter(&|utxo| utxo.explicit_asset() == policy_asset, &|_| false)?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("the borrower has no explicit coin"))?;
    let parts = InstallmentParts {
        first_output: PartialOutput::new(
            borrower.get_address().script_pubkey(),
            coin.explicit_amount(),
            policy_asset,
        ),
        first_input: coin,
        ..honest
    };

    assert_program_rejects(
        build_installment_with(&setup, &loan, &parts, borrower)?.finalize(borrower),
    );

    Ok(())
}

#[simplex::test]
fn full_repayment_after_installments_pays_the_rest(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, mut loan) = accepted_loan(&context)?;
    let pinned = setup.parameters.pinned;

    let mut installment_txs: Vec<Transaction> = Vec::new();
    for amount in [1_500, 2_250, 700] {
        let (tx, next) = pay_installment(&setup, &loan, borrower, random_payment(amount))?;
        installment_txs.push(tx);
        loan = next;
    }
    assert_eq!(loan.opening.amount, pinned.repayment.amount - 4_450);

    let repayment_tx = broadcast(
        &build_full_repayment(&loan, borrower, lender_blinding_key(&setup))?,
        borrower,
    )?;

    // the repayment output is the debt itself, the rest of the amount under the debt's blinder
    let rest = repayment_output(&setup.parameters, loan.opening);
    let repayment_utxo = find_pinned_utxo(&repayment_tx, &rest);
    assert_eq!(repayment_utxo.outpoint.vout, 1);

    // the lender opens every installment and the repayment, and they add up to the repayment of
    // the terms
    let mut paid = 0;
    for txout in installment_txs
        .iter()
        .map(|tx| &tx.output[2])
        .chain([&repayment_tx.output[1]])
    {
        paid += open_as_lender(&setup, txout)?.amount;
    }
    assert_eq!(paid, pinned.repayment.amount);

    // the collateral returns to the borrower
    let collateral = unblind_with(borrower, &repayment_tx.output[2])?;
    assert_eq!(
        (collateral.asset, collateral.value),
        (
            pinned.active_collateral.asset_id,
            pinned.active_collateral.amount
        )
    );

    Ok(())
}

#[simplex::test]
fn full_repayment_fails_with_another_commitment(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let (_, loan) = pay_installment(&setup, &loan, borrower, random_payment(2_000))?;
    let debt_hash = loan.offer.get_debt_hash();
    let lender_key = lender_blinding_key(&setup);

    // the control: the rest of the debt under its blinder goes through the program
    let rest = repayment_output(&parameters, loan.opening);
    build_full_repayment_with(&loan, borrower, lender_key, debt_hash, rest)?.finalize(borrower)?;

    for repayment in [
        // the rest of the amount under another blinder
        repayment_output(&parameters, random_payment(loan.opening.amount)),
        // one unit more under the debt's blinder
        rest.with_amount(rest.amount + 1),
        // the repayment of the terms, the debt before the installment
        parameters.pinned.repayment,
    ] {
        assert_program_rejects(
            build_full_repayment_with(&loan, borrower, lender_key, debt_hash, repayment)?
                .finalize(borrower),
        );
    }

    Ok(())
}

#[simplex::test]
fn installment_runs_within_the_cost_budget(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;

    let (tx, _) = pay_installment(&setup, &loan, borrower, random_payment(1_000))?;

    let spend = simplicity_spend("Installment", &tx, 1)?;
    assert!(
        spend.within_budget,
        "the installment costs {} mWU, over the budget of its {} WU",
        spend.cost, spend.weight
    );

    Ok(())
}
