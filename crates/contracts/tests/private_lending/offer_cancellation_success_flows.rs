use simplex::transaction::PartialOutput;

use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::ConfidentialTransaction;
use private_lending_core::CARRY_SUPPLY;

use super::setup::{
    CARRY_SUPPLY_OUTPUT, broadcast, carry_supply, default_offer_parameters, find_explicit_utxo,
    find_pinned_utxo, setup_pending_private_offer, simplicity_spend,
};

/// The cancellation burns both NFTs and the carry supply, which the borrower NFT unlocks, and
/// returns the collateral.
#[simplex::test]
fn private_offer_cancellation_returns_collateral(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let provider = context.get_default_provider();
    let borrower = context.get_default_signer();

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let carry_lock = parameters.get_principal_output_asset_auth();

    let pending_offer_utxo =
        find_pinned_utxo(&setup.creation_tx, &parameters.pinned.pending_collateral);
    let lender_nft_utxo = find_explicit_utxo(&setup.creation_tx, parameters.lender_nft_asset_id);
    let borrower_nft_utxo = borrower.get_utxos_asset(parameters.borrower_nft_asset_id)?[0].clone();
    let supply = carry_supply(&setup.creation_tx);
    let carry_asset = supply.explicit_asset();

    let mut ctx = ConfidentialTransaction::new();

    setup.offer.attach_cancellation(
        &mut ctx,
        pending_offer_utxo,
        lender_nft_utxo,
        borrower_nft_utxo,
        supply.clone(),
    );

    ctx.add_output(
        PartialOutput::new(
            borrower.get_confidential_address().script_pubkey(),
            parameters.pinned.pending_collateral.amount,
            parameters.pinned.pending_collateral.asset_id,
        )
        .with_blinding_key(borrower.get_blinding_public_key()),
    );

    let cancellation_tx = broadcast(&ctx, borrower)?;
    simplicity_spend("OfferCancellation", &cancellation_tx, 0)?;

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

    // the carry supply (input 3) is burned whole, in the clear: it is the same for every loan
    assert_eq!(cancellation_tx.input[3].previous_output, supply.outpoint);
    assert_eq!(supply.outpoint.vout, CARRY_SUPPLY_OUTPUT as u32);
    let burn = &cancellation_tx.output[2];
    assert!(burn.script_pubkey.is_op_return());
    assert_eq!(
        (burn.asset.explicit(), burn.value.explicit()),
        (Some(carry_asset), Some(CARRY_SUPPLY))
    );
    assert!(
        provider
            .fetch_scripthash_utxos(&carry_lock.get_script_pubkey())?
            .iter()
            .all(|utxo| utxo.outpoint != supply.outpoint)
    );

    Ok(())
}
