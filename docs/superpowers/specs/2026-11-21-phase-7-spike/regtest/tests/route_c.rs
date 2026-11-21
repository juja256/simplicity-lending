//! P7 spike, route C on regtest: two installments that release collateral by
//! c' = ceil(d'·C/R), proved by a Sigma proof linked to two carry outputs (e', R − 1 − e') of an
//! issued worthless token, with the liquidation repair (Y_i Merkle root, equation (4)); then a
//! liquidation by a lender who could not read the installments. Throwaway code.

use std::collections::HashMap;

use k256::elliptic_curve::group::Curve;
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::point::AffineCoordinates;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::Field;
use k256::{AffinePoint, EncodedPoint, FieldBytes, FieldElement, ProjectivePoint, Scalar, U256};
use sha2::{Digest, Sha256};

use simplex::program::{ArgumentsTrait, Program, WitnessTrait};
use simplex::signer::Signer;
use simplex::simplicityhl::elements::confidential::{
    self, AssetBlindingFactor, ValueBlindingFactor,
};
use simplex::simplicityhl::elements::encode::serialize;
use simplex::simplicityhl::elements::secp256k1_zkp::{PublicKey, Secp256k1, SecretKey};
use simplex::simplicityhl::elements::{AssetId, OutPoint, Transaction};
use simplex::simplicityhl::simplicity::jet::Elements;
use simplex::simplicityhl::simplicity::{BitIter, RedeemNode};
use simplex::simplicityhl::{Arguments, WitnessValues};
use simplex::transaction::partial_input::IssuanceInput;
use simplex::transaction::{
    FinalTransaction, PartialInput, PartialOutput, ProgramInput, RequiredSignature, UTXO,
};

use lending_contracts::utils::confidential::{
    ConfidentialTransaction, PinnedOutputExt, wait_for_confirmation,
};
use lending_contracts::utils::get_random_seed;
use private_lending_core::{PinnedOutput, debt_after, debt_hash};

const HEAD: &str = include_str!("../simf/route_c_head.simf");
const TAIL: &str = include_str!("../simf/route_c_tail.simf");
const TREE_DEPTH: usize = 10;

// ------------------------------------------------------------------ k256 and encodings

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn w(b: &[u8]) -> String {
    format!("0x{}", hex(b))
}

fn scalar_of(bytes: &[u8]) -> Scalar {
    let fb: FieldBytes = *FieldBytes::from_slice(bytes);
    <Scalar as Reduce<U256>>::reduce_bytes(&fb)
}

fn sc(v: u128) -> Scalar {
    Scalar::from(v as u64) + Scalar::from((v >> 64) as u64) * Scalar::from(1u64 << 32) * Scalar::from(1u64 << 32)
}

fn vbf_scalar(v: &ValueBlindingFactor) -> Scalar {
    scalar_of(v.into_inner().as_ref())
}

fn abf_scalar(a: &AssetBlindingFactor) -> Scalar {
    scalar_of(a.into_inner().as_ref())
}

fn vbf_of(s: &Scalar) -> ValueBlindingFactor {
    ValueBlindingFactor::from_slice(&s.to_bytes()).unwrap()
}

fn abf_of(s: &Scalar) -> AssetBlindingFactor {
    AssetBlindingFactor::from_slice(&s.to_bytes()).unwrap()
}

/// The curve point of a commitment in Elements' encoding: the prefix bit is set when y is not a
/// square.
fn point_of(encoding: &[u8]) -> ProjectivePoint {
    assert_eq!(encoding.len(), 33);
    let mut even = [0u8; 33];
    even[0] = 2;
    even[1..].copy_from_slice(&encoding[1..]);
    let p = AffinePoint::from_encoded_point(&EncodedPoint::from_bytes(even).unwrap()).unwrap();
    let y = p.to_encoded_point(false);
    let y = FieldElement::from_bytes(FieldBytes::from_slice(y.y().unwrap())).unwrap();
    let square = bool::from(y.sqrt().is_some());
    let bit = encoding[0] & 1 == 1;
    if square != bit { p.into() } else { -ProjectivePoint::from(p) }
}

fn value_point(v: &confidential::Value) -> ProjectivePoint {
    point_of(&serialize(v))
}

fn asset_point(a: &confidential::Asset) -> ProjectivePoint {
    point_of(&serialize(a))
}

fn xy(p: &ProjectivePoint) -> ([u8; 32], [u8; 32]) {
    let e = p.to_affine().to_encoded_point(false);
    (e.x().unwrap().as_slice().try_into().unwrap(), e.y().unwrap().as_slice().try_into().unwrap())
}

fn ge(p: &ProjectivePoint) -> String {
    let (x, y) = xy(p);
    format!("({}, {})", w(&x), w(&y))
}

fn nums(tag: &str) -> ProjectivePoint {
    for i in 0u32.. {
        let mut h = Sha256::new();
        h.update(tag.as_bytes());
        h.update(i.to_be_bytes());
        let mut enc = [0u8; 33];
        enc[0] = 2;
        enc[1..].copy_from_slice(&h.finalize());
        if let Some(p) =
            Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&EncodedPoint::from_bytes(enc).unwrap()))
        {
            return p.into();
        }
    }
    unreachable!()
}

fn iv(tag: &str) -> [u8; 32] {
    Sha256::digest(tag.as_bytes()).into()
}

fn compress(state: &[u8; 32], a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut s = [0u32; 8];
    for i in 0..8 {
        s[i] = u32::from_be_bytes(state[4 * i..4 * i + 4].try_into().unwrap());
    }
    let mut blk = [0u8; 64];
    blk[..32].copy_from_slice(a);
    blk[32..].copy_from_slice(b);
    sha2::compress256(&mut s, &[blk.into()]);
    let mut out = [0u8; 32];
    for i in 0..8 {
        out[4 * i..4 * i + 4].copy_from_slice(&s[i].to_be_bytes());
    }
    out
}

fn absorb(h: &[u8; 32], p: &ProjectivePoint) -> [u8; 32] {
    let (x, y) = xy(p);
    compress(h, &x, &y)
}

// ------------------------------------------------------------------ the loan's constants

/// What both parties know of a loan, and the program's parameters.
#[derive(Clone)]
struct Loan {
    collateral_asset: AssetId,
    repayment_asset: AssetId,
    cap: u64,          // C
    repay: u64,        // R
    abf_c: Scalar,     // collateral asset blinder at acceptance
    vbf_c0: Scalar,    // rho
    abf_a: Scalar,     // repayment asset blinder (A)
    r0: Scalar,        // D0's blinder
    j: ProjectivePoint,
    xs: Vec<Scalar>,   // x_1..x_N (xs[i] = x_(i+1))
    ys: Vec<Scalar>,
    tree: Vec<Vec<[u8; 32]>>, // levels, leaves first
    carry_script_hash: [u8; 32],
}

impl Loan {
    fn active_collateral(&self) -> PinnedOutput {
        PinnedOutput {
            asset_id: self.collateral_asset,
            amount: self.cap,
            asset_blinding_factor: abf_of(&self.abf_c),
            value_blinding_factor: vbf_of(&self.vbf_c0),
        }
    }
    fn d0_pinned(&self) -> PinnedOutput {
        PinnedOutput {
            asset_id: self.repayment_asset,
            amount: self.repay,
            asset_blinding_factor: abf_of(&self.abf_a),
            value_blinding_factor: vbf_of(&self.r0),
        }
    }
    fn a(&self) -> confidential::Asset {
        self.d0_pinned().asset_commitment()
    }
    fn a_pt(&self) -> ProjectivePoint {
        asset_point(&self.a())
    }
    fn a_c_pt(&self) -> ProjectivePoint {
        asset_point(&self.active_collateral().asset_commitment())
    }
    fn v_c0_pt(&self) -> ProjectivePoint {
        value_point(&self.active_collateral().value_commitment())
    }
    fn d0(&self) -> confidential::Value {
        self.d0_pinned().value_commitment()
    }
    fn fs_iv(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        for p in [self.a_pt(), self.a_c_pt(), self.v_c0_pt(), value_point(&self.d0()), self.j] {
            let (x, y) = xy(&p);
            h.update(x);
            h.update(y);
        }
        h.finalize().into()
    }
    /// The collateral after `i` installments holding `amount`: asset blinder abf_c + i, and the
    /// value blinder that makes its G-coefficient over A_c equal x_i.
    fn collateral_at(&self, i: u32, amount: u64) -> PinnedOutput {
        let abf = self.abf_c + Scalar::from(u64::from(i));
        let vbf = if i == 0 {
            self.vbf_c0
        } else {
            self.xs[i as usize - 1] - Scalar::from(amount) * Scalar::from(u64::from(i))
        };
        PinnedOutput {
            asset_id: self.collateral_asset,
            amount,
            asset_blinding_factor: abf_of(&abf),
            value_blinding_factor: vbf_of(&vbf),
        }
    }
    fn y_point(&self, i: usize) -> ProjectivePoint {
        ProjectivePoint::GENERATOR * self.xs[i] + self.j * self.ys[i]
    }
    fn arguments(&self) -> String {
        let a = serialize(&self.a());
        let mut m = serde_json::Map::new();
        let root = self.tree.last().unwrap()[0];
        for (name, ty, val) in [
            ("REPAYMENT_ASSET", "(bool, u256)", format!("({}, {})", a[0] & 1 == 1, w(&a[1..]))),
            ("A_GE", "(u256, u256)", ge(&self.a_pt())),
            ("A_C_GE", "(u256, u256)", ge(&self.a_c_pt())),
            ("V_C0_GE", "(u256, u256)", ge(&self.v_c0_pt())),
            ("D0_GE", "(u256, u256)", ge(&value_point(&self.d0()))),
            ("J_GE", "(u256, u256)", ge(&self.j)),
            ("Y_ROOT", "u256", w(&root)),
            ("FS_IV", "u256", w(&self.fs_iv())),
            ("LEAF_IV", "u256", w(&iv("p7 leaf"))),
            ("NODE_IV", "u256", w(&iv("p7 node"))),
            ("CARRY_SCRIPT_HASH", "u256", w(&self.carry_script_hash)),
        ] {
            m.insert(name.into(), serde_json::json!({"value": val, "type": ty}));
        }
        serde_json::Value::Object(m).to_string()
    }
}

fn build_tree(loan: &mut Loan, n: usize) {
    let seed = get_random_seed();
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for i in 0..n {
        let mut hx = Sha256::new();
        hx.update(b"x");
        hx.update(seed);
        hx.update((i as u32).to_be_bytes());
        xs.push(scalar_of(&hx.finalize()));
        let mut hy = Sha256::new();
        hy.update(b"y");
        hy.update(seed);
        hy.update((i as u32).to_be_bytes());
        ys.push(scalar_of(&hy.finalize()));
    }
    loan.xs = xs;
    loan.ys = ys;
    let leaf_iv = iv("p7 leaf");
    let node_iv = iv("p7 node");
    let mut level: Vec<[u8; 32]> = (0..n).map(|i| absorb(&leaf_iv, &loan.y_point(i))).collect();
    let mut tree = vec![level.clone()];
    while level.len() > 1 {
        level = level.chunks(2).map(|c| compress(&node_iv, &c[0], &c[1])).collect();
        tree.push(level.clone());
    }
    loan.tree = tree;
}

fn merkle_path(loan: &Loan, mut index: usize) -> String {
    let mut steps = Vec::new();
    for level in &loan.tree[..TREE_DEPTH] {
        let is_right = index & 1 == 1;
        let sibling = level[index ^ 1];
        steps.push(format!("({}, {})", is_right, w(&sibling)));
        index >>= 1;
    }
    format!("[{}]", steps.join(", "))
}

// ------------------------------------------------------------------ the program

#[derive(Clone)]
struct JsonArgs(String);
impl ArgumentsTrait for JsonArgs {
    fn build_arguments(&self) -> Arguments {
        serde_json::from_str(&self.0).unwrap()
    }
}

#[derive(Clone)]
struct JsonWitness(String);
impl WitnessTrait for JsonWitness {
    fn build_witness(&self) -> WitnessValues {
        serde_json::from_str(&self.0).unwrap()
    }
}

fn program(loan: &Loan, debt: &confidential::Value) -> Program {
    let source: &'static str = Box::leak(format!("{HEAD}\n{TAIL}").into_boxed_str());
    let mut p = Program::new(source, Box::new(JsonArgs(loan.arguments()))).with_storage_capacity(2);
    let mut active = [0u8; 32];
    active[31] = 1;
    p.set_storage_at(0, active);
    p.set_storage_at(1, debt_hash(&loan.a(), debt));
    p
}

const PARAMS_TY: &str = "((bool, u256), u16, (u256, u256), [(bool, u256); 10], ((u256, u256), (u256, u256), (u256, u256), (u256, u256), (u256, u256), (u256, u256), (u256, u256)), ((u256, u256, u256, u256), (u256, u256, u256, u256), (u256, u256, u256)))";

fn witness_json(path_value: String) -> JsonWitness {
    let ty = format!("Either<{PARAMS_TY}, ()>");
    JsonWitness(serde_json::json!({"PATH": {"value": path_value, "type": ty}}).to_string())
}

// ------------------------------------------------------------------ the prover

/// The openings the borrower uses, as they are in the transaction.
struct Openings {
    debt_left: confidential::Value,
    d_left_blinder: Scalar, // r'
    successor: PinnedOutput,
    index: u32,             // i: the input's step; the successor is at i + 1
    claimed_index: u32,     // the index the witness claims (honest: index)
    leaf: usize,            // the leaf whose Y and path the witness carries (honest: index)
    y_override: Option<(ProjectivePoint, Scalar)>, // a self-made Y and its y
    w1: PinnedOutput,
    w2: PinnedOutput,
    e: u64,                 // the e the prover claims
}

fn prove(loan: &Loan, o: &Openings) -> String {
    let g = ProjectivePoint::GENERATOR;
    let mut rng = rand::thread_rng();
    let (a, a_c, v_c0, d0) = (loan.a_pt(), loan.a_c_pt(), loan.v_c0_pt(), value_point(&loan.d0()));
    let d_left = value_point(&o.debt_left);
    let v_s = value_point(&o.successor.value_commitment());
    let (w1, a_w1) = (value_point(&o.w1.value_commitment()), asset_point(&o.w1.asset_commitment()));
    let (w2, a_w2) = (value_point(&o.w2.value_commitment()), asset_point(&o.w2.asset_commitment()));
    let next = o.index as usize + 1;
    let (y_pt, y) = o.y_override.unwrap_or((loan.y_point(o.leaf), loan.ys[o.leaf]));

    // secrets
    let s_cap = Scalar::from(loan.cap);
    let rho = loan.vbf_c0;
    let s_c = Scalar::from(o.successor.amount);
    let x = Scalar::from(o.successor.amount) * Scalar::from(next as u64)
        + vbf_scalar(&o.successor.value_blinding_factor);
    let s_e = Scalar::from(o.e);
    let r_w1 = vbf_scalar(&o.w1.value_blinding_factor);
    let s_r = Scalar::from(loan.repay);
    let r0 = loan.r0;
    let r_w2 = vbf_scalar(&o.w2.value_blinding_factor);
    let tau = s_c * r0 - s_cap * o.d_left_blinder;

    let k: Vec<Scalar> = (0..11).map(|_| Scalar::random(&mut rng)).collect();
    let (k_cap, k_rho, k_c, k_x, k_y, k_e, k_w1, k_r, k_r0, k_w2, k_tau) =
        (k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7], k[8], k[9], k[10]);
    let t = [
        a_c * k_cap + g * k_rho,
        a_c * k_c + g * k_x,
        g * k_x + loan.j * k_y,
        a_w1 * k_e + g * k_w1,
        a * k_r + g * k_r0,
        a_w2 * (k_r - k_e) + g * k_w2,
        d0 * k_c - d_left * k_cap - a * k_e - g * k_tau,
    ];
    let mut h = loan.fs_iv();
    for p in [d_left, v_s, w1, a_w1, w2, a_w2, y_pt] {
        h = absorb(&h, &p);
    }
    for p in &t {
        h = absorb(&h, p);
    }
    let c = scalar_of(&h);
    let z: Vec<Scalar> = [
        (k_cap, s_cap), (k_rho, rho), (k_c, s_c), (k_x, x), (k_y, y), (k_e, s_e), (k_w1, r_w1),
        (k_r, s_r), (k_r0, r0), (k_w2, r_w2), (k_tau, tau),
    ]
    .iter()
    .map(|(k, s)| *k + c * s)
    .collect();
    let zs = |r: std::ops::Range<usize>| z[r].iter().map(|s| w(&s.to_bytes())).collect::<Vec<_>>().join(", ");

    let debt = serialize(&debt_value_before(o));
    let ts: Vec<String> = t.iter().map(ge).collect();
    format!(
        "Left((({}, {}), {}, {}, {}, ({}), (({}), ({}), ({}))))",
        debt[0] & 1 == 1,
        w(&debt[1..]),
        o.claimed_index,
        ge(&y_pt),
        merkle_path(loan, o.leaf),
        ts.join(", "),
        zs(0..4),
        zs(4..8),
        zs(8..11)
    )
}

thread_local! {
    static DEBT_BEFORE: std::cell::RefCell<Option<confidential::Value>> = const { std::cell::RefCell::new(None) };
}
fn debt_value_before(_o: &Openings) -> confidential::Value {
    DEBT_BEFORE.with(|d| d.borrow().unwrap())
}

// ------------------------------------------------------------------ chain helpers

fn issue(context: &simplex::TestContext, amount: u64) -> anyhow::Result<AssetId> {
    let signer = context.get_default_signer();
    let mut ft = FinalTransaction::new();
    let first = signer.get_utxos_asset(context.get_network().policy_asset())?[0].clone();
    let details = ft.add_issuance_input(
        PartialInput::new(first.clone()),
        IssuanceInput::new_issuance(amount, 0, get_random_seed()),
        RequiredSignature::NativeEcdsa,
    );
    let spk = signer.get_address().script_pubkey();
    ft.add_output(PartialOutput::new(spk.clone(), amount, details.asset_id));
    ft.add_output(PartialOutput::new(spk, first.explicit_amount(), first.explicit_asset()));
    signer.broadcast(&ft)?.wait()?;
    Ok(details.asset_id)
}

fn coin(signer: &Signer, asset: AssetId, at_least: u64) -> anyhow::Result<UTXO> {
    let ok = |u: &UTXO| u.asset() == asset && u.amount() >= at_least;
    signer
        .get_utxos_filter(&ok, &ok)?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no coin of {asset}"))
}

fn add_change(ctx: &mut ConfidentialTransaction, signer: &Signer, coin: UTXO, spent: u64) {
    let (asset, amount) = (coin.asset(), coin.amount());
    ctx.add_input(PartialInput::new(coin), RequiredSignature::NativeEcdsa);
    if amount > spent {
        ctx.add_output(
            PartialOutput::new(signer.get_confidential_address().script_pubkey(), amount - spent, asset)
                .with_blinding_key(signer.get_blinding_public_key()),
        );
    }
}

fn confirm(signer: &Signer, tx: &Transaction) -> anyhow::Result<()> {
    let provider = signer.get_provider();
    provider.broadcast_transaction(tx)?;
    wait_for_confirmation(provider, &tx.txid())?;
    std::thread::sleep(std::time::Duration::from_millis(1500));
    Ok(())
}

fn report(label: &str, tx: &Transaction, index: usize) -> anyhow::Result<()> {
    let stack = &tx.input[index].witness.script_witness;
    let [wit, prog, ..] = stack.as_slice() else { anyhow::bail!("not a Simplicity spend") };
    let node = RedeemNode::<Elements>::decode(BitIter::from(prog.as_slice()), BitIter::from(wit.as_slice()))
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let cost = node.bounds().cost;
    let stack_len = serialize(stack).len();
    println!(
        "SPIKE {label}: tx weight {} WU ({} inputs, {} outputs); loan input: script witness {} B \
         (witness {} B, program {} B), cost {cost} mWU, budget {} mWU, within budget without \
         padding: {}",
        tx.weight(),
        tx.input.len(),
        tx.output.len(),
        stack_len,
        wit.len(),
        prog.len(),
        (stack_len + 50) * 1000,
        cost.is_budget_valid(stack)
    );
    for (i, o) in tx.output.iter().enumerate() {
        println!(
            "SPIKE   out {i}: rangeproof {} B, surjection {} B, script {} B",
            o.witness.rangeproof.as_ref().map(|r| r.len()).unwrap_or(0),
            o.witness.surjection_proof.as_ref().map(|r| r.len()).unwrap_or(0),
            o.script_pubkey.len()
        );
    }
    Ok(())
}

// ------------------------------------------------------------------ BSGS

/// Finds k in [1, max] with k·base = target.
fn bsgs(target: ProjectivePoint, base: ProjectivePoint, max: u64) -> Option<u64> {
    let m = ((max as f64).sqrt() as u64 + 1).next_power_of_two();
    let mut table: HashMap<u64, u32> = HashMap::with_capacity(m as usize);
    let key = |p: &AffinePoint| u64::from_be_bytes(p.x()[..8].try_into().unwrap());
    const CHUNK: usize = 4096;
    let mut cur = ProjectivePoint::IDENTITY;
    let mut j = 0u64;
    while j < m {
        let n = CHUNK.min((m - j) as usize);
        let mut pts = Vec::with_capacity(n);
        for _ in 0..n {
            pts.push(cur);
            cur += base;
        }
        let mut aff = vec![AffinePoint::IDENTITY; n];
        ProjectivePoint::batch_normalize(&pts, &mut aff);
        for (t, a) in aff.iter().enumerate() {
            table.entry(key(a)).or_insert((j + t as u64) as u32);
        }
        j += n as u64;
    }
    let giant = -(base * Scalar::from(m));
    let mut cur = target;
    let mut i = 0u64;
    while i * m <= max {
        let n = CHUNK;
        let mut pts = Vec::with_capacity(n);
        for _ in 0..n {
            pts.push(cur);
            cur += giant;
        }
        let mut aff = vec![AffinePoint::IDENTITY; n];
        ProjectivePoint::batch_normalize(&pts, &mut aff);
        for (t, a) in aff.iter().enumerate() {
            if let Some(&jj) = table.get(&key(a)) {
                let k = (i + t as u64) * m + u64::from(jj);
                if base * Scalar::from(k) == target {
                    return Some(k);
                }
            }
        }
        i += n as u64;
    }
    None
}

// ------------------------------------------------------------------ the installment

struct State {
    utxo: UTXO,
    debt: confidential::Value,
    debt_amount: u64,
    debt_blinder: Scalar,
    collateral: u64,
    index: u32,
    carries: Vec<UTXO>,
}

#[derive(Clone, Copy, PartialEq)]
enum Tamper {
    None,
    SuccessorPlusOne,
    CarriesOffByOne,
    RandomBlinder,
    SelfMadeY,
    IndexAhead,
    LeafAhead,
}

fn build_installment(
    loan: &Loan,
    st: &State,
    borrower: &Signer,
    lender_script: &simplex::simplicityhl::elements::Script,
    payment: u64,
    tamper: Tamper,
) -> anyhow::Result<(ConfidentialTransaction, State)> {
    let network = *borrower.get_provider().get_network();
    let secp = Secp256k1::new();
    // the installment: under A, rewindable by nobody the lender knows (an unreadable installment)
    let s = Scalar::random(&mut rand::thread_rng());
    let installment = PinnedOutput {
        asset_id: loan.repayment_asset,
        amount: payment,
        asset_blinding_factor: abf_of(&loan.abf_a),
        value_blinding_factor: vbf_of(&s),
    };
    let unknown_key = simplex::simplicityhl::elements::bitcoin::PublicKey::new(PublicKey::from_secret_key(&secp, &SecretKey::new(&mut rand::thread_rng())));
    let debt_left = debt_after(&st.debt, &installment.value_commitment())?;
    let d_left = st.debt_amount - payment;
    let r_left = st.debt_blinder - s;

    let c_next = (u128::from(d_left) * u128::from(loan.cap)).div_ceil(u128::from(loan.repay)) as u64;
    let e = (u128::from(c_next) * u128::from(loan.repay) - u128::from(d_left) * u128::from(loan.cap)) as u64;
    let next = st.index + 1;
    let honest_successor = loan.collateral_at(next, c_next);
    let random_blinder = PinnedOutput {
        value_blinding_factor: vbf_of(&Scalar::random(&mut rand::thread_rng())),
        ..honest_successor
    };
    // the blinder of index next + 1, at the successor's real asset step next
    let ahead_blinder = PinnedOutput {
        value_blinding_factor: vbf_of(
            &(loan.xs[next as usize] - Scalar::from(c_next) * Scalar::from(u64::from(next))),
        ),
        ..honest_successor
    };
    let successor = match tamper {
        Tamper::SuccessorPlusOne => loan.collateral_at(next, c_next + 1),
        Tamper::RandomBlinder | Tamper::SelfMadeY => random_blinder,
        Tamper::IndexAhead | Tamper::LeafAhead => ahead_blinder,
        _ => honest_successor,
    };
    let (claimed_index, leaf) = match tamper {
        Tamper::IndexAhead => (st.index + 1, st.index as usize + 1),
        Tamper::LeafAhead => (st.index, st.index as usize + 1),
        _ => (st.index, st.index as usize),
    };
    let y_override = if tamper == Tamper::SelfMadeY {
        let x = Scalar::from(successor.amount) * Scalar::from(u64::from(next))
            + vbf_scalar(&successor.value_blinding_factor);
        let y = Scalar::random(&mut rand::thread_rng());
        Some((ProjectivePoint::GENERATOR * x + loan.j * y, y))
    } else {
        None
    };
    let carry_asset = st.carries[0].asset();
    // the carries hold e' + 1 and R − e', both at least 1 on a spendable script
    // the tampered split moves one unit from W1 to W2: the same total, the wrong e'
    let shift = u64::from(tamper == Tamper::CarriesOffByOne);
    let w1 = PinnedOutput::new_random(carry_asset, e + 1 - shift);
    let w2_amount = loan.repay - e + shift;
    let w2 = PinnedOutput::new_random(carry_asset, w2_amount);

    DEBT_BEFORE.with(|d| *d.borrow_mut() = Some(st.debt));
    let openings = Openings {
        debt_left,
        d_left_blinder: r_left,
        successor,
        index: st.index,
        claimed_index,
        leaf,
        y_override,
        w1,
        w2,
        e,
    };
    let path = prove(loan, &openings);

    let mut ctx = ConfidentialTransaction::new();
    ctx.add_program_input(
        PartialInput::new(st.utxo.clone()),
        ProgramInput::new(Box::new(program(loan, &st.debt)), Box::new(witness_json(path))),
        RequiredSignature::None,
    );
    let successor_program = program(loan, &debt_left);
    let borrower_conf = borrower.get_confidential_address().script_pubkey();
    let bkey = borrower.get_blinding_public_key();
    ctx.add_pinned_output(successor_program.get_script_pubkey(&network), successor, bkey);
    ctx.add_pinned_output(lender_script.clone(), installment, unknown_key);
    ctx.add_pinned_output(borrower_conf.clone(), w1, bkey);
    ctx.add_pinned_output(borrower_conf.clone(), w2, bkey);
    // the release
    let released = st.collateral - successor.amount;
    if released > 0 {
        ctx.add_output(
            PartialOutput::new(borrower_conf.clone(), released, loan.collateral_asset).with_blinding_key(bkey),
        );
    }
    let rep_coin = coin(borrower, loan.repayment_asset, payment)?;
    add_change(&mut ctx, borrower, rep_coin, payment);
    let carry_in: u64 = st.carries.iter().map(UTXO::amount).sum();
    for (n, c) in st.carries.iter().enumerate() {
        ctx.add_input(PartialInput::new(c.clone()), RequiredSignature::NativeEcdsa);
        let _ = n;
    }
    let carry_out = w1.amount + w2_amount;
    if carry_in > carry_out {
        ctx.add_output(
            PartialOutput::new(borrower_conf.clone(), carry_in - carry_out, carry_asset).with_blinding_key(bkey),
        );
    }

    let next_state = State {
        utxo: st.utxo.clone(), // replaced after broadcast
        debt: debt_left,
        debt_amount: d_left,
        debt_blinder: r_left,
        collateral: c_next,
        index: next,
        carries: vec![],
    };
    // carry UTXOs are found after broadcast through the pinned outputs
    CARRIES.with(|c| *c.borrow_mut() = vec![w1, w2]);
    Ok((ctx, next_state))
}

thread_local! {
    static CARRIES: std::cell::RefCell<Vec<PinnedOutput>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn pinned_utxo(tx: &Transaction, pinned: &PinnedOutput) -> UTXO {
    let (vout, txout) = tx.output.iter().enumerate().find(|(_, o)| pinned.matches(o)).unwrap();
    pinned.to_utxo(OutPoint::new(tx.txid(), vout as u32), txout.clone())
}

fn carry_of(loan: &Loan, d: u64) -> u128 {
    let c = (u128::from(d) * u128::from(loan.cap)).div_ceil(u128::from(loan.repay));
    c * u128::from(loan.repay) - u128::from(d) * u128::from(loan.cap)
}

/// A payment of about `num/den` of `debt` whose carry is zero (`zero`) or not.
fn pick_payment(loan: &Loan, debt: u64, num: u64, den: u64, zero: bool) -> u64 {
    let mut p = debt / den * num;
    loop {
        if (carry_of(loan, debt - p) == 0) == zero {
            return p;
        }
        p += 1;
    }
}

#[simplex::test]
fn route_c_installments_and_liquidation(context: simplex::TestContext) -> anyhow::Result<()> {
    let borrower = context.get_default_signer();
    let network = *context.get_network();
    let lender = context.random_signer();
    {
        // split the wallet's coin, so issuances can spend one and pay the fee from another
        let policy = network.policy_asset();
        let big = borrower
            .get_utxos_asset(policy)?
            .into_iter()
            .max_by_key(|u| u.amount())
            .unwrap();
        let part = big.amount() / 16;
        let mut ft = FinalTransaction::new();
        ft.add_input(PartialInput::new(big), RequiredSignature::NativeEcdsa);
        for _ in 0..12 {
            ft.add_output(PartialOutput::new(borrower.get_address().script_pubkey(), part, policy));
        }
        borrower.broadcast(&ft)?.wait()?;
    }

    // C below 2^40 (the lender's search is about 2^20 steps here), R a little above
    // C/R = 4/5, so that e' = 0 whenever 5 divides d' (a zero carry is routine)
    let cap: u64 = (1 << 40) - (1 << 20);
    let repay: u64 = cap / 4 * 5;
    let collateral_asset = issue(&context, cap + 1_000_000)?;
    let repayment_asset = issue(&context, 2 * repay)?;
    let carry_asset = issue(&context, 4 * repay)?;
    borrower.send(lender.get_address().script_pubkey(), 50_000_000)?.wait()?;

    let mut rng = rand::thread_rng();
    let mut loan = Loan {
        collateral_asset,
        repayment_asset,
        cap,
        repay,
        abf_c: Scalar::random(&mut rng),
        vbf_c0: Scalar::random(&mut rng),
        abf_a: Scalar::random(&mut rng),
        r0: Scalar::random(&mut rng),
        j: nums("p7 J"),
        xs: vec![],
        ys: vec![],
        tree: vec![],
        carry_script_hash: Sha256::digest(borrower.get_confidential_address().script_pubkey().as_bytes()).into(),
    };
    build_tree(&mut loan, 1 << TREE_DEPTH);

    // the active loan: C at A_c, storage h(A, D0)
    let d0 = loan.d0();
    let mut ctx = ConfidentialTransaction::new();
    let active = loan.active_collateral();
    ctx.add_pinned_output(
        program(&loan, &d0).get_script_pubkey(&network),
        active,
        lender.get_blinding_public_key(),
    );
    let ccoin = coin(borrower, collateral_asset, cap)?;
    add_change(&mut ctx, borrower, ccoin, cap);
    let tx = ctx.finalize(borrower)?;
    confirm(borrower, &tx)?;
    let mut st = State {
        utxo: pinned_utxo(&tx, &active),
        debt: d0,
        debt_amount: repay,
        debt_blinder: loan.r0,
        collateral: cap,
        index: 0,
        carries: vec![coin(borrower, carry_asset, repay)?],
    };
    // the installments go to an address outside the lender's wallet (the real lock is asset_auth)
    let lender_script = context.random_signer().get_address().script_pubkey();

    // installment 1: the carries come from the issued token (with a carry change)
    let p1 = pick_payment(&loan, st.debt_amount, 1, 3, true);
    let (ctx, mut next) = build_installment(&loan, &st, borrower, &lender_script, p1, Tamper::None)?;
    let tx1 = ctx.finalize(borrower)?;
    confirm(borrower, &tx1)?;
    report("installment 1 (carries from the issuance)", &tx1, 0)?;
    next.utxo = pinned_utxo(&tx1, &loan.collateral_at(1, next.collateral));
    next.carries = CARRIES.with(|c| c.borrow().iter().map(|p| pinned_utxo(&tx1, p)).collect());
    println!("SPIKE   c' = {} of C = {}, released {}, carry e' = {}", next.collateral, cap, st.collateral - next.collateral, carry_of(&loan, next.debt_amount));
    st = next;

    // the refused variants of installment 2
    let p2 = pick_payment(&loan, st.debt_amount, 1, 2, false);
    for (tamper, label) in [
        (Tamper::SuccessorPlusOne, "successor holds c' + 1"),
        (Tamper::CarriesOffByOne, "carries split (e', R − e' + 1): right total, wrong e'"),
        (Tamper::RandomBlinder, "successor with a random blinder, honest Y"),
        (Tamper::SelfMadeY, "successor with a random blinder, self-made Y, honest path"),
        (Tamper::IndexAhead, "index, leaf and blinder of i + 1 at step i"),
        (Tamper::LeafAhead, "leaf and blinder of i + 1, index i"),
    ] {
        let (ctx, _) = build_installment(&loan, &st, borrower, &lender_script, p2, tamper)?;
        match ctx.finalize(borrower) {
            Ok(tx) => match borrower.get_provider().broadcast_transaction(&tx) {
                Ok(_) => anyhow::bail!("{label}: accepted"),
                Err(e) => println!("SPIKE refused by the node ({label}): {e}"),
            },
            Err(e) => println!("SPIKE refused by the program ({label}): {e}"),
        }
    }

    // installment 2: steady state, the two carries in and out
    let (ctx, mut next) = build_installment(&loan, &st, borrower, &lender_script, p2, Tamper::None)?;
    let tx2 = ctx.finalize(borrower)?;
    confirm(borrower, &tx2)?;
    report("installment 2 (steady state: two carries in, two out)", &tx2, 0)?;
    next.utxo = pinned_utxo(&tx2, &loan.collateral_at(2, next.collateral));
    println!("SPIKE   c'' = {}, released {}, carry e'' = {}", next.collateral, st.collateral - next.collateral, carry_of(&loan, next.debt_amount));
    st = next;

    // the lender liquidates without reading either installment: it knows C, abf_c, the x_i, the
    // number of installments, and the chain. It tracks the debt as a point (as the spec says).
    let lender_debt = {
        let mut d = loan.d0();
        for tx in [&tx1, &tx2] {
            d = debt_after(&d, &tx.output[1].value)?; // installment outputs, unopened
        }
        d
    };
    let i = 2u32;
    let succ_txout = tx2.output[0].clone();
    let v_s = value_point(&succ_txout.value);
    let target = v_s - ProjectivePoint::GENERATOR * loan.xs[i as usize - 1];
    let started = std::time::Instant::now();
    let found = bsgs(target, loan.a_c_pt(), cap).ok_or_else(|| anyhow::anyhow!("search failed"))?;
    println!("SPIKE lender's search: c = {found} (true {}) in {:?}", st.collateral, started.elapsed());
    let opened = loan.collateral_at(i, found);
    let utxo = UTXO {
        outpoint: OutPoint::new(tx2.txid(), 0),
        txout: succ_txout,
        secrets: Some(opened.secrets()),
    };
    let mut ctx = ConfidentialTransaction::new();
    ctx.add_program_input(
        PartialInput::new(utxo),
        ProgramInput::new(Box::new(program(&loan, &lender_debt)), Box::new(witness_json("Right(())".into()))),
        RequiredSignature::None,
    );
    ctx.add_output(
        PartialOutput::new(lender.get_confidential_address().script_pubkey(), found, collateral_asset)
            .with_blinding_key(lender.get_blinding_public_key()),
    );
    let ltx = ctx.finalize(&lender)?;
    confirm(&lender, &ltx)?;
    println!("SPIKE liquidation confirmed: {} ({} WU)", ltx.txid(), ltx.weight());
    Ok(())
}
