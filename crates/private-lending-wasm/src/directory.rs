//! Signing lender directory actions.

use private_lending_core::{DirectoryAction as CoreDirectoryAction, sign_directory_action as sign};
use wasm_bindgen::prelude::*;

use crate::error::{bad_input, decode_hex_array, encode_hex};
use crate::keys::LendingKey;

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

/// Signs a directory action for the server's 32-byte challenge (hex) and the display name; returns
/// the 64-byte Schnorr signature as hex.
#[wasm_bindgen(js_name = signDirectoryAction)]
pub fn sign_directory_action(
    key: &LendingKey,
    action: DirectoryAction,
    challenge_hex: &str,
    display_name: &str,
) -> Result<String, String> {
    if action == DirectoryAction::Delete && !display_name.is_empty() {
        return Err(bad_input(
            "a delete is signed over an empty name, as the indexer verifies it",
        ));
    }
    let challenge = decode_hex_array::<32>(challenge_hex)?;
    let signature = sign(key.inner(), action.into(), &challenge, display_name);
    Ok(encode_hex(signature.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::decode_hex_array;
    use crate::keys::LendingKey;
    use elements::secp256k1_zkp::{XOnlyPublicKey, schnorr};

    #[test]
    fn directory_signature_verifies() {
        let key = LendingKey::from_master_blinding_key(&"07".repeat(32)).unwrap();
        let challenge = [0x5a; 32];
        let challenge_hex = crate::error::encode_hex(&challenge);

        let signature =
            sign_directory_action(&key, DirectoryAction::Put, &challenge_hex, "Acme Bank").unwrap();

        let signature =
            schnorr::Signature::from_slice(&decode_hex_array::<64>(&signature).unwrap()).unwrap();
        let pubkey =
            XOnlyPublicKey::from_slice(&decode_hex_array::<32>(&key.x_only_public_key()).unwrap())
                .unwrap();
        assert!(private_lending_core::verify_directory_action(
            &pubkey,
            private_lending_core::DirectoryAction::Put,
            &challenge,
            "Acme Bank",
            &signature
        ));
        assert!(!private_lending_core::verify_directory_action(
            &pubkey,
            private_lending_core::DirectoryAction::Delete,
            &challenge,
            "Acme Bank",
            &signature
        ));
    }

    #[test]
    fn bad_challenge_is_rejected() {
        let key = LendingKey::from_master_blinding_key(&"07".repeat(32)).unwrap();
        let error = sign_directory_action(&key, DirectoryAction::Put, "abcd", "Acme").unwrap_err();
        assert!(error.starts_with("bad-input:"), "{error}");
    }

    #[test]
    fn delete_with_a_name_is_bad_input() {
        let key = LendingKey::from_master_blinding_key(&"07".repeat(32)).unwrap();
        let challenge_hex = crate::error::encode_hex(&[0x5a; 32]);
        let error = sign_directory_action(&key, DirectoryAction::Delete, &challenge_hex, "Acme")
            .unwrap_err();
        assert!(error.starts_with("bad-input:"), "{error}");
        assert!(sign_directory_action(&key, DirectoryAction::Delete, &challenge_hex, "").is_ok());
    }
}
