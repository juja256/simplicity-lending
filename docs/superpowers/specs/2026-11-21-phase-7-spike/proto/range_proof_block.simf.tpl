/*
 * P7 spike prototype, cheaper Fiat–Shamir: the challenge of bit i is two SHA-256 compressions
 * (jet::sha_256_block) from the statement digest as the chaining value, over
 * B.x ‖ T0.x | T1.x ‖ (the three prefix bits in the last byte). Fixed-length input, no padding.
 */

fn neg_h() -> Ge {
    ({{NEG_H_X}}, {{NEG_H_Y}})
}

fn commitment() -> Ge {
    ({{E_X}}, {{E_Y}})
}

fn prefix_word(b: u1, t0: u1, t1: u1) -> u256 {
    let byte: u8 = <(u4, u4)>::into((0, <(u2, u2)>::into((<(u1, u1)>::into((0, b)), <(u1, u1)>::into((t0, t1))))));
    <(u128, u128)>::into((0, <(u64, u64)>::into((0, <(u32, u32)>::into((0, <(u16, u16)>::into((0, <(u8, u8)>::into((0, byte))))))))))
}

fn verify_bit(
    proof: ((u1, u256), (u1, u256), (u1, u256), u256, u256, u256),
    acc: (Gej, u256)
) -> (Gej, u256) {
    let ((bb, bx), (t0b, t0x), (t1b, t1x), c0, z0, z1): ((u1, u256), (u1, u256), (u1, u256), u256, u256, u256) = proof;
    let (sum, digest): (Gej, u256) = acc;

    let c: u256 = jet::scalar_normalize(jet::sha_256_block(
        jet::sha_256_block(digest, bx, t0x),
        t1x,
        prefix_word(bb, t0b, t1b)
    ));

    // branch 0, B = r·G: −c0·B + z0·G = T0
    jet::point_verify_1(((jet::scalar_negate(c0), (bb, bx)), z0), (t0b, t0x));

    // branch 1, B − H = r·G: −c1·(B − H) + z1·G = T1, with c1 = c − c0
    let b_ge: Ge = unwrap(jet::decompress((bb, bx)));
    let (bh_x, bh_y): (u256, u256) = unwrap(jet::gej_normalize(jet::gej_ge_add((b_ge, 1), neg_h())));
    jet::point_verify_1(
        ((jet::scalar_add(c0, jet::scalar_negate(c)), (<bool>::into(jet::fe_is_odd(bh_y)), bh_x)), z1),
        (t1b, t1x)
    );

    // Horner: sum ← 2·sum + B
    (jet::gej_ge_add(jet::gej_double(sum), b_ge), digest)
}

fn main() {
    let start: (Gej, u256) = (((0, 0), 0), {{DIGEST}});
    let (sum, digest): (Gej, u256) = array_fold::<verify_bit, {{N}}>(witness::PROOF, start);
    assert!(jet::gej_ge_equiv(sum, commitment()));
}
