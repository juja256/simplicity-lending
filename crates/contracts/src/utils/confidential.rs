//! Confidential outputs with blinding factors fixed in advance ("pinned"), and a finalizer for
//! transactions that contain them.
//!
//! A covenant can pin an output by the hash of its confidential asset and amount
//! (`jet::asset_amount_hash`), so whoever builds the transaction cannot change the blinding
//! factors, and the recipient, who chose them, can always open the output. Simplex blinds outputs
//! with random factors only, so [`ConfidentialTransaction::finalize`] blinds the pinned outputs
//! itself and lets `blind_last` balance the remaining ones.

use std::collections::HashSet;
use std::ops::{Deref, DerefMut};

use ring::digest::{SHA256, digest};
use simplex::program::ProgramError;
use simplex::provider::{ProviderError, ProviderTrait};
use simplex::signer::{Signer, SignerError, SignerTrait};
use simplex::simplicityhl::elements::bitcoin::PublicKey;
use simplex::simplicityhl::elements::confidential::{
    self, AssetBlindingFactor, ValueBlindingFactor,
};
use simplex::simplicityhl::elements::encode::serialize;
use simplex::simplicityhl::elements::pset::PsetBlindError;
use simplex::simplicityhl::elements::secp256k1_zkp::{
    Generator, PedersenCommitment, Secp256k1, SecretKey,
};
use simplex::simplicityhl::elements::{
    AssetId, ConfidentialTxOutError, OutPoint, RangeProofMessage, Script, Transaction, TxOut,
    TxOutSecrets, Txid, pset,
};
use simplex::transaction::{
    FinalTransaction, PartialInput, PartialOutput, RequiredSignature, UTXO,
};

/// The smallest confidential change the finalizer leaves.
pub const MIN_CONFIDENTIAL_CHANGE: u64 = 1_000;

/// The fee of the first pass, which only measures the transaction's weight.
const PLACEHOLDER_FEE: u64 = 1_000;

/// How many times [`wait_for_confirmation`] repeats the provider's wait, a short poll.
const CONFIRMATION_WAITS: usize = 20;

/// Waits for `txid` to confirm, repeating the provider's wait when it times out.
///
/// # Errors
/// Returns the provider's error, the timeout after [`CONFIRMATION_WAITS`] waits.
pub fn wait_for_confirmation(
    provider: &dyn ProviderTrait,
    txid: &Txid,
) -> Result<(), ProviderError> {
    for _ in 1..CONFIRMATION_WAITS {
        match provider.wait(txid) {
            Err(ProviderError::Confirmation()) => continue,
            result => return result,
        }
    }

    provider.wait(txid)
}

/// A confidential output whose asset and value blinding factors are fixed in advance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinnedOutput {
    pub asset_id: AssetId,
    pub amount: u64,
    pub asset_blinding_factor: AssetBlindingFactor,
    pub value_blinding_factor: ValueBlindingFactor,
}

impl PinnedOutput {
    /// A pinned output with fresh random blinding factors.
    ///
    /// # Panics
    /// Panics if `amount` is zero: Elements range proofs of confidential values start at 1.
    pub fn new_random(asset_id: AssetId, amount: u64) -> Self {
        assert!(amount > 0, "A confidential amount must be positive");

        let mut rng = rand::thread_rng();

        Self {
            asset_id,
            amount,
            asset_blinding_factor: AssetBlindingFactor::new(&mut rng),
            value_blinding_factor: ValueBlindingFactor::new(&mut rng),
        }
    }

    /// The same blinding factors with another amount.
    pub fn with_amount(mut self, amount: u64) -> Self {
        self.amount = amount;
        self
    }

    pub fn asset_commitment(&self) -> confidential::Asset {
        let secp = Secp256k1::new();
        let generator = Generator::new_blinded(
            &secp,
            self.asset_id.into_tag(),
            self.asset_blinding_factor.into_inner(),
        );

        confidential::Asset::Confidential(generator)
    }

    pub fn value_commitment(&self) -> confidential::Value {
        let secp = Secp256k1::new();
        let generator = self
            .asset_commitment()
            .commitment()
            .expect("a confidential asset");
        let commitment = PedersenCommitment::new(
            &secp,
            self.amount,
            self.value_blinding_factor.into_inner(),
            generator,
        );

        confidential::Value::Confidential(commitment)
    }

    /// SHA-256 of the consensus encodings of the asset and value commitments: what the
    /// covenant computes with `jet::asset_amount_hash`.
    pub fn commitment_hash(&self) -> [u8; 32] {
        let mut bytes = serialize(&self.asset_commitment());
        bytes.extend(serialize(&self.value_commitment()));

        let mut hash = [0u8; 32];
        hash.copy_from_slice(digest(&SHA256, &bytes).as_ref());

        hash
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

    /// The output `outpoint` created with this pinned output, ready to be spent.
    pub fn to_utxo(&self, outpoint: OutPoint, txout: TxOut) -> UTXO {
        UTXO {
            outpoint,
            txout,
            secrets: Some(self.secrets()),
        }
    }
}

#[derive(thiserror::Error, Debug)]
pub enum ConfidentialTransactionError {
    #[error(transparent)]
    Signer(#[from] SignerError),

    #[error(transparent)]
    Provider(#[from] ProviderError),

    #[error(transparent)]
    Program(#[from] ProgramError),

    #[error("Failed to blind a PST: {0}")]
    PsetBlind(#[from] PsetBlindError),

    #[error("Failed to blind a pinned output: {0}")]
    ConfidentialTxOut(#[from] ConfidentialTxOutError),

    #[error("Failed to extract a transaction from the PST: {0}")]
    Pset(#[from] pset::Error),

    #[error("Pinned output {0} has no recipient blinding key")]
    MissingBlindingKey(usize),

    #[error(
        "Program input {0} requires a signature, which the confidential finalizer does not inject"
    )]
    UnsupportedProgramSignature(usize),

    #[error("Not enough policy asset to pay the fee {0} and a confidential change")]
    NotEnoughFunds(u64),
}

/// A [`FinalTransaction`] with the pinned outputs it contains.
pub struct ConfidentialTransaction {
    ft: FinalTransaction,
    pinned_outputs: Vec<(usize, PinnedOutput)>,
}

impl ConfidentialTransaction {
    pub fn new() -> Self {
        Self {
            ft: FinalTransaction::new(),
            pinned_outputs: Vec::new(),
        }
    }

    /// Adds `pinned` paid to `script_pubkey`, with a range proof that `recipient_blinding_key`
    /// rewinds.
    pub fn add_pinned_output(
        &mut self,
        script_pubkey: Script,
        pinned: PinnedOutput,
        recipient_blinding_key: PublicKey,
    ) {
        let index = self.ft.n_outputs();

        self.ft.add_output(
            PartialOutput::new(script_pubkey, pinned.amount, pinned.asset_id)
                .with_blinding_key(recipient_blinding_key),
        );
        self.pinned_outputs.push((index, pinned));
    }

    pub fn pinned_outputs(&self) -> &[(usize, PinnedOutput)] {
        &self.pinned_outputs
    }

    /// Selects `signer`'s policy-asset coins for the fee, adds a confidential change to `signer`
    /// (the free output that balances the blinding factors), blinds and signs. Wallet inputs must
    /// belong to `signer`; program inputs must not require signatures.
    ///
    /// # Errors
    /// Returns an error if the wallet cannot pay the fee, or if blinding, a program or signing
    /// fails.
    pub fn finalize(&self, signer: &Signer) -> Result<Transaction, ConfidentialTransactionError> {
        let fee_rate = signer.get_provider().fetch_fee_rate(1)?;

        // the weight hardly depends on the fee, so one measuring pass is enough
        let draft = self.finalize_with_fee(signer, PLACEHOLDER_FEE)?;
        let fee = self
            .ft
            .calculate_fee(draft.discount_weight(), fee_rate)
            .max(PLACEHOLDER_FEE);

        self.finalize_with_fee(signer, fee)
    }

    /// [`Self::finalize`] and broadcast; waits for the transaction.
    ///
    /// # Errors
    /// See [`Self::finalize`], and broadcasting errors.
    pub fn broadcast(&self, signer: &Signer) -> Result<Transaction, ConfidentialTransactionError> {
        let tx = self.finalize(signer)?;

        let provider = signer.get_provider();
        provider.broadcast_transaction(&tx)?;
        wait_for_confirmation(provider, &tx.txid())?;

        Ok(tx)
    }

    fn finalize_with_fee(
        &self,
        signer: &Signer,
        fee: u64,
    ) -> Result<Transaction, ConfidentialTransactionError> {
        let network = *signer.get_provider().get_network();
        let policy_asset = network.policy_asset();

        let mut ft = self.ft.clone();

        let used: HashSet<OutPoint> = ft
            .inputs()
            .iter()
            .map(|input| {
                OutPoint::new(
                    input.partial_input.witness_txid,
                    input.partial_input.witness_output_index,
                )
            })
            .collect();
        let mut wallet_utxos = signer.get_utxos_asset(policy_asset)?;
        wallet_utxos.retain(|utxo| !used.contains(&utxo.outpoint));
        wallet_utxos.sort_by_key(|utxo| std::cmp::Reverse(utxo.amount()));

        let needed = (fee + MIN_CONFIDENTIAL_CHANGE).cast_signed();
        let mut wallet_utxos = wallet_utxos.into_iter();
        while ft.calculate_fee_delta(&network) < needed {
            let utxo = wallet_utxos
                .next()
                .ok_or(ConfidentialTransactionError::NotEnoughFunds(fee))?;
            ft.add_input(PartialInput::new(utxo), RequiredSignature::NativeEcdsa);
        }

        let change = ft.calculate_fee_delta(&network).cast_unsigned() - fee;
        ft.add_output(
            PartialOutput::new(
                signer.get_confidential_address().script_pubkey(),
                change,
                policy_asset,
            )
            .with_blinding_key(signer.get_blinding_public_key()),
        );
        ft.add_output(PartialOutput::new(Script::new(), fee, policy_asset));

        let (mut pst, input_secrets) = ft.extract_pst();
        let secp = Secp256k1::new();
        let mut rng = rand::thread_rng();
        let surjection_inputs = pst.surjection_inputs(&input_secrets)?;

        for (index, pinned) in &self.pinned_outputs {
            let output = &mut pst.outputs_mut()[*index];
            let recipient_blinding_key = output
                .blinding_key
                .ok_or(ConfidentialTransactionError::MissingBlindingKey(*index))?;

            let (asset, surjection_proof) = confidential::Asset::Explicit(pinned.asset_id).blind(
                &mut rng,
                &secp,
                pinned.asset_blinding_factor,
                &surjection_inputs,
            )?;
            let message = RangeProofMessage {
                asset: pinned.asset_id,
                bf: pinned.asset_blinding_factor,
            };
            let (value, nonce, rangeproof) = confidential::Value::Explicit(pinned.amount).blind(
                &secp,
                pinned.value_blinding_factor,
                recipient_blinding_key.inner,
                SecretKey::new(&mut rng),
                &output.script_pubkey,
                &message,
            )?;

            output.asset_comm = asset.commitment();
            output.amount_comm = value.commitment();
            output.asset_surjection_proof = Some(Box::new(surjection_proof));
            output.value_rangeproof = Some(Box::new(rangeproof));
            output.ecdh_pubkey = nonce.commitment().map(|inner| PublicKey {
                inner,
                compressed: true,
            });
            // already blinded: `blind_last` must leave it alone
            output.blinder_index = None;

            // `blind_last` balances as if this output had zero blinding factors; the scalar
            // corrects for its `amount * abf + vbf`
            let mut correction = ValueBlindingFactor::last(
                &secp,
                pinned.amount,
                pinned.asset_blinding_factor,
                &[],
                &[],
            );
            correction += -pinned.value_blinding_factor;
            pst.global.scalars.push(correction.into_inner());
        }

        pst.blind_last(&mut rng, &secp, &input_secrets)?;

        for (index, input) in ft.inputs().iter().enumerate() {
            let final_script_witness = match &input.program_input {
                Some(program_input) => {
                    if !matches!(input.required_sig, RequiredSignature::None) {
                        return Err(ConfidentialTransactionError::UnsupportedProgramSignature(
                            index,
                        ));
                    }

                    let witness = program_input.witness.build_witness();

                    program_input
                        .program
                        .finalize(&pst, &witness, index, &network)?
                }
                None => {
                    let (public_key, signature) = signer.sign_input(&pst, index)?;

                    let mut raw_signature = signature.serialize_der().to_vec();
                    raw_signature
                        .push(simplex::simplicityhl::elements::EcdsaSighashType::All as u8);

                    vec![raw_signature, public_key.to_bytes()]
                }
            };

            pst.inputs_mut()[index].final_script_witness = Some(final_script_witness);
        }

        Ok(pst.extract_tx()?)
    }
}

impl Default for ConfidentialTransaction {
    fn default() -> Self {
        Self::new()
    }
}

impl Deref for ConfidentialTransaction {
    type Target = FinalTransaction;

    fn deref(&self) -> &FinalTransaction {
        &self.ft
    }
}

impl DerefMut for ConfidentialTransaction {
    fn deref_mut(&mut self) -> &mut FinalTransaction {
        &mut self.ft
    }
}

#[cfg(test)]
mod tests {
    use super::PinnedOutput;
    use simplex::simplicityhl::elements::AssetId;

    #[test]
    fn commitment_hash_depends_on_amount_and_blinders() {
        let asset = AssetId::from_slice(&[7u8; 32]).unwrap();
        let pinned = PinnedOutput::new_random(asset, 1_000);

        assert_eq!(pinned.commitment_hash(), pinned.commitment_hash());
        assert_ne!(
            pinned.commitment_hash(),
            pinned.with_amount(999).commitment_hash()
        );
        assert_ne!(
            pinned.commitment_hash(),
            PinnedOutput::new_random(asset, 1_000).commitment_hash()
        );
    }
}
