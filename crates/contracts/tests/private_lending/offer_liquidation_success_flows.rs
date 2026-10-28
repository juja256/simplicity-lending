use simplex::signer::Signer;
use simplex::transaction::{PartialInput, PartialOutput, RequiredSignature};

use lending_contracts::utils::confidential::ConfidentialTransaction;

use super::setup::{
    PrivateOfferSetup, accept_private_offer, broadcast, default_offer_parameters, find_pinned_utxo,
    get_active_offer, setup_pending_private_offer,
};

/// The liquidation transaction, before finalization.
pub(super) fn build_liquidation(
    setup: &PrivateOfferSetup,
    acceptance_tx: &simplex::simplicityhl::elements::Transaction,
    lender: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = setup.parameters;

    let active_offer_utxo = find_pinned_utxo(acceptance_tx, &parameters.pinned.active_collateral);
    let lender_nft_utxo = lender.get_utxos_asset(parameters.lender_nft_asset_id)?[0].clone();

    let mut ctx = ConfidentialTransaction::new();

    setup.offer.attach_liquidation(&mut ctx, active_offer_utxo);

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

    Ok(ctx)
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
