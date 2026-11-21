//! The terms of an offer, signed by the borrower and carried in the collateral output's range
//! proof, where only the borrower and the lender can read them, with the borrower's message.

use std::fmt;

use elements::hashes::{Hash, sha256};
use elements::secp256k1_zkp::{self, Keypair, SECP256K1, XOnlyPublicKey, schnorr};
use elements::{AssetId, OutPoint};

use crate::message::{decode_field, push_field};
use crate::{LendingKey, Message, MessageError, tagged_hash};

/// The version of the terms encoding.
pub const TERMS_VERSION: u8 = 2;

const OFFER_TAG: &str = "simplicity-lending/private/v1/offer";

/// The length of the encoding's fixed fields, everything before the message field: version,
/// length, the terms and the borrower key.
const FIXED_LENGTH: usize = 153;
/// The length of the fixed fields after the version and the length.
const FIXED_BODY_LENGTH: usize = FIXED_LENGTH - 3;
const SIGNATURE_LENGTH: usize = 64;

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

/// Offer terms and the borrower's message, with the borrower's BIP340 signature, which binds them
/// to one lender and one creation transaction.
///
/// Encoded big-endian: version `2` (1) ‖ length (2) ‖ principal asset (32) ‖ principal amount (8)
/// ‖ repayment amount (8) ‖ interest bps (2) ‖ expiration height (4) ‖ borrower NFT (32) ‖ lender
/// NFT (32) ‖ borrower x-only key (32) ‖ message field ‖ signature (64), the asset ids in their
/// internal (consensus-serialized) byte order, and the length the number of bytes after itself.
/// The message field is the single byte `0` when there is no message, or `1 ‖ kind ‖ length_be16
/// ‖ text` (see [`Message`]): the terms are 218 bytes with no message, and 221 plus the text's
/// length with one.
///
/// The signature signs `tagged_hash("simplicity-lending/private/v1/offer", lender_pk ‖ txid ‖
/// vout_le32 ‖ everything before the signature)`, over the first input of the creation
/// transaction, the txid in its internal byte order: it covers the message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedTerms {
    pub terms: OfferTerms,
    pub borrower: XOnlyPublicKey,
    /// The borrower's message to the lender, which is not part of the terms the contract
    /// enforces.
    pub message: Option<Message>,
    pub signature: schnorr::Signature,
}

/// Why encoded terms were rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TermsError {
    /// The version is not [`TERMS_VERSION`].
    UnknownVersion(u8),
    /// The input is shorter than its length field says, or the length is not that of the fields
    /// it frames.
    BadLength,
    /// The message field does not decode.
    Message(MessageError),
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
            Self::Message(e) => write!(f, "unreadable message in the terms: {e}"),
            Self::BadSignature => f.write_str("bad terms signature"),
            Self::Malformed => f.write_str("malformed terms"),
        }
    }
}

impl std::error::Error for TermsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Message(e) => Some(e),
            Self::UnknownVersion(_) | Self::BadLength | Self::BadSignature | Self::Malformed => {
                None
            }
        }
    }
}

impl SignedTerms {
    /// Signs `terms` and `message` with the borrower's lending key for `lender` and the first
    /// input of the creation transaction, with random auxiliary data.
    ///
    /// The message is not checked against
    /// [`MAX_CREATION_MESSAGE_BYTES`](crate::MAX_CREATION_MESSAGE_BYTES), past which the terms do
    /// not fit in the range proof: [`NewOffer::build`](crate::NewOffer::build) checks it.
    ///
    /// The auxiliary data comes from `rand`'s thread RNG, which seeds from the operating system
    /// through `getrandom`: on `wasm32-unknown-unknown` that needs `getrandom`'s `js` feature (see
    /// the crate documentation).
    pub fn sign(
        terms: OfferTerms,
        message: Option<Message>,
        borrower: &LendingKey,
        lender: &XOnlyPublicKey,
        first_input: &OutPoint,
    ) -> SignedTerms {
        let borrower_pk = borrower.x_only_public_key();
        let prefix = signed_prefix(&terms, &borrower_pk, message.as_ref());
        let digest = signed_message(&prefix, lender, first_input);
        let keypair = Keypair::from_secret_key(SECP256K1, &borrower.secret_key());
        let signature = SECP256K1.sign_schnorr_with_aux_rand(&digest, &keypair, &rand::random());

        SignedTerms {
            terms,
            borrower: borrower_pk,
            message,
            signature,
        }
    }

    /// Checks that the key in `borrower` signed the terms for `lender` and `first_input`.
    ///
    /// It proves only that the embedded `borrower` key signed, whoever that is: a caller that
    /// expects a particular borrower compares `borrower` with that key itself.
    pub fn verify(
        &self,
        lender: &XOnlyPublicKey,
        first_input: &OutPoint,
    ) -> Result<(), TermsError> {
        let prefix = signed_prefix(&self.terms, &self.borrower, self.message.as_ref());
        let digest = signed_message(&prefix, lender, first_input);

        SECP256K1
            .verify_schnorr(&self.signature, &digest, &self.borrower)
            .map_err(|_| TermsError::BadSignature)
    }

    /// The encoding, 218 bytes with no message and 221 plus the text's length with one.
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = signed_prefix(&self.terms, &self.borrower, self.message.as_ref());
        bytes.extend_from_slice(self.signature.as_ref());
        bytes
    }

    /// Decodes terms from the start of `bytes`, ignoring the bytes after the length the encoding
    /// declares, such as the zero padding of a rewound range proof message.
    ///
    /// The version and the length frame the encoding, so an input shorter than its declared length
    /// is [`TermsError::BadLength`] whatever its version. The message field must fill the length
    /// exactly, up to the signature, and a message that does not decode is
    /// [`TermsError::Message`]. The signature is not checked; see [`SignedTerms::verify`].
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
        // the shortest body holds the field's single byte `0`
        if body.len() < FIXED_BODY_LENGTH + 1 + SIGNATURE_LENGTH {
            return Err(TermsError::BadLength);
        }
        let (fixed, rest) = body.split_at(FIXED_BODY_LENGTH);
        let (field, signature) = rest.split_at(rest.len() - SIGNATURE_LENGTH);
        let (message, field_length) = decode_field(field).map_err(TermsError::Message)?;
        if field_length != field.len() {
            return Err(TermsError::BadLength);
        }

        let mut reader = Reader(fixed);
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
        let signature =
            schnorr::Signature::from_slice(signature).map_err(|_| TermsError::Malformed)?;

        Ok(SignedTerms {
            terms,
            borrower,
            message,
            signature,
        })
    }
}

/// The encoding before the signature, the part the signature covers: the fixed fields and the
/// message field.
fn signed_prefix(
    terms: &OfferTerms,
    borrower: &XOnlyPublicKey,
    message: Option<&Message>,
) -> Vec<u8> {
    let mut field = Vec::new();
    push_field(&mut field, message);
    let length = u16::try_from(FIXED_BODY_LENGTH + field.len() + SIGNATURE_LENGTH)
        .expect("a message is at most MESSAGE_ROOM bytes, see Message::text");

    let mut bytes = Vec::with_capacity(FIXED_LENGTH + field.len() + SIGNATURE_LENGTH);
    bytes.push(TERMS_VERSION);
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(&terms.principal_asset.into_inner().to_byte_array());
    bytes.extend_from_slice(&terms.principal_amount.to_be_bytes());
    bytes.extend_from_slice(&terms.repayment_amount.to_be_bytes());
    bytes.extend_from_slice(&terms.interest_rate_bps.to_be_bytes());
    bytes.extend_from_slice(&terms.loan_expiration_time.to_be_bytes());
    bytes.extend_from_slice(&terms.borrower_nft.into_inner().to_byte_array());
    bytes.extend_from_slice(&terms.lender_nft.into_inner().to_byte_array());
    bytes.extend_from_slice(&borrower.serialize());
    debug_assert_eq!(bytes.len(), FIXED_LENGTH);
    bytes.extend_from_slice(&field);
    bytes
}

/// The message the borrower signs: `tagged_hash("simplicity-lending/private/v1/offer", lender_pk ‖
/// txid ‖ vout_le32 ‖ signed_prefix)`.
fn signed_message(
    signed_prefix: &[u8],
    lender: &XOnlyPublicKey,
    first_input: &OutPoint,
) -> secp256k1_zkp::Message {
    let digest = tagged_hash(
        OFFER_TAG,
        &[
            &lender.serialize(),
            first_input.txid.as_byte_array(),
            &first_input.vout.to_le_bytes(),
            signed_prefix,
        ],
    );

    secp256k1_zkp::Message::from_digest(digest)
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

    use elements::hex::ToHex;
    use elements::{AssetId, Txid};

    use super::*;
    use crate::test_util::sequence;
    use crate::{MAX_CREATION_MESSAGE_BYTES, MESSAGE_ROOM};

    static BORROWER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[1; 32]));
    static LENDER: LazyLock<XOnlyPublicKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[2; 32]).x_only_public_key());
    static OTHER_LENDER: LazyLock<XOnlyPublicKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[3; 32]).x_only_public_key());
    /// The txid bytes 0x00..=0x1f in internal order and a vout whose bytes differ, so a byte
    /// order mistake changes the signed message.
    static OUTPOINT_A: LazyLock<OutPoint> =
        LazyLock::new(|| OutPoint::new(Txid::from_byte_array(sequence(0x00)), 0x0102_0304));
    static OUTPOINT_B: LazyLock<OutPoint> =
        LazyLock::new(|| OutPoint::new(Txid::from_byte_array(sequence(0x00)), 0x0102_0305));

    fn sample_terms() -> OfferTerms {
        OfferTerms {
            principal_asset: AssetId::from_slice(&sequence(0xa0)).unwrap(),
            principal_amount: 0x0102_0304_0506_0708,
            repayment_amount: 0x1112_1314_1516_1718,
            interest_rate_bps: 0x2122,
            loan_expiration_time: 0x3132_3334,
            borrower_nft: AssetId::from_slice(&sequence(0x40)).unwrap(),
            lender_nft: AssetId::from_slice(&sequence(0x60)).unwrap(),
        }
    }

    fn hello() -> Message {
        Message::text("hello").unwrap()
    }

    /// Terms signed by [`BORROWER`] for [`LENDER`] and [`OUTPOINT_A`], with `message`.
    fn signed_with(message: Option<Message>) -> SignedTerms {
        SignedTerms::sign(sample_terms(), message, &BORROWER, &LENDER, &OUTPOINT_A)
    }

    /// Terms signed by [`BORROWER`] for [`LENDER`] and [`OUTPOINT_A`], with no message.
    fn sample_signed() -> SignedTerms {
        signed_with(None)
    }

    #[test]
    fn terms_v2_round_trip_with_and_without_a_message() {
        for (signed, length) in [
            (sample_signed(), 218),
            (signed_with(Some(hello())), 226),
            (
                signed_with(Some(Message::text("two lines\nз емодзі 🙂").unwrap())),
                221 + "two lines\nз емодзі 🙂".len(),
            ),
        ] {
            let mut bytes = signed.encode();
            assert_eq!(bytes.len(), length);
            bytes.extend_from_slice(&[0u8; 2900]); // rewind returns the message padded with zeros
            assert_eq!(SignedTerms::decode(&bytes).unwrap(), signed);
            assert!(signed.verify(&LENDER, &OUTPOINT_A).is_ok());
        }
    }

    #[test]
    fn terms_signature_covers_the_message() {
        let signed = signed_with(Some(hello()));
        let mut bytes = signed.encode();
        bytes[157] ^= 0x20; // "hello" → "Hello"
        let tampered = SignedTerms::decode(&bytes).unwrap();
        assert_eq!(
            tampered.message.as_ref().map(Message::as_text),
            Some("Hello")
        );
        assert_eq!(
            tampered.verify(&LENDER, &OUTPOINT_A),
            Err(TermsError::BadSignature)
        );

        // dropping the message, or adding one, breaks the signature too
        let dropped = SignedTerms {
            message: None,
            ..signed.clone()
        };
        assert_eq!(
            dropped.verify(&LENDER, &OUTPOINT_A),
            Err(TermsError::BadSignature)
        );
        let added = SignedTerms {
            message: Some(hello()),
            ..sample_signed()
        };
        assert_eq!(
            added.verify(&LENDER, &OUTPOINT_A),
            Err(TermsError::BadSignature)
        );
    }

    #[test]
    fn longest_creation_message_fits() {
        let longest = Message::text(&"a".repeat(MAX_CREATION_MESSAGE_BYTES)).unwrap();
        let signed = signed_with(Some(longest));
        let bytes = signed.encode();
        assert_eq!(bytes.len(), MESSAGE_ROOM);
        assert_eq!(SignedTerms::decode(&bytes).unwrap(), signed);
    }

    #[test]
    fn version_1_terms_are_refused() {
        let mut bytes = sample_signed().encode();
        bytes[0] = 1;
        assert_eq!(
            SignedTerms::decode(&bytes),
            Err(TermsError::UnknownVersion(1))
        );

        // a v1 encoding, 217 bytes with no message field
        let mut v1 = vec![1, 0, 214];
        v1.extend_from_slice(&[0x11; 214]);
        v1.extend_from_slice(&[0; 3000]);
        assert_eq!(SignedTerms::decode(&v1), Err(TermsError::UnknownVersion(1)));
    }

    #[test]
    fn crafted_message_fields_are_refused() {
        let signed = signed_with(Some(hello()));
        let with = |at: usize, byte: u8| {
            let mut bytes = signed.encode();
            bytes[at] = byte;
            SignedTerms::decode(&bytes)
        };

        assert_eq!(
            with(153, 2),
            Err(TermsError::Message(MessageError::UnknownVersion(2)))
        );
        assert_eq!(
            with(154, 2),
            Err(TermsError::Message(MessageError::UnknownKind(2)))
        );
        assert_eq!(
            with(157, 0xff),
            Err(TermsError::Message(MessageError::NotUtf8))
        );
        // a text length that runs into the signature, or past the terms
        assert_eq!(
            with(156, 6),
            Err(TermsError::Message(MessageError::BadLength))
        );
        assert_eq!(
            with(155, 0x10),
            Err(TermsError::Message(MessageError::BadLength))
        );
        // a text length that leaves a byte between the message and the signature
        assert_eq!(with(156, 4), Err(TermsError::BadLength));
        // a length field that leaves room between the message and the signature
        let mut bytes = signed.encode();
        bytes[2] += 1;
        bytes.push(0);
        assert_eq!(SignedTerms::decode(&bytes), Err(TermsError::BadLength));
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
        bytes[0] = 3;
        assert!(matches!(
            SignedTerms::decode(&bytes),
            Err(TermsError::UnknownVersion(3))
        ));
        assert!(matches!(
            SignedTerms::decode(&bytes[..100]),
            Err(TermsError::BadLength)
        ));
    }

    #[test]
    fn encoding_follows_the_v2_layout() {
        let signed = signed_with(Some(hello()));
        let bytes = signed.encode();

        assert_eq!(bytes[0..3], [2, 0, 223]);
        assert_eq!(bytes[3..35], sequence(0xa0));
        assert_eq!(bytes[35..43], [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(
            bytes[43..51],
            [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18]
        );
        assert_eq!(bytes[51..53], [0x21, 0x22]);
        assert_eq!(bytes[53..57], [0x31, 0x32, 0x33, 0x34]);
        assert_eq!(bytes[57..89], sequence(0x40));
        assert_eq!(bytes[89..121], sequence(0x60));
        assert_eq!(bytes[121..153], BORROWER.x_only_public_key().serialize());
        assert_eq!(bytes[153..162], [1, 1, 0, 5, b'h', b'e', b'l', b'l', b'o']);

        // the signature covers lender_pk ‖ txid ‖ vout_le32 ‖ bytes 0..162
        let digest = tagged_hash(
            "simplicity-lending/private/v1/offer",
            &[
                &LENDER.serialize(),
                &sequence(0x00),
                &[0x04, 0x03, 0x02, 0x01],
                &bytes[..162],
            ],
        );
        let signature = schnorr::Signature::from_slice(&bytes[162..226]).unwrap();
        assert!(
            SECP256K1
                .verify_schnorr(
                    &signature,
                    &secp256k1_zkp::Message::from_digest(digest),
                    &BORROWER.x_only_public_key()
                )
                .is_ok()
        );

        // with no message, the field is the single byte 0
        let bytes = sample_signed().encode();
        assert_eq!(bytes[0..3], [2, 0, 215]);
        assert_eq!(bytes[153], 0);
        assert_eq!(bytes.len(), 218);
    }

    #[test]
    fn bad_length_field_and_invalid_borrower_key_are_rejected() {
        let mut bytes = sample_signed().encode();
        bytes[2] = 214;
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

    /// The frozen message the borrower signs for the sample terms with the message `"hello"`,
    /// computed apart from this crate, so a change of tag, field order or byte order fails.
    #[test]
    fn signing_digest_known_answer() {
        let prefix = signed_prefix(
            &sample_terms(),
            &BORROWER.x_only_public_key(),
            Some(&hello()),
        );
        let message = signed_message(&prefix, &LENDER, &OUTPOINT_A);

        assert_eq!(
            message.as_ref().to_hex(),
            "c749222bd3357b5e04e117a7b481dc5668f2c820a7ba5386b4052bf9ae966fc5"
        );
    }
}
