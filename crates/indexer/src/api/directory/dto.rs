use elements::AssetId;
use private_lending_core::{LenderTerms, PairTerms};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DirectoryChallenge {
    /// 32 random bytes, hex. Single-use.
    pub challenge: String,
    /// Unix seconds.
    pub expires_at: i64,
}

/// What a lender accepts for one pair of assets, with the field names of the core's `PairTerms`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PairTermsDto {
    /// The asset lent, 64 hex characters in display order.
    pub principal_asset: String,
    /// The asset lent against, 64 hex characters in display order.
    pub collateral_asset: String,
    /// The least APR, in basis points.
    pub min_apr_bps: u32,
    /// The most principal base units per 10^8 collateral base units, a `u64` as decimal digits.
    #[schema(example = "5000000000")]
    pub max_principal_per_collateral: String,
    /// Days, at least 1.
    pub min_term_days: u32,
    /// Days, at most 3650.
    pub max_term_days: u32,
    /// Principal base units, a `u64` as decimal digits, at least 1.
    #[schema(example = "1000")]
    pub min_principal: String,
    /// Principal base units, a `u64` as decimal digits.
    #[schema(example = "10000000")]
    pub max_principal: String,
}

/// A lender's terms: 1 to 8 pairs, no two with the same principal and collateral assets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LenderTermsDto {
    pub pairs: Vec<PairTermsDto>,
}

impl From<&PairTerms> for PairTermsDto {
    fn from(pair: &PairTerms) -> Self {
        PairTermsDto {
            principal_asset: pair.principal_asset.to_string(),
            collateral_asset: pair.collateral_asset.to_string(),
            min_apr_bps: pair.min_apr_bps,
            max_principal_per_collateral: pair.max_principal_per_collateral.to_string(),
            min_term_days: pair.min_term_days,
            max_term_days: pair.max_term_days,
            min_principal: pair.min_principal.to_string(),
            max_principal: pair.max_principal.to_string(),
        }
    }
}

impl From<&LenderTerms> for LenderTermsDto {
    fn from(terms: &LenderTerms) -> Self {
        LenderTermsDto {
            pairs: terms.pairs.iter().map(PairTermsDto::from).collect(),
        }
    }
}

/// A `u64` written as a string of decimal digits; the error names the field by its path.
fn parse_amount(path: &str, text: &str) -> Result<u64, String> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{path} is not a string of decimal digits"));
    }
    text.parse()
        .map_err(|_| format!("{path} is above {}", u64::MAX))
}

/// An asset id written as 64 hex characters in display order.
fn parse_asset(path: &str, text: &str) -> Result<AssetId, String> {
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("{path} is not 64 hex characters"));
    }
    text.parse()
        .map_err(|e| format!("{path} is not an asset id: {e}"))
}

impl PairTermsDto {
    fn to_pair(&self, path: &str) -> Result<PairTerms, String> {
        let field = |name: &str| format!("{path}.{name}");
        Ok(PairTerms {
            principal_asset: parse_asset(&field("principal_asset"), &self.principal_asset)?,
            collateral_asset: parse_asset(&field("collateral_asset"), &self.collateral_asset)?,
            min_apr_bps: self.min_apr_bps,
            max_principal_per_collateral: parse_amount(
                &field("max_principal_per_collateral"),
                &self.max_principal_per_collateral,
            )?,
            min_term_days: self.min_term_days,
            max_term_days: self.max_term_days,
            min_principal: parse_amount(&field("min_principal"), &self.min_principal)?,
            max_principal: parse_amount(&field("max_principal"), &self.max_principal)?,
        })
    }
}

impl LenderTermsDto {
    /// The terms, checked with `LenderTerms::validate`, so they are terms `LenderTerms::decode`
    /// accepts. The error names the field, such as `terms.pairs[0].min_principal`, or the rule
    /// the terms break.
    pub fn to_terms(&self) -> Result<LenderTerms, String> {
        let pairs = self
            .pairs
            .iter()
            .enumerate()
            .map(|(index, pair)| pair.to_pair(&format!("terms.pairs[{index}]")))
            .collect::<Result<_, _>>()?;
        let terms = LenderTerms { pairs };
        terms.validate().map_err(|e| format!("terms: {e}"))?;
        Ok(terms)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DirectoryEntry {
    /// X-only lending key, 32 bytes, hex.
    pub pubkey: String,
    pub display_name: String,
    /// The lender's terms; `null` for an entry written before the directory carried terms, which
    /// the list leaves out.
    pub terms: Option<LenderTermsDto>,
    /// Unix seconds of the last put, `null` when `terms` is.
    pub terms_published_at: Option<i64>,
    /// The challenge the last put consumed, 32 bytes, hex; `null` for an entry written before the
    /// directory kept it.
    pub signed_challenge: Option<String>,
    /// The last put's BIP340 signature over the challenge, the name and the terms, 64 bytes, hex;
    /// `null` when `signed_challenge` is.
    pub signature: Option<String>,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds.
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DirectoryList {
    pub items: Vec<DirectoryEntry>,
    /// Entries with terms, ignoring paging.
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PutDirectoryEntry {
    /// 1 to 64 characters, no leading or trailing whitespace, no control characters.
    pub display_name: String,
    /// A challenge issued by `POST /private/directory/challenges`, 32 bytes, hex.
    pub challenge: String,
    /// The terms the entry publishes, signed with the name.
    pub terms: LenderTermsDto,
    /// BIP340 signature, 64 bytes, hex.
    pub signature: String,
}

/// A delete carries no name and no terms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteDirectoryEntry {
    /// A challenge issued by `POST /private/directory/challenges`, 32 bytes, hex.
    pub challenge: String,
    /// BIP340 signature, 64 bytes, hex.
    pub signature: String,
}

#[cfg(test)]
mod tests {
    use super::{LenderTermsDto, PairTermsDto};
    use elements::AssetId;
    use private_lending_core::{LenderTerms, PairTerms};

    fn terms() -> LenderTerms {
        LenderTerms {
            pairs: vec![PairTerms {
                principal_asset: AssetId::from_slice(&[1; 32]).unwrap(),
                collateral_asset: AssetId::from_slice(&[2; 32]).unwrap(),
                min_apr_bps: 1,
                max_principal_per_collateral: u64::MAX,
                min_term_days: 1,
                max_term_days: 3650,
                min_principal: 1,
                max_principal: u64::MAX,
            }],
        }
    }

    #[test]
    fn terms_round_trip_through_the_dto() {
        let terms = terms();
        let dto = LenderTermsDto::from(&terms);
        assert_eq!(dto.pairs[0].max_principal, "18446744073709551615");
        assert_eq!(dto.to_terms(), Ok(terms));
    }

    #[test]
    fn asset_ids_are_display_hex() {
        let mut bytes = [0u8; 32];
        bytes[0] = 0xab;
        let asset = AssetId::from_slice(&bytes).unwrap();
        let mut terms = terms();
        terms.pairs[0].principal_asset = asset;
        let dto = LenderTermsDto::from(&terms);
        // Display order is the internal byte order reversed.
        assert!(dto.pairs[0].principal_asset.ends_with("ab"));
        assert_eq!(dto.to_terms().unwrap().pairs[0].principal_asset, asset);
    }

    #[test]
    fn conversion_errors_name_the_field() {
        let dto = LenderTermsDto::from(&terms());
        let with = |change: fn(&mut PairTermsDto)| {
            let mut dto = dto.clone();
            dto.pairs.push(dto.pairs[0].clone());
            dto.pairs[1].collateral_asset = "33".repeat(32);
            change(&mut dto.pairs[1]);
            dto.to_terms().unwrap_err()
        };

        assert_eq!(
            with(|pair| pair.min_principal = String::new()),
            "terms.pairs[1].min_principal is not a string of decimal digits"
        );
        assert_eq!(
            with(|pair| pair.max_principal = "+1".to_string()),
            "terms.pairs[1].max_principal is not a string of decimal digits"
        );
        assert_eq!(
            with(|pair| pair.principal_asset = "g".repeat(64)),
            "terms.pairs[1].principal_asset is not 64 hex characters"
        );
        assert_eq!(
            with(|pair| pair.min_term_days = 0),
            "terms: bad lender terms term range"
        );
    }
}
