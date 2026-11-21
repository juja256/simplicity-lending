//! The secrets of an offer: the borrower–lender shared secret and the values derived from it.

use elements::confidential::{AssetBlindingFactor, Nonce, ValueBlindingFactor};
use elements::hashes::{Hash, HashEngine, sha256};
use elements::secp256k1_zkp::{PublicKey, SECP256K1, SecretKey, XOnlyPublicKey};

use crate::release::{MAX_STEPS, scalar};
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

    /// The salt of the offer's expiry hash ([`expiry_hash`]), which the liquidation's witness
    /// reveals with the expiry.
    pub fn expiry_salt(&self) -> [u8; 32] {
        self.derive("expiry-salt")
    }

    /// The blinders `x_j` and `y_j` of step `j`, for `j = 1 … 1024`:
    /// `scalar(derive("release-x/<j>"))` and `scalar(derive("release-y/<j>"))` with `<j>` in
    /// decimal, each reduced modulo the curve order. The collateral at step `j` has the value
    /// commitment `c_j·A_c + x_j·G`, and the contract's Merkle tree commits to
    /// `Y_j = x_j·G + y_j·J` ([`BlinderTree`](crate::BlinderTree)).
    ///
    /// # Panics
    /// If `j` is 0 or above 1024.
    pub fn release_blinders(&self, j: u32) -> (SecretKey, SecretKey) {
        assert!(
            (1..=MAX_STEPS).contains(&j),
            "a loan has no step {j}: its steps are 1 to {MAX_STEPS}"
        );
        let secret_scalar = |label: String| {
            SecretKey::from_slice(&scalar(&self.derive(&label)).to_be_bytes()).expect(
                "a tagged hash is a multiple of the curve order with negligible probability",
            )
        };

        (
            secret_scalar(format!("release-x/{j}")),
            secret_scalar(format!("release-y/{j}")),
        )
    }

    /// The value labelled `label`: `tagged_hash("simplicity-lending/private/v1/<label>",
    /// shared_secret)`.
    pub fn derive(&self, label: &str) -> [u8; 32] {
        let tag = format!("{DERIVED_TAG_PREFIX}{label}");

        tagged_hash(&tag, &[&self.shared_secret.secret_bytes()])
    }
}

/// The expiry hash of the contract, `SHA-256(salt ‖ expiry)` with the expiry as a 4-byte
/// big-endian block height: the hash the liquidation branch checks its witness's salt and expiry
/// against. A spend through any other branch reveals a CMR that commits to the hash, so without the
/// salt ([`OfferSecrets::expiry_salt`]) nobody can try candidate expiries against it.
pub fn expiry_hash(salt: &[u8; 32], expiry: u32) -> [u8; 32] {
    let mut engine = sha256::Hash::engine();
    engine.input(salt);
    engine.input(&expiry.to_be_bytes());

    sha256::Hash::from_engine(engine).to_byte_array()
}

#[cfg(test)]
impl OfferSecrets {
    /// The secrets of the offer whose shared secret is `shared_secret`.
    pub(crate) fn from_shared_secret(shared_secret: SecretKey) -> OfferSecrets {
        OfferSecrets { shared_secret }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use elements::hex::ToHex;
    use elements::secp256k1_zkp::Parity;

    use super::*;
    use crate::test_util::sequence;

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

    /// Frozen outputs of the derivation for a fixed shared secret, the bytes 0x80..=0x9f, so a
    /// change of tag or label fails.
    #[test]
    fn view_tag_and_blinders_known_answers() {
        let secrets = OfferSecrets {
            shared_secret: SecretKey::from_slice(&sequence(0x80)).unwrap(),
        };

        assert_eq!(secrets.view_tag(), 0xda);
        let (abf, vbf) = secrets.blinders(PinnedRole::PendingCollateral);
        assert_eq!(
            abf.into_inner().as_ref().to_hex(),
            "6b94e2dffa5ea476fad3e58101b7d80f03e094ed13628cd84552555cfb2c04d6"
        );
        assert_eq!(
            vbf.into_inner().as_ref().to_hex(),
            "65537b6c8aa26a483786b244e94816364bc69fe7966b2176a75acc5b9f7491e7"
        );
    }

    /// The frozen salt of the same shared secret as [`view_tag_and_blinders_known_answers`], so a
    /// change of tag or label fails.
    #[test]
    fn expiry_salt_known_answer() {
        let secrets = OfferSecrets {
            shared_secret: SecretKey::from_slice(&sequence(0x80)).unwrap(),
        };

        assert_eq!(
            secrets.expiry_salt().to_hex(),
            "b169c9d413aef8b85345f5bfd3df018b57d447f2d5295fb05246ba04fa9142ca"
        );
        let (borrower_side, lender_side) = both_sides(&[9; 32]);
        assert_eq!(borrower_side.expiry_salt(), lender_side.expiry_salt());
    }

    /// The frozen blinders of the first and the last step, for the same shared secret as
    /// [`view_tag_and_blinders_known_answers`], so a change of tag, label or reduction fails.
    #[test]
    fn release_blinders_known_answers() {
        let secrets = OfferSecrets {
            shared_secret: SecretKey::from_slice(&sequence(0x80)).unwrap(),
        };

        let (x_1, y_1) = secrets.release_blinders(1);
        assert_eq!(
            x_1.secret_bytes().to_hex(),
            "2347eab89207a4f4ed897eff8c12fa22f3c15d6eaa9cf5fa865c0a4014928343"
        );
        assert_eq!(
            y_1.secret_bytes().to_hex(),
            "6b8f846594e2a8ac32f33181b973782f3475615b06ab26275691da9e93571ce9"
        );
        let (x_1024, y_1024) = secrets.release_blinders(1024);
        assert_eq!(
            x_1024.secret_bytes().to_hex(),
            "4bf102fe8a2240d7cb13f0f937afa43b8ae84b7a3ae7355d0cb7f54f7096d445"
        );
        assert_eq!(
            y_1024.secret_bytes().to_hex(),
            "d211d53fecf6ac05e7f1ad7e0a94761660ac6c711dbd8929e3b33a094b6cf6b2"
        );
        // the label is the decimal step, so x_1 is derived as "release-x/1"
        assert_eq!(
            x_1.secret_bytes(),
            scalar(&secrets.derive("release-x/1")).to_be_bytes()
        );
    }

    #[test]
    fn both_sides_derive_the_same_release_blinders() {
        let (borrower_side, lender_side) = both_sides(&[9; 32]);
        for j in [1, 2, 1023, 1024] {
            assert_eq!(
                borrower_side.release_blinders(j),
                lender_side.release_blinders(j)
            );
        }
        let (x_1, y_1) = borrower_side.release_blinders(1);
        let (x_2, _) = borrower_side.release_blinders(2);
        assert_ne!(x_1, y_1);
        assert_ne!(x_1, x_2);
    }

    #[test]
    #[should_panic(expected = "no step")]
    fn release_blinders_of_step_zero_panic() {
        both_sides(&[9; 32]).0.release_blinders(0);
    }

    #[test]
    #[should_panic(expected = "no step")]
    fn release_blinders_past_the_last_step_panic() {
        both_sides(&[9; 32]).0.release_blinders(1025);
    }

    #[test]
    fn expiry_hash_is_sha256_of_salt_and_big_endian_height() {
        let salt = sequence(0x80);
        let preimage = [&salt[..], &[0x01, 0x02, 0x03, 0x04]].concat();

        assert_eq!(
            expiry_hash(&salt, 0x0102_0304),
            sha256::Hash::hash(&preimage).to_byte_array()
        );
        assert_eq!(
            expiry_hash(&salt, 0x0102_0304).to_hex(),
            "a30290aaa7ce7f331be57c25d69cc17073efe0f552152020e462e76d9a0db79e"
        );
        assert_ne!(
            expiry_hash(&salt, 0x0403_0201),
            expiry_hash(&salt, 0x0102_0304)
        );
    }
}
