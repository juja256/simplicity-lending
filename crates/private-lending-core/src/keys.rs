//! Lending keys and the ephemeral key of an offer.

use elements::hashes::Hash;
use elements::secp256k1_zkp::{Parity, PublicKey, SECP256K1, SecretKey, XOnlyPublicKey};
use elements::{AssetId, OutPoint};

use crate::tagged_hash;

const LENDING_KEY_TAG: &str = "simplicity-lending/lending-key/v1";
const EPHEMERAL_TAG: &str = "simplicity-lending/private/v1/ephemeral";

/// A user's lending key, derived from the wallet's SLIP-77 master blinding key.
///
/// The key is normalized so that its public key has even Y: the x-only public key then serves
/// both BIP340 signatures and, lifted with [`lift_lending_key`], ECDH.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LendingKey {
    secret_key: SecretKey,
}

impl LendingKey {
    /// The lending key of a master blinding key: `tagged_hash("simplicity-lending/lending-key/v1",
    /// mbk)` as a secret key, negated if its public key has odd Y.
    pub fn from_master_blinding_key(mbk: &[u8; 32]) -> LendingKey {
        let hash = tagged_hash(LENDING_KEY_TAG, &[mbk]);
        let secret_key = SecretKey::from_slice(&hash)
            .expect("a tagged hash is zero or above the curve order with negligible probability");

        let secret_key = match secret_key.x_only_public_key(SECP256K1).1 {
            Parity::Even => secret_key,
            Parity::Odd => secret_key.negate(),
        };

        LendingKey { secret_key }
    }

    /// The secret key, whose public key has even Y.
    pub fn secret_key(&self) -> SecretKey {
        self.secret_key
    }

    /// The x-only public key, the user's public identity as a borrower or a lender.
    pub fn x_only_public_key(&self) -> XOnlyPublicKey {
        self.secret_key.x_only_public_key(SECP256K1).0
    }
}

/// The full public key of an x-only lending key: the point with even Y.
pub fn lift_lending_key(key: &XOnlyPublicKey) -> PublicKey {
    key.public_key(Parity::Even)
}

/// The ephemeral key of an offer, whose public key is the collateral output's nonce:
/// `tagged_hash("simplicity-lending/private/v1/ephemeral", borrower_sk ‖ txid ‖ vout_le32 ‖
/// borrower_nft ‖ lender_nft)` over the first input of the creation transaction and the two NFTs
/// it issues, the txid and the asset ids in their internal byte order.
///
/// It is deterministic, so the borrower can find its offers again from its lending key alone:
/// the first input and the NFTs are public in the creation transaction (input 0, outputs 0 and
/// 1). The NFTs make it differ between two creation transactions that spend the same input 0,
/// since each build issues NFTs from fresh random entropy.
pub fn ephemeral_key(
    borrower: &LendingKey,
    first_input: &OutPoint,
    borrower_nft: AssetId,
    lender_nft: AssetId,
) -> SecretKey {
    let hash = borrower_tagged_hash(
        EPHEMERAL_TAG,
        borrower,
        first_input,
        borrower_nft,
        lender_nft,
    );

    SecretKey::from_slice(&hash)
        .expect("a tagged hash is zero or above the curve order with negligible probability")
}

/// `tagged_hash(tag, borrower_sk ‖ txid ‖ vout_le32 ‖ borrower_nft ‖ lender_nft)`: the data of
/// the per-offer values that only the borrower computes, the ephemeral key and the lender-key
/// pad. The secret key hashes as its 32 bytes, the txid and the asset ids in their internal byte
/// order.
pub(crate) fn borrower_tagged_hash(
    tag: &str,
    borrower: &LendingKey,
    first_input: &OutPoint,
    borrower_nft: AssetId,
    lender_nft: AssetId,
) -> [u8; 32] {
    tagged_hash(
        tag,
        &[
            &borrower.secret_key.secret_bytes(),
            first_input.txid.as_byte_array(),
            &first_input.vout.to_le_bytes(),
            &borrower_nft.into_inner().to_byte_array(),
            &lender_nft.into_inner().to_byte_array(),
        ],
    )
}

#[cfg(test)]
mod tests {
    use elements::{AssetId, Txid};

    use super::*;
    use crate::test_util::sequence;

    fn asset(byte: u8) -> AssetId {
        AssetId::from_slice(&[byte; 32]).unwrap()
    }

    /// The txid bytes 0x00..=0x1f in internal order and a vout whose bytes differ, so a byte
    /// order mistake changes the hash.
    fn first_input() -> OutPoint {
        OutPoint::new(Txid::from_byte_array(sequence(0x00)), 0x0102_0304)
    }

    #[test]
    fn lending_key_is_deterministic_and_even() {
        let a = LendingKey::from_master_blinding_key(&[7; 32]);
        let b = LendingKey::from_master_blinding_key(&[7; 32]);
        assert_eq!(a.secret_key(), b.secret_key());
        assert_eq!(
            lift_lending_key(&a.x_only_public_key()),
            PublicKey::from_secret_key(SECP256K1, &a.secret_key())
        );
    }

    #[test]
    fn ephemeral_key_depends_on_borrower_first_input_and_nfts() {
        let borrower = LendingKey::from_master_blinding_key(&[1; 32]);
        let other_borrower = LendingKey::from_master_blinding_key(&[3; 32]);
        let first_input = first_input();
        let (borrower_nft, lender_nft) = (asset(0x44), asset(0x55));
        let key = ephemeral_key(&borrower, &first_input, borrower_nft, lender_nft);
        assert_eq!(
            key,
            ephemeral_key(&borrower, &first_input, borrower_nft, lender_nft)
        );

        let other_txid = OutPoint::new(Txid::from_byte_array([0xee; 32]), first_input.vout);
        let other_vout = OutPoint::new(first_input.txid, first_input.vout + 1);
        let others = [
            ephemeral_key(&other_borrower, &first_input, borrower_nft, lender_nft),
            ephemeral_key(&borrower, &other_txid, borrower_nft, lender_nft),
            ephemeral_key(&borrower, &other_vout, borrower_nft, lender_nft),
            // a rebuilt creation transaction spends the same input 0 but issues fresh NFTs
            ephemeral_key(&borrower, &first_input, asset(0x66), lender_nft),
            ephemeral_key(&borrower, &first_input, borrower_nft, asset(0x66)),
            ephemeral_key(&borrower, &first_input, lender_nft, borrower_nft),
        ];
        for other in others {
            assert_ne!(key, other);
        }
    }
}
