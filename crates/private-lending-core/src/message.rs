//! Private messages, carried in the range proofs of a loan's confidential outputs where only the
//! borrower and the lender can read them: the borrower's at creation inside the signed terms, and
//! the signed messages of the acceptance, the installments and the full repayment.

use std::fmt;

use elements::Txid;
use elements::hashes::Hash;
use elements::secp256k1_zkp::{self, Keypair, SECP256K1, XOnlyPublicKey, schnorr};

use crate::{LendingKey, tagged_hash};

/// The bytes a range proof's message carries after the asset id and the asset blinding factor.
pub const MESSAGE_ROOM: usize = 3136;
/// The longest text of a signed message, in bytes: the room less the field's 4 bytes and the
/// signature's 64.
pub const MAX_SIGNED_MESSAGE_BYTES: usize = 3068;
/// The longest text of the creation's message, in bytes: the room less the terms' 153 signed
/// bytes, the field's 4 and the signature's 64.
pub const MAX_CREATION_MESSAGE_BYTES: usize = 2915;

const MESSAGE_TAG: &str = "simplicity-lending/private/v2/message";

/// The version of the message field.
const FIELD_VERSION: u8 = 1;
/// The kind of a text message.
const TEXT_KIND: u8 = 1;
/// The field's header: version, kind and length.
const HEADER_LENGTH: usize = 4;
const SIGNATURE_LENGTH: usize = 64;

/// What a message holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageKind {
    /// UTF-8 text, kind `1`.
    Text,
}

impl MessageKind {
    fn byte(self) -> u8 {
        match self {
            Self::Text => TEXT_KIND,
        }
    }
}

/// A private message: a non-empty UTF-8 text.
///
/// Its field is encoded big-endian as version `1` (1) ‖ kind (1) ‖ length (2) ‖ the text's bytes,
/// and a missing message as the single byte `0`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    kind: MessageKind,
    text: String,
}

impl Message {
    /// A text message.
    ///
    /// # Errors
    /// Returns [`MessageError::Empty`] if `text` is empty, and [`MessageError::TooLong`] if it is
    /// longer than [`MESSAGE_ROOM`] bytes, which no range proof carries. Each channel has a lower
    /// limit, which its sender checks.
    pub fn text(text: &str) -> Result<Message, MessageError> {
        if text.is_empty() {
            return Err(MessageError::Empty);
        }
        if text.len() > MESSAGE_ROOM {
            return Err(MessageError::TooLong {
                length: text.len(),
                max: MESSAGE_ROOM,
            });
        }

        Ok(Message {
            kind: MessageKind::Text,
            text: text.to_owned(),
        })
    }

    pub fn kind(&self) -> MessageKind {
        self.kind
    }

    pub fn as_text(&self) -> &str {
        &self.text
    }
}

/// The step of a loan whose output carries a signed message, which the signature binds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessagePhase {
    /// The lender's message on the principal output of the acceptance.
    Acceptance,
    /// The borrower's message on the installment output of the `j`-th installment, from 1.
    Installment(u32),
    /// The borrower's message on the repayment output of the full repayment.
    FullRepayment,
}

impl MessagePhase {
    /// The phase's bytes in the signed digest: `0x01`, `0x02 ‖ j_be32` or `0x03`.
    fn bytes(self) -> Vec<u8> {
        match self {
            Self::Acceptance => vec![0x01],
            Self::Installment(j) => {
                let mut bytes = vec![0x02];
                bytes.extend_from_slice(&j.to_be_bytes());
                bytes
            }
            Self::FullRepayment => vec![0x03],
        }
    }
}

/// A message with its sender's BIP340 signature, which binds it to one offer and one phase of the
/// loan.
///
/// Encoded as the message field ‖ signature (64), the extra data of the output's range proof. The
/// signature signs `tagged_hash("simplicity-lending/private/v2/message", phase ‖ offer id ‖
/// message field)`, the offer id the creation transaction's txid in its internal byte order and
/// the phase as [`MessagePhase`] gives it, so that the other party, who knows the output's
/// blinders and could remake its range proof, cannot move the message to another offer or
/// another phase unnoticed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedMessage {
    pub message: Message,
    pub signature: schnorr::Signature,
}

/// Why a message was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageError {
    /// The text is empty.
    Empty,
    /// The text is longer than its channel carries.
    TooLong { length: usize, max: usize },
    /// The field's version is not `1`.
    UnknownVersion(u8),
    /// The field's kind is not text.
    UnknownKind(u8),
    /// The field or the signature runs past the input.
    BadLength,
    /// The text is not valid UTF-8.
    NotUtf8,
    /// The signature does not sign the message for this sender, phase and offer.
    BadSignature,
    /// The signature does not parse. `SignedMessage::decode` never gives it: it takes exactly 64
    /// bytes, and any 64 bytes parse as a Schnorr signature (only the check can refuse them).
    Malformed,
}

impl fmt::Display for MessageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("the message is empty"),
            Self::TooLong { length, max } => {
                write!(f, "the message is {length} bytes, longer than {max}")
            }
            Self::UnknownVersion(version) => write!(f, "unknown message version {version}"),
            Self::UnknownKind(kind) => write!(f, "unknown message kind {kind}"),
            Self::BadLength => f.write_str("bad message length"),
            Self::NotUtf8 => f.write_str("the message is not UTF-8 text"),
            Self::BadSignature => f.write_str("bad message signature"),
            Self::Malformed => f.write_str("malformed message signature"),
        }
    }
}

impl std::error::Error for MessageError {}

impl SignedMessage {
    /// Signs `message` with the sender's lending key for `phase` of the offer whose creation
    /// transaction is `offer_id`, with random auxiliary data (see [`crate::SignedTerms::sign`]).
    ///
    /// # Errors
    /// Returns [`MessageError::TooLong`] if the text is longer than
    /// [`MAX_SIGNED_MESSAGE_BYTES`].
    pub fn sign(
        message: Message,
        sender: &LendingKey,
        phase: MessagePhase,
        offer_id: &Txid,
    ) -> Result<SignedMessage, MessageError> {
        let length = message.text.len();
        if length > MAX_SIGNED_MESSAGE_BYTES {
            return Err(MessageError::TooLong {
                length,
                max: MAX_SIGNED_MESSAGE_BYTES,
            });
        }

        let mut field = Vec::with_capacity(HEADER_LENGTH + length);
        push_field(&mut field, Some(&message));
        let digest = signed_digest(phase, offer_id, &field);
        let keypair = Keypair::from_secret_key(SECP256K1, &sender.secret_key());
        let signature = SECP256K1.sign_schnorr_with_aux_rand(&digest, &keypair, &rand::random());

        Ok(SignedMessage { message, signature })
    }

    /// Checks that `sender` signed the message for `phase` of the offer `offer_id`.
    pub fn verify(
        &self,
        sender: &XOnlyPublicKey,
        phase: MessagePhase,
        offer_id: &Txid,
    ) -> Result<(), MessageError> {
        let mut field = Vec::new();
        push_field(&mut field, Some(&self.message));
        let digest = signed_digest(phase, offer_id, &field);

        SECP256K1
            .verify_schnorr(&self.signature, &digest, sender)
            .map_err(|_| MessageError::BadSignature)
    }

    /// The encoding, the field and the signature.
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes =
            Vec::with_capacity(HEADER_LENGTH + self.message.text.len() + SIGNATURE_LENGTH);
        push_field(&mut bytes, Some(&self.message));
        bytes.extend_from_slice(self.signature.as_ref());
        bytes
    }

    /// Decodes a signed message from the start of a range proof's extra data, ignoring the bytes
    /// after it, such as the zero padding of a rewound range proof message.
    ///
    /// Returns `None` when the extra data is empty or starts with `0`: the output carries no
    /// message. The signature is not checked; see [`SignedMessage::verify`].
    pub fn decode(extra_data: &[u8]) -> Result<Option<SignedMessage>, MessageError> {
        if extra_data.is_empty() {
            return Ok(None);
        }
        let (Some(message), field_length) = decode_field(extra_data)? else {
            return Ok(None);
        };
        let signature = extra_data
            .get(field_length..field_length + SIGNATURE_LENGTH)
            .ok_or(MessageError::BadLength)?;
        let signature =
            schnorr::Signature::from_slice(signature).map_err(|_| MessageError::Malformed)?;

        Ok(Some(SignedMessage { message, signature }))
    }
}

/// Appends the message field of `message`, or the single byte `0` for none.
pub(crate) fn push_field(bytes: &mut Vec<u8>, message: Option<&Message>) {
    let Some(message) = message else {
        bytes.push(0);
        return;
    };
    let length = u16::try_from(message.text.len())
        .expect("a message is at most MESSAGE_ROOM bytes, see Message::text");

    bytes.push(FIELD_VERSION);
    bytes.push(message.kind.byte());
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(message.text.as_bytes());
}

/// Decodes a message field from the start of `bytes`: the message, or none, and the field's
/// length.
///
/// The checks run in the order of the field, so that each crafted field gets its own error: the
/// version, the kind, the length against `bytes` and against [`MESSAGE_ROOM`], then the text.
pub(crate) fn decode_field(bytes: &[u8]) -> Result<(Option<Message>, usize), MessageError> {
    match bytes.first() {
        None => return Err(MessageError::BadLength),
        Some(0) => return Ok((None, 1)),
        Some(&FIELD_VERSION) => {}
        Some(&version) => return Err(MessageError::UnknownVersion(version)),
    }
    let kind = match bytes.get(1) {
        None => return Err(MessageError::BadLength),
        Some(&TEXT_KIND) => MessageKind::Text,
        Some(&kind) => return Err(MessageError::UnknownKind(kind)),
    };
    let length = bytes
        .get(2..HEADER_LENGTH)
        .map(|length| usize::from(u16::from_be_bytes([length[0], length[1]])))
        .ok_or(MessageError::BadLength)?;
    let text = bytes
        .get(HEADER_LENGTH..HEADER_LENGTH + length)
        .ok_or(MessageError::BadLength)?;
    // no range proof carries more, and a longer message would break `Message::text`'s bound
    if length > MESSAGE_ROOM {
        return Err(MessageError::TooLong {
            length,
            max: MESSAGE_ROOM,
        });
    }
    if text.is_empty() {
        return Err(MessageError::Empty);
    }
    let text = std::str::from_utf8(text).map_err(|_| MessageError::NotUtf8)?;

    let message = Message {
        kind,
        text: text.to_owned(),
    };
    Ok((Some(message), HEADER_LENGTH + length))
}

/// The digest the sender signs: `tagged_hash("simplicity-lending/private/v2/message", phase ‖
/// offer id ‖ message field)`.
fn signed_digest(phase: MessagePhase, offer_id: &Txid, field: &[u8]) -> secp256k1_zkp::Message {
    let digest = tagged_hash(
        MESSAGE_TAG,
        &[&phase.bytes(), offer_id.as_byte_array(), field],
    );

    secp256k1_zkp::Message::from_digest(digest)
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use elements::hex::ToHex;

    use super::*;
    use crate::test_util::sequence;

    static SENDER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[1; 32]));
    /// The txid bytes 0x00..=0x1f in internal order.
    static OFFER_ID: LazyLock<Txid> = LazyLock::new(|| Txid::from_byte_array(sequence(0x00)));
    static OTHER_OFFER_ID: LazyLock<Txid> = LazyLock::new(|| Txid::from_byte_array(sequence(0x01)));

    fn field(message: Option<&Message>) -> Vec<u8> {
        let mut bytes = Vec::new();
        push_field(&mut bytes, message);
        bytes
    }

    fn signed(text: &str, phase: MessagePhase) -> SignedMessage {
        SignedMessage::sign(Message::text(text).unwrap(), &SENDER, phase, &OFFER_ID).unwrap()
    }

    #[test]
    fn message_field_round_trip_with_zero_padding() {
        let text = "two lines\nwith an emoji 🙂 and Кирилиця";
        let message = Message::text(text).unwrap();
        let mut bytes = field(Some(&message));
        assert_eq!(bytes[..4], [1, 1, 0, text.len() as u8]);
        assert_eq!(&bytes[4..], text.as_bytes());

        let length = bytes.len();
        bytes.extend_from_slice(&[0; 3000]); // rewind returns the message padded with zeros
        let (decoded, consumed) = decode_field(&bytes).unwrap();
        assert_eq!(decoded.as_ref().map(Message::as_text), Some(text));
        assert_eq!(decoded.unwrap().kind(), MessageKind::Text);
        assert_eq!(consumed, length);

        assert_eq!(field(None), [0]);
        assert_eq!(decode_field(&[0; 100]).unwrap(), (None, 1));

        let signed = signed(text, MessagePhase::Acceptance);
        let mut bytes = signed.encode();
        assert_eq!(bytes.len(), length + 64);
        bytes.extend_from_slice(&[0; 2000]);
        assert_eq!(SignedMessage::decode(&bytes).unwrap(), Some(signed));
        assert_eq!(SignedMessage::decode(&[0; MESSAGE_ROOM]).unwrap(), None);
        assert_eq!(SignedMessage::decode(&[]).unwrap(), None);
    }

    #[test]
    fn empty_text_is_refused() {
        assert_eq!(Message::text(""), Err(MessageError::Empty));
    }

    /// The frozen digest the sender signs for a fixed offer id, `Installment(2)` and `"hello"`,
    /// computed apart from this crate, so a change of tag, phase bytes or order fails.
    #[test]
    fn signed_message_known_answer() {
        let message = Message::text("hello").unwrap();
        let digest = signed_digest(
            MessagePhase::Installment(2),
            &OFFER_ID,
            &field(Some(&message)),
        );
        assert_eq!(
            digest.as_ref().to_hex(),
            "e528fbf1044a167e1f23310f92ac51e639a68babaab04a3860868043269bdb25"
        );

        let signed = signed("hello", MessagePhase::Installment(2));
        assert!(
            SECP256K1
                .verify_schnorr(&signed.signature, &digest, &SENDER.x_only_public_key())
                .is_ok()
        );
        let bytes = signed.encode();
        assert_eq!(bytes[..9], [1, 1, 0, 5, b'h', b'e', b'l', b'l', b'o']);
        assert_eq!(bytes[9..], *signed.signature.as_ref());
    }

    #[test]
    fn signature_binds_phase_offer_and_installment() {
        let sender = SENDER.x_only_public_key();
        let other_sender = LendingKey::from_master_blinding_key(&[2; 32]).x_only_public_key();

        let acceptance = signed("hello", MessagePhase::Acceptance);
        assert_eq!(
            acceptance.verify(&sender, MessagePhase::Acceptance, &OFFER_ID),
            Ok(())
        );
        assert_eq!(
            acceptance.verify(&sender, MessagePhase::FullRepayment, &OFFER_ID),
            Err(MessageError::BadSignature)
        );
        assert_eq!(
            acceptance.verify(&sender, MessagePhase::Acceptance, &OTHER_OFFER_ID),
            Err(MessageError::BadSignature)
        );
        assert_eq!(
            acceptance.verify(&other_sender, MessagePhase::Acceptance, &OFFER_ID),
            Err(MessageError::BadSignature)
        );

        let first = signed("hello", MessagePhase::Installment(1));
        assert_eq!(
            first.verify(&sender, MessagePhase::Installment(1), &OFFER_ID),
            Ok(())
        );
        assert_eq!(
            first.verify(&sender, MessagePhase::Installment(2), &OFFER_ID),
            Err(MessageError::BadSignature)
        );
        assert_eq!(
            first.verify(&sender, MessagePhase::FullRepayment, &OFFER_ID),
            Err(MessageError::BadSignature)
        );

        let repayment = signed("hello", MessagePhase::FullRepayment);
        assert_eq!(
            repayment.verify(&sender, MessagePhase::Acceptance, &OFFER_ID),
            Err(MessageError::BadSignature)
        );

        // a changed text, and a missing signature, decode but do not verify
        let mut bytes = acceptance.encode();
        bytes[4] ^= 1;
        let tampered = SignedMessage::decode(&bytes).unwrap().unwrap();
        assert_eq!(
            tampered.verify(&sender, MessagePhase::Acceptance, &OFFER_ID),
            Err(MessageError::BadSignature)
        );
        let mut bytes = acceptance.encode();
        bytes[9..].fill(0);
        let unsigned = SignedMessage::decode(&bytes).unwrap().unwrap();
        assert_eq!(
            unsigned.verify(&sender, MessagePhase::Acceptance, &OFFER_ID),
            Err(MessageError::BadSignature)
        );
    }

    #[test]
    fn decode_refuses_crafted_fields() {
        let valid = signed("hello", MessagePhase::Acceptance).encode();
        let with = |at: usize, byte: u8| {
            let mut bytes = valid.clone();
            bytes[at] = byte;
            bytes.extend_from_slice(&[0; 100]);
            SignedMessage::decode(&bytes)
        };

        assert_eq!(with(0, 2), Err(MessageError::UnknownVersion(2)));
        assert_eq!(with(1, 2), Err(MessageError::UnknownKind(2)));
        assert_eq!(with(1, 0), Err(MessageError::UnknownKind(0)));
        // a length past the buffer, and a text with no room left for the signature
        let mut too_long = valid.clone();
        too_long[2..4].copy_from_slice(&u16::MAX.to_be_bytes());
        assert_eq!(
            SignedMessage::decode(&too_long),
            Err(MessageError::BadLength)
        );
        assert_eq!(
            SignedMessage::decode(&valid[..valid.len() - 1]),
            Err(MessageError::BadLength)
        );
        assert_eq!(
            SignedMessage::decode(&[1, 1, 0]),
            Err(MessageError::BadLength)
        );
        // an invalid UTF-8 byte, and an overlong encoding of `/`
        assert_eq!(with(4, 0xff), Err(MessageError::NotUtf8));
        let overlong = [1, 1, 0, 2, 0xc0, 0xaf];
        assert_eq!(decode_field(&overlong), Err(MessageError::NotUtf8));
        // a text longer than any range proof carries
        let mut over_room = vec![1, 1];
        over_room.extend_from_slice(&((MESSAGE_ROOM + 1) as u16).to_be_bytes());
        over_room.extend_from_slice(&[b'a'; MESSAGE_ROOM + 1 + 64]);
        assert_eq!(
            SignedMessage::decode(&over_room),
            Err(MessageError::TooLong {
                length: MESSAGE_ROOM + 1,
                max: MESSAGE_ROOM,
            })
        );
        // an empty text
        let mut empty = vec![1, 1, 0, 0];
        empty.extend_from_slice(&[0; 64]);
        assert_eq!(SignedMessage::decode(&empty), Err(MessageError::Empty));
    }

    #[test]
    fn longest_messages_fit() {
        let longest = "a".repeat(MAX_SIGNED_MESSAGE_BYTES);
        let encoded = signed(&longest, MessagePhase::FullRepayment).encode();
        assert_eq!(encoded.len(), MESSAGE_ROOM);

        let over = Message::text(&"a".repeat(MAX_SIGNED_MESSAGE_BYTES + 1)).unwrap();
        assert_eq!(
            SignedMessage::sign(over, &SENDER, MessagePhase::FullRepayment, &OFFER_ID),
            Err(MessageError::TooLong {
                length: MAX_SIGNED_MESSAGE_BYTES + 1,
                max: MAX_SIGNED_MESSAGE_BYTES,
            })
        );
        // counted in UTF-8 bytes: 767 emojis are 3068 bytes
        let emojis = "🙂".repeat(MAX_SIGNED_MESSAGE_BYTES / 4);
        assert_eq!(emojis.len(), MAX_SIGNED_MESSAGE_BYTES);
        assert!(
            SignedMessage::sign(
                Message::text(&format!("{emojis}a")).unwrap(),
                &SENDER,
                MessagePhase::Acceptance,
                &OFFER_ID
            )
            .is_err()
        );

        // no range proof carries more than the room
        assert_eq!(
            Message::text(&"a".repeat(MESSAGE_ROOM + 1)),
            Err(MessageError::TooLong {
                length: MESSAGE_ROOM + 1,
                max: MESSAGE_ROOM,
            })
        );
    }
}
