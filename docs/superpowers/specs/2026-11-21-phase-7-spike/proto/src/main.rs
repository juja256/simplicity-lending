//! P7 spike prototype driver: proves and verifies a bit-OR range proof in SimplicityHL and
//! prints the verifier's cost, program bytes and witness bytes. Throwaway code.

use std::sync::Arc;

use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::Field;
use k256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar, U256};
use rand::{thread_rng, Rng};
use sha2::{Digest, Sha256};
use simplicityhl::simplicity::bit_machine::BitMachine;
use simplicityhl::simplicity::BitIter;
use simplicityhl::{Arguments, CompiledProgram, WitnessValues};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn compressed(p: &ProjectivePoint) -> [u8; 33] {
    let e = p.to_affine().to_encoded_point(true);
    e.as_bytes().try_into().unwrap()
}

fn affine_xy(p: &ProjectivePoint) -> (String, String) {
    let e = p.to_affine().to_encoded_point(false);
    (format!("0x{}", hex(e.x().unwrap())), format!("0x{}", hex(e.y().unwrap())))
}

fn scalar_hex(s: &Scalar) -> String {
    format!("0x{}", hex(&s.to_bytes()))
}

fn point_value(p: &ProjectivePoint) -> String {
    let c = compressed(p);
    format!("({}, 0x{})", c[0] & 1, hex(&c[1..]))
}

/// A NUMS point: try-and-increment on SHA-256 of a tag.
fn nums(tag: &str) -> ProjectivePoint {
    for i in 0u32.. {
        let mut h = Sha256::new();
        h.update(tag.as_bytes());
        h.update(i.to_be_bytes());
        let x = h.finalize();
        let mut enc = [0u8; 33];
        enc[0] = 2;
        enc[1..].copy_from_slice(&x);
        let ep = EncodedPoint::from_bytes(enc).unwrap();
        if let Some(p) = Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&ep)) {
            return p.into();
        }
    }
    unreachable!()
}

fn challenge(digest: &[u8; 32], b: &ProjectivePoint, t0: &ProjectivePoint, t1: &ProjectivePoint) -> Scalar {
    if BLOCK_HASH.load(std::sync::atomic::Ordering::Relaxed) {
        return challenge_block(digest, b, t0, t1);
    }
    let mut h = Sha256::new();
    h.update(digest);
    h.update(compressed(b));
    h.update(compressed(t0));
    h.update(compressed(t1));
    let out: FieldBytes = h.finalize();
    <Scalar as Reduce<U256>>::reduce_bytes(&out)
}

static BLOCK_HASH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Two SHA-256 compressions chained from the digest: B.x ‖ T0.x, then T1.x ‖ prefix bits.
fn challenge_block(digest: &[u8; 32], b: &ProjectivePoint, t0: &ProjectivePoint, t1: &ProjectivePoint) -> Scalar {
    let (cb, ct0, ct1) = (compressed(b), compressed(t0), compressed(t1));
    let mut state = [0u32; 8];
    for i in 0..8 {
        state[i] = u32::from_be_bytes(digest[4 * i..4 * i + 4].try_into().unwrap());
    }
    let mut blk1 = [0u8; 64];
    blk1[..32].copy_from_slice(&cb[1..]);
    blk1[32..].copy_from_slice(&ct0[1..]);
    let mut blk2 = [0u8; 64];
    blk2[..32].copy_from_slice(&ct1[1..]);
    blk2[63] = ((cb[0] & 1) << 2) | ((ct0[0] & 1) << 1) | (ct1[0] & 1);
    sha2::compress256(&mut state, &[blk1.into(), blk2.into()]);
    let mut out = [0u8; 32];
    for i in 0..8 {
        out[4 * i..4 * i + 4].copy_from_slice(&state[i].to_be_bytes());
    }
    <Scalar as Reduce<U256>>::reduce_bytes(&out.into())
}

struct BitProof {
    b: ProjectivePoint,
    t0: ProjectivePoint,
    t1: ProjectivePoint,
    c0: Scalar,
    z0: Scalar,
    z1: Scalar,
}

/// Proves v in [0, 2^n) for E = v·H + r·G; returns (E, proofs most significant bit first).
fn prove_range(h_gen: &ProjectivePoint, v: u64, n: usize, digest: &[u8; 32]) -> (ProjectivePoint, Vec<BitProof>) {
    let mut rng = thread_rng();
    let g = ProjectivePoint::GENERATOR;
    let mut e = ProjectivePoint::IDENTITY;
    let mut proofs = Vec::new();
    for i in (0..n).rev() {
        let bit = (v >> i) & 1 == 1;
        let r = Scalar::random(&mut rng);
        let b = if bit { *h_gen + g * r } else { g * r };
        let k = Scalar::random(&mut rng);
        let proof = if !bit {
            let (c1, z1) = (Scalar::random(&mut rng), Scalar::random(&mut rng));
            let t1 = g * z1 - (b - h_gen) * c1;
            let t0 = g * k;
            let c = challenge(digest, &b, &t0, &t1);
            let c0 = c - c1;
            BitProof { b, t0, t1, c0, z0: k + c0 * r, z1 }
        } else {
            let (c0, z0) = (Scalar::random(&mut rng), Scalar::random(&mut rng));
            let t0 = g * z0 - b * c0;
            let t1 = g * k;
            let c = challenge(digest, &b, &t0, &t1);
            let c1 = c - c0;
            BitProof { b, t0, t1, c0, z0, z1: k + c1 * r }
        };
        e = e.double() + b;
        let _ = i;
        proofs.push(proof);
    }
    (e, proofs)
}

struct Measured {
    cost_mwu: u64,
    program_bytes: usize,
    witness_bytes: usize,
    ok: bool,
}

fn run(source: &str, witness_json: &str) -> Measured {
    let compiled = CompiledProgram::new(source, Arguments::default(), false).expect("compiles");
    let wv: WitnessValues = serde_json::from_str(witness_json).expect("witness parses");
    let satisfied = compiled.satisfy(wv).expect("satisfies");
    let env = simplicityhl::dummy_env::dummy();
    let pruned = satisfied.redeem().prune(&env);
    let pruned = match pruned {
        Ok(p) => p,
        Err(e) => {
            println!("  prune/exec failed: {e}");
            return Measured { cost_mwu: 0, program_bytes: 0, witness_bytes: 0, ok: false };
        }
    };
    let (prog, wit) = pruned.to_vec_with_witness();
    // round trip, as consensus decodes it
    let decoded = simplicityhl::simplicity::RedeemNode::<simplicityhl::simplicity::jet::Elements>::decode(
        BitIter::from(prog.as_slice()),
        BitIter::from(wit.as_slice()),
    )
    .expect("decodes");
    let cost = decoded.bounds().cost;
    let cost_mwu: u64 = format!("{cost}").parse().unwrap();
    let mut mac = BitMachine::for_program(&decoded).expect("bounds");
    let ok = mac.exec(&decoded, &env).is_ok();
    Measured { cost_mwu, program_bytes: prog.len(), witness_bytes: wit.len(), ok }
}

fn report(label: &str, m: &Measured) {
    // the script witness is [witness, program, cmr(32), control block(33)] plus length prefixes
    let stack = m.witness_bytes + m.program_bytes + 32 + 33 + 1 + 3 + 3 + 1 + 1;
    let needed_wu = m.cost_mwu.div_ceil(1000);
    let budget_wu = stack as u64 + 50;
    let padding = needed_wu.saturating_sub(budget_wu);
    println!(
        "{label}: ran ok = {}, cost {} mWU ({} WU), program {} B, witness {} B, script witness ~{} B, \
         padding {} B, input witness weight ~{} WU",
        m.ok, m.cost_mwu, needed_wu, m.program_bytes, m.witness_bytes, stack, padding,
        stack as u64 + padding
    );
}

fn range_proof_case(n: usize, tamper: bool) -> Measured {
    range_proof_case_src(include_str!("../range_proof.simf.tpl"), n, tamper, false)
}

fn range_proof_case_src(tpl: &str, n: usize, tamper: bool, cost_only: bool) -> Measured {
    let h_gen = nums("p7-spike H");
    let digest: [u8; 32] = Sha256::digest(b"p7-spike statement").into();
    let mut rng = thread_rng();
    let v: u64 = if n == 64 { rng.gen() } else { rng.gen::<u64>() & ((1u64 << n) - 1) };
    let (e, mut proofs) = prove_range(&h_gen, v, n, &digest);
    if tamper {
        proofs[n / 2].z1 += Scalar::ONE;
    }
    let (nhx, nhy) = affine_xy(&(-h_gen));
    let (ex, ey) = affine_xy(&e);
    let src = tpl
        .replace("{{NEG_H_X}}", &nhx)
        .replace("{{NEG_H_Y}}", &nhy)
        .replace("{{E_X}}", &ex)
        .replace("{{E_Y}}", &ey)
        .replace("{{DIGEST}}", &format!("0x{}", hex(&digest)))
        .replace("{{N}}", &n.to_string());
    let items: Vec<String> = proofs
        .iter()
        .map(|p| {
            format!(
                "({}, {}, {}, {}, {}, {})",
                point_value(&p.b),
                point_value(&p.t0),
                point_value(&p.t1),
                scalar_hex(&p.c0),
                scalar_hex(&p.z0),
                scalar_hex(&p.z1)
            )
        })
        .collect();
    let ty = format!("[((u1, u256), (u1, u256), (u1, u256), u256, u256, u256); {n}]");
    let witness = serde_json::json!({
        "PROOF": { "value": format!("[{}]", items.join(", ")), "type": ty }
    })
    .to_string();
    if cost_only {
        return static_cost(&src, &witness);
    }
    run(&src, &witness)
}

fn static_cost(source: &str, witness_json: &str) -> Measured {
    let compiled = CompiledProgram::new(source, Arguments::default(), false).expect("compiles");
    let wv: WitnessValues = serde_json::from_str(witness_json).expect("witness parses");
    let satisfied = compiled.satisfy(wv).expect("satisfies");
    let (prog, wit) = satisfied.redeem().to_vec_with_witness();
    let cost: u64 = format!("{}", satisfied.redeem().bounds().cost).parse().unwrap();
    Measured { cost_mwu: cost, program_bytes: prog.len(), witness_bytes: wit.len(), ok: false }
}

fn loop_case(label: &str, src: &str) {
    let m = run(src, "{}");
    report(label, &m);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let what = args.get(1).map(String::as_str).unwrap_or("range");
    match what {
        "range" => {
            for n in [1usize, 2, 8, 52, 64] {
                let m = range_proof_case(n, false);
                report(&format!("range proof, {n} bits"), &m);
            }
            let m = range_proof_case(64, true);
            report("range proof, 64 bits, one z1 tampered (must fail)", &m);
        }
        "loops" => {
            loop_case("array_fold, 64 scale calls", include_str!("../loop_array_fold.simf"));
            loop_case("for_while u8 counter, exits after 64 scale calls", include_str!("../loop_for_while.simf"));
            loop_case("unrolled straight line, 4 scale calls", include_str!("../loop_straight4.simf"));
        }
        "sigma" => sigma::run_sigma(),
        "block" => {
            BLOCK_HASH.store(true, std::sync::atomic::Ordering::Relaxed);
            let tpl = std::fs::read_to_string("range_proof_block.simf.tpl").unwrap();
            for n in [1usize, 8, 52, 64] {
                let m = range_proof_case_src(&tpl, n, false, false);
                report(&format!("block-hash range proof, {n} bits"), &m);
            }
            let m = range_proof_case_src(&tpl, 64, true, false);
            report("block-hash range proof, 64 bits, one z1 tampered (must fail)", &m);
        }
        "check" => {
            let path = args.get(2).expect("simf path");
            let source = std::fs::read_to_string(path).unwrap();
            let z = "0x0000000000000000000000000000000000000000000000000000000000000001";
            let ge = format!("({z}, {z})");
            let mut m = serde_json::Map::new();
            for (name, ty, val) in [
                ("REPAYMENT_ASSET", "(bool, u256)", format!("(false, {z})")),
                ("A_GE", "(u256, u256)", ge.clone()),
                ("A_C_GE", "(u256, u256)", ge.clone()),
                ("V_C0_GE", "(u256, u256)", ge.clone()),
                ("D0_GE", "(u256, u256)", ge.clone()),
                ("J_GE", "(u256, u256)", ge.clone()),
                ("Y_ROOT", "u256", z.to_string()),
                ("FS_IV", "u256", z.to_string()),
                ("LEAF_IV", "u256", z.to_string()),
                ("NODE_IV", "u256", z.to_string()),
            ] {
                m.insert(name.into(), serde_json::json!({"value": val, "type": ty}));
            }
            let a: Arguments = serde_json::from_str(&serde_json::Value::Object(m).to_string()).unwrap();
            match CompiledProgram::new(source.as_str(), a, false) {
                Ok(_) => println!("compiles"),
                Err(e) => println!("{e}"),
            }
        }
        "variants" => {
            for f in ["range_proof.simf.tpl", "variant_nohash.simf.tpl", "variant_jets_only.simf.tpl"] {
                let tpl = std::fs::read_to_string(f).unwrap();
                let m = range_proof_case_src(&tpl, 8, false, true);
                report(&format!("{f}, 8 bits, unpruned static cost"), &m);
            }
        }
        _ => panic!("unknown case"),
    }
    let _ = Arc::new(());
}

mod sigma;
