//! Confidential outputs with blinding factors fixed in advance ("pinned"), and a finalizer for
//! transactions that contain them.
//!
//! A covenant can pin an output by the hash of its confidential asset and amount
//! (`jet::asset_amount_hash`), so whoever builds the transaction cannot change the blinding
//! factors, and the recipient, who chose them, can always open the output. Simplex blinds outputs
//! with random factors only, so [`ConfidentialTransaction::finalize`] blinds with
//! [`private_lending_core::blind_pset`], which blinds the pinned outputs and lets `blind_last`
//! balance the remaining ones.

use std::collections::HashSet;
use std::ops::{Deref, DerefMut};

use private_lending_core::{BlindPsetError, PinnedBlinding, blind_pset};
use simplex::program::ProgramError;
use simplex::provider::{ProviderError, ProviderTrait};
use simplex::signer::{Signer, SignerError, SignerTrait};
use simplex::simplicityhl::elements::bitcoin::PublicKey;
use simplex::simplicityhl::elements::confidential::{AssetBlindingFactor, ValueBlindingFactor};
use simplex::simplicityhl::elements::secp256k1_zkp::SecretKey;
use simplex::simplicityhl::elements::{AssetId, OutPoint, Script, Transaction, TxOut, Txid, pset};
use simplex::transaction::{
    FinalTransaction, PartialInput, PartialOutput, RequiredSignature, UTXO,
};

pub use private_lending_core::PinnedOutput;

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

/// The parts of a [`PinnedOutput`] that need randomness or simplex types.
pub trait PinnedOutputExt {
    /// A pinned output with fresh random blinding factors.
    ///
    /// # Panics
    /// Panics if `amount` is zero: Elements range proofs of confidential values start at 1.
    fn new_random(asset_id: AssetId, amount: u64) -> Self;

    /// The output `outpoint` created with this pinned output, ready to be spent.
    fn to_utxo(&self, outpoint: OutPoint, txout: TxOut) -> UTXO;
}

impl PinnedOutputExt for PinnedOutput {
    fn new_random(asset_id: AssetId, amount: u64) -> Self {
        assert!(amount > 0, "A confidential amount must be positive");

        let mut rng = rand::thread_rng();

        Self {
            asset_id,
            amount,
            asset_blinding_factor: AssetBlindingFactor::new(&mut rng),
            value_blinding_factor: ValueBlindingFactor::new(&mut rng),
        }
    }

    fn to_utxo(&self, outpoint: OutPoint, txout: TxOut) -> UTXO {
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
    BlindPset(#[from] BlindPsetError),

    #[error("Failed to extract a transaction from the PST: {0}")]
    Pset(#[from] pset::Error),

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
    pinned_outputs: Vec<PinnedBlinding>,
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
        self.push_pinned_output(
            script_pubkey,
            pinned,
            recipient_blinding_key,
            None,
            Vec::new(),
        );
    }

    /// [`Self::add_pinned_output`] with the nonce `ephemeral_sk·G` and `extra_data` in the range
    /// proof's message (see [`PinnedBlinding`]).
    pub fn add_pinned_output_with(
        &mut self,
        script_pubkey: Script,
        pinned: PinnedOutput,
        recipient_blinding_key: PublicKey,
        ephemeral_sk: SecretKey,
        extra_data: Vec<u8>,
    ) {
        self.push_pinned_output(
            script_pubkey,
            pinned,
            recipient_blinding_key,
            Some(ephemeral_sk),
            extra_data,
        );
    }

    pub fn pinned_outputs(&self) -> &[PinnedBlinding] {
        &self.pinned_outputs
    }

    fn push_pinned_output(
        &mut self,
        script_pubkey: Script,
        pinned: PinnedOutput,
        recipient_blinding_key: PublicKey,
        ephemeral_sk: Option<SecretKey>,
        extra_data: Vec<u8>,
    ) {
        let output_index = self.ft.n_outputs();

        self.ft.add_output(
            PartialOutput::new(script_pubkey, pinned.amount, pinned.asset_id)
                .with_blinding_key(recipient_blinding_key),
        );
        self.pinned_outputs.push(PinnedBlinding {
            output_index,
            pinned,
            ephemeral_sk,
            extra_data,
        });
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
        blind_pset(
            &mut pst,
            &input_secrets,
            &self.pinned_outputs,
            &mut rand::thread_rng(),
        )?;

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
    use super::{PinnedOutput, PinnedOutputExt};
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
