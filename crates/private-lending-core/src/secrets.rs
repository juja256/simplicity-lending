//! The secrets of an offer: the borrower–lender shared secret and the values derived from it.

use elements::confidential::{AssetBlindingFactor, Nonce, ValueBlindingFactor};
use elements::secp256k1_zkp::{PublicKey, SECP256K1, SecretKey, XOnlyPublicKey};

use crate::{LendingKey, lift_lending_key, tagged_hash};

/// The prefix of the tags of values derived from the shared secret.
const DERIVED_TAG_PREFIX: &str = "simplicity-lending/private/v1/";

/// An output of the private contract whose blinding factors derive from the shared secret.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PinnedRole {
    PendingCollateral,
    ActiveCollateral,
    Principal,
    Repayment,
}

impl PinnedRole {
    /// The labels of the role's asset and value blinding factors.
    fn blinder_labels(self) -> (&'static str, &'static str) {
        match self {
            Self::PendingCollateral => ("pending-collateral-abf", "pending-collateral-vbf"),
            Self::ActiveCollateral => ("active-collateral-abf", "active-collateral-vbf"),
            Self::Principal => ("principal-abf", "principal-vbf"),
            Self::Repayment => ("repayment-abf", "repayment-vbf"),
        }
    }
}

/// The secrets of one offer, which its borrower and its lender compute independently.
///
/// The shared secret is the one Elements uses to rewind the collateral output's range proof;
/// every other per-offer value derives from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OfferSecrets {
    shared_secret: SecretKey,
}

impl OfferSecrets {
    /// The borrower's side, from the offer's ephemeral key and the lender's lending key.
    pub fn for_borrower(ephemeral_sk: &SecretKey, lender: &XOnlyPublicKey) -> OfferSecrets {
        let (_, shared_secret) =
            Nonce::with_ephemeral_sk(SECP256K1, *ephemeral_sk, &lift_lending_key(lender));

        OfferSecrets { shared_secret }
    }

    /// The lender's side, from its lending key and the collateral output's nonce.
    pub fn for_lender(lender: &LendingKey, nonce: &PublicKey) -> OfferSecrets {
        let shared_secret = Nonce::Confidential(*nonce)
            .shared_secret(&lender.secret_key())
            .expect("a confidential nonce always has a shared secret");

        OfferSecrets { shared_secret }
    }

    /// The ECDH shared secret, as Elements computes it from a confidential nonce.
    pub fn shared_secret(&self) -> SecretKey {
        self.shared_secret
    }

    /// The offer's view tag, which lets a lender skip most offers addressed to others.
    pub fn view_tag(&self) -> u8 {
        self.derive("view-tag")[0]
    }

    /// The asset and value blinding factors of the output with `role`.
    pub fn blinders(&self, role: PinnedRole) -> (AssetBlindingFactor, ValueBlindingFactor) {
        let (abf_label, vbf_label) = role.blinder_labels();

        let abf = AssetBlindingFactor::from_slice(&self.derive(abf_label))
            .expect("a tagged hash is above the curve order with negligible probability");
        let vbf = ValueBlindingFactor::from_slice(&self.derive(vbf_label))
            .expect("a tagged hash is above the curve order with negligible probability");

        (abf, vbf)
    }

    /// The value labelled `label`: `tagged_hash("simplicity-lending/private/v1/<label>",
    /// shared_secret)`.
    pub fn derive(&self, label: &str) -> [u8; 32] {
        let tag = format!("{DERIVED_TAG_PREFIX}{label}");

        tagged_hash(&tag, &[&self.shared_secret.secret_bytes()])
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use elements::secp256k1_zkp::Parity;

    use super::*;

    const ALL_ROLES: [PinnedRole; 4] = [
        PinnedRole::PendingCollateral,
        PinnedRole::ActiveCollateral,
        PinnedRole::Principal,
        PinnedRole::Repayment,
    ];

    /// Whether the lending key of `mbk`, before normalization, has an odd-Y public key.
    fn raw_key_has_odd_y(mbk: &[u8; 32]) -> bool {
        let raw = tagged_hash("simplicity-lending/lending-key/v1", &[mbk]);
        let raw = SecretKey::from_slice(&raw).unwrap();
        raw.x_only_public_key(SECP256K1).1 == Parity::Odd
    }

    /// The borrower's and the lender's secrets of an offer to the lender of `mbk`.
    fn both_sides(mbk: &[u8; 32]) -> (OfferSecrets, OfferSecrets) {
        let lender = LendingKey::from_master_blinding_key(mbk);
        let e = SecretKey::from_slice(&[3; 32]).unwrap();
        let nonce = PublicKey::from_secret_key(SECP256K1, &e);
        (
            OfferSecrets::for_borrower(&e, &lender.x_only_public_key()),
            OfferSecrets::for_lender(&lender, &nonce),
        )
    }

    #[test]
    fn odd_y_lending_key_agrees_on_shared_secret() {
        // find a master blinding key whose raw tagged hash has an odd-Y public key
        let mbk = (0u8..=255)
            .map(|i| [i; 32])
            .find(raw_key_has_odd_y)
            .unwrap();
        let lender = LendingKey::from_master_blinding_key(&mbk);
        let e = SecretKey::from_slice(&[3; 32]).unwrap();
        let borrower_side = OfferSecrets::for_borrower(&e, &lender.x_only_public_key());
        let nonce = PublicKey::from_secret_key(SECP256K1, &e);
        assert_eq!(
            borrower_side.shared_secret(),
            OfferSecrets::for_lender(&lender, &nonce).shared_secret()
        );
    }

    #[test]
    fn both_sides_derive_the_same_view_tag_and_blinders() {
        let (borrower_side, lender_side) = both_sides(&[9; 32]);
        assert_eq!(borrower_side.view_tag(), lender_side.view_tag());
        for role in ALL_ROLES {
            assert_eq!(borrower_side.blinders(role), lender_side.blinders(role));
        }
    }

    #[test]
    fn derived_labels_are_distinct() {
        let (secrets, _) = both_sides(&[9; 32]);
        let all: HashSet<_> = ALL_ROLES
            .iter()
            .flat_map(|r| {
                let (abf, vbf) = secrets.blinders(*r);
                [*abf.into_inner().as_ref(), *vbf.into_inner().as_ref()]
            })
            .collect();
        assert_eq!(all.len(), 8);
    }
}
