//! Blinding a PSET whose pinned outputs carry extra data in their range proofs, and rewinding
//! such an output.

use std::collections::{HashMap, HashSet};
use std::fmt;

use elements::confidential::{self, AssetBlindingFactor, Nonce, ValueBlindingFactor};
use elements::pset::{PartiallySignedTransaction, PsetBlindError};
use elements::secp256k1_zkp::{
    self, PedersenCommitment, RangeProof, SECP256K1, SecretKey, SurjectionProof,
};
use elements::{
    AssetId, BlindAssetProofs, BlindValueProofs, ConfidentialTxOutError, RangeProofMessage,
    SurjectionInput, TxOut, TxOutSecrets, bitcoin,
};
use rand::{CryptoRng, RngCore};

use crate::PinnedOutput;

/// How [`blind_pset`] blinds one pinned output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedBlinding {
    /// The index of the output in the PSET.
    pub output_index: usize,
    pub pinned: PinnedOutput,
    /// The key whose public key becomes the output's nonce; random when `None`.
    pub ephemeral_sk: Option<SecretKey>,
    /// Bytes the range proof's message carries after the asset id and the asset blinding factor,
    /// at most 3136 (the message holds 3200 bytes at the range proof parameters of Elements).
    pub extra_data: Vec<u8>,
}

/// Errors of [`blind_pset`].
#[derive(Debug)]
pub enum BlindPsetError {
    /// The pinned output's index is past the PSET's outputs.
    MissingOutput(usize),
    /// Two pinned blindings name the same output.
    DuplicateOutput(usize),
    /// The output has no recipient blinding key.
    MissingBlindingKey(usize),
    /// The output's explicit asset or amount is not the pinned one.
    PinnedMismatch(usize),
    /// Blinding the output's asset failed.
    Asset(usize, ConfidentialTxOutError),
    /// Creating a proof for the output failed.
    Proof(usize, secp256k1_zkp::Error),
    /// Blinding the other outputs failed.
    Pset(PsetBlindError),
}

impl fmt::Display for BlindPsetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingOutput(index) => write!(f, "pinned output {index} is not in the PSET"),
            Self::DuplicateOutput(index) => write!(f, "output {index} is pinned twice"),
            Self::MissingBlindingKey(index) => {
                write!(f, "pinned output {index} has no recipient blinding key")
            }
            Self::PinnedMismatch(index) => {
                write!(
                    f,
                    "output {index} does not carry its pinned asset and amount"
                )
            }
            Self::Asset(index, e) => write!(f, "failed to blind the asset of output {index}: {e}"),
            Self::Proof(index, e) => write!(f, "failed to prove output {index}: {e}"),
            Self::Pset(e) => write!(f, "failed to blind the PSET: {e}"),
        }
    }
}

impl std::error::Error for BlindPsetError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Asset(_, e) => Some(e),
            Self::Proof(_, e) => Some(e),
            Self::Pset(e) => Some(e),
            Self::MissingOutput(_)
            | Self::DuplicateOutput(_)
            | Self::MissingBlindingKey(_)
            | Self::PinnedMismatch(_) => None,
        }
    }
}

impl From<PsetBlindError> for BlindPsetError {
    fn from(e: PsetBlindError) -> Self {
        Self::Pset(e)
    }
}

/// Errors of [`rewind`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RewindError {
    /// The output's asset or value is explicit.
    NotConfidential,
    /// The output has no range proof.
    MissingRangeProof,
    /// The range proof does not open with this shared secret.
    RangeProof(secp256k1_zkp::Error),
    /// The message does not start with an asset id and an asset blinding factor.
    MalformedMessage,
}

impl fmt::Display for RewindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfidential => f.write_str("the output is not confidential"),
            Self::MissingRangeProof => f.write_str("the output has no range proof"),
            Self::RangeProof(e) => write!(f, "the range proof does not rewind: {e}"),
            Self::MalformedMessage => f.write_str("malformed range proof message"),
        }
    }
}

impl std::error::Error for RewindError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::RangeProof(e) => Some(e),
            Self::NotConfidential | Self::MissingRangeProof | Self::MalformedMessage => None,
        }
    }
}

/// The length of the range proof message's prefix, the asset id and the asset blinding factor.
const MESSAGE_PREFIX_LENGTH: usize = 64;

/// Blinds the PSET's outputs: each pinned output with its fixed blinding factors, a range proof
/// whose message is `asset id ‖ asset blinding factor ‖ extra data`, and blind value and asset
/// proofs; then, with `blind_last`, the other outputs marked for blinding, the last of which
/// balances the blinding factors.
///
/// `input_secrets` holds the secrets of the inputs by index, zero blinding factors for explicit
/// inputs. At least one output besides the pinned ones must be marked for blinding (a blinding
/// key and the blinder index of an input with secrets).
///
/// # Errors
/// Returns an error if two pinned blindings name the same output (checked before anything is
/// blinded), a pinned output is missing, has no blinding key or another explicit asset or amount
/// than the pinned one, or if blinding or a proof fails.
pub fn blind_pset<R: RngCore + CryptoRng>(
    pset: &mut PartiallySignedTransaction,
    input_secrets: &HashMap<usize, TxOutSecrets>,
    pinned: &[PinnedBlinding],
    rng: &mut R,
) -> Result<(), BlindPsetError> {
    // blinding one output twice would push two balancing scalars for it
    let mut indices = HashSet::new();
    if let Some(duplicate) = pinned
        .iter()
        .find(|blinding| !indices.insert(blinding.output_index))
    {
        return Err(BlindPsetError::DuplicateOutput(duplicate.output_index));
    }

    let surjection_inputs = pset.surjection_inputs(input_secrets)?;

    for blinding in pinned {
        blind_pinned_output(pset, &surjection_inputs, blinding, rng)?;
    }

    pset.blind_last(rng, SECP256K1, input_secrets)?;

    Ok(())
}

fn blind_pinned_output<R: RngCore + CryptoRng>(
    pset: &mut PartiallySignedTransaction,
    surjection_inputs: &[SurjectionInput],
    blinding: &PinnedBlinding,
    rng: &mut R,
) -> Result<(), BlindPsetError> {
    let index = blinding.output_index;
    let pinned = &blinding.pinned;
    let abf = pinned.asset_blinding_factor;
    let vbf = pinned.value_blinding_factor;

    let output = pset
        .outputs_mut()
        .get_mut(index)
        .ok_or(BlindPsetError::MissingOutput(index))?;
    let recipient_blinding_key = output
        .blinding_key
        .ok_or(BlindPsetError::MissingBlindingKey(index))?;
    if output.asset != Some(pinned.asset_id) || output.amount != Some(pinned.amount) {
        return Err(BlindPsetError::PinnedMismatch(index));
    }

    let (_, surjection_proof) = confidential::Asset::Explicit(pinned.asset_id)
        .blind(rng, SECP256K1, abf, surjection_inputs)
        .map_err(|e| BlindPsetError::Asset(index, e))?;
    let asset_generator = pinned.asset_generator();
    let value_commitment =
        PedersenCommitment::new(SECP256K1, pinned.amount, vbf.into_inner(), asset_generator);

    let ephemeral_sk = blinding.ephemeral_sk.unwrap_or_else(|| SecretKey::new(rng));
    let (nonce, shared_secret) =
        Nonce::with_ephemeral_sk(SECP256K1, ephemeral_sk, &recipient_blinding_key.inner);

    let mut message = RangeProofMessage {
        asset: pinned.asset_id,
        bf: abf,
    }
    .to_bytes()
    .to_vec();
    message.extend_from_slice(&blinding.extra_data);

    let rangeproof = RangeProof::new(
        SECP256K1,
        TxOut::RANGEPROOF_MIN_VALUE,
        value_commitment,
        pinned.amount,
        vbf.into_inner(),
        &message,
        output.script_pubkey.as_bytes(),
        shared_secret,
        TxOut::RANGEPROOF_EXP_SHIFT,
        TxOut::RANGEPROOF_MIN_PRIV_BITS,
        asset_generator,
    )
    .map_err(|e| BlindPsetError::Proof(index, e))?;
    let blind_value_proof = RangeProof::blind_value_proof(
        rng,
        SECP256K1,
        pinned.amount,
        value_commitment,
        asset_generator,
        vbf,
    )
    .map_err(|e| BlindPsetError::Proof(index, e))?;
    let blind_asset_proof =
        SurjectionProof::blind_asset_proof(rng, SECP256K1, pinned.asset_id, abf)
            .map_err(|e| BlindPsetError::Proof(index, e))?;

    output.asset_comm = Some(asset_generator);
    output.amount_comm = Some(value_commitment);
    output.asset_surjection_proof = Some(Box::new(surjection_proof));
    output.value_rangeproof = Some(Box::new(rangeproof));
    output.blind_asset_proof = Some(Box::new(blind_asset_proof));
    output.blind_value_proof = Some(Box::new(blind_value_proof));
    output.ecdh_pubkey = nonce.commitment().map(bitcoin::PublicKey::new);
    // already blinded: `blind_last` must leave it alone
    output.blinder_index = None;

    // `blind_last` balances as if this output had zero blinding factors; the scalar corrects
    // for its `amount * abf + vbf`
    let mut correction = ValueBlindingFactor::last(SECP256K1, pinned.amount, abf, &[], &[]);
    correction += -vbf;
    pset.global.scalars.push(correction.into_inner());

    Ok(())
}

/// Opens a confidential output's range proof with the shared secret of its nonce.
///
/// Returns the output's secrets and the extra data of the range proof's message, followed by
/// zeros: rewinding returns the whole message buffer of the proof.
///
/// The amount and the value blinder are proven by the range proof, but the returned asset id and
/// asset blinder are only what the message claims: nothing checks them against the output's asset
/// commitment. A caller that relies on them compares the commitments itself, as opening an offer
/// does (see [`PinnedOutput::matches`]).
///
/// # Errors
/// Returns an error if the output is not confidential, has no range proof, its range proof does
/// not open with `shared_secret`, or the message does not start with an asset id and an asset
/// blinding factor.
pub fn rewind(
    txout: &TxOut,
    shared_secret: SecretKey,
) -> Result<(TxOutSecrets, Vec<u8>), RewindError> {
    let (commitment, asset_generator) = match (txout.value, txout.asset) {
        (
            confidential::Value::Confidential(commitment),
            confidential::Asset::Confidential(generator),
        ) => (commitment, generator),
        _ => return Err(RewindError::NotConfidential),
    };
    let rangeproof = txout
        .witness
        .rangeproof
        .as_ref()
        .ok_or(RewindError::MissingRangeProof)?;

    let (opening, _) = rangeproof
        .rewind(
            SECP256K1,
            commitment,
            shared_secret,
            txout.script_pubkey.as_bytes(),
            asset_generator,
        )
        .map_err(RewindError::RangeProof)?;

    let (prefix, extra_data) = opening
        .message
        .split_at_checked(MESSAGE_PREFIX_LENGTH)
        .ok_or(RewindError::MalformedMessage)?;
    let (asset, abf) = prefix.split_at(32);
    let asset = AssetId::from_slice(asset).map_err(|_| RewindError::MalformedMessage)?;
    let abf = AssetBlindingFactor::from_slice(abf).map_err(|_| RewindError::MalformedMessage)?;
    let vbf = ValueBlindingFactor::from_slice(opening.blinding_factor.as_ref())
        .expect("a tweak's bytes are a value blinding factor");

    Ok((
        TxOutSecrets::new(asset, abf, opening.value, vbf),
        extra_data.to_vec(),
    ))
}

#[cfg(test)]
mod tests {
    use elements::hashes::Hash;
    use elements::pset::{Input, Output};
    use elements::secp256k1_zkp::PublicKey;
    use elements::{Script, TxOutWitness, Txid};
    use rand::thread_rng;

    use super::*;
    use crate::{LendingKey, OfferSecrets, lift_lending_key};

    fn asset(byte: u8) -> AssetId {
        AssetId::from_slice(&[byte; 32]).unwrap()
    }

    fn policy_asset() -> AssetId {
        asset(0xaa)
    }

    fn script(byte: u8) -> Script {
        Script::from(vec![0x51, byte])
    }

    fn random_pinned(asset_id: AssetId, amount: u64) -> PinnedOutput {
        let mut rng = thread_rng();
        PinnedOutput {
            asset_id,
            amount,
            asset_blinding_factor: AssetBlindingFactor::new(&mut rng),
            value_blinding_factor: ValueBlindingFactor::new(&mut rng),
        }
    }

    /// The recipient of the pinned outputs, a lending key as in the private contract.
    fn lender() -> LendingKey {
        LendingKey::from_master_blinding_key(&[5; 32])
    }

    /// The blinding key of the wallet's change.
    fn change_blinding_key() -> PublicKey {
        PublicKey::from_secret_key(SECP256K1, &SecretKey::from_slice(&[6; 32]).unwrap())
    }

    /// An explicit coin and its secrets, with zero blinding factors as simplex reports them.
    fn explicit_coin(asset_id: AssetId, amount: u64) -> (TxOut, TxOutSecrets) {
        let txout = TxOut {
            asset: confidential::Asset::Explicit(asset_id),
            value: confidential::Value::Explicit(amount),
            nonce: Nonce::Null,
            script_pubkey: script(0xc0),
            witness: TxOutWitness::default(),
        };
        let secrets = TxOutSecrets::new(
            asset_id,
            AssetBlindingFactor::zero(),
            amount,
            ValueBlindingFactor::zero(),
        );
        (txout, secrets)
    }

    /// A confidential wallet coin and its unblinded secrets.
    fn confidential_coin(asset_id: AssetId, amount: u64) -> (TxOut, TxOutSecrets) {
        let coin = random_pinned(asset_id, amount);
        let txout = TxOut {
            asset: coin.asset_commitment(),
            value: coin.value_commitment(),
            nonce: Nonce::Confidential(change_blinding_key()),
            script_pubkey: script(0xc1),
            witness: TxOutWitness::default(),
        };
        (txout, coin.secrets())
    }

    /// An output to blind for `blinding_key`, marked for blinding as simplex marks it.
    fn blinded_output(
        script_pubkey: Script,
        amount: u64,
        asset_id: AssetId,
        blinding_key: PublicKey,
    ) -> Output {
        let blinding_key = bitcoin::PublicKey::new(blinding_key);
        let mut output = Output::new_explicit(script_pubkey, amount, asset_id, Some(blinding_key));
        output.blinder_index = Some(0);
        output
    }

    fn fee_output(amount: u64) -> Output {
        Output::new_explicit(Script::new(), amount, policy_asset(), None)
    }

    /// A PSET spending `coins` to `outputs`, and the coins' secrets by input index.
    fn pset(
        coins: &[(TxOut, TxOutSecrets)],
        outputs: Vec<Output>,
    ) -> (PartiallySignedTransaction, HashMap<usize, TxOutSecrets>) {
        let mut pset = PartiallySignedTransaction::new_v2();
        let mut input_secrets = HashMap::new();
        for (index, (txout, secrets)) in coins.iter().enumerate() {
            pset.add_input(Input {
                previous_txid: Txid::from_byte_array([1; 32]),
                previous_output_index: index as u32,
                witness_utxo: Some(txout.clone()),
                ..Default::default()
            });
            input_secrets.insert(index, *secrets);
        }
        for output in outputs {
            pset.add_output(output);
        }
        (pset, input_secrets)
    }

    /// Spends `coin` to a pinned output with an ephemeral key and extra data, a confidential
    /// change and an explicit fee, and checks that the lender rewinds the pinned output.
    fn assert_pinned_output_rewinds(coin: (TxOut, TxOutSecrets)) {
        let lender = lender();
        let e = SecretKey::from_slice(&[3; 32]).unwrap();
        let pinned = random_pinned(policy_asset(), 60_000);
        let (mut pset, input_secrets) = pset(
            std::slice::from_ref(&coin),
            vec![
                blinded_output(
                    script(1),
                    pinned.amount,
                    pinned.asset_id,
                    lift_lending_key(&lender.x_only_public_key()),
                ),
                blinded_output(script(2), 39_500, policy_asset(), change_blinding_key()),
                fee_output(500),
            ],
        );
        let blinding = PinnedBlinding {
            output_index: 0,
            pinned,
            ephemeral_sk: Some(e),
            extra_data: b"terms".to_vec(),
        };

        blind_pset(&mut pset, &input_secrets, &[blinding], &mut thread_rng()).unwrap();
        let tx = pset.extract_tx().unwrap();

        let nonce = PublicKey::from_secret_key(SECP256K1, &e);
        assert_eq!(tx.output[0].nonce, Nonce::Confidential(nonce));
        assert!(pinned.matches(&tx.output[0]));

        let shared_secret = OfferSecrets::for_lender(&lender, &nonce).shared_secret();
        let (secrets, extra_data) = rewind(&tx.output[0], shared_secret).unwrap();
        assert_eq!(secrets, pinned.secrets());
        assert_eq!(&extra_data[..5], b"terms");
        assert!(extra_data[5..].iter().all(|byte| *byte == 0));

        let wrong_secret = SecretKey::from_slice(&[4; 32]).unwrap();
        assert!(matches!(
            rewind(&tx.output[0], wrong_secret),
            Err(RewindError::RangeProof(_))
        ));

        tx.verify_tx_amt_proofs(SECP256K1, &[coin.0]).unwrap();
    }

    /// Two pinned outputs of different assets, a confidential change and an explicit fee,
    /// blinded; with the pinned outputs and the spent coins.
    fn blinded_two_pinned() -> (PartiallySignedTransaction, [PinnedOutput; 2], Vec<TxOut>) {
        let coins = [
            explicit_coin(policy_asset(), 100_000),
            confidential_coin(asset(0xbb), 10_000),
        ];
        let collateral = random_pinned(asset(0xbb), 10_000);
        let principal = random_pinned(policy_asset(), 30_000);
        let recipient = lift_lending_key(&lender().x_only_public_key());
        let (mut pset, input_secrets) = pset(
            &coins,
            vec![
                blinded_output(script(1), collateral.amount, collateral.asset_id, recipient),
                blinded_output(script(2), principal.amount, principal.asset_id, recipient),
                blinded_output(script(3), 69_500, policy_asset(), change_blinding_key()),
                fee_output(500),
            ],
        );
        let pinned = [collateral, principal];
        let blindings: Vec<_> = pinned
            .iter()
            .enumerate()
            .map(|(output_index, pinned)| PinnedBlinding {
                output_index,
                pinned: *pinned,
                ephemeral_sk: None,
                extra_data: Vec::new(),
            })
            .collect();

        blind_pset(&mut pset, &input_secrets, &blindings, &mut thread_rng()).unwrap();

        (pset, pinned, coins.map(|(txout, _)| txout).to_vec())
    }

    #[test]
    fn pinned_output_rewinds_with_extra_data() {
        assert_pinned_output_rewinds(explicit_coin(policy_asset(), 100_000));
    }

    #[test]
    fn pinned_outputs_carry_blind_proofs() {
        let (pset, _, _) = blinded_two_pinned();

        let blinded: Vec<_> = pset
            .outputs()
            .iter()
            .filter(|output| output.blinding_key.is_some())
            .collect();
        assert_eq!(blinded.len(), 3);
        for output in blinded {
            let (asset_id, amount) = (output.asset.unwrap(), output.amount.unwrap());
            let asset_comm = output.asset_comm.unwrap();
            let amount_comm = output.amount_comm.unwrap();

            let value_proof = output.blind_value_proof.as_ref().unwrap();
            assert!(value_proof.blind_value_proof_verify(
                SECP256K1,
                amount,
                asset_comm,
                amount_comm
            ));
            let asset_proof = output.blind_asset_proof.as_ref().unwrap();
            assert!(asset_proof.blind_asset_proof_verify(SECP256K1, asset_id, asset_comm));
        }
    }

    #[test]
    fn blinded_transaction_balances() {
        let (pset, pinned, spent) = blinded_two_pinned();
        let tx = pset.extract_tx().unwrap();

        tx.verify_tx_amt_proofs(SECP256K1, &spent).unwrap();
        assert!(pinned[0].matches(&tx.output[0]));
        assert!(pinned[1].matches(&tx.output[1]));
    }

    #[test]
    fn duplicate_output_index_is_rejected() {
        let coin = explicit_coin(policy_asset(), 100_000);
        let pinned = random_pinned(policy_asset(), 60_000);
        let recipient = lift_lending_key(&lender().x_only_public_key());
        let (mut pset, input_secrets) = pset(
            std::slice::from_ref(&coin),
            vec![
                blinded_output(script(1), pinned.amount, pinned.asset_id, recipient),
                blinded_output(script(2), 39_500, policy_asset(), change_blinding_key()),
                fee_output(500),
            ],
        );
        let blinding = PinnedBlinding {
            output_index: 0,
            pinned,
            ephemeral_sk: None,
            extra_data: Vec::new(),
        };
        let unblinded = pset.clone();

        let result = blind_pset(
            &mut pset,
            &input_secrets,
            &[blinding.clone(), blinding],
            &mut thread_rng(),
        );

        assert!(matches!(result, Err(BlindPsetError::DuplicateOutput(0))));
        assert_eq!(pset, unblinded);
    }

    #[test]
    fn blind_pset_with_confidential_wallet_input() {
        assert_pinned_output_rewinds(confidential_coin(policy_asset(), 100_000));
    }
}
