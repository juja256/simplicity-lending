use simplex::transaction::{PartialInput, PartialOutput, RequiredSignature};

use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::ConfidentialTransaction;

use super::setup::{
    broadcast, default_offer_parameters, find_explicit_utxo, find_pinned_utxo,
    setup_pending_private_offer,
};

#[simplex::test]
fn private_offer_cancellation_returns_collateral(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let provider = context.get_default_provider();
    let borrower = context.get_default_signer();

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;

    let pending_offer_utxo =
        find_pinned_utxo(&setup.creation_tx, &parameters.pinned.pending_collateral);
    let lender_nft_utxo = find_explicit_utxo(&setup.creation_tx, parameters.lender_nft_asset_id);
    let borrower_nft_utxo = borrower.get_utxos_asset(parameters.borrower_nft_asset_id)?[0].clone();

    let mut ctx = ConfidentialTransaction::new();

    setup
        .offer
        .attach_cancellation(&mut ctx, pending_offer_utxo, lender_nft_utxo);

    ctx.add_input(
        PartialInput::new(borrower_nft_utxo),
        RequiredSignature::NativeEcdsa,
    );
    ctx.add_output(
        PartialOutput::new(
            borrower.get_confidential_address().script_pubkey(),
            parameters.pinned.pending_collateral.amount,
            parameters.pinned.pending_collateral.asset_id,
        )
        .with_blinding_key(borrower.get_blinding_public_key()),
    );

    broadcast(&ctx, borrower)?;

    assert!(
        provider
            .fetch_scripthash_utxos(&setup.offer.get_script_pubkey())?
            .is_empty()
    );
    assert!(
        borrower
            .get_utxos_asset(parameters.borrower_nft_asset_id)?
            .is_empty()
    );

    Ok(())
}
