//! Offline covenant checks. These use synthetic transactions/UTXOs and execute the real
//! programs, but do not validate confidential balance proofs or broadcast anything.
use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingParameters, PrivateLendingWitnessBranch,
    verify_offer_as_lender,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::programs::script_auth::{ScriptAuth, ScriptAuthWitnessParams};
use private_lending_core::{LendingKey, PinnedOutput};
use simplex::program::{ProgramTrait, WitnessTrait};
use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::confidential::{Asset, Nonce, Value};
use simplex::simplicityhl::elements::encode::deserialize;
use simplex::simplicityhl::elements::pset::PartiallySignedTransaction;
use simplex::simplicityhl::elements::{
    AssetId, LockTime, OutPoint, Script, Sequence, Transaction, TxIn, TxOut, TxOutWitness,
};

fn fixture() -> (Transaction, PrivateLendingParameters) {
    // Published deterministic test fixture, not a live wallet key.
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../web/scripts/fixtures/private-lending-parity.json"
    ))
    .unwrap();
    let creation: Transaction =
        deserialize(&hex::decode(fixture["creation_tx"].as_str().unwrap()).unwrap()).unwrap();
    let (_, params) = verify_offer_as_lender(
        &LendingKey::from_master_blinding_key(&[2; 32]),
        &creation,
        SimplicityNetwork::default_regtest(),
    )
    .unwrap();
    (creation, params)
}

fn explicit(asset: AssetId, amount: u64, script: Script) -> TxOut {
    TxOut {
        asset: Asset::Explicit(asset),
        value: Value::Explicit(amount),
        nonce: Nonce::Null,
        script_pubkey: script,
        witness: TxOutWitness::default(),
    }
}

fn pinned(pinned: PinnedOutput, script: Script) -> TxOut {
    TxOut {
        asset: pinned.asset_commitment(),
        value: pinned.value_commitment(),
        nonce: Nonce::Null,
        script_pubkey: script,
        witness: TxOutWitness::default(),
    }
}

fn pset(
    utxos: Vec<(OutPoint, TxOut)>,
    outputs: Vec<TxOut>,
    height: u32,
) -> PartiallySignedTransaction {
    let tx = Transaction {
        version: 2,
        lock_time: LockTime::from_height(height).unwrap(),
        input: utxos
            .iter()
            .map(|(outpoint, _)| TxIn {
                previous_output: *outpoint,
                sequence: Sequence::ENABLE_LOCKTIME_NO_RBF,
                ..Default::default()
            })
            .collect(),
        output: outputs,
    };
    let mut pset = PartiallySignedTransaction::from_tx(tx);
    for (input, (_, utxo)) in pset.inputs_mut().iter_mut().zip(utxos) {
        input.witness_utxo = Some(utxo);
    }
    pset
}

#[test]
fn expired_pending_offer_can_be_accepted_then_liquidated_without_borrower_signature() {
    let (creation, params) = fixture();
    let pending = PrivateLendingOffer::new_pending(params);
    let active = PrivateLendingOffer::new_active(params);
    let nft_lock = ScriptAuth::from_simplex_program(&pending);
    let lender_destination = Script::from(vec![0x51]);
    let later_height = params.loan_expiration_time + 100;
    let active_collateral = pinned(params.pinned.active_collateral, active.get_script_pubkey());
    let lender_nft = explicit(params.lender_nft_asset_id, 1, lender_destination.clone());

    let acceptance = pset(
        vec![
            (
                OutPoint::new(creation.txid(), 3),
                creation.output[3].clone(),
            ),
            (
                OutPoint::new(creation.txid(), 1),
                creation.output[1].clone(),
            ),
        ],
        vec![
            active_collateral.clone(),
            pinned(
                params.pinned.principal,
                params.get_principal_output_asset_auth().get_script_pubkey(),
            ),
            lender_nft.clone(),
        ],
        later_height,
    );
    let accept_witness = PrivateLendingWitnessBranch::OfferAcceptance
        .build_witness()
        .build_witness();
    pending
        .get_program()
        .execute(&acceptance, &accept_witness, 0, &params.network)
        .unwrap();
    nft_lock
        .get_program()
        .execute(
            &acceptance,
            &ScriptAuthWitnessParams::new(0)
                .build_witness()
                .build_witness(),
            1,
            &params.network,
        )
        .unwrap();

    // Positive control: the acceptance actually checks the promised principal.
    let mut wrong_principal = acceptance.clone();
    wrong_principal.outputs_mut()[1].amount_comm = Some(
        params
            .pinned
            .principal
            .with_amount(params.pinned.principal.amount - 1)
            .value_commitment()
            .commitment()
            .unwrap(),
    );
    assert!(
        pending
            .get_program()
            .execute(&wrong_principal, &accept_witness, 0, &params.network)
            .is_err()
    );

    let mut redirected_principal = acceptance.clone();
    redirected_principal.outputs_mut()[1].script_pubkey = lender_destination.clone();
    assert!(
        pending
            .get_program()
            .execute(&redirected_principal, &accept_witness, 0, &params.network)
            .is_err()
    );

    let mut wrong_collateral = acceptance.clone();
    wrong_collateral.outputs_mut()[0].amount_comm = Some(
        params
            .pinned
            .active_collateral
            .with_amount(params.pinned.active_collateral.amount - 1)
            .value_commitment()
            .commitment()
            .unwrap(),
    );
    assert!(
        pending
            .get_program()
            .execute(&wrong_collateral, &accept_witness, 0, &params.network)
            .is_err()
    );

    let mut duplicate_nft = acceptance.clone();
    duplicate_nft.inputs_mut()[1]
        .witness_utxo
        .as_mut()
        .unwrap()
        .value = Value::Explicit(2);
    duplicate_nft.outputs_mut()[2].amount = Some(2);
    assert!(
        pending
            .get_program()
            .execute(&duplicate_nft, &accept_witness, 0, &params.network)
            .is_err()
    );

    let acceptance_txid = acceptance.extract_tx().unwrap().txid();
    let liquidation = pset(
        vec![
            (OutPoint::new(acceptance_txid, 0), active_collateral),
            (OutPoint::new(acceptance_txid, 2), lender_nft),
        ],
        vec![explicit(
            params.lender_nft_asset_id,
            1,
            Script::new_op_return(b"burn"),
        )],
        later_height,
    );
    let liquidation_witness = PrivateLendingWitnessBranch::Liquidation
        .build_witness()
        .build_witness();
    active
        .get_program()
        .execute(&liquidation, &liquidation_witness, 0, &params.network)
        .unwrap();

    let mut early_liquidation = liquidation.clone();
    early_liquidation.global.tx_data.fallback_locktime =
        Some(LockTime::from_height(params.loan_expiration_time - 1).unwrap());
    assert!(
        active
            .get_program()
            .execute(&early_liquidation, &liquidation_witness, 0, &params.network)
            .is_err()
    );

    let mut no_burn = liquidation.clone();
    no_burn.outputs_mut()[0].script_pubkey = lender_destination;
    assert!(
        active
            .get_program()
            .execute(&no_burn, &liquidation_witness, 0, &params.network)
            .is_err()
    );

    let mut foreign_nft = liquidation.clone();
    foreign_nft.inputs_mut()[1]
        .witness_utxo
        .as_mut()
        .unwrap()
        .asset = Asset::Explicit(params.borrower_nft_asset_id);
    assert!(
        active
            .get_program()
            .execute(&foreign_nft, &liquidation_witness, 0, &params.network)
            .is_err()
    );
}
