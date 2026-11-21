//! The lender's search for the collateral of a loan whose installments it cannot read.
//!
//! At step `k ≥ 1` the loan's collateral holds `c_k` and has the asset blinder `a_c + k` and the
//! value blinder `x_k − c_k·k`, so its value commitment is `V_k = c_k·A_c + x_k·G`, with `A_c` the
//! active collateral's asset commitment and `x_k` the step's derived blinder
//! ([`OfferSecrets::release_blinders`](crate::OfferSecrets::release_blinders)). The lender knows
//! `A_c` and `x_k`, reads `V_k` from the chain, and finds the one `c_k ∈ [1, C]` with
//! `c_k·A_c = V_k − x_k·G` ([`find_collateral`]); the opening follows
//! ([`collateral_opening`]). Liquidation therefore never needs the installments' amounts.
//!
//! The search is baby-step giant-step over `[1, C]` with `C ≤ 2^44`:
//!
//! - **The table** holds `j·A_c` for `j = 1 … m`, `m = ceil(sqrt(C/2))`, keyed by the first 8
//!   bytes of the point's x-coordinate. A point and its negation share it, so one entry stands for
//!   both `j` and `−j`, and a giant step covers `2m + 1` amounts.
//! - **The giant steps** visit `Q − i·(2m + 1)·A_c` for `i = 0, 1, …`, with `Q = V_k − x_k·G`, and
//!   look each one up. A match proposes `i·(2m + 1) ± j`, and a proposal counts only once it is in
//!   `[1, C]` and its multiple of `A_c` is `Q`, so the search returns exactly the solution, or
//!   nothing.
//! - **The cost** at `C = 2^44` is about `2^22.5` point additions, made in affine coordinates
//!   4,096 at a time with one field inversion ([`Walk`]), and a table of `2^22` eight-byte slots
//!   (32 MiB). That is about 0.6 s optimized and 1 s in wasm; the browser still runs it in a Web
//!   Worker.
//!
//! The search's time depends on `c_k`; it runs on the lender's machine, over its own loan.

use elements::confidential::{AssetBlindingFactor, ValueBlindingFactor};
use elements::secp256k1_zkp::{PublicKey, Scalar, SecretKey};
use k256::elliptic_curve::group::prime::PrimeCurveAffine;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::{AffinePoint, EncodedPoint, FieldBytes, FieldElement, ProjectivePoint};

use crate::offer::small_scalar;
use crate::release_proof::{to_k256, to_point};
use crate::{MAX_COLLATERAL, MAX_STEPS};

/// The lanes of a [`Walk`]: the points added together with one field inversion.
const CHUNK: usize = 4096;
/// The low bits of a table entry, which hold its step `j`; the others hold the key's high bits.
/// The table's steps are below `2^22` for every bound up to [`MAX_COLLATERAL`].
const STEP_BITS: u32 = 22;
const STEP_MASK: u64 = (1 << STEP_BITS) - 1;

/// The collateral `c_k ∈ [1, max]` of a loan at step `k ≥ 1` whose collateral has the value
/// commitment `v_k`: the one amount with `c_k·A_c = V_k − x_k·G`, where `a_c` is `A_c`, the
/// active collateral's asset commitment as a point, and `x_k` the step's derived blinder. The
/// lender passes the loan's collateral `C` as `max`.
///
/// `a_c` is the asset commitment at acceptance, not the loan output's, which is `A_c + k·G`. Both
/// points are read from Elements' encodings with [`value_point`](crate::value_point) and
/// [`asset_point`](crate::asset_point).
///
/// Returns `None` if no amount in `[1, max]` fits, which on the loan's real chain does not happen
/// (proofs, Theorem 8). Its time and memory grow with `sqrt(max)`, to about 1 s in wasm and
/// 32 MiB at `max = 2^44`.
///
/// # Panics
/// If `max` is above [`MAX_COLLATERAL`], which bounds the search's time and memory.
pub fn find_collateral(v_k: &PublicKey, a_c: &PublicKey, x_k: &SecretKey, max: u64) -> Option<u64> {
    assert!(
        max <= MAX_COLLATERAL,
        "the search's bound {max} is above the largest collateral, {MAX_COLLATERAL}"
    );
    if max == 0 {
        return None;
    }

    Table::new(to_point(a_c), max).find(&search_target(v_k, x_k))
}

/// `V_k − x_k·G`, the multiple of `A_c` the search looks for.
fn search_target(v_k: &PublicKey, x_k: &SecretKey) -> ProjectivePoint {
    to_point(v_k) - ProjectivePoint::GENERATOR * to_k256(&Scalar::from(*x_k))
}

/// The opening of the collateral at step `k` holding `c_k`: the asset blinder `a_c + k` and the
/// value blinder `x_k − c_k·k` modulo the curve order, from the active collateral's asset
/// blinder `a_c` and the step's derived blinder `x_k`. This is how the borrower's installment
/// pins its successor, so with the [`find_collateral`] amount it opens the loan's output.
///
/// # Panics
/// If `k` is 0 or above 1024: step 0's collateral is the active collateral, with its own
/// opening.
pub fn collateral_opening(
    k: u32,
    c_k: u64,
    a_c_blinder: &AssetBlindingFactor,
    x_k: &SecretKey,
) -> (AssetBlindingFactor, ValueBlindingFactor) {
    assert!(
        (1..=MAX_STEPS).contains(&k),
        "a loan has no step {k} after an installment: its steps are 1 to {MAX_STEPS}"
    );
    let step = u128::from(k);

    // elements adds value blinders only, so the asset blinder is added as one
    let mut abf = ValueBlindingFactor::from_slice(a_c_blinder.into_inner().as_ref())
        .expect("an asset blinder is a scalar");
    abf += small_scalar(step);
    let mut vbf =
        ValueBlindingFactor::from_slice(&x_k.secret_bytes()).expect("a secret key is a scalar");
    vbf += -small_scalar(step * u128::from(c_k));

    (
        AssetBlindingFactor::from_slice(abf.into_inner().as_ref())
            .expect("a scalar is an asset blinder"),
        vbf,
    )
}

/// The baby steps `j·base`, `j = 1 … m`, in an open-addressing table of `2^b` slots, at most three
/// quarters full ([`half_width`], [`slot_count`]). A slot holds 0 when empty, and otherwise the
/// key's high `64 − 22` bits with `j` in the low 22; the slot is chosen by the key's low bits, and
/// taken slots are skipped forward. Equal keys all stay in the table, so every `j` whose key
/// matches is proposed.
struct Table {
    base: ProjectivePoint,
    max: u64,
    /// `m`: the table holds `j·base` for `j = 1 … m`.
    half_width: u64,
    slots: Vec<u64>,
}

impl Table {
    /// The table of the search for amounts in `[1, max]` of `base`, `1 ≤ max ≤ 2^44`.
    fn new(base: ProjectivePoint, max: u64) -> Table {
        let half_width = half_width(max);
        debug_assert!(half_width <= STEP_MASK, "the steps fit their bits");
        let mut table = Table {
            base,
            max,
            half_width,
            slots: vec![0; slot_count(half_width)],
        };

        let mut walk = Walk::new(base, base);
        let mut j = 1;
        loop {
            let count = CHUNK.min((half_width - j + 1) as usize);
            for t in 0..count {
                // `j·base` is not the point at infinity, since `j` is below the order
                if let Some(key) = walk.key(t) {
                    table.insert(key, j + t as u64);
                }
            }
            j += count as u64;
            if j > half_width {
                break;
            }
            walk.advance();
        }

        table
    }

    fn insert(&mut self, key: u64, j: u64) {
        let mask = self.slots.len() - 1;
        let mut slot = key as usize & mask;
        while self.slots[slot] != 0 {
            slot = (slot + 1) & mask;
        }
        // `j ≥ 1`, so a taken slot is never 0
        self.slots[slot] = (key & !STEP_MASK) | j;
    }

    /// The steps `j` whose key's high bits are `key`'s.
    fn steps_of(&self, key: u64) -> impl Iterator<Item = u64> + '_ {
        let mask = self.slots.len() - 1;
        let mut slot = key as usize & mask;

        // the table is never full, so the run of taken slots ends
        std::iter::from_fn(move || {
            loop {
                let entry = self.slots[slot];
                if entry == 0 {
                    return None;
                }
                slot = (slot + 1) & mask;
                if entry & !STEP_MASK == key & !STEP_MASK {
                    return Some(entry & STEP_MASK);
                }
            }
        })
    }

    /// The amount `c ∈ [1, max]` with `c·base = target`, if there is one.
    fn find(&self, target: &ProjectivePoint) -> Option<u64> {
        let stride = 2 * self.half_width + 1;
        let giant = -(self.base * k256::Scalar::from(stride));
        // the giant step `i` covers `i·stride − m … i·stride + m`
        let last = (self.max + self.half_width) / stride;

        let mut walk = Walk::new(*target, giant);
        let mut i = 0;
        loop {
            let count = CHUNK.min((last - i + 1) as usize);
            for t in 0..count {
                let center = (i + t as u64) * stride;
                let Some(key) = walk.key(t) else {
                    // `target − center·base` is the point at infinity
                    if self.opens(center, target) {
                        return Some(center);
                    }
                    continue;
                };
                for j in self.steps_of(key) {
                    for amount in [center.checked_add(j), center.checked_sub(j)] {
                        if let Some(amount) = amount.filter(|&a| self.opens(a, target)) {
                            return Some(amount);
                        }
                    }
                }
            }
            i += count as u64;
            if i > last {
                return None;
            }
            walk.advance();
        }
    }

    /// Whether `amount` is in `[1, max]` and `amount·base = target`.
    fn opens(&self, amount: u64, target: &ProjectivePoint) -> bool {
        (1..=self.max).contains(&amount) && self.base * k256::Scalar::from(amount) == *target
    }
}

/// The points `start + n·step`, `n = 0, 1, …`, [`CHUNK`] at a time in affine coordinates: lane
/// `t` holds `start + (r·CHUNK + t)·step` at round `r`. A round adds `CHUNK·step` to every lane in
/// affine coordinates, with one field inversion for all of them (Montgomery's trick), which costs
/// about 6 field multiplications a point.
///
/// A lane at the point at infinity, or equal to `±CHUNK·step`, has no affine sum. That happens in
/// at most a few rounds of a search, and such a round is added in projective coordinates.
struct Walk {
    /// The lanes' coordinates, of magnitude 1; meaningless for a lane at infinity.
    xs: Vec<FieldElement>,
    ys: Vec<FieldElement>,
    /// Which lanes are the point at infinity.
    at_infinity: Vec<bool>,
    /// `CHUNK·step`, and its coordinates.
    jump: ProjectivePoint,
    jump_x: FieldElement,
    jump_y: FieldElement,
    /// The running products of the inversion.
    products: Vec<FieldElement>,
}

impl Walk {
    /// The walk from `start` by `step`, at round 0. `CHUNK·step` must not be the point at
    /// infinity.
    fn new(start: ProjectivePoint, step: ProjectivePoint) -> Walk {
        let mut points = Vec::with_capacity(CHUNK);
        let mut next = start;
        for _ in 0..CHUNK {
            points.push(next);
            next += step;
        }
        let jump = step * k256::Scalar::from(CHUNK as u64);
        let (jump_x, jump_y) = coordinates(&jump.to_affine())
            .expect("the steps are nonzero multiples of a point of prime order above CHUNK");

        let mut walk = Walk {
            xs: vec![FieldElement::ZERO; CHUNK],
            ys: vec![FieldElement::ZERO; CHUNK],
            at_infinity: vec![false; CHUNK],
            jump,
            jump_x,
            jump_y,
            products: vec![FieldElement::ZERO; CHUNK],
        };
        walk.set(&points);

        walk
    }

    /// The key of lane `t`'s point ([`key`]), or `None` at the point at infinity.
    fn key(&self, t: usize) -> Option<u64> {
        if self.at_infinity[t] {
            return None;
        }

        Some(key(&self.xs[t].to_bytes()))
    }

    /// Moves every lane to the next round.
    fn advance(&mut self) {
        if self.at_infinity.contains(&true) || !self.add_jump_affine() {
            let points: Vec<ProjectivePoint> =
                (0..CHUNK).map(|t| self.point(t) + self.jump).collect();
            self.set(&points);
        }
    }

    /// Adds `CHUNK·step` to every lane in affine coordinates, `λ = (y_J − y)/(x_J − x)`,
    /// `x' = λ² − x − x_J` and `y' = λ·(x − x') − y`, with the denominators inverted together.
    /// Returns `false`, the lanes unchanged, if a denominator is 0: a lane is `±CHUNK·step`.
    fn add_jump_affine(&mut self) -> bool {
        // the magnitudes: each lane's coordinates and the jump's are 1, a difference is 3, and a
        // product 1; `x'` and `y'` are weakly normalized back to 1
        let mut product = FieldElement::ONE;
        for t in 0..CHUNK {
            product *= self.jump_x - self.xs[t];
            self.products[t] = product;
        }
        // the product is 0 exactly when a denominator is
        let Some(mut inverse) = Option::<FieldElement>::from(product.invert()) else {
            return false;
        };

        for t in (0..CHUNK).rev() {
            let (x, y) = (self.xs[t], self.ys[t]);
            let denominator = self.jump_x - x;
            // `1/(x_J − x)`, then the inverse of the product of the earlier denominators
            let reciprocal = if t > 0 {
                inverse * self.products[t - 1]
            } else {
                inverse
            };
            inverse *= denominator;

            let lambda = (self.jump_y - y) * reciprocal;
            let x_next = (lambda.square() - x - self.jump_x).normalize_weak();
            self.ys[t] = (lambda * (x - x_next) - y).normalize_weak();
            self.xs[t] = x_next;
        }

        true
    }

    /// Lane `t`'s point.
    fn point(&self, t: usize) -> ProjectivePoint {
        if self.at_infinity[t] {
            return ProjectivePoint::IDENTITY;
        }
        let encoded = EncodedPoint::from_affine_coordinates(
            &self.xs[t].to_bytes(),
            &self.ys[t].to_bytes(),
            false,
        );

        Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&encoded))
            .expect("a lane is a curve point")
            .into()
    }

    /// Sets the lanes to `points`. Each point takes its own field inversion, about 3 µs
    /// optimized, which the rounds this runs in (the first, and the few added in projective
    /// coordinates) can afford.
    fn set(&mut self, points: &[ProjectivePoint]) {
        for (t, point) in points.iter().enumerate() {
            match coordinates(&point.to_affine()) {
                Some((x, y)) => {
                    (self.xs[t], self.ys[t]) = (x, y);
                    self.at_infinity[t] = false;
                }
                None => self.at_infinity[t] = true,
            }
        }
    }
}

/// The affine coordinates of a point, normalized, or `None` for the point at infinity.
fn coordinates(point: &AffinePoint) -> Option<(FieldElement, FieldElement)> {
    if bool::from(point.is_identity()) {
        return None;
    }
    let encoded = point.to_encoded_point(false);
    let coordinate = |bytes: Option<&FieldBytes>| {
        Option::<FieldElement>::from(FieldElement::from_bytes(
            bytes.expect("an uncompressed point has both coordinates"),
        ))
        .expect("a coordinate is below the field's prime")
    };

    Some((coordinate(encoded.x()), coordinate(encoded.y())))
}

/// The table's key of a point with the x-coordinate `x`: its first 8 bytes, which the point's
/// negation shares.
fn key(x: &FieldBytes) -> u64 {
    u64::from_be_bytes(x[..8].try_into().expect("an x-coordinate has 32 bytes"))
}

/// `m = ceil(sqrt(max/2))`, which balances the table's `m` steps against the about
/// `max/(2m + 1)` giant steps.
fn half_width(max: u64) -> u64 {
    let half = max.div_ceil(2);
    let root = half.isqrt();

    if root * root < half { root + 1 } else { root }
}

/// The table's slots for `m` steps: the power of two at or above `4m/3 + 1`, so that at most
/// three quarters are taken and a run of taken slots always ends.
fn slot_count(half_width: u64) -> usize {
    (half_width + half_width / 3 + 1).next_power_of_two() as usize
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use elements::secp256k1_zkp::Scalar;
    use k256::elliptic_curve::Group;
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};

    use super::*;
    use crate::release_proof::tests::{borrower, loan, loan_fs_iv};
    use crate::release_proof::{prove, to_k256, verify};
    use crate::{MAX_COLLATERAL, PinnedOutput, asset_point, value_point};

    /// The bound of the tests' searches.
    const MAX: u64 = 1 << 36;

    /// A loan of the release proof's fixed offer, whose collateral the tests search.
    fn search_loan() -> crate::release_proof::tests::Loan {
        loan(MAX, 11_000)
    }

    /// `A_c`, the active collateral's asset commitment as a point: the search's base at every
    /// step.
    fn active_asset(loan: &crate::release_proof::tests::Loan) -> PublicKey {
        asset_point(&loan.pinned.active_collateral.asset_commitment()).unwrap()
    }

    /// The loan's collateral at step `k` holding `amount`, pinned with the asset blinder
    /// `a_c + k` and the value blinder `x_k − amount·k`, computed apart from
    /// [`collateral_opening`].
    fn collateral(loan: &crate::release_proof::tests::Loan, k: u32, amount: u64) -> PinnedOutput {
        let active = loan.pinned.active_collateral;
        let (x_k, _) = loan.secrets.release_blinders(k);
        let step = k256::Scalar::from(u64::from(k));
        let a_c = k256_of(active.asset_blinding_factor.into_inner().as_ref());
        let x_k = to_k256(&Scalar::from(x_k));

        PinnedOutput {
            amount,
            asset_blinding_factor: AssetBlindingFactor::from_slice(&(a_c + step).to_bytes())
                .unwrap(),
            value_blinding_factor: ValueBlindingFactor::from_slice(
                &(x_k - k256::Scalar::from(amount) * step).to_bytes(),
            )
            .unwrap(),
            ..active
        }
    }

    fn k256_of(bytes: &[u8]) -> k256::Scalar {
        to_k256(&Scalar::from_be_bytes(bytes.try_into().unwrap()).unwrap())
    }

    /// `V_k`, the point of the value commitment of the collateral at step `k` holding `amount`,
    /// read from its Elements encoding as the lender reads it from the chain.
    fn value_at(loan: &crate::release_proof::tests::Loan, k: u32, amount: u64) -> PublicKey {
        value_point(&collateral(loan, k, amount).value_commitment()).unwrap()
    }

    // ---- the search

    #[test]
    fn finds_the_largest_amount() {
        let loan = search_loan();
        let (x_k, _) = loan.secrets.release_blinders(5);

        assert_eq!(
            find_collateral(&value_at(&loan, 5, MAX), &active_asset(&loan), &x_k, MAX),
            Some(MAX)
        );
    }

    #[test]
    fn finds_the_smallest_amount() {
        let loan = search_loan();
        let (x_k, _) = loan.secrets.release_blinders(1);

        assert_eq!(
            find_collateral(&value_at(&loan, 1, 1), &active_asset(&loan), &x_k, MAX),
            Some(1)
        );
    }

    /// Amounts at every edge of the table and random ones, at steps 1 to 1024.
    #[test]
    fn finds_amounts_up_to_the_bound() {
        let loan = search_loan();
        let mut rng = StdRng::seed_from_u64(0x5ea2c4);
        let mut amounts = vec![2, 3, MAX - 1];
        amounts.extend((0..6).map(|_| rng.gen_range(1..=MAX)));
        // small amounts, where a mistake in the table's lowest steps shows
        amounts.extend((0..3).map(|_| rng.gen_range(1..=1_000)));

        for (n, amount) in amounts.into_iter().enumerate() {
            let k = [1, 2, 1023, 1024][n % 4];
            let (x_k, _) = loan.secrets.release_blinders(k);
            let found =
                find_collateral(&value_at(&loan, k, amount), &active_asset(&loan), &x_k, MAX);

            assert_eq!(found, Some(amount), "amount {amount} at step {k}");
        }
    }

    /// Amounts at the edges of the table and of the walks, on one table at `2^36`: the multiples
    /// of the giant stride, where a giant step meets the point at infinity and the walk's lanes
    /// meet `±CHUNK·step`; the steps `±m` and `±(m − 1)` around them; and the walks' rounds.
    #[test]
    fn finds_amounts_at_the_edges_of_the_table() {
        let loan = search_loan();
        let table = Table::new(to_point(&active_asset(&loan)), MAX);
        let m = table.half_width;
        let stride = 2 * m + 1;
        let chunk = CHUNK as u64;
        assert_eq!(m, 185_364);

        let mut amounts = vec![
            m,
            m + 1,
            m - 1,
            chunk,
            chunk + 1,
            2 * chunk,
            2 * chunk + 1,
            stride,
            2 * stride,
            chunk * stride,
            (chunk + 1) * stride,
            2 * chunk * stride,
            (MAX / stride) * stride,
        ];
        for center in [stride, 1_000 * stride, (chunk - 1) * stride, chunk * stride] {
            amounts.extend([center + m, center - m, center + m - 1, center - (m - 1)]);
        }

        for (n, amount) in amounts.into_iter().enumerate() {
            let k = 1 + n as u32;
            let (x_k, _) = loan.secrets.release_blinders(k);
            let target = search_target(&value_at(&loan, k, amount), &x_k);

            assert_eq!(table.find(&target), Some(amount), "amount {amount}");
        }
    }

    /// The walk's lanes are `start + n·step`, also across lanes at the point at infinity and at
    /// `±CHUNK·step`.
    #[test]
    fn the_walk_adds_its_steps() {
        let base = to_point(&active_asset(&search_loan()));
        let walks = [
            // lane 0 is `CHUNK·base`, then the point at infinity, then `−CHUNK·base`
            (base * k256::Scalar::from(CHUNK as u64), -base),
            // lane 0 starts at the point at infinity, and lane `CHUNK − 1` is `CHUNK·step` next
            (ProjectivePoint::IDENTITY, base),
        ];
        for (start, step) in walks {
            let mut walk = Walk::new(start, step);
            let mut expected = start;
            for round in 0..4 {
                if round > 0 {
                    walk.advance();
                }
                for t in 0..CHUNK {
                    assert_eq!(walk.point(t), expected, "round {round}, lane {t}");
                    assert_eq!(walk.key(t).is_none(), bool::from(expected.is_identity()));
                    expected += step;
                }
            }
        }
    }

    #[test]
    fn the_table_fits_the_largest_collateral() {
        assert_eq!(half_width(MAX_COLLATERAL), 2_965_821);
        assert!(half_width(MAX_COLLATERAL) <= STEP_MASK);
        // 32 MiB of slots
        assert_eq!(slot_count(half_width(MAX_COLLATERAL)), 1 << 22);
        assert_eq!((half_width(1), slot_count(1)), (1, 2));
        assert_eq!(half_width(2), 1);
        assert_eq!(half_width(3), 2);
    }

    #[test]
    fn finds_no_amount_above_the_bound() {
        let loan = search_loan();
        let (x_k, _) = loan.secrets.release_blinders(3);
        let a_c = active_asset(&loan);

        for amount in [MAX + 1, MAX + 1_000, 1 << 40, MAX_COLLATERAL] {
            assert_eq!(
                find_collateral(&value_at(&loan, 3, amount), &a_c, &x_k, MAX),
                None,
                "amount {amount}"
            );
        }
        // the bound itself, and one below it
        assert_eq!(find_collateral(&value_at(&loan, 3, 7), &a_c, &x_k, 6), None);
        assert_eq!(
            find_collateral(&value_at(&loan, 3, 7), &a_c, &x_k, 7),
            Some(7)
        );
        assert_eq!(find_collateral(&value_at(&loan, 3, 1), &a_c, &x_k, 0), None);
    }

    /// An amount of 0: `V_k − x_k·G` is the point at infinity, which is no amount in `[1, max]`.
    #[test]
    fn finds_no_amount_of_zero() {
        let loan = search_loan();
        let (x_k, _) = loan.secrets.release_blinders(3);
        let v_k = PublicKey::from_secret_key(elements::secp256k1_zkp::SECP256K1, &x_k);

        assert_eq!(find_collateral(&v_k, &active_asset(&loan), &x_k, MAX), None);
    }

    /// Another step's blinder opens nothing.
    #[test]
    fn finds_nothing_with_another_steps_blinder() {
        let loan = search_loan();
        let (x_other, _) = loan.secrets.release_blinders(4);

        assert_eq!(
            find_collateral(
                &value_at(&loan, 3, 12_345),
                &active_asset(&loan),
                &x_other,
                1 << 20
            ),
            None
        );
    }

    #[test]
    #[should_panic(expected = "the search's bound")]
    fn a_bound_above_the_largest_collateral_panics() {
        let loan = search_loan();
        let (x_k, _) = loan.secrets.release_blinders(1);

        find_collateral(
            &value_at(&loan, 1, 1),
            &active_asset(&loan),
            &x_k,
            MAX_COLLATERAL + 1,
        );
    }

    /// The worst case at the largest collateral, `2^44`. Run it optimized:
    /// `cargo test -p private-lending-core --release -- --ignored --nocapture largest_collateral`.
    #[test]
    #[ignore = "searches 2^44 amounts: run it optimized"]
    fn finds_the_largest_collateral() {
        let loan = loan(MAX_COLLATERAL, 11_000);
        let (x_k, _) = loan.secrets.release_blinders(1024);
        let v_k = value_at(&loan, 1024, MAX_COLLATERAL);
        let a_c = active_asset(&loan);

        let start = Instant::now();
        let found = find_collateral(&v_k, &a_c, &x_k, MAX_COLLATERAL);
        println!("2^44: found {found:?} in {:?}", start.elapsed());

        assert_eq!(found, Some(MAX_COLLATERAL));
    }

    // ---- the opening

    /// The lender opens the successor of the release proof's installment, from its value
    /// commitment and the derived values alone, with the opening the borrower pinned.
    #[test]
    fn the_search_opens_the_successor_of_a_proved_installment() {
        // (C, R, the installment's step i, the debt it leaves)
        let cases = [(50_000, 11_000, 2, 8_000), (1 << 30, 1_000_000, 1023, 1)];
        for (c, r, i, debt) in cases {
            let loan = loan(c, r);
            let installment = loan.installment(i, debt);
            let statement = loan.statement(&installment);
            let proof = prove(&statement, &loan.secrets(i, debt), &borrower());
            assert!(verify(&statement, &proof, &loan_fs_iv(&statement)));
            let [successor, _, _] = loan.outputs(&installment);

            // the lender's view: the step, `V_k` from the chain, its own derivations
            let k = i + 1;
            let (x_k, _) = loan.secrets.release_blinders(k);
            let a_c_blinder = loan.pinned.active_collateral.asset_blinding_factor;
            let c_k = find_collateral(&statement.v_s, &statement.a_c, &x_k, c).unwrap();
            assert_eq!(c_k, crate::collateral_at(debt, c, r));

            let (abf, vbf) = collateral_opening(k, c_k, &a_c_blinder, &x_k);
            assert_eq!(
                (abf, vbf),
                (
                    successor.asset_blinding_factor,
                    successor.value_blinding_factor
                )
            );
            let opened = PinnedOutput {
                amount: c_k,
                asset_blinding_factor: abf,
                value_blinding_factor: vbf,
                ..loan.pinned.active_collateral
            };
            assert_eq!(
                value_point(&opened.value_commitment()).unwrap(),
                statement.v_s
            );
            // the asset moves by `G` at each step, as phase 5 pins it
            assert_eq!(
                opened.asset_commitment(),
                loan.pinned.collateral_after(k).asset_commitment()
            );
        }
    }

    #[test]
    fn the_opening_matches_the_pinned_collateral() {
        let loan = search_loan();
        let a_c_blinder = loan.pinned.active_collateral.asset_blinding_factor;
        for (k, amount) in [(1, 1), (17, 123_456), (1024, MAX)] {
            let (x_k, _) = loan.secrets.release_blinders(k);
            let pinned = collateral(&loan, k, amount);

            assert_eq!(
                collateral_opening(k, amount, &a_c_blinder, &x_k),
                (pinned.asset_blinding_factor, pinned.value_blinding_factor),
                "step {k}"
            );
        }
    }

    #[test]
    #[should_panic(expected = "a loan has no step 0")]
    fn the_opening_of_step_zero_panics() {
        let loan = search_loan();
        let (x_1, _) = loan.secrets.release_blinders(1);

        collateral_opening(
            0,
            1,
            &loan.pinned.active_collateral.asset_blinding_factor,
            &x_1,
        );
    }

    /// The search's base is `A_c`, not the loan output's asset commitment `A_c + k·G`.
    #[test]
    fn the_base_is_the_active_collateral() {
        let loan = search_loan();
        let (x_k, _) = loan.secrets.release_blinders(2);
        let moved = asset_point(&loan.pinned.collateral_after(2).asset_commitment()).unwrap();

        assert_eq!(
            find_collateral(&value_at(&loan, 2, 99), &moved, &x_k, 1_000),
            None
        );
    }
}
