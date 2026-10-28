//! The terms of an offer, signed by the borrower and carried in the collateral output's range
//! proof, where only the borrower and the lender can read them.

use std::fmt;

use elements::hashes::{Hash, sha256};
use elements::secp256k1_zkp::{Keypair, Message, SECP256K1, XOnlyPublicKey, schnorr};
use elements::{AssetId, OutPoint};

use crate::{LendingKey, tagged_hash};

/// The version of the terms encoding.
pub const TERMS_VERSION: u8 = 1;

const OFFER_TAG: &str = "simplicity-lending/private/v1/offer";

/// The value of the length field: the number of bytes after the version and the length.
const BODY_LENGTH: u16 = 214;
/// The length of the encoded terms.
const ENCODED_LENGTH: usize = 3 + BODY_LENGTH as usize;
/// The length of the signed prefix of the encoding, everything before the signature.
const SIGNED_LENGTH: usize = 153;

/// The terms of an offer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OfferTerms {
    pub principal_asset: AssetId,
    pub principal_amount: u64,
    pub repayment_amount: u64,
    pub interest_rate_bps: u16,
    /// The block height at which the loan expires.
    pub loan_expiration_time: u32,
    pub borrower_nft: AssetId,
    pub lender_nft: AssetId,
}

/// Offer terms with the borrower's BIP340 signature, which binds them to one lender and one
/// creation transaction.
///
/// Encoded big-endian in 217 bytes: version `1` (1) ‖ length `214` (2) ‖ principal asset (32) ‖
/// principal amount (8) ‖ repayment amount (8) ‖ interest bps (2) ‖ expiration height (4) ‖
/// borrower NFT (32) ‖ lender NFT (32) ‖ borrower x-only key (32) ‖ signature (64), the asset
/// ids in their internal (consensus-serialized) byte order.
///
/// The signature signs `tagged_hash("simplicity-lending/private/v1/offer", lender_pk ‖ txid ‖
/// vout_le32 ‖ bytes 0..153)`, over the first input of the creation transaction, the txid in its
/// internal byte order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SignedTerms {
    pub terms: OfferTerms,
    pub borrower: XOnlyPublicKey,
    pub signature: schnorr::Signature,
}

/// Why encoded terms were rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TermsError {
    /// The version is not [`TERMS_VERSION`].
    UnknownVersion(u8),
    /// The input is shorter than its length field says, or the length is not the version's.
    BadLength,
    /// The signature does not sign the terms for this lender and first input.
    BadSignature,
    /// The borrower key or the signature does not parse.
    Malformed,
}

impl fmt::Display for TermsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownVersion(version) => write!(f, "unknown terms version {version}"),
            Self::BadLength => f.write_str("bad terms length"),
            Self::BadSignature => f.write_str("bad terms signature"),
            Self::Malformed => f.write_str("malformed terms"),
        }
    }
}

impl std::error::Error for TermsError {}

impl SignedTerms {
    /// Signs `terms` with the borrower's lending key for `lender` and the first input of the
    /// creation transaction, with random auxiliary data.
    pub fn sign(
        terms: OfferTerms,
        borrower: &LendingKey,
        lender: &XOnlyPublicKey,
        first_input: &OutPoint,
    ) -> SignedTerms {
        let borrower_pk = borrower.x_only_public_key();
        let message = signed_message(&signed_prefix(&terms, &borrower_pk), lender, first_input);
        let keypair = Keypair::from_secret_key(SECP256K1, &borrower.secret_key());
        let signature = SECP256K1.sign_schnorr_with_aux_rand(&message, &keypair, &rand::random());

        SignedTerms {
            terms,
            borrower: borrower_pk,
            signature,
        }
    }

    /// Checks that the borrower signed the terms for `lender` and `first_input`.
    pub fn verify(
        &self,
        lender: &XOnlyPublicKey,
        first_input: &OutPoint,
    ) -> Result<(), TermsError> {
        let message = signed_message(
            &signed_prefix(&self.terms, &self.borrower),
            lender,
            first_input,
        );

        SECP256K1
            .verify_schnorr(&self.signature, &message, &self.borrower)
            .map_err(|_| TermsError::BadSignature)
    }

    /// The 217-byte encoding.
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = signed_prefix(&self.terms, &self.borrower);
        bytes.extend_from_slice(self.signature.as_ref());
        bytes
    }

    /// Decodes terms from the start of `bytes`, ignoring the bytes after the length the encoding
    /// declares, such as the zero padding of a rewound range proof message.
    ///
    /// The version and the length frame the encoding, so an input shorter than its declared length
    /// is [`TermsError::BadLength`] whatever its version. The signature is not checked; see
    /// [`SignedTerms::verify`].
    pub fn decode(bytes: &[u8]) -> Result<SignedTerms, TermsError> {
        let [version, length_hi, length_lo, rest @ ..] = bytes else {
            return Err(TermsError::BadLength);
        };
        let length = u16::from_be_bytes([*length_hi, *length_lo]);
        let body = rest
            .get(..usize::from(length))
            .ok_or(TermsError::BadLength)?;
        if *version != TERMS_VERSION {
            return Err(TermsError::UnknownVersion(*version));
        }
        if length != BODY_LENGTH {
            return Err(TermsError::BadLength);
        }

        let mut reader = Reader(body);
        let terms = OfferTerms {
            principal_asset: reader.asset_id(),
            principal_amount: u64::from_be_bytes(reader.array()),
            repayment_amount: u64::from_be_bytes(reader.array()),
            interest_rate_bps: u16::from_be_bytes(reader.array()),
            loan_expiration_time: u32::from_be_bytes(reader.array()),
            borrower_nft: reader.asset_id(),
            lender_nft: reader.asset_id(),
        };
        let borrower =
            XOnlyPublicKey::from_slice(&reader.array::<32>()).map_err(|_| TermsError::Malformed)?;
        let signature = schnorr::Signature::from_slice(&reader.array::<64>())
            .map_err(|_| TermsError::Malformed)?;

        Ok(SignedTerms {
            terms,
            borrower,
            signature,
        })
    }
}

/// Bytes 0..153 of the encoding, the part the signature covers.
fn signed_prefix(terms: &OfferTerms, borrower: &XOnlyPublicKey) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(ENCODED_LENGTH);
    bytes.push(TERMS_VERSION);
    bytes.extend_from_slice(&BODY_LENGTH.to_be_bytes());
    bytes.extend_from_slice(&terms.principal_asset.into_inner().to_byte_array());
    bytes.extend_from_slice(&terms.principal_amount.to_be_bytes());
    bytes.extend_from_slice(&terms.repayment_amount.to_be_bytes());
    bytes.extend_from_slice(&terms.interest_rate_bps.to_be_bytes());
    bytes.extend_from_slice(&terms.loan_expiration_time.to_be_bytes());
    bytes.extend_from_slice(&terms.borrower_nft.into_inner().to_byte_array());
    bytes.extend_from_slice(&terms.lender_nft.into_inner().to_byte_array());
    bytes.extend_from_slice(&borrower.serialize());
    debug_assert_eq!(bytes.len(), SIGNED_LENGTH);
    bytes
}

/// The message the borrower signs: `tagged_hash("simplicity-lending/private/v1/offer", lender_pk ‖
/// txid ‖ vout_le32 ‖ signed_prefix)`.
fn signed_message(
    signed_prefix: &[u8],
    lender: &XOnlyPublicKey,
    first_input: &OutPoint,
) -> Message {
    let digest = tagged_hash(
        OFFER_TAG,
        &[
            &lender.serialize(),
            first_input.txid.as_byte_array(),
            &first_input.vout.to_le_bytes(),
            signed_prefix,
        ],
    );

    Message::from_digest(digest)
}

/// Reads fixed-size fields from the front of a slice whose length the caller has checked.
struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn array<const N: usize>(&mut self) -> [u8; N] {
        let (field, rest) = self.0.split_first_chunk().expect("the length is checked");
        self.0 = rest;
        *field
    }

    fn asset_id(&mut self) -> AssetId {
        AssetId::from_inner(sha256::Midstate::from_byte_array(self.array()))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use elements::secp256k1_zkp::{Message, SECP256K1};
    use elements::{AssetId, Txid};

    use super::*;
    use crate::tagged_hash;

    static BORROWER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[1; 32]));
    static LENDER: LazyLock<XOnlyPublicKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[2; 32]).x_only_public_key());
    static OTHER_LENDER: LazyLock<XOnlyPublicKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[3; 32]).x_only_public_key());
    static OUTPOINT_A: LazyLock<OutPoint> =
        LazyLock::new(|| OutPoint::new(Txid::from_byte_array([0xaa; 32]), 0));
    static OUTPOINT_B: LazyLock<OutPoint> =
        LazyLock::new(|| OutPoint::new(Txid::from_byte_array([0xaa; 32]), 1));

    fn sample_terms() -> OfferTerms {
        OfferTerms {
            principal_asset: AssetId::from_slice(&[0x11; 32]).unwrap(),
            principal_amount: 0x0102_0304_0506_0708,
            repayment_amount: 0x1112_1314_1516_1718,
            interest_rate_bps: 0x2122,
            loan_expiration_time: 0x3132_3334,
            borrower_nft: AssetId::from_slice(&[0x44; 32]).unwrap(),
            lender_nft: AssetId::from_slice(&[0x55; 32]).unwrap(),
        }
    }

    /// Terms signed by [`BORROWER`] for [`LENDER`] and [`OUTPOINT_A`].
    fn sample_signed() -> SignedTerms {
        SignedTerms::sign(sample_terms(), &BORROWER, &LENDER, &OUTPOINT_A)
    }

    #[test]
    fn terms_round_trip_with_zero_padding() {
        let signed = sample_signed();
        let mut bytes = signed.encode();
        assert_eq!(bytes.len(), 217);
        bytes.extend_from_slice(&[0u8; 3000]); // rewind returns the message padded with zeros
        assert_eq!(SignedTerms::decode(&bytes).unwrap(), signed);
    }

    #[test]
    fn signature_binds_lender_and_first_input() {
        let signed = sample_signed(); // signed for LENDER and OUTPOINT_A
        assert!(signed.verify(&LENDER, &OUTPOINT_A).is_ok());
        assert!(matches!(
            signed.verify(&OTHER_LENDER, &OUTPOINT_A),
            Err(TermsError::BadSignature)
        ));
        assert!(matches!(
            signed.verify(&LENDER, &OUTPOINT_B),
            Err(TermsError::BadSignature)
        ));
    }

    #[test]
    fn tampered_amount_fails_verification() {
        let mut signed = sample_signed();
        signed.terms.repayment_amount -= 1;
        assert!(matches!(
            signed.verify(&LENDER, &OUTPOINT_A),
            Err(TermsError::BadSignature)
        ));
    }

    #[test]
    fn unknown_version_and_short_input_are_rejected() {
        let mut bytes = sample_signed().encode();
        bytes[0] = 2;
        assert!(matches!(
            SignedTerms::decode(&bytes),
            Err(TermsError::UnknownVersion(2))
        ));
        assert!(matches!(
            SignedTerms::decode(&bytes[..100]),
            Err(TermsError::BadLength)
        ));
    }

    #[test]
    fn encoding_follows_the_v1_layout() {
        let signed = sample_signed();
        let bytes = signed.encode();

        assert_eq!(bytes[0..3], [1, 0, 214]);
        assert_eq!(bytes[3..35], [0x11; 32]);
        assert_eq!(bytes[35..43], [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(
            bytes[43..51],
            [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18]
        );
        assert_eq!(bytes[51..53], [0x21, 0x22]);
        assert_eq!(bytes[53..57], [0x31, 0x32, 0x33, 0x34]);
        assert_eq!(bytes[57..89], [0x44; 32]);
        assert_eq!(bytes[89..121], [0x55; 32]);
        assert_eq!(bytes[121..153], BORROWER.x_only_public_key().serialize());

        // the signature covers lender_pk ‖ txid ‖ vout_le32 ‖ bytes 0..153
        let digest = tagged_hash(
            "simplicity-lending/private/v1/offer",
            &[
                &LENDER.serialize(),
                &[0xaa; 32],
                &[0, 0, 0, 0],
                &bytes[..153],
            ],
        );
        let signature = schnorr::Signature::from_slice(&bytes[153..217]).unwrap();
        assert!(
            SECP256K1
                .verify_schnorr(
                    &signature,
                    &Message::from_digest(digest),
                    &BORROWER.x_only_public_key()
                )
                .is_ok()
        );
    }

    #[test]
    fn bad_length_field_and_invalid_borrower_key_are_rejected() {
        let mut bytes = sample_signed().encode();
        bytes[2] = 213;
        assert!(matches!(
            SignedTerms::decode(&bytes),
            Err(TermsError::BadLength)
        ));

        let mut bytes = sample_signed().encode();
        bytes[121..153].copy_from_slice(&[0xff; 32]); // not an x coordinate on the curve
        assert!(matches!(
            SignedTerms::decode(&bytes),
            Err(TermsError::Malformed)
        ));
    }
}
