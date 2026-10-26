use super::setup::{
    accept_private_offer, assert_confidential, broadcast, build_full_repayment,
    claim_asset_auth_output, default_offer_parameters, find_pinned_utxo, get_active_offer,
    setup_pending_private_offer, unblind_with,
};

#[simplex::test]
fn private_offer_full_repayment_pays_pinned_outputs(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let terms = parameters.terms;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    setup.offer = get_active_offer(&setup);

    let repayment_tx = broadcast(
        &build_full_repayment(&setup, &acceptance_tx, borrower, &lender)?,
        borrower,
    )?;

    let repayment_utxo = find_pinned_utxo(&repayment_tx, &terms.repayment);
    let protocol_fee_utxo = find_pinned_utxo(&repayment_tx, &terms.protocol_fee);

    assert_eq!(repayment_utxo.outpoint.vout, 1);
    assert_eq!(protocol_fee_utxo.outpoint.vout, 2);
    assert_confidential(&repayment_tx, &repayment_utxo);
    assert_confidential(&repayment_tx, &protocol_fee_utxo);

    // principal and interest, minus the protocol's 10% of the interest
    assert_eq!(terms.repayment.amount, 10_900);
    assert_eq!(terms.protocol_fee.amount, 100);

    // the lender decrypts its repayment with its blinding key, and the fee keeper its fee
    assert_eq!(
        unblind_with(&lender, &repayment_utxo)?,
        terms.repayment.secrets()
    );
    assert_eq!(
        unblind_with(borrower, &protocol_fee_utxo)?,
        terms.protocol_fee.secrets()
    );

    // both can spend what they were paid
    claim_asset_auth_output(
        &lender,
        &parameters.get_repayment_output_asset_auth(),
        repayment_utxo,
    )?;
    claim_asset_auth_output(
        borrower,
        &parameters.get_protocol_fee_output_asset_auth(),
        protocol_fee_utxo,
    )?;

    assert!(
        lender
            .get_utxos_asset(parameters.lender_nft_asset_id)?
            .is_empty()
    );
    assert!(
        lender
            .get_utxos_asset(terms.repayment.asset_id)?
            .iter()
            .any(|utxo| utxo.amount() == terms.repayment.amount)
    );

    Ok(())
}
