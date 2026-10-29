//! Recognizing the offers that are addressed to a lending key, before opening them.

use elements::AssetId;
use elements::OutPoint;
use elements::secp256k1_zkp::{PublicKey, SECP256K1};
use private_lending_core::{OfferSecrets, ephemeral_key};
use wasm_bindgen::prelude::*;

use crate::error::{bad_input, decode_hex_array};
use crate::keys::LendingKey;

fn parse_nonce(nonce_hex: &str) -> Result<PublicKey, String> {
    let bytes = decode_hex_array::<33>(nonce_hex)?;
    PublicKey::from_slice(&bytes)
        .map_err(|e| bad_input(format!("the nonce is not a public key: {e}")))
}

pub(crate) fn parse<T: std::str::FromStr>(what: &str, value: &str) -> Result<T, String>
where
    T::Err: std::fmt::Display,
{
    value
        .trim()
        .parse()
        .map_err(|e| bad_input(format!("bad {what}: {e}")))
}

/// Whether the marker's view tag is the one this lender's shared secret with the offer's nonce
/// gives. A cheap filter: one in 256 other offers passes it.
#[wasm_bindgen(js_name = viewTagMatches)]
pub fn view_tag_matches(
    lender: &LendingKey,
    nonce_hex: &str,
    view_tag: u8,
) -> Result<bool, String> {
    let nonce = parse_nonce(nonce_hex)?;
    Ok(OfferSecrets::for_lender(lender.inner(), &nonce).view_tag() == view_tag)
}

/// Whether the offer's nonce is this borrower's ephemeral public key for the creation
/// transaction's first input (`"<txid>:<vout>"`) and the two NFTs it issues.
#[wasm_bindgen(js_name = isOwnCandidate)]
pub fn is_own_candidate(
    borrower: &LendingKey,
    first_input: &str,
    borrower_nft: &str,
    lender_nft: &str,
    nonce_hex: &str,
) -> Result<bool, String> {
    let nonce = parse_nonce(nonce_hex)?;
    let first_input: OutPoint = parse("first input", first_input)?;
    let borrower_nft: AssetId = parse("borrower NFT", borrower_nft)?;
    let lender_nft: AssetId = parse("lender NFT", lender_nft)?;

    let ephemeral = ephemeral_key(borrower.inner(), &first_input, borrower_nft, lender_nft);
    Ok(ephemeral.public_key(SECP256K1) == nonce)
}

/// The program id of private lending offers: the first 4 bytes of the SHA-256 of the program
/// source, 8 hex characters. It is the first field of the marker.
#[wasm_bindgen(js_name = privateLendingProgramId)]
pub fn private_lending_program_id() -> String {
    crate::program_id_hex()
}

#[cfg(test)]
mod tests {
    use super::*;
    use elements::encode::deserialize;
    use lending_contracts::programs::private_lending::PrivateLendingOffer;
    use lending_contracts::programs::program::SimplexProgram;
    use private_lending_core::find_offer;

    fn fixture() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../web/scripts/fixtures/private-lending-parity.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn key_of(fixture: &serde_json::Value, field: &str) -> LendingKey {
        LendingKey::from_master_blinding_key(fixture[field].as_str().unwrap()).unwrap()
    }

    #[test]
    fn scanning_recognizes_the_fixture_offer() {
        let fixture = fixture();
        let tx_bytes = crate::error::decode_hex(fixture["creation_tx"].as_str().unwrap()).unwrap();
        let tx: elements::Transaction = deserialize(&tx_bytes).unwrap();
        let found = find_offer(&tx, PrivateLendingOffer::get_program_id()).unwrap();

        let nonce = crate::error::encode_hex(&found.offer.nonce.commitment().unwrap().serialize());
        let first_input = found.first_input.to_string();
        let (borrower_nft, lender_nft) =
            (found.borrower_nft.to_string(), found.lender_nft.to_string());

        let lender = key_of(&fixture, "lender_master_blinding_key");
        let borrower = key_of(&fixture, "borrower_master_blinding_key");
        let other =
            LendingKey::from_master_blinding_key(&crate::error::encode_hex(&[3; 32])).unwrap();

        assert!(view_tag_matches(&lender, &nonce, found.marker.view_tag).unwrap());
        assert!(
            is_own_candidate(&borrower, &first_input, &borrower_nft, &lender_nft, &nonce).unwrap()
        );
        assert!(
            !is_own_candidate(&other, &first_input, &borrower_nft, &lender_nft, &nonce).unwrap()
        );
    }

    #[test]
    fn program_id_matches_the_contract() {
        let expected = crate::error::encode_hex(&PrivateLendingOffer::get_program_id());
        assert_eq!(private_lending_program_id(), expected);
        assert_eq!(fixture()["program_id"].as_str().unwrap(), expected);
    }
}
