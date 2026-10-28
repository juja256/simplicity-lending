//! Lending keys and the ephemeral key of an offer.

use elements::OutPoint;
use elements::hashes::Hash;
use elements::secp256k1_zkp::{Parity, PublicKey, SECP256K1, SecretKey, XOnlyPublicKey};

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
/// `tagged_hash("simplicity-lending/private/v1/ephemeral", borrower_sk ‖ txid ‖ vout_le32)` over
/// the first input of the creation transaction, the txid in its internal byte order.
///
/// It is deterministic, so the borrower can find its offers again from its lending key alone.
pub fn ephemeral_key(borrower: &LendingKey, first_input: &OutPoint) -> SecretKey {
    let hash = tagged_hash(
        EPHEMERAL_TAG,
        &[
            &borrower.secret_key.secret_bytes(),
            first_input.txid.as_byte_array(),
            &first_input.vout.to_le_bytes(),
        ],
    );

    SecretKey::from_slice(&hash)
        .expect("a tagged hash is zero or above the curve order with negligible probability")
}

#[cfg(test)]
mod tests {
    use elements::Txid;

    use super::*;

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
    fn ephemeral_key_depends_on_first_input() {
        let borrower = LendingKey::from_master_blinding_key(&[1; 32]);
        let a = OutPoint::new(Txid::all_zeros(), 0);
        let b = OutPoint::new(Txid::all_zeros(), 1);
        assert_eq!(ephemeral_key(&borrower, &a), ephemeral_key(&borrower, &a));
        assert_ne!(ephemeral_key(&borrower, &a), ephemeral_key(&borrower, &b));
    }
}
