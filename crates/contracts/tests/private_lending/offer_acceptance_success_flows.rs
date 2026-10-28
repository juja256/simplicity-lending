use super::setup::{
    accept_private_offer, assert_confidential, claim_asset_auth_output, default_offer_parameters,
    find_pinned_utxo, setup_pending_private_offer, unblind_with,
};

#[simplex::test]
fn private_offer_acceptance_pins_collateral_and_principal(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let pinned = setup.parameters.pinned;

    let pending_offer_utxo = find_pinned_utxo(&setup.creation_tx, &pinned.pending_collateral);
    assert_confidential(&setup.creation_tx, &pending_offer_utxo);

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    let active_offer_utxo = find_pinned_utxo(&acceptance_tx, &pinned.active_collateral);
    let principal_utxo = find_pinned_utxo(&acceptance_tx, &pinned.principal);

    assert_eq!(active_offer_utxo.outpoint.vout, 0);
    assert_eq!(principal_utxo.outpoint.vout, 1);
    assert_confidential(&acceptance_tx, &active_offer_utxo);
    assert_confidential(&acceptance_tx, &principal_utxo);

    // the borrower decrypts the principal with its blinding key, as a wallet would
    assert_eq!(
        unblind_with(borrower, &principal_utxo.txout)?,
        pinned.principal.secrets()
    );

    // and can spend it with the borrower NFT
    let principal_asset_auth = setup.parameters.get_principal_output_asset_auth();
    let claim_tx = claim_asset_auth_output(borrower, &principal_asset_auth, principal_utxo)?;

    assert!(
        claim_tx
            .output
            .iter()
            .any(|txout| txout.asset.explicit() == Some(setup.parameters.borrower_nft_asset_id))
    );

    Ok(())
}
