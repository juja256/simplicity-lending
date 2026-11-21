//! The release proof's jets differential: the real program's installment branch, run on synthetic
//! installments whose proofs come from the core's `prove`, honest and tampered, must give the
//! verdict of the core's `verify` (with equation M by `fold_path`) on each. Every check of the
//! branch outside the proof passes in every case, so the program's verdict is the proof's. The
//! statement's points are read from the synthetic transaction's outputs, as the program reads
//! them. These need no chain, only the network, which they take from simplex's test context so
//! that `simplex test` runs them.

use std::collections::HashSet;

use simplex::either::Either::{Left, Right};
use simplex::program::{ProgramError, ProgramTrait, WitnessTrait};
use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::confidential::{
    Asset, AssetBlindingFactor, Nonce, Value, ValueBlindingFactor,
};
use simplex::simplicityhl::elements::encode::serialize;
use simplex::simplicityhl::elements::hashes::{HashEngine, sha256};
use simplex::simplicityhl::elements::pset::PartiallySignedTransaction;
use simplex::simplicityhl::elements::secp256k1_zkp::{PublicKey, SECP256K1, Scalar, SecretKey};
use simplex::simplicityhl::elements::{
    AssetId, LockTime, OutPoint, Script, Sequence, Transaction, TxIn, TxOut, TxOutWitness, Txid,
    hashes::Hash,
};

use lending_contracts::artifacts::private_lending::derived_private_lending::PrivateLendingWitness;
use lending_contracts::programs::private_lending::{
    InstallmentRelease, PrivateLendingOffer, PrivateLendingParameters, PrivateLendingWitnessBranch,
};
use lending_contracts::programs::program::SimplexProgram;
use lending_contracts::utils::confidential::ConfidentialTransaction;
use lending_contracts::utils::confidential::PinnedOutput;
use private_lending_core::{
    BlinderTree, DebtOpening, LEAF_IV, LendingKey, MAX_STEPS, NewOffer, OfferSecrets, OfferTerms,
    ReleaseProof, ReleaseSecrets, ReleaseStatement, carry_remainder, collateral_at, debt_after,
    fold_path, prove, verify,
};
use simplex::transaction::UTXO;

use super::setup::{blinder_commitment, statement_of};

/// The installment's loan input.
const LOAN_INPUT: usize = 1;

fn asset(byte: u8) -> AssetId {
    AssetId::from_slice(&[byte; 32]).expect("32 bytes")
}

fn random_vbf() -> ValueBlindingFactor {
    ValueBlindingFactor::new(&mut rand::thread_rng())
}

fn random_abf() -> AssetBlindingFactor {
    AssetBlindingFactor::new(&mut rand::thread_rng())
}

/// An explicit output of `amount` of `asset` to `script`.
fn explicit(asset: AssetId, amount: u64, script: Script) -> TxOut {
    TxOut {
        asset: Asset::Explicit(asset),
        value: Value::Explicit(amount),
        nonce: Nonce::Null,
        script_pubkey: script,
        witness: TxOutWitness::default(),
    }
}

/// The commitments of `pinned` at `script`, without proofs: the program reads only commitments.
fn pinned(pinned: PinnedOutput, script: Script) -> TxOut {
    TxOut {
        asset: pinned.asset_commitment(),
        value: pinned.value_commitment(),
        nonce: Nonce::Null,
        script_pubkey: script,
        witness: TxOutWitness::default(),
    }
}

/// A loan of `C = 3,001` and `R = 11,000` built off chain, with its offer's secrets and its
/// borrower's lending key.
struct OffChainLoan {
    parameters: PrivateLendingParameters,
    secrets: OfferSecrets,
    borrower: LendingKey,
    tree: BlinderTree,
}

impl OffChainLoan {
    fn new(network: SimplicityNetwork) -> OffChainLoan {
        let borrower = LendingKey::from_master_blinding_key(&[1; 32]);
        let lender = LendingKey::from_master_blinding_key(&[2; 32]);
        let first_input = OutPoint::new(Txid::from_byte_array([0xee; 32]), 0);
        let terms = OfferTerms {
            principal_asset: asset(0xaa),
            principal_amount: 10_000,
            repayment_amount: 11_000,
            interest_rate_bps: 1_000,
            loan_expiration_time: 1_000,
            borrower_nft: asset(0x44),
            lender_nft: asset(0x55),
        };
        let new_offer = NewOffer::build(
            &borrower,
            &lender.x_only_public_key(),
            &first_input,
            PrivateLendingOffer::get_program_id(),
            asset(0xcc),
            3_001,
            terms,
            None,
        )
        .expect("the terms are valid");
        let parameters = PrivateLendingParameters::from_terms(
            &terms,
            new_offer.pinned,
            &new_offer.secrets,
            network,
        );

        OffChainLoan {
            parameters,
            secrets: new_offer.secrets,
            borrower,
            tree: BlinderTree::new(&new_offer.secrets),
        }
    }

    fn collateral(&self) -> u64 {
        self.parameters.pinned.active_collateral.amount
    }

    fn repayment(&self) -> u64 {
        self.parameters.pinned.repayment.amount
    }

    /// The honest installment at `step` of a loan that owes `debt`, paying `payment`, with random
    /// blinders for the debt, the payment and the carries.
    fn installment(&self, step: u32, debt: u64, payment: u64) -> Installment {
        self.installment_holding(step, debt, payment, 0)
    }

    /// [`Self::installment`] whose successor holds `extra` units more than `c'`, under the step's
    /// blinders, proved with the honest secrets: E2 alone fails when `extra` is not 0.
    fn installment_holding(&self, step: u32, debt: u64, payment: u64, extra: i64) -> Installment {
        let pinned = self.parameters.pinned;
        let (collateral, full) = (self.collateral(), self.repayment());
        let debt = if step == 0 {
            DebtOpening::of(&pinned.repayment)
        } else {
            DebtOpening {
                amount: debt,
                blinder: random_vbf(),
            }
        };
        let payment = DebtOpening {
            amount: payment,
            blinder: random_vbf(),
        };
        let debt_left = debt.after(payment).expect("part of the debt is left");
        let e = carry_remainder(debt_left.amount, collateral, full);
        let carries = [e + 1, full - e].map(|amount| PinnedOutput {
            asset_id: asset(0xee),
            amount,
            asset_blinding_factor: random_abf(),
            value_blinding_factor: random_vbf(),
        });
        let (x, y) = self.secrets.release_blinders(step + 1);

        let mut installment = Installment {
            step,
            debt,
            payment: PinnedOutput {
                amount: payment.amount,
                value_blinding_factor: payment.blinder,
                ..pinned.repayment
            },
            successor: self.parameters.loan_collateral(
                &self.secrets,
                step + 1,
                collateral_at(debt_left.amount, collateral, full)
                    .checked_add_signed(extra)
                    .expect("a successor amount"),
            ),
            carries,
            y: blinder_commitment(&x, &y),
            proof: ReleaseProof {
                t: [blinder_commitment(&x, &y); 7],
                z: [Scalar::ZERO; 11],
            },
        };
        let secrets = ReleaseSecrets::new(
            &pinned.active_collateral,
            &pinned.repayment,
            debt_left,
            (x, y),
            (
                carries[0].value_blinding_factor,
                carries[1].value_blinding_factor,
            ),
        );
        installment.proof = prove(&installment.statement(self), &secrets, &self.borrower);

        installment
    }

    /// The loan's state before `installment`: the offer at its debt and step, and its output,
    /// holding the collateral the debt gives.
    fn loan(&self, installment: &Installment) -> (PrivateLendingOffer, TxOut) {
        let repayment = self.parameters.pinned.repayment;
        let debt = installment.debt.commitment(&repayment);
        let offer = PrivateLendingOffer::new_active_at(self.parameters, debt, installment.step);
        let held = collateral_at(installment.debt.amount, self.collateral(), self.repayment());
        let collateral = self
            .parameters
            .loan_collateral(&self.secrets, installment.step, held);

        let txout = pinned(collateral, offer.get_script_pubkey());

        (offer, txout)
    }

    /// The synthetic transaction of `installment`: inputs 0 the borrower NFT and 1 the loan;
    /// outputs 0 the borrower NFT, 1 the successor at the storage of `D − V`, 2 the installment,
    /// 3 and 4 the carries. Every check of the installment branch outside the proof passes.
    fn transaction(&self, installment: &Installment) -> PartiallySignedTransaction {
        let parameters = self.parameters;
        let (_, loan) = self.loan(installment);
        let debt = installment.debt.commitment(&parameters.pinned.repayment);
        let debt_left = debt_after(&debt, &installment.payment.value_commitment())
            .expect("the installment leaves a debt");
        let successor =
            PrivateLendingOffer::new_active_at(parameters, debt_left, installment.step + 1);
        let anyone = Script::from(vec![0x51]);
        let carry_lock = parameters
            .get_principal_output_asset_auth()
            .get_script_pubkey();
        let prevouts = vec![
            explicit(parameters.borrower_nft_asset_id, 1, anyone.clone()),
            loan,
        ];
        let outputs = vec![
            explicit(parameters.borrower_nft_asset_id, 1, anyone),
            pinned(installment.successor, successor.get_script_pubkey()),
            pinned(
                installment.payment,
                parameters
                    .get_installment_output_asset_auth()
                    .get_script_pubkey(),
            ),
            pinned(installment.carries[0], carry_lock.clone()),
            pinned(installment.carries[1], carry_lock),
        ];

        spend(prevouts, outputs)
    }
}

/// A spend of `prevouts`, in order, into `outputs`, as a PSET whose inputs carry their prevouts.
fn spend(prevouts: Vec<TxOut>, outputs: Vec<TxOut>) -> PartiallySignedTransaction {
    let funding = Transaction {
        version: 2,
        lock_time: LockTime::ZERO,
        input: vec![TxIn::default()],
        output: prevouts.clone(),
    };
    let tx = Transaction {
        version: 2,
        lock_time: LockTime::ZERO,
        input: (0..prevouts.len())
            .map(|vout| TxIn {
                previous_output: OutPoint::new(funding.txid(), vout as u32),
                sequence: Sequence::ENABLE_LOCKTIME_NO_RBF,
                ..Default::default()
            })
            .collect(),
        output: outputs,
    };
    let mut pset = PartiallySignedTransaction::from_tx(tx);
    for (input, prevout) in pset.inputs_mut().iter_mut().zip(prevouts) {
        input.witness_utxo = Some(prevout);
    }

    pset
}

/// An installment's parts that the proof covers.
#[derive(Clone, Copy)]
struct Installment {
    step: u32,
    debt: DebtOpening,
    payment: PinnedOutput,
    successor: PinnedOutput,
    carries: [PinnedOutput; 2],
    y: PublicKey,
    proof: ReleaseProof,
}

impl Installment {
    fn statement(&self, loan: &OffChainLoan) -> ReleaseStatement {
        let [first, second] = self.carries;

        statement_of(
            &loan.parameters,
            &self.debt.commitment(&loan.parameters.pinned.repayment),
            &self.payment.value_commitment(),
            &self.successor.value_commitment(),
            [
                (first.asset_commitment(), first.value_commitment()),
                (second.asset_commitment(), second.value_commitment()),
            ],
            self.y,
        )
    }

    fn witness(&self, loan: &OffChainLoan) -> Box<PrivateLendingWitness> {
        PrivateLendingWitnessBranch::Installment {
            debt: self.debt.commitment(&loan.parameters.pinned.repayment),
            step: self.step,
            blinder_commitment: self.y,
            path: loan.tree.path(self.step),
            proof: self.proof,
        }
        .build_witness()
    }
}

/// `compress(LEAF_IV, Y.x, Y.y)`.
fn leaf(y: &PublicKey) -> [u8; 32] {
    let uncompressed = y.serialize_uncompressed();
    let mut engine =
        sha256::HashEngine::from_midstate(sha256::Midstate::from_byte_array(LEAF_IV), 0);
    engine.input(&uncompressed[1..]);

    engine.midstate().to_byte_array()
}

/// The core's verdict on the installment `pset` carries: `verify` of the statement read from its
/// outputs, and equation M by `fold_path`.
fn rust_accepts(
    loan: &OffChainLoan,
    installment: &Installment,
    pset: &PartiallySignedTransaction,
) -> bool {
    let tx = pset.extract_tx().expect("a complete transaction");
    let [successor, paid, first, second] = [1, 2, 3, 4].map(|index| &tx.output[index]);
    let statement = statement_of(
        &loan.parameters,
        &installment
            .debt
            .commitment(&loan.parameters.pinned.repayment),
        &paid.value,
        &successor.value,
        [(first.asset, first.value), (second.asset, second.value)],
        installment.y,
    );

    verify(&statement, &installment.proof, &loan.parameters.fs_iv())
        && fold_path(leaf(&installment.y), &loan.tree.path(installment.step))
            == (loan.tree.root(), installment.step)
}

/// The program's verdict: whether the loan input's program runs to the end on `pset` with
/// `witness`. A failure to load the program or to find its address is a fault of the test.
fn program_accepts(
    loan: &OffChainLoan,
    installment: &Installment,
    pset: &PartiallySignedTransaction,
    witness: &PrivateLendingWitness,
) -> bool {
    let (offer, _) = loan.loan(installment);

    match offer.get_program().execute(
        pset,
        &witness.build_witness(),
        LOAN_INPUT,
        &loan.parameters.network,
    ) {
        Ok(_) => true,
        Err(ProgramError::Pruning(_) | ProgramError::Execution(_)) => false,
        Err(error) => panic!("the program did not run: {error}"),
    }
}

/// Runs the case and asserts that both verdicts are `expected`.
fn assert_verdicts(
    name: &str,
    loan: &OffChainLoan,
    installment: &Installment,
    pset: &PartiallySignedTransaction,
    expected: bool,
) {
    let rust = rust_accepts(loan, installment, pset);
    let program = program_accepts(loan, installment, pset, &installment.witness(loan));
    println!("{name}: verify {rust}, program {program}");

    assert_eq!(rust, program, "{name}: the program and verify disagree");
    assert_eq!(rust, expected, "{name}: expected {expected}");
}

fn plus_one(scalar: &Scalar) -> Scalar {
    let one = SecretKey::from_slice(&Scalar::ONE.to_be_bytes()).expect("one");

    match SecretKey::from_slice(&scalar.to_be_bytes()) {
        Ok(key) => Scalar::from(key.add_tweak(&Scalar::ONE).expect("not n − 1")),
        // zero
        Err(_) => Scalar::from(one),
    }
}

/// The honest proof at the first and at a later step; each response one more; each commitment
/// plus `G`; each of the statement's points that the transaction carries changed after the proof;
/// and a successor of `c' + 1` proved with `c'`, which only V2 refuses: the program and the core
/// agree on every one.
#[simplex::test]
fn the_program_and_verify_agree_on_tampered_proofs(context: simplex::TestContext) {
    let loan = OffChainLoan::new(*context.get_network());

    for (step, debt, payment) in [(0, 11_000, 3_999), (3, 9_000, 1_234)] {
        let honest = loan.installment(step, debt, payment);
        let pset = loan.transaction(&honest);
        assert_verdicts(
            &format!("honest at step {step}"),
            &loan,
            &honest,
            &pset,
            true,
        );

        for m in 0..11 {
            let mut tampered = honest;
            tampered.proof.z[m] = plus_one(&tampered.proof.z[m]);
            assert_verdicts(&format!("z[{m}] + 1"), &loan, &tampered, &pset, false);
        }

        for j in 0..7 {
            let mut tampered = honest;
            tampered.proof.t[j] = tampered.proof.t[j]
                .add_exp_tweak(SECP256K1, &Scalar::ONE)
                .expect("not −G");
            assert_verdicts(&format!("T{} + G", j + 1), &loan, &tampered, &pset, false);
        }

        // the outputs change under the proof: V_s, W1, A_w1, W2, A_w2, and V (so D')
        let mut cases: Vec<(&str, Installment)> = Vec::new();
        let mut successor = honest;
        successor.successor.value_blinding_factor = random_vbf();
        cases.push(("V_s", successor));
        for (carry, names) in [(0, ["W1", "A_w1"]), (1, ["W2", "A_w2"])] {
            let mut value = honest;
            value.carries[carry].value_blinding_factor = random_vbf();
            cases.push((names[0], value));
            let mut asset = honest;
            asset.carries[carry].asset_blinding_factor = random_abf();
            cases.push((names[1], asset));
        }
        let mut paid = honest;
        paid.payment.value_blinding_factor = random_vbf();
        cases.push(("V, and so D'", paid));
        for (name, tampered) in cases {
            let pset = loan.transaction(&tampered);
            assert_verdicts(&format!("{name} changed"), &loan, &tampered, &pset, false);
        }

        // output 1 holds c' + 1 under the step's blinder, and the proof is of that statement with
        // the honest c': E3 and E7 hold, and only V2 ties V_s to the proved c'
        let unproved = loan.installment_holding(step, debt, payment, 1);
        let unproved_pset = loan.transaction(&unproved);
        assert_verdicts(
            "V_s of c' + 1, proved with c'",
            &loan,
            &unproved,
            &unproved_pset,
            false,
        );

        // Y, which the tree binds
        let mut moved = honest;
        moved.y = moved
            .y
            .add_exp_tweak(SECP256K1, &Scalar::ONE)
            .expect("not −G");
        assert_verdicts("Y + G", &loan, &moved, &pset, false);
    }
}

/// Honest proofs whose transaction commitments, `D'`, `V_s`, `W1`, `A_w1`, `W2` and `A_w2`, take
/// both prefix bits: the program and the core accept every one.
#[simplex::test]
fn the_program_and_verify_agree_on_both_prefix_bits(context: simplex::TestContext) {
    let loan = OffChainLoan::new(*context.get_network());
    let mut seen: [HashSet<u8>; 6] = Default::default();

    for round in 0..64 {
        let step = round % 4;
        let honest = loan.installment(step, 9_000, 1 + u64::from(round));
        let pset = loan.transaction(&honest);
        assert_verdicts(
            &format!("honest, round {round}"),
            &loan,
            &honest,
            &pset,
            true,
        );

        let tx = pset.extract_tx().expect("a complete transaction");
        let debt = honest.debt.commitment(&loan.parameters.pinned.repayment);
        let bit = |encoding: Vec<u8>| encoding[0] & 1;
        for (bits, encoding) in seen.iter_mut().zip([
            serialize(&debt_after(&debt, &tx.output[2].value).expect("a debt")),
            serialize(&tx.output[1].value),
            serialize(&tx.output[3].value),
            serialize(&tx.output[3].asset),
            serialize(&tx.output[4].value),
            serialize(&tx.output[4].asset),
        ]) {
            bits.insert(bit(encoding));
        }
        if seen.iter().all(|bits| bits.len() == 2) {
            println!("both prefix bits after {} rounds", round + 1);
            return;
        }
    }

    panic!("the prefix bits seen: {seen:?}");
}

/// A `T` or a `Y` off the curve, its `y`'s last bit flipped, is refused. The core's points are
/// always on the curve, so this is the program's alone. It does not isolate the on-curve checks:
/// the changed bytes also change the challenge or the leaf, which fail on their own. The lib test
/// `program_checks_the_witness_points_on_the_curve` checks that the program calls them.
#[simplex::test]
fn the_program_refuses_points_off_the_curve(context: simplex::TestContext) {
    let loan = OffChainLoan::new(*context.get_network());
    let honest = loan.installment(0, 11_000, 3_999);
    let pset = loan.transaction(&honest);
    assert!(program_accepts(
        &loan,
        &honest,
        &pset,
        &honest.witness(&loan)
    ));

    let off_curve = |(x, mut y): ([u8; 32], [u8; 32])| {
        y[31] ^= 1;
        (x, y)
    };

    // T7, then Y
    for point in [4, 2] {
        let mut witness = *honest.witness(&loan);
        let Right(Left(Left(installment))) = &mut witness.path else {
            panic!("not an installment witness");
        };
        match point {
            4 => installment.4.6 = off_curve(installment.4.6),
            _ => installment.2 = off_curve(installment.2),
        }

        assert!(!program_accepts(&loan, &honest, &pset, &witness));
    }
}

/// The last step that has a leaf, 1023, whose Merkle path has every bit set: the honest
/// installment passes both verifiers, a response one more and a successor of `c' + 1` proved with
/// `c'` fail both.
#[simplex::test]
fn the_program_and_verify_agree_at_the_last_step(context: simplex::TestContext) {
    let loan = OffChainLoan::new(*context.get_network());
    let step = MAX_STEPS - 1;
    assert!(loan.tree.path(step).iter().all(|(is_right, _)| *is_right));

    let honest = loan.installment(step, 5_000, 100);
    let pset = loan.transaction(&honest);
    assert_verdicts("honest at step 1023", &loan, &honest, &pset, true);

    let mut tampered = honest;
    tampered.proof.z[3] = plus_one(&tampered.proof.z[3]);
    assert_verdicts("z[3] + 1 at step 1023", &loan, &tampered, &pset, false);

    let unproved = loan.installment_holding(step, 5_000, 100, 1);
    let unproved_pset = loan.transaction(&unproved);
    assert_verdicts(
        "V_s of c' + 1 at step 1023",
        &loan,
        &unproved,
        &unproved_pset,
        false,
    );
}

/// Step 1024 has no leaf for its successor's blinders: the witness refuses it.
#[simplex::test]
#[should_panic(expected = "A loan at step 1024 has no installment left")]
fn the_witness_refuses_step_1024(context: simplex::TestContext) {
    let loan = OffChainLoan::new(*context.get_network());
    let honest = loan.installment(0, 11_000, 3_999);

    PrivateLendingWitnessBranch::Installment {
        debt: honest.debt.commitment(&loan.parameters.pinned.repayment),
        step: MAX_STEPS,
        blinder_commitment: honest.y,
        path: loan.tree.path(0),
        proof: honest.proof,
    }
    .build_witness();
}

/// After 1024 installments the builder offers only the full repayment.
#[simplex::test]
#[should_panic(expected = "The loan has had 1024 installments: only the full repayment is left")]
fn the_builder_refuses_an_installment_at_step_1024(context: simplex::TestContext) {
    let loan = OffChainLoan::new(*context.get_network());
    let offer_pinned = loan.parameters.pinned;
    let offer = PrivateLendingOffer::new_active_at(
        loan.parameters,
        offer_pinned.repayment.value_commitment(),
        MAX_STEPS,
    );
    let coin = |vout: u32, txout: TxOut| UTXO {
        outpoint: OutPoint::new(Txid::from_byte_array([0xdd; 32]), vout),
        txout,
        secrets: None,
    };
    let anyone = Script::from(vec![0x51]);
    let key = SecretKey::from_slice(&[7; 32]).expect("a key");
    let public_key = simplex::simplicityhl::elements::bitcoin::PublicKey::new(
        PublicKey::from_secret_key(SECP256K1, &key),
    );

    offer.attach_installment(
        &mut ConfidentialTransaction::new(),
        coin(
            0,
            explicit(loan.parameters.borrower_nft_asset_id, 1, anyone.clone()),
        ),
        coin(
            1,
            pinned(offer_pinned.active_collateral, offer.get_script_pubkey()),
        ),
        anyone.clone(),
        offer_pinned.repayment.with_amount(1),
        public_key,
        key,
        None,
        InstallmentRelease {
            borrower: &loan.borrower,
            secrets: &loan.secrets,
            debt: DebtOpening::of(&offer_pinned.repayment),
            principal_coins: Vec::new(),
            carries: Vec::new(),
            release_receiver: anyone,
            release_blinding_key: public_key,
        },
    );
}
