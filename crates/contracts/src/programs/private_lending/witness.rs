use simplex::either::Either::{Left, Right};
use simplex::simplicityhl::elements::confidential;
use simplex::simplicityhl::elements::encode::{Encodable, serialize};

use crate::artifacts::private_lending::derived_private_lending::PrivateLendingWitness;

#[derive(Debug, Clone, Copy)]
pub enum PrivateLendingWitnessBranch {
    OfferAcceptance,
    OfferCancellation,
    /// The program checks that `debt` is the debt the loan's storage holds, computes the debt the
    /// installment at output 2 leaves and requires the successor loan at output 1 to hold it.
    Installment {
        debt: confidential::Value,
    },
    /// The program checks that `debt_hash` is the debt hash the loan's storage holds and that the
    /// repayment at output 1 has it.
    FullRepayment {
        debt_hash: [u8; 32],
    },
    /// The program checks that `debt` is the debt the loan's storage holds, that `key` is a
    /// nonzero scalar below the group's order with `key·G = ±debt`, and that output 1 is the
    /// `OP_RETURN` of `key`.
    ZeroDebtClose {
        debt: confidential::Value,
        key: [u8; 32],
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
    /// Panics if the debt of an installment or a zero-debt close is not a commitment.
    pub fn build_witness(&self) -> Box<PrivateLendingWitness> {
        let path = match self {
            PrivateLendingWitnessBranch::OfferAcceptance => Left(Left(())),
            PrivateLendingWitnessBranch::OfferCancellation => Left(Right(())),
            PrivateLendingWitnessBranch::Installment { debt } => {
                Right(Left(Left(commitment_witness(debt))))
            }
            PrivateLendingWitnessBranch::FullRepayment { debt_hash } => {
                Right(Left(Right(Left(*debt_hash))))
            }
            PrivateLendingWitnessBranch::ZeroDebtClose { debt, key } => {
                Right(Left(Right(Right((commitment_witness(debt), *key)))))
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
