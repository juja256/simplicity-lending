//! The marker of an offer: the `OP_RETURN` payload of its creation transaction.

use elements::secp256k1_zkp::XOnlyPublicKey;
use elements::{AssetId, OutPoint};

use crate::keys::borrower_tagged_hash;
use crate::{LendingKey, OfferSecrets};

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
    /// `first_input` as its input 0 and issues `borrower_nft` and `lender_nft`.
    pub fn new(
        program_id: [u8; 4],
        secrets: &OfferSecrets,
        lender: &XOnlyPublicKey,
        borrower: &LendingKey,
        first_input: &OutPoint,
        borrower_nft: AssetId,
        lender_nft: AssetId,
    ) -> Marker {
        let pad = lender_key_pad(borrower, first_input, borrower_nft, lender_nft);

        Marker {
            program_id,
            view_tag: secrets.view_tag(),
            encrypted_lender_key: xor(lender.serialize(), pad),
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
    /// txid ‖ vout_le32 ‖ borrower_nft ‖ lender_nft)` over the first input of the creation
    /// transaction and the two NFTs it issues, the txid and the asset ids in their internal byte
    /// order.
    ///
    /// With another borrower key, first input or NFT the result is `None` or an unrelated key.
    pub fn decrypt_lender_key(
        &self,
        borrower: &LendingKey,
        first_input: &OutPoint,
        borrower_nft: AssetId,
        lender_nft: AssetId,
    ) -> Option<XOnlyPublicKey> {
        let pad = lender_key_pad(borrower, first_input, borrower_nft, lender_nft);

        XOnlyPublicKey::from_slice(&xor(self.encrypted_lender_key, pad)).ok()
    }
}

/// The pad that encrypts the lender's key:
/// `tagged_hash("simplicity-lending/private/v1/lender-key-pad", borrower_sk ‖ txid ‖ vout_le32 ‖
/// borrower_nft ‖ lender_nft)`.
///
/// It hashes the borrower's secret key rather than the shared secret, so the borrower can
/// compute it without knowing the lender. The NFTs, issued from fresh random entropy by every
/// build, make it differ between two creation transactions that spend the same input 0, so the
/// XOR of two markers does not reveal the XOR of their lenders' keys.
fn lender_key_pad(
    borrower: &LendingKey,
    first_input: &OutPoint,
    borrower_nft: AssetId,
    lender_nft: AssetId,
) -> [u8; 32] {
    borrower_tagged_hash(
        LENDER_KEY_PAD_TAG,
        borrower,
        first_input,
        borrower_nft,
        lender_nft,
    )
}

fn xor(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    std::array::from_fn(|i| a[i] ^ b[i])
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use elements::Txid;
    use elements::hashes::Hash;

    use super::*;
    use crate::test_util::sequence;
    use crate::{ephemeral_key, tagged_hash};

    const PROGRAM_ID: [u8; 4] = [0x10, 0x11, 0x12, 0x13];

    static BORROWER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[1; 32]));
    static OTHER_BORROWER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[3; 32]));
    static LENDER: LazyLock<XOnlyPublicKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[2; 32]).x_only_public_key());
    /// The txid bytes 0x00..=0x1f in internal order and a vout whose bytes differ, so a byte
    /// order mistake changes the pad.
    static FIRST_INPUT: LazyLock<OutPoint> =
        LazyLock::new(|| OutPoint::new(Txid::from_byte_array(sequence(0x00)), 0x0102_0304));
    /// The NFT ids of the sample creation transaction, the bytes 0x40..=0x5f and 0x60..=0x7f in
    /// internal order.
    static BORROWER_NFT: LazyLock<AssetId> =
        LazyLock::new(|| AssetId::from_slice(&sequence(0x40)).unwrap());
    static LENDER_NFT: LazyLock<AssetId> =
        LazyLock::new(|| AssetId::from_slice(&sequence(0x60)).unwrap());

    /// The borrower's secrets of an offer from [`BORROWER`] to [`LENDER`].
    fn sample_secrets() -> OfferSecrets {
        let ephemeral_sk = ephemeral_key(&BORROWER, &FIRST_INPUT, *BORROWER_NFT, *LENDER_NFT);
        OfferSecrets::for_borrower(&ephemeral_sk, &LENDER)
    }

    fn sample_marker() -> Marker {
        Marker::new(
            PROGRAM_ID,
            &sample_secrets(),
            &LENDER,
            &BORROWER,
            &FIRST_INPUT,
            *BORROWER_NFT,
            *LENDER_NFT,
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
            marker.decrypt_lender_key(&BORROWER, &FIRST_INPUT, *BORROWER_NFT, *LENDER_NFT),
            Some(*LENDER)
        );
    }

    #[test]
    fn other_borrower_gets_another_key() {
        let marker = sample_marker();
        assert_ne!(
            marker.decrypt_lender_key(&OTHER_BORROWER, &FIRST_INPUT, *BORROWER_NFT, *LENDER_NFT),
            Some(*LENDER)
        );
    }

    #[test]
    fn another_first_input_or_other_nfts_give_another_key() {
        let marker = sample_marker();
        let other_input = OutPoint::new(FIRST_INPUT.txid, FIRST_INPUT.vout + 1);
        let other_nft = AssetId::from_slice(&[0x66; 32]).unwrap();

        let decrypted = [
            marker.decrypt_lender_key(&BORROWER, &other_input, *BORROWER_NFT, *LENDER_NFT),
            marker.decrypt_lender_key(&BORROWER, &FIRST_INPUT, other_nft, *LENDER_NFT),
            marker.decrypt_lender_key(&BORROWER, &FIRST_INPUT, *BORROWER_NFT, other_nft),
        ];
        for key in decrypted {
            assert_ne!(key, Some(*LENDER));
        }
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

        // the pad is tagged_hash(lender-key-pad, borrower_sk ‖ txid ‖ vout_le32 ‖ borrower_nft ‖
        // lender_nft)
        let pad = tagged_hash(
            "simplicity-lending/private/v1/lender-key-pad",
            &[
                &BORROWER.secret_key().secret_bytes(),
                &sequence(0x00),
                &[0x04, 0x03, 0x02, 0x01],
                &sequence(0x40),
                &sequence(0x60),
            ],
        );
        let lender = LENDER.serialize();
        let encrypted: [u8; 32] = std::array::from_fn(|i| lender[i] ^ pad[i]);
        assert_eq!(bytes[5..37], encrypted);
    }
}
