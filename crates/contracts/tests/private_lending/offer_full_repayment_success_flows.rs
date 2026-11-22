use private_lending_core::CARRY_SUPPLY;

use super::setup::{
    Loan, accept_private_offer, assert_confidential, broadcast, build_full_repayment, carry_supply,
    claim_asset_auth_output, default_offer_parameters, find_pinned_utxo, open_with_lending_key,
    setup_pending_private_offer, simplicity_spend, unblind_with,
};

/// The input of a full repayment that spends the loan.
const FULL_REPAYMENT_LOAN_INPUT: usize = 1;

#[simplex::test]
fn private_offer_full_repayment_pays_pinned_repayment(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let lender = context.random_signer();

    let mut setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let parameters = setup.parameters;
    let pinned = parameters.pinned;

    let acceptance_tx = accept_private_offer(&context, &mut setup, &lender)?;

    let loan = Loan::accepted(&setup, &acceptance_tx);
    let repayment_tx = broadcast(
        &build_full_repayment(&setup, &loan, borrower, lender.get_blinding_public_key())?,
        borrower,
    )?;
    simplicity_spend("FullRepayment", &repayment_tx, FULL_REPAYMENT_LOAN_INPUT)?;

    let repayment_utxo = find_pinned_utxo(&repayment_tx, &pinned.repayment);

    assert_eq!(repayment_utxo.outpoint.vout, 1);
    assert_confidential(&repayment_tx, &repayment_utxo);

    // principal and interest, all of it to the lender
    assert_eq!(pinned.repayment.amount, 10_000 + 1_000);

    // no protocol fee output: the collateral returns to the borrower right after the repayment
    let collateral_return = &repayment_tx.output[2];
    let collateral_return_secrets = unblind_with(borrower, collateral_return)?;

    assert_eq!(
        collateral_return.script_pubkey,
        borrower.get_address().script_pubkey()
    );
    assert_eq!(
        collateral_return_secrets.asset,
        pinned.active_collateral.asset_id
    );
    assert_eq!(
        collateral_return_secrets.value,
        pinned.active_collateral.amount
    );

    // before any installment the carry is the creation's supply: the borrower NFT (input 0)
    // unlocks it after the principal coin (input 3), and its units burn in a confidential
    // OP_RETURN, which the borrower opens
    let supply = carry_supply(&setup.creation_tx);
    assert_eq!(repayment_tx.input[3].previous_output, supply.outpoint);
    let burn = repayment_tx
        .output
        .iter()
        .find(|txout| txout.script_pubkey.is_op_return() && txout.value.is_confidential())
        .ok_or_else(|| anyhow::anyhow!("the carries are not burned"))?;
    let burned = open_with_lending_key(&setup.borrower_lending_key, burn)?;
    assert_eq!(
        (burned.asset, burned.value),
        (supply.explicit_asset(), CARRY_SUPPLY)
    );

    // the lender decrypts its repayment with its blinding key
    assert_eq!(
        unblind_with(&lender, &repayment_utxo.txout)?,
        pinned.repayment.secrets()
    );

    // and can spend it by burning the lender NFT
    claim_asset_auth_output(
        &lender,
        &parameters.get_repayment_output_asset_auth(),
        repayment_utxo,
    )?;

    assert!(
        lender
            .get_utxos_asset(parameters.lender_nft_asset_id)?
            .is_empty()
    );
    assert!(
        lender
            .get_utxos_asset(pinned.repayment.asset_id)?
            .iter()
            .any(|utxo| utxo.amount() == pinned.repayment.amount)
    );

    Ok(())
}
