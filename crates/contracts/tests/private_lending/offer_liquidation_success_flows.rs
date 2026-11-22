use simplex::signer::Signer;
use simplex::simplicityhl::elements::{LockTime, Transaction};
use simplex::transaction::{PartialInput, RequiredSignature, UTXO};

use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingWitnessBranch,
};
use lending_contracts::utils::confidential::{ConfidentialTransaction, PinnedOutput};
use private_lending_core::OfferSecrets;

use super::setup::{
    Loan, PrivateOfferSetup, accept_private_offer, broadcast, collateral_to,
    default_offer_parameters, get_active_offer, lender_view, mine_until,
    setup_pending_private_offer, simplicity_spend,
};

/// The input of a liquidation that spends the loan.
const LIQUIDATION_LOAN_INPUT: usize = 0;

/// The liquidation of `loan`, before finalization: [`build_liquidation_of`] its offer and output,
/// as the lender reads them from the chain, with the offer's secrets as the lender derives them.
pub(super) fn build_liquidation_at(
    setup: &PrivateOfferSetup,
    loan: &Loan,
    lender: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    let (_, secrets) = lender_view(setup)?;
    let loan_utxo = UTXO {
        secrets: None,
        ..loan.utxo.clone()
    };

    Ok(build_liquidation_of(&loan.offer, loan_utxo, lender, &secrets)?.0)
}

/// The liquidation of the loan `offer` held at `loan_utxo`, before finalization, built with
/// `attach_liquidation`: the lender NFT (input 1) is burned and the collateral goes to the lender
/// (output 1). The lender builds it from `secrets`, the chain and what it computes alone: the
/// collateral's opening comes from the search, with no opening of the debt or of an installment.
/// Returns the transaction and the collateral it takes.
pub(super) fn build_liquidation_of(
    offer: &PrivateLendingOffer,
    loan_utxo: UTXO,
    lender: &Signer,
    secrets: &OfferSecrets,
) -> anyhow::Result<(ConfidentialTransaction, PinnedOutput)> {
    let parameters = *offer.get_parameters();

    let mut ctx = ConfidentialTransaction::new();

    let collateral = offer.attach_liquidation(&mut ctx, loan_utxo, secrets);

    let lender_nft_utxo = lender.get_utxos_asset(parameters.lender_nft_asset_id)?[0].clone();
    ctx.add_input(
        PartialInput::new(lender_nft_utxo),
        RequiredSignature::NativeEcdsa,
    );
    ctx.add_output(collateral_to(lender, &parameters, collateral.amount));

    Ok((ctx, collateral))
}

/// The liquidation of the loan that `acceptance_tx` starts, before finalization.
pub(super) fn build_liquidation(
    setup: &PrivateOfferSetup,
    acceptance_tx: &Transaction,
    lender: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    build_liquidation_at(setup, &Loan::accepted(setup, acceptance_tx), lender)
}

/// [`build_liquidation`] with the liquidation witness of `salt` and `expiry`, locked to
/// `lock_time`, where `attach_liquidation` uses the offer's salt and expiry for all three.
pub(super) fn build_liquidation_with(
    setup: &PrivateOfferSetup,
    acceptance_tx: &Transaction,
    lender: &Signer,
    salt: [u8; 32],
    expiry: u32,
    lock_time: u32,
) -> anyhow::Result<ConfidentialTransaction> {
    let loan = Loan::accepted(setup, acceptance_tx);
    let mut ctx = build_liquidation_at(setup, &loan, lender)?;

    set_liquidation_witness(
        &mut ctx,
        PrivateLendingWitnessBranch::Liquidation {
            debt_hash: loan.offer.get_debt_hash(),
            salt,
            expiry,
        },
        lock_time,
    )?;

    Ok(ctx)
}

/// Gives the loan input (input 0) of the liquidation `ctx` the witness of `branch` and locks it
/// to `lock_time`.
pub(super) fn set_liquidation_witness(
    ctx: &mut ConfidentialTransaction,
    branch: PrivateLendingWitnessBranch,
    lock_time: u32,
) -> anyhow::Result<()> {
    let loan_input = &mut ctx.inputs_mut()[LIQUIDATION_LOAN_INPUT];
    loan_input.partial_input.locktime = LockTime::from_height(lock_time)?;
    loan_input
        .program_input
        .as_mut()
        .expect("the loan input runs the program")
        .witness = branch.build_witness();

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

    mine_until(&context, parameters.loan_expiration_time + 1)?;

    let liquidation_tx = broadcast(
        &build_liquidation(&setup, &acceptance_tx, &lender)?,
        &lender,
    )?;
    simplicity_spend("Liquidation", &liquidation_tx, LIQUIDATION_LOAN_INPUT)?;

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
