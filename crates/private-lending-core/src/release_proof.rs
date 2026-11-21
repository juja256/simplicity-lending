//! The release proof: the borrower's Sigma proof that an installment's successor holds exactly
//! `c' = ceil(d'·C/R)` of the collateral and uses the blinder committed for its step, and the Rust
//! verifier of what the program checks.
//!
//! An installment at step `i` creates step `i + 1`. The proof shows knowledge of eleven secrets,
//! `C, ρ, c', x, y, e, w1, R, r₀, w2, τ`, with one response each, shared by every equation the
//! secret appears in:
//!
//! ```text
//! E1  V_c0      = C·A_c + ρ·G
//! E2  V_s       = c'·A_c + x·G
//! E3  Y         = x·G + y·J
//! E4  W1 − A_w1 = e·A_w1 + w1·G
//! E5  D₀        = R·A + r₀·G
//! E6  W2        = (R − e)·A_w2 + w2·G
//! E7  0         = c'·D₀ − C·D' − e·A − τ·G
//! ```
//!
//! The challenge chains SHA-256 compressions from the loan's `FS_IV` over `D'`, `V_s`, `W1`,
//! `A_w1`, `W2`, `A_w2` and `Y` (the statement's digest `h₇`), then over `T1..T7`, and reduces the
//! last chaining value modulo the curve order. The nonces derive from the borrower's lending key,
//! `h₇` and a hash of the secrets, so two builds of one statement give the same proof and the
//! lender, who knows the shared secret, cannot compute them.

use std::array;

use elements::confidential::ValueBlindingFactor;
use elements::secp256k1_zkp::{PublicKey, Scalar, SecretKey};
use k256::elliptic_curve::PrimeField;
use k256::elliptic_curve::group::Group;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::{AffinePoint, EncodedPoint, ProjectivePoint};

use crate::release::{compress, fs_iv, point_xy, release_j, scalar};
use crate::{DebtOpening, LendingKey, PinnedOutput, carry_remainder, collateral_at, tagged_hash};

/// The tag of the hash of the secrets that each nonce binds.
const WITNESS_TAG: &str = "simplicity-lending/private/v1/release-witness";
/// The tag of the nonces' hash.
const NONCE_TAG: &str = "simplicity-lending/private/v1/release-nonce";

/// The points of an installment's release proof, all curve points.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseStatement {
    /// `A`, the repayment asset's commitment: a parameter.
    pub a: PublicKey,
    /// `A_c`, the active collateral's asset commitment: a parameter.
    pub a_c: PublicKey,
    /// `V_c0 = C·A_c + ρ·G`, the active collateral's value commitment: a parameter.
    pub v_c0: PublicKey,
    /// `D₀ = R·A + r₀·G`, the debt at acceptance: a parameter.
    pub d0: PublicKey,
    /// `D' = D − V`, the debt the installment leaves.
    pub d_next: PublicKey,
    /// `V_s`, the successor's value commitment (output 1).
    pub v_s: PublicKey,
    /// `W1`, the first carry's value commitment (output 3), of `e + 1` units.
    pub w1: PublicKey,
    /// `A_w1`, the first carry's asset commitment.
    pub a_w1: PublicKey,
    /// `W2`, the second carry's value commitment (output 4), of `R − e` units.
    pub w2: PublicKey,
    /// `A_w2`, the second carry's asset commitment.
    pub a_w2: PublicKey,
    /// `Y = x_(i+1)·G + y_(i+1)·J`, the blinder commitment of the successor's step.
    pub y: PublicKey,
}

impl ReleaseStatement {
    /// The statement's points, in the order of its fields.
    fn points(&self) -> [ProjectivePoint; 11] {
        [
            &self.a,
            &self.a_c,
            &self.v_c0,
            &self.d0,
            &self.d_next,
            &self.v_s,
            &self.w1,
            &self.a_w1,
            &self.w2,
            &self.a_w2,
            &self.y,
        ]
        .map(to_point)
    }
}

/// The eleven secrets of a release proof, in the order of its responses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseSecrets {
    /// `C`, the collateral at acceptance.
    pub collateral: u64,
    /// `ρ`, the active collateral's value blinder.
    pub rho: Scalar,
    /// `c'`, the collateral the successor holds.
    pub c_next: u64,
    /// `x = x_(i+1)`, the coefficient of `G` in the successor's value commitment.
    pub x: Scalar,
    /// `y = y_(i+1)`, the coefficient of `J` in `Y`.
    pub y: Scalar,
    /// `e = c'·R − d'·C`, the remainder the carries hold.
    pub e: u64,
    /// `w1`, the first carry's value blinder.
    pub w1: Scalar,
    /// `R`, the full repayment.
    pub repayment: u64,
    /// `r₀`, the value blinder of the debt at acceptance.
    pub r0: Scalar,
    /// `w2`, the second carry's value blinder.
    pub w2: Scalar,
    /// `τ = c'·r₀ − C·r'`, with `r'` the blinder of `D'`.
    pub tau: Scalar,
}

impl ReleaseSecrets {
    /// The honest borrower's secrets for an installment that leaves `debt_left`, `(d', r')`:
    ///
    /// - `C` and `ρ` from the active collateral, `R` and `r₀` from the pinned repayment;
    /// - `c' = ceil(d'·C/R)` and `e = c'·R − d'·C` ([`collateral_at`], [`carry_remainder`]);
    /// - `x` and `y` from `blinders`, the step's `(x_(i+1), y_(i+1))`
    ///   ([`OfferSecrets::release_blinders`](crate::OfferSecrets::release_blinders)), the
    ///   successor having the value blinder `x_(i+1) − c'·(i+1)`;
    /// - `w1` and `w2`, the carries' value blinders;
    /// - `τ = c'·r₀ − C·r'`.
    ///
    /// # Panics
    /// If the repayment is 0 or `d'` is above it, as [`collateral_at`].
    pub fn new(
        active_collateral: &PinnedOutput,
        repayment: &PinnedOutput,
        debt_left: DebtOpening,
        blinders: (SecretKey, SecretKey),
        carry_blinders: (ValueBlindingFactor, ValueBlindingFactor),
    ) -> ReleaseSecrets {
        let (collateral, full) = (active_collateral.amount, repayment.amount);
        let c_next = collateral_at(debt_left.amount, collateral, full);
        let r0 = blinder_scalar(&repayment.value_blinding_factor);
        let tau = k256::Scalar::from(c_next) * to_k256(&r0)
            - k256::Scalar::from(collateral) * to_k256(&blinder_scalar(&debt_left.blinder));

        ReleaseSecrets {
            collateral,
            rho: blinder_scalar(&active_collateral.value_blinding_factor),
            c_next,
            x: Scalar::from(blinders.0),
            y: Scalar::from(blinders.1),
            e: carry_remainder(debt_left.amount, collateral, full),
            w1: blinder_scalar(&carry_blinders.0),
            repayment: full,
            r0,
            w2: blinder_scalar(&carry_blinders.1),
            tau: from_k256(&tau),
        }
    }

    /// The secrets as scalars, in the order of the responses.
    fn scalars(&self) -> [k256::Scalar; 11] {
        [
            k256::Scalar::from(self.collateral),
            to_k256(&self.rho),
            k256::Scalar::from(self.c_next),
            to_k256(&self.x),
            to_k256(&self.y),
            k256::Scalar::from(self.e),
            to_k256(&self.w1),
            k256::Scalar::from(self.repayment),
            to_k256(&self.r0),
            to_k256(&self.w2),
            to_k256(&self.tau),
        ]
    }
}

/// A release proof: the commitments `T1..T7` and the responses
/// `z_C, z_ρ, z_c', z_x, z_y, z_e, z_w1, z_R, z_r₀, z_w2, z_τ`, in the witness's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseProof {
    pub t: [PublicKey; 7],
    pub z: [Scalar; 11],
}

/// The borrower's proof of `statement` with `secrets`.
///
/// The nonces are `k_m = scalar(tagged_hash("simplicity-lending/private/v1/release-nonce",
/// borrower_sk ‖ h₇ ‖ W ‖ m))` for `m = 0 … 10` as one byte, in the responses' order, where `h₇` is
/// the statement's digest under `FS_IV` (computed here from the statement's `A`, `A_c`, `V_c0` and
/// `D₀`, see [`fs_iv`]) and `W = tagged_hash("simplicity-lending/private/v1/release-witness",
/// C ‖ ρ ‖ c' ‖ x ‖ y ‖ e ‖ w1 ‖ R ‖ r₀ ‖ w2 ‖ τ)`, each secret as 32 big-endian bytes. The proof
/// is therefore deterministic. The commitments are `T = φ(k)`, the left-hand sides of E1–E7 at the
/// nonces, and the responses `z_m = k_m + c·secret_m`.
///
/// Secrets that do not satisfy E1–E7 give a proof that [`verify`] refuses. The borrower verifies
/// a proof before publishing it.
///
/// # Panics
/// If a commitment is the point at infinity, which happens with negligible probability.
pub fn prove(
    statement: &ReleaseStatement,
    secrets: &ReleaseSecrets,
    borrower: &LendingKey,
) -> ReleaseProof {
    let fs_iv = fs_iv(&statement.a, &statement.a_c, &statement.v_c0, &statement.d0);
    let witness = secrets.scalars();
    let k = nonces(borrower, &statement_digest(&fs_iv, statement), &witness);
    let t = commitments(statement, &k).map(|t| {
        to_public_key(&t)
            .expect("a commitment is the point at infinity with negligible probability")
    });
    let c = to_k256(&challenge(&fs_iv, statement, &t));

    ReleaseProof {
        t,
        z: array::from_fn(|m| from_k256(&(k[m] + c * witness[m]))),
    }
}

/// The honest commitments `T1..T7` at the nonces `k`: the left-hand sides of E1–E7.
fn commitments(statement: &ReleaseStatement, k: &[k256::Scalar; 11]) -> [ProjectivePoint; 7] {
    // `k_s` is the nonce of the successor's `c'`
    let [k_c, k_rho, k_s, k_x, k_y, k_e, k_w1, k_r, k_r0, k_w2, k_tau] = *k;
    let [a, a_c, _, d0, d_next, _, _, a_w1, _, a_w2, _] = statement.points();
    let j = to_point(&release_j());
    let g = ProjectivePoint::GENERATOR;

    [
        a_c * k_c + g * k_rho,
        a_c * k_s + g * k_x,
        g * k_x + j * k_y,
        a_w1 * k_e + g * k_w1,
        a * k_r + g * k_r0,
        a_w2 * (k_r - k_e) + g * k_w2,
        d0 * k_s - d_next * k_c - a * k_e - g * k_tau,
    ]
}

/// Whether `proof` proves `statement` for the loan whose Fiat–Shamir IV is `fs_iv`: the
/// installment's checks 10 and 11 of the design note ("The program"), as the program runs them.
///
/// - **The statement's points** are what the program reads: `V_s`, `W1`, `A_w1`, `W2` and `A_w2`
///   from outputs 1, 3 and 4 by phase 5's conversion ([`value_point`](crate::value_point),
///   [`asset_point`](crate::asset_point)), `D' = D − V` (check 4), `Y` from the witness, and the
///   parameters `A`, `A_c`, `V_c0` and `D₀`. The verifier uses the very points it hashes.
/// - **Check 10.** The program reads `T1..T7` and `Y` as affine words and checks each with
///   `jet::ge_is_on_curve`. A [`PublicKey`] is always a curve point, so the types discharge the
///   check. They also make the coordinates canonical: a word `x + p` below `2^256`, which the jets
///   read as `x`, has no [`PublicKey`], so this verifier cannot be handed a proof that the program
///   would hash differently.
/// - **Check 11, the challenge:** `c = scalar(h₁₄)` ([`challenge`]) over `fs_iv` as given, a
///   parameter of the program, which this function does not recompute from the statement.
/// - **Check 11, V1–V7:** each is one `jet::linear_verify_1`, `a·P + b·G = Q`, with `Q` built as
///   the program builds it: `T + k·P` by `jet::scale`, `jet::gej_ge_add` and `jet::gej_normalize`,
///   whose `unwrap` fails on the point at infinity. So a `Q`, or V7's intermediate
///   `T7 + z_C·D'`, or V4's `W1 − A_w1`, at infinity fails its check here too.
///   - V1: `z_C·A_c + z_ρ·G = T1 + c·V_c0`;
///   - V2: `z_c'·A_c + z_x·G = T2 + c·V_s`;
///   - V3: `z_y·J + z_x·G = T3 + c·Y`;
///   - V4: `z_e·A_w1 + z_w1·G = T4 + c·(W1 − A_w1)`;
///   - V5: `z_R·A + z_r₀·G = T5 + c·D₀`;
///   - V6: `(z_R − z_e)·A_w2 + z_w2·G = T6 + c·W2`, the coefficient by `jet::scalar_add` and
///     `jet::scalar_negate`;
///   - V7: `z_c'·D₀ + (−z_τ)·G = (T7 + z_C·D') + z_e·A`.
/// - **The responses:** the jets reduce a response modulo the curve order. A [`Scalar`] is below
///   it, so the reduction is the identity.
///
/// Equation M (check 8), which binds `Y` to the step, is [`fold_path`](crate::fold_path) of
/// `Y`'s leaf; the other checks are the transaction's.
pub fn verify(statement: &ReleaseStatement, proof: &ReleaseProof, fs_iv: &[u8; 32]) -> bool {
    checks(statement, proof, fs_iv).iter().all(|&holds| holds)
}

/// Each of V1–V7, in order, as [`verify`] describes them.
fn checks(statement: &ReleaseStatement, proof: &ReleaseProof, fs_iv: &[u8; 32]) -> [bool; 7] {
    let c = to_k256(&challenge(fs_iv, statement, &proof.t));
    let [t1, t2, t3, t4, t5, t6, t7] = proof.t.map(|t| to_point(&t));
    let z = proof.z.map(|z| to_k256(&z));
    // `z_s` is the response of the successor's `c'`
    let [z_c, z_rho, z_s, z_x, z_y, z_e, z_w1, z_r, z_r0, z_w2, z_tau] = z;
    let [a, a_c, v_c0, d0, d_next, v_s, w1, a_w1, w2, a_w2, y] = statement.points();
    let j = to_point(&release_j());

    // `W1 − A_w1`, normalized by the program
    let w1_less_asset = Some(w1 - a_w1).filter(|point| !bool::from(point.is_identity()));

    [
        add_scaled(&t1, &c, &v_c0).is_some_and(|q| linear_verify(&z_c, &a_c, &z_rho, &q)),
        add_scaled(&t2, &c, &v_s).is_some_and(|q| linear_verify(&z_s, &a_c, &z_x, &q)),
        add_scaled(&t3, &c, &y).is_some_and(|q| linear_verify(&z_y, &j, &z_x, &q)),
        w1_less_asset
            .and_then(|p| add_scaled(&t4, &c, &p))
            .is_some_and(|q| linear_verify(&z_e, &a_w1, &z_w1, &q)),
        add_scaled(&t5, &c, &d0).is_some_and(|q| linear_verify(&z_r, &a, &z_r0, &q)),
        add_scaled(&t6, &c, &w2).is_some_and(|q| linear_verify(&(z_r - z_e), &a_w2, &z_w2, &q)),
        add_scaled(&t7, &z_c, &d_next)
            .and_then(|q| add_scaled(&q, &z_e, &a))
            .is_some_and(|q| linear_verify(&z_s, &d0, &-z_tau, &q)),
    ]
}

/// `jet::linear_verify_1`: whether `a·P + b·G = Q`.
fn linear_verify(
    a: &k256::Scalar,
    p: &ProjectivePoint,
    b: &k256::Scalar,
    q: &ProjectivePoint,
) -> bool {
    *p * a + ProjectivePoint::GENERATOR * b == *q
}

/// The Fiat–Shamir challenge of a proof with the commitments `t`: `scalar(h₁₄)`, where
/// `h₀ = fs_iv`, `h₁ … h₇` absorb `D'`, `V_s`, `W1`, `A_w1`, `W2`, `A_w2` and `Y`, and
/// `h₈ … h₁₄` absorb `T1 … T7`, each step `compress(h, P.x, P.y)`.
pub fn challenge(fs_iv: &[u8; 32], statement: &ReleaseStatement, t: &[PublicKey; 7]) -> Scalar {
    let h14 = t.iter().fold(statement_digest(fs_iv, statement), absorb);

    scalar(&h14)
}

/// `h₇`, the statement's digest: `fs_iv` with `D'`, `V_s`, `W1`, `A_w1`, `W2`, `A_w2` and `Y`
/// absorbed.
fn statement_digest(fs_iv: &[u8; 32], statement: &ReleaseStatement) -> [u8; 32] {
    let s = statement;

    [&s.d_next, &s.v_s, &s.w1, &s.a_w1, &s.w2, &s.a_w2, &s.y]
        .into_iter()
        .fold(*fs_iv, absorb)
}

/// `compress(h, P.x, P.y)`.
fn absorb(h: [u8; 32], point: &PublicKey) -> [u8; 32] {
    let (x, y) = point_xy(point);

    compress(&h, &x, &y)
}

/// The program's `T + k·P`, normalized: `None` for the point at infinity, where the program's
/// `unwrap` fails.
fn add_scaled(
    t: &ProjectivePoint,
    k: &k256::Scalar,
    p: &ProjectivePoint,
) -> Option<ProjectivePoint> {
    Some(*p * k + t).filter(|sum| !bool::from(sum.is_identity()))
}

/// The nonces of the proof with `witness` of the statement whose digest is `h7`, as [`prove`]
/// describes them.
fn nonces(
    borrower: &LendingKey,
    h7: &[u8; 32],
    witness: &[k256::Scalar; 11],
) -> [k256::Scalar; 11] {
    let witness: Vec<u8> = witness.iter().flat_map(|w| w.to_bytes()).collect();
    let witness_hash = tagged_hash(WITNESS_TAG, &[&witness]);
    let borrower_sk = borrower.secret_key().secret_bytes();

    array::from_fn(|m| {
        let hash = tagged_hash(NONCE_TAG, &[&borrower_sk, h7, &witness_hash, &[m as u8]]);
        to_k256(&scalar(&hash))
    })
}

/// The curve point of a public key.
pub(crate) fn to_point(key: &PublicKey) -> ProjectivePoint {
    let encoded =
        EncodedPoint::from_bytes(key.serialize()).expect("a compressed key is a SEC1 encoding");
    let affine: Option<AffinePoint> = AffinePoint::from_encoded_point(&encoded).into();

    affine.expect("a public key is a curve point").into()
}

/// The public key of a curve point; `None` for the point at infinity.
fn to_public_key(point: &ProjectivePoint) -> Option<PublicKey> {
    if bool::from(point.is_identity()) {
        return None;
    }

    Some(
        PublicKey::from_slice(point.to_affine().to_encoded_point(true).as_bytes())
            .expect("a finite curve point is a public key"),
    )
}

/// A scalar for k256's arithmetic.
pub(crate) fn to_k256(value: &Scalar) -> k256::Scalar {
    Option::from(k256::Scalar::from_repr(value.to_be_bytes().into()))
        .expect("a scalar is below the curve order")
}

/// A scalar from k256's arithmetic.
fn from_k256(value: &k256::Scalar) -> Scalar {
    Scalar::from_be_bytes(value.to_bytes().into()).expect("a k256 scalar is below the curve order")
}

/// A value blinder as a scalar.
fn blinder_scalar(blinder: &ValueBlindingFactor) -> Scalar {
    Scalar::from_be_bytes(*blinder.into_inner().as_ref()).expect("a blinder is below the order")
}

#[cfg(test)]
pub(crate) mod tests {
    use elements::AssetId;
    use elements::confidential::AssetBlindingFactor;
    use elements::hashes::{Hash, sha256};
    use elements::hex::ToHex;
    use elements::secp256k1_zkp::SECP256K1;

    use super::*;
    use crate::release::{blinder_commitment, blinder_leaf, fold_path};
    use crate::test_util::sequence;
    use crate::{
        BlinderTree, MAX_COLLATERAL, MAX_REPAYMENT, OfferPinned, OfferSecrets, OfferTerms,
        asset_point, value_point,
    };

    fn asset(byte: u8) -> AssetId {
        AssetId::from_slice(&[byte; 32]).unwrap()
    }

    fn k256_of(bytes: [u8; 32]) -> k256::Scalar {
        to_k256(&Scalar::from_be_bytes(bytes).unwrap())
    }

    fn vbf(value: k256::Scalar) -> ValueBlindingFactor {
        ValueBlindingFactor::from_slice(&value.to_bytes()).unwrap()
    }

    fn abf(value: k256::Scalar) -> AssetBlindingFactor {
        AssetBlindingFactor::from_slice(&value.to_bytes()).unwrap()
    }

    /// A loan of the fixed offer: shared secret 0x80..=0x9f, as `release.rs`'s known answers.
    pub(crate) struct Loan {
        pub(crate) secrets: OfferSecrets,
        pub(crate) pinned: OfferPinned,
    }

    pub(crate) fn loan(collateral: u64, repayment: u64) -> Loan {
        let secrets =
            OfferSecrets::from_shared_secret(SecretKey::from_slice(&sequence(0x80)).unwrap());
        let terms = OfferTerms {
            principal_asset: asset(0xaa),
            principal_amount: repayment.min(10_000),
            repayment_amount: repayment,
            interest_rate_bps: 1_000,
            loan_expiration_time: 1_000,
            borrower_nft: asset(0x44),
            lender_nft: asset(0x55),
        };
        let pinned = OfferPinned::derive(&secrets, asset(0xcc), collateral, &terms);

        Loan { secrets, pinned }
    }

    /// What an installment's outputs hold, from which its statement follows. A tamper changes one
    /// field.
    #[derive(Clone, Copy)]
    pub(crate) struct Installment {
        /// `i`: the successor is at step `i + 1`.
        step: u32,
        debt_left: DebtOpening,
        /// The successor's amount.
        c_next: u64,
        /// The coefficient of `G` in the successor's value commitment.
        x: k256::Scalar,
        /// The opening of `Y`, `(x, y)`.
        y_opening: (k256::Scalar, k256::Scalar),
        /// The carries' amounts.
        carries: (u64, u64),
    }

    /// The carries' asset and value blinders.
    fn carry_blinders() -> ((k256::Scalar, k256::Scalar), (k256::Scalar, k256::Scalar)) {
        (
            (k256_of(sequence(0x21)), k256_of(sequence(0x61))),
            (k256_of(sequence(0x41)), k256_of(sequence(0xa1))),
        )
    }

    /// The blinder of the debt left, fixed.
    fn debt_left(amount: u64) -> DebtOpening {
        DebtOpening {
            amount,
            blinder: vbf(k256_of(sequence(0x01))),
        }
    }

    impl Loan {
        fn collateral(&self) -> u64 {
            self.pinned.active_collateral.amount
        }

        fn repayment(&self) -> u64 {
            self.pinned.repayment.amount
        }

        /// The honest installment at `step` that leaves `debt` owed.
        pub(crate) fn installment(&self, step: u32, debt: u64) -> Installment {
            let (c, r) = (self.collateral(), self.repayment());
            let e = carry_remainder(debt, c, r);
            let (x, y) = self.secrets.release_blinders(step + 1);
            let (x, y) = (to_k256(&Scalar::from(x)), to_k256(&Scalar::from(y)));

            Installment {
                step,
                debt_left: debt_left(debt),
                c_next: collateral_at(debt, c, r),
                x,
                y_opening: (x, y),
                carries: (e + 1, r - e),
            }
        }

        /// The honest secrets of the honest installment at `step` that leaves `debt` owed.
        pub(crate) fn secrets(&self, step: u32, debt: u64) -> ReleaseSecrets {
            let ((_, w1), (_, w2)) = carry_blinders();
            ReleaseSecrets::new(
                &self.pinned.active_collateral,
                &self.pinned.repayment,
                debt_left(debt),
                self.secrets.release_blinders(step + 1),
                (vbf(w1), vbf(w2)),
            )
        }

        /// The outputs of `installment`: the successor and the two carries.
        pub(crate) fn outputs(&self, installment: &Installment) -> [PinnedOutput; 3] {
            let active = self.pinned.active_collateral;
            let next = k256::Scalar::from(u64::from(installment.step + 1));
            let a_c = to_k256(
                &Scalar::from_be_bytes(*active.asset_blinding_factor.into_inner().as_ref())
                    .unwrap(),
            );
            let successor = PinnedOutput {
                asset_id: active.asset_id,
                amount: installment.c_next,
                asset_blinding_factor: abf(a_c + next),
                value_blinding_factor: vbf(
                    installment.x - k256::Scalar::from(installment.c_next) * next
                ),
            };
            let ((abf1, vbf1), (abf2, vbf2)) = carry_blinders();
            let carry = |amount, asset_blinder, value_blinder| PinnedOutput {
                asset_id: asset(0xee),
                amount,
                asset_blinding_factor: abf(asset_blinder),
                value_blinding_factor: vbf(value_blinder),
            };

            [
                successor,
                carry(installment.carries.0, abf1, vbf1),
                carry(installment.carries.1, abf2, vbf2),
            ]
        }

        /// The statement of `installment`, its points read from the outputs' commitments as the
        /// program reads them.
        pub(crate) fn statement(&self, installment: &Installment) -> ReleaseStatement {
            let (repayment, active) = (self.pinned.repayment, self.pinned.active_collateral);
            let [successor, w1, w2] = self.outputs(installment);
            let (x, y) = installment.y_opening;

            ReleaseStatement {
                a: asset_point(&repayment.asset_commitment()).unwrap(),
                a_c: asset_point(&active.asset_commitment()).unwrap(),
                v_c0: value_point(&active.value_commitment()).unwrap(),
                d0: value_point(&repayment.value_commitment()).unwrap(),
                d_next: value_point(&installment.debt_left.commitment(&repayment)).unwrap(),
                v_s: value_point(&successor.value_commitment()).unwrap(),
                w1: value_point(&w1.value_commitment()).unwrap(),
                a_w1: asset_point(&w1.asset_commitment()).unwrap(),
                w2: value_point(&w2.value_commitment()).unwrap(),
                a_w2: asset_point(&w2.asset_commitment()).unwrap(),
                y: blinder_commitment(
                    &SecretKey::from_slice(&x.to_bytes()).unwrap(),
                    &SecretKey::from_slice(&y.to_bytes()).unwrap(),
                    &release_j(),
                ),
            }
        }
    }

    /// The fixed installment of the known answers: `C = 50,000`, `R = 11,000`, at step 2, leaving
    /// 8,000 owed, so `c' = 36,364` and `e = 4,000`.
    const KNOWN: (u64, u64, u32, u64) = (50_000, 11_000, 2, 8_000);

    pub(crate) fn borrower() -> LendingKey {
        LendingKey::from_master_blinding_key(&[1; 32])
    }

    /// The proof of the fixed installment.
    fn known() -> (
        Loan,
        Installment,
        ReleaseStatement,
        ReleaseSecrets,
        ReleaseProof,
    ) {
        let (c, r, step, debt) = KNOWN;
        let loan = loan(c, r);
        let installment = loan.installment(step, debt);
        let statement = loan.statement(&installment);
        let secrets = loan.secrets(step, debt);
        let proof = prove(&statement, &secrets, &borrower());

        (loan, installment, statement, secrets, proof)
    }

    pub(crate) fn loan_fs_iv(statement: &ReleaseStatement) -> [u8; 32] {
        fs_iv(&statement.a, &statement.a_c, &statement.v_c0, &statement.d0)
    }

    /// The checks V1–V7 of the proof of `statement` with `secrets`.
    fn checks_of(statement: &ReleaseStatement, secrets: &ReleaseSecrets) -> [bool; 7] {
        let proof = prove(statement, secrets, &borrower());
        checks(statement, &proof, &loan_fs_iv(statement))
    }

    /// The checks that hold everywhere but at `failing`, one-based as V1–V7.
    fn all_but(failing: usize) -> [bool; 7] {
        array::from_fn(|i| i + 1 != failing)
    }

    fn plus_one(value: &Scalar) -> Scalar {
        from_k256(&(to_k256(value) + k256::Scalar::ONE))
    }

    // ---- the honest proof

    #[test]
    fn honest_proof_verifies() {
        let (_, _, statement, _, proof) = known();
        let fs_iv = loan_fs_iv(&statement);

        assert_eq!(checks(&statement, &proof, &fs_iv), [true; 7]);
        assert!(verify(&statement, &proof, &fs_iv));
    }

    /// Edges of the arithmetic: `e = 0`, `e = R − 1`, a release of 0, `C > R`, the first step and
    /// the last, and the largest terms.
    #[test]
    fn honest_proofs_verify_at_the_edges() {
        // (C, R, step, d', the expected e)
        let cases = [
            (50_000, 11_000, 0, 5_500, Some(0)),
            (7, 10, 0, 3, Some(9)),
            (1, 10, 4, 9, None),
            (1, 1_000_000, 1023, 1, Some(999_999)),
            (MAX_COLLATERAL, MAX_REPAYMENT, 0, MAX_REPAYMENT - 1, None),
            (
                MAX_COLLATERAL,
                MAX_REPAYMENT,
                7,
                1,
                Some(MAX_REPAYMENT - MAX_COLLATERAL),
            ),
        ];
        for (c, r, step, debt, e) in cases {
            let loan = loan(c, r);
            let statement = loan.statement(&loan.installment(step, debt));
            let secrets = loan.secrets(step, debt);
            if let Some(e) = e {
                assert_eq!(secrets.e, e);
            }

            assert_eq!(
                checks_of(&statement, &secrets),
                [true; 7],
                "C {c}, R {r}, d' {debt}"
            );
        }
    }

    #[test]
    fn honest_secrets_are_the_installments() {
        let (loan, installment, _, secrets, _) = known();
        let (collateral, repayment) = (loan.pinned.active_collateral, loan.pinned.repayment);
        let (x, y) = installment.y_opening;
        let ((_, w1), (_, w2)) = carry_blinders();

        assert_eq!(
            secrets,
            ReleaseSecrets {
                collateral: 50_000,
                rho: blinder_scalar(&collateral.value_blinding_factor),
                c_next: 36_364,
                x: from_k256(&x),
                y: from_k256(&y),
                e: 4_000,
                w1: from_k256(&w1),
                repayment: 11_000,
                r0: blinder_scalar(&repayment.value_blinding_factor),
                w2: from_k256(&w2),
                tau: from_k256(
                    &(k256::Scalar::from(36_364u64)
                        * to_k256(&blinder_scalar(&repayment.value_blinding_factor))
                        - k256::Scalar::from(50_000u64) * k256_of(sequence(0x01)))
                ),
            }
        );
        assert_eq!(installment.carries, (4_001, 7_000));
    }

    // ---- determinism and the nonces

    #[test]
    fn two_builds_of_one_statement_give_the_same_proof() {
        let (_, _, statement, secrets, proof) = known();

        assert_eq!(prove(&statement, &secrets, &borrower()), proof);
    }

    #[test]
    fn nonces_depend_on_the_key_the_statement_and_the_witness() {
        let (loan, _, statement, secrets, proof) = known();

        // another borrower key
        let other_key = LendingKey::from_master_blinding_key(&[2; 32]);
        let other = prove(&statement, &secrets, &other_key);
        assert!(verify(&statement, &other, &loan_fs_iv(&statement)));
        assert!(other.t.iter().zip(proof.t).all(|(a, b)| *a != b));

        // another statement: another payment
        let (_, _, step, debt) = KNOWN;
        let next = loan.statement(&loan.installment(step, debt - 1));
        let next_proof = prove(&next, &loan.secrets(step, debt - 1), &borrower());
        assert!(next_proof.t.iter().zip(proof.t).all(|(a, b)| *a != b));

        // one statement, another witness: R1 gives it other nonces, so the responses' difference
        // is not c·(w − w')
        let wrong = ReleaseSecrets {
            e: secrets.e + 1,
            ..secrets
        };
        let wrong_proof = prove(&statement, &wrong, &borrower());
        assert!(wrong_proof.t.iter().zip(proof.t).all(|(a, b)| *a != b));
    }

    // ---- known answers, from the independent computation in the task report

    #[test]
    fn fs_iv_of_the_fixed_offer_known_answer() {
        let (_, _, statement, _, _) = known();

        assert_eq!(
            loan_fs_iv(&statement).to_hex(),
            "00e97c5971248d9ea14599d7a07d7905b10a40da3519faa0d361abe439078bbe"
        );
    }

    #[test]
    fn nonces_known_answer() {
        let (_, _, statement, secrets, _) = known();
        let h7 = statement_digest(&loan_fs_iv(&statement), &statement);
        assert_eq!(
            h7.to_hex(),
            "c3396396c6e033f31e5e5de0cc8fc22942737850a4910b1e7092512e20a99eb4"
        );

        let k = nonces(&borrower(), &h7, &secrets.scalars());
        assert_eq!(
            from_k256(&k[0]).to_be_bytes().to_hex(),
            "2c9ed952e6445ad7ec85ade7aba36ab7c02b3646567aedca8bd74f6a2eb0ded4"
        );
        assert_eq!(
            from_k256(&k[5]).to_be_bytes().to_hex(),
            "615e4ff0c9ea28aa209a6b0b5c31d6fc226856523a6c63da14eabd070b15398a"
        );
        assert_eq!(
            from_k256(&k[10]).to_be_bytes().to_hex(),
            "a3a404b2712b548832ac0604849d637df574ee3bd5426f28376863b1e73d1f33"
        );
    }

    #[test]
    fn challenge_known_answer() {
        let (_, _, statement, _, proof) = known();

        assert_eq!(
            proof.t[0].serialize().to_hex(),
            "0223d9ced726d734b5fe6104ce4e1d51a07e9b09b71acc05a44f884b8d6b44c387"
        );
        assert_eq!(
            proof.t[6].serialize().to_hex(),
            "02cb7108d45ef592f9174791226168773f08d1a26e7aa0eabf5bf016dc004f0c21"
        );
        assert_eq!(
            challenge(&loan_fs_iv(&statement), &statement, &proof.t)
                .to_be_bytes()
                .to_hex(),
            "f6dd55f75d0e52534313a037d3a072ba0696bd17c2baf1cbe6cb172544dbec14"
        );
    }

    #[test]
    fn proof_known_answer() {
        let (_, _, statement, _, proof) = known();
        assert_eq!(
            statement.y.serialize().to_hex(),
            "0301948c23ef593506ef70026125202285f9d21f3e5f14b7b7080ca079fbf75a3a"
        );
        assert_eq!(
            proof.z[0].to_be_bytes().to_hex(),
            "ea452281e37380f4d5b2458d052be734c5a8ebe8afba7922b00263c09de1f7fd"
        );
        assert_eq!(
            proof.z[10].to_be_bytes().to_hex(),
            "d06a058e6fb5f30eb5eaf4f2d151b60aa3b92738ddc10c02e3c63c8d40e685d1"
        );

        // every commitment and response, as x ‖ y and 32 bytes
        let mut bytes = Vec::new();
        for t in &proof.t {
            let (x, y) = point_xy(t);
            bytes.extend(x);
            bytes.extend(y);
        }
        for z in &proof.z {
            bytes.extend(z.to_be_bytes());
        }
        assert_eq!(
            sha256::Hash::hash(&bytes).to_byte_array().to_hex(),
            "53e3de8c542716ee470d141bf291f70dd0e9189b21fdd80fe3000105059e636d"
        );
    }

    // ---- the tampers the proof sees: each cheater uses the witness most consistent with its
    // outputs, and fails at the one equation the tamper breaks

    #[test]
    fn successor_one_unit_off_fails_v7() {
        let (loan, installment, _, secrets, _) = known();
        for c_next in [secrets.c_next + 1, secrets.c_next - 1] {
            let statement = loan.statement(&Installment {
                c_next,
                ..installment
            });
            let cheat = ReleaseSecrets { c_next, ..secrets };

            assert_eq!(checks_of(&statement, &cheat), all_but(7), "c' = {c_next}");
        }
    }

    #[test]
    fn carries_split_wrong_fail() {
        let (loan, installment, _, secrets, _) = known();
        let (r, e) = (secrets.repayment, secrets.e);

        // (e, R − e + 1): consistent for e − 1 in E4 and E6, so E7 fails
        let statement = loan.statement(&Installment {
            carries: (e, r - e + 1),
            ..installment
        });
        let cheat = ReleaseSecrets {
            e: e - 1,
            ..secrets
        };
        assert_eq!(checks_of(&statement, &cheat), all_but(7));

        // (e + 2, R − e − 1): consistent for e + 1, so E7 fails
        let statement = loan.statement(&Installment {
            carries: (e + 2, r - e - 1),
            ..installment
        });
        let cheat = ReleaseSecrets {
            e: e + 1,
            ..secrets
        };
        assert_eq!(checks_of(&statement, &cheat), all_but(7));

        // summing to R + 2 or R: the second carry disagrees with the honest e
        for second in [r - e + 1, r - e - 1] {
            let statement = loan.statement(&Installment {
                carries: (e + 1, second),
                ..installment
            });
            assert_eq!(
                checks_of(&statement, &secrets),
                all_but(6),
                "W2 holds {second}"
            );
        }
    }

    #[test]
    fn random_blinder_against_the_honest_y_fails_v3() {
        let (loan, installment, _, secrets, _) = known();
        let random = k256_of(sequence(0x33));
        let statement = loan.statement(&Installment {
            x: random,
            ..installment
        });

        // knowing the successor's blinder, E2 holds and E3 does not
        let cheat = ReleaseSecrets {
            x: from_k256(&random),
            ..secrets
        };
        assert_eq!(checks_of(&statement, &cheat), all_but(3));
        // with the committed x, E2 does not hold
        assert_eq!(checks_of(&statement, &secrets), all_but(2));
    }

    /// A self-made `Y` whose opening the cheater knows passes V1–V7: equation M refuses it.
    #[test]
    fn self_made_y_passes_the_sigma_checks_and_fails_m() {
        let (loan, installment, statement, secrets, _) = known();
        let tree = BlinderTree::new(&loan.secrets);
        let path = tree.path(installment.step);
        let honest_leaf = blinder_leaf(&statement.y);
        assert_eq!(
            fold_path(honest_leaf, &path),
            (tree.root(), installment.step)
        );

        let (x, y) = (k256_of(sequence(0x33)), k256_of(sequence(0x55)));
        let self_made = Installment {
            x,
            y_opening: (x, y),
            ..installment
        };
        let statement = loan.statement(&self_made);
        let cheat = ReleaseSecrets {
            x: from_k256(&x),
            y: from_k256(&y),
            ..secrets
        };
        assert_eq!(checks_of(&statement, &cheat), [true; 7]);

        let leaf = blinder_leaf(&statement.y);
        assert_ne!(fold_path(leaf, &path).0, tree.root());
    }

    #[test]
    fn proof_against_another_y_fails() {
        let (loan, installment, statement, _, proof) = known();
        let (x, y) = (k256_of(sequence(0x33)), k256_of(sequence(0x55)));
        let other = loan.statement(&Installment {
            y_opening: (x, y),
            ..installment
        });

        assert!(!verify(&other, &proof, &loan_fs_iv(&statement)));
    }

    #[test]
    fn altered_responses_and_commitments_fail() {
        let (_, _, statement, _, proof) = known();
        let fs_iv = loan_fs_iv(&statement);

        for m in 0..11 {
            let mut altered = proof;
            altered.z[m] = plus_one(&proof.z[m]);
            assert!(!verify(&statement, &altered, &fs_iv), "z_{m} + 1");
        }
        for j in 0..7 {
            let mut altered = proof;
            altered.t[j] = proof.t[j].add_exp_tweak(SECP256K1, &Scalar::ONE).unwrap();
            assert!(!verify(&statement, &altered, &fs_iv), "T{} + G", j + 1);
        }
        // the commitments swapped
        let mut swapped = proof;
        swapped.t.swap(0, 1);
        assert!(!verify(&statement, &swapped, &fs_iv));
    }

    #[test]
    fn proof_of_another_statement_fails() {
        let (loan, _, statement, _, proof) = known();
        let (_, _, step, debt) = KNOWN;

        // the next payment's installment, and the same one at another step
        for (step, debt) in [(step, debt - 1), (step + 1, debt)] {
            let other = loan.statement(&loan.installment(step, debt));
            let fs_iv = loan_fs_iv(&other);
            assert!(verify(
                &other,
                &prove(&other, &loan.secrets(step, debt), &borrower()),
                &fs_iv
            ));
            assert!(!verify(&other, &proof, &fs_iv));
        }

        // another loan's IV
        let other_loan = self::loan(50_001, 11_000);
        let other_iv = loan_fs_iv(&other_loan.statement(&other_loan.installment(2, 8_000)));
        assert!(!verify(&statement, &proof, &other_iv));
    }

    // ---- where the program fails on a point at infinity

    /// `W1 = A_w1`: one unit with a zero blinder. E4 holds with `e = 0` and `w1 = 0`, but the
    /// program's `W1 − A_w1` is the point at infinity, which it cannot normalize.
    #[test]
    fn first_carry_equal_to_its_asset_fails_v4() {
        // C = 5, R = 10, d' = 2: c' = 1 and e = 0
        let loan = loan(5, 10);
        let mut statement = loan.statement(&loan.installment(0, 2));
        let mut secrets = loan.secrets(0, 2);
        assert_eq!(secrets.e, 0);
        statement.w1 = statement.a_w1;
        secrets.w1 = Scalar::ZERO;

        assert_eq!(checks_of(&statement, &secrets), all_but(4));
    }

    #[test]
    fn add_scaled_refuses_the_point_at_infinity() {
        let g = ProjectivePoint::GENERATOR;
        let k = k256::Scalar::from(5u64);

        assert_eq!(
            add_scaled(&(g * k), &k, &g),
            Some(g * k256::Scalar::from(10u64))
        );
        assert_eq!(add_scaled(&-(g * k), &k, &g), None);
        // a zero multiple is the point at infinity, which the jets' `scale` gives
        assert_eq!(add_scaled(&g, &k256::Scalar::ZERO, &g), Some(g));
    }
}
