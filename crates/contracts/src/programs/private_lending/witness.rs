use simplex::either::Either::{Left, Right};

use crate::artifacts::private_lending::derived_private_lending::PrivateLendingWitness;

#[derive(Debug, Clone, Copy)]
pub enum PrivateLendingWitnessBranch {
    OfferAcceptance,
    OfferCancellation,
    /// Reserved for a later contract version: the program always rejects it.
    PartialRepayment,
    FullRepayment,
    Liquidation,
}

impl PrivateLendingWitnessBranch {
    pub fn build_witness(&self) -> Box<PrivateLendingWitness> {
        let path = match self {
            PrivateLendingWitnessBranch::OfferAcceptance => Left(Left(())),
            PrivateLendingWitnessBranch::OfferCancellation => Left(Right(())),
            PrivateLendingWitnessBranch::PartialRepayment => Right(Left(Left(()))),
            PrivateLendingWitnessBranch::FullRepayment => Right(Left(Right(()))),
            PrivateLendingWitnessBranch::Liquidation => Right(Right(())),
        };

        Box::new(PrivateLendingWitness { path })
    }
}
