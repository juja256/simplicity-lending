//! The ground truth that the browser's LWK-based code is checked against: a real private creation
//! transaction from regtest, the keys that open it, the contract's expected arguments and scripts,
//! and the serialized witnesses of the branches the web builds, from synthetic spends of the offer.
//! Regenerate it with `WRITE_PARITY_FIXTURE=1 simplex test write_private_lending_parity_fixture`.

use serde_json::{Value, json};

use simplex::program::{ProgramTrait, WitnessTrait};
use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::confidential::{Asset, Nonce};
use simplex::simplicityhl::elements::encode::{deserialize, serialize};
use simplex::simplicityhl::elements::pset::PartiallySignedTransaction;
use simplex::simplicityhl::elements::{
    AssetId, LockTime, OutPoint, Script, Sequence, Transaction, TxIn, TxOut, TxOutWitness,
    confidential,
};

use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingParameters, PrivateLendingWitnessBranch,
    verify_offer_as_borrower, verify_offer_as_lender,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::programs::script_auth::ScriptAuth;
use private_lending_core::{LendingKey, PinnedOutput};

use super::setup::{default_offer_parameters, setup_pending_private_offer};

const FIXTURE: &str = include_str!("../../../../web/scripts/fixtures/private-lending-parity.json");
const FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../web/scripts/fixtures/private-lending-parity.json"
);

const BORROWER_MASTER_BLINDING_KEY: [u8; 32] = [1; 32];
const LENDER_MASTER_BLINDING_KEY: [u8; 32] = [2; 32];

/// An explicit output of `amount` of `asset` to `script`.
fn explicit_output(asset: AssetId, amount: u64, script: Script) -> TxOut {
    TxOut {
        asset: Asset::Explicit(asset),
        value: confidential::Value::Explicit(amount),
        nonce: Nonce::Null,
        script_pubkey: script,
        witness: TxOutWitness::default(),
    }
}

/// The commitments of `pinned` at `script`, without proofs: the program reads only commitments.
fn pinned_output(pinned: PinnedOutput, script: Script) -> TxOut {
    TxOut {
        asset: pinned.asset_commitment(),
        value: pinned.value_commitment(),
        nonce: Nonce::Null,
        script_pubkey: script,
        witness: TxOutWitness::default(),
    }
}

/// A transaction that creates `outputs`, the prevouts of a synthetic spend.
fn prevouts_tx(outputs: Vec<TxOut>) -> Transaction {
    Transaction {
        version: 2,
        lock_time: LockTime::ZERO,
        input: vec![TxIn::default()],
        output: outputs,
    }
}

/// A spend of every output of `prevouts`, in order, into `outputs`, locked to the height
/// `lock_time`, with sequences that enable it, as a PSET whose inputs carry their prevouts.
fn spend(
    prevouts: &Transaction,
    outputs: Vec<TxOut>,
    lock_time: u32,
) -> PartiallySignedTransaction {
    let tx = Transaction {
        version: 2,
        lock_time: LockTime::from_height(lock_time).expect("a block height"),
        input: (0..prevouts.output.len())
            .map(|vout| TxIn {
                previous_output: OutPoint::new(prevouts.txid(), vout as u32),
                sequence: Sequence::ENABLE_LOCKTIME_NO_RBF,
                ..Default::default()
            })
            .collect(),
        output: outputs,
    };
    let mut pset = PartiallySignedTransaction::from_tx(tx);
    for (input, prevout) in pset.inputs_mut().iter_mut().zip(&prevouts.output) {
        input.witness_utxo = Some(prevout.clone());
    }

    pset
}

/// The witness vector of `branch` on input `input_index` of a spend of `prevouts` into `outputs`:
/// the transactions, and the serialized witness that running the active offer's program gives,
/// which the web's witness of the same values must equal.
fn witness_vector(
    parameters: &PrivateLendingParameters,
    prevouts: Vec<TxOut>,
    outputs: Vec<TxOut>,
    lock_time: u32,
    input_index: usize,
    branch: PrivateLendingWitnessBranch,
) -> Value {
    let active = PrivateLendingOffer::new_active(*parameters);
    let prevouts = prevouts_tx(prevouts);
    let pset = spend(&prevouts, outputs, lock_time);
    let stack = active
        .get_program()
        .finalize(
            &pset,
            &branch.build_witness().build_witness(),
            input_index,
            &parameters.network,
        )
        .expect("the program accepts the synthetic spend");

    json!({
        "prevouts_tx": hex::encode(serialize(&prevouts)),
        "tx": hex::encode(serialize(&pset.extract_tx().expect("a complete transaction"))),
        "input_index": input_index,
        "witness": hex::encode(&stack[0]),
    })
}

/// The witness vectors of the full repayment and the liquidation of the loan the offer of
/// `parameters` starts.
fn witness_vectors(parameters: &PrivateLendingParameters) -> Value {
    let pinned = parameters.pinned;
    let active = PrivateLendingOffer::new_active(*parameters);
    let anyone = Script::from(vec![0x51]);
    let burn = Script::new_op_return(b"burn");
    let loan = pinned_output(pinned.active_collateral, active.get_script_pubkey());
    let debt_hash = active.get_debt_hash();
    let expiry = parameters.loan_expiration_time;

    let mut full_repayment = witness_vector(
        parameters,
        vec![
            explicit_output(parameters.borrower_nft_asset_id, 1, anyone.clone()),
            loan.clone(),
        ],
        vec![
            explicit_output(parameters.borrower_nft_asset_id, 1, burn.clone()),
            pinned_output(
                pinned.repayment,
                parameters
                    .get_repayment_output_asset_auth()
                    .get_script_pubkey(),
            ),
        ],
        0,
        1,
        PrivateLendingWitnessBranch::FullRepayment { debt_hash },
    );
    full_repayment["debt_hash"] = json!(hex::encode(debt_hash));

    let mut liquidation = witness_vector(
        parameters,
        vec![
            loan,
            explicit_output(parameters.lender_nft_asset_id, 1, anyone),
        ],
        vec![explicit_output(parameters.lender_nft_asset_id, 1, burn)],
        expiry,
        0,
        PrivateLendingWitnessBranch::Liquidation {
            debt_hash,
            salt: parameters.expiry_salt,
            expiry,
        },
    );
    liquidation["debt_hash"] = json!(hex::encode(debt_hash));
    liquidation["salt"] = json!(hex::encode(parameters.expiry_salt));
    liquidation["expiry"] = json!(expiry);

    json!({ "full_repayment": full_repayment, "liquidation": liquidation })
}

/// The fixture that the contract's values give for `parameters` and `creation_tx`.
fn expected_fixture(parameters: &PrivateLendingParameters, creation_tx: &Transaction) -> Value {
    let arguments = parameters.build_arguments();
    let (repayment_asset_prefix_bit, repayment_asset_x) = arguments.repayment_asset;
    let pending = PrivateLendingOffer::new_pending(*parameters);
    let active = PrivateLendingOffer::new_active(*parameters);
    let lender_nft_lock = ScriptAuth::from_simplex_program(&pending);

    json!({
        "borrower_master_blinding_key": hex::encode(BORROWER_MASTER_BLINDING_KEY),
        "lender_master_blinding_key": hex::encode(LENDER_MASTER_BLINDING_KEY),
        "program_id": hex::encode(PrivateLendingOffer::get_program_id()),
        "creation_tx": hex::encode(serialize(creation_tx)),
        "arguments": {
            "borrower_nft_asset_id": hex::encode(arguments.borrower_nft_asset_id),
            "lender_nft_asset_id": hex::encode(arguments.lender_nft_asset_id),
            "pending_collateral_commitment": hex::encode(arguments.pending_collateral_commitment),
            "active_collateral_commitment": hex::encode(arguments.active_collateral_commitment),
            "principal_commitment": hex::encode(arguments.principal_commitment),
            "repayment_commitment": hex::encode(arguments.repayment_commitment),
            "expiry_hash": hex::encode(arguments.expiry_hash),
            "repayment_asset_prefix_bit": u8::from(repayment_asset_prefix_bit),
            "repayment_asset_x": hex::encode(repayment_asset_x),
        },
        "principal_output_script_hash":
            hex::encode(parameters.get_principal_output_asset_auth().get_script_hash()),
        "repayment_output_script_hash":
            hex::encode(parameters.get_repayment_output_asset_auth().get_script_hash()),
        "installment_output_script_hash":
            hex::encode(parameters.get_installment_output_asset_auth().get_script_hash()),
        "pending_offer_script_pubkey": hex::encode(pending.get_script_pubkey().as_bytes()),
        "active_offer_script_pubkey": hex::encode(active.get_script_pubkey().as_bytes()),
        "lender_nft_script_pubkey": hex::encode(lender_nft_lock.get_script_pubkey().as_bytes()),
        "witness_vectors": witness_vectors(parameters),
    })
}

/// Writes the fixture from a fresh regtest offer, only when `WRITE_PARITY_FIXTURE` is set.
#[simplex::test]
fn write_private_lending_parity_fixture(context: simplex::TestContext) -> anyhow::Result<()> {
    if std::env::var_os("WRITE_PARITY_FIXTURE").is_none() {
        return Ok(());
    }

    let setup = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
    let (_, parameters) = verify_offer_as_lender(
        &setup.lender_lending_key,
        &setup.creation_tx,
        *context.get_network(),
    )?;

    let fixture = expected_fixture(&parameters, &setup.creation_tx);
    std::fs::write(
        FIXTURE_PATH,
        format!("{}\n", serde_json::to_string_pretty(&fixture)?),
    )?;

    Ok(())
}

#[simplex::test]
fn parity_fixture_verifies_against_the_contract(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let network: SimplicityNetwork = *context.get_network();
    let fixture: Value = serde_json::from_str(FIXTURE)?;
    let creation_tx: Transaction = deserialize(&hex::decode(
        fixture["creation_tx"].as_str().expect("creation_tx"),
    )?)?;

    let (_, lender_parameters) = verify_offer_as_lender(
        &LendingKey::from_master_blinding_key(&LENDER_MASTER_BLINDING_KEY),
        &creation_tx,
        network,
    )?;
    let (_, borrower_parameters) = verify_offer_as_borrower(
        &LendingKey::from_master_blinding_key(&BORROWER_MASTER_BLINDING_KEY),
        &creation_tx,
        network,
    )?;
    assert_eq!(lender_parameters, borrower_parameters);

    // the arguments, script hashes, script pubkeys and program id
    assert_eq!(fixture, expected_fixture(&lender_parameters, &creation_tx));

    // the outputs of the creation transaction are the ones the fixture names
    let script_pubkey_at =
        |vout: usize| hex::encode(creation_tx.output[vout].script_pubkey.as_bytes());
    assert_eq!(script_pubkey_at(3), fixture["pending_offer_script_pubkey"]);
    assert_eq!(script_pubkey_at(1), fixture["lender_nft_script_pubkey"]);

    Ok(())
}
