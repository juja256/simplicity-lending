/*
 * P7 spike prototype: verify a bit-decomposition range proof, E = v·H + r·G with v in [0, 2^N).
 * Each bit i (most significant first) carries B_i = b_i·H + r_i·G and a CDS OR proof that B_i or
 * B_i − H is a multiple of G, made non-interactive with c = SHA-256(digest ‖ B_i ‖ T0 ‖ T1) mod n,
 * c0 + c1 = c. The verifier then checks Σ 2^i·B_i = E by Horner's rule.
 * Placeholders {{...}} are filled in by the Rust driver.
 */

fn neg_h() -> Ge {
    ({{NEG_H_X}}, {{NEG_H_Y}})
}

fn commitment() -> Ge {
    ({{E_X}}, {{E_Y}})
}

fn hash_point(ctx: Ctx8, p: (u1, u256)) -> Ctx8 {
    let (bit, x): (u1, u256) = p;
    let prefix: u8 = jet::or_8(jet::left_pad_low_1_8(bit), 2);
    let ctx: Ctx8 = jet::sha_256_ctx_8_add_1(ctx, prefix);
    jet::sha_256_ctx_8_add_32(ctx, x)
}

fn verify_bit(
    proof: ((u1, u256), (u1, u256), (u1, u256), u256, u256, u256),
    acc: (Gej, u256)
) -> (Gej, u256) {
    let (b, t0, t1, c0, z0, z1): ((u1, u256), (u1, u256), (u1, u256), u256, u256, u256) = proof;
    let (sum, digest): (Gej, u256) = acc;

    let ctx: Ctx8 = jet::sha_256_ctx_8_init();
    let ctx: Ctx8 = jet::sha_256_ctx_8_add_32(ctx, digest);
    let ctx: Ctx8 = hash_point(ctx, b);
    let ctx: Ctx8 = hash_point(ctx, t0);
    let ctx: Ctx8 = hash_point(ctx, t1);
    let c: u256 = jet::scalar_normalize(jet::sha_256_ctx_8_finalize(ctx));
    let c1: u256 = jet::scalar_add(c, jet::scalar_negate(c0));

    // branch 0, B = r·G: −c0·B + z0·G = T0
    jet::point_verify_1(((jet::scalar_negate(c0), b), z0), t0);

    // branch 1, B − H = r·G: −c1·(B − H) + z1·G = T1
    let b_ge: Ge = unwrap(jet::decompress(b));
    let b_minus_h: Ge = unwrap(jet::gej_normalize(jet::gej_ge_add((b_ge, 1), neg_h())));
    let (bh_x, bh_y): (u256, u256) = b_minus_h;
    let bh: (u1, u256) = (<bool>::into(jet::fe_is_odd(bh_y)), bh_x);
    jet::point_verify_1(((jet::scalar_negate(c1), bh), z1), t1);

    // Horner: sum ← 2·sum + B
    (jet::gej_ge_add(jet::gej_double(sum), b_ge), digest)
}

fn main() {
    let start: (Gej, u256) = (((0, 0), 0), {{DIGEST}});
    let (sum, digest): (Gej, u256) = array_fold::<verify_bit, {{N}}>(witness::PROOF, start);
    assert!(jet::gej_ge_equiv(sum, commitment()));
}
