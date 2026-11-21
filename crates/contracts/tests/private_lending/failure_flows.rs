use simplex::signer::Signer;
use simplex::simplicityhl::elements::confidential::ValueBlindingFactor;
use simplex::simplicityhl::elements::{LockTime, Script, Sequence};
use simplex::transaction::{PartialInput, PartialOutput};

use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingWitnessBranch,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::programs::script_auth::{ScriptAuth, ScriptAuthWitnessParams};
use lending_contracts::utils::confidential::{
    ConfidentialTransaction, PinnedOutput, PinnedOutputExt,
};
use private_lending_core::{DebtOpening, debt_hash};

use super::offer_liquidation_success_flows::{build_liquidation_at, set_liquidation_witness};
use super::setup::{
    Loan, PrivateOfferSetup, accept_private_offer, accepted_loan, add_lender_principal,
    assert_program_rejects, broadcast, build_full_repayment_with, default_offer_parameters,
    find_explicit_utxo, find_pinned_utxo, fund_lender, pay_installment,
    setup_pending_private_offer,
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

/// The liquidation's storage check is its only proof that the loan is active. A pending offer's
/// lender NFT unlocks for any transaction that spends the offer, so without the check anyone could
/// take an expired pending offer's collateral.
#[simplex::test]
fn liquidation_fails_on_a_pending_offer(context: simplex::TestContext) -> anyhow::Result<()> {
    let anyone = context.get_default_signer();

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let pending_offer = PrivateLendingOffer::new_pending(parameters);
    let expiry = parameters.loan_expiration_time;

    let pending_offer_utxo =
        find_pinned_utxo(&setup.creation_tx, &parameters.pinned.pending_collateral);
    let lender_nft_utxo = find_explicit_utxo(&setup.creation_tx, parameters.lender_nft_asset_id);

    let mut ctx = ConfidentialTransaction::new();

    // the liquidation witness of the pending offer's debt, the true salt and expiry, locked to it
    pending_offer.add_program_input_from_partial_input(
        &mut ctx,
        PartialInput::new(pending_offer_utxo)
            .with_sequence(Sequence::ENABLE_LOCKTIME_NO_RBF)
            .with_locktime(LockTime::from_height(expiry)?),
        PrivateLendingWitnessBranch::Liquidation {
            debt_hash: pending_offer.get_debt_hash(),
            salt: parameters.expiry_salt,
            expiry,
        }
        .build_witness(),
    );
    // the lender NFT's lock opens with the pending offer at input 0, and the NFT is burned
    ScriptAuth::from_simplex_program(&pending_offer).attach_unlocking(
        &mut ctx,
        lender_nft_utxo,
        ScriptAuthWitnessParams::new(0),
    );
    ctx.add_output(PartialOutput::new(
        Script::new_op_return(b"burn"),
        1,
        parameters.lender_nft_asset_id,
    ));
    ctx.add_output(
        PartialOutput::new(
            anyone.get_confidential_address().script_pubkey(),
            parameters.pinned.pending_collateral.amount,
            parameters.pinned.pending_collateral.asset_id,
        )
        .with_blinding_key(anyone.get_blinding_public_key()),
    );

    assert_program_rejects(ctx.finalize(anyone));

    Ok(())
}

/// The witness's debt hash must be the one the loan's storage holds: after an installment, a
/// liquidation with the starting debt's hash, or another debt's, is refused.
#[simplex::test]
fn liquidation_fails_with_another_debt_hash(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let (setup, lender, loan) = accepted_loan(&context)?;
    let parameters = setup.parameters;
    let (_, loan) = pay_installment(
        &setup,
        &loan,
        borrower,
        DebtOpening {
            amount: 1_000,
            blinder: ValueBlindingFactor::new(&mut rand::thread_rng()),
        },
    )?;
    let expiry = parameters.loan_expiration_time;

    // the control: the debt hash of the loan's storage goes through the program
    build_liquidation_at(&loan, &lender)?.finalize(&lender)?;

    for other_debt_hash in [
        // the starting debt, before the installment
        parameters.pinned.repayment.commitment_hash(),
        // another debt
        debt_hash(
            &parameters.pinned.repayment.asset_commitment(),
            &parameters.pinned.principal.value_commitment(),
        ),
    ] {
        assert_ne!(other_debt_hash, loan.offer.get_debt_hash());
        let mut ctx = build_liquidation_at(&loan, &lender)?;
        set_liquidation_witness(
            &mut ctx,
            PrivateLendingWitnessBranch::Liquidation {
                debt_hash: other_debt_hash,
                salt: parameters.expiry_salt,
                expiry,
            },
            expiry,
        )?;

        assert_program_rejects(ctx.finalize(&lender));
    }

    Ok(())
}
