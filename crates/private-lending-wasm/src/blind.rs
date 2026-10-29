//! Blinding PSETs: pinned outputs with their fixed blinding factors, the rest freshly.

use std::collections::HashMap;

use elements::confidential::{AssetBlindingFactor, ValueBlindingFactor};
use elements::pset::PartiallySignedTransaction;
use elements::{AssetId, TxOutSecrets};
use private_lending_core::PinnedBlinding as CorePinnedBlinding;
use wasm_bindgen::prelude::*;

use crate::error::bad_input;
use crate::open::{OpenedOffer, PinnedRole, pinned_output};
use crate::scan::parse;

/// How to blind one pinned output of a PSET: an opaque handle from [`NewOffer`](crate::NewOffer)
/// or [`OpenedOffer`].
#[wasm_bindgen]
pub struct PinnedBlinding(CorePinnedBlinding);

impl PinnedBlinding {
    pub(crate) fn from_core(blinding: CorePinnedBlinding) -> Self {
        Self(blinding)
    }
}

/// The secrets of one input of a PSET: its asset, amount and blinding factors.
#[wasm_bindgen]
pub struct InputSecret {
    pub(crate) index: usize,
    pub(crate) secrets: TxOutSecrets,
}

#[wasm_bindgen]
impl InputSecret {
    /// The secrets of a confidential input; the blinding factors are in the `Display` format of
    /// elements (big-endian hex), the same as LWK's `toString()`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        input_index: u32,
        asset: &str,
        asset_blinder: &str,
        value: u64,
        value_blinder: &str,
    ) -> Result<InputSecret, String> {
        Ok(Self {
            index: input_index as usize,
            secrets: TxOutSecrets::new(
                parse::<AssetId>("asset", asset)?,
                parse::<AssetBlindingFactor>("asset blinder", asset_blinder)?,
                value,
                parse::<ValueBlindingFactor>("value blinder", value_blinder)?,
            ),
        })
    }

    /// The secrets of an explicit input, whose blinding factors are zero.
    pub fn explicit(input_index: u32, asset: &str, value: u64) -> Result<InputSecret, String> {
        Ok(Self {
            index: input_index as usize,
            secrets: TxOutSecrets::new(
                parse::<AssetId>("asset", asset)?,
                AssetBlindingFactor::zero(),
                value,
                ValueBlindingFactor::zero(),
            ),
        })
    }
}

#[wasm_bindgen]
impl OpenedOffer {
    /// How to blind the output of `role` that a transaction at acceptance or repayment creates:
    /// a random ephemeral key and no extra data. The PSET output must carry the matching blinding
    /// key (`borrowerBlindingKey()` at acceptance). Only creation blinds the pending collateral,
    /// with the borrower's ephemeral key (`NewOffer.collateralBlinding`), so that role is
    /// `bad-input`.
    #[wasm_bindgen(js_name = pinnedBlinding)]
    pub fn pinned_blinding(
        &self,
        role: PinnedRole,
        output_index: u32,
    ) -> Result<PinnedBlinding, String> {
        if role == PinnedRole::PendingCollateral {
            return Err(bad_input(
                "the pending collateral is blinded only at creation, with NewOffer.collateralBlinding",
            ));
        }
        Ok(PinnedBlinding(CorePinnedBlinding {
            output_index: output_index as usize,
            pinned: *pinned_output(&self.inner().pinned, role),
            ephemeral_sk: None,
            extra_data: Vec::new(),
        }))
    }

    /// The secrets of the covenant input of `role`, which the PSET spends as `input_index`.
    #[wasm_bindgen(js_name = inputSecret)]
    pub fn input_secret(&self, role: PinnedRole, input_index: u32) -> InputSecret {
        InputSecret {
            index: input_index as usize,
            secrets: pinned_output(&self.inner().pinned, role).secrets(),
        }
    }
}

/// Blinds the PSET (base64): the pinned outputs with their fixed blinding factors, the other
/// outputs marked for blinding freshly. Returns the blinded PSET, base64.
///
/// This consumes the `InputSecret` and `PinnedBlinding` handles, even on error: create fresh ones
/// for every call. Issuance inputs must not be blinded (`blinded_issuance = 0`), or blinding
/// fails.
#[wasm_bindgen(js_name = blindPset)]
pub fn blind_pset(
    pset_base64: &str,
    input_secrets: Vec<InputSecret>,
    blindings: Vec<PinnedBlinding>,
) -> Result<String, String> {
    let mut pset: PartiallySignedTransaction = parse("PSET", pset_base64)?;
    let mut secrets = HashMap::new();
    for secret in input_secrets {
        if secrets.insert(secret.index, secret.secrets).is_some() {
            return Err(bad_input(format!("two secrets for input {}", secret.index)));
        }
    }
    let blindings: Vec<_> = blindings.into_iter().map(|b| b.0).collect();

    private_lending_core::blind_pset(&mut pset, &secrets, &blindings, &mut rand::thread_rng())
        .map_err(bad_input)?;
    Ok(pset.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::encode_hex;
    use elements::confidential::{self, AssetBlindingFactor, Nonce, ValueBlindingFactor};
    use elements::hashes::Hash;
    use elements::pset::{Input, Output, PartiallySignedTransaction};
    use elements::secp256k1_zkp::{PublicKey, SECP256K1, SecretKey};
    use elements::{AssetId, Script, TxOut, TxOutWitness, Txid, bitcoin};
    use private_lending_core::{LendingKey as CoreKey, PinnedOutput, lift_lending_key};
    use rand::thread_rng;

    fn asset(byte: u8) -> AssetId {
        AssetId::from_slice(&[byte; 32]).unwrap()
    }

    fn change_key() -> PublicKey {
        PublicKey::from_secret_key(SECP256K1, &SecretKey::from_slice(&[6; 32]).unwrap())
    }

    fn blinded_output(amount: u64, blinding_key: PublicKey) -> Output {
        let key = bitcoin::PublicKey::new(blinding_key);
        let mut output = Output::new_explicit(
            Script::from(vec![0x51, amount as u8]),
            amount,
            asset(0xaa),
            Some(key),
        );
        output.blinder_index = Some(0);
        output
    }

    #[test]
    fn blinding_with_display_format_secrets_balances() {
        let mut rng = thread_rng();
        let coin = PinnedOutput {
            asset_id: asset(0xaa),
            amount: 100_000,
            asset_blinding_factor: AssetBlindingFactor::new(&mut rng),
            value_blinding_factor: ValueBlindingFactor::new(&mut rng),
        };
        let txout = TxOut {
            asset: coin.asset_commitment(),
            value: coin.value_commitment(),
            nonce: Nonce::Confidential(change_key()),
            script_pubkey: Script::from(vec![0x51, 0xc1]),
            witness: TxOutWitness::default(),
        };
        let pinned = PinnedOutput {
            asset_id: asset(0xaa),
            amount: 60_000,
            asset_blinding_factor: AssetBlindingFactor::new(&mut rng),
            value_blinding_factor: ValueBlindingFactor::new(&mut rng),
        };

        let mut pset = PartiallySignedTransaction::new_v2();
        pset.add_input(Input {
            previous_txid: Txid::from_byte_array([1; 32]),
            previous_output_index: 0,
            witness_utxo: Some(txout.clone()),
            ..Default::default()
        });
        let recipient =
            lift_lending_key(&CoreKey::from_master_blinding_key(&[5; 32]).x_only_public_key());
        pset.add_output(blinded_output(60_000, recipient));
        pset.add_output(blinded_output(39_500, change_key()));
        pset.add_output(Output::new_explicit(Script::new(), 500, asset(0xaa), None));

        let secret = InputSecret::new(
            0,
            &coin.asset_id.to_string(),
            &coin.asset_blinding_factor.to_string(),
            coin.amount,
            &coin.value_blinding_factor.to_string(),
        )
        .unwrap();
        let blinding = PinnedBlinding::from_core(private_lending_core::PinnedBlinding {
            output_index: 0,
            pinned,
            ephemeral_sk: None,
            extra_data: Vec::new(),
        });

        let blinded = blind_pset(&pset.to_string(), vec![secret], vec![blinding]).unwrap();

        let tx = blinded
            .parse::<PartiallySignedTransaction>()
            .unwrap()
            .extract_tx()
            .unwrap();
        assert!(pinned.matches(&tx.output[0]));
        assert!(matches!(
            tx.output[1].value,
            confidential::Value::Confidential(_)
        ));
        tx.verify_tx_amt_proofs(SECP256K1, &[txout]).unwrap();
    }

    #[test]
    fn explicit_input_secret_has_zero_blinders() {
        let secret = InputSecret::explicit(3, &asset(0xaa).to_string(), 7).unwrap();
        assert_eq!(secret.index, 3);
        assert_eq!(secret.secrets.asset_bf, AssetBlindingFactor::zero());
        assert_eq!(secret.secrets.value_bf, ValueBlindingFactor::zero());
        assert_eq!(secret.secrets.value, 7);
    }

    #[test]
    fn bad_inputs_are_rejected() {
        let a = asset(0xaa).to_string();
        let good = encode_hex(&[1; 32]);
        let short = encode_hex(&[1; 31]);
        let errors = [
            blind_pset("not base64 !!", vec![], vec![]).err().unwrap(),
            InputSecret::new(0, &a, &short, 1, &good).err().unwrap(),
            InputSecret::new(0, &a, &good, 1, &short).err().unwrap(),
            InputSecret::explicit(0, "zz", 1).err().unwrap(),
        ];
        for error in errors {
            assert!(error.starts_with("bad-input:"), "{error}");
        }
    }

    #[test]
    fn blinding_for_an_acceptance_balances() {
        use crate::open::tests::{creation_hex, fixture, key_of, tx_of};
        use crate::open::{open_creation_as_borrower_hex, open_creation_as_lender_hex};

        let fixture = fixture();
        let hex = creation_hex(&fixture);
        let creation = tx_of(&hex);
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let borrower = key_of(&fixture, "borrower_master_blinding_key");
        let opened = open_creation_as_lender_hex(&lender, &hex).unwrap();
        assert_eq!(
            opened.borrower_blinding_key(),
            open_creation_as_borrower_hex(&borrower, &hex)
                .unwrap()
                .borrower_blinding_key()
        );
        let borrower_blinding_key = PublicKey::from_slice(
            &crate::error::decode_hex(&opened.borrower_blinding_key()).unwrap(),
        )
        .unwrap();

        let principal_asset: AssetId = opened.principal_asset().parse().unwrap();
        let collateral_asset: AssetId = opened.collateral_asset().parse().unwrap();
        let (principal, fee) = (opened.principal_amount(), 500);
        let wallet_amount = principal + 10_000;
        let wallet_txout = TxOut {
            asset: confidential::Asset::Explicit(principal_asset),
            value: confidential::Value::Explicit(wallet_amount),
            nonce: Nonce::Null,
            script_pubkey: Script::from(vec![0x51, 0x77]),
            witness: TxOutWitness::default(),
        };
        let covenant_txout = creation.output[3].clone();

        let mut pset = PartiallySignedTransaction::new_v2();
        pset.add_input(Input {
            previous_txid: creation.txid(),
            previous_output_index: 3,
            witness_utxo: Some(covenant_txout.clone()),
            ..Default::default()
        });
        pset.add_input(Input {
            previous_txid: Txid::from_byte_array([2; 32]),
            previous_output_index: 0,
            witness_utxo: Some(wallet_txout.clone()),
            ..Default::default()
        });
        let blinded = |amount: u64, asset_id: AssetId, key: PublicKey, tag: u8| {
            let mut output = Output::new_explicit(
                Script::from(vec![0x51, tag]),
                amount,
                asset_id,
                Some(bitcoin::PublicKey::new(key)),
            );
            output.blinder_index = Some(0);
            output
        };
        pset.add_output(blinded(
            opened.collateral_amount(),
            collateral_asset,
            borrower_blinding_key,
            1,
        ));
        pset.add_output(blinded(
            principal,
            principal_asset,
            borrower_blinding_key,
            2,
        ));
        pset.add_output(blinded(
            wallet_amount - principal - fee,
            principal_asset,
            change_key(),
            3,
        ));
        pset.add_output(Output::new_explicit(
            Script::new(),
            fee,
            principal_asset,
            None,
        ));

        let secrets = vec![
            opened.input_secret(PinnedRole::PendingCollateral, 0),
            InputSecret::explicit(1, &principal_asset.to_string(), wallet_amount).unwrap(),
        ];
        let blindings = vec![
            opened
                .pinned_blinding(PinnedRole::ActiveCollateral, 0)
                .unwrap(),
            opened.pinned_blinding(PinnedRole::Principal, 1).unwrap(),
        ];

        let blinded_pset = blind_pset(&pset.to_string(), secrets, blindings).unwrap();

        let tx = blinded_pset
            .parse::<PartiallySignedTransaction>()
            .unwrap()
            .extract_tx()
            .unwrap();
        let pinned = &opened.inner().pinned;
        assert!(pinned.active_collateral.matches(&tx.output[0]));
        assert!(pinned.principal.matches(&tx.output[1]));
        tx.verify_tx_amt_proofs(SECP256K1, &[covenant_txout, wallet_txout])
            .unwrap();
    }
}
