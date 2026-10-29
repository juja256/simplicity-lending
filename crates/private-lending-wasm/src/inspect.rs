//! Reading the PSET fields that the private flows check before signing and that LWK's JS API
//! does not expose: the blinding keys, nonces, commitments and blind proofs of outputs, and the
//! issuances of inputs.

use elements::pset::{Input, Output, PartiallySignedTransaction};
use elements::secp256k1_zkp::ZERO_TWEAK;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::error::encode_hex;
use crate::scan::parse;

/// The issuance of an input, or null.
fn issuance_json(input: &Input) -> Value {
    if !input.has_issuance() {
        return Value::Null;
    }
    let (asset_id, token_id) = input.issuance_ids();
    json!({
        "assetId": asset_id.to_string(),
        "tokenId": token_id.to_string(),
        "isReissuance": input.issuance_blinding_nonce.is_some_and(|nonce| nonce != ZERO_TWEAK),
        "amount": input.issuance_value_amount.map(|amount| amount.to_string()),
        "amountCommitment": input
            .issuance_value_comm
            .map(|commitment| encode_hex(&commitment.serialize())),
        "inflationKeys": input.issuance_inflation_keys.map(|amount| amount.to_string()),
        "inflationKeysCommitment": input
            .issuance_inflation_keys_comm
            .map(|commitment| encode_hex(&commitment.serialize())),
        "blindedIssuance": input.blinded_issuance,
    })
}

fn input_json(input: &Input) -> Value {
    json!({
        "prevout": format!("{}:{}", input.previous_txid, input.previous_output_index),
        "issuance": issuance_json(input),
    })
}

fn output_json(output: &Output) -> Value {
    json!({
        "script": encode_hex(output.script_pubkey.as_bytes()),
        "asset": output.asset.map(|asset| asset.to_string()),
        "amount": output.amount.map(|amount| amount.to_string()),
        "assetCommitment": output.asset_comm.map(|generator| encode_hex(&generator.serialize())),
        "amountCommitment": output
            .amount_comm
            .map(|commitment| encode_hex(&commitment.serialize())),
        "ecdhPubkey": output.ecdh_pubkey.map(|key| encode_hex(&key.to_bytes())),
        "blindingKey": output.blinding_key.map(|key| encode_hex(&key.to_bytes())),
        "blinderIndex": output.blinder_index,
        "hasBlindValueProof": output.blind_value_proof.is_some(),
        "hasBlindAssetProof": output.blind_asset_proof.is_some(),
    })
}

/// The fields of a PSET (base64) that the private flows check before signing, as JSON:
/// `{ inputs: [{ prevout, issuance }], outputs: [{ script, asset, amount, assetCommitment,
/// amountCommitment, ecdhPubkey, blindingKey, blinderIndex, hasBlindValueProof,
/// hasBlindAssetProof }] }`.
///
/// `issuance` is null for an input without one, else `{ assetId, tokenId, isReissuance, amount,
/// amountCommitment, inflationKeys, inflationKeysCommitment, blindedIssuance }`. Every absent
/// field is null, never a default. Amounts are decimal strings; asset ids are display-order hex,
/// prevouts `"<txid>:<vout>"`, commitments and keys hex of their 33-byte serialization.
#[wasm_bindgen(js_name = inspectPset)]
pub fn inspect_pset(pset_base64: &str) -> Result<String, String> {
    let pset: PartiallySignedTransaction = parse("PSET", pset_base64)?;
    Ok(json!({
        "inputs": pset.inputs().iter().map(input_json).collect::<Vec<_>>(),
        "outputs": pset.outputs().iter().map(output_json).collect::<Vec<_>>(),
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blind::blind_pset;
    use crate::build::tests::{build_offer, creation_pset};
    use crate::open::PinnedRole;

    fn inspect(pset: &str) -> Value {
        serde_json::from_str(&inspect_pset(pset).unwrap()).unwrap()
    }

    #[test]
    fn inspects_a_creation_before_and_after_blinding() {
        let offer = build_offer(10_000).unwrap();
        let terms = offer.inner.signed_terms.terms;
        let (pset, secrets) = creation_pset(&offer);
        let pinned = offer.pinned(PinnedRole::PendingCollateral);

        let before = inspect(&pset.to_string());
        let inputs = before["inputs"].as_array().unwrap();
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0]["prevout"], format!("{}:1", "07".repeat(32)));
        assert_eq!(inputs[1]["prevout"], format!("{}:1", "ee".repeat(32)));
        for (input, nft) in inputs.iter().zip([terms.borrower_nft, terms.lender_nft]) {
            let issuance = &input["issuance"];
            assert_eq!(issuance["assetId"], nft.to_string());
            assert_eq!(issuance["isReissuance"], false);
            assert_eq!(issuance["amount"], "1");
            assert_eq!(issuance["amountCommitment"], Value::Null);
            assert_eq!(issuance["inflationKeys"], Value::Null);
            assert_eq!(issuance["inflationKeysCommitment"], Value::Null);
            assert_eq!(issuance["blindedIssuance"], 0);
        }

        let outputs = before["outputs"].as_array().unwrap();
        assert_eq!(outputs.len(), 6);
        assert_eq!(outputs[0]["script"], "5110");
        assert_eq!(outputs[0]["asset"], terms.borrower_nft.to_string());
        assert_eq!(outputs[0]["amount"], "1");
        assert_eq!(outputs[3]["amount"], "50000");
        assert_eq!(outputs[3]["blindingKey"], offer.collateral_blinding_key());
        assert_eq!(outputs[3]["blinderIndex"], 0);
        for output in outputs {
            for field in ["assetCommitment", "amountCommitment", "ecdhPubkey"] {
                assert_eq!(output[field], Value::Null, "{field} before blinding");
            }
            assert_eq!(output["hasBlindValueProof"], false);
            assert_eq!(output["hasBlindAssetProof"], false);
        }
        for explicit in [0, 1, 2, 5] {
            assert_eq!(outputs[explicit]["blindingKey"], Value::Null);
            assert_eq!(outputs[explicit]["blinderIndex"], Value::Null);
        }

        let blinded = blind_pset(
            &pset.to_string(),
            secrets,
            vec![offer.collateral_blinding(3)],
        )
        .unwrap();
        let after = inspect(&blinded);
        assert_eq!(after["inputs"], before["inputs"]);
        let outputs = after["outputs"].as_array().unwrap();
        let offer_output = &outputs[3];
        assert_eq!(offer_output["assetCommitment"], pinned.asset_commitment());
        assert_eq!(offer_output["amountCommitment"], pinned.value_commitment());
        assert_eq!(offer_output["blindingKey"], offer.collateral_blinding_key());
        assert_eq!(offer_output["blinderIndex"], 0);
        assert!(offer_output["ecdhPubkey"].is_string());
        assert_eq!(offer_output["hasBlindValueProof"], true);
        assert_eq!(offer_output["hasBlindAssetProof"], true);
        // the change is blinded freshly; the NFTs, the marker and the fee stay explicit
        assert!(outputs[4]["amountCommitment"].is_string());
        assert!(outputs[4]["ecdhPubkey"].is_string());
        for explicit in [0, 1, 2, 5] {
            assert_eq!(outputs[explicit], before["outputs"][explicit]);
        }
    }

    #[test]
    fn inspects_inflation_keys_and_inputs_without_issuance() {
        let offer = build_offer(10_000).unwrap();
        let (mut pset, _) = creation_pset(&offer);
        pset.inputs_mut()[0].issuance_inflation_keys = Some(5);
        pset.inputs_mut()[1].issuance_value_amount = None;
        pset.inputs_mut()[1].blinded_issuance = None;
        pset.inputs_mut()[1].issuance_asset_entropy = None;

        let inspected = inspect(&pset.to_string());
        assert_eq!(inspected["inputs"][0]["issuance"]["inflationKeys"], "5");
        assert_eq!(inspected["inputs"][1]["issuance"], Value::Null);
    }

    #[test]
    fn a_bad_pset_is_rejected() {
        for bad in ["not base64 !!", "cHNldA=="] {
            assert!(inspect_pset(bad).unwrap_err().starts_with("bad-input:"));
        }
    }
}
