use std::collections::HashMap;

use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::confidential::{AssetBlindingFactor, ValueBlindingFactor};
use simplex::simplicityhl::elements::hashes::Hash;
use simplex::simplicityhl::elements::pset::{Input, Output, PartiallySignedTransaction};
use simplex::simplicityhl::elements::{
    AssetId, ContractHash, OutPoint, Script, Transaction, TxOut, TxOutSecrets, Txid, bitcoin,
    confidential,
};
use simplex::transaction::UTXO;

use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingParameters, VerifyError, add_nft_issuances,
    verify_offer_as_borrower, verify_offer_as_lender,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::programs::script_auth::ScriptAuth;
use lending_contracts::utils::confidential::ConfidentialTransaction;
use private_lending_core::{
    CreationError, LendingKey, NewOffer, OfferTerms, OpenError, blind_pset, find_offer,
    lift_lending_key,
};

use super::setup::{
    COLLATERAL_AMOUNT, PRINCIPAL_AMOUNT, PRINCIPAL_INTEREST_RATE, default_offer_parameters,
    setup_pending_private_offer,
};

/// The principal and 10% interest.
const REPAYMENT_AMOUNT: u64 = 11_000;
/// The contract hashes of the NFT issuances in [`OffChainOffer`].
const BORROWER_NFT_CONTRACT_HASH: [u8; 32] = [0x21; 32];
const LENDER_NFT_CONTRACT_HASH: [u8; 32] = [0x22; 32];

fn borrower_key() -> LendingKey {
    LendingKey::from_master_blinding_key(&[1; 32])
}

fn lender_key() -> LendingKey {
    LendingKey::from_master_blinding_key(&[2; 32])
}

/// Input 0 of the creation transaction in [`OffChainOffer`], which issues the borrower NFT.
fn first_input() -> OutPoint {
    OutPoint::new(Txid::from_byte_array([0xee; 32]), 0)
}

/// Input 1 of the creation transaction in [`OffChainOffer`], which issues the lender NFT.
fn lender_nft_coin() -> OutPoint {
    OutPoint::new(Txid::from_byte_array([0xee; 32]), 1)
}

/// The asset that `coin` issues with `contract_hash`.
fn issued_asset(coin: OutPoint, contract_hash: [u8; 32]) -> AssetId {
    AssetId::from_entropy(AssetId::generate_asset_entropy(
        coin,
        ContractHash::from_byte_array(contract_hash),
    ))
}

/// An offer made up without a chain.
struct OffChainOffer {
    new_offer: NewOffer,
    /// The parameters the borrower builds the offer with.
    parameters: PrivateLendingParameters,
}

impl OffChainOffer {
    fn new(network: SimplicityNetwork) -> OffChainOffer {
        let terms = OfferTerms {
            principal_asset: AssetId::from_slice(&[0xaa; 32]).unwrap(),
            principal_amount: PRINCIPAL_AMOUNT,
            repayment_amount: REPAYMENT_AMOUNT,
            interest_rate_bps: PRINCIPAL_INTEREST_RATE,
            loan_expiration_time: 1_000,
            borrower_nft: issued_asset(first_input(), BORROWER_NFT_CONTRACT_HASH),
            lender_nft: issued_asset(lender_nft_coin(), LENDER_NFT_CONTRACT_HASH),
        };
        let new_offer = NewOffer::build(
            &borrower_key(),
            &lender_key().x_only_public_key(),
            &first_input(),
            PrivateLendingOffer::get_program_id(),
            network.policy_asset(),
            COLLATERAL_AMOUNT,
            terms,
        )
        .unwrap();
        let parameters = PrivateLendingParameters::from_terms(&terms, new_offer.pinned, network);

        OffChainOffer {
            new_offer,
            parameters,
        }
    }

    /// The honest creation transaction, unsigned.
    fn creation_tx(&self) -> Transaction {
        self.creation_tx_with(self.parameters)
    }

    /// The creation transaction, unsigned, whose output 3 is at the pending offer address of
    /// `parameters` and whose output 1 locks the lender NFT to that offer: inputs 0 and 1 issue
    /// the NFTs, output 2 carries the marker, output 3 the collateral blinded as
    /// `attach_creation` blinds it; a confidential change and an explicit fee follow.
    fn creation_tx_with(&self, parameters: PrivateLendingParameters) -> Transaction {
        let new_offer = &self.new_offer;
        let terms = new_offer.signed_terms.terms;
        let offer = PrivateLendingOffer::new_pending(parameters);
        let policy_asset = parameters.network.policy_asset();

        let mut pset = PartiallySignedTransaction::new_v2();
        let mut input_secrets = HashMap::new();
        let coins = [
            (first_input(), BORROWER_NFT_CONTRACT_HASH, COLLATERAL_AMOUNT),
            (lender_nft_coin(), LENDER_NFT_CONTRACT_HASH, 1_000),
        ];
        for (index, (coin, contract_hash, amount)) in coins.into_iter().enumerate() {
            pset.add_input(Input {
                previous_txid: coin.txid,
                previous_output_index: coin.vout,
                witness_utxo: Some(TxOut::new_fee(amount, policy_asset)),
                issuance_value_amount: Some(1),
                issuance_asset_entropy: Some(contract_hash),
                // an explicit issuance, which the PSET blinder leaves alone
                blinded_issuance: Some(0),
                ..Default::default()
            });
            input_secrets.insert(
                index,
                TxOutSecrets::new(
                    policy_asset,
                    AssetBlindingFactor::zero(),
                    amount,
                    ValueBlindingFactor::zero(),
                ),
            );
        }

        let lender_blinding_key = bitcoin::PublicKey::new(lift_lending_key(&new_offer.lender));
        let change_blinding_key =
            bitcoin::PublicKey::new(lift_lending_key(&borrower_key().x_only_public_key()));
        let mut change = Output::new_explicit(
            Script::from(vec![0x51, 0x14]),
            900,
            policy_asset,
            Some(change_blinding_key),
        );
        change.blinder_index = Some(1);
        for output in [
            Output::new_explicit(Script::from(vec![0x51, 0x10]), 1, terms.borrower_nft, None),
            Output::new_explicit(
                ScriptAuth::from_simplex_program(&offer).get_script_pubkey(),
                1,
                terms.lender_nft,
                None,
            ),
            Output::new_explicit(
                Script::new_op_return(&new_offer.marker.encode()),
                0,
                policy_asset,
                None,
            ),
            Output::new_explicit(
                offer.get_script_pubkey(),
                COLLATERAL_AMOUNT,
                policy_asset,
                Some(lender_blinding_key),
            ),
            change,
            Output::new_explicit(Script::new(), 100, policy_asset, None),
        ] {
            pset.add_output(output);
        }

        blind_pset(
            &mut pset,
            &input_secrets,
            &[new_offer.collateral_blinding(3)],
            &mut rand::thread_rng(),
        )
        .unwrap();

        pset.extract_tx().unwrap()
    }
}

/// Both sides' verification of `creation_tx`.
fn verify_both(
    creation_tx: &Transaction,
    network: SimplicityNetwork,
) -> [Result<PrivateLendingParameters, VerifyError>; 2] {
    [
        verify_offer_as_lender(&lender_key(), creation_tx, network).map(|(_, p)| p),
        verify_offer_as_borrower(&borrower_key(), creation_tx, network).map(|(_, p)| p),
    ]
}

/// An explicit policy coin at `outpoint`, as the creation's issuance inputs spend.
fn coin(outpoint: OutPoint, network: SimplicityNetwork) -> UTXO {
    UTXO {
        outpoint,
        txout: TxOut::new_fee(1_000, network.policy_asset()),
        secrets: None,
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
fn lender_finds_and_verifies_offer(context: simplex::TestContext) -> anyhow::Result<()> {
    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let creation_tx = &setup.creation_tx;

    // what the indexer finds
    let found = find_offer(creation_tx, PrivateLendingOffer::get_program_id())
        .expect("the creation transaction carries an offer");
    assert_eq!(found.offer_outpoint, OutPoint::new(creation_tx.txid(), 3));
    assert_eq!(found.first_input, creation_tx.input[0].previous_output);

    let (opened, parameters) = verify_offer_as_lender(
        &setup.lender_lending_key,
        creation_tx,
        *context.get_network(),
    )?;

    assert_eq!(parameters, setup.parameters);
    assert_eq!(opened.lender, setup.lender_lending_key.x_only_public_key());

    Ok(())
}

#[simplex::test]
fn borrower_recovers_offer_from_chain(context: simplex::TestContext) -> anyhow::Result<()> {
    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;

    let (recovered, parameters) = verify_offer_as_borrower(
        &setup.borrower_lending_key,
        &setup.creation_tx,
        *context.get_network(),
    )?;

    assert_eq!(
        recovered.lender,
        setup.lender_lending_key.x_only_public_key()
    );
    assert_eq!(parameters, setup.parameters);

    Ok(())
}

#[simplex::test]
fn dishonest_repayment_fails_verification(context: simplex::TestContext) -> anyhow::Result<()> {
    let network = *context.get_network();
    let offer = OffChainOffer::new(network);

    // the address the terms give passes
    assert_eq!(
        verify_both(&offer.creation_tx(), network),
        [Ok(offer.parameters); 2]
    );

    // the borrower pins one unit less of repayment than the terms show
    let mut dishonest = offer.parameters;
    dishonest.pinned.repayment = dishonest.pinned.repayment.with_amount(REPAYMENT_AMOUNT - 1);
    let creation_tx = offer.creation_tx_with(dishonest);

    assert_eq!(
        verify_both(&creation_tx, network),
        [Err(VerifyError::AddressMismatch); 2]
    );

    Ok(())
}

#[simplex::test]
fn unlocked_lender_nft_fails_verification(context: simplex::TestContext) -> anyhow::Result<()> {
    let network = *context.get_network();
    let offer = OffChainOffer::new(network);

    // the lender NFT goes elsewhere than to the offer: nobody could accept it
    let mut creation_tx = offer.creation_tx();
    creation_tx.output[1].script_pubkey = creation_tx.output[0].script_pubkey.clone();

    assert_eq!(
        verify_both(&creation_tx, network),
        [Err(VerifyError::LenderNftNotLocked); 2]
    );

    Ok(())
}

#[simplex::test]
fn core_checks_fail_verification(context: simplex::TestContext) -> anyhow::Result<()> {
    let network = *context.get_network();
    let offer = OffChainOffer::new(network);

    // a second unit of the lender NFT
    let mut creation_tx = offer.creation_tx();
    creation_tx.input[1].asset_issuance.amount = confidential::Value::Explicit(2);
    assert_eq!(
        verify_both(&creation_tx, network),
        [Err(VerifyError::Creation(CreationError::LenderNftNotUnique)); 2]
    );

    // another borrower's key does not open the offer
    let stranger = LendingKey::from_master_blinding_key(&[3; 32]);
    assert_eq!(
        verify_offer_as_borrower(&stranger, &offer.creation_tx(), network).err(),
        Some(VerifyError::Creation(CreationError::Open(
            OpenError::NotMine
        )))
    );

    Ok(())
}

#[simplex::test]
#[should_panic(expected = "The offer's parameters are not those of the new offer's terms")]
fn creation_with_other_parameters_panics(context: simplex::TestContext) {
    let network = *context.get_network();
    let offer = OffChainOffer::new(network);

    // parameters that do not come from the terms: another expiration
    let mut other = offer.parameters;
    other.loan_expiration_time += 1;

    let mut ctx = ConfidentialTransaction::new();
    add_nft_issuances(
        &mut ctx,
        coin(first_input(), network),
        coin(lender_nft_coin(), network),
    );

    PrivateLendingOffer::new_pending(other).attach_creation(
        &mut ctx,
        &offer.new_offer,
        Script::new(),
    );
}

#[simplex::test]
#[should_panic(expected = "Input 0 is not the new offer's first input")]
fn creation_from_another_first_input_panics(context: simplex::TestContext) {
    let network = *context.get_network();
    let offer = OffChainOffer::new(network);

    // the new offer was built for input 0 = first_input()
    let mut ctx = ConfidentialTransaction::new();
    add_nft_issuances(
        &mut ctx,
        coin(lender_nft_coin(), network),
        coin(first_input(), network),
    );

    PrivateLendingOffer::new_pending(offer.parameters).attach_creation(
        &mut ctx,
        &offer.new_offer,
        Script::new(),
    );
}
