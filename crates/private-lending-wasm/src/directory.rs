//! Signing lender directory actions.

use private_lending_core::{DirectoryAction as CoreDirectoryAction, sign_directory_action as sign};
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
