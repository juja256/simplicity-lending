use simplex::signer::Signer;
use simplex::transaction::PartialOutput;

use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingWitnessBranch,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::programs::script_auth::{ScriptAuth, ScriptAuthWitnessParams};
use lending_contracts::utils::confidential::{
    ConfidentialTransaction, PinnedOutput, PinnedOutputExt,
};
use private_lending_core::DebtOpening;

use super::setup::{
    Loan, PrivateOfferSetup, accept_private_offer, add_lender_principal, assert_program_rejects,
    broadcast, build_full_repayment_with, default_offer_parameters, find_explicit_utxo,
    find_pinned_utxo, fund_lender, setup_pending_private_offer,
};

/// An acceptance in which the lender pays the principal as `principal` instead of the pinned
/// output of the terms.
fn build_acceptance_with_principal(
    context: &simplex::TestContext,
    setup: &PrivateOfferSetup,
    lender: &Signer,
    principal: PinnedOutput,
) -> anyhow::Result<ConfidentialTransaction> {
    let borrower = context.get_default_signer();
    let parameters = setup.parameters;

    let pending_offer_utxo =
        find_pinned_utxo(&setup.creation_tx, &parameters.pinned.pending_collateral);
    let lender_nft_utxo = find_explicit_utxo(&setup.creation_tx, parameters.lender_nft_asset_id);

    let mut ctx = ConfidentialTransaction::new();

    setup.offer.add_program_input(
        &mut ctx,
        pending_offer_utxo,
        PrivateLendingWitnessBranch::OfferAcceptance.build_witness(),
    );
    ScriptAuth::from_simplex_program(&setup.offer).attach_unlocking(
        &mut ctx,
        lender_nft_utxo,
        ScriptAuthWitnessParams::new(0),
    );

    let active_offer = PrivateLendingOffer::new_active(parameters);
    ctx.add_pinned_output(
        active_offer.get_script_pubkey(),
        parameters.pinned.active_collateral,
        borrower.get_blinding_public_key(),
    );
    ctx.add_pinned_output(
        parameters
            .get_principal_output_asset_auth()
            .get_script_pubkey(),
        principal,
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

/// The honest control of the acceptance failures: with the pinned principal, the transaction that
/// [`build_acceptance_with_principal`] builds goes through, so they fail for their principal only.
#[simplex::test]
fn private_offer_acceptance_succeeds_with_the_pinned_principal(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let lender = context.random_signer();

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let principal = setup.parameters.pinned.principal;

    fund_lender(&context, &lender, principal.asset_id, principal.amount)?;

    let ctx = build_acceptance_with_principal(&context, &setup, &lender, principal)?;
    let acceptance_tx = broadcast(&ctx, &lender)?;

    assert!(principal.matches(&acceptance_tx.output[1]));

    Ok(())
}

#[simplex::test]
fn private_offer_acceptance_fails_with_another_principal_amount(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let lender = context.random_signer();

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let principal = setup.parameters.pinned.principal;

    fund_lender(&context, &lender, principal.asset_id, principal.amount)?;

    // the right blinding factors, one unit less
    let short_principal = principal.with_amount(principal.amount - 1);
    let ctx = build_acceptance_with_principal(&context, &setup, &lender, short_principal)?;

    assert_program_rejects(ctx.finalize(&lender));

    Ok(())
}

#[simplex::test]
fn private_offer_acceptance_fails_with_unpinned_principal_blinders(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let lender = context.random_signer();

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let principal = setup.parameters.pinned.principal;

    fund_lender(&context, &lender, principal.asset_id, principal.amount)?;

    // the right amount under blinding factors the borrower does not know
    let reblinded_principal = PinnedOutput::new_random(principal.asset_id, principal.amount);
    let ctx = build_acceptance_with_principal(&context, &setup, &lender, reblinded_principal)?;

    assert_program_rejects(ctx.finalize(&lender));

    Ok(())
}

/// The honest control of the repayment failures: with the starting debt's hash and the pinned
/// repayment, the transaction that `build_full_repayment_with` builds goes through, so they fail
/// for their repayment or their debt hash only.
#[simplex::test]
fn private_offer_repayment_succeeds_with_the_pinned_repayment(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let repayment = setup.parameters.pinned.repayment;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;
    let loan = Loan::accepted(setup.parameters, &acceptance_tx);

    let ctx = build_full_repayment_with(
        &loan,
        borrower,
        lender.get_blinding_public_key(),
        repayment.commitment_hash(),
        repayment,
    )?;
    let repayment_tx = broadcast(&ctx, borrower)?;

    assert!(repayment.matches(&repayment_tx.output[1]));

    Ok(())
}

#[simplex::test]
fn private_offer_repayment_fails_with_unpinned_repayment_blinders(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let repayment = setup.parameters.pinned.repayment;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;
    let loan = Loan::accepted(setup.parameters, &acceptance_tx);

    // the borrower pays the right amount, but under blinding factors the lender cannot know
    let reblinded_repayment = PinnedOutput::new_random(repayment.asset_id, repayment.amount);
    let ctx = build_full_repayment_with(
        &loan,
        borrower,
        lender.get_blinding_public_key(),
        repayment.commitment_hash(),
        reblinded_repayment,
    )?;

    assert_program_rejects(ctx.finalize(borrower));

    Ok(())
}

/// The witness's debt hash must be the one the loan's storage holds: a loan whose storage holds
/// another debt than the starting one does not repay with the starting debt's hash and output.
#[simplex::test]
fn private_offer_repayment_fails_with_wrong_debt_slot(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let repayment = parameters.pinned.repayment;

    // an active offer whose debt is another commitment than the repayment's
    let wrong_debt_offer = PrivateLendingOffer::new_active_at(
        parameters,
        parameters.pinned.principal.value_commitment(),
        0,
    );

    let mut funding_ctx = ConfidentialTransaction::new();
    funding_ctx.add_pinned_output(
        wrong_debt_offer.get_script_pubkey(),
        parameters.pinned.active_collateral,
        borrower.get_blinding_public_key(),
    );
    let funding_tx = broadcast(&funding_ctx, borrower)?;

    let loan = Loan {
        utxo: find_pinned_utxo(&funding_tx, &wrong_debt_offer.get_collateral()),
        offer: wrong_debt_offer,
        opening: DebtOpening::of(&repayment),
    };
    let ctx = build_full_repayment_with(
        &loan,
        borrower,
        lender.get_blinding_public_key(),
        repayment.commitment_hash(),
        repayment,
    )?;

    assert_program_rejects(ctx.finalize(borrower));

    Ok(())
}
