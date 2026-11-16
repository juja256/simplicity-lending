//! Signing lender directory actions, and checking the entries the indexer serves.

use elements::secp256k1_zkp::{XOnlyPublicKey, schnorr};
use private_lending_core::{
    DirectoryAction as CoreDirectoryAction, sign_directory_action as sign, verify_directory_action,
};
use wasm_bindgen::prelude::*;

use crate::error::{bad_input, decode_hex_array, encode_hex};
use crate::keys::LendingKey;
use crate::lender_terms::parse_terms;

/// What a directory signature authorizes.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectoryAction {
    /// Create or replace the lender's listing.
    Put,
    /// Remove the lender's listing.
    Delete,
}

impl From<DirectoryAction> for CoreDirectoryAction {
    fn from(action: DirectoryAction) -> Self {
        match action {
            DirectoryAction::Put => CoreDirectoryAction::Put,
            DirectoryAction::Delete => CoreDirectoryAction::Delete,
        }
    }
}

/// Signs a directory action for the server's 32-byte challenge (hex), the display name and the
/// lender's terms (JSON, as `encodeLenderTerms` takes them); returns the 64-byte Schnorr signature
/// as hex.
///
/// A put signs a non-empty name and the terms together; a delete signs an empty name and no
/// terms, as the indexer verifies them. Anything else, and terms that `LenderTerms::validate`
/// rejects, is a `bad-input` error.
#[wasm_bindgen(js_name = signDirectoryAction)]
pub fn sign_directory_action(
    key: &LendingKey,
    action: DirectoryAction,
    challenge_hex: &str,
    display_name: &str,
    terms_json: Option<String>,
) -> Result<String, String> {
    let terms = match (action, terms_json) {
        (DirectoryAction::Put, Some(_)) if display_name.is_empty() => {
            return Err(bad_input("a put is signed over a display name"));
        }
        (DirectoryAction::Put, Some(json)) => Some(parse_terms(&json)?),
        (DirectoryAction::Put, None) => {
            return Err(bad_input("a put is signed over the lender's terms"));
        }
        (DirectoryAction::Delete, _) if !display_name.is_empty() => {
            return Err(bad_input(
                "a delete is signed over an empty name, as the indexer verifies it",
            ));
        }
        (DirectoryAction::Delete, Some(_)) => {
            return Err(bad_input(
                "a delete is signed over no terms, as the indexer verifies it",
            ));
        }
        (DirectoryAction::Delete, None) => None,
    };
    let challenge = decode_hex_array::<32>(challenge_hex)?;
    let signature = sign(
        key.inner(),
        action.into(),
        &challenge,
        display_name,
        terms.as_ref(),
    )
    .map_err(bad_input)?;
    Ok(encode_hex(signature.as_ref()))
}

/// Decodes exactly `N` bytes of hex; the error names the field.
fn field_hex<const N: usize>(field: &str, hex: &str) -> Result<[u8; N], String> {
    decode_hex_array::<N>(hex).map_err(|_| bad_input(format!("{field} is not {N} bytes of hex")))
}

/// Checks a served directory entry: whether the x-only key `pubkey_hex` signed a put for the
/// challenge (32 bytes, hex), the display name and the terms (JSON, as `encodeLenderTerms` takes
/// them), with the 64-byte Schnorr signature (hex).
///
/// Terms that do not parse or that `LenderTerms::validate` rejects give `false`, as no put the
/// indexer accepts carries them. Malformed hex, or a key that is not an x-only public key, is a
/// `bad-input` error naming the field.
#[wasm_bindgen(js_name = verifyDirectoryEntry)]
pub fn verify_directory_entry(
    pubkey_hex: &str,
    challenge_hex: &str,
    display_name: &str,
    terms_json: &str,
    signature_hex: &str,
) -> Result<bool, String> {
    let pubkey = XOnlyPublicKey::from_slice(&field_hex::<32>("pubkey", pubkey_hex)?)
        .map_err(|_| bad_input("pubkey is not an x-only public key"))?;
    let challenge = field_hex::<32>("challenge", challenge_hex)?;
    let signature = schnorr::Signature::from_slice(&field_hex::<64>("signature", signature_hex)?)
        .map_err(|_| bad_input("signature is not a Schnorr signature"))?;
    let Ok(terms) = parse_terms(terms_json) else {
        return Ok(false);
    };
    Ok(verify_directory_action(
        &pubkey,
        CoreDirectoryAction::Put,
        &challenge,
        display_name,
        Some(&terms),
        &signature,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{decode_hex_array, encode_hex};
    use crate::keys::LendingKey;
    use crate::lender_terms::{parse_terms, tests::terms_json};
    use elements::secp256k1_zkp::{XOnlyPublicKey, schnorr};
    use private_lending_core::{
        DirectoryAction as Core, LenderTerms, verify_directory_action as verify,
    };

    fn key() -> LendingKey {
        LendingKey::from_master_blinding_key(&"07".repeat(32)).unwrap()
    }

    fn challenge_hex() -> String {
        encode_hex(&[0x5a; 32])
    }

    /// Whether the signature verifies in the core for this action, name and terms.
    fn verifies(
        key: &LendingKey,
        signature: &str,
        action: Core,
        name: &str,
        terms: Option<&LenderTerms>,
    ) -> bool {
        let signature =
            schnorr::Signature::from_slice(&decode_hex_array::<64>(signature).unwrap()).unwrap();
        let pubkey =
            XOnlyPublicKey::from_slice(&decode_hex_array::<32>(&key.x_only_public_key()).unwrap())
                .unwrap();
        verify(&pubkey, action, &[0x5a; 32], name, terms, &signature)
    }

    #[test]
    fn put_signs_the_name_and_the_terms() {
        let key = key();
        let terms = parse_terms(&terms_json()).unwrap();
        let signature = sign_directory_action(
            &key,
            DirectoryAction::Put,
            &challenge_hex(),
            "Acme Bank",
            Some(terms_json()),
        )
        .unwrap();

        assert!(verifies(
            &key,
            &signature,
            Core::Put,
            "Acme Bank",
            Some(&terms)
        ));
        assert!(!verifies(&key, &signature, Core::Put, "Acme Bank", None));
        assert!(!verifies(
            &key,
            &signature,
            Core::Delete,
            "Acme Bank",
            Some(&terms)
        ));
        let mut other = terms.clone();
        other.pairs[0].min_apr_bps += 1;
        assert!(!verifies(
            &key,
            &signature,
            Core::Put,
            "Acme Bank",
            Some(&other)
        ));
    }

    #[test]
    fn delete_signs_an_empty_name_and_no_terms() {
        let key = key();
        let signature =
            sign_directory_action(&key, DirectoryAction::Delete, &challenge_hex(), "", None)
                .unwrap();
        assert!(verifies(&key, &signature, Core::Delete, "", None));
    }

    /// A put signed by `key` over the challenge, the name and the terms.
    fn signed_put(key: &LendingKey, name: &str, terms: &str) -> String {
        sign_directory_action(
            key,
            DirectoryAction::Put,
            &challenge_hex(),
            name,
            Some(terms.to_string()),
        )
        .unwrap()
    }

    #[test]
    fn verify_entry_accepts_signed_put() {
        let key = key();
        let signature = signed_put(&key, "Acme Bank", &terms_json());
        assert_eq!(
            verify_directory_entry(
                &key.x_only_public_key(),
                &challenge_hex(),
                "Acme Bank",
                &terms_json(),
                &signature,
            ),
            Ok(true)
        );
        // Hex of either case, as the other hex inputs take it.
        assert_eq!(
            verify_directory_entry(
                &key.x_only_public_key().to_uppercase(),
                &challenge_hex().to_uppercase(),
                "Acme Bank",
                &terms_json(),
                &signature.to_uppercase(),
            ),
            Ok(true)
        );
    }

    #[test]
    fn verify_entry_rejects_changed_terms_name_or_key() {
        let key = key();
        let signature = signed_put(&key, "Acme Bank", &terms_json());
        let verify = |pubkey: &str, name: &str, terms: &str| {
            verify_directory_entry(pubkey, &challenge_hex(), name, terms, &signature)
        };
        let pubkey = key.x_only_public_key();

        // One byte of the rate: the APR moves by 1 basis point.
        let mut terms: serde_json::Value = serde_json::from_str(&terms_json()).unwrap();
        let apr = terms["pairs"][0]["min_apr_bps"].as_u64().unwrap();
        terms["pairs"][0]["min_apr_bps"] = (apr + 1).into();
        assert_eq!(verify(&pubkey, "Acme Bank", &terms.to_string()), Ok(false));
        assert_eq!(verify(&pubkey, "Acme Bank Ltd", &terms_json()), Ok(false));
        let other = LendingKey::from_master_blinding_key(&"08".repeat(32)).unwrap();
        assert_eq!(
            verify(&other.x_only_public_key(), "Acme Bank", &terms_json()),
            Ok(false)
        );
        // Signed by another key, served under this one.
        let forged = signed_put(&other, "Acme Bank", &terms_json());
        assert_eq!(
            verify_directory_entry(
                &pubkey,
                &challenge_hex(),
                "Acme Bank",
                &terms_json(),
                &forged
            ),
            Ok(false)
        );
        // A signature over another challenge.
        assert_eq!(
            verify_directory_entry(
                &pubkey,
                &encode_hex(&[0x5b; 32]),
                "Acme Bank",
                &terms_json(),
                &signature
            ),
            Ok(false)
        );
    }

    #[test]
    fn verify_entry_gives_false_for_invalid_terms() {
        let key = key();
        let signature = signed_put(&key, "Acme Bank", &terms_json());
        let mut out_of_range: serde_json::Value = serde_json::from_str(&terms_json()).unwrap();
        out_of_range["pairs"][0]["max_term_days"] = 3651.into();
        for terms in [
            r#"{"pairs": []}"#.to_string(),
            out_of_range.to_string(),
            "not json".to_string(),
            r#"{"pairs": [], "version": 1}"#.to_string(),
        ] {
            assert_eq!(
                verify_directory_entry(
                    &key.x_only_public_key(),
                    &challenge_hex(),
                    "Acme Bank",
                    &terms,
                    &signature,
                ),
                Ok(false),
                "{terms}"
            );
        }
    }

    #[test]
    fn verify_entry_names_the_malformed_field() {
        let key = key();
        let pubkey = key.x_only_public_key();
        let signature = signed_put(&key, "Acme Bank", &terms_json());
        let challenge = challenge_hex();
        let verify = |pubkey: &str, challenge: &str, signature: &str| {
            verify_directory_entry(pubkey, challenge, "Acme Bank", &terms_json(), signature)
                .unwrap_err()
        };
        let cases = [
            (verify("zz", &challenge, &signature), "pubkey"),
            (verify(&pubkey[2..], &challenge, &signature), "pubkey"),
            // 32 bytes, but no point on the curve has this x.
            (verify(&"ff".repeat(32), &challenge, &signature), "pubkey"),
            (verify(&pubkey, "abc", &signature), "challenge"),
            (verify(&pubkey, &challenge[2..], &signature), "challenge"),
            (verify(&pubkey, &challenge, "xyz"), "signature"),
            (verify(&pubkey, &challenge, &signature[2..]), "signature"),
        ];
        for (error, field) in cases {
            assert!(error.starts_with("bad-input: "), "{error}");
            assert!(error.contains(field), "{field}: {error}");
        }
    }

    #[test]
    fn bad_challenge_is_rejected() {
        let error = sign_directory_action(
            &key(),
            DirectoryAction::Put,
            "abcd",
            "Acme",
            Some(terms_json()),
        )
        .unwrap_err();
        assert!(error.starts_with("bad-input:"), "{error}");
    }

    #[test]
    fn the_caller_rule_is_enforced() {
        let key = key();
        let sign = |action, name: &str, terms: Option<String>| {
            sign_directory_action(&key, action, &challenge_hex(), name, terms)
        };
        let refusals = [
            (
                "a put without terms",
                sign(DirectoryAction::Put, "Acme", None),
            ),
            (
                "a put without a name",
                sign(DirectoryAction::Put, "", Some(terms_json())),
            ),
            (
                "a put with invalid terms",
                sign(
                    DirectoryAction::Put,
                    "Acme",
                    Some(r#"{"pairs": []}"#.into()),
                ),
            ),
            (
                "a delete with a name",
                sign(DirectoryAction::Delete, "Acme", None),
            ),
            (
                "a delete with terms",
                sign(DirectoryAction::Delete, "", Some(terms_json())),
            ),
        ];
        for (what, result) in refusals {
            let error = result.unwrap_err();
            assert!(error.starts_with("bad-input:"), "{what}: {error}");
        }
    }
}
