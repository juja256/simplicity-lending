//! Error strings for the JavaScript boundary: `<code>: <message>`.
//!
//! No exported function builds a `JsValue` or `JsError`, since those panic outside wasm.

use std::fmt::Display;

use elements::hex::{FromHex, ToHex};
use private_lending_core::{CreationError, OpenError};

/// The error string `<code>: <message>`.
pub(crate) fn err(code: &str, message: impl Display) -> String {
    format!("{code}: {message}")
}

/// A `bad-input` error: the caller passed something malformed.
pub(crate) fn bad_input(message: impl Display) -> String {
    err("bad-input", message)
}

/// The code of an open error. `view-tag-mismatch`, `not-mine` and `rewind-failed` mean the offer
/// is not addressed to this key; `terms-invalid` and `collateral-mismatch` mean it is, but invalid.
pub(crate) fn open_error_code(error: &OpenError) -> &'static str {
    match error {
        OpenError::ViewTagMismatch => "view-tag-mismatch",
        OpenError::NotMine => "not-mine",
        OpenError::Rewind(_) => "rewind-failed",
        OpenError::Terms(_) => "terms-invalid",
        OpenError::CollateralMismatch => "collateral-mismatch",
    }
}

/// The code of a creation error.
pub(crate) fn creation_error_code(error: &CreationError) -> &'static str {
    match error {
        CreationError::NotFound => "not-found",
        CreationError::Open(open) => open_error_code(open),
        CreationError::InvalidTerms => "invalid-terms",
        CreationError::LenderNftNotUnique => "lender-nft-not-unique",
        CreationError::NftOutputMismatch => "nft-output-mismatch",
    }
}

/// The error string of a creation error.
pub(crate) fn creation_error(error: CreationError) -> String {
    err(creation_error_code(&error), error)
}

/// Decodes hex of either case, ignoring surrounding whitespace.
pub(crate) fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    Vec::<u8>::from_hex(hex.trim()).map_err(|_| bad_input("not a hex string"))
}

/// Decodes exactly `N` bytes of hex.
pub(crate) fn decode_hex_array<const N: usize>(hex: &str) -> Result<[u8; N], String> {
    decode_hex(hex)?
        .try_into()
        .map_err(|_| bad_input(format!("expected {N} bytes of hex")))
}

/// Lowercase hex of the bytes.
pub(crate) fn encode_hex(bytes: &[u8]) -> String {
    bytes.to_hex()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_errors_map_to_their_codes() {
        assert_eq!(
            creation_error_code(&CreationError::Open(OpenError::NotMine)),
            "not-mine"
        );
        assert_eq!(creation_error_code(&CreationError::NotFound), "not-found");
        assert!(creation_error(CreationError::InvalidTerms).starts_with("invalid-terms: "));
    }

    #[test]
    fn hex_round_trips_in_either_case() {
        assert_eq!(decode_hex(" 0aFf\n").unwrap(), vec![0x0a, 0xff]);
        assert_eq!(encode_hex(&[0x0a, 0xff]), "0aff");
        assert!(decode_hex("abc").is_err());
        assert!(decode_hex_array::<2>("0a").is_err());
    }

    #[test]
    fn signs_and_odd_digits_are_not_hex() {
        for bad in ["+a", "+a+b", "-a", "+abc", "0x"] {
            let error = decode_hex(bad).unwrap_err();
            assert!(error.starts_with("bad-input:"), "{bad}: {error}");
        }
    }
}
