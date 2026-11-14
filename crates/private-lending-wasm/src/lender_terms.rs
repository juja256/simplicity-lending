//! Lender terms and the check of a borrower's proposal against them, as JSON.
//!
//! Terms are `{"pairs": [<pair>, ...]}` and a proposal is one object, with the field names of
//! [`PairTerms`] and [`Proposal`]: `u64` amounts as decimal strings, `u32` fields as JSON numbers
//! and asset ids as display hex. Every field is required and no other is allowed. A breach is named
//! by [`TermBreach::name`].

use elements::AssetId;
use private_lending_core::{LenderTerms, PairTerms, Proposal, TermBreach};
use serde_json::{Map, Value, json};
use wasm_bindgen::prelude::*;

use crate::error::{bad_input, decode_hex, encode_hex};

/// A JSON object whose fields are taken one by one; [`Fields::finish`] refuses the keys left.
/// Errors name the field by its path, such as `terms.pairs[0].min_apr_bps`.
struct Fields {
    path: String,
    map: Map<String, Value>,
}

impl Fields {
    fn new(path: String, value: Value) -> Result<Self, String> {
        match value {
            Value::Object(map) => Ok(Self { path, map }),
            _ => Err(bad_input(format!("{path} is not a JSON object"))),
        }
    }

    fn path(&self, key: &str) -> String {
        format!("{}.{key}", self.path)
    }

    fn take(&mut self, key: &str) -> Result<Value, String> {
        self.map
            .remove(key)
            .ok_or_else(|| bad_input(format!("{} is missing", self.path(key))))
    }

    /// A `u64`, written as a string of decimal digits.
    fn amount(&mut self, key: &str) -> Result<u64, String> {
        let path = self.path(key);
        match self.take(key)? {
            Value::String(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => {
                text.parse()
                    .map_err(|_| bad_input(format!("{path} is above {}", u64::MAX)))
            }
            _ => Err(bad_input(format!(
                "{path} is not a string of decimal digits"
            ))),
        }
    }

    /// A `u32`, written as a JSON number.
    fn number(&mut self, key: &str) -> Result<u32, String> {
        let path = self.path(key);
        // `as_u64` is `None` for a negative number and for one written with a fraction or an
        // exponent, such as `7.0`
        self.take(key)?
            .as_u64()
            .and_then(|number| u32::try_from(number).ok())
            .ok_or_else(|| bad_input(format!("{path} is not an integer from 0 to {}", u32::MAX)))
    }

    /// An asset id, written as 64 hex characters in display order.
    fn asset(&mut self, key: &str) -> Result<AssetId, String> {
        let path = self.path(key);
        match self.take(key)? {
            Value::String(text)
                if text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()) =>
            {
                text.parse()
                    .map_err(|e| bad_input(format!("{path} is not an asset id: {e}")))
            }
            _ => Err(bad_input(format!("{path} is not 64 hex characters"))),
        }
    }

    fn finish(self) -> Result<(), String> {
        match self.map.keys().next() {
            Some(key) => Err(bad_input(format!(
                "{} is not a known field",
                self.path(key)
            ))),
            None => Ok(()),
        }
    }
}

fn parse_json(what: &str, json: &str) -> Result<Value, String> {
    serde_json::from_str(json).map_err(|e| bad_input(format!("{what} is not JSON: {e}")))
}

fn parse_pair(path: String, value: Value) -> Result<PairTerms, String> {
    let mut fields = Fields::new(path, value)?;
    let pair = PairTerms {
        principal_asset: fields.asset("principal_asset")?,
        collateral_asset: fields.asset("collateral_asset")?,
        min_apr_bps: fields.number("min_apr_bps")?,
        max_principal_per_collateral: fields.amount("max_principal_per_collateral")?,
        min_term_days: fields.number("min_term_days")?,
        max_term_days: fields.number("max_term_days")?,
        min_principal: fields.amount("min_principal")?,
        max_principal: fields.amount("max_principal")?,
    };
    fields.finish()?;
    Ok(pair)
}

/// Parses terms JSON and checks them with [`LenderTerms::validate`], so any terms the wasm takes
/// are terms [`LenderTerms::decode`] accepts.
pub(crate) fn parse_terms(json: &str) -> Result<LenderTerms, String> {
    let mut fields = Fields::new("terms".into(), parse_json("terms", json)?)?;
    let Value::Array(pairs) = fields.take("pairs")? else {
        return Err(bad_input("terms.pairs is not a JSON array"));
    };
    fields.finish()?;

    let pairs = pairs
        .into_iter()
        .enumerate()
        .map(|(index, pair)| parse_pair(format!("terms.pairs[{index}]"), pair))
        .collect::<Result<_, _>>()?;
    let terms = LenderTerms { pairs };
    terms
        .validate()
        .map_err(|e| bad_input(format!("terms: {e}")))?;
    Ok(terms)
}

fn parse_proposal(json: &str) -> Result<Proposal, String> {
    let mut fields = Fields::new("proposal".into(), parse_json("proposal", json)?)?;
    let proposal = Proposal {
        principal_asset: fields.asset("principal_asset")?,
        collateral_asset: fields.asset("collateral_asset")?,
        principal_amount: fields.amount("principal_amount")?,
        collateral_amount: fields.amount("collateral_amount")?,
        repayment_amount: fields.amount("repayment_amount")?,
        term_blocks: fields.number("term_blocks")?,
    };
    fields.finish()?;
    Ok(proposal)
}

fn pair_json(pair: &PairTerms) -> Value {
    json!({
        "principal_asset": pair.principal_asset.to_string(),
        "collateral_asset": pair.collateral_asset.to_string(),
        "min_apr_bps": pair.min_apr_bps,
        "max_principal_per_collateral": pair.max_principal_per_collateral.to_string(),
        "min_term_days": pair.min_term_days,
        "max_term_days": pair.max_term_days,
        "min_principal": pair.min_principal.to_string(),
        "max_principal": pair.max_principal.to_string(),
    })
}

/// The encoding of the terms (JSON), hex, as the directory stores and signs it. Terms that
/// `LenderTerms::validate` rejects are a `bad-input` error naming the problem.
#[wasm_bindgen(js_name = encodeLenderTerms)]
pub fn encode_lender_terms(terms_json: &str) -> Result<String, String> {
    Ok(encode_hex(&parse_terms(terms_json)?.encode()))
}

/// The terms (JSON) of their encoding (hex); an encoding `LenderTerms::decode` rejects is a
/// `bad-input` error.
#[wasm_bindgen(js_name = decodeLenderTerms)]
pub fn decode_lender_terms(hex: &str) -> Result<String, String> {
    let terms =
        LenderTerms::decode(&decode_hex(hex)?).map_err(|e| bad_input(format!("terms: {e}")))?;
    Ok(json!({ "pairs": terms.pairs.iter().map(pair_json).collect::<Vec<_>>() }).to_string())
}

/// The names of the terms (JSON) that the proposal (JSON) breaks, in the core's order; empty when
/// the proposal is within the terms.
#[wasm_bindgen(js_name = checkProposal)]
pub fn check_proposal(terms_json: &str, proposal_json: &str) -> Result<Vec<String>, String> {
    let terms = parse_terms(terms_json)?;
    let proposal = parse_proposal(proposal_json)?;
    Ok(terms
        .check_proposal(&proposal)
        .into_iter()
        .map(|breach| TermBreach::name(breach).to_owned())
        .collect())
}

/// The least repayment for `principal` at `min_apr_bps` over `term_blocks`, rounded up; a
/// `bad-input` error above `u64::MAX`.
#[wasm_bindgen(js_name = minRepayment)]
pub fn min_repayment(principal: u64, min_apr_bps: u32, term_blocks: u32) -> Result<u64, String> {
    private_lending_core::min_repayment(principal, min_apr_bps, term_blocks).ok_or_else(|| {
        bad_input(format!(
            "the least repayment is above u64::MAX ({})",
            u64::MAX
        ))
    })
}

/// The least collateral for `principal` at `max_principal_per_collateral`, rounded up; a
/// `bad-input` error for a rate of 0 or above `u64::MAX`.
#[wasm_bindgen(js_name = minCollateral)]
pub fn min_collateral(principal: u64, max_principal_per_collateral: u64) -> Result<u64, String> {
    private_lending_core::min_collateral(principal, max_principal_per_collateral).ok_or_else(|| {
        bad_input(
            "the least collateral has no value: the principal per collateral is 0, or it is \
             above u64::MAX",
        )
    })
}

/// The APR of a loan in basis points, rounded down, for display; a `bad-input` error when the
/// principal or the term is 0, the repayment is below the principal or the rate is above
/// `u64::MAX`.
#[wasm_bindgen(js_name = aprBps)]
pub fn apr_bps(principal: u64, repayment: u64, term_blocks: u32) -> Result<u64, String> {
    private_lending_core::apr_bps(principal, repayment, term_blocks).ok_or_else(|| {
        bad_input(
            "the APR has no value: the principal or the term is 0, the repayment is below the \
             principal, or the rate is above u64::MAX",
        )
    })
}

/// The principal per 10^8 collateral base units, rounded down, for display; a `bad-input` error
/// for 0 collateral or above `u64::MAX`.
#[wasm_bindgen(js_name = principalPerCollateral)]
pub fn principal_per_collateral(principal: u64, collateral: u64) -> Result<u64, String> {
    private_lending_core::principal_per_collateral(principal, collateral).ok_or_else(|| {
        bad_input(
            "the principal per collateral has no value: the collateral is 0, or it is above \
             u64::MAX",
        )
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::{Value, json};

    use super::*;

    const FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/scripts/fixtures/lender-terms-parity.json"
    );

    pub(crate) const PRINCIPAL_ASSET: &str =
        "bfbebdbcbbbab9b8b7b6b5b4b3b2b1b0afaeadacabaaa9a8a7a6a5a4a3a2a1a0";
    pub(crate) const COLLATERAL_ASSET: &str =
        "5f5e5d5c5b5a595857565554535251504f4e4d4c4b4a49484746454443424140";

    fn pair() -> Value {
        json!({
            "principal_asset": PRINCIPAL_ASSET,
            "collateral_asset": COLLATERAL_ASSET,
            "min_apr_bps": 500,
            "max_principal_per_collateral": "3000000000000",
            "min_term_days": 7,
            "max_term_days": 365,
            "min_principal": "100000000",
            "max_principal": "10000000000000",
        })
    }

    fn terms() -> Value {
        json!({ "pairs": [pair()] })
    }

    /// TEST lent against tL-BTC at 5% a year, as JSON.
    pub(crate) fn terms_json() -> String {
        terms().to_string()
    }

    fn proposal() -> Value {
        json!({
            "principal_asset": PRINCIPAL_ASSET,
            "collateral_asset": COLLATERAL_ASSET,
            "principal_amount": "1000000000000",
            "collateral_amount": "50000000",
            "repayment_amount": "1005000000000",
            "term_blocks": 43200,
        })
    }

    fn assert_bad_input(result: Result<impl std::fmt::Debug, String>, names: &str) {
        let error = result.unwrap_err();
        assert!(error.starts_with("bad-input: "), "{error}");
        assert!(error.contains(names), "{error} does not name {names}");
    }

    #[test]
    fn terms_round_trip() {
        let hex = encode_lender_terms(&terms_json()).unwrap();
        let core = LenderTerms::decode(&crate::error::decode_hex(&hex).unwrap()).unwrap();
        assert_eq!(core, parse_terms(&terms_json()).unwrap());
        assert_eq!(hex.len(), 2 * (2 + 100));

        let decoded: Value = serde_json::from_str(&decode_lender_terms(&hex).unwrap()).unwrap();
        assert_eq!(decoded, terms());
    }

    #[test]
    fn decode_rejects_bad_encodings() {
        assert_bad_input(decode_lender_terms("zz"), "hex");
        let hex = encode_lender_terms(&terms_json()).unwrap();
        assert_bad_input(decode_lender_terms(&format!("02{}", &hex[2..])), "version");
        assert_bad_input(decode_lender_terms(&hex[..hex.len() - 2]), "length");
    }

    #[test]
    fn terms_json_is_checked_field_by_field() {
        let with = |key: &str, value: Value| {
            let mut pair = pair();
            pair[key] = value;
            json!({ "pairs": [pair] }).to_string()
        };
        let without = |key: &str| {
            let mut pair = pair();
            pair.as_object_mut().unwrap().remove(key);
            json!({ "pairs": [pair] }).to_string()
        };
        let field = |key: &str| format!("terms.pairs[0].{key}");

        assert_bad_input(encode_lender_terms("not json"), "terms");
        assert_bad_input(encode_lender_terms("[]"), "terms");
        assert_bad_input(encode_lender_terms("{}"), "terms.pairs");
        assert_bad_input(encode_lender_terms(r#"{"pairs": {}}"#), "terms.pairs");
        assert_bad_input(
            encode_lender_terms(&json!({ "pairs": [pair()], "extra": 1 }).to_string()),
            "terms.extra",
        );
        assert_bad_input(
            encode_lender_terms(&with("extra", json!(1))),
            &field("extra"),
        );
        assert_bad_input(
            encode_lender_terms(&without("min_apr_bps")),
            &field("min_apr_bps"),
        );
        assert_bad_input(
            encode_lender_terms(&with("min_principal", json!(100_000_000))),
            &field("min_principal"),
        );
        for bad in ["", "-1", "+1", "1.5", " 1", "1e3", "18446744073709551616"] {
            assert_bad_input(
                encode_lender_terms(&with("max_principal", json!(bad))),
                &field("max_principal"),
            );
        }
        for bad in [
            json!(-1),
            json!(1.5),
            json!("7"),
            json!(4_294_967_296_u64),
            json!(null),
        ] {
            assert_bad_input(
                encode_lender_terms(&with("min_term_days", bad)),
                &field("min_term_days"),
            );
        }
        for bad in [
            json!(&PRINCIPAL_ASSET[1..]),
            json!(format!("{PRINCIPAL_ASSET}00")),
            json!(format!("{}zz", &PRINCIPAL_ASSET[2..])),
            json!(1),
        ] {
            assert_bad_input(
                encode_lender_terms(&with("principal_asset", bad)),
                &field("principal_asset"),
            );
        }
        // valid JSON, invalid terms
        assert_bad_input(encode_lender_terms(r#"{"pairs": []}"#), "pair count");
        assert_bad_input(
            encode_lender_terms(&with("collateral_asset", json!(PRINCIPAL_ASSET))),
            "own asset",
        );
        assert_bad_input(
            encode_lender_terms(&with("min_term_days", json!(0))),
            "term range",
        );
        assert_bad_input(
            encode_lender_terms(&json!({ "pairs": [pair(), pair()] }).to_string()),
            "same assets",
        );
    }

    #[test]
    fn proposal_json_is_checked_field_by_field() {
        let with = |key: &str, value: Value| {
            let mut proposal = proposal();
            proposal[key] = value;
            proposal.to_string()
        };
        let without = |key: &str| {
            let mut proposal = proposal();
            proposal.as_object_mut().unwrap().remove(key);
            proposal.to_string()
        };

        assert_bad_input(check_proposal(&terms_json(), "1"), "proposal");
        assert_bad_input(
            check_proposal(&terms_json(), &with("extra", json!(1))),
            "proposal.extra",
        );
        assert_bad_input(
            check_proposal(&terms_json(), &without("term_blocks")),
            "proposal.term_blocks",
        );
        assert_bad_input(
            check_proposal(&terms_json(), &with("repayment_amount", json!(1))),
            "proposal.repayment_amount",
        );
        assert_bad_input(
            check_proposal(&terms_json(), &with("term_blocks", json!(-1))),
            "proposal.term_blocks",
        );
        assert_bad_input(
            check_proposal(&terms_json(), &with("collateral_asset", json!("00"))),
            "proposal.collateral_asset",
        );
        assert_bad_input(
            check_proposal(r#"{"pairs": []}"#, &proposal().to_string()),
            "terms",
        );
    }

    #[test]
    fn check_proposal_names_the_breaches() {
        assert_eq!(
            check_proposal(&terms_json(), &proposal().to_string()).unwrap(),
            Vec::<String>::new()
        );
        let short = with_amounts("1000000000000", "1", "1000000000000");
        assert_eq!(
            check_proposal(&terms_json(), &short).unwrap(),
            ["AprBelowMinimum", "CollateralBelowMinimum"]
        );
    }

    fn with_amounts(principal: &str, collateral: &str, repayment: &str) -> String {
        let mut proposal = proposal();
        proposal["principal_amount"] = json!(principal);
        proposal["collateral_amount"] = json!(collateral);
        proposal["repayment_amount"] = json!(repayment);
        proposal.to_string()
    }

    /// Amounts near `u64::MAX` give an error or a breach, never a wrapped value or a panic.
    #[test]
    fn u64_max_is_an_error_or_a_breach() {
        assert_bad_input(min_repayment(u64::MAX, 500, 43_200), "u64::MAX");
        assert_bad_input(min_collateral(u64::MAX, 1), "u64::MAX");
        assert_bad_input(min_collateral(1, 0), "0");
        assert_bad_input(apr_bps(1, u64::MAX, 1), "u64::MAX");
        assert_bad_input(apr_bps(2, 1, 43_200), "below the principal");
        assert_bad_input(principal_per_collateral(u64::MAX, 1), "u64::MAX");
        assert_bad_input(principal_per_collateral(1, 0), "0");

        let max = u64::MAX.to_string();
        assert_eq!(
            check_proposal(&terms_json(), &with_amounts(&max, &max, &max)).unwrap(),
            ["PrincipalAboveRange", "AprBelowMinimum"]
        );
    }

    #[test]
    fn arithmetic_matches_the_core() {
        assert_eq!(
            min_repayment(1_000_000_000_000, 500, 43_200),
            Ok(1_004_109_589_042)
        );
        assert_eq!(
            min_collateral(1_000_000_000_000, 3_000_000_000_000),
            Ok(33_333_334)
        );
        assert_eq!(
            apr_bps(1_000_000_000_000, 1_005_000_000_000, 43_200),
            Ok(608)
        );
        assert_eq!(
            principal_per_collateral(1_000_000_000_000, 50_000_000),
            Ok(2_000_000_000_000)
        );
    }

    /// The fixture the web's parity check runs through the wasm, run here through the same
    /// functions natively.
    #[test]
    fn fixture_vectors() {
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(FIXTURE_PATH).unwrap()).unwrap();
        let amount = |value: &Value| value.as_str().unwrap().parse::<u64>().unwrap();
        let expected = |value: &Value| value.as_str().map(|text| text.parse::<u64>().unwrap());

        for vector in fixture["vectors"].as_array().unwrap() {
            let name = vector["name"].as_str().unwrap();
            let terms = vector["terms"].to_string();
            let proposal = &vector["proposal"];

            let hex = encode_lender_terms(&terms).unwrap();
            let decoded: Value = serde_json::from_str(&decode_lender_terms(&hex).unwrap()).unwrap();
            assert_eq!(decoded, vector["terms"], "{name}");

            let breaches = check_proposal(&terms, &proposal.to_string()).unwrap();
            let names: Vec<&str> = vector["check_proposal"]
                .as_array()
                .unwrap()
                .iter()
                .map(|breach| breach.as_str().unwrap())
                .collect();
            assert_eq!(breaches, names, "{name}");

            let pairs = vector["terms"]["pairs"].as_array().unwrap();
            let rates = pairs
                .iter()
                .find(|pair| {
                    pair["principal_asset"] == proposal["principal_asset"]
                        && pair["collateral_asset"] == proposal["collateral_asset"]
                })
                .unwrap_or(&pairs[0]);
            let principal = amount(&proposal["principal_amount"]);
            let term_blocks = proposal["term_blocks"].as_u64().unwrap() as u32;
            assert_eq!(
                min_repayment(
                    principal,
                    rates["min_apr_bps"].as_u64().unwrap() as u32,
                    term_blocks
                )
                .ok(),
                expected(&vector["min_repayment"]),
                "{name}"
            );
            assert_eq!(
                min_collateral(principal, amount(&rates["max_principal_per_collateral"])).ok(),
                expected(&vector["min_collateral"]),
                "{name}"
            );
            assert_eq!(
                apr_bps(
                    principal,
                    amount(&proposal["repayment_amount"]),
                    term_blocks
                )
                .ok(),
                expected(&vector["apr_bps"]),
                "{name}"
            );
            assert_eq!(
                principal_per_collateral(principal, amount(&proposal["collateral_amount"])).ok(),
                expected(&vector["principal_per_collateral"]),
                "{name}"
            );
        }
    }
}
