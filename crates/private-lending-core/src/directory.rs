//! The lender directory's signed message: a lender puts or deletes a listing by signing a
//! single-use challenge from the indexer with their lending key. A put signs the display name and
//! the lender's terms together, so neither can be changed without the other.

use std::fmt;

use elements::secp256k1_zkp::{Keypair, Message, SECP256K1, XOnlyPublicKey, schnorr};

use crate::{LenderTerms, LenderTermsError, LendingKey, tagged_hash};

/// The tag of the directory message hash. Version 2 adds the name's length and the terms; a
/// version 1 signature no longer verifies.
pub const DIRECTORY_TAG: &str = "simplicity-lending/directory/v2";

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

/// Why a directory action was not signed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectorySignError {
    /// The display name is longer than `u16::MAX` bytes, the most its length field holds.
    NameTooLong,
    /// The terms are not ones [`LenderTerms::decode`] would accept.
    InvalidTerms(LenderTermsError),
}

impl fmt::Display for DirectorySignError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NameTooLong => write!(f, "the display name is longer than {} bytes", u16::MAX),
            Self::InvalidTerms(error) => write!(f, "invalid lender terms: {error}"),
        }
    }
}

impl std::error::Error for DirectorySignError {}

/// The message a directory signature signs: `tagged_hash("simplicity-lending/directory/v2",
/// action ‖ pubkey ‖ challenge ‖ name length ‖ display_name ‖ terms)`, with the action as one
/// byte, the x-only key serialized, the name's length in bytes as a big-endian `u16`, the name as
/// UTF-8 and the terms as [`LenderTerms::encode`] writes them (empty for `None`).
///
/// A put signs a name and `Some` terms; a delete signs an empty name and `None`. The length keeps
/// the name and the terms apart. A name longer than `u16::MAX` bytes is written with the length
/// `u16::MAX`: [`sign_directory_action`] refuses such a name and [`verify_directory_action`]
/// rejects it.
pub fn directory_message(
    action: DirectoryAction,
    pubkey: &XOnlyPublicKey,
    challenge: &[u8; 32],
    display_name: &str,
    terms: Option<&LenderTerms>,
) -> [u8; 32] {
    let name_length = u16::try_from(display_name.len()).unwrap_or(u16::MAX);
    let terms = terms.map(LenderTerms::encode).unwrap_or_default();
    tagged_hash(
        DIRECTORY_TAG,
        &[
            &[action.byte()],
            &pubkey.serialize(),
            challenge,
            &name_length.to_be_bytes(),
            display_name.as_bytes(),
            &terms,
        ],
    )
}

/// Signs a directory action with the lending key, with random auxiliary data.
///
/// Refuses a name longer than `u16::MAX` bytes and terms that [`LenderTerms::validate`] rejects,
/// since [`LenderTerms::encode`] writes invalid terms as they are. Which actions take a name and
/// terms is the caller's rule, as [`directory_message`] gives it. The auxiliary data comes from
/// `rand`'s thread RNG, as in [`crate::SignedTerms::sign`].
pub fn sign_directory_action(
    key: &LendingKey,
    action: DirectoryAction,
    challenge: &[u8; 32],
    display_name: &str,
    terms: Option<&LenderTerms>,
) -> Result<schnorr::Signature, DirectorySignError> {
    if display_name.len() > usize::from(u16::MAX) {
        return Err(DirectorySignError::NameTooLong);
    }
    if let Some(terms) = terms {
        terms.validate().map_err(DirectorySignError::InvalidTerms)?;
    }
    let message = Message::from_digest(directory_message(
        action,
        &key.x_only_public_key(),
        challenge,
        display_name,
        terms,
    ));
    let keypair = Keypair::from_secret_key(SECP256K1, &key.secret_key());

    Ok(SECP256K1.sign_schnorr_with_aux_rand(&message, &keypair, &rand::random()))
}

/// Checks that `pubkey` signed the directory action for this challenge, name and terms.
///
/// The terms are not validated, as the caller checks them on their own; any terms give an answer.
/// A name longer than `u16::MAX` bytes is rejected.
pub fn verify_directory_action(
    pubkey: &XOnlyPublicKey,
    action: DirectoryAction,
    challenge: &[u8; 32],
    display_name: &str,
    terms: Option<&LenderTerms>,
    signature: &schnorr::Signature,
) -> bool {
    if display_name.len() > usize::from(u16::MAX) {
        return false;
    }
    let message = Message::from_digest(directory_message(
        action,
        pubkey,
        challenge,
        display_name,
        terms,
    ));

    SECP256K1
        .verify_schnorr(signature, &message, pubkey)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use elements::AssetId;
    use elements::hex::ToHex;

    use super::*;
    use crate::test_util::sequence;
    use crate::{LenderTermsError, PairTerms};

    const CHALLENGE: [u8; 32] = [0x5c; 32];

    /// One pair whose every field has distinct bytes, all below `0x80`, so its encoding is also
    /// a UTF-8 string.
    fn known_answer_terms() -> LenderTerms {
        LenderTerms {
            pairs: vec![PairTerms {
                principal_asset: AssetId::from_slice(&sequence(0x00)).unwrap(),
                collateral_asset: AssetId::from_slice(&sequence(0x20)).unwrap(),
                min_apr_bps: 0x0102_0304,
                max_principal_per_collateral: 0x1112_1314_1516_1718,
                min_term_days: 7,
                max_term_days: 3650,
                min_principal: 0x2122_2324_2526_2728,
                max_principal: 0x3132_3334_3536_3738,
            }],
        }
    }

    #[test]
    fn signature_verifies_for_its_action_key_challenge_name_and_terms() {
        let key = LendingKey::from_master_blinding_key(&[1; 32]);
        let pk = key.x_only_public_key();
        let terms = known_answer_terms();
        let sig = sign_directory_action(
            &key,
            DirectoryAction::Put,
            &CHALLENGE,
            "Acme Bank",
            Some(&terms),
        )
        .unwrap();
        let verify = |pubkey, action, challenge, name, terms| {
            verify_directory_action(pubkey, action, challenge, name, terms, &sig)
        };
        let (put, delete) = (DirectoryAction::Put, DirectoryAction::Delete);
        assert!(verify(&pk, put, &CHALLENGE, "Acme Bank", Some(&terms)));

        // one byte of the terms' encoding changed
        let mut changed = terms.clone();
        changed.pairs[0].max_principal_per_collateral += 1;
        let (old, new) = (terms.encode(), changed.encode());
        assert_eq!(old.iter().zip(&new).filter(|(a, b)| a != b).count(), 1);
        // terms that no decode accepts give an answer, not a panic
        let empty = LenderTerms { pairs: vec![] };
        let many = LenderTerms {
            pairs: vec![terms.pairs[0]; 300],
        };
        let other = LendingKey::from_master_blinding_key(&[2; 32]).x_only_public_key();

        let rejected = [
            (&pk, delete, &CHALLENGE, "Acme Bank", Some(&terms)),
            (&pk, put, &[0x5d; 32], "Acme Bank", Some(&terms)),
            (&pk, put, &CHALLENGE, "Acme Bank ", Some(&terms)),
            (&pk, put, &CHALLENGE, "Acme Bank", None),
            (&pk, put, &CHALLENGE, "Acme Bank", Some(&changed)),
            (&pk, put, &CHALLENGE, "Acme Bank", Some(&empty)),
            (&pk, put, &CHALLENGE, "Acme Bank", Some(&many)),
            (&other, put, &CHALLENGE, "Acme Bank", Some(&terms)),
        ];
        for (pubkey, action, challenge, name, terms) in rejected {
            assert!(
                !verify(pubkey, action, challenge, name, terms),
                "{action:?} {name:?}"
            );
        }

        // a delete signs an empty name and no terms
        let sig =
            sign_directory_action(&key, DirectoryAction::Delete, &CHALLENGE, "", None).unwrap();
        assert!(verify_directory_action(
            &pk,
            DirectoryAction::Delete,
            &CHALLENGE,
            "",
            None,
            &sig
        ));
        assert!(!verify_directory_action(
            &pk,
            DirectoryAction::Put,
            &CHALLENGE,
            "",
            None,
            &sig
        ));
    }

    /// A version 1 signature over the same action, key, challenge and name no longer verifies.
    #[test]
    fn version_1_signature_is_rejected() {
        let key = LendingKey::from_master_blinding_key(&[1; 32]);
        let pk = key.x_only_public_key();
        let keypair = Keypair::from_secret_key(SECP256K1, &key.secret_key());
        let v1 = |action: DirectoryAction, name: &str| {
            let digest = tagged_hash(
                "simplicity-lending/directory/v1",
                &[
                    &[action.byte()],
                    &pk.serialize(),
                    &CHALLENGE,
                    name.as_bytes(),
                ],
            );
            SECP256K1.sign_schnorr_with_aux_rand(&Message::from_digest(digest), &keypair, &[0; 32])
        };

        let put = v1(DirectoryAction::Put, "Acme Bank");
        assert!(!verify_directory_action(
            &pk,
            DirectoryAction::Put,
            &CHALLENGE,
            "Acme Bank",
            None,
            &put
        ));
        assert!(!verify_directory_action(
            &pk,
            DirectoryAction::Put,
            &CHALLENGE,
            "Acme Bank",
            Some(&known_answer_terms()),
            &put
        ));
        let delete = v1(DirectoryAction::Delete, "");
        assert!(!verify_directory_action(
            &pk,
            DirectoryAction::Delete,
            &CHALLENGE,
            "",
            None,
            &delete
        ));
    }

    /// The name's length keeps the name and the terms apart: the name followed by the terms'
    /// encoding, with no terms, is another message.
    #[test]
    fn name_and_terms_do_not_run_together() {
        let pk = LendingKey::from_master_blinding_key(&[1; 32]).x_only_public_key();
        let terms = known_answer_terms();
        let joined = String::from_utf8([b"Acme".as_slice(), &terms.encode()].concat()).unwrap();
        assert_ne!(
            directory_message(DirectoryAction::Put, &pk, &CHALLENGE, "Acme", Some(&terms)),
            directory_message(DirectoryAction::Put, &pk, &CHALLENGE, &joined, None)
        );
    }

    #[test]
    fn signing_refuses_invalid_terms_and_long_names() {
        let key = LendingKey::from_master_blinding_key(&[1; 32]);
        let sign = |name: &str, terms: &LenderTerms| {
            sign_directory_action(&key, DirectoryAction::Put, &CHALLENGE, name, Some(terms))
        };
        let valid = known_answer_terms();
        let pair = valid.pairs[0];

        let invalid = [
            (
                LenderTerms { pairs: vec![] },
                LenderTermsError::BadPairCount(0),
            ),
            (
                LenderTerms {
                    pairs: vec![pair; 9],
                },
                LenderTermsError::BadPairCount(9),
            ),
            (
                LenderTerms {
                    pairs: vec![
                        pair,
                        PairTerms {
                            min_apr_bps: 0,
                            ..pair
                        },
                    ],
                },
                LenderTermsError::DuplicatePair,
            ),
            (
                LenderTerms {
                    pairs: vec![PairTerms {
                        min_principal: 0,
                        ..pair
                    }],
                },
                LenderTermsError::BadPrincipalRange,
            ),
        ];
        for (terms, error) in invalid {
            assert_eq!(
                sign("Acme Bank", &terms),
                Err(DirectorySignError::InvalidTerms(error))
            );
        }

        let longest = "a".repeat(usize::from(u16::MAX));
        assert!(sign(&longest, &valid).is_ok());
        let too_long = "a".repeat(usize::from(u16::MAX) + 1);
        assert_eq!(
            sign(&too_long, &valid),
            Err(DirectorySignError::NameTooLong)
        );

        // a name too long for its length field could run into the terms, so verify rejects it
        let pk = key.x_only_public_key();
        let run_on = String::from_utf8([longest.as_bytes(), &valid.encode()].concat()).unwrap();
        assert_eq!(
            directory_message(
                DirectoryAction::Put,
                &pk,
                &CHALLENGE,
                &longest,
                Some(&valid)
            ),
            directory_message(DirectoryAction::Put, &pk, &CHALLENGE, &run_on, None)
        );
        let sig = sign(&longest, &valid).unwrap();
        assert!(verify_directory_action(
            &pk,
            DirectoryAction::Put,
            &CHALLENGE,
            &longest,
            Some(&valid),
            &sig
        ));
        assert!(!verify_directory_action(
            &pk,
            DirectoryAction::Put,
            &CHALLENGE,
            &run_on,
            None,
            &sig
        ));
    }

    /// Frozen like part A's vectors: a change of tag, action byte, field order, the name's length
    /// or the terms' encoding fails. Checked against an independent computation of the tagged
    /// hash over the bytes the documentation of [`directory_message`] lists.
    #[test]
    fn directory_message_known_answer() {
        let pk = LendingKey::from_master_blinding_key(&[1; 32]).x_only_public_key();
        let terms = known_answer_terms();
        assert_eq!(
            directory_message(
                DirectoryAction::Put,
                &pk,
                &CHALLENGE,
                "Acme Bank",
                Some(&terms)
            )
            .to_hex(),
            "cf978d67cfb1135b7d261d2baef750edfd90e07e4db3ddb9a48ccde2c30f659b"
        );
        assert_eq!(
            directory_message(DirectoryAction::Delete, &pk, &CHALLENGE, "", None).to_hex(),
            "3639cfb10d0e74a5fcbd208c5826f648caf70eaa0150c2476778b0b39d9886e0"
        );
    }

    const FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/scripts/fixtures/directory-parity.json"
    );

    /// A directory entry as the indexer serves it, without its timestamps: the terms in the JSON
    /// the wasm takes (u64 amounts as decimal strings, u32 fields as numbers) and the put's
    /// challenge and signature.
    fn entry_json(
        pubkey: &XOnlyPublicKey,
        name: &str,
        terms: &LenderTerms,
        signature: &str,
    ) -> serde_json::Value {
        let pairs = terms
            .pairs
            .iter()
            .map(|pair| {
                serde_json::json!({
                    "principal_asset": pair.principal_asset.to_string(),
                    "collateral_asset": pair.collateral_asset.to_string(),
                    "min_apr_bps": pair.min_apr_bps,
                    "max_principal_per_collateral": pair.max_principal_per_collateral.to_string(),
                    "min_term_days": pair.min_term_days,
                    "max_term_days": pair.max_term_days,
                    "min_principal": pair.min_principal.to_string(),
                    "max_principal": pair.max_principal.to_string(),
                })
            })
            .collect::<Vec<_>>();
        serde_json::json!({
            "pubkey": pubkey.serialize().to_hex(),
            "display_name": name,
            "terms": { "pairs": pairs },
            "signed_challenge": CHALLENGE.to_hex(),
            "signature": signature,
        })
    }

    /// The entry the web's parity check verifies with the wasm (`verifyDirectoryEntry`). Its name
    /// is not ASCII, so its length in bytes differs from its length in characters. Signatures take
    /// random auxiliary data, so the fixture is written once, with
    /// `WRITE_DIRECTORY_FIXTURE=1 cargo test -p private-lending-core directory_parity_entry`, then
    /// `pnpm exec prettier --write scripts/fixtures/directory-parity.json` in `web`; otherwise the
    /// test checks that the fixture's entry is this one and that its signature verifies.
    #[test]
    fn directory_parity_entry() {
        let key = LendingKey::from_master_blinding_key(&[1; 32]);
        let pk = key.x_only_public_key();
        let name = "Acme Bank — Zürich";
        let terms = known_answer_terms();
        let description = concat!(
            "A lender directory entry signed by private-lending-core, as the indexer serves it ",
            "without its timestamps. Written by the directory_parity_entry test in directory.rs.",
        );

        if std::env::var_os("WRITE_DIRECTORY_FIXTURE").is_some() {
            let signature =
                sign_directory_action(&key, DirectoryAction::Put, &CHALLENGE, name, Some(&terms))
                    .unwrap();
            let fixture = serde_json::json!({
                "description": description,
                "entry": entry_json(&pk, name, &terms, &signature.serialize().to_hex()),
            });
            let text = serde_json::to_string_pretty(&fixture).unwrap() + "\n";
            std::fs::write(FIXTURE_PATH, text).unwrap();
            return;
        }

        let text = std::fs::read_to_string(FIXTURE_PATH).unwrap();
        let written: serde_json::Value = serde_json::from_str(&text).unwrap();
        let signature_hex = written["entry"]["signature"].as_str().unwrap();
        let fixture = serde_json::json!({
            "description": description,
            "entry": entry_json(&pk, name, &terms, signature_hex),
        });
        assert_eq!(
            written, fixture,
            "the fixture is stale; regenerate it as this test's documentation says"
        );
        let signature: schnorr::Signature = signature_hex.parse().unwrap();
        assert!(verify_directory_action(
            &pk,
            DirectoryAction::Put,
            &CHALLENGE,
            name,
            Some(&terms),
            &signature
        ));
    }
}
