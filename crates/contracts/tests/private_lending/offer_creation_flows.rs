use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::hashes::{Hash, sha256};
use simplex::simplicityhl::elements::secp256k1_zkp::{Tweak, ZERO_TWEAK};
use simplex::simplicityhl::elements::{
    AssetId, AssetIssuance, ContractHash, LockTime, OutPoint, Transaction, TxIn, TxOut, Txid,
    confidential,
};

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
/// The contract hash of the lender NFT issuance in [`offer_off_chain`].
const LENDER_NFT_CONTRACT_HASH: [u8; 32] = [0x11; 32];

/// The coin that issues the lender NFT in [`offer_off_chain`], its input 1.
fn lender_nft_coin() -> OutPoint {
    OutPoint::new(Txid::from_byte_array([0xee; 32]), 1)
}

/// The entropy of the lender NFT issued in [`offer_off_chain`].
fn lender_nft_entropy() -> sha256::Midstate {
    AssetId::generate_asset_entropy(
        lender_nft_coin(),
        ContractHash::from_byte_array(LENDER_NFT_CONTRACT_HASH),
    )
}

/// An offer made up without a chain.
struct OffChainOffer {
    /// Input 1 issues one lender NFT without reissuance token, output 3 is at the offer's
    /// address; nothing else is filled in.
    creation_tx: Transaction,
    /// The offer as its lender opens it from output 3.
    opened: OpenedOffer,
    /// The parameters the borrower builds the offer with.
    parameters: PrivateLendingParameters,
}

fn offer_off_chain(network: SimplicityNetwork) -> OffChainOffer {
    let borrower = LendingKey::from_master_blinding_key(&[1; 32]);
    let lender = LendingKey::from_master_blinding_key(&[2; 32]);
    let asset = |byte| AssetId::from_slice(&[byte; 32]).unwrap();
    let first_input = OutPoint::new(Txid::from_byte_array([0xee; 32]), 0);

    let terms = OfferTerms {
        principal_asset: asset(0xaa),
        principal_amount: PRINCIPAL_AMOUNT,
        repayment_amount: REPAYMENT_AMOUNT,
        interest_rate_bps: PRINCIPAL_INTEREST_RATE,
        loan_expiration_time: 1_000,
        borrower_nft: asset(0x44),
        lender_nft: AssetId::from_entropy(lender_nft_entropy()),
    };
    let new_offer = NewOffer::build(
        &borrower,
        &lender.x_only_public_key(),
        &first_input,
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

    let lender_nft_issuance = AssetIssuance {
        asset_blinding_nonce: ZERO_TWEAK,
        asset_entropy: LENDER_NFT_CONTRACT_HASH,
        amount: confidential::Value::Explicit(1),
        inflation_keys: confidential::Value::Null,
    };
    let creation_tx = Transaction {
        version: 2,
        lock_time: LockTime::ZERO,
        input: vec![
            TxIn {
                previous_output: first_input,
                ..TxIn::default()
            },
            TxIn {
                previous_output: lender_nft_coin(),
                asset_issuance: lender_nft_issuance,
                ..TxIn::default()
            },
        ],
        output: vec![
            TxOut::default(),
            TxOut::default(),
            TxOut::default(),
            offer_output(parameters),
        ],
    };

    OffChainOffer {
        creation_tx,
        opened,
        parameters,
    }
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
    let parameters = verify_pending_offer(&opened, creation_tx, *context.get_network())?;

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
    let OffChainOffer {
        mut creation_tx,
        opened,
        parameters,
    } = offer_off_chain(network);

    // the address the terms give passes
    assert!(verify_pending_offer(&opened, &creation_tx, network).is_ok());

    // the borrower pins one unit less of repayment than the terms show
    let mut dishonest = parameters;
    dishonest.pinned.repayment = parameters
        .pinned
        .repayment
        .with_amount(REPAYMENT_AMOUNT - 1);
    creation_tx.output[3] = offer_output(dishonest);

    assert_eq!(
        verify_pending_offer(&opened, &creation_tx, network).err(),
        Some(VerifyError::AddressMismatch)
    );

    Ok(())
}

#[simplex::test]
fn invalid_terms_fail_verification(context: simplex::TestContext) -> anyhow::Result<()> {
    let network = *context.get_network();
    let offer = offer_off_chain(network);
    let verify_with = |change: fn(&mut OfferTerms)| {
        let mut opened = offer.opened;
        change(&mut opened.signed_terms.terms);

        verify_pending_offer(&opened, &offer.creation_tx, network).err()
    };

    assert_eq!(
        verify_with(|terms| terms.principal_amount = 0),
        Some(VerifyError::InvalidTerms)
    );
    assert_eq!(
        verify_with(|terms| terms.repayment_amount = PRINCIPAL_AMOUNT - 1),
        Some(VerifyError::InvalidTerms)
    );

    // a lock time from 500_000_000 on is a timestamp: the lender could never liquidate
    assert_eq!(
        verify_with(|terms| terms.loan_expiration_time = 500_000_000),
        Some(VerifyError::InvalidTerms)
    );
    // the last height passes the terms, then fails the address, built for another expiration
    assert_eq!(
        verify_with(|terms| terms.loan_expiration_time = 499_999_999),
        Some(VerifyError::AddressMismatch)
    );

    Ok(())
}

#[simplex::test]
fn non_unique_lender_nft_fails_verification(context: simplex::TestContext) -> anyhow::Result<()> {
    let network = *context.get_network();
    let offer = offer_off_chain(network);
    let verify_with = |change: fn(&mut AssetIssuance)| {
        let mut creation_tx = offer.creation_tx.clone();
        change(&mut creation_tx.input[1].asset_issuance);

        verify_pending_offer(&offer.opened, &creation_tx, network).err()
    };

    // a second unit
    assert_eq!(
        verify_with(|issuance| issuance.amount = confidential::Value::Explicit(2)),
        Some(VerifyError::LenderNftNotUnique)
    );
    // a reissuance token
    assert_eq!(
        verify_with(|issuance| issuance.inflation_keys = confidential::Value::Explicit(1)),
        Some(VerifyError::LenderNftNotUnique)
    );

    // a reissuance of the NFT: input 1 gives the NFT's asset id, but the NFT exists already
    let mut reissuance_tx = offer.creation_tx.clone();
    let reissuance = &mut reissuance_tx.input[1].asset_issuance;
    reissuance.asset_blinding_nonce = Tweak::from_slice(&[1; 32])?;
    reissuance.asset_entropy = lender_nft_entropy().to_byte_array();

    assert_eq!(
        reissuance_tx.input[1].issuance_ids().0,
        offer.parameters.lender_nft_asset_id
    );
    assert_eq!(
        verify_pending_offer(&offer.opened, &reissuance_tx, network).err(),
        Some(VerifyError::LenderNftNotUnique)
    );

    // terms that name another asset than the one input 1 issues
    let mut other_nft = offer.opened;
    other_nft.signed_terms.terms.lender_nft = AssetId::from_slice(&[0x55; 32])?;

    assert_eq!(
        verify_pending_offer(&other_nft, &offer.creation_tx, network).err(),
        Some(VerifyError::LenderNftNotUnique)
    );

    Ok(())
}
