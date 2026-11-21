//! The release of collateral by installments: how much collateral a loan holds at each step, the
//! bounds the lender checks at acceptance, and the derived values of the liquidation repair.
//!
//! A loan with collateral `C` and full repayment `R` holds, while it owes `d`, the collateral
//! `c = ceil(d·C/R)` ([`collateral_at`]), and `e = c·R − d·C`, with `0 ≤ e ≤ R − 1`, is the
//! remainder its carry outputs hold ([`carry_remainder`]). With `paid = R − d`, the collateral
//! released so far is `C − c = floor(paid·C/R)`, so the releases of a loan add up to `C` exactly.
//! Every figure is computed in `u128`.
//!
//! The repair lets the lender open the collateral after installments it cannot read. Each step `j`
//! of a loan has two blinders `x_j` and `y_j` ([`OfferSecrets::release_blinders`]), and the
//! collateral at step `j` has the value commitment `c_j·A_c + x_j·G`. The commitments
//! `Y_j = x_j·G + y_j·J`, with `J` a point whose discrete logarithm nobody knows ([`release_j`]),
//! are the leaves of a Merkle tree ([`BlinderTree`]) whose root the contract takes as a parameter.
//! The release proof's Fiat–Shamir challenge starts from a per-loan IV ([`fs_iv`]).
//!
//! The tree and the challenge hash with SHA-256's compression function alone, as the contract's
//! `jet::sha_256_block` does: `compress(h, a, b)` is the compression of the 64-byte block `a ‖ b`
//! from the chaining value `h`, with no padding and no length.

use std::fmt;

use elements::hashes::{Hash, HashEngine, sha256};
use elements::secp256k1_zkp::{PublicKey, SECP256K1, Scalar, SecretKey};
use k256::elliptic_curve::ops::Reduce;
use k256::{FieldElement, U256};

use crate::OfferSecrets;

/// The carry token's supply, which the creation transaction issues for each loan.
pub const CARRY_SUPPLY: u64 = 1 << 50;
/// The largest collateral the lender accepts, in base units.
pub const MAX_COLLATERAL: u64 = 1 << 44;
/// The largest full repayment the lender accepts, in base units: the carries need `R + 1` units
/// of the supply, and the first installment burns a leftover of at least 1.
pub const MAX_REPAYMENT: u64 = CARRY_SUPPLY - 2;
/// The most installments a loan can have: the Merkle tree has one leaf for each.
pub const MAX_STEPS: u32 = 1024;
/// The depth of the Merkle tree of the blinder commitments.
const TREE_DEPTH: usize = 10;

/// The chaining value of the tree's leaves,
/// `SHA-256("simplicity-lending/private/v1/release-leaf")`.
pub const LEAF_IV: [u8; 32] = [
    0xbb, 0xf7, 0xd7, 0xdb, 0x42, 0xaf, 0xe9, 0xbc, //
    0x57, 0x6c, 0x22, 0xb0, 0x06, 0x77, 0x2d, 0x76, //
    0xa1, 0x6e, 0x07, 0xd7, 0x0e, 0x5d, 0x11, 0x20, //
    0x77, 0x4a, 0xcd, 0xa8, 0x20, 0x54, 0x2c, 0x41, //
];
/// The chaining value of the tree's inner nodes,
/// `SHA-256("simplicity-lending/private/v1/release-node")`.
pub const NODE_IV: [u8; 32] = [
    0xbe, 0x7d, 0x66, 0xef, 0x2b, 0x12, 0xa4, 0xce, //
    0x86, 0x0b, 0xd5, 0x6b, 0x5f, 0x69, 0xb7, 0x50, //
    0x94, 0x7b, 0x37, 0x10, 0x39, 0x1d, 0xe9, 0xfe, //
    0x88, 0x3d, 0xd8, 0xe7, 0x9f, 0xf9, 0xf6, 0xcd, //
];

/// The prefix of the hashes that try x-coordinates for `J`.
const J_TAG: &[u8] = b"simplicity-lending/private/v1/release-J";
/// The prefix of the hash that gives the Fiat–Shamir IV.
const FS_TAG: &[u8] = b"simplicity-lending/private/v1/release-fs";

/// Why a loan's terms fall outside the bounds of proportional release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseError {
    /// The collateral is 0 or above [`MAX_COLLATERAL`].
    CollateralOutOfBounds,
    /// The full repayment is 0 or above [`MAX_REPAYMENT`].
    RepaymentOutOfBounds,
}

impl fmt::Display for ReleaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CollateralOutOfBounds => {
                write!(
                    f,
                    "the collateral must be between 1 and {MAX_COLLATERAL} base units"
                )
            }
            Self::RepaymentOutOfBounds => {
                write!(
                    f,
                    "the repayment must be between 1 and {MAX_REPAYMENT} base units"
                )
            }
        }
    }
}

impl std::error::Error for ReleaseError {}

/// Whether a loan of `collateral` and full repayment `repayment` is within the bounds the lender
/// checks at acceptance: `1 ≤ C ≤ 2^44` and `1 ≤ R ≤ 2^50 − 2`. The bound on `R` is what the
/// release proof's integer argument rests on, since no range proof bounds `R`.
///
/// # Errors
/// Returns [`ReleaseError::CollateralOutOfBounds`] or [`ReleaseError::RepaymentOutOfBounds`] for
/// the first amount outside its bounds.
pub fn check_bounds(collateral: u64, repayment: u64) -> Result<(), ReleaseError> {
    if !(1..=MAX_COLLATERAL).contains(&collateral) {
        return Err(ReleaseError::CollateralOutOfBounds);
    }
    if !(1..=MAX_REPAYMENT).contains(&repayment) {
        return Err(ReleaseError::RepaymentOutOfBounds);
    }

    Ok(())
}

/// The collateral a loan holds while it owes `debt`: `ceil(debt·collateral/repayment)`.
///
/// # Panics
/// If `repayment` is 0 or `debt` is above it: no loan owes more than its full repayment.
pub fn collateral_at(debt: u64, collateral: u64, repayment: u64) -> u64 {
    assert!(repayment > 0, "a loan's repayment is at least 1");
    assert!(
        debt <= repayment,
        "a loan never owes more than its repayment"
    );
    let (debt, collateral, repayment) = (
        u128::from(debt),
        u128::from(collateral),
        u128::from(repayment),
    );

    // at most `collateral`, since `debt ≤ repayment`
    ((debt * collateral).div_ceil(repayment)) as u64
}

/// The remainder `e = c·repayment − debt·collateral` of a loan that owes `debt` and holds
/// `c = collateral_at(debt, collateral, repayment)`, with `0 ≤ e ≤ repayment − 1`: what the
/// carry outputs hold, `e + 1` and `repayment − e` units.
///
/// # Panics
/// As [`collateral_at`].
pub fn carry_remainder(debt: u64, collateral: u64, repayment: u64) -> u64 {
    let held = collateral_at(debt, collateral, repayment);

    // below `repayment`, by the ceiling
    (u128::from(held) * u128::from(repayment) - u128::from(debt) * u128::from(collateral)) as u64
}

/// The collateral that paying `payment` of `debt` releases: the collateral at `debt` minus the
/// collateral at `debt − payment`. A full repayment (`payment = debt`) releases all the collateral
/// left; an installment may release 0.
///
/// # Panics
/// If `payment` is above `debt`, and as [`collateral_at`].
pub fn release_of(debt: u64, payment: u64, collateral: u64, repayment: u64) -> u64 {
    assert!(payment <= debt, "the payment is above the debt");

    collateral_at(debt, collateral, repayment)
        - collateral_at(debt - payment, collateral, repayment)
}

/// `J`, the point with the even `y` whose x-coordinate is the first
/// `X_t = SHA-256("simplicity-lending/private/v1/release-J" ‖ t)`, `t = 0, 1, …` as 4 big-endian
/// bytes, that has one. Nobody knows its discrete logarithm to base `G`.
pub fn release_j() -> PublicKey {
    (0u32..)
        .find_map(|t| {
            let x = sha256::Hash::hash(&[J_TAG, &t.to_be_bytes()].concat()).to_byte_array();
            even_y_point(&x)
        })
        .expect("about half of all x-coordinates have a point")
}

/// The point with x-coordinate `x` and an even `y`, if there is one. An `x` at or above the field's
/// prime is rejected, not reduced.
fn even_y_point(x: &[u8; 32]) -> Option<PublicKey> {
    let below_prime: bool = FieldElement::from_bytes(&(*x).into()).is_some().into();
    if !below_prime {
        return None;
    }
    let mut compressed = [0x02; 33];
    compressed[1..].copy_from_slice(x);

    PublicKey::from_slice(&compressed).ok()
}

/// The IV of an installment's Fiat–Shamir challenge,
/// `SHA-256("simplicity-lending/private/v1/release-fs" ‖ A ‖ A_c ‖ V_c0 ‖ D₀ ‖ J)` with each point
/// as its `x ‖ y`: the repayment asset `A`, the active collateral's asset and value commitments
/// `A_c` and `V_c0`, the debt at acceptance `D₀`, and [`release_j`]. It binds the challenge to
/// every constant of the statement.
pub fn fs_iv(a: &PublicKey, a_c: &PublicKey, v_c0: &PublicKey, d0: &PublicKey) -> [u8; 32] {
    let mut engine = sha256::Hash::engine();
    engine.input(FS_TAG);
    for point in [a, a_c, v_c0, d0, &release_j()] {
        let (x, y) = point_xy(point);
        engine.input(&x);
        engine.input(&y);
    }

    sha256::Hash::from_engine(engine).to_byte_array()
}

/// The Merkle tree of an offer's blinder commitments `Y_1 … Y_1024`.
///
/// Leaf `i`, for `i = 0 … 1023`, is `compress(LEAF_IV, Y_(i+1).x, Y_(i+1).y)`: the commitment an
/// installment at step `i` uses for its successor. A node is `compress(NODE_IV, left, right)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlinderTree {
    /// The levels from the leaves up: `levels[k]` has `1024 >> k` nodes, and `levels[10]` is the
    /// root.
    levels: Vec<Vec<[u8; 32]>>,
}

impl BlinderTree {
    /// The tree of the offer with `secrets`, which its borrower and its lender build alike.
    pub fn new(secrets: &OfferSecrets) -> BlinderTree {
        let j = release_j();
        let leaves: Vec<[u8; 32]> = (1..=MAX_STEPS)
            .map(|step| {
                let (x, y) = secrets.release_blinders(step);
                blinder_leaf(&blinder_commitment(&x, &y, &j))
            })
            .collect();

        let mut levels = vec![leaves];
        for _ in 0..TREE_DEPTH {
            let parents = levels[levels.len() - 1]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|[left, right]| compress(&NODE_IV, left, right))
                .collect();
            levels.push(parents);
        }

        BlinderTree { levels }
    }

    /// The root, the contract's `BLINDER_ROOT`.
    pub fn root(&self) -> [u8; 32] {
        self.levels[TREE_DEPTH][0]
    }

    /// Leaf `i`, of `Y_(i+1)`.
    ///
    /// # Panics
    /// If `i` is 1024 or above.
    pub fn leaf(&self, i: u32) -> [u8; 32] {
        self.levels[0][leaf_index(i)]
    }

    /// The path of leaf `i` as the installment's witness lists it: 10 pairs `(is_right, sibling)`
    /// from the leaf up, `is_right` being bit `k` of `i` at level `k`.
    ///
    /// # Panics
    /// If `i` is 1024 or above.
    pub fn path(&self, i: u32) -> [(bool, [u8; 32]); TREE_DEPTH] {
        let i = leaf_index(i);

        std::array::from_fn(|k| {
            let node = i >> k;
            (node & 1 == 1, self.levels[k][node ^ 1])
        })
    }
}

/// `i` as an index of the leaves.
///
/// # Panics
/// If `i` is 1024 or above.
fn leaf_index(i: u32) -> usize {
    assert!(
        i < MAX_STEPS,
        "the tree has no leaf {i}: it has {MAX_STEPS}"
    );

    i as usize
}

/// What the contract computes from a leaf and its path: the root they fold to, and the index that
/// the path's `is_right` bits spell. Equation M holds when the root is `BLINDER_ROOT` and the index
/// is the witness's.
pub fn fold_path(leaf: [u8; 32], path: &[(bool, [u8; 32]); TREE_DEPTH]) -> ([u8; 32], u32) {
    path.iter()
        .enumerate()
        .fold((leaf, 0), |(node, index), (k, (is_right, sibling))| {
            let parent = if *is_right {
                compress(&NODE_IV, sibling, &node)
            } else {
                compress(&NODE_IV, &node, sibling)
            };
            (parent, index | u32::from(*is_right) << k)
        })
}

/// The leaf of a blinder commitment `Y`, `compress(LEAF_IV, Y.x, Y.y)`.
pub(crate) fn blinder_leaf(y: &PublicKey) -> [u8; 32] {
    let (x, y) = point_xy(y);

    compress(&LEAF_IV, &x, &y)
}

/// The blinder commitment `x·G + y·J`.
pub(crate) fn blinder_commitment(x: &SecretKey, y: &SecretKey, j: &PublicKey) -> PublicKey {
    let y_j = j
        .mul_tweak(SECP256K1, &Scalar::from(*y))
        .expect("a nonzero multiple of a curve point is a curve point");

    PublicKey::from_secret_key(SECP256K1, x)
        .combine(&y_j)
        .expect("x·G + y·J is the point at infinity with negligible probability")
}

/// `compress(h, a, b)`: SHA-256's compression of the 64-byte block `a ‖ b` from the chaining value
/// `h`, with no padding and no length, as `jet::sha_256_block` computes it.
pub(crate) fn compress(h: &[u8; 32], a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut engine = sha256::HashEngine::from_midstate(sha256::Midstate::from_byte_array(*h), 0);
    engine.input(a);
    engine.input(b);

    // the engine has compressed the full block and holds no partial one
    engine.midstate().to_byte_array()
}

/// `scalar(b)`: the 32 bytes `b` read big-endian and reduced modulo the curve order.
pub(crate) fn scalar(bytes: &[u8; 32]) -> Scalar {
    let reduced = <k256::Scalar as Reduce<U256>>::reduce_bytes(&(*bytes).into());

    Scalar::from_be_bytes(reduced.to_bytes().into()).expect("a reduced scalar is below the order")
}

/// The affine coordinates of a point as two 32-byte big-endian words.
pub(crate) fn point_xy(point: &PublicKey) -> ([u8; 32], [u8; 32]) {
    let uncompressed = point.serialize_uncompressed();
    let x = uncompressed[1..33]
        .try_into()
        .expect("an uncompressed point is 0x04, x and y");
    let y = uncompressed[33..]
        .try_into()
        .expect("an uncompressed point is 0x04, x and y");

    (x, y)
}

#[cfg(test)]
mod tests {
    use elements::hex::{FromHex, ToHex};
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};

    use super::*;
    use crate::test_util::sequence;

    /// The curve order, big-endian.
    const ORDER: &str = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

    fn bytes32(hex: &str) -> [u8; 32] {
        <[u8; 32]>::from_hex(hex).unwrap()
    }

    /// The fixed offer of the known answers: the shared secret 0x80..=0x9f, as in `secrets.rs`.
    fn fixed_secrets() -> OfferSecrets {
        OfferSecrets::from_shared_secret(SecretKey::from_slice(&sequence(0x80)).unwrap())
    }

    /// `floor(paid·collateral/repayment)`, computed apart from [`collateral_at`].
    fn released_by(paid: u64, collateral: u64, repayment: u64) -> u64 {
        (u128::from(paid) * u128::from(collateral) / u128::from(repayment)) as u64
    }

    // ---- the release arithmetic

    /// Random loans paid off by random installments: each release is the difference of the
    /// floors, the remainder is in range, and the releases with the full repayment's collateral
    /// add up to `C`.
    #[test]
    fn releases_add_up_to_the_collateral() {
        let mut rng = StdRng::seed_from_u64(7);
        for round in 0..2000 {
            // small terms some of the time, so that releases of 0 and C > R occur
            let (collateral, repayment) = if round % 2 == 0 {
                (
                    rng.gen_range(1..=MAX_COLLATERAL),
                    rng.gen_range(1..=MAX_REPAYMENT),
                )
            } else {
                (rng.gen_range(1..=50), rng.gen_range(1..=50))
            };
            let steps = rng.gen_range(0..=40);

            let mut debt = repayment;
            let mut released = 0u64;
            assert_eq!(collateral_at(debt, collateral, repayment), collateral);
            for _ in 0..steps {
                if debt == 1 {
                    break;
                }
                let payment = rng.gen_range(1..debt);
                let release = release_of(debt, payment, collateral, repayment);
                let paid_before = repayment - debt;
                debt -= payment;
                let paid = repayment - debt;
                assert_eq!(
                    release,
                    released_by(paid, collateral, repayment)
                        - released_by(paid_before, collateral, repayment)
                );
                released += release;

                let held = collateral_at(debt, collateral, repayment);
                assert_eq!(held, collateral - released);
                let e = carry_remainder(debt, collateral, repayment);
                assert!(e < repayment);
                assert_eq!(
                    u128::from(held) * u128::from(repayment)
                        - u128::from(debt) * u128::from(collateral),
                    u128::from(e)
                );
            }
            // the full repayment takes the rest
            let last = release_of(debt, debt, collateral, repayment);
            assert_eq!(last, collateral_at(debt, collateral, repayment));
            assert_eq!(released + last, collateral);
        }
    }

    #[test]
    fn remainder_is_zero_when_the_debt_divides_evenly() {
        // at acceptance and when nothing is owed
        assert_eq!(
            carry_remainder(MAX_REPAYMENT, MAX_COLLATERAL, MAX_REPAYMENT),
            0
        );
        assert_eq!(carry_remainder(0, MAX_COLLATERAL, MAX_REPAYMENT), 0);
        assert_eq!(collateral_at(0, MAX_COLLATERAL, MAX_REPAYMENT), 0);
        // half the debt of an even repayment
        assert_eq!(collateral_at(5, 8, 10), 4);
        assert_eq!(carry_remainder(5, 8, 10), 0);
    }

    #[test]
    fn remainder_can_be_one_less_than_the_repayment() {
        // 3·7 = 2·10 + 1, so c = 3 and e = 30 − 21 = 9
        assert_eq!(collateral_at(3, 7, 10), 3);
        assert_eq!(carry_remainder(3, 7, 10), 9);

        // at the largest collateral, with the odd repayment 2^50 − 3: the debt d = C⁻¹ mod R
        // gives d·C ≡ 1, so e = R − 1
        let (collateral, repayment) = (MAX_COLLATERAL, MAX_REPAYMENT - 1);
        let half = u128::from(repayment).div_ceil(2); // (R + 1)/2 = 2⁻¹ mod R
        let debt = (0..44).fold(1u128, |acc, _| acc * half % u128::from(repayment)) as u64;
        assert_eq!(
            u128::from(debt) * u128::from(collateral) % u128::from(repayment),
            1
        );
        assert_eq!(carry_remainder(debt, collateral, repayment), repayment - 1);
    }

    #[test]
    fn an_installment_can_release_nothing() {
        // C = 1, R = 10: the collateral stays 1 until the debt is paid off
        assert_eq!(release_of(10, 1, 1, 10), 0);
        assert_eq!(release_of(9, 8, 1, 10), 0);
        assert_eq!(release_of(1, 1, 1, 10), 1);
    }

    #[test]
    fn largest_terms_do_not_overflow() {
        let (c, r) = (MAX_COLLATERAL, MAX_REPAYMENT);
        assert_eq!(collateral_at(r - 1, c, r), c);
        assert_eq!(release_of(r, r, c, r), c);
        assert_eq!(release_of(r, r - 1, c, r), c - 1);
        assert_eq!(collateral_at(1, c, r), 1);
        assert_eq!(carry_remainder(1, c, r), r - c);
    }

    #[test]
    #[should_panic(expected = "never owes more than its repayment")]
    fn debt_above_the_repayment_panics() {
        collateral_at(11, 1, 10);
    }

    #[test]
    #[should_panic(expected = "payment is above the debt")]
    fn payment_above_the_debt_panics() {
        release_of(5, 6, 1, 10);
    }

    #[test]
    fn bounds_at_and_past_each_limit() {
        assert_eq!(MAX_COLLATERAL, 17_592_186_044_416);
        assert_eq!(MAX_REPAYMENT, 1_125_899_906_842_622);
        assert_eq!(CARRY_SUPPLY, 1_125_899_906_842_624);
        assert_eq!(MAX_STEPS, 1024);

        assert_eq!(check_bounds(1, 1), Ok(()));
        assert_eq!(check_bounds(MAX_COLLATERAL, MAX_REPAYMENT), Ok(()));
        assert_eq!(
            check_bounds(MAX_COLLATERAL + 1, MAX_REPAYMENT),
            Err(ReleaseError::CollateralOutOfBounds)
        );
        assert_eq!(
            check_bounds(MAX_COLLATERAL, MAX_REPAYMENT + 1),
            Err(ReleaseError::RepaymentOutOfBounds)
        );
        assert_eq!(check_bounds(0, 1), Err(ReleaseError::CollateralOutOfBounds));
        assert_eq!(check_bounds(1, 0), Err(ReleaseError::RepaymentOutOfBounds));
        assert_eq!(
            check_bounds(u64::MAX, u64::MAX),
            Err(ReleaseError::CollateralOutOfBounds)
        );
    }

    // ---- the hashing primitives

    /// The compression of a hand-padded one-block message from SHA-256's IV is its hash.
    #[test]
    fn compress_is_sha256s_compression_function() {
        let standard_iv =
            bytes32("6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19");
        let mut block = [0u8; 64];
        block[..3].copy_from_slice(b"abc");
        block[3] = 0x80;
        block[63] = 24; // the length in bits
        let (a, b) = block.split_at(32);

        assert_eq!(
            compress(&standard_iv, a.try_into().unwrap(), b.try_into().unwrap()),
            sha256::Hash::hash(b"abc").to_byte_array()
        );
    }

    #[test]
    fn scalar_reduces_modulo_the_order() {
        let order = bytes32(ORDER);
        let mut order_plus_one = order;
        order_plus_one[31] += 1;

        assert_eq!(scalar(&order), Scalar::ZERO);
        assert_eq!(scalar(&order_plus_one), Scalar::ONE);
        assert_eq!(
            scalar(&[0xff; 32]).to_be_bytes().to_hex(),
            "000000000000000000000000000000014551231950b75fc4402da1732fc9bebe"
        );
        assert_eq!(scalar(&sequence(0x01)).to_be_bytes(), sequence(0x01));
    }

    #[test]
    fn ivs_are_the_hashes_of_their_tags() {
        assert_eq!(
            LEAF_IV,
            sha256::Hash::hash(b"simplicity-lending/private/v1/release-leaf").to_byte_array()
        );
        assert_eq!(
            NODE_IV,
            sha256::Hash::hash(b"simplicity-lending/private/v1/release-node").to_byte_array()
        );
        assert_eq!(
            LEAF_IV.to_hex(),
            "bbf7d7db42afe9bc576c22b006772d76a16e07d70e5d1120774acda820542c41"
        );
        assert_eq!(
            NODE_IV.to_hex(),
            "be7d66ef2b12a4ce860bd56b5f69b750947b3710391de9fe883dd8e79ff9f6cd"
        );
    }

    // ---- J

    #[test]
    fn j_known_answer() {
        let j = release_j();
        assert_eq!(
            j.serialize().to_hex(),
            "02bd8d8368c2d77e10d44111aca9ee0f2be215e62cee554e7cbb3ed577ae7cb9db"
        );
        let (x, y) = point_xy(&j);
        assert_eq!(
            [x, y].concat().to_hex(),
            "bd8d8368c2d77e10d44111aca9ee0f2be215e62cee554e7cbb3ed577ae7cb9db\
             e0072f694007f4795ffc5633d8f6c88b7523bee3282e8e511573c8764381360a"
        );
    }

    /// `X_0` has no point, so `J` is the try at `t = 1`.
    #[test]
    fn j_is_the_first_try_with_a_point() {
        let try_at =
            |t: u32| sha256::Hash::hash(&[J_TAG, &t.to_be_bytes()].concat()).to_byte_array();
        assert_eq!(even_y_point(&try_at(0)), None);
        assert_eq!(even_y_point(&try_at(1)), Some(release_j()));
    }

    #[test]
    fn even_y_point_rejects_an_x_past_the_prime() {
        // x = 1 is on the curve (1 + 7 = 8 is a square), and 1 + p is below 2^256
        let one = Scalar::ONE.to_be_bytes();
        let one_plus_p =
            bytes32("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc30");

        let point = even_y_point(&one).unwrap();
        assert_eq!(point.serialize()[0], 0x02);
        assert_eq!(point_xy(&point).0, one);
        assert_eq!(even_y_point(&one_plus_p), None);
    }

    // ---- FS_IV

    /// The IV over the multiples of `G` by the bytes 0x10.., 0x20.., 0x30.. and 0x40.., so that a
    /// change of tag, order or byte order fails.
    #[test]
    fn fs_iv_known_answer() {
        let [a, a_c, v_c0, d0] = [0x10, 0x20, 0x30, 0x40].map(|start| {
            PublicKey::from_secret_key(SECP256K1, &SecretKey::from_slice(&sequence(start)).unwrap())
        });

        assert_eq!(
            fs_iv(&a, &a_c, &v_c0, &d0).to_hex(),
            "00da87cbd6bd1103e8fdfc07a8905d9dbeb131e85d148de33fbb4a6f83120516"
        );
        assert_ne!(fs_iv(&a, &a_c, &v_c0, &d0), fs_iv(&a_c, &a, &v_c0, &d0));
    }

    // ---- the tree

    #[test]
    fn tree_known_answers() {
        let tree = BlinderTree::new(&fixed_secrets());

        assert_eq!(
            tree.root().to_hex(),
            "2321e1ef30cd59ba6465f3ed938e87ec17218d435904435828dc6dceca54d0f1"
        );
        assert_eq!(
            tree.leaf(0).to_hex(),
            "52488e5a69435affdde4af692b2e34f6dafe3df710793c6e1fc1d46e6e6d1456"
        );
        assert_eq!(
            tree.leaf(1023).to_hex(),
            "ec3a42ab097f45eacf4ea158c30f99f529655bcf0df9684b1a388b7edcbbc4df"
        );

        // leaf i holds Y_(i+1)
        let secrets = fixed_secrets();
        for (i, step) in [(0, 1), (1023, 1024)] {
            let (x, y) = secrets.release_blinders(step);
            let commitment = blinder_commitment(&x, &y, &release_j());
            let (cx, cy) = point_xy(&commitment);
            assert_eq!(tree.leaf(i), compress(&LEAF_IV, &cx, &cy));
            assert_eq!(tree.leaf(i), blinder_leaf(&commitment));
        }
    }

    #[test]
    fn paths_fold_to_the_root_at_their_index() {
        let tree = BlinderTree::new(&fixed_secrets());

        for i in [0, 1, 2, 511, 512, 1022, 1023] {
            let path = tree.path(i);
            for (k, (is_right, _)) in path.iter().enumerate() {
                assert_eq!(*is_right, i >> k & 1 == 1);
            }
            assert_eq!(fold_path(tree.leaf(i), &path), (tree.root(), i));
        }

        // a leaf with another's path folds elsewhere
        assert_ne!(fold_path(tree.leaf(1), &tree.path(0)).0, tree.root());
        assert_ne!(fold_path(tree.leaf(0), &tree.path(1)).0, tree.root());
    }

    #[test]
    #[should_panic(expected = "no leaf")]
    fn leaf_past_the_last_panics() {
        BlinderTree::new(&fixed_secrets()).leaf(MAX_STEPS);
    }
}
