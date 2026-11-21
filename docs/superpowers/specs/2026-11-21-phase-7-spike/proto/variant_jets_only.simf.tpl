/* only the EC jets per bit, minimal bindings: cost floor */
fn neg_h() -> Ge {
    ({{NEG_H_X}}, {{NEG_H_Y}})
}

fn commitment() -> Ge {
    ({{E_X}}, {{E_Y}})
}

fn verify_bit(
    proof: ((u1, u256), (u1, u256), (u1, u256), u256, u256, u256),
    sum: Gej
) -> Gej {
    let (b, t0, t1, c0, z0, z1): ((u1, u256), (u1, u256), (u1, u256), u256, u256, u256) = proof;
    jet::point_verify_1(((c0, b), z0), t0);
    let b_ge: Ge = unwrap(jet::decompress(b));
    jet::point_verify_1(((c0, t1), z1), t1);
    jet::gej_ge_add(jet::gej_double(sum), b_ge)
}

fn main() {
    let d: u256 = {{DIGEST}};
    let sum: Gej = array_fold::<verify_bit, {{N}}>(witness::PROOF, ((0, 0), 0));
    assert!(jet::gej_ge_equiv(sum, commitment()));
}
