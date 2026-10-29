//! The ground truth that the browser's LWK-based code is checked against: a real private creation
//! transaction from regtest, the keys that open it, and the contract's expected arguments and
//! scripts. Regenerate it with `WRITE_PARITY_FIXTURE=1 simplex test write_private_lending_parity_fixture`.

use serde_json::{Value, json};

use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::Transaction;
use simplex::simplicityhl::elements::encode::{deserialize, serialize};

use lending_contracts::programs::private_lending::{
    PrivateLendingOffer, PrivateLendingParameters, verify_offer_as_borrower, verify_offer_as_lender,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::programs::script_auth::ScriptAuth;
use private_lending_core::LendingKey;

use super::setup::{default_offer_parameters, setup_pending_private_offer};

const FIXTURE: &str = include_str!("../../../../web/scripts/fixtures/private-lending-parity.json");
const FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../web/scripts/fixtures/private-lending-parity.json"
);

const BORROWER_MASTER_BLINDING_KEY: [u8; 32] = [1; 32];
const LENDER_MASTER_BLINDING_KEY: [u8; 32] = [2; 32];

/// The fixture that the contract's values give for `parameters` and `creation_tx`.
fn expected_fixture(parameters: &PrivateLendingParameters, creation_tx: &Transaction) -> Value {
    let arguments = parameters.build_arguments();
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
            "loan_expiration_time": arguments.loan_expiration_time,
        },
        "principal_output_script_hash":
            hex::encode(parameters.get_principal_output_asset_auth().get_script_hash()),
        "repayment_output_script_hash":
            hex::encode(parameters.get_repayment_output_asset_auth().get_script_hash()),
        "pending_offer_script_pubkey": hex::encode(pending.get_script_pubkey().as_bytes()),
        "active_offer_script_pubkey": hex::encode(active.get_script_pubkey().as_bytes()),
        "lender_nft_script_pubkey": hex::encode(lender_nft_lock.get_script_pubkey().as_bytes()),
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
