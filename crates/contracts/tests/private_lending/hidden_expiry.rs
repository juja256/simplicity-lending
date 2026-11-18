//! Item 1, the hidden expiry: the liquidation branch carries `EXPIRY_HASH = SHA-256(salt ‖
//! expiry_be32)`, with the salt derived from the offer's shared secret, and takes the salt and the
//! expiry from its witness. A spend through another branch reveals the program's CMR, which
//! commits to the hash but not to the salt or the expiry, so trying candidate expiries against it
//! needs the salt.

use std::num::NonZeroUsize;

use simplex::program::ArgumentsTrait;
use simplex::simplicityhl::TemplateProgram;
use simplex::simplicityhl::elements::Transaction;
use simplex::simplicityhl::elements::hashes::{Hash, sha256};
use simplex::simplicityhl::elements::secp256k1_zkp::SecretKey;

use lending_contracts::artifacts::private_lending::PrivateLendingProgram;
use lending_contracts::artifacts::private_lending::derived_private_lending::PrivateLendingArguments;
use lending_contracts::programs::private_lending::PrivateLendingParameters;
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::ConfidentialTransactionError;
use private_lending_core::{OfferSecrets, expiry_hash};

use super::offer_liquidation_success_flows::{build_liquidation, build_liquidation_with};
use super::setup::{
    PrivateOfferSetup, accept_private_offer, assert_program_rejects, broadcast,
    build_full_repayment, default_offer_parameters, find_pinned_utxo, get_active_offer,
    setup_pending_private_offer,
};

/// The input of an acceptance that spends the offer.
const ACCEPTANCE_OFFER_INPUT: usize = 0;
/// The input of a full repayment that spends the offer.
const FULL_REPAYMENT_OFFER_INPUT: usize = 1;
/// How far from the true expiry `candidate_expiries_do_not_match` tries candidates, each way. Each
/// candidate costs three compilations of the program, about 1.5 s of CPU in a debug build, so the
/// window is ±200 blocks, not the plan's ±1 000, which would take about six minutes on 16 threads.
const CANDIDATE_WINDOW: u32 = 200;

/// The CMR that input `index` of `tx` reveals: the leaf script of its Simplicity spend, the second
/// to last item of its witness stack (the witness, the program, the CMR, the control block).
fn revealed_cmr(tx: &Transaction, index: usize) -> [u8; 32] {
    let stack = &tx.input[index].witness.script_witness;

    stack[stack.len() - 2]
        .as_slice()
        .try_into()
        .expect("a 32-byte CMR")
}

/// The private lending program, parsed once: its CMR for given arguments is that of the program
/// the contracts compile, with debug symbols.
fn private_lending_template() -> TemplateProgram {
    TemplateProgram::new(PrivateLendingProgram::SOURCE).expect("the program parses")
}

fn program_cmr(template: &TemplateProgram, arguments: &PrivateLendingArguments) -> [u8; 32] {
    let compiled = template
        .instantiate(arguments.build_arguments(), true)
        .expect("the arguments fit the program");

    compiled.commit().cmr().to_byte_array()
}

/// The CMR of the program with `arguments`, but `hash` in place of their `EXPIRY_HASH`.
fn cmr_with_expiry_hash(
    template: &TemplateProgram,
    arguments: &PrivateLendingArguments,
    hash: [u8; 32],
) -> [u8; 32] {
    let mut arguments = arguments.clone();
    arguments.expiry_hash = hash;

    program_cmr(template, &arguments)
}

/// The guesses, `(what, block, hash)`, whose expiry hash gives the program with `arguments` the
/// CMR `revealed`. A compilation takes about half a second in a debug build, so the guesses are
/// spread over every core.
fn guesses_matching<'a>(
    template: &TemplateProgram,
    arguments: &PrivateLendingArguments,
    revealed: [u8; 32],
    guesses: &[(&'a str, u32, [u8; 32])],
) -> Vec<(&'a str, u32, [u8; 32])> {
    let threads = std::thread::available_parallelism().map_or(1, NonZeroUsize::get);

    std::thread::scope(|scope| {
        let handles: Vec<_> = guesses
            .chunks(guesses.len().div_ceil(threads).max(1))
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .filter(|(_, _, hash)| {
                            cmr_with_expiry_hash(template, arguments, *hash) == revealed
                        })
                        .copied()
                        .collect::<Vec<_>>()
                })
            })
            .collect();

        handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("a guessing thread panicked"))
            .collect()
    })
}

/// The salt of another offer to the same lender.
fn another_offers_salt(setup: &PrivateOfferSetup) -> [u8; 32] {
    let ephemeral_sk = SecretKey::from_slice(&[7; 32]).expect("a valid secret key");
    let salt =
        OfferSecrets::for_borrower(&ephemeral_sk, &setup.lender_lending_key.x_only_public_key())
            .expiry_salt();

    assert_ne!(salt, setup.parameters.expiry_salt);

    salt
}

/// The salt enters the CMR that the acceptance and the full repayment reveal. Two real offers with
/// the same terms and expiry also differ in their pinned outputs, whose blinders derive from the
/// same secret as the salt, so the other offer is this offer's parameters with another salt: the
/// revealed CMRs are those of this offer's parameters, and the other parameters give another CMR.
#[simplex::test]
fn salt_changes_the_revealed_cmr(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let other_parameters = PrivateLendingParameters {
        expiry_salt: another_offers_salt(&setup),
        ..parameters
    };

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;
    let active_offer = get_active_offer(&setup);
    let repayment_tx = broadcast(
        &build_full_repayment(
            &active_offer,
            find_pinned_utxo(&acceptance_tx, &parameters.pinned.active_collateral),
            borrower,
            &lender,
        )?,
        borrower,
    )?;

    let template = private_lending_template();
    let cmr = program_cmr(&template, &parameters.build_arguments());
    let other_cmr = program_cmr(&template, &other_parameters.build_arguments());

    assert_ne!(cmr, other_cmr);
    for revealed in [
        revealed_cmr(&acceptance_tx, ACCEPTANCE_OFFER_INPUT),
        revealed_cmr(&repayment_tx, FULL_REPAYMENT_OFFER_INPUT),
    ] {
        assert_eq!(revealed, cmr);
        assert_ne!(revealed, other_cmr);
    }

    Ok(())
}

/// An observer who knows every other argument of the program and guesses the salt cannot find the
/// expiry from the CMR that an acceptance reveals.
#[simplex::test]
fn candidate_expiries_do_not_match(context: simplex::TestContext) -> anyhow::Result<()> {
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let other_salt = another_offers_salt(&setup);

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;
    let revealed = revealed_cmr(&acceptance_tx, ACCEPTANCE_OFFER_INPUT);

    let template = private_lending_template();
    let arguments = parameters.build_arguments();
    let expiry = parameters.loan_expiration_time;

    // the control: the true salt at the true expiry gives the revealed CMR
    assert_eq!(
        cmr_with_expiry_hash(
            &template,
            &arguments,
            expiry_hash(&parameters.expiry_salt, expiry)
        ),
        revealed
    );

    let candidates = expiry.saturating_sub(CANDIDATE_WINDOW)..=expiry + CANDIDATE_WINDOW;
    assert!(candidates.contains(&expiry));
    let guesses: Vec<_> = candidates
        .flat_map(|candidate| {
            [
                (
                    "no salt",
                    candidate,
                    sha256::Hash::hash(&candidate.to_be_bytes()).to_byte_array(),
                ),
                ("a zero salt", candidate, expiry_hash(&[0; 32], candidate)),
                (
                    "another offer's salt",
                    candidate,
                    expiry_hash(&other_salt, candidate),
                ),
            ]
        })
        .collect();

    let matching = guesses_matching(&template, &arguments, revealed, &guesses);
    assert!(
        matching.is_empty(),
        "these guesses give the revealed CMR: {matching:?}"
    );

    Ok(())
}

#[simplex::test]
fn liquidation_fails_with_a_wrong_salt(context: simplex::TestContext) -> anyhow::Result<()> {
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let expiry = parameters.loan_expiration_time;
    let other_salt = another_offers_salt(&setup);

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    setup.offer = get_active_offer(&setup);

    for salt in [other_salt, [0; 32]] {
        let ctx = build_liquidation_with(&setup, &acceptance_tx, &lender, salt, expiry, expiry)?;

        assert_program_rejects(ctx.finalize(&lender));
    }

    // the control: the same transaction with the offer's salt goes through the program
    let ctx = build_liquidation_with(
        &setup,
        &acceptance_tx,
        &lender,
        parameters.expiry_salt,
        expiry,
        expiry,
    )?;
    ctx.finalize(&lender)?;

    Ok(())
}

#[simplex::test]
fn liquidation_fails_with_a_wrong_expiry(context: simplex::TestContext) -> anyhow::Result<()> {
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let expiry = parameters.loan_expiration_time;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    setup.offer = get_active_offer(&setup);

    // locked to the expiry it claims, so the lock time check passes and the hash fails: an earlier
    // expiry would let the lender liquidate early
    for wrong_expiry in [expiry - 1, expiry + 1] {
        let ctx = build_liquidation_with(
            &setup,
            &acceptance_tx,
            &lender,
            parameters.expiry_salt,
            wrong_expiry,
            wrong_expiry,
        )?;

        assert_program_rejects(ctx.finalize(&lender));
    }

    Ok(())
}

#[simplex::test]
fn liquidation_fails_before_the_expiry(context: simplex::TestContext) -> anyhow::Result<()> {
    let provider = context.get_default_provider();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let expiry = parameters.loan_expiration_time;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    setup.offer = get_active_offer(&setup);

    let tip = provider.fetch_tip_height()?;
    assert!(tip < expiry);

    // locked to the expiry: the program accepts it, but the network refuses a transaction not
    // final yet
    let result = build_liquidation(&setup, &acceptance_tx, &lender)?.broadcast(&lender);

    assert!(matches!(
        result,
        Err(ConfidentialTransactionError::Provider(_))
    ));

    // locked to the tip, so final now: the program refuses it
    let ctx = build_liquidation_with(
        &setup,
        &acceptance_tx,
        &lender,
        parameters.expiry_salt,
        expiry,
        tip,
    )?;

    assert_program_rejects(ctx.finalize(&lender));
    assert!(
        !provider
            .fetch_scripthash_utxos(&setup.offer.get_script_pubkey())?
            .is_empty()
    );

    Ok(())
}
