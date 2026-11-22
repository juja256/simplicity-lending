use private_lending_core::{MAX_STEPS, ReleaseProof};
use simplex::either::Either::{Left, Right};
use simplex::simplicityhl::elements::confidential;
use simplex::simplicityhl::elements::encode::{Encodable, serialize};
use simplex::simplicityhl::elements::secp256k1_zkp::PublicKey;

use crate::artifacts::private_lending::derived_private_lending::PrivateLendingWitness;

// The installment's witness, with its release proof, is about a kilobyte: a branch is built once
// per spend, so it stays unboxed and `Copy`.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Copy)]
pub enum PrivateLendingWitnessBranch {
    OfferAcceptance,
    OfferCancellation,
    /// The program checks that `debt` is the debt the loan's storage holds, computes the debt the
    /// installment at output 2 leaves and requires the successor loan at output 1 to hold it. It
    /// checks that the loan is at `step` (its asset commitment is `A_c + step·G`), that
    /// `blinder_commitment` is leaf `step` of `BLINDER_ROOT` by `path`, and that `proof` proves
    /// the release: the successor holds `ceil(d'·C/R)` of the collateral, with the value blinder
    /// that `blinder_commitment` commits to, the carries at outputs 3 and 4 holding the remainder.
    Installment {
        debt: confidential::Value,
        /// `i`, the number of installments the loan has had.
        step: u32,
        /// `Y_(i+1) = x_(i+1)·G + y_(i+1)·J`.
        blinder_commitment: PublicKey,
        /// The Merkle path of leaf `i`, from the leaf up
        /// ([`BlinderTree::path`](private_lending_core::BlinderTree::path)).
        path: [(bool, [u8; 32]); 10],
        proof: ReleaseProof,
    },
    /// The program checks that `debt_hash` is the debt hash the loan's storage holds and that the
    /// repayment at output 1 has it.
    FullRepayment {
        debt_hash: [u8; 32],
    },
    /// The program checks that `debt_hash` is the debt hash the loan's storage holds, that
    /// `SHA-256(salt ‖ expiry)` is its `EXPIRY_HASH` and that the transaction is locked to at
    /// least `expiry`.
    Liquidation {
        debt_hash: [u8; 32],
        salt: [u8; 32],
        expiry: u32,
    },
}

impl PrivateLendingWitnessBranch {
    /// # Panics
    /// Panics if the debt of an installment is not a commitment, or its step is 1024 or above:
    /// the tree has no leaf for it.
    pub fn build_witness(&self) -> Box<PrivateLendingWitness> {
        let path = match self {
            PrivateLendingWitnessBranch::OfferAcceptance => Left(Left(())),
            PrivateLendingWitnessBranch::OfferCancellation => Left(Right(())),
            PrivateLendingWitnessBranch::Installment {
                debt,
                step,
                blinder_commitment,
                path,
                proof,
            } => {
                assert!(
                    *step < MAX_STEPS,
                    "A loan at step {step} has no installment left: the tree has {MAX_STEPS} leaves"
                );
                let index = u16::try_from(*step).expect("a step below 1024 fits in a u16");
                let [t1, t2, t3, t4, t5, t6, t7] = proof.t.map(|t| point_witness(&t));
                let [z1, z2, z3, z4, z5, z6, z7, z8, z9, z10, z11] =
                    proof.z.map(|z| z.to_be_bytes());

                Right(Left(Left((
                    commitment_witness(debt),
                    index,
                    point_witness(blinder_commitment),
                    *path,
                    (t1, t2, t3, t4, t5, t6, t7),
                    (z1, z2, z3, z4, z5, z6, z7, z8, z9, z10, z11),
                ))))
            }
            PrivateLendingWitnessBranch::FullRepayment { debt_hash } => {
                Right(Left(Right(*debt_hash)))
            }
            PrivateLendingWitnessBranch::Liquidation {
                debt_hash,
                salt,
                expiry,
            } => Right(Right((*debt_hash, *salt, *expiry))),
        };

        Box::new(PrivateLendingWitness { path })
    }
}

/// A commitment as the program takes it: whether the low bit of its consensus encoding's prefix is
/// set, and its x-coordinate, the 32 bytes that follow the prefix. The program takes the bit as a
/// `bool`, not a `u1`: simplex 0.0.5's generated conversion of a `u1` panics on 0.
///
/// # Panics
/// Panics if `commitment` is explicit or null: its consensus encoding is not 33 bytes.
pub(crate) fn commitment_witness(commitment: &impl Encodable) -> (bool, [u8; 32]) {
    let encoding = serialize(commitment);
    assert!(encoding.len() == 33, "Not a commitment");

    let x = encoding[1..]
        .try_into()
        .expect("33 bytes are the prefix and x");

    (encoding[0] & 1 == 1, x)
}

/// A curve point as the program takes it, a `Ge`: its affine coordinates `(x, y)`, each 32 bytes
/// big-endian.
pub(crate) fn point_witness(point: &PublicKey) -> ([u8; 32], [u8; 32]) {
    let uncompressed = point.serialize_uncompressed();
    let coordinate = |range: std::ops::Range<usize>| {
        uncompressed[range]
            .try_into()
            .expect("an uncompressed point is 0x04, x and y")
    };

    (coordinate(1..33), coordinate(33..65))
}
