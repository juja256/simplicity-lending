use simplex::signer::Signer;
use simplex::simplicityhl::elements::secp256k1_zkp::Secp256k1;
use simplex::simplicityhl::elements::{AssetId, OutPoint, Transaction, TxOutSecrets};
use simplex::transaction::{
    FinalTransaction, PartialInput, PartialOutput, RequiredSignature, UTXO,
};

use lending_contracts::programs::asset_auth::{AssetAuth, AssetAuthWitnessParams};
use lending_contracts::programs::lending::OfferParameters;
use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingParameters, PrivateLendingTerms,
};
use lending_contracts::utils::confidential::{ConfidentialTransaction, PinnedOutput};

use lending_contracts::utils::confidential::wait_for_confirmation;
use lending_contracts::utils::get_random_seed;
use simplex::transaction::partial_input::IssuanceInput;

use super::common::wallet::get_split_utxo_ft;

pub(super) const COLLATERAL_AMOUNT: u64 = 3_000;
pub(super) const PRINCIPAL_AMOUNT: u64 = 10_000;
pub(super) const PRINCIPAL_INTEREST_RATE: u16 = 1_000; // 10%
pub(super) const TOTAL_PRINCIPAL_AMOUNT: u64 = 200_000;

pub(super) struct PrivateOfferSetup {
    pub offer: PrivateLendingOffer,
    pub parameters: PrivateLendingParameters,
    pub creation_tx: Transaction,
}

pub(super) fn default_offer_parameters(
    context: &simplex::TestContext,
) -> anyhow::Result<OfferParameters> {
    let current_height = context.get_default_provider().fetch_tip_height()?;

    Ok(OfferParameters {
        collateral_amount: COLLATERAL_AMOUNT,
        principal_amount: PRINCIPAL_AMOUNT,
        loan_expiration_time: current_height + 60,
        principal_interest_rate: PRINCIPAL_INTEREST_RATE,
    })
}

/// Broadcasts `ctx` signed by `signer` and waits until `signer`'s wallet lists the
/// confidential change of the transaction, so that the next transaction can spend it (the
/// indexer may lag behind the confirmation).
pub(super) fn broadcast(
    ctx: &ConfidentialTransaction,
    signer: &Signer,
) -> anyhow::Result<Transaction> {
    let tx = ctx.broadcast(signer)?;

    // the finalizer's change precedes the fee, the last output
    let change_vout = (tx.output.len() - 2) as u32;

    for _ in 0..100 {
        let listed = signer.get_utxos_txid(tx.txid())?;
        if listed.iter().any(|utxo| utxo.outpoint.vout == change_vout) {
            return Ok(tx);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    anyhow::bail!("the wallet does not list its change from {}", tx.txid())
}

/// The output of `tx` that carries `pinned`, as a spendable UTXO.
pub(super) fn find_pinned_utxo(tx: &Transaction, pinned: &PinnedOutput) -> UTXO {
    let (vout, txout) = tx
        .output
        .iter()
        .enumerate()
        .find(|(_, txout)| pinned.matches(txout))
        .expect("The transaction has no output with this pinned commitment");

    pinned.to_utxo(OutPoint::new(tx.txid(), vout as u32), txout.clone())
}

/// The explicit output of `tx` that carries `asset_id`.
pub(super) fn find_explicit_utxo(tx: &Transaction, asset_id: AssetId) -> UTXO {
    let (vout, txout) = tx
        .output
        .iter()
        .enumerate()
        .find(|(_, txout)| txout.asset.explicit() == Some(asset_id))
        .expect("The transaction has no explicit output of this asset");

    UTXO {
        outpoint: OutPoint::new(tx.txid(), vout as u32),
        txout: txout.clone(),
        secrets: None,
    }
}

/// What `signer` recovers by rewinding the range proof of `utxo` with its blinding key.
pub(super) fn unblind_with(signer: &Signer, utxo: &UTXO) -> anyhow::Result<TxOutSecrets> {
    let secp = Secp256k1::new();

    Ok(utxo
        .txout
        .unblind(&secp, signer.get_blinding_private_key().inner)?)
}

pub(super) fn fund_lender(
    context: &simplex::TestContext,
    lender: &Signer,
    principal_asset_id: AssetId,
    principal_to_send: u64,
) -> anyhow::Result<()> {
    let signer = context.get_default_signer();

    let principal_utxo = signer.get_utxos_asset(principal_asset_id)?[0].clone();
    // the largest explicit coin: the lender pays the fees of several confidential transactions
    let policy_asset = context.get_network().policy_asset();
    let policy_utxo = signer
        .get_utxos_filter(&|utxo| utxo.explicit_asset() == policy_asset, &|_| false)?
        .into_iter()
        .max_by_key(UTXO::explicit_amount)
        .expect("the default signer has an explicit policy coin");

    let principal_utxo_amount = principal_utxo.explicit_amount();
    let policy_amount_to_send = policy_utxo.explicit_amount() / 2;

    let mut ft = FinalTransaction::new();

    ft.add_input(
        PartialInput::new(principal_utxo),
        RequiredSignature::NativeEcdsa,
    );
    ft.add_input(
        PartialInput::new(policy_utxo),
        RequiredSignature::NativeEcdsa,
    );

    ft.add_output(PartialOutput::new(
        lender.get_address().script_pubkey(),
        principal_to_send,
        principal_asset_id,
    ));
    ft.add_output(PartialOutput::new(
        lender.get_address().script_pubkey(),
        policy_amount_to_send,
        context.get_network().policy_asset(),
    ));

    if principal_utxo_amount > principal_to_send {
        ft.add_output(PartialOutput::new(
            signer.get_address().script_pubkey(),
            principal_utxo_amount - principal_to_send,
            principal_asset_id,
        ));
    }

    broadcast_explicit(context, &ft)?;

    Ok(())
}

/// Broadcasts `ft` from the default signer and waits for it to confirm. The common helpers wait
/// once, a short poll that eight parallel tests can outlast.
fn broadcast_explicit(context: &simplex::TestContext, ft: &FinalTransaction) -> anyhow::Result<()> {
    let txid = context.get_default_signer().broadcast(ft)?.txid();

    Ok(wait_for_confirmation(
        context.get_default_provider(),
        &txid,
    )?)
}

/// Splits the default signer's first coin: the fresh wallet holds a single coin, and an issuance
/// spends one and pays its fee with another.
fn split_first_signer_utxo(
    context: &simplex::TestContext,
    amounts: Vec<u64>,
) -> anyhow::Result<()> {
    let signer = context.get_default_signer();
    let signer_utxo = signer
        .get_utxos()?
        .first()
        .cloned()
        .expect("Signer does not have any utxos");

    let ft = get_split_utxo_ft(signer_utxo, amounts, signer, *context.get_network());

    broadcast_explicit(context, &ft)
}

/// Issues `asset_amount` of a new asset to the default signer.
fn issue_asset(context: &simplex::TestContext, asset_amount: u64) -> anyhow::Result<AssetId> {
    let signer = context.get_default_signer();
    let first_utxo = signer.get_utxos_asset(context.get_network().policy_asset())?[0].clone();

    let mut ft = FinalTransaction::new();

    let issuance_details = ft.add_issuance_input(
        PartialInput::new(first_utxo.clone()),
        IssuanceInput::new_issuance(asset_amount, 0, get_random_seed()),
        RequiredSignature::NativeEcdsa,
    );

    let signer_script_pubkey = signer.get_address().script_pubkey();

    ft.add_output(PartialOutput::new(
        signer_script_pubkey.clone(),
        asset_amount,
        issuance_details.asset_id,
    ));
    ft.add_output(PartialOutput::new(
        signer_script_pubkey,
        first_utxo.explicit_amount(),
        first_utxo.explicit_asset(),
    ));

    broadcast_explicit(context, &ft)?;

    Ok(issuance_details.asset_id)
}

/// The borrower (the default signer) issues the NFTs and the principal asset (it also holds the
/// protocol fee keeper asset), fixes the terms and creates the pending offer.
pub(super) fn setup_pending_private_offer(
    context: &simplex::TestContext,
    offer_parameters: OfferParameters,
) -> anyhow::Result<PrivateOfferSetup> {
    let borrower = context.get_default_signer();

    split_first_signer_utxo(context, vec![5000, 10000])?;

    let protocol_fee_keeper_asset_id = issue_asset(context, 1)?;
    let principal_asset_id = issue_asset(context, TOTAL_PRINCIPAL_AMOUNT)?;
    let borrower_nft_asset_id = issue_asset(context, 1)?;
    let lender_nft_asset_id = issue_asset(context, 1)?;

    let terms = PrivateLendingTerms::new(
        context.get_network().policy_asset(),
        principal_asset_id,
        offer_parameters,
    );

    let parameters = PrivateLendingParameters {
        borrower_nft_asset_id,
        lender_nft_asset_id,
        protocol_fee_keeper_asset_id,
        terms,
        network: *context.get_network(),
    };

    let offer = PrivateLendingOffer::new_pending(parameters);

    let mut ctx = ConfidentialTransaction::new();

    let lender_nft_utxo = borrower.get_utxos_asset(lender_nft_asset_id)?[0].clone();
    ctx.add_input(
        PartialInput::new(lender_nft_utxo),
        RequiredSignature::NativeEcdsa,
    );

    // the collateral comes from the finalizer's coin selection
    offer.attach_creation(&mut ctx, borrower.get_blinding_public_key());

    let creation_tx = broadcast(&ctx, borrower)?;

    Ok(PrivateOfferSetup {
        offer,
        parameters,
        creation_tx,
    })
}

/// The acceptance transaction, before finalization (the lender's view of the terms).
pub(super) fn build_acceptance(
    context: &simplex::TestContext,
    setup: &mut PrivateOfferSetup,
    lender: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    let borrower = context.get_default_signer();
    let parameters = setup.parameters;

    let pending_offer_utxo =
        find_pinned_utxo(&setup.creation_tx, &parameters.terms.pending_collateral);
    let lender_nft_utxo = find_explicit_utxo(&setup.creation_tx, parameters.lender_nft_asset_id);

    let mut ctx = ConfidentialTransaction::new();

    setup.offer.attach_acceptance(
        &mut ctx,
        pending_offer_utxo,
        lender_nft_utxo,
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

pub(super) fn add_lender_principal(
    ctx: &mut ConfidentialTransaction,
    lender: &Signer,
    parameters: PrivateLendingParameters,
) -> anyhow::Result<()> {
    let principal_amount = parameters.terms.principal.amount;
    let lender_principal_utxo = lender.get_utxos_filter(
        &|utxo| {
            utxo.explicit_asset() == parameters.terms.principal.asset_id
                && utxo.explicit_amount() >= principal_amount
        },
        &|_| true,
    )?[0]
        .clone();
    let principal_utxo_amount = lender_principal_utxo.explicit_amount();

    ctx.add_input(
        PartialInput::new(lender_principal_utxo),
        RequiredSignature::NativeEcdsa,
    );

    if principal_utxo_amount > principal_amount {
        ctx.add_output(
            PartialOutput::new(
                lender.get_confidential_address().script_pubkey(),
                principal_utxo_amount - principal_amount,
                parameters.terms.principal.asset_id,
            )
            .with_blinding_key(lender.get_blinding_public_key()),
        );
    }

    Ok(())
}

/// Funds a fresh lender and accepts the pending offer; returns the acceptance transaction.
pub(super) fn accept_private_offer(
    context: &simplex::TestContext,
    setup: &mut PrivateOfferSetup,
    lender: &Signer,
) -> anyhow::Result<Transaction> {
    fund_lender(
        context,
        lender,
        setup.parameters.terms.principal.asset_id,
        setup.parameters.terms.principal.amount,
    )?;

    let ctx = build_acceptance(context, setup, lender)?;

    broadcast(&ctx, lender)
}

/// The full repayment transaction, before finalization: the borrower repays from `principal_utxo`
/// and takes the collateral back.
pub(super) fn build_full_repayment(
    setup: &PrivateOfferSetup,
    acceptance_tx: &Transaction,
    borrower: &Signer,
    lender: &Signer,
) -> anyhow::Result<ConfidentialTransaction> {
    let parameters = setup.parameters;
    let total_amount_to_repay = parameters.terms.get_total_amount_to_repay();

    let active_offer_utxo = find_pinned_utxo(acceptance_tx, &parameters.terms.active_collateral);
    let borrower_nft_utxo = borrower.get_utxos_asset(parameters.borrower_nft_asset_id)?[0].clone();
    let borrower_principal_utxo = borrower.get_utxos_filter(
        &|utxo| {
            utxo.explicit_asset() == parameters.terms.principal.asset_id
                && utxo.explicit_amount() >= total_amount_to_repay
        },
        &|_| true,
    )?[0]
        .clone();
    let principal_utxo_amount = borrower_principal_utxo.explicit_amount();

    let mut ctx = ConfidentialTransaction::new();

    setup.offer.attach_full_repayment(
        &mut ctx,
        borrower_nft_utxo,
        active_offer_utxo,
        lender.get_blinding_public_key(),
        // the protocol fee keeper is the default signer, here the borrower
        borrower.get_blinding_public_key(),
    );

    ctx.add_input(
        PartialInput::new(borrower_principal_utxo),
        RequiredSignature::NativeEcdsa,
    );

    ctx.add_output(
        PartialOutput::new(
            borrower.get_confidential_address().script_pubkey(),
            parameters.terms.active_collateral.amount,
            parameters.terms.active_collateral.asset_id,
        )
        .with_blinding_key(borrower.get_blinding_public_key()),
    );

    if principal_utxo_amount > total_amount_to_repay {
        ctx.add_output(
            PartialOutput::new(
                borrower.get_confidential_address().script_pubkey(),
                principal_utxo_amount - total_amount_to_repay,
                parameters.terms.principal.asset_id,
            )
            .with_blinding_key(borrower.get_blinding_public_key()),
        );
    }

    Ok(ctx)
}

/// Spends the asset_auth output `locked_utxo` with `keeper`'s auth asset (input 1, output 0) and
/// sends the unlocked amount to `keeper`. Returns the claim transaction.
pub(super) fn claim_asset_auth_output(
    keeper: &Signer,
    asset_auth: &AssetAuth,
    locked_utxo: UTXO,
) -> anyhow::Result<Transaction> {
    let auth_parameters = *asset_auth.get_parameters();
    let secrets = locked_utxo.secrets.expect("a pinned output");

    let auth_asset_utxo = keeper.get_utxos_asset(auth_parameters.asset_id)?[0].clone();

    let mut ctx = ConfidentialTransaction::new();

    asset_auth.attach_unlocking(&mut ctx, locked_utxo, AssetAuthWitnessParams::new(1, 0));

    ctx.add_input(
        PartialInput::new(auth_asset_utxo),
        RequiredSignature::NativeEcdsa,
    );

    let auth_asset_destination = if auth_parameters.with_asset_burn {
        simplex::simplicityhl::elements::Script::new_op_return(b"burn")
    } else {
        keeper.get_address().script_pubkey()
    };
    ctx.add_output(PartialOutput::new(
        auth_asset_destination,
        auth_parameters.asset_amount,
        auth_parameters.asset_id,
    ));

    ctx.add_output(
        PartialOutput::new(
            keeper.get_confidential_address().script_pubkey(),
            secrets.value,
            secrets.asset,
        )
        .with_blinding_key(keeper.get_blinding_public_key()),
    );

    broadcast(&ctx, keeper)
}

pub(super) fn get_active_offer(setup: &PrivateOfferSetup) -> PrivateLendingOffer {
    PrivateLendingOffer::new_active(setup.parameters)
}

pub(super) fn assert_confidential(tx: &Transaction, utxo: &UTXO) {
    let txout = &tx.output[utxo.outpoint.vout as usize];

    assert!(txout.asset.is_confidential(), "the asset is visible");
    assert!(txout.value.is_confidential(), "the amount is visible");
}
