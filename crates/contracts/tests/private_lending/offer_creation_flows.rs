use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::hashes::Hash;
use simplex::simplicityhl::elements::{AssetId, OutPoint, TxOut, Txid, confidential};

use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingParameters, VerifyError, find_private_offer,
    verify_pending_offer,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::programs::script_auth::ScriptAuth;
use private_lending_core::{
    LendingKey, NewOffer, OfferTerms, OpenedOffer, open_as_borrower, open_as_lender,
};

use super::setup::{
    COLLATERAL_AMOUNT, PRINCIPAL_AMOUNT, PRINCIPAL_INTEREST_RATE, default_offer_parameters,
    setup_pending_private_offer,
};

/// The principal and 10% interest.
const REPAYMENT_AMOUNT: u64 = 11_000;

/// An offer opened by its lender without a chain, from a [`NewOffer`] with made-up NFTs and first
/// input, and the parameters the borrower builds from it.
fn opened_offer_off_chain(network: SimplicityNetwork) -> (OpenedOffer, PrivateLendingParameters) {
    let borrower = LendingKey::from_master_blinding_key(&[1; 32]);
    let lender = LendingKey::from_master_blinding_key(&[2; 32]);
    let asset = |byte| AssetId::from_slice(&[byte; 32]).unwrap();

    let terms = OfferTerms {
        principal_asset: asset(0xaa),
        principal_amount: PRINCIPAL_AMOUNT,
        repayment_amount: REPAYMENT_AMOUNT,
        interest_rate_bps: PRINCIPAL_INTEREST_RATE,
        loan_expiration_time: 1_000,
        borrower_nft: asset(0x44),
        lender_nft: asset(0x55),
    };
    let new_offer = NewOffer::build(
        &borrower,
        &lender.x_only_public_key(),
        &OutPoint::new(Txid::from_byte_array([0xee; 32]), 0),
        PrivateLendingOffer::get_program_id(),
        network.policy_asset(),
        COLLATERAL_AMOUNT,
        terms,
    )
    .unwrap();

    let opened = OpenedOffer {
        signed_terms: new_offer.signed_terms,
        lender: lender.x_only_public_key(),
        collateral: new_offer.pinned.pending_collateral.secrets(),
        secrets: new_offer.secrets,
        pinned: new_offer.pinned,
    };
    let parameters = PrivateLendingParameters {
        borrower_nft_asset_id: terms.borrower_nft,
        lender_nft_asset_id: terms.lender_nft,
        pinned: new_offer.pinned,
        loan_expiration_time: terms.loan_expiration_time,
        network,
    };

    (opened, parameters)
}

/// An output at the pending offer address of `parameters`.
fn offer_output(parameters: PrivateLendingParameters) -> TxOut {
    TxOut {
        script_pubkey: PrivateLendingOffer::new_pending(parameters).get_script_pubkey(),
        ..TxOut::default()
    }
}

#[simplex::test]
fn creation_issues_nfts_in_the_creation_layout(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let creation_tx = &setup.creation_tx;
    let parameters = setup.parameters;
    let nfts = [
        parameters.borrower_nft_asset_id,
        parameters.lender_nft_asset_id,
    ];

    // inputs 0 and 1 issue one borrower NFT and one lender NFT, without reissuance tokens
    for (input, nft) in creation_tx.input[..2].iter().zip(nfts) {
        assert_eq!(input.issuance_ids().0, nft);
        assert_eq!(
            input.asset_issuance.amount,
            confidential::Value::Explicit(1)
        );
        assert_eq!(
            input.asset_issuance.inflation_keys,
            confidential::Value::Null
        );
    }

    // the borrower NFT goes to the borrower, the lender NFT is locked to the offer
    let receivers = [
        borrower.get_address().script_pubkey(),
        ScriptAuth::from_simplex_program(&setup.offer).get_script_pubkey(),
    ];
    for (output, (receiver, nft)) in creation_tx.output[..2]
        .iter()
        .zip(receivers.into_iter().zip(nfts))
    {
        assert_eq!(output.script_pubkey, receiver);
        assert_eq!(output.asset.explicit(), Some(nft));
        assert_eq!(output.value.explicit(), Some(1));
    }

    assert!(creation_tx.output[2].is_null_data());
    assert_eq!(
        creation_tx.output[3].script_pubkey,
        setup.offer.get_script_pubkey()
    );

    Ok(())
}

#[simplex::test]
fn lender_finds_opens_and_verifies_offer(context: simplex::TestContext) -> anyhow::Result<()> {
    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let creation_tx = &setup.creation_tx;

    let (marker, offer_outpoint, offer, first_input) =
        find_private_offer(creation_tx).expect("the creation transaction carries an offer");

    assert_eq!(offer_outpoint, OutPoint::new(creation_tx.txid(), 3));
    assert_eq!(first_input, creation_tx.input[0].previous_output);

    let opened = open_as_lender(&setup.lender_lending_key, &offer, &first_input, &marker)?;
    let parameters = verify_pending_offer(&opened, &offer, *context.get_network())?;

    assert_eq!(
        parameters.build_arguments(),
        setup.parameters.build_arguments()
    );

    Ok(())
}

#[simplex::test]
fn borrower_recovers_offer_from_chain(context: simplex::TestContext) -> anyhow::Result<()> {
    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;

    let (marker, _, offer, first_input) =
        find_private_offer(&setup.creation_tx).expect("the creation transaction carries an offer");

    let recovered = open_as_borrower(&setup.borrower_lending_key, &offer, &first_input, &marker)?;

    assert_eq!(
        recovered.lender,
        setup.lender_lending_key.x_only_public_key()
    );
    assert_eq!(recovered.pinned, setup.parameters.pinned);

    Ok(())
}

#[simplex::test]
fn dishonest_repayment_fails_verification(context: simplex::TestContext) -> anyhow::Result<()> {
    let network = *context.get_network();
    let (opened, parameters) = opened_offer_off_chain(network);

    // the address the terms give passes
    assert!(verify_pending_offer(&opened, &offer_output(parameters), network).is_ok());

    // the borrower pins one unit less of repayment than the terms show
    let mut dishonest = parameters;
    dishonest.pinned.repayment = parameters
        .pinned
        .repayment
        .with_amount(REPAYMENT_AMOUNT - 1);

    assert_eq!(
        verify_pending_offer(&opened, &offer_output(dishonest), network).err(),
        Some(VerifyError::AddressMismatch)
    );

    Ok(())
}

#[simplex::test]
fn invalid_amounts_fail_verification(context: simplex::TestContext) -> anyhow::Result<()> {
    let network = *context.get_network();
    let (opened, parameters) = opened_offer_off_chain(network);
    let offer = offer_output(parameters);

    let mut zero_principal = opened;
    zero_principal.signed_terms.terms.principal_amount = 0;

    assert_eq!(
        verify_pending_offer(&zero_principal, &offer, network).err(),
        Some(VerifyError::InvalidTerms)
    );

    let mut repayment_below_principal = opened;
    repayment_below_principal
        .signed_terms
        .terms
        .repayment_amount = PRINCIPAL_AMOUNT - 1;

    assert_eq!(
        verify_pending_offer(&repayment_below_principal, &offer, network).err(),
        Some(VerifyError::InvalidTerms)
    );

    Ok(())
}
