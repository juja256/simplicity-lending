/*
 * P7 spike prototype: the Sigma proof of the release statement (stateless form).
 * Public points (here constants; in the contract: parameters and introspection):
 *   A_c, V_c0 (collateral at acceptance), V_s (successor collateral), D0, D' (debt left), E'.
 * Proves knowledge of C, rho, c', x', tau with
 *   V_c0 = C·A_c + rho·G,  V_s = c'·A_c + x'·G,  c'·D0 − C·D' − tau·G = E'.
 * Witness: T1, T2, T3 (affine) and z_C, z_rho, z_c', z_x', z_tau. Challenge: SHA-256
 * compressions chained from a statement digest over the T's.
 */

fn a_c() -> Ge { ({{A_C}}) }
fn v_c0() -> Ge { ({{V_C0}}) }
fn v_s() -> Ge { ({{V_S}}) }
fn d0() -> Ge { ({{D0}}) }
fn d_left() -> Ge { ({{D_LEFT}}) }
fn e_left() -> Ge { ({{E_LEFT}}) }

// T + k·P, as an affine point
fn add_scaled(t: Ge, k: u256, p: Ge) -> Ge {
    unwrap(jet::gej_normalize(jet::gej_ge_add(jet::scale(k, (p, 1)), t)))
}

fn main() {
    let (t1, t2, t3, zs): (Ge, Ge, Ge, (u256, u256, u256, u256, u256)) = witness::PROOF;
    let (z_cap, z_rho, z_c, z_x, z_tau): (u256, u256, u256, u256, u256) = zs;
    let (t1x, t1y): (u256, u256) = t1;
    let (t2x, t2y): (u256, u256) = t2;
    let (t3x, t3y): (u256, u256) = t3;

    let h: u256 = jet::sha_256_block({{DIGEST}}, t1x, t1y);
    let h: u256 = jet::sha_256_block(h, t2x, t2y);
    let c: u256 = jet::scalar_normalize(jet::sha_256_block(h, t3x, t3y));

    // z_C·A_c + z_rho·G = T1 + c·V_c0
    jet::linear_verify_1(((z_cap, a_c()), z_rho), add_scaled(t1, c, v_c0()));
    // z_c'·A_c + z_x'·G = T2 + c·V_s
    jet::linear_verify_1(((z_c, a_c()), z_x), add_scaled(t2, c, v_s()));
    // z_c'·D0 − z_tau·G = T3 + c·E' + z_C·D'
    jet::linear_verify_1(
        ((z_c, d0()), jet::scalar_negate(z_tau)),
        add_scaled(add_scaled(t3, c, e_left()), z_cap, d_left())
    );
}
