use simplex::signer::Signer;
use simplex::simplicityhl::elements::{Script, Transaction};
use simplex::transaction::{PartialInput, PartialOutput, RequiredSignature};

use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingWitnessBranch,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::programs::script_auth::{ScriptAuth, ScriptAuthWitnessParams};
use lending_contracts::utils::confidential::{
    ConfidentialTransaction, ConfidentialTransactionError, PinnedOutput, PinnedOutputExt,
};

use super::offer_liquidation_success_flows::build_liquidation;
use super::setup::{
    PrivateOfferSetup, accept_private_offer, add_lender_principal, broadcast, build_full_repayment,
    default_offer_parameters, find_explicit_utxo, find_pinned_utxo, fund_lender, get_active_offer,
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

/// A full repayment of the active offer accepted in `acceptance_tx`, built by hand: the offer input
/// takes the witness of `branch` and the lender is paid `repayment`, where `attach_full_repayment`
/// uses `FullRepayment` and the pinned repayment.
fn build_repayment_with(
    context: &simplex::TestContext,
    setup: &PrivateOfferSetup,
    acceptance_tx: &Transaction,
    lender: &Signer,
    branch: PrivateLendingWitnessBranch,
    repayment: PinnedOutput,
) -> anyhow::Result<ConfidentialTransaction> {
    let borrower = context.get_default_signer();
    let parameters = setup.parameters;
    let active_offer = get_active_offer(setup);

    let active_offer_utxo = find_pinned_utxo(acceptance_tx, &parameters.pinned.active_collateral);
    let borrower_nft_utxo = borrower.get_utxos_asset(parameters.borrower_nft_asset_id)?[0].clone();
    let borrower_principal_utxo = borrower.get_utxos_filter(
        &|utxo| {
            utxo.explicit_asset() == repayment.asset_id && utxo.explicit_amount() > repayment.amount
        },
        &|_| true,
    )?[0]
        .clone();
    let principal_utxo_amount = borrower_principal_utxo.explicit_amount();

    let mut ctx = ConfidentialTransaction::new();

    ctx.add_input(
        PartialInput::new(borrower_nft_utxo),
        RequiredSignature::NativeEcdsa,
    );
    ctx.add_output(PartialOutput::new(
        Script::new_op_return(b"burn"),
        1,
        parameters.borrower_nft_asset_id,
    ));
    active_offer.add_program_input(&mut ctx, active_offer_utxo, branch.build_witness());
    ctx.add_pinned_output(
        parameters
            .get_repayment_output_asset_auth()
            .get_script_pubkey(),
        repayment,
        lender.get_blinding_public_key(),
    );
    ctx.add_input(
        PartialInput::new(borrower_principal_utxo),
        RequiredSignature::NativeEcdsa,
    );
    ctx.add_output(
        PartialOutput::new(
            borrower.get_confidential_address().script_pubkey(),
            parameters.pinned.active_collateral.amount,
            parameters.pinned.active_collateral.asset_id,
        )
        .with_blinding_key(borrower.get_blinding_public_key()),
    );
    ctx.add_output(PartialOutput::new(
        borrower.get_address().script_pubkey(),
        principal_utxo_amount - repayment.amount,
        repayment.asset_id,
    ));

    Ok(ctx)
}

fn assert_program_rejects(result: Result<impl Sized, ConfidentialTransactionError>) {
    match result {
        Err(ConfidentialTransactionError::Program(_)) => {}
        Err(error) => panic!("expected the program to reject the transaction, got: {error}"),
        Ok(_) => panic!("expected the program to reject the transaction"),
    }
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

#[simplex::test]
fn private_offer_repayment_fails_with_unpinned_repayment_blinders(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let repayment = setup.parameters.pinned.repayment;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    // the borrower pays the right amount, but under blinding factors the lender cannot know
    let reblinded_repayment = PinnedOutput::new_random(repayment.asset_id, repayment.amount);
    let ctx = build_repayment_with(
        &context,
        &setup,
        &acceptance_tx,
        &lender,
        PrivateLendingWitnessBranch::FullRepayment,
        reblinded_repayment,
    )?;

    assert_program_rejects(ctx.finalize(borrower));

    Ok(())
}

#[simplex::test]
fn private_offer_partial_repayment_branch_fails(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let repayment = setup.parameters.pinned.repayment;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    // a valid full repayment, spent through the reserved partial repayment branch
    let ctx = build_repayment_with(
        &context,
        &setup,
        &acceptance_tx,
        &lender,
        PrivateLendingWitnessBranch::PartialRepayment,
        repayment,
    )?;

    assert_program_rejects(ctx.finalize(borrower));

    Ok(())
}

#[simplex::test]
fn private_offer_repayment_fails_with_wrong_debt_slot(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;

    // an active offer whose debt slot holds another commitment hash than the repayment's
    let wrong_debt_offer = PrivateLendingOffer::new_with_storage(
        parameters,
        true,
        parameters.pinned.principal.commitment_hash(),
    );

    let mut funding_ctx = ConfidentialTransaction::new();
    funding_ctx.add_pinned_output(
        wrong_debt_offer.get_script_pubkey(),
        parameters.pinned.active_collateral,
        borrower.get_blinding_public_key(),
    );
    let funding_tx = broadcast(&funding_ctx, borrower)?;

    let wrong_debt_offer_utxo = find_pinned_utxo(&funding_tx, &parameters.pinned.active_collateral);
    let ctx = build_full_repayment(&wrong_debt_offer, wrong_debt_offer_utxo, borrower, &lender)?;

    assert_program_rejects(ctx.finalize(borrower));

    Ok(())
}

#[simplex::test]
fn private_offer_liquidation_fails_before_expiration_time(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let provider = context.get_default_provider();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    setup.offer = get_active_offer(&setup);

    assert!(provider.fetch_tip_height()? < parameters.loan_expiration_time);

    // the program accepts the lock time, but the network refuses a transaction not final yet
    let result = build_liquidation(&setup, &acceptance_tx, &lender)?.broadcast(&lender);

    assert!(matches!(
        result,
        Err(ConfidentialTransactionError::Provider(_))
    ));
    assert!(
        !provider
            .fetch_scripthash_utxos(&setup.offer.get_script_pubkey())?
            .is_empty()
    );

    Ok(())
}
