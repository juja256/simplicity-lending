//! Confidential outputs whose blinding factors are fixed in advance ("pinned").
//!
//! A covenant can pin an output by the hash of its confidential asset and amount
//! (`jet::asset_amount_hash`), so whoever builds the transaction cannot change the blinding
//! factors, and the recipient, who chose them, can always open the output.

use elements::confidential::{self, AssetBlindingFactor, ValueBlindingFactor};
use elements::encode::serialize;
use elements::hashes::{Hash, sha256};
use elements::secp256k1_zkp::{Generator, PedersenCommitment, SECP256K1};
use elements::{AssetId, TxOut, TxOutSecrets};

/// A confidential output whose asset and value blinding factors are fixed in advance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinnedOutput {
    pub asset_id: AssetId,
    pub amount: u64,
    pub asset_blinding_factor: AssetBlindingFactor,
    pub value_blinding_factor: ValueBlindingFactor,
}

impl PinnedOutput {
    /// The same blinding factors with another amount.
    pub fn with_amount(mut self, amount: u64) -> Self {
        self.amount = amount;
        self
    }

    pub fn asset_commitment(&self) -> confidential::Asset {
        confidential::Asset::Confidential(self.asset_generator())
    }

    pub fn value_commitment(&self) -> confidential::Value {
        let commitment = PedersenCommitment::new(
            SECP256K1,
            self.amount,
            self.value_blinding_factor.into_inner(),
            self.asset_generator(),
        );

        confidential::Value::Confidential(commitment)
    }

    /// SHA-256 of the consensus encodings of the asset and value commitments: what the
    /// covenant computes with `jet::asset_amount_hash`.
    pub fn commitment_hash(&self) -> [u8; 32] {
        let mut bytes = serialize(&self.asset_commitment());
        bytes.extend(serialize(&self.value_commitment()));

        sha256::Hash::hash(&bytes).to_byte_array()
    }

    /// Whether `txout` carries exactly this pinned asset and amount.
    pub fn matches(&self, txout: &TxOut) -> bool {
        txout.asset == self.asset_commitment() && txout.value == self.value_commitment()
    }

    pub fn secrets(&self) -> TxOutSecrets {
        TxOutSecrets::new(
            self.asset_id,
            self.asset_blinding_factor,
            self.amount,
            self.value_blinding_factor,
        )
    }

    /// The blinded asset generator, the commitment's inner value.
    pub(crate) fn asset_generator(&self) -> Generator {
        Generator::new_blinded(
            SECP256K1,
            self.asset_id.into_tag(),
            self.asset_blinding_factor.into_inner(),
        )
    }
}
