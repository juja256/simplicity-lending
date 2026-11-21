//! The ground truth that the browser's LWK-based code is checked against: a real private creation
//! transaction from regtest, the keys that open it, the contract's expected arguments and scripts,
//! and the serialized witnesses of the branches the web builds, from synthetic spends of the offer.
//! The offer's loan, also from regtest, has its acceptance and one installment, with the debt and
//! the loan's scripts the contract gives for them. The offer carries the borrower's message in its
//! terms, the acceptance the lender's on the principal, and the installment the borrower's, each
//! signed for its phase. A second offer's `A` has the other prefix bit, so that the web's
//! conversion of the bit is checked both ways.
//! Regenerate it with `WRITE_PARITY_FIXTURE=1 simplex test write_private_lending_parity_fixture`.

use serde_json::{Value, json};

use simplex::program::{ProgramTrait, WitnessTrait};
use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::confidential::{Asset, Nonce, ValueBlindingFactor};
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
use private_lending_core::{
    DebtOpening, LendingKey, Message, MessagePhase, OfferSecrets, PinnedOutput, SignedMessage,
    debt_after, debt_hash, open_installment, open_installment_with_extra_data, rewind,
    zero_debt_key,
};

use super::offer_installment_flows::{prefix_bit, random_payment};
use super::setup::{
    Loan, accept_private_offer_with, borrower_blinding_key, default_offer_parameters,
    pay_installment_with, repayment_output, setup_pending_private_offer,
    setup_pending_private_offer_with,
};

const FIXTURE: &str = include_str!("../../../../web/scripts/fixtures/private-lending-parity.json");
const FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../web/scripts/fixtures/private-lending-parity.json"
);

const BORROWER_MASTER_BLINDING_KEY: [u8; 32] = [1; 32];
const LENDER_MASTER_BLINDING_KEY: [u8; 32] = [2; 32];

/// The amount of the loan's installment, below the repayment of 11 000.
const INSTALLMENT_AMOUNT: u64 = 3_000;

/// The loan's messages: the borrower's in the terms, the lender's on the acceptance's principal
/// and the borrower's on the installment. Each has a newline and two have characters beyond
/// ASCII, so that the web reads them as UTF-8 text with their lines.
const CREATION_MESSAGE: &str = "Collateral from my savings.\nI repay early when I can — 🙂";
const ACCEPTANCE_MESSAGE: &str = "Accepted, thank you.\nПлатіть вчасно, будь ласка.";
const INSTALLMENT_MESSAGE: &str = "The first installment.\nThe rest next month.";

/// How many offers the writer creates, at most, to find one whose `A` has the other prefix bit:
/// each has it with probability 1/2.
const MAX_OTHER_OFFERS: usize = 16;

/// The value blinders of the witness vectors' installment and zero debt `k·G`: fixed, so that the
/// contract's check of the fixture gives the same vectors, and not palindromes, so that the web's
/// check of a reversed key spends with another key.
const VECTOR_INSTALLMENT_BLINDER: [u8; 32] = counting_from(0x50);
const VECTOR_ZERO_DEBT_BLINDER: [u8; 32] = counting_from(0x60);

/// The 32 bytes that count up from `first`.
const fn counting_from(first: u8) -> [u8; 32] {
    let mut bytes = [0; 32];
    let mut i = 0;
    while i < 32 {
        bytes[i] = first + i as u8;
        i += 1;
    }
    bytes
}

/// The installment transaction's output that holds the successor loan, and the one that pays the
/// installment.
const INSTALLMENT_LOAN_OUTPUT: usize = 1;
const INSTALLMENT_OUTPUT: usize = 2;

/// The transactions of the fixture, all from regtest.
struct FixtureTransactions {
    creation: Transaction,
    acceptance: Transaction,
    installment: Transaction,
    /// The creation of the second offer, whose `A` has the other prefix bit.
    other_creation: Transaction,
}

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

/// A value blinder of `bytes`.
fn blinder(bytes: [u8; 32]) -> ValueBlindingFactor {
    ValueBlindingFactor::from_slice(&bytes).expect("a scalar below the curve order")
}

/// The witness vector of `branch` on input `input_index` of a spend of `prevouts` into `outputs`:
/// the transactions, and the serialized witness that running the program of `loan`, the active
/// offer the spend takes, gives, which the web's witness of the same values must equal. It also
/// carries the loan's debt hash, at which the web takes the program's spend info.
fn witness_vector(
    loan: &PrivateLendingOffer,
    prevouts: Vec<TxOut>,
    outputs: Vec<TxOut>,
    lock_time: u32,
    input_index: usize,
    branch: PrivateLendingWitnessBranch,
) -> Value {
    let prevouts = prevouts_tx(prevouts);
    let pset = spend(&prevouts, outputs, lock_time);
    let stack = loan
        .get_program()
        .finalize(
            &pset,
            &branch.build_witness().build_witness(),
            input_index,
            &loan.get_parameters().network,
        )
        .expect("the program accepts the synthetic spend");

    json!({
        "prevouts_tx": hex::encode(serialize(&prevouts)),
        "tx": hex::encode(serialize(&pset.extract_tx().expect("a complete transaction"))),
        "input_index": input_index,
        "witness": hex::encode(&stack[0]),
        "debt_hash": hex::encode(loan.get_debt_hash()),
    })
}

/// The witness vectors of the installment, the full repayment, the zero-debt close and the
/// liquidation of the loan the offer of `parameters` starts. The installment, the full repayment
/// and the liquidation spend the loan at acceptance, whose debt is `D₀`; the zero-debt close
/// spends the loan after an installment that left the debt `k·G`, which owes nothing.
fn witness_vectors(parameters: &PrivateLendingParameters) -> Value {
    let pinned = parameters.pinned;
    let active = PrivateLendingOffer::new_active(*parameters);
    let anyone = Script::from(vec![0x51]);
    let burn = Script::new_op_return(b"burn");
    let loan = pinned_output(pinned.active_collateral, active.get_script_pubkey());
    let debt = active.get_debt();
    let debt_hash = active.get_debt_hash();
    let expiry = parameters.loan_expiration_time;

    // the installment passes the borrower NFT to output 0, puts the successor loan at `D₀ − V`
    // with the collateral after one step at output 1, and pays `V` to the installment lock at
    // output 2
    let payment = PinnedOutput {
        amount: INSTALLMENT_AMOUNT,
        value_blinding_factor: blinder(VECTOR_INSTALLMENT_BLINDER),
        ..pinned.repayment
    };
    let debt_left = debt_after(&debt, &payment.value_commitment()).expect("debt is left");
    let successor = PrivateLendingOffer::new_active_at(*parameters, debt_left, 1);
    let mut installment = witness_vector(
        &active,
        vec![
            explicit_output(parameters.borrower_nft_asset_id, 1, anyone.clone()),
            loan.clone(),
        ],
        vec![
            explicit_output(parameters.borrower_nft_asset_id, 1, anyone.clone()),
            pinned_output(successor.get_collateral(), successor.get_script_pubkey()),
            pinned_output(
                payment,
                parameters
                    .get_installment_output_asset_auth()
                    .get_script_pubkey(),
            ),
        ],
        0,
        1,
        PrivateLendingWitnessBranch::Installment { debt },
    );
    installment["debt"] = json!(hex::encode(serialize(&debt)));

    let full_repayment = witness_vector(
        &active,
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

    // the zero-debt close burns the borrower NFT at output 0 and reveals `k` at output 1. Its debt
    // `k·G` or `−k·G` has the other prefix bit than `D₀`, so that the vectors' debts take both.
    let k = blinder(VECTOR_ZERO_DEBT_BLINDER);
    let zero_debt = [k, -k]
        .map(|blinder| DebtOpening { amount: 0, blinder })
        .into_iter()
        .find(|opening| prefix_bit(&opening.commitment(&pinned.repayment)) != prefix_bit(&debt))
        .expect("k·G and −k·G have either prefix bit");
    let k = zero_debt_key(&zero_debt).expect("a zero debt of a nonzero blinder");
    let closed =
        PrivateLendingOffer::new_active_at(*parameters, zero_debt.commitment(&pinned.repayment), 1);
    let mut zero_debt_close = witness_vector(
        &closed,
        vec![
            explicit_output(parameters.borrower_nft_asset_id, 1, anyone.clone()),
            pinned_output(closed.get_collateral(), closed.get_script_pubkey()),
        ],
        vec![
            explicit_output(parameters.borrower_nft_asset_id, 1, burn.clone()),
            explicit_output(
                parameters.borrower_nft_asset_id,
                0,
                Script::new_op_return(&k),
            ),
        ],
        0,
        1,
        PrivateLendingWitnessBranch::ZeroDebtClose {
            debt: closed.get_debt(),
            key: k,
        },
    );
    zero_debt_close["debt"] = json!(hex::encode(serialize(&closed.get_debt())));
    zero_debt_close["k"] = json!(hex::encode(k));

    let mut liquidation = witness_vector(
        &active,
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
    liquidation["salt"] = json!(hex::encode(parameters.expiry_salt));
    liquidation["expiry"] = json!(expiry);

    json!({
        "installment": installment,
        "full_repayment": full_repayment,
        "zero_debt_close": zero_debt_close,
        "liquidation": liquidation,
    })
}

/// The contract's arguments of the offer of `parameters`, as the web takes them.
fn arguments_json(parameters: &PrivateLendingParameters) -> Value {
    let arguments = parameters.build_arguments();
    let (repayment_asset_prefix_bit, repayment_asset_x) = arguments.repayment_asset;

    json!({
        "borrower_nft_asset_id": hex::encode(arguments.borrower_nft_asset_id),
        "lender_nft_asset_id": hex::encode(arguments.lender_nft_asset_id),
        "pending_collateral_commitment": hex::encode(arguments.pending_collateral_commitment),
        "active_collateral_commitment": hex::encode(arguments.active_collateral_commitment),
        "principal_commitment": hex::encode(arguments.principal_commitment),
        "repayment_commitment": hex::encode(arguments.repayment_commitment),
        "expiry_hash": hex::encode(arguments.expiry_hash),
        "repayment_asset_prefix_bit": u8::from(repayment_asset_prefix_bit),
        "repayment_asset_x": hex::encode(repayment_asset_x),
    })
}

/// The second offer: its creation transaction, arguments and scripts.
fn other_offer_json(parameters: &PrivateLendingParameters, creation_tx: &Transaction) -> Value {
    let pending = PrivateLendingOffer::new_pending(*parameters);
    let active = PrivateLendingOffer::new_active(*parameters);
    let lender_nft_lock = ScriptAuth::from_simplex_program(&pending);

    json!({
        "creation_tx": hex::encode(serialize(creation_tx)),
        "arguments": arguments_json(parameters),
        "pending_offer_script_pubkey": hex::encode(pending.get_script_pubkey().as_bytes()),
        "active_offer_script_pubkey": hex::encode(active.get_script_pubkey().as_bytes()),
        "lender_nft_script_pubkey": hex::encode(lender_nft_lock.get_script_pubkey().as_bytes()),
    })
}

/// The loan of the offer of `parameters` after its acceptance and one installment: the
/// transactions, the installment's amount as the lender opens it, and for each loan output (the
/// acceptance's, then the installment's) the debt hash its storage holds and its script. The debt
/// after the installment comes from the chain, `D₀ − V`, and the scripts from the contract.
fn loan_json(
    parameters: &PrivateLendingParameters,
    acceptance: &Transaction,
    installment: &Transaction,
) -> anyhow::Result<Value> {
    let repayment = parameters.pinned.repayment;
    let paid = &installment.output[INSTALLMENT_OUTPUT];
    let debt = debt_after(&repayment.value_commitment(), &paid.value)?;
    let nonce = paid
        .nonce
        .commitment()
        .ok_or_else(|| anyhow::anyhow!("the installment has no nonce"))?;
    let lender = LendingKey::from_master_blinding_key(&LENDER_MASTER_BLINDING_KEY);
    let shared_secret = OfferSecrets::for_lender(&lender, &nonce).shared_secret();
    let amount = open_installment(paid, shared_secret, &repayment)?.amount;
    let loans = [
        PrivateLendingOffer::new_active(*parameters),
        PrivateLendingOffer::new_active_at(*parameters, debt, 1),
    ];
    let installment_txid = installment.txid();

    Ok(json!({
        "acceptance_tx": hex::encode(serialize(acceptance)),
        "installment_txs": [hex::encode(serialize(installment))],
        "installment_outpoint": format!("{installment_txid}:{INSTALLMENT_OUTPUT}"),
        "installment_amount": amount,
        "remaining": repayment.amount - amount,
        "loan_outpoint": format!("{installment_txid}:{INSTALLMENT_LOAN_OUTPUT}"),
        "debt_commitment": hex::encode(serialize(&debt)),
        "debt_hashes": loans.each_ref().map(|loan| hex::encode(loan.get_debt_hash())),
        "loan_script_pubkeys":
            loans.each_ref().map(|loan| hex::encode(loan.get_script_pubkey().as_bytes())),
    }))
}

/// The fixture that the contract's values give for the offers of `parameters` and
/// `other_parameters` and the transactions `txs`.
fn expected_fixture(
    parameters: &PrivateLendingParameters,
    other_parameters: &PrivateLendingParameters,
    txs: &FixtureTransactions,
) -> anyhow::Result<Value> {
    let pending = PrivateLendingOffer::new_pending(*parameters);
    let active = PrivateLendingOffer::new_active(*parameters);
    let lender_nft_lock = ScriptAuth::from_simplex_program(&pending);

    Ok(json!({
        "borrower_master_blinding_key": hex::encode(BORROWER_MASTER_BLINDING_KEY),
        "lender_master_blinding_key": hex::encode(LENDER_MASTER_BLINDING_KEY),
        "program_id": hex::encode(PrivateLendingOffer::get_program_id()),
        "creation_tx": hex::encode(serialize(&txs.creation)),
        "arguments": arguments_json(parameters),
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
        "loan": loan_json(parameters, &txs.acceptance, &txs.installment)?,
        "messages": {
            "creation": CREATION_MESSAGE,
            "acceptance": ACCEPTANCE_MESSAGE,
            "installment": INSTALLMENT_MESSAGE,
        },
        "other_offer": other_offer_json(other_parameters, &txs.other_creation),
    }))
}

/// The low bit of the prefix of the offer's `A`.
fn repayment_asset_bit(parameters: &PrivateLendingParameters) -> u8 {
    prefix_bit(&parameters.pinned.repayment.asset_commitment())
}

/// An installment of [`INSTALLMENT_AMOUNT`] on `loan` whose blinder is searched off chain, so that
/// the debt it leaves, `D₁`, has the other prefix bit than the debt at acceptance, `D₀`.
fn installment_of_the_other_bit(loan: &Loan) -> anyhow::Result<DebtOpening> {
    let parameters = loan.parameters();
    let start = loan.offer.get_debt();

    loop {
        let payment = random_payment(INSTALLMENT_AMOUNT);
        let paid = repayment_output(&parameters, payment).value_commitment();
        if prefix_bit(&debt_after(&start, &paid)?) != prefix_bit(&start) {
            return Ok(payment);
        }
    }
}

/// Writes the fixture from fresh regtest offers, only when `WRITE_PARITY_FIXTURE` is set. Every
/// offer is created before the acceptance and the installment, so that the setup's explicit
/// transactions meet no confidential coin.
#[simplex::test]
fn write_private_lending_parity_fixture(context: simplex::TestContext) -> anyhow::Result<()> {
    if std::env::var_os("WRITE_PARITY_FIXTURE").is_none() {
        return Ok(());
    }

    let mut setup = setup_pending_private_offer_with(
        &context,
        default_offer_parameters(&context)?,
        Some(Message::text(CREATION_MESSAGE)?),
    )?;
    let parameters = setup.parameters;
    let offer_id = setup.creation_tx.txid();
    let mut other = None;
    for _ in 0..MAX_OTHER_OFFERS {
        let candidate = setup_pending_private_offer(&context, default_offer_parameters(&context)?)?;
        if repayment_asset_bit(&candidate.parameters) != repayment_asset_bit(&parameters) {
            other = Some(candidate);
            break;
        }
    }
    let other = other.ok_or_else(|| anyhow::anyhow!("no offer with the other prefix bit of A"))?;

    // the acceptance is blinded to the borrower's lending key, as the app blinds it, so that the
    // borrower reads the lender's message with it
    let lender = context.random_signer();
    let accepted = SignedMessage::sign(
        Message::text(ACCEPTANCE_MESSAGE)?,
        &setup.lender_lending_key,
        MessagePhase::Acceptance,
        &offer_id,
    )?;
    let borrower_key = borrower_blinding_key(&setup);
    let acceptance =
        accept_private_offer_with(&context, &mut setup, &lender, borrower_key, Some(&accepted))?;
    let loan = Loan::accepted(parameters, &acceptance);
    let payment = installment_of_the_other_bit(&loan)?;
    let paid = SignedMessage::sign(
        Message::text(INSTALLMENT_MESSAGE)?,
        &setup.borrower_lending_key,
        MessagePhase::Installment(1),
        &offer_id,
    )?;
    let (installment, _) = pay_installment_with(
        &setup,
        &loan,
        context.get_default_signer(),
        payment,
        Some(&paid),
    )?;

    let txs = FixtureTransactions {
        creation: setup.creation_tx,
        acceptance,
        installment,
        other_creation: other.creation_tx,
    };
    let fixture = expected_fixture(&parameters, &other.parameters, &txs)?;
    std::fs::write(
        FIXTURE_PATH,
        format!("{}\n", serde_json::to_string_pretty(&fixture)?),
    )?;

    Ok(())
}

/// The transaction at `field` of `fixture`, hex.
fn transaction_at(fixture: &Value, field: &str) -> anyhow::Result<Transaction> {
    let hex = fixture
        .pointer(field)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("the fixture has no {field}"))?;

    Ok(deserialize(&hex::decode(hex)?)?)
}

#[simplex::test]
fn parity_fixture_verifies_against_the_contract(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let network: SimplicityNetwork = *context.get_network();
    let fixture: Value = serde_json::from_str(FIXTURE)?;
    let txs = FixtureTransactions {
        creation: transaction_at(&fixture, "/creation_tx")?,
        acceptance: transaction_at(&fixture, "/loan/acceptance_tx")?,
        installment: transaction_at(&fixture, "/loan/installment_txs/0")?,
        other_creation: transaction_at(&fixture, "/other_offer/creation_tx")?,
    };
    let lender = LendingKey::from_master_blinding_key(&LENDER_MASTER_BLINDING_KEY);
    let borrower = LendingKey::from_master_blinding_key(&BORROWER_MASTER_BLINDING_KEY);

    let (as_lender, lender_parameters) = verify_offer_as_lender(&lender, &txs.creation, network)?;
    let (as_borrower, borrower_parameters) =
        verify_offer_as_borrower(&borrower, &txs.creation, network)?;
    assert_eq!(lender_parameters, borrower_parameters);
    let (other_offer, other_parameters) =
        verify_offer_as_lender(&lender, &txs.other_creation, network)?;
    let (_, other_as_borrower) = verify_offer_as_borrower(&borrower, &txs.other_creation, network)?;
    assert_eq!(other_parameters, other_as_borrower);

    // the arguments, script hashes, script pubkeys, program id and the loan's values
    assert_eq!(
        fixture,
        expected_fixture(&lender_parameters, &other_parameters, &txs)?
    );

    // the outputs of the creation transactions are the ones the fixture names
    let script_pubkey_at =
        |tx: &Transaction, vout: usize| hex::encode(tx.output[vout].script_pubkey.as_bytes());
    assert_eq!(
        script_pubkey_at(&txs.creation, 3),
        fixture["pending_offer_script_pubkey"]
    );
    assert_eq!(
        script_pubkey_at(&txs.creation, 1),
        fixture["lender_nft_script_pubkey"]
    );
    let other = &fixture["other_offer"];
    assert_eq!(
        script_pubkey_at(&txs.other_creation, 3),
        other["pending_offer_script_pubkey"]
    );
    assert_eq!(
        script_pubkey_at(&txs.other_creation, 1),
        other["lender_nft_script_pubkey"]
    );

    // the loan on chain: the acceptance's output 0 and the installment's output 1, which spends
    // it, are at the scripts the contract gives for their debts
    let loan = &fixture["loan"];
    assert_eq!(
        script_pubkey_at(&txs.acceptance, 0),
        loan["loan_script_pubkeys"][0]
    );
    assert_eq!(
        script_pubkey_at(&txs.installment, INSTALLMENT_LOAN_OUTPUT),
        loan["loan_script_pubkeys"][1]
    );
    assert_eq!(
        txs.installment.input[1].previous_output,
        OutPoint::new(txs.acceptance.txid(), 0)
    );
    assert_eq!(
        loan["debt_hashes"][0],
        fixture["arguments"]["repayment_commitment"]
    );

    // both prefix bits occur: of `A` across the two offers, and of the debt before and after the
    // installment
    assert_ne!(
        repayment_asset_bit(&lender_parameters),
        repayment_asset_bit(&other_parameters)
    );
    let start = lender_parameters.pinned.repayment.value_commitment();
    let debt = debt_after(&start, &txs.installment.output[INSTALLMENT_OUTPUT].value)?;
    assert_ne!(prefix_bit(&start), prefix_bit(&debt));
    assert_eq!(
        hex::encode(debt_hash(
            &lender_parameters.pinned.repayment.asset_commitment(),
            &debt
        )),
        loan["debt_hashes"][1]
    );

    // the messages on chain are the fixture's, each signed for its phase of this offer
    let offer_id = txs.creation.txid();
    for opened in [&as_lender, &as_borrower] {
        let message = opened.signed_terms.message.as_ref().map(Message::as_text);
        assert_eq!(message, Some(CREATION_MESSAGE));
    }
    assert_eq!(other_offer.signed_terms.message, None);
    let read = |extra_data: &[u8], sender: &LendingKey, phase| -> anyhow::Result<String> {
        let signed = SignedMessage::decode(extra_data)?
            .ok_or_else(|| anyhow::anyhow!("the output carries no message"))?;
        signed.verify(&sender.x_only_public_key(), phase, &offer_id)?;
        Ok(signed.message.as_text().to_owned())
    };
    let shared_secret = |key: &LendingKey, output: &TxOut| {
        let nonce = output.nonce.commitment().expect("a confidential output");
        OfferSecrets::for_lender(key, &nonce).shared_secret()
    };
    let principal = &txs.acceptance.output[1];
    let (_, accepted) = rewind(principal, shared_secret(&borrower, principal))?;
    assert_eq!(
        read(&accepted, &lender, MessagePhase::Acceptance)?,
        ACCEPTANCE_MESSAGE
    );
    let paid = &txs.installment.output[INSTALLMENT_OUTPUT];
    let (_, installment) = open_installment_with_extra_data(
        paid,
        shared_secret(&lender, paid),
        &lender_parameters.pinned.repayment,
    )?;
    assert_eq!(
        read(&installment, &borrower, MessagePhase::Installment(1))?,
        INSTALLMENT_MESSAGE
    );

    Ok(())
}
