//! The debt of a loan as a curve point, and opening the installments that pay it.
//!
//! The debt is the point `D = d·A + r·G`, where `d` is the amount still owed, `r` its blinder, `A`
//! the asset commitment of the offer's pinned repayment output and `G` the generator. At
//! acceptance it is the pinned repayment's value commitment `D₀`. An installment pays a value
//! commitment `V` under `A` and leaves `D − V`, and the covenant stores `h(A, D)` ([`debt_hash`])
//! for the debt still owed. The borrower tracks the debt's opening `(d, r)` ([`DebtOpening`]); the
//! lender can track the point itself ([`debt_after`]), without opening any installment.
//!
//! Elements encodes a commitment as a prefix and the x-coordinate, and the prefix's low bit is 0
//! exactly when `y` is a square modulo the field's prime: secp256k1-zkp writes `0x08` or `0x09`
//! for a value commitment and `0x0a` or `0x0b` for an asset generator. That bit is not the parity
//! of `y` that a compressed public key carries, so a commitment becomes a curve point by the
//! square-ness of `y`, as the covenant converts it.

use std::fmt;

use elements::TxOut;
use elements::confidential::{self, ValueBlindingFactor};
use elements::encode::serialize;
use elements::hashes::{Hash, sha256};
use elements::secp256k1_zkp::{
    Generator, PedersenCommitment, PublicKey, SECP256K1, Scalar, SecretKey,
};
use k256::FieldElement;

use crate::{PinnedOutput, RewindError, rewind};

/// The prefix of a value commitment whose `y` is a square; `0x09` when it is not.
const VALUE_PREFIX: u8 = 0x08;
/// The prefix of an asset generator whose `y` is a square; `0x0b` when it is not.
const GENERATOR_PREFIX: u8 = 0x0a;

/// The amount and the value blinder of a point under the repayment asset `A`: of the debt, or of
/// an installment that pays part of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DebtOpening {
    pub amount: u64,
    pub blinder: ValueBlindingFactor,
}

impl DebtOpening {
    /// The opening of a pinned output's value commitment. Of the pinned repayment, it is the debt
    /// at acceptance, `(R, r₀)`.
    pub fn of(pinned: &PinnedOutput) -> Self {
        DebtOpening {
            amount: pinned.amount,
            blinder: pinned.value_blinding_factor,
        }
    }

    /// What is left of this debt after `payment`: the amounts subtract, and the blinders subtract
    /// modulo the curve order.
    ///
    /// Returns `None` when the payment is larger than the debt, which leaves an amount no output
    /// can pay (the covenant cannot see amounts, so the client refuses such an installment), and
    /// when the payment is the debt itself, amount and blinder, which leaves the point at
    /// infinity: the covenant refuses that installment, as [`debt_after`] does.
    pub fn after(self, payment: DebtOpening) -> Option<DebtOpening> {
        let amount = self.amount.checked_sub(payment.amount)?;
        let mut blinder = self.blinder;
        blinder += -payment.blinder;
        if amount == 0 && blinder == ValueBlindingFactor::zero() {
            return None;
        }

        Some(DebtOpening { amount, blinder })
    }

    /// The point of this opening under the repayment asset, `amount·A + blinder·G`, as a value
    /// commitment, with `A` the asset commitment of `repayment` (its asset id and asset blinder).
    /// Amount 0 gives `blinder·G`, the debt after an installment of all that was owed.
    ///
    /// # Panics
    /// If both the amount and the blinder are zero: the point at infinity has no encoding, and
    /// [`DebtOpening::after`] never returns it.
    pub fn commitment(&self, repayment: &PinnedOutput) -> confidential::Value {
        self.under(repayment).value_commitment()
    }

    /// `repayment` with this opening's amount and value blinder.
    fn under(&self, repayment: &PinnedOutput) -> PinnedOutput {
        PinnedOutput {
            amount: self.amount,
            value_blinding_factor: self.blinder,
            ..*repayment
        }
    }
}

/// Why a debt computation failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DebtError {
    /// The asset or the value is explicit or null, not a commitment.
    NotConfidential,
    /// The commitment's x-coordinate is not on the curve.
    NotOnCurve,
    /// The result is the point at infinity, which no commitment encodes.
    Infinity,
}

impl fmt::Display for DebtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfidential => f.write_str("the asset or the value is not a commitment"),
            Self::NotOnCurve => f.write_str("the commitment is not a point of the curve"),
            Self::Infinity => f.write_str("the result is the point at infinity"),
        }
    }
}

impl std::error::Error for DebtError {}

/// The debt after an installment, `D − V` for the debt `D` and the installment's value
/// commitment `V`, both under the repayment asset: what the covenant computes for the successor
/// loan's storage.
///
/// # Errors
/// Returns [`DebtError::NotConfidential`] if either value is explicit or null,
/// [`DebtError::NotOnCurve`] if either does not decode, and [`DebtError::Infinity`] if they are
/// equal: the installment pays the whole debt, and the covenant refuses it.
pub fn debt_after(
    debt: &confidential::Value,
    payment: &confidential::Value,
) -> Result<confidential::Value, DebtError> {
    let (debt, payment) = (value_point(debt)?, value_point(payment)?);
    let left = debt
        .combine(&payment.negate(SECP256K1))
        .map_err(|_| DebtError::Infinity)?;

    Ok(value_of_point(&left))
}

/// `h(A, D)`: the SHA-256 of the consensus encodings of the asset commitment `A` and the debt
/// `D`, which the covenant stores for the debt and computes with `jet::asset_amount_hash` for an
/// output that carries them. For the debt at acceptance it is the pinned repayment's commitment
/// hash.
pub fn debt_hash(asset: &confidential::Asset, debt: &confidential::Value) -> [u8; 32] {
    let mut bytes = serialize(asset);
    bytes.extend(serialize(debt));

    sha256::Hash::hash(&bytes).to_byte_array()
}

/// `A_c + G`: the collateral's asset commitment after one more installment, which adds one to
/// its asset blinder (see [`OfferPinned::collateral_after`](crate::OfferPinned::collateral_after)).
///
/// # Errors
/// Returns [`DebtError::NotConfidential`] if the asset is explicit or null,
/// [`DebtError::NotOnCurve`] if it does not decode, and [`DebtError::Infinity`] if it is `−G`.
pub fn asset_plus_generator(asset: &confidential::Asset) -> Result<confidential::Asset, DebtError> {
    let sum = asset_point(asset)?
        .add_exp_tweak(SECP256K1, &Scalar::ONE)
        .map_err(|_| DebtError::Infinity)?;

    Ok(asset_of_point(&sum))
}

/// The combined opening of the outputs that a loan's final claim sweeps.
///
/// All repayment outputs of a loan, the installments and the full repayment, add up to the debt
/// at acceptance, whose opening `start` the lender knows. The full repayment and the unclaimed
/// installments therefore add up to `start` minus the `claimed` installments' openings. Every one
/// of these outputs carries the asset commitment `A`, so the claim balances when one of them takes
/// this opening and the others an amount and a blinder of zero, whatever their range proofs hold.
///
/// Returns `None` when the claimed openings add up to more than `start`, or to all of it.
pub fn sweep_opening(start: DebtOpening, claimed: &[DebtOpening]) -> Option<DebtOpening> {
    claimed
        .iter()
        .try_fold(start, |left, claimed| left.after(*claimed))
}

/// Why an installment output did not open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallmentError {
    /// The range proof does not rewind with the shared secret, as when the installment is blinded
    /// to another key, or the output is not confidential or has no range proof.
    Rewind(RewindError),
    /// The range proof's message names another asset id or asset blinder than the repayment's.
    OtherAsset,
    /// The output's asset commitment is not `A`, or its value commitment is not the rewound
    /// opening's under `A`.
    CommitmentMismatch,
}

impl fmt::Display for InstallmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rewind(_) => f.write_str("the installment output does not rewind"),
            Self::OtherAsset => {
                f.write_str("the installment's range proof names another asset or asset blinder")
            }
            Self::CommitmentMismatch => f.write_str(
                "the installment's commitments are not its opening's under the repayment asset",
            ),
        }
    }
}

impl std::error::Error for InstallmentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Rewind(e) => Some(e),
            Self::OtherAsset | Self::CommitmentMismatch => None,
        }
    }
}

/// Opens an installment output: rewinds its range proof with `shared_secret` and checks that it
/// pays the repayment asset `A` (`repayment`'s asset id and asset blinder) with the rewound
/// amount and value blinder.
///
/// The borrower's shared secret is
/// [`OfferSecrets::for_borrower`](crate::OfferSecrets::for_borrower) of the installment's derived
/// key ([`installment_ephemeral_key`](crate::installment_ephemeral_key)) and the lender's key; the
/// lender's is [`OfferSecrets::for_lender`](crate::OfferSecrets::for_lender) of its lending key and
/// the output's nonce.
///
/// # Errors
/// Returns an error if the range proof does not rewind, its message names another asset or asset
/// blinder than `A`'s, or the output's commitments are not the opening's under `A`.
pub fn open_installment(
    txout: &TxOut,
    shared_secret: SecretKey,
    repayment: &PinnedOutput,
) -> Result<DebtOpening, InstallmentError> {
    open_installment_with_extra_data(txout, shared_secret, repayment).map(|(opening, _)| opening)
}

/// [`open_installment`], which also returns the extra data of the range proof's message, padded
/// with zeros: the borrower's message, read in the same rewind that opens the amount (see
/// [`SignedMessage::decode`](crate::SignedMessage::decode)).
///
/// # Errors
/// As [`open_installment`].
pub fn open_installment_with_extra_data(
    txout: &TxOut,
    shared_secret: SecretKey,
    repayment: &PinnedOutput,
) -> Result<(DebtOpening, Vec<u8>), InstallmentError> {
    let (secrets, extra_data) = rewind(txout, shared_secret).map_err(InstallmentError::Rewind)?;
    if secrets.asset != repayment.asset_id || secrets.asset_bf != repayment.asset_blinding_factor {
        return Err(InstallmentError::OtherAsset);
    }

    let opening = DebtOpening {
        amount: secrets.value,
        blinder: secrets.value_bf,
    };
    // the rewound asset and asset blinder come from the range proof's message, which nothing ties
    // to the asset commitment, so the commitments are compared too
    if !opening.under(repayment).matches(txout) {
        return Err(InstallmentError::CommitmentMismatch);
    }

    Ok((opening, extra_data))
}

/// The curve point of a value commitment, by phase 5's square-ness rule: the point the covenant
/// reads from the commitment.
///
/// # Errors
/// Returns [`DebtError::NotConfidential`] if the value is explicit or null, and
/// [`DebtError::NotOnCurve`] if its x-coordinate is not on the curve.
pub fn value_point(value: &confidential::Value) -> Result<PublicKey, DebtError> {
    let commitment = value.commitment().ok_or(DebtError::NotConfidential)?;

    commitment_point(&commitment.serialize())
}

/// The value commitment of a curve point.
fn value_of_point(point: &PublicKey) -> confidential::Value {
    let commitment = PedersenCommitment::from_slice(&commitment_encoding(point, VALUE_PREFIX))
        .expect("a curve point's x-coordinate and the prefix of its y are a value commitment");

    confidential::Value::Confidential(commitment)
}

/// The curve point of an asset commitment, by phase 5's square-ness rule: the point the covenant
/// reads from the commitment.
///
/// # Errors
/// Returns [`DebtError::NotConfidential`] if the asset is explicit or null, and
/// [`DebtError::NotOnCurve`] if its x-coordinate is not on the curve.
pub fn asset_point(asset: &confidential::Asset) -> Result<PublicKey, DebtError> {
    let generator = asset.commitment().ok_or(DebtError::NotConfidential)?;

    commitment_point(&generator.serialize())
}

/// The asset commitment of a curve point.
fn asset_of_point(point: &PublicKey) -> confidential::Asset {
    let generator = Generator::from_slice(&commitment_encoding(point, GENERATOR_PREFIX))
        .expect("a curve point's x-coordinate and the prefix of its y are an asset generator");

    confidential::Asset::Confidential(generator)
}

/// The curve point of a commitment in Elements' encoding, a prefix and the x-coordinate, the
/// prefix's low bit 0 exactly when `y` is a square. Of the two points with this x-coordinate, the
/// one with even `y` is negated when the square-ness of its `y` disagrees with the bit: exactly one
/// of `y` and `−y` is a square, because the field's prime is 3 modulo 4.
fn commitment_point(encoding: &[u8; 33]) -> Result<PublicKey, DebtError> {
    let mut compressed = *encoding;
    compressed[0] = 0x02;
    let even = PublicKey::from_slice(&compressed).map_err(|_| DebtError::NotOnCurve)?;

    let y_is_square = encoding[0] & 1 == 0;
    if has_square_y(&even) == y_is_square {
        Ok(even)
    } else {
        Ok(even.negate(SECP256K1))
    }
}

/// The encoding of a curve point as a commitment with `prefix` (that of a square `y`): its low
/// bit set exactly when `y` is not a square, then the x-coordinate.
fn commitment_encoding(point: &PublicKey, prefix: u8) -> [u8; 33] {
    let mut encoding = [0; 33];
    encoding[0] = prefix | u8::from(!has_square_y(point));
    encoding[1..].copy_from_slice(&point.serialize()[1..]);

    encoding
}

/// Whether the point's `y` is a square modulo the field's prime.
fn has_square_y(point: &PublicKey) -> bool {
    let uncompressed = point.serialize_uncompressed();
    let y: [u8; 32] = uncompressed[33..]
        .try_into()
        .expect("an uncompressed point is 0x04, x and y");
    let y = FieldElement::from_bytes(&y.into())
        .expect("a curve point's y-coordinate is below the field's prime");

    y.sqrt().is_some().into()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use elements::confidential::{AssetBlindingFactor, Nonce};
    use elements::encode::serialize;
    use elements::hashes::Hash;
    use elements::secp256k1_zkp::{RangeProof, SECP256K1, XOnlyPublicKey};
    use elements::{AssetId, OutPoint, RangeProofMessage, Script, TxOutWitness, Txid};
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};

    use super::*;
    use crate::test_util::sequence;
    use crate::{
        LendingKey, OfferPinned, OfferSecrets, OfferTerms, installment_ephemeral_key,
        lift_lending_key,
    };

    /// A collateral amount near the supply of bitcoin, so that `i·c` is large.
    const COLLATERAL_AMOUNT: u64 = 2_100_000_000_000_000;

    fn rng() -> StdRng {
        StdRng::seed_from_u64(0x5eed)
    }

    fn asset(byte: u8) -> AssetId {
        AssetId::from_slice(&[byte; 32]).unwrap()
    }

    fn principal_asset() -> AssetId {
        asset(0xaa)
    }

    fn random_pinned(rng: &mut StdRng, asset_id: AssetId, amount: u64) -> PinnedOutput {
        PinnedOutput {
            asset_id,
            amount,
            asset_blinding_factor: AssetBlindingFactor::new(rng),
            value_blinding_factor: ValueBlindingFactor::new(rng),
        }
    }

    /// A repayment output of the principal asset with random blinders, standing for `A`.
    fn random_repayment(rng: &mut StdRng) -> PinnedOutput {
        random_pinned(rng, principal_asset(), 1_000_000)
    }

    fn random_opening(rng: &mut StdRng, amount: u64) -> DebtOpening {
        DebtOpening {
            amount,
            blinder: ValueBlindingFactor::new(rng),
        }
    }

    /// The low bit of a commitment's prefix: 0 when its `y` is a square.
    fn prefix_bit(encoding: &[u8]) -> u8 {
        encoding[0] & 1
    }

    /// `blinder·G`.
    fn times_generator(blinder: ValueBlindingFactor) -> PublicKey {
        let key = SecretKey::from_slice(blinder.into_inner().as_ref()).unwrap();
        PublicKey::from_secret_key(SECP256K1, &key)
    }

    /// The pinned outputs of the offer whose borrower's ephemeral key is `[seed; 32]`, derived as
    /// both parties derive them.
    fn offer_pinned(seed: u8) -> OfferPinned {
        let lender = LendingKey::from_master_blinding_key(&[2; 32]);
        let ephemeral_sk = SecretKey::from_slice(&[seed; 32]).unwrap();
        let secrets = OfferSecrets::for_borrower(&ephemeral_sk, &lender.x_only_public_key());
        let terms = OfferTerms {
            principal_asset: principal_asset(),
            principal_amount: 10_000,
            repayment_amount: 11_000,
            interest_rate_bps: 1_000,
            loan_expiration_time: 1_000,
            borrower_nft: asset(0x44),
            lender_nft: asset(0x55),
        };
        OfferPinned::derive(&secrets, asset(0xcc), COLLATERAL_AMOUNT, &terms)
    }

    /// An installment output of `payment` under the asset and asset blinder of `actual`, blinded
    /// with `ephemeral_sk` to `recipient`, whose range proof's message names the asset id and the
    /// asset blinder of `claimed`; proved as `blind_pset` proves a pinned output.
    fn installment_output(
        actual: &PinnedOutput,
        claimed: &PinnedOutput,
        payment: DebtOpening,
        ephemeral_sk: SecretKey,
        recipient: &XOnlyPublicKey,
    ) -> TxOut {
        let script_pubkey = Script::from(vec![0x51, 0x20, 0x01]);
        let actual = PinnedOutput {
            amount: payment.amount,
            value_blinding_factor: payment.blinder,
            ..*actual
        };
        let (nonce, shared_secret) =
            Nonce::with_ephemeral_sk(SECP256K1, ephemeral_sk, &lift_lending_key(recipient));
        let message = RangeProofMessage {
            asset: claimed.asset_id,
            bf: claimed.asset_blinding_factor,
        }
        .to_bytes();

        let (asset, value) = (actual.asset_commitment(), actual.value_commitment());
        let (generator, commitment) = (asset.commitment().unwrap(), value.commitment().unwrap());
        let rangeproof = RangeProof::new(
            SECP256K1,
            TxOut::RANGEPROOF_MIN_VALUE,
            commitment,
            actual.amount,
            actual.value_blinding_factor.into_inner(),
            &message,
            script_pubkey.as_bytes(),
            shared_secret,
            TxOut::RANGEPROOF_EXP_SHIFT,
            TxOut::RANGEPROOF_MIN_PRIV_BITS,
            generator,
        )
        .unwrap();

        TxOut {
            asset,
            value,
            nonce,
            script_pubkey,
            witness: TxOutWitness {
                surjection_proof: None,
                rangeproof: Some(Box::new(rangeproof)),
            },
        }
    }

    #[test]
    fn conversion_round_trips_both_prefix_bits() {
        let mut rng = rng();
        let (mut value_prefixes, mut generator_prefixes) = (HashSet::new(), HashSet::new());

        for _ in 0..32 {
            let amount = rng.gen_range(0..=u64::MAX);
            let pinned = random_pinned(&mut rng, principal_asset(), amount);
            let (asset, value) = (pinned.asset_commitment(), pinned.value_commitment());

            let point = value_point(&value).unwrap();
            assert_eq!(value_of_point(&point), value);
            value_prefixes.insert(serialize(&value)[0]);

            let point = asset_point(&asset).unwrap();
            assert_eq!(asset_of_point(&point), asset);
            generator_prefixes.insert(serialize(&asset)[0]);

            // the value commitment of amount 0 is `r·G`, whatever its prefix
            let zero = pinned.with_amount(0).value_commitment();
            let blinder = pinned.value_blinding_factor;
            assert_eq!(value_point(&zero), Ok(times_generator(blinder)));
            value_prefixes.insert(serialize(&zero)[0]);

            // a generator blinded with `a` is the unblinded one plus `a·G`, whatever their prefixes
            let unblinded = PinnedOutput {
                asset_blinding_factor: AssetBlindingFactor::zero(),
                ..pinned
            };
            let unblinded = asset_point(&unblinded.asset_commitment()).unwrap();
            let abf = pinned.asset_blinding_factor.into_inner();
            let abf = ValueBlindingFactor::from_slice(abf.as_ref()).unwrap();
            assert_eq!(
                Ok(point),
                unblinded.combine(&times_generator(abf)).map_err(|_| ())
            );
        }

        assert_eq!(value_prefixes, HashSet::from([0x08, 0x09]));
        assert_eq!(generator_prefixes, HashSet::from([0x0a, 0x0b]));
    }

    #[test]
    fn debt_after_matches_the_openings() {
        let mut rng = rng();
        let repayment = random_repayment(&mut rng);
        let mut bits = HashSet::new();

        for _ in 0..200 {
            let amount = rng.gen_range(1..=u64::MAX);
            let debt = random_opening(&mut rng, amount);
            let amount = rng.gen_range(1..=debt.amount);
            let payment = random_opening(&mut rng, amount);
            let (d, v) = (debt.commitment(&repayment), payment.commitment(&repayment));
            let expected = debt.after(payment).unwrap().commitment(&repayment);

            assert_eq!(debt_after(&d, &v), Ok(expected));
            bits.insert((
                prefix_bit(&serialize(&d)),
                prefix_bit(&serialize(&v)),
                prefix_bit(&serialize(&expected)),
            ));
        }

        // every combination of the prefix bits of `D`, `V` and `D − V`
        assert_eq!(bits.len(), 8);
    }

    #[test]
    fn debt_after_refuses_infinity() {
        let mut rng = rng();
        let repayment = random_repayment(&mut rng);
        let debt = random_opening(&mut rng, 5_000);
        let d = debt.commitment(&repayment);

        assert_eq!(debt_after(&d, &d), Err(DebtError::Infinity));
        assert_eq!(debt.after(debt), None);
    }

    #[test]
    fn debt_values_must_be_commitments() {
        let mut rng = rng();
        let repayment = random_repayment(&mut rng);
        let d = random_opening(&mut rng, 5_000).commitment(&repayment);
        let explicit = confidential::Value::Explicit(5_000);

        assert_eq!(debt_after(&explicit, &d), Err(DebtError::NotConfidential));
        assert_eq!(debt_after(&d, &explicit), Err(DebtError::NotConfidential));
        assert_eq!(
            debt_after(&d, &confidential::Value::Null),
            Err(DebtError::NotConfidential)
        );
        assert_eq!(
            asset_plus_generator(&confidential::Asset::Explicit(principal_asset())),
            Err(DebtError::NotConfidential)
        );
    }

    #[test]
    fn start_debt_hash_is_the_repayment_commitment() {
        let repayment = offer_pinned(3).repayment;
        let start = DebtOpening::of(&repayment);

        assert_eq!(start.amount, repayment.amount);
        assert_eq!(start.blinder, repayment.value_blinding_factor);
        assert_eq!(start.commitment(&repayment), repayment.value_commitment());
        assert_eq!(
            debt_hash(&repayment.asset_commitment(), &start.commitment(&repayment)),
            repayment.commitment_hash()
        );
    }

    #[test]
    fn collateral_after_keeps_the_value_commitment() {
        let mut prefixes = HashSet::new();

        for seed in 1..=8 {
            let pinned = offer_pinned(seed);
            let active = pinned.active_collateral;
            assert_eq!(pinned.collateral_after(0), active);

            for i in 0..=5 {
                let (step, next) = (pinned.collateral_after(i), pinned.collateral_after(i + 1));
                assert_eq!(
                    (step.asset_id, step.amount),
                    (active.asset_id, active.amount)
                );
                assert_eq!(step.value_commitment(), active.value_commitment());
                assert_eq!(
                    asset_plus_generator(&step.asset_commitment()),
                    Ok(next.asset_commitment())
                );
                prefixes.insert(serialize(&step.asset_commitment())[0]);
            }

            let last = pinned.collateral_after(u32::MAX);
            assert_eq!(last.value_commitment(), active.value_commitment());
        }

        assert_eq!(prefixes, HashSet::from([0x0a, 0x0b]));
    }

    /// Whether the value commitments `swept` add up to `total`.
    fn adds_up(swept: &[confidential::Value], total: &confidential::Value) -> bool {
        let points: Vec<_> = swept.iter().map(|v| value_point(v).unwrap()).collect();
        let points: Vec<_> = points.iter().collect();
        PublicKey::combine_keys(&points).unwrap() == value_point(total).unwrap()
    }

    #[test]
    fn sweep_opening_balances() {
        let mut rng = rng();
        let repayment = random_repayment(&mut rng);
        let start = DebtOpening::of(&repayment);
        let installments: Vec<_> = [100_000, 250_000, 50_000, 300_000]
            .map(|amount| random_opening(&mut rng, amount))
            .to_vec();
        let claimed = [installments[0], installments[2]];
        let unclaimed = [installments[1], installments[3]];
        let debt = installments
            .iter()
            .try_fold(start, |debt, paid| debt.after(*paid))
            .unwrap();
        let commitments = |openings: &[DebtOpening]| -> Vec<_> {
            openings.iter().map(|o| o.commitment(&repayment)).collect()
        };

        // the full repayment's output is the debt itself
        let swept = commitments(&[unclaimed[0], unclaimed[1], debt]);
        let sweep = sweep_opening(start, &claimed).unwrap();
        assert!(adds_up(&swept, &sweep.commitment(&repayment)));

        // claims beyond the debt at acceptance
        let too_much = [random_opening(&mut rng, start.amount + 1)];
        assert_eq!(sweep_opening(start, &too_much), None);
    }

    #[test]
    fn opening_after_refuses_overpayment() {
        let mut rng = rng();
        let debt = random_opening(&mut rng, 1_000);

        assert_eq!(debt.after(random_opening(&mut rng, 1_001)), None);
        assert_eq!(debt.after(random_opening(&mut rng, u64::MAX)), None);

        let payment = random_opening(&mut rng, 400);
        let left = debt.after(payment).unwrap();
        assert_eq!(left.amount, 600);
        let mut blinder = left.blinder;
        blinder += payment.blinder;
        assert_eq!(blinder, debt.blinder);

        let all = random_opening(&mut rng, 1_000);
        assert_eq!(debt.after(all).map(|left| left.amount), Some(0));
    }

    #[test]
    fn open_installment_for_both_parties() {
        let mut rng = rng();
        let borrower = LendingKey::from_master_blinding_key(&[1; 32]);
        let lender = LendingKey::from_master_blinding_key(&[2; 32]);
        let other_lender = LendingKey::from_master_blinding_key(&[3; 32]);
        let repayment = random_repayment(&mut rng);
        let payment = random_opening(&mut rng, 40_000);
        let ephemeral_sk = installment_ephemeral_key(
            &borrower,
            OutPoint::new(Txid::from_byte_array(sequence(0x00)), 1),
            OutPoint::new(Txid::from_byte_array(sequence(0x20)), 0),
            &Script::from(vec![0x00, 0x14, 0x07]),
        );
        let nonce = PublicKey::from_secret_key(SECP256K1, &ephemeral_sk);
        let lender_key = lender.x_only_public_key();
        let as_borrower = OfferSecrets::for_borrower(&ephemeral_sk, &lender_key).shared_secret();
        let as_lender = OfferSecrets::for_lender(&lender, &nonce).shared_secret();

        let output = installment_output(&repayment, &repayment, payment, ephemeral_sk, &lender_key);
        assert_eq!(output.nonce, Nonce::Confidential(nonce));
        assert_eq!(
            open_installment(&output, as_borrower, &repayment),
            Ok(payment)
        );
        assert_eq!(
            open_installment(&output, as_lender, &repayment),
            Ok(payment)
        );

        // blinded to another lender's key
        let other_key = other_lender.x_only_public_key();
        let elsewhere =
            installment_output(&repayment, &repayment, payment, ephemeral_sk, &other_key);
        for shared_secret in [as_borrower, as_lender] {
            assert!(matches!(
                open_installment(&elsewhere, shared_secret, &repayment),
                Err(InstallmentError::Rewind(RewindError::RangeProof(_)))
            ));
        }

        // blinded to the lender with a key the borrower did not derive: the lender opens it alone
        let drawn_sk = SecretKey::new(&mut rng);
        let drawn = installment_output(&repayment, &repayment, payment, drawn_sk, &lender_key);
        let drawn_nonce = PublicKey::from_secret_key(SECP256K1, &drawn_sk);
        let as_lender = OfferSecrets::for_lender(&lender, &drawn_nonce).shared_secret();
        assert_eq!(open_installment(&drawn, as_lender, &repayment), Ok(payment));
        assert!(matches!(
            open_installment(&drawn, as_borrower, &repayment),
            Err(InstallmentError::Rewind(RewindError::RangeProof(_)))
        ));
    }

    #[test]
    fn open_installment_refuses_another_asset() {
        let mut rng = rng();
        let lender = LendingKey::from_master_blinding_key(&[2; 32]);
        let ephemeral_sk = SecretKey::new(&mut rng);
        let nonce = PublicKey::from_secret_key(SECP256K1, &ephemeral_sk);
        let shared_secret = OfferSecrets::for_lender(&lender, &nonce).shared_secret();
        let lender_key = lender.x_only_public_key();
        let repayment = random_repayment(&mut rng);
        let payment = random_opening(&mut rng, 40_000);
        let reblinded = PinnedOutput {
            asset_blinding_factor: AssetBlindingFactor::new(&mut rng),
            ..repayment
        };
        let other_asset = random_pinned(&mut rng, asset(0xbb), 0);
        let open = |actual: &PinnedOutput, claimed: &PinnedOutput| {
            let output = installment_output(actual, claimed, payment, ephemeral_sk, &lender_key);
            open_installment(&output, shared_secret, &repayment)
        };

        // the message names `A`, but the output is under another asset blinder or asset
        assert_eq!(
            open(&reblinded, &repayment),
            Err(InstallmentError::CommitmentMismatch)
        );
        assert_eq!(
            open(&other_asset, &repayment),
            Err(InstallmentError::CommitmentMismatch)
        );
        // the message names another asset blinder or asset
        assert_eq!(
            open(&reblinded, &reblinded),
            Err(InstallmentError::OtherAsset)
        );
        assert_eq!(
            open(&repayment, &reblinded),
            Err(InstallmentError::OtherAsset)
        );
        assert_eq!(
            open(&other_asset, &other_asset),
            Err(InstallmentError::OtherAsset)
        );
    }
}
