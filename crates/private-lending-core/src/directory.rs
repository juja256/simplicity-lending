//! The lender directory's signed message: a lender puts or deletes a listing by signing a
//! single-use challenge from the indexer with their lending key.

use elements::secp256k1_zkp::{Keypair, Message, SECP256K1, XOnlyPublicKey, schnorr};

use crate::{LendingKey, tagged_hash};

/// The tag of the directory message hash.
pub const DIRECTORY_TAG: &str = "simplicity-lending/directory/v1";

/// What a directory signature authorizes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectoryAction {
    /// Create or replace the lender's listing.
    Put,
    /// Remove the lender's listing.
    Delete,
}

impl DirectoryAction {
    /// The action's byte in the signed message: `1` for put, `2` for delete.
    pub fn byte(self) -> u8 {
        match self {
            Self::Put => 1,
            Self::Delete => 2,
        }
    }
}

/// The message a directory signature signs: `tagged_hash("simplicity-lending/directory/v1",
/// action ‖ pubkey ‖ challenge ‖ display_name)`, with the action as one byte, the x-only key
/// serialized and the name as UTF-8 (empty for delete).
pub fn directory_message(
    action: DirectoryAction,
    pubkey: &XOnlyPublicKey,
    challenge: &[u8; 32],
    display_name: &str,
) -> [u8; 32] {
    tagged_hash(
        DIRECTORY_TAG,
        &[
            &[action.byte()],
            &pubkey.serialize(),
            challenge,
            display_name.as_bytes(),
        ],
    )
}

/// Signs a directory action with the lending key, with random auxiliary data.
///
/// The auxiliary data comes from `rand`'s thread RNG, as in [`crate::SignedTerms::sign`].
pub fn sign_directory_action(
    key: &LendingKey,
    action: DirectoryAction,
    challenge: &[u8; 32],
    display_name: &str,
) -> schnorr::Signature {
    let message = Message::from_digest(directory_message(
        action,
        &key.x_only_public_key(),
        challenge,
        display_name,
    ));
    let keypair = Keypair::from_secret_key(SECP256K1, &key.secret_key());

    SECP256K1.sign_schnorr_with_aux_rand(&message, &keypair, &rand::random())
}

/// Checks that `pubkey` signed the directory action for this challenge and name.
pub fn verify_directory_action(
    pubkey: &XOnlyPublicKey,
    action: DirectoryAction,
    challenge: &[u8; 32],
    display_name: &str,
    signature: &schnorr::Signature,
) -> bool {
    let message = Message::from_digest(directory_message(action, pubkey, challenge, display_name));

    SECP256K1
        .verify_schnorr(signature, &message, pubkey)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use elements::hex::ToHex;

    use super::*;

    const CHALLENGE: [u8; 32] = [0x5c; 32];

    #[test]
    fn signature_verifies_for_its_action_key_challenge_and_name() {
        let key = LendingKey::from_master_blinding_key(&[1; 32]);
        let pk = key.x_only_public_key();
        let sig = sign_directory_action(&key, DirectoryAction::Put, &CHALLENGE, "Acme Bank");
        assert!(verify_directory_action(
            &pk,
            DirectoryAction::Put,
            &CHALLENGE,
            "Acme Bank",
            &sig
        ));
        assert!(!verify_directory_action(
            &pk,
            DirectoryAction::Delete,
            &CHALLENGE,
            "Acme Bank",
            &sig
        ));
        assert!(!verify_directory_action(
            &pk,
            DirectoryAction::Put,
            &[0x5d; 32],
            "Acme Bank",
            &sig
        ));
        assert!(!verify_directory_action(
            &pk,
            DirectoryAction::Put,
            &CHALLENGE,
            "Acme Bank ",
            &sig
        ));
        let other = LendingKey::from_master_blinding_key(&[2; 32]).x_only_public_key();
        assert!(!verify_directory_action(
            &other,
            DirectoryAction::Put,
            &CHALLENGE,
            "Acme Bank",
            &sig
        ));
    }

    /// Frozen like part A's vectors: a change of tag, action byte or field order fails.
    #[test]
    fn directory_message_known_answer() {
        let pk = LendingKey::from_master_blinding_key(&[1; 32]).x_only_public_key();
        assert_eq!(
            directory_message(DirectoryAction::Put, &pk, &CHALLENGE, "Acme Bank").to_hex(),
            "37c926ac9b518f3fe9e2c464b41d41ca4bda43475f7dd405d1af398a5764935c"
        );
        assert_eq!(
            directory_message(DirectoryAction::Delete, &pk, &CHALLENGE, "").to_hex(),
            "53c1a6c4455d33851cdf9120d0af95c2e8b5eec23565693631780d8c6328cc27"
        );
    }
}
