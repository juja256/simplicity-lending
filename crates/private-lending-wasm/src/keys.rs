//! Lending keys in the browser.

use elements::secp256k1_zkp::{PublicKey, Secp256k1, XOnlyPublicKey};
use elements::{Address, AddressParams, Script};
use private_lending_core::{
    LendingKey as CoreLendingKey, lift_lending_key as core_lift, tagged_hash,
};
use rand::thread_rng;
use wasm_bindgen::prelude::*;

use crate::error::{bad_input, decode_hex, decode_hex_array, encode_hex};

const FINGERPRINT_TAG: &str = "simplicity-lending/lending-key-fingerprint/v1";

/// A user's lending key, derived from the wallet's SLIP-77 master blinding key.
#[wasm_bindgen]
pub struct LendingKey(CoreLendingKey);

#[wasm_bindgen]
impl LendingKey {
    /// The lending key of a confidential descriptor: the master blinding key in its
    /// `slip77(<64 hex>)`.
    #[wasm_bindgen(js_name = fromDescriptor)]
    pub fn from_descriptor(descriptor: &str) -> Result<LendingKey, String> {
        const OPEN: &str = "slip77(";
        let start = descriptor
            .find(OPEN)
            .ok_or_else(|| bad_input("the descriptor has no slip77(...) key"))?
            + OPEN.len();
        let key = descriptor
            .get(start..start + 64)
            .filter(|_| descriptor[start + 64..].starts_with(')'))
            .ok_or_else(|| bad_input("slip77 must hold 64 hex characters"))?;
        Self::from_master_blinding_key(key)
    }

    /// The lending key of a master blinding key given as 64 hex characters.
    #[wasm_bindgen(js_name = fromMasterBlindingKey)]
    pub fn from_master_blinding_key(hex: &str) -> Result<LendingKey, String> {
        let mbk = decode_hex_array::<32>(hex)?;
        Ok(LendingKey(CoreLendingKey::from_master_blinding_key(&mbk)))
    }

    /// The x-only public key, 64 hex characters.
    #[wasm_bindgen(js_name = xOnlyPublicKey)]
    pub fn x_only_public_key(&self) -> String {
        encode_hex(&self.0.x_only_public_key().serialize())
    }

    /// A short identifier of the key, 16 hex characters.
    pub fn fingerprint(&self) -> String {
        fingerprint(&self.0.x_only_public_key().serialize())
    }

    pub(crate) fn inner(&self) -> &CoreLendingKey {
        &self.0
    }
}

/// The fingerprint of an x-only public key given as 64 hex characters.
/// The 33-byte compressed public key (hex) of an x-only lending key, the point with even Y. It is
/// the blinding key of outputs addressed to that lending key.
#[wasm_bindgen(js_name = liftLendingKey)]
pub fn lift_lending_key(x_only_hex: &str) -> Result<String, String> {
    let key = XOnlyPublicKey::from_slice(&decode_hex_array::<32>(x_only_hex)?)
        .map_err(|e| bad_input(format!("not an x-only public key: {e}")))?;
    Ok(encode_hex(&core_lift(&key).serialize()))
}

#[wasm_bindgen(js_name = keyFingerprint)]
pub fn key_fingerprint(x_only_hex: &str) -> Result<String, String> {
    Ok(fingerprint(&decode_hex_array::<32>(x_only_hex)?))
}

/// The confidential address of a script (hex) with the blinding key (33-byte compressed key, hex)
/// on a `network`: `liquid`, `liquidtestnet` or `regtest`. LWK cannot build one with a chosen
/// blinding key. `bad-input` for a script with no address form.
#[wasm_bindgen(js_name = confidentialAddress)]
pub fn confidential_address(
    script_pubkey_hex: &str,
    blinding_key_hex: &str,
    network: &str,
) -> Result<String, String> {
    let params: &'static AddressParams = match network {
        "liquid" => &AddressParams::LIQUID,
        "liquidtestnet" => &AddressParams::LIQUID_TESTNET,
        "regtest" => &AddressParams::ELEMENTS,
        other => return Err(bad_input(format!("unknown network {other:?}"))),
    };
    let script = Script::from(decode_hex(script_pubkey_hex)?);
    let blinding_key = decode_hex_array::<33>(blinding_key_hex)?;
    let blinding_key = PublicKey::from_slice(&blinding_key)
        .map_err(|e| bad_input(format!("not a public key: {e}")))?;
    Address::from_script(&script, Some(blinding_key), params)
        .map(|address| address.to_string())
        .ok_or_else(|| bad_input("the script has no address form"))
}

/// A random compressed public key (hex). Its only use is fresh issuance entropy in an asset
/// contract's `issuer_pubkey`; the secret is discarded.
#[wasm_bindgen(js_name = freshIssuerPubkey)]
pub fn fresh_issuer_pubkey() -> String {
    let (_, public) = Secp256k1::new().generate_keypair(&mut thread_rng());
    encode_hex(&public.serialize())
}

fn fingerprint(x_only: &[u8; 32]) -> String {
    encode_hex(&tagged_hash(FINGERPRINT_TAG, &[x_only])[..8])
}

#[cfg(test)]
mod tests {
    use super::*;
    use elements::{Address, AddressParams, Script};
    use std::str::FromStr;

    #[test]
    fn confidential_address_round_trips() {
        let script = Script::from(
            vec![0x51, 0x20]
                .into_iter()
                .chain([7; 32])
                .collect::<Vec<_>>(),
        );
        let key = lift_lending_key(
            &LendingKey::from_master_blinding_key(&encode_hex(&[1; 32]))
                .unwrap()
                .x_only_public_key(),
        )
        .unwrap();
        for (network, params) in [
            ("liquid", &AddressParams::LIQUID),
            ("liquidtestnet", &AddressParams::LIQUID_TESTNET),
            ("regtest", &AddressParams::ELEMENTS),
        ] {
            let address =
                confidential_address(&encode_hex(script.as_bytes()), &key, network).unwrap();
            let parsed = Address::from_str(&address).unwrap();
            assert_eq!(parsed.script_pubkey(), script);
            assert_eq!(
                encode_hex(&parsed.blinding_pubkey.unwrap().serialize()),
                key
            );
            assert_eq!(parsed.params, params);
        }
    }

    #[test]
    fn fresh_issuer_pubkeys_differ() {
        let (a, b) = (fresh_issuer_pubkey(), fresh_issuer_pubkey());
        assert_eq!(a.len(), 66);
        assert_ne!(a, b);
    }

    #[test]
    fn bad_address_inputs_are_rejected() {
        let script = format!("5120{}", "07".repeat(32));
        let key = lift_lending_key(
            &LendingKey::from_master_blinding_key(&encode_hex(&[1; 32]))
                .unwrap()
                .x_only_public_key(),
        )
        .unwrap();
        let cases = [
            confidential_address("zz", &key, "liquid"),
            confidential_address(&script, &key, "mainnet"),
            confidential_address(&script, "02", "liquid"),
            confidential_address(&script, &format!("04{}", "11".repeat(64)), "liquid"),
            // OP_RETURN has no address form.
            confidential_address("6a", &key, "liquid"),
        ];
        for case in cases {
            let error = case.unwrap_err();
            assert!(error.starts_with("bad-input:"), "{error}");
        }
    }

    #[test]
    fn lending_key_from_descriptor_equals_the_master_blinding_key_derivation() {
        let descriptor = format!(
            "ct(slip77({}),elwpkh([d0c0ffee/84h/1h/0h]tpubD6NzVbkrYhZ4Y/<0;1>/*))#abcd1234",
            encode_hex(&[7; 32])
        );
        let key = LendingKey::from_descriptor(&descriptor).unwrap();
        let expected = CoreLendingKey::from_master_blinding_key(&[7; 32]);
        assert_eq!(
            key.x_only_public_key(),
            encode_hex(&expected.x_only_public_key().serialize())
        );
    }

    #[test]
    fn descriptor_without_slip77_is_rejected() {
        let short = "ab".repeat(31) + "a";
        let cases = [
            format!("ct({},elwpkh(xpub/0/*))", "02".repeat(32)),
            "elwpkh(xpub/0/*)".to_string(),
            "ct(slip77(xyz),elwpkh(xpub/0/*))".to_string(),
            format!("ct(slip77({short}),elwpkh(xpub/0/*))"),
        ];
        for case in cases {
            let error = LendingKey::from_descriptor(&case).err().unwrap();
            assert!(error.starts_with("bad-input:"), "{case}: {error}");
        }
    }

    #[test]
    fn fingerprint_is_the_tagged_hash_prefix() {
        let key = LendingKey::from_master_blinding_key(&encode_hex(&[1; 32])).unwrap();
        assert!(key.x_only_public_key().starts_with("a9ddbd65"));
        assert!(key.x_only_public_key().ends_with("9762"));
        assert_eq!(key.fingerprint(), "1aa05299d34bb9f5");
        assert_eq!(
            key_fingerprint(&key.x_only_public_key()).unwrap(),
            "1aa05299d34bb9f5"
        );
    }
}
