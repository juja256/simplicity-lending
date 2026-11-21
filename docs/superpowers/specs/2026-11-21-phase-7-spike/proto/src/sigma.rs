//! Proves and verifies the release statement's Sigma proof (see sigma.simf.tpl).

use super::*;

fn ge(p: &ProjectivePoint) -> String {
    let (x, y) = affine_xy(p);
    format!("{x}, {y}")
}

fn word(b: &[u8]) -> [u8; 32] {
    b.try_into().unwrap()
}

fn fs(digest: &[u8; 32], ts: &[ProjectivePoint; 3]) -> Scalar {
    let mut state = [0u32; 8];
    for i in 0..8 {
        state[i] = u32::from_be_bytes(digest[4 * i..4 * i + 4].try_into().unwrap());
    }
    let blocks: Vec<[u8; 64]> = ts
        .iter()
        .map(|t| {
            let e = t.to_affine().to_encoded_point(false);
            let mut b = [0u8; 64];
            b[..32].copy_from_slice(&word(e.x().unwrap()));
            b[32..].copy_from_slice(&word(e.y().unwrap()));
            b
        })
        .collect();
    for b in blocks {
        sha2::compress256(&mut state, &[b.into()]);
    }
    let mut out = [0u8; 32];
    for i in 0..8 {
        out[4 * i..4 * i + 4].copy_from_slice(&state[i].to_be_bytes());
    }
    <Scalar as Reduce<U256>>::reduce_bytes(&out.into())
}

pub fn run_sigma() {
    let mut rng = thread_rng();
    let g = ProjectivePoint::GENERATOR;
    let a = nums("p7 repayment asset A");
    let a_c = nums("p7 collateral asset A_c");
    // amounts: C collateral, R repayment, d' debt left, c' = ceil(d'·C/R), e' = c'·R − d'·C
    let (cap, rep, d_left): (u64, u64, u64) = (1_000_000, 1_150_000, 401_234);
    let c_s = (d_left as u128 * cap as u128).div_ceil(rep as u128) as u64;
    let e_left = (c_s as u128 * rep as u128 - d_left as u128 * cap as u128) as u64;
    assert!(e_left < rep);
    let s = |v: u64| Scalar::from(v);
    let (rho, x_s, r0, r_left, f) = (
        Scalar::random(&mut rng),
        Scalar::random(&mut rng),
        Scalar::random(&mut rng),
        Scalar::random(&mut rng),
        Scalar::random(&mut rng),
    );
    let v_c0 = a_c * s(cap) + g * rho;
    let v_s = a_c * s(c_s) + g * x_s;
    let d0 = a * s(rep) + g * r0;
    let dl = a * s(d_left) + g * r_left;
    let e = a * s(e_left) + g * f;
    // tau with c'·D0 − C·D' − tau·G = E'
    let tau = s(c_s) * r0 - s(cap) * r_left - f;
    assert_eq!(d0 * s(c_s) - dl * s(cap) - g * tau, e);

    let digest: [u8; 32] = Sha256::digest(b"p7-spike sigma statement").into();
    let k: Vec<Scalar> = (0..5).map(|_| Scalar::random(&mut rng)).collect();
    let (k_cap, k_rho, k_c, k_x, k_tau) = (k[0], k[1], k[2], k[3], k[4]);
    let t1 = a_c * k_cap + g * k_rho;
    let t2 = a_c * k_c + g * k_x;
    let t3 = d0 * k_c - dl * k_cap - g * k_tau;
    let c = fs(&digest, &[t1, t2, t3]);
    let z = [
        k_cap + c * s(cap),
        k_rho + c * rho,
        k_c + c * s(c_s),
        k_x + c * x_s,
        k_tau + c * tau,
    ];
    let src = include_str!("../sigma.simf.tpl")
        .replace("{{A_C}}", &ge(&a_c))
        .replace("{{V_C0}}", &ge(&v_c0))
        .replace("{{V_S}}", &ge(&v_s))
        .replace("{{D0}}", &ge(&d0))
        .replace("{{D_LEFT}}", &ge(&dl))
        .replace("{{E_LEFT}}", &ge(&e))
        .replace("{{DIGEST}}", &format!("0x{}", hex(&digest)));
    let zs: Vec<String> = z.iter().map(scalar_hex).collect();
    let value = format!("(({}), ({}), ({}), ({}))", ge(&t1), ge(&t2), ge(&t3), zs.join(", "));
    let witness = serde_json::json!({
        "PROOF": { "value": value, "type": "((u256, u256), (u256, u256), (u256, u256), (u256, u256, u256, u256, u256))" }
    })
    .to_string();
    report("sigma proof of the release statement", &run(&src, &witness));
    // a wrong release: c' + 1
    let bad = src.replace(&ge(&v_s), &ge(&(v_s + a_c)));
    report("sigma proof against c' + 1 (must fail)", &run(&bad, &witness));
}
