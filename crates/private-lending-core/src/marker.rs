//! The marker of an offer: the `OP_RETURN` payload of its creation transaction.

use elements::OutPoint;
use elements::hashes::Hash;
use elements::secp256k1_zkp::XOnlyPublicKey;

use crate::{LendingKey, OfferSecrets, tagged_hash};

const LENDER_KEY_PAD_TAG: &str = "simplicity-lending/private/v1/lender-key-pad";

/// The length of the encoded marker.
const ENCODED_LENGTH: usize = 37;

/// The marker of an offer, which lets the indexer find the offer, lets a lender skip offers
/// addressed to others, and lets the borrower recover the lender's key.
///
/// Encoded in 37 bytes: program id (4) ‖ view tag (1) ‖ encrypted lender key (32).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Marker {
    /// Identifies the private lending program, so the indexer recognizes offers.
    pub program_id: [u8; 4],
    /// The offer's [view tag](OfferSecrets::view_tag), which a lender checks before rewinding
    /// the collateral output's range proof.
    pub view_tag: u8,
    /// The lender's x-only key XOR a pad only the borrower can compute; see
    /// [`Marker::decrypt_lender_key`].
    pub encrypted_lender_key: [u8; 32],
}

impl Marker {
    /// The marker of the offer from `borrower` to `lender` whose creation transaction spends
    /// `first_input` as its input 0.
    pub fn new(
        program_id: [u8; 4],
        secrets: &OfferSecrets,
        lender: &XOnlyPublicKey,
        borrower: &LendingKey,
        first_input: &OutPoint,
    ) -> Marker {
        Marker {
            program_id,
            view_tag: secrets.view_tag(),
            encrypted_lender_key: xor(lender.serialize(), lender_key_pad(borrower, first_input)),
        }
    }

    /// The 37-byte encoding.
    pub fn encode(&self) -> [u8; ENCODED_LENGTH] {
        let mut bytes = [0; ENCODED_LENGTH];
        bytes[..4].copy_from_slice(&self.program_id);
        bytes[4] = self.view_tag;
        bytes[5..].copy_from_slice(&self.encrypted_lender_key);
        bytes
    }

    /// Decodes a marker from exactly 37 bytes.
    pub fn decode(bytes: &[u8]) -> Option<Marker> {
        let [p0, p1, p2, p3, view_tag, encrypted_lender_key @ ..] =
            <[u8; ENCODED_LENGTH]>::try_from(bytes).ok()?;

        Some(Marker {
            program_id: [p0, p1, p2, p3],
            view_tag,
            encrypted_lender_key,
        })
    }

    /// The lender's key, which only the offer's borrower can decrypt: it XORs the encrypted key
    /// with the pad `tagged_hash("simplicity-lending/private/v1/lender-key-pad", borrower_sk ‖
    /// txid ‖ vout_le32)` over the first input of the creation transaction, the txid in its
    /// internal byte order.
    ///
    /// With another borrower key or first input the result is `None` or an unrelated key.
    pub fn decrypt_lender_key(
        &self,
        borrower: &LendingKey,
        first_input: &OutPoint,
    ) -> Option<XOnlyPublicKey> {
        let key = xor(
            self.encrypted_lender_key,
            lender_key_pad(borrower, first_input),
        );

        XOnlyPublicKey::from_slice(&key).ok()
    }
}

/// The pad that encrypts the lender's key:
/// `tagged_hash("simplicity-lending/private/v1/lender-key-pad", borrower_sk ‖ txid ‖ vout_le32)`.
///
/// It hashes the borrower's secret key rather than the shared secret, so the borrower can
/// compute it without knowing the lender.
fn lender_key_pad(borrower: &LendingKey, first_input: &OutPoint) -> [u8; 32] {
    tagged_hash(
        LENDER_KEY_PAD_TAG,
        &[
            &borrower.secret_key().secret_bytes(),
            first_input.txid.as_byte_array(),
            &first_input.vout.to_le_bytes(),
        ],
    )
}

fn xor(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    std::array::from_fn(|i| a[i] ^ b[i])
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use elements::Txid;

    use super::*;
    use crate::ephemeral_key;

    const PROGRAM_ID: [u8; 4] = [0x10, 0x11, 0x12, 0x13];

    static BORROWER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[1; 32]));
    static OTHER_BORROWER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[3; 32]));
    static LENDER: LazyLock<XOnlyPublicKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[2; 32]).x_only_public_key());
    /// The txid bytes 0x00..=0x1f in internal order and a vout whose bytes differ, so a byte
    /// order mistake changes the pad.
    static FIRST_INPUT: LazyLock<OutPoint> = LazyLock::new(|| {
        OutPoint::new(
            Txid::from_byte_array(std::array::from_fn(|i| i as u8)),
            0x0102_0304,
        )
    });

    /// The borrower's secrets of an offer from [`BORROWER`] to [`LENDER`].
    fn sample_secrets() -> OfferSecrets {
        OfferSecrets::for_borrower(&ephemeral_key(&BORROWER, &FIRST_INPUT), &LENDER)
    }

    fn sample_marker() -> Marker {
        Marker::new(
            PROGRAM_ID,
            &sample_secrets(),
            &LENDER,
            &BORROWER,
            &FIRST_INPUT,
        )
    }

    #[test]
    fn marker_round_trips() {
        let marker = sample_marker();
        let bytes = marker.encode();
        assert_eq!(Marker::decode(&bytes), Some(marker));
        assert_eq!(Marker::decode(&bytes[..36]), None);
        assert_eq!(Marker::decode(&[bytes.as_slice(), &[0]].concat()), None);
    }

    #[test]
    fn borrower_decrypts_lender_key() {
        let marker = sample_marker();
        assert_eq!(
            marker.decrypt_lender_key(&BORROWER, &FIRST_INPUT),
            Some(*LENDER)
        );
    }

    #[test]
    fn other_borrower_gets_another_key() {
        let marker = sample_marker();
        assert_ne!(
            marker.decrypt_lender_key(&OTHER_BORROWER, &FIRST_INPUT),
            Some(*LENDER)
        );
    }

    #[test]
    fn view_tag_matches_secrets() {
        assert_eq!(sample_marker().view_tag, sample_secrets().view_tag());
    }

    #[test]
    fn encoding_follows_the_layout() {
        let bytes = sample_marker().encode();

        assert_eq!(bytes[0..4], PROGRAM_ID);
        assert_eq!(bytes[4], sample_secrets().view_tag());

        // the pad is tagged_hash(lender-key-pad, borrower_sk ‖ txid ‖ vout_le32)
        let txid: [u8; 32] = std::array::from_fn(|i| i as u8);
        let pad = tagged_hash(
            "simplicity-lending/private/v1/lender-key-pad",
            &[
                &BORROWER.secret_key().secret_bytes(),
                &txid,
                &[0x04, 0x03, 0x02, 0x01],
            ],
        );
        let lender = LENDER.serialize();
        let encrypted: [u8; 32] = std::array::from_fn(|i| lender[i] ^ pad[i]);
        assert_eq!(bytes[5..37], encrypted);
    }
}
