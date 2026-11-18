use simplex::signer::Signer;
use simplex::simplicityhl::elements::{LockTime, Script, Sequence, Transaction};
use simplex::transaction::{PartialInput, PartialOutput, RequiredSignature};

use lending_contracts::programs::private_lending::PrivateLendingWitnessBranch;
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::ConfidentialTransaction;

use super::setup::{
    PrivateOfferSetup, accept_private_offer, broadcast, default_offer_parameters, find_pinned_utxo,
    get_active_offer, setup_pending_private_offer,
};

/// The liquidation transaction, before finalization.
pub(super) fn build_liquidation(
    setup: &PrivateOfferSetup,
    acceptance_tx: &Transaction,
    lender: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = setup.parameters;

    let active_offer_utxo = find_pinned_utxo(acceptance_tx, &parameters.pinned.active_collateral);

    let mut ctx = ConfidentialTransaction::new();

    setup.offer.attach_liquidation(&mut ctx, active_offer_utxo);

    add_lender_nft_and_collateral(&mut ctx, setup, lender)?;

    Ok(ctx)
}

/// A liquidation built by hand, before finalization: the offer input takes the liquidation
/// witness of `salt` and `expiry` and the transaction is locked to `lock_time`, where
/// `attach_liquidation` uses the offer's salt and expiry for all three.
pub(super) fn build_liquidation_with(
    setup: &PrivateOfferSetup,
    acceptance_tx: &Transaction,
    lender: &Signer,
    salt: [u8; 32],
    expiry: u32,
    lock_time: u32,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = setup.parameters;

    let active_offer_input = PartialInput::new(find_pinned_utxo(
        acceptance_tx,
        &parameters.pinned.active_collateral,
    ))
    .with_sequence(Sequence::ENABLE_LOCKTIME_NO_RBF)
    .with_locktime(LockTime::from_height(lock_time)?);

    let mut ctx = ConfidentialTransaction::new();

    setup.offer.add_program_input_from_partial_input(
        &mut ctx,
        active_offer_input,
        PrivateLendingWitnessBranch::Liquidation { salt, expiry }.build_witness(),
    );
    ctx.add_output(PartialOutput::new(
        Script::new_op_return(b"burn"),
        1,
        parameters.lender_nft_asset_id,
    ));

    add_lender_nft_and_collateral(&mut ctx, setup, lender)?;

    Ok(ctx)
}

/// The rest of a liquidation after the offer input and the lender NFT burn: the lender NFT
/// (input 1) and the collateral to the lender.
fn add_lender_nft_and_collateral(
    ctx: &mut ConfidentialTransaction,
    setup: &PrivateOfferSetup,
    lender: &Signer,
) -> anyhow::Result<()> {
    let parameters = setup.parameters;

    let lender_nft_utxo = lender.get_utxos_asset(parameters.lender_nft_asset_id)?[0].clone();

    ctx.add_input(
        PartialInput::new(lender_nft_utxo),
        RequiredSignature::NativeEcdsa,
    );
    ctx.add_output(
        PartialOutput::new(
            lender.get_confidential_address().script_pubkey(),
            parameters.pinned.active_collateral.amount,
            parameters.pinned.active_collateral.asset_id,
        )
        .with_blinding_key(lender.get_blinding_public_key()),
    );

    Ok(())
}

#[simplex::test]
fn private_offer_liquidation_succeeds_after_expiration_time(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let provider = context.get_default_provider();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    setup.offer = get_active_offer(&setup);

    let expiration_height = u64::from(parameters.loan_expiration_time) + 1;
    context
        .get_network_utils()
        .mine_until_height(expiration_height)?;

    broadcast(
        &build_liquidation(&setup, &acceptance_tx, &lender)?,
        &lender,
    )?;

    assert!(
        lender
            .get_utxos_asset(parameters.lender_nft_asset_id)?
            .is_empty()
    );
    assert!(
        lender
            .get_utxos_asset(parameters.pinned.active_collateral.asset_id)?
            .iter()
            .any(|utxo| utxo.amount() == parameters.pinned.active_collateral.amount)
    );
    assert!(provider.fetch_tip_height()? >= parameters.loan_expiration_time);

    Ok(())
}
