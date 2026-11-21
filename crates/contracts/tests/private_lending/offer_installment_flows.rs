//! Item 3(b), installments that release collateral: the installment branch computes the debt an
//! installment leaves, `D' = D − V`, on chain, requires the successor loan at the storage of
//! `h(A, D')`, re-blinds the collateral's asset by `+G`, and checks the release proof: the
//! successor holds `c' = ceil(d'·C/R)` under the blinder committed for its step, and the carries
//! at outputs 3 and 4 hold `e + 1` and `R − e`. The expected storage, collateral and carries come
//! from the core's `debt_after`, `collateral_at`, `carry_remainder` and the offer's derived
//! blinders, so the core and the covenant check each other. Each refusal below changes one part of
//! an installment whose honest parts go through, so that it fails one check of the program.

use std::collections::HashSet;

use simplex::signer::Signer;
use simplex::simplicityhl::elements::confidential::{
    self, AssetBlindingFactor, ValueBlindingFactor,
};
use simplex::simplicityhl::elements::encode::{Encodable, deserialize, serialize};
use simplex::simplicityhl::elements::secp256k1_zkp::{SECP256K1, Scalar, SecretKey};
use simplex::simplicityhl::elements::{Transaction, TxOut};
use simplex::transaction::{PartialOutput, UTXO};

use lending_contracts::programs::private_lending::PrivateLendingOffer;
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::{PinnedOutput, PinnedOutputExt};
use private_lending_core::{
    CARRY_SUPPLY, DebtOpening, OfferSecrets, ReleaseSecrets, carry_remainder, collateral_at,
    collateral_opening, debt_after, debt_hash, open_installment, release_of,
};

use super::setup::{
    CARRY_OUTPUTS, INSTALLMENT_OUTPUT, InstallmentParts, Loan, OfferParameters, PrivateOfferSetup,
    SUCCESSOR_OUTPUT, accepted_loan, accepted_loan_with, assert_program_rejects,
    blinder_commitment, broadcast, build_full_repayment, build_full_repayment_with,
    build_installment_with, default_offer_parameters, find_pinned_utxo, lender_blinding_key,
    open_with_lending_key, pay_installment, repayment_output, simplicity_spend, unblind_with,
};

/// The most installments `installments_cover_both_prefix_bits` makes before it gives up.
const MAX_INSTALLMENTS: u32 = 16;
/// The amount of each installment of `installments_cover_both_prefix_bits`: 16 of them stay below
/// the repayment of 11 000.
const SMALL_INSTALLMENT: u64 = 100;
/// The largest transaction weight Elements relays.
const MAX_STANDARD_WEIGHT: usize = 100_000;

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
pub(super) fn random_payment(amount: u64) -> DebtOpening {
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
pub(super) fn open_as_lender(
    setup: &PrivateOfferSetup,
    txout: &TxOut,
) -> anyhow::Result<DebtOpening> {
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
    borrower: &Signer,
) -> anyhow::Result<()> {
    build_installment_with(setup, loan, parts, borrower)?.finalize(borrower)?;

    Ok(())
}

/// Asserts that the program refuses the installment of `parts` on `loan`.
fn assert_parts_rejected(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    parts: &InstallmentParts,
    borrower: &Signer,
) -> anyhow::Result<()> {
    assert_program_rejects(
        build_installment_with(setup, loan, parts, borrower)?.finalize(borrower),
    );

    Ok(())
}

/// The collateral of `loan`'s offer at `step` holding `amount`, with the value blinder that
/// commits `x` instead of the step's: `amount·A_c + x·G`.
fn collateral_with_blinder(
    setup: &PrivateOfferSetup,
    step: u32,
    amount: u64,
    x: &SecretKey,
) -> PinnedOutput {
    let active = setup.parameters.pinned.active_collateral;
    let (asset_blinding_factor, value_blinding_factor) =
        collateral_opening(step, amount, &active.asset_blinding_factor, x);

    PinnedOutput {
        amount,
        asset_blinding_factor,
        value_blinding_factor,
        ..active
    }
}

/// The borrower's openings of the installment `tx`'s carries, with its lending key.
fn opened_carries(setup: &PrivateOfferSetup, tx: &Transaction) -> anyhow::Result<[u64; 2]> {
    let [first, second] = CARRY_OUTPUTS
        .map(|index| open_with_lending_key(&setup.borrower_lending_key, &tx.output[index]));

    Ok([first?.value, second?.value])
}

/// The output of an installment that holds the release, when it is not 0.
const RELEASE_OUTPUT: usize = 5;

/// Pays `payment` on `loan` and checks the installment against the core: the successor holds
/// `ceil(d'·C/R)` under the step's blinders at the storage of `D − V`, the borrower receives the
/// release, the carries hold `e + 1` and `R − e`, input 2 is the principal coin and the carries
/// follow it. Returns the transaction, the loan it leaves and the release.
fn pay_and_check(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    payment: DebtOpening,
) -> anyhow::Result<(Transaction, Loan, u64)> {
    let parameters = setup.parameters;
    let pinned = parameters.pinned;
    let (collateral, full) = (pinned.active_collateral.amount, pinned.repayment.amount);
    let step = loan.offer.get_installments();
    let debt_left = loan.opening.amount - payment.amount;
    let held = collateral_at(debt_left, collateral, full);
    let e = carry_remainder(debt_left, collateral, full);
    let expected_release = release_of(loan.opening.amount, payment.amount, collateral, full);
    let expected_debt = debt_after(
        &loan.offer.get_debt(),
        &repayment_output(&parameters, payment).value_commitment(),
    )?;

    let principal_coins: HashSet<_> = borrower
        .get_utxos_asset(pinned.repayment.asset_id)?
        .into_iter()
        .map(|coin| coin.outpoint)
        .collect();

    let (tx, next) = pay_installment(setup, loan, borrower, payment)?;

    let expected = PrivateLendingOffer::new_active_at(parameters, expected_debt, step + 1);
    assert_eq!(
        tx.output[SUCCESSOR_OUTPUT].script_pubkey,
        expected.get_script_pubkey()
    );
    assert!(
        parameters
            .loan_collateral(&setup.secrets, step + 1, held)
            .matches(&tx.output[SUCCESSOR_OUTPUT])
    );
    assert_eq!(next.collateral(), held);
    assert_eq!(opened_carries(setup, &tx)?, [e + 1, full - e]);
    assert_eq!(loan.collateral() - held, expected_release);
    if expected_release > 0 {
        let release = unblind_with(borrower, &tx.output[RELEASE_OUTPUT])?;
        assert_eq!(
            (release.asset, release.value),
            (pinned.active_collateral.asset_id, expected_release)
        );
    }

    // input 2 is a principal coin, from which output 2's key derives, and the carries follow
    assert_eq!(tx.input[1].previous_output, loan.utxo.outpoint);
    assert!(principal_coins.contains(&tx.input[2].previous_output));
    for (offset, carry) in loan.carries.iter().enumerate() {
        assert_eq!(tx.input[3 + offset].previous_output, carry.outpoint);
    }

    Ok((tx, next, expected_release))
}

#[simplex::test]
fn installments_cover_both_prefix_bits(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, mut loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;

    // the prefix bits seen of D, V, D', A_c + i·G, A_c + (i+1)·G, V_s, W1, A_w1, W2 and A_w2
    let mut bits: [HashSet<u8>; 10] = Default::default();

    // The blinder of each installment fixes the bits of V and D', and D' is the next installment's
    // D, so two installments cover D, V and D'. The collateral's commitments and the carries'
    // move with blinders the offer derives or draws, so only more installments cover their bits.
    for i in 0..MAX_INSTALLMENTS {
        let debt = loan.offer.get_debt();
        let payment = payment_with_bits(
            &loan,
            SMALL_INSTALLMENT,
            (i % 2) as u8,
            1 - prefix_bit(&debt),
        );
        let v = repayment_output(&parameters, payment).value_commitment();
        let input_asset = loan.utxo.txout.asset;

        let (tx, next, _) = pay_and_check(&setup, &loan, borrower, payment)?;
        assert_eq!(tx.output[INSTALLMENT_OUTPUT].value, v);
        // the borrower's opening of the debt gives the same point as the lender's computation
        let expected_debt = debt_after(&debt, &v)?;
        assert_eq!(
            next.opening.commitment(&parameters.pinned.repayment),
            expected_debt
        );
        assert_eq!(
            next.offer.get_program().get_storage_at(1),
            debt_hash(
                &parameters.pinned.repayment.asset_commitment(),
                &expected_debt
            )
        );

        let [w1, w2] = CARRY_OUTPUTS.map(|index| &tx.output[index]);
        for (seen, bit) in bits.iter_mut().zip([
            prefix_bit(&debt),
            prefix_bit(&v),
            prefix_bit(&expected_debt),
            prefix_bit(&input_asset),
            prefix_bit(&tx.output[SUCCESSOR_OUTPUT].asset),
            prefix_bit(&tx.output[SUCCESSOR_OUTPUT].value),
            prefix_bit(&w1.value),
            prefix_bit(&w1.asset),
            prefix_bit(&w2.value),
            prefix_bit(&w2.asset),
        ]) {
            seen.insert(bit);
        }

        loan = next;
        if bits.iter().all(|seen| seen.len() == 2) {
            println!(
                "both prefix bits of D, V, D', the collateral's and the carries' commitments \
                 after {} installments",
                i + 1
            );
            break;
        }
    }

    assert!(
        bits.iter().all(|seen| seen.len() == 2),
        "the prefix bits seen: {bits:?}"
    );

    Ok(())
}

/// The edges of the arithmetic on `C = 3,000`, `R = 11,000`: the first installment leaves
/// `d' = 9,999`, so `e = 0`, and releases 273; the next pays 1 and releases nothing; the one after
/// releases again.
#[simplex::test]
fn installments_release_with_no_remainder_and_nothing(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let full = setup.parameters.pinned.repayment.amount;

    let (first, loan, released) = pay_and_check(&setup, &loan, borrower, random_payment(1_001))?;
    assert_eq!(loan.opening.amount, 9_999);
    assert_eq!(carry_remainder(9_999, 3_000, full), 0);
    assert_eq!(opened_carries(&setup, &first)?, [1, full]);
    assert_eq!(released, 273);

    let (nothing, loan, released) = pay_and_check(&setup, &loan, borrower, random_payment(1))?;
    assert_eq!(released, 0);
    assert_eq!(loan.collateral(), 2_727);

    let (something, _, released) = pay_and_check(&setup, &loan, borrower, random_payment(500))?;
    assert!(released > 0);
    // the borrower's extra output takes the release's place when nothing is released (proofs,
    // R2): the number of outputs does not tell
    assert_eq!(nothing.output.len(), something.output.len());

    Ok(())
}

/// `e = R − 1`: with `C = 3,001` and `R = 11,000`, coprime, an installment of 3,999 leaves
/// `d' = 7,001`, whose `d'·C` is 1 modulo `R`.
#[simplex::test]
fn installment_releases_with_the_largest_remainder(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let offer_parameters = OfferParameters {
        collateral_amount: 3_001,
        ..default_offer_parameters(&context)?
    };
    let (setup, _lender, loan) = accepted_loan_with(&context, offer_parameters)?;
    let full = setup.parameters.pinned.repayment.amount;

    let (tx, loan, released) = pay_and_check(&setup, &loan, borrower, random_payment(3_999))?;
    assert_eq!(carry_remainder(7_001, 3_001, full), full - 1);
    assert_eq!(opened_carries(&setup, &tx)?, [full, 1]);
    assert_eq!(released, 3_001 - 1_911);

    // a later installment spends both carries
    let (_, _, _) = pay_and_check(&setup, &loan, borrower, random_payment(2_000))?;

    Ok(())
}

/// The successor's amount and asset: `c' ± 1`, with the proof of that amount, and the asset
/// commitment plus `2G` with the honest value commitment and proof.
#[simplex::test]
fn installment_refuses_another_successor(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    // d' = 8,000: c' = 2,182 and 818 released
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(3_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;
    let step = honest.step;
    let held = honest.successor_collateral.amount;
    let (x, y) = setup.secrets.release_blinders(step + 1);

    // c' + 1 and c' − 1 under the step's blinder, each proved as if honest
    for amount in [held + 1, held - 1] {
        let mut parts = InstallmentParts {
            successor_collateral: setup.parameters.loan_collateral(
                &setup.secrets,
                step + 1,
                amount,
            ),
            ..honest.clone()
        };
        let mut secrets = parts.honest_secrets(&setup, &loan, (x, y));
        secrets.c_next = amount;
        parts.prove(&setup, &secrets);

        assert_parts_rejected(&setup, &loan, &parts, borrower)?;
    }

    // the asset commitment two steps on, its value commitment and the proof the honest ones
    let parts = InstallmentParts {
        successor_collateral: collateral_with_blinder(&setup, step + 2, held, &x),
        ..honest.clone()
    };
    assert_eq!(
        parts.successor_collateral.value_commitment(),
        honest.successor_collateral.value_commitment()
    );
    assert_parts_rejected(&setup, &loan, &parts, borrower)?;

    Ok(())
}

/// The carries: split `(e, R − e + 1)` with the proof of `e − 1`, summing to `R + 2` or to `R`, on
/// another script, or explicit. At the first installment, whose carry supply absorbs the
/// difference.
#[simplex::test]
fn installment_refuses_other_carries(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let full = setup.parameters.pinned.repayment.amount;
    // d' = 10,000: e = 8,000
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(1_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;
    let blinders = setup.secrets.release_blinders(honest.step + 1);
    let e = honest.carries[0].amount - 1;
    assert_eq!(e, 8_000);
    let carry_asset = honest.carries[0].asset_id;

    // proved with the e that the carries' amounts give, `e − 1`, or with the honest e
    for (amounts, claimed_e) in [
        ([e, full - e + 1], e - 1),
        ([e + 1, full - e + 1], e),
        ([e + 1, full - e - 1], e),
    ] {
        let mut parts = InstallmentParts {
            carries: amounts.map(|amount| PinnedOutput::new_random(carry_asset, amount)),
            ..honest.clone()
        };
        let mut secrets = parts.honest_secrets(&setup, &loan, blinders);
        secrets.e = claimed_e;
        parts.prove(&setup, &secrets);

        assert_parts_rejected(&setup, &loan, &parts, borrower)?;
    }

    // either carry to the borrower's wallet instead of the principal's lock
    for carry in 0..2 {
        let mut parts = honest.clone();
        parts.carry_scripts[carry] = borrower.get_address().script_pubkey();

        assert_parts_rejected(&setup, &loan, &parts, borrower)?;
    }

    // the first carry explicit
    let parts = InstallmentParts {
        explicit_carry: true,
        ..honest.clone()
    };
    assert_parts_rejected(&setup, &loan, &parts, borrower)?;

    Ok(())
}

/// The successor's committed blinder, at step 1: a random blinder against the honest `Y`; a
/// self-made `Y` of that blinder with the honest path; the index, leaf and blinder of step 2; the
/// leaf and blinder of step 2 with the index 1.
#[simplex::test]
fn installment_refuses_another_blinder(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let (_, loan) = pay_installment(&setup, &loan, borrower, random_payment(1_000))?;
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(2_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;
    let (step, held) = (honest.step, honest.successor_collateral.amount);
    assert_eq!(step, 1);
    let honest_blinders = setup.secrets.release_blinders(step + 1);
    let mut rng = rand::thread_rng();
    let random_x = SecretKey::new(&mut rng);

    // a random blinder, proved with the honest Y's y
    let mut parts = InstallmentParts {
        successor_collateral: collateral_with_blinder(&setup, step + 1, held, &random_x),
        ..honest.clone()
    };
    let secrets = parts.honest_secrets(&setup, &loan, (random_x, honest_blinders.1));
    parts.prove(&setup, &secrets);
    assert_parts_rejected(&setup, &loan, &parts, borrower)?;

    // the same blinder in a Y of the borrower's own, with the honest path
    let random_y = SecretKey::new(&mut rng);
    parts.blinder_commitment = blinder_commitment(&random_x, &random_y);
    let secrets = parts.honest_secrets(&setup, &loan, (random_x, random_y));
    parts.prove(&setup, &secrets);
    assert_parts_rejected(&setup, &loan, &parts, borrower)?;

    // the blinders of step 3, with the index and leaf of step 2, or with the leaf of step 2 only
    let (ahead_x, ahead_y) = setup.secrets.release_blinders(step + 2);
    for claimed_step in [step + 1, step] {
        let mut parts = InstallmentParts {
            step: claimed_step,
            leaf: step + 1,
            blinder_commitment: blinder_commitment(&ahead_x, &ahead_y),
            successor_collateral: collateral_with_blinder(&setup, step + 1, held, &ahead_x),
            ..honest.clone()
        };
        let secrets = parts.honest_secrets(&setup, &loan, (ahead_x, ahead_y));
        parts.prove(&setup, &secrets);

        assert_parts_rejected(&setup, &loan, &parts, borrower)?;
    }

    Ok(())
}

/// The proof itself: a response one more, a commitment plus `G`, and the proof of another
/// installment of the same loan.
#[simplex::test]
fn installment_refuses_another_proof(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(1_500))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;

    let mut parts = honest.clone();
    let mut z_e = parts.proof.z[5].to_be_bytes();
    z_e[31] ^= 1;
    parts.proof.z[5] = Scalar::from_be_bytes(z_e)?;
    assert_parts_rejected(&setup, &loan, &parts, borrower)?;

    let mut parts = honest.clone();
    parts.proof.t[6] = parts.proof.t[6].add_exp_tweak(SECP256K1, &Scalar::ONE)?;
    assert_parts_rejected(&setup, &loan, &parts, borrower)?;

    let other = InstallmentParts::honest(&setup, &loan, borrower, random_payment(1_500))?;
    let parts = InstallmentParts {
        proof: other.proof,
        ..honest
    };
    assert_parts_rejected(&setup, &loan, &parts, borrower)?;

    Ok(())
}

/// An installment of the whole debt's amount under another blinder, and of one unit more: `d'` is
/// 0 or −1, and no successor of at least one unit (the least consensus admits for a spendable
/// output) satisfies the proof. Each is proved with the successor's least amount and the largest
/// remainder, `c' = 1` and `e = R − 1`, which would release all the collateral but one unit.
#[simplex::test]
fn installment_refuses_the_whole_debt_and_more(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let full = parameters.pinned.repayment.amount;
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(1_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;
    let blinders = setup.secrets.release_blinders(honest.step + 1);
    let carry_asset = honest.carries[0].asset_id;

    for amount in [loan.opening.amount, loan.opening.amount + 1] {
        let payment = random_payment(amount);
        let installment = repayment_output(&parameters, payment);
        let left = debt_after(&loan.offer.get_debt(), &installment.value_commitment())?;
        let mut parts = InstallmentParts {
            installment,
            successor_script: PrivateLendingOffer::new_active_at(parameters, left, 1)
                .get_script_pubkey(),
            successor_collateral: parameters.loan_collateral(&setup.secrets, 1, 1),
            carries: [full, 1].map(|amount| PinnedOutput::new_random(carry_asset, amount)),
            ..honest.clone()
        };
        // the secrets of a debt left of 0, then c' = 1 and e = R − 1
        let mut debt_left = loan.opening;
        debt_left.amount = 0;
        debt_left.blinder += -payment.blinder;
        let mut secrets = ReleaseSecrets::new(
            &parameters.pinned.active_collateral,
            &parameters.pinned.repayment,
            debt_left,
            blinders,
            (
                parts.carries[0].value_blinding_factor,
                parts.carries[1].value_blinding_factor,
            ),
        );
        secrets.c_next = 1;
        secrets.e = full - 1;
        parts.prove(&setup, &secrets);

        assert_parts_rejected(&setup, &loan, &parts, borrower)?;
    }

    Ok(())
}

#[simplex::test]
fn installment_fails_with_another_asset_on_output_2(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(1_000))?;
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

        assert_parts_rejected(&setup, &loan, &parts, borrower)?;
    }

    Ok(())
}

#[simplex::test]
fn installment_fails_with_another_script_on_output_2(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(1_000))?;
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

        assert_parts_rejected(&setup, &loan, &parts, borrower)?;
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
    let honest = InstallmentParts::honest(&setup, &loan, borrower, payment)?;
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

        assert_parts_rejected(&setup, &loan, &parts, borrower)?;
    }

    Ok(())
}

/// The storage authenticates the witness's debt: a borrower cannot pay against a debt of its own
/// choosing, even with the successor at the storage the program computes from that debt, so that
/// every later check of the installment's outputs passes.
#[simplex::test]
fn installment_fails_with_another_debt_in_the_witness(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(1_000))?;
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

        assert_parts_rejected(&setup, &loan, &parts, borrower)?;
    }

    Ok(())
}

#[simplex::test]
fn installment_fails_at_the_point_at_infinity(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(1_000))?;
    assert_honest_parts_pass(&setup, &loan, &honest, borrower)?;

    // an installment of the debt itself, amount and blinder: D − V is the point at infinity, which
    // no storage encodes
    let parts = InstallmentParts {
        installment: repayment_output(&setup.parameters, loan.opening),
        ..honest
    };
    assert_eq!(parts.installment.value_commitment(), loan.offer.get_debt());

    assert_parts_rejected(&setup, &loan, &parts, borrower)?;

    Ok(())
}

#[simplex::test]
fn installment_fails_without_the_borrower_nft(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let honest = InstallmentParts::honest(&setup, &loan, borrower, random_payment(1_000))?;
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

    assert_parts_rejected(&setup, &loan, &parts, borrower)?;

    Ok(())
}

/// The full repayment after installments that released collateral pays the rest of the debt,
/// returns the collateral left, and sweeps the two carries into one confidential burn of `R + 1`
/// units. The releases and the collateral returned add up to `C`, and the installments and the
/// repayment to `R`.
#[simplex::test]
fn full_repayment_after_installments_pays_the_rest(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, mut loan) = accepted_loan(&context)?;
    let pinned = setup.parameters.pinned;
    let (collateral, full) = (pinned.active_collateral.amount, pinned.repayment.amount);

    let mut installment_txs: Vec<Transaction> = Vec::new();
    let mut released = 0;
    for amount in [1_500, 2_250, 700] {
        let (tx, next, release) = pay_and_check(&setup, &loan, borrower, random_payment(amount))?;
        installment_txs.push(tx);
        released += release;
        loan = next;
    }
    assert_eq!(loan.opening.amount, full - 4_450);
    let carries: Vec<_> = loan.carries.iter().map(|carry| carry.outpoint).collect();

    let repayment_tx = broadcast(
        &build_full_repayment(&setup, &loan, borrower, lender_blinding_key(&setup))?,
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
        .map(|tx| &tx.output[INSTALLMENT_OUTPUT])
        .chain([&repayment_tx.output[1]])
    {
        paid += open_as_lender(&setup, txout)?.amount;
    }
    assert_eq!(paid, full);

    // the collateral left returns to the borrower, and with the releases it is all of it
    let returned = unblind_with(borrower, &repayment_tx.output[2])?;
    assert_eq!(returned.asset, pinned.active_collateral.asset_id);
    assert_eq!(returned.value, loan.collateral());
    assert_eq!(released + returned.value, collateral);

    // the two carries follow the principal coin, before the fee coins, and burn together,
    // confidential
    assert_eq!(
        repayment_tx.input[3..3 + carries.len()]
            .iter()
            .map(|input| input.previous_output)
            .collect::<Vec<_>>(),
        carries
    );
    let burn = repayment_tx
        .output
        .iter()
        .find(|txout| txout.script_pubkey.is_op_return() && txout.value.is_confidential())
        .ok_or_else(|| anyhow::anyhow!("the carries are not burned"))?;
    assert_eq!(
        open_with_lending_key(&setup.borrower_lending_key, burn)?.value,
        full + 1
    );
    // with the range proof of any other confidential output
    assert_eq!(
        burn.witness.rangeproof.as_ref().map(|proof| proof.len()),
        repayment_tx.output[1]
            .witness
            .rangeproof
            .as_ref()
            .map(|proof| proof.len())
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

/// The installment runs within its cost budget with no annex, paid for by its own witness, and its
/// transaction is below the standard weight: the first installment, which burns the carry
/// supply's leftover, and one that spends two carries.
#[simplex::test]
fn installment_runs_within_the_cost_budget(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;

    let (first, loan) = pay_installment(&setup, &loan, borrower, random_payment(1_000))?;
    let (steady, _) = pay_installment(&setup, &loan, borrower, random_payment(1_000))?;

    for (branch, tx) in [
        ("Installment (the first, with the leftover burn)", &first),
        ("Installment (two carries in)", &steady),
    ] {
        let spend = simplicity_spend(branch, tx, 1)?;
        println!(
            "{branch}: transaction weight {} WU, {} inputs, {} outputs",
            tx.weight(),
            tx.input.len(),
            tx.output.len()
        );
        // the witness, the program, the CMR and the control block: no annex
        assert_eq!(tx.input[1].witness.script_witness.len(), 4);
        assert!(
            spend.within_budget,
            "the installment costs {} mWU, over the budget of its {} WU",
            spend.cost, spend.weight
        );
        assert!(tx.weight() < MAX_STANDARD_WEIGHT);
    }
    // the first installment burns the supply's leftover, S − R − 1 units
    let burn = first
        .output
        .iter()
        .find(|txout| txout.script_pubkey.is_op_return() && txout.value.is_confidential())
        .ok_or_else(|| anyhow::anyhow!("the first installment burns no leftover"))?;
    assert_eq!(
        open_with_lending_key(&setup.borrower_lending_key, burn)?.value,
        CARRY_SUPPLY - setup.parameters.pinned.repayment.amount - 1
    );

    Ok(())
}
