//! The zero-debt close. An installment of exactly the amount still owed, under another blinder than
//! the debt's, leaves the debt `k·G`, which no repayment output can carry: a range proof proves an
//! amount of at least 1. The borrower closes such a loan by burning the borrower NFT and revealing
//! `k` in an `OP_RETURN`; the covenant checks that `k·G` has the debt's x-coordinate, so the
//! borrower may reveal `k` or `−k`.

use simplex::signer::Signer;
use simplex::simplicityhl::elements::confidential::ValueBlindingFactor;
use simplex::transaction::{PartialInput, PartialOutput, RequiredSignature};

use lending_contracts::programs::private_lending::PrivateLendingWitnessBranch;
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::ConfidentialTransaction;
use lending_contracts::utils::op_return_payload;
use private_lending_core::{DebtOpening, zero_debt_blinder, zero_debt_key};

use super::offer_installment_flows::prefix_bit;
use super::setup::{
    Loan, PrivateOfferSetup, accepted_loan, assert_program_rejects, borrower_nft, broadcast,
    collateral_to, pay_installment, simplicity_spend, unblind_with,
};

/// The order `n` of secp256k1's group, big-endian.
const CURVE_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// The scalar `value`, below 256, as a blinder.
fn small_blinder(value: u8) -> ValueBlindingFactor {
    let mut bytes = [0; 32];
    bytes[31] = value;

    ValueBlindingFactor::from_slice(&bytes).expect("a small scalar")
}

/// `n + value`, for `value` below 0xbe so that the last byte does not carry.
fn order_plus(value: u8) -> [u8; 32] {
    let mut bytes = CURVE_ORDER;
    bytes[31] += value;

    bytes
}

/// The 32 bytes of `−blinder`.
fn negated_key(blinder: ValueBlindingFactor) -> [u8; 32] {
    *(-blinder).into_inner().as_ref()
}

/// Pays an installment of all that `loan` owes under `blinder`, another blinder than the debt's,
/// and returns the loan it leaves, which owes nothing: its debt is `(r − blinder)·G`.
fn pay_the_whole_amount(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    borrower: &Signer,
    blinder: ValueBlindingFactor,
) -> anyhow::Result<Loan> {
    let payment = DebtOpening {
        amount: loan.opening.amount,
        blinder,
    };
    let (_, zero) = pay_installment(setup, loan, borrower, payment)?;
    assert_eq!(zero.opening.amount, 0);

    Ok(zero)
}

/// A blinder for an installment of all that `loan` owes, searched off chain so that the zero debt
/// it leaves has the prefix bit `bit`.
fn blinder_for_bit(loan: &Loan, bit: u8) -> ValueBlindingFactor {
    let repayment = loan.parameters().pinned.repayment;

    loop {
        let blinder = ValueBlindingFactor::new(&mut rand::thread_rng());
        let payment = DebtOpening {
            amount: loan.opening.amount,
            blinder,
        };
        let left = loan
            .opening
            .after(payment)
            .expect("another blinder than the debt's");

        if prefix_bit(&left.commitment(&repayment)) == bit {
            return blinder;
        }
    }
}

/// The loan of a fresh offer brought to a zero debt with the prefix bit `bit`.
fn zero_debt_loan(
    context: &simplex::TestContext,
    bit: u8,
) -> anyhow::Result<(PrivateOfferSetup, Loan)> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(context)?;
    let zero = pay_the_whole_amount(&setup, &loan, borrower, blinder_for_bit(&loan, bit))?;
    assert_eq!(prefix_bit(&zero.offer.get_debt()), bit);

    Ok((setup, zero))
}

/// The zero-debt close of `loan`, before finalization, built with `attach_zero_debt_close`: the
/// collateral returns to the borrower at output 2.
fn build_zero_debt_close(
    loan: &Loan,
    borrower: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = loan.parameters();

    let mut ctx = ConfidentialTransaction::new();

    loan.offer.attach_zero_debt_close(
        &mut ctx,
        borrower_nft(borrower, &parameters)?,
        loan.utxo.clone(),
        loan.opening,
    );
    ctx.add_output(collateral_to(borrower, &parameters));

    Ok(ctx)
}

/// A zero-debt close of `loan` built by hand, before finalization: the loan input takes the
/// witness of `key`, and output 1 is `key_output`, or, without one, the collateral back to the
/// borrower, which otherwise follows at output 2. `attach_zero_debt_close` reveals the debt's
/// blinder in both.
fn build_zero_debt_close_with(
    loan: &Loan,
    borrower: &Signer,
    key: [u8; 32],
    key_output: Option<PartialOutput>,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = loan.parameters();

    let mut ctx = ConfidentialTransaction::new();

    ctx.add_input(
        PartialInput::new(borrower_nft(borrower, &parameters)?),
        RequiredSignature::NativeEcdsa,
    );
    ctx.add_output(PartialOutput::new(
        simplex::simplicityhl::elements::Script::new_op_return(b"burn"),
        1,
        parameters.borrower_nft_asset_id,
    ));
    loan.offer.add_program_input(
        &mut ctx,
        loan.utxo.clone(),
        PrivateLendingWitnessBranch::ZeroDebtClose {
            debt: loan.offer.get_debt(),
            key,
        }
        .build_witness(),
    );
    if let Some(key_output) = key_output {
        ctx.add_output(key_output);
    }
    ctx.add_output(collateral_to(borrower, &parameters));

    Ok(ctx)
}

/// The `OP_RETURN` that reveals `key`, one 32-byte push.
fn key_reveal(key: &[u8; 32]) -> PartialOutput {
    PartialOutput::new_metadata(key)
}

/// The control of the failures below: revealing the debt's blinder goes through the program.
fn assert_true_key_passes(loan: &Loan, borrower: &Signer) -> anyhow::Result<()> {
    let key = zero_debt_key(&loan.opening).expect("a zero debt");

    build_zero_debt_close_with(loan, borrower, key, Some(key_reveal(&key)))?.finalize(borrower)?;

    Ok(())
}

#[simplex::test]
fn zero_debt_state_closes_revealing_k(context: simplex::TestContext) -> anyhow::Result<()> {
    let provider = context.get_default_provider();
    let borrower = context.get_default_signer();
    let (_setup, loan) = zero_debt_loan(&context, 0)?;
    let parameters = loan.parameters();
    let debt = loan.offer.get_debt();

    let close_tx = broadcast(&build_zero_debt_close(&loan, borrower)?, borrower)?;
    simplicity_spend("ZeroDebtClose", &close_tx, 1)?;

    // output 1 reveals k, from which the lender recovers the debt's blinder
    let key =
        op_return_payload(&close_tx.output[1].script_pubkey).expect("output 1 is an OP_RETURN");
    let key: [u8; 32] = key.try_into()?;
    assert_eq!(Some(key), zero_debt_key(&loan.opening));
    assert_eq!(zero_debt_blinder(&key, &debt), Ok(loan.opening.blinder));

    // the borrower NFT is burned, and the collateral returns to the borrower
    assert!(close_tx.output[0].script_pubkey.is_op_return());
    assert!(
        borrower
            .get_utxos_asset(parameters.borrower_nft_asset_id)?
            .is_empty()
    );
    let collateral = unblind_with(borrower, &close_tx.output[2])?;
    assert_eq!(
        (collateral.asset, collateral.value),
        (
            parameters.pinned.active_collateral.asset_id,
            parameters.pinned.active_collateral.amount
        )
    );
    assert!(
        provider
            .fetch_scripthash_utxos(&loan.offer.get_script_pubkey())?
            .is_empty()
    );

    Ok(())
}

#[simplex::test]
fn zero_debt_state_closes_revealing_minus_k(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (_setup, loan) = zero_debt_loan(&context, 1)?;
    let debt = loan.offer.get_debt();

    let minus_k = negated_key(loan.opening.blinder);
    let close_tx = broadcast(
        &build_zero_debt_close_with(&loan, borrower, minus_k, Some(key_reveal(&minus_k)))?,
        borrower,
    )?;

    // `−k` gives the lender the debt's blinder just as well
    let key =
        op_return_payload(&close_tx.output[1].script_pubkey).expect("output 1 is an OP_RETURN");
    assert_eq!(key, minus_k);
    assert_eq!(zero_debt_blinder(&minus_k, &debt), Ok(loan.opening.blinder));

    Ok(())
}

#[simplex::test]
fn zero_debt_close_fails_while_debt_remains(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;
    let (_, loan) = pay_installment(
        &setup,
        &loan,
        borrower,
        DebtOpening {
            amount: 1_000,
            blinder: ValueBlindingFactor::new(&mut rand::thread_rng()),
        },
    )?;
    assert!(loan.opening.amount > 0);

    // the debt's blinder r, while d·A + r·G still holds an amount d
    let key = *loan.opening.blinder.into_inner().as_ref();
    for key in [key, negated_key(loan.opening.blinder)] {
        assert_program_rejects(
            build_zero_debt_close_with(&loan, borrower, key, Some(key_reveal(&key)))?
                .finalize(borrower),
        );
    }

    Ok(())
}

#[simplex::test]
fn zero_debt_close_fails_with_k_of_another_point(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (_setup, loan) = zero_debt_loan(&context, 0)?;
    assert_true_key_passes(&loan, borrower)?;

    // the key of another zero debt
    let other = *ValueBlindingFactor::new(&mut rand::thread_rng())
        .into_inner()
        .as_ref();
    assert_program_rejects(
        build_zero_debt_close_with(&loan, borrower, other, Some(key_reveal(&other)))?
            .finalize(borrower),
    );

    Ok(())
}

#[simplex::test]
fn zero_debt_close_fails_with_k_zero(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (_setup, loan) = zero_debt_loan(&context, 1)?;
    assert_true_key_passes(&loan, borrower)?;

    let zero = [0; 32];
    assert_program_rejects(
        build_zero_debt_close_with(&loan, borrower, zero, Some(key_reveal(&zero)))?
            .finalize(borrower),
    );

    Ok(())
}

/// The covenant reads the key as a scalar below `n`, not modulo `n`: `k + n` gives the point `k·G`
/// in secp256k1's arithmetic, but the lender's `zero_debt_blinder` refuses it, and could not sweep.
#[simplex::test]
fn zero_debt_close_fails_with_k_at_or_above_the_order(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    const K: u8 = 7;

    let borrower = context.get_default_signer();
    let (setup, _lender, loan) = accepted_loan(&context)?;

    // the debt left is K·G, so that K + n fits in 256 bits
    let mut blinder = loan.opening.blinder;
    blinder += -small_blinder(K);
    let loan = pay_the_whole_amount(&setup, &loan, borrower, blinder)?;
    assert_eq!(loan.opening.blinder, small_blinder(K));
    assert_true_key_passes(&loan, borrower)?;

    for key in [order_plus(K), CURVE_ORDER] {
        assert_program_rejects(
            build_zero_debt_close_with(&loan, borrower, key, Some(key_reveal(&key)))?
                .finalize(borrower),
        );
    }

    Ok(())
}

#[simplex::test]
fn zero_debt_close_fails_without_the_op_return(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (_setup, loan) = zero_debt_loan(&context, 0)?;
    assert_true_key_passes(&loan, borrower)?;
    let key = zero_debt_key(&loan.opening).expect("a zero debt");

    for key_output in [
        // no OP_RETURN: output 1 is the collateral back to the borrower
        None,
        // an OP_RETURN of `−k` while the witness says `k`
        Some(key_reveal(&negated_key(loan.opening.blinder))),
        // an OP_RETURN that pushes something else than the key
        Some(PartialOutput::new_metadata(b"burn")),
    ] {
        assert_program_rejects(
            build_zero_debt_close_with(&loan, borrower, key, key_output)?.finalize(borrower),
        );
    }

    Ok(())
}
