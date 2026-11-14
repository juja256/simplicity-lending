//! The terms a lender publishes in the directory, and the check of a borrower's proposal against
//! them.
//!
//! Terms are in blocks underneath: a day is [`BLOCKS_PER_DAY`] blocks and a year
//! [`BLOCKS_PER_YEAR`]. The APR check compares repayments, not rounded rates: a proposal is below
//! the minimum APR when its repayment is below [`min_repayment`].

use std::fmt;

use elements::AssetId;
use elements::hashes::sha256;

/// The version of the lender terms encoding.
pub const LENDER_TERMS_VERSION: u8 = 1;
/// The most pairs one lender's terms hold.
pub const MAX_PAIRS: usize = 8;
/// The blocks in a day, one a minute.
pub const BLOCKS_PER_DAY: u32 = 1440;
/// The blocks in a year of 365 days.
pub const BLOCKS_PER_YEAR: u64 = 525_600;
/// The collateral base units [`PairTerms::max_principal_per_collateral`] is quoted per: 10^8, one
/// whole coin of 8 decimals.
pub const COLLATERAL_SCALE: u64 = 100_000_000;

/// The longest term a pair may allow, about ten years.
const MAX_TERM_DAYS: u32 = 3650;
/// The length of one encoded pair.
const PAIR_LENGTH: usize = 32 + 32 + 4 + 8 + 4 + 4 + 8 + 8;
/// The denominator of the interest: basis points in one, times the blocks in a year.
const APR_DENOMINATOR: u128 = 10_000 * BLOCKS_PER_YEAR as u128;

/// What a lender accepts for one pair of assets: the principal they lend and the collateral they
/// lend against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PairTerms {
    pub principal_asset: AssetId,
    pub collateral_asset: AssetId,
    /// The least APR, in basis points.
    pub min_apr_bps: u32,
    /// The most principal base units per [`COLLATERAL_SCALE`] collateral base units.
    pub max_principal_per_collateral: u64,
    pub min_term_days: u32,
    pub max_term_days: u32,
    pub min_principal: u64,
    pub max_principal: u64,
}

/// The terms a lender publishes: one [`PairTerms`] for each pair of assets, 1 to [`MAX_PAIRS`]
/// pairs, no two with the same principal and collateral assets.
///
/// Encoded big-endian: version `1` (1) ‖ pair count (1) ‖ per pair, principal asset (32) ‖
/// collateral asset (32) ‖ min APR bps (4) ‖ max principal per collateral (8) ‖ min term days (4)
/// ‖ max term days (4) ‖ min principal (8) ‖ max principal (8), 100 bytes, the asset ids in their
/// internal (consensus-serialized) byte order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LenderTerms {
    pub pairs: Vec<PairTerms>,
}

/// Why lender terms were rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LenderTermsError {
    /// The version is not [`LENDER_TERMS_VERSION`].
    UnknownVersion(u8),
    /// The input is not the length its pair count gives.
    BadLength,
    /// The pair count is 0 or more than [`MAX_PAIRS`].
    BadPairCount(u8),
    /// Two pairs have the same principal and collateral assets.
    DuplicatePair,
    /// A pair's principal and collateral assets are the same.
    SameAssets,
    /// A pair's maximum principal per collateral is 0.
    ZeroPrincipalPerCollateral,
    /// A pair's minimum principal is 0 or above its maximum.
    BadPrincipalRange,
    /// A pair's minimum term is 0 or above its maximum, or its maximum is above ten years.
    BadTermRange,
}

impl fmt::Display for LenderTermsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownVersion(version) => write!(f, "unknown lender terms version {version}"),
            Self::BadLength => f.write_str("bad lender terms length"),
            Self::BadPairCount(count) => write!(f, "bad lender terms pair count {count}"),
            Self::DuplicatePair => f.write_str("two lender terms pairs have the same assets"),
            Self::SameAssets => f.write_str("a lender terms pair lends against its own asset"),
            Self::ZeroPrincipalPerCollateral => {
                f.write_str("a lender terms pair allows no principal per collateral")
            }
            Self::BadPrincipalRange => f.write_str("bad lender terms principal range"),
            Self::BadTermRange => f.write_str("bad lender terms term range"),
        }
    }
}

impl std::error::Error for LenderTermsError {}

/// A borrower's proposal, checked against a lender's terms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Proposal {
    pub principal_asset: AssetId,
    pub collateral_asset: AssetId,
    pub principal_amount: u64,
    pub collateral_amount: u64,
    pub repayment_amount: u64,
    /// The expiry height minus the creation height (the tip for an unconfirmed creation),
    /// computed by the caller.
    pub term_blocks: u32,
}

/// A term of a lender's pair that a proposal breaks, in the order
/// [`LenderTerms::check_proposal`] lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TermBreach {
    /// No pair of the terms has the proposal's principal and collateral assets.
    UnsupportedPair,
    PrincipalBelowRange,
    PrincipalAboveRange,
    TermBelowRange,
    TermAboveRange,
    /// The repayment is below [`min_repayment`], or that minimum is above `u64::MAX`.
    AprBelowMinimum,
    /// The collateral is below [`min_collateral`], or that minimum is above `u64::MAX`.
    CollateralBelowMinimum,
}

impl PairTerms {
    /// Checks that the assets differ, `max_principal_per_collateral ≥ 1`, `1 ≤ min_principal ≤
    /// max_principal` and `1 ≤ min_term_days ≤ max_term_days ≤ 3650`, in that order.
    pub fn validate(&self) -> Result<(), LenderTermsError> {
        if self.principal_asset == self.collateral_asset {
            return Err(LenderTermsError::SameAssets);
        }
        if self.max_principal_per_collateral == 0 {
            return Err(LenderTermsError::ZeroPrincipalPerCollateral);
        }
        if self.min_principal == 0 || self.min_principal > self.max_principal {
            return Err(LenderTermsError::BadPrincipalRange);
        }
        if self.min_term_days == 0
            || self.min_term_days > self.max_term_days
            || self.max_term_days > MAX_TERM_DAYS
        {
            return Err(LenderTermsError::BadTermRange);
        }
        Ok(())
    }

    fn has_assets(&self, principal_asset: &AssetId, collateral_asset: &AssetId) -> bool {
        self.principal_asset == *principal_asset && self.collateral_asset == *collateral_asset
    }

    fn encode_into(&self, bytes: &mut Vec<u8>) {
        bytes.extend_from_slice(&self.principal_asset.into_inner().to_byte_array());
        bytes.extend_from_slice(&self.collateral_asset.into_inner().to_byte_array());
        bytes.extend_from_slice(&self.min_apr_bps.to_be_bytes());
        bytes.extend_from_slice(&self.max_principal_per_collateral.to_be_bytes());
        bytes.extend_from_slice(&self.min_term_days.to_be_bytes());
        bytes.extend_from_slice(&self.max_term_days.to_be_bytes());
        bytes.extend_from_slice(&self.min_principal.to_be_bytes());
        bytes.extend_from_slice(&self.max_principal.to_be_bytes());
    }

    /// Decodes one pair from its [`PAIR_LENGTH`] bytes.
    fn decode(bytes: &[u8; PAIR_LENGTH]) -> PairTerms {
        let mut reader = Reader(bytes);
        PairTerms {
            principal_asset: reader.asset_id(),
            collateral_asset: reader.asset_id(),
            min_apr_bps: u32::from_be_bytes(reader.array()),
            max_principal_per_collateral: u64::from_be_bytes(reader.array()),
            min_term_days: u32::from_be_bytes(reader.array()),
            max_term_days: u32::from_be_bytes(reader.array()),
            min_principal: u64::from_be_bytes(reader.array()),
            max_principal: u64::from_be_bytes(reader.array()),
        }
    }
}

impl LenderTerms {
    /// The encoding, of the terms as they are: [`LenderTerms::decode`] rejects terms that are not
    /// valid. A list of more than 255 pairs is written with the count 255.
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(2 + self.pairs.len() * PAIR_LENGTH);
        bytes.push(LENDER_TERMS_VERSION);
        bytes.push(u8::try_from(self.pairs.len()).unwrap_or(u8::MAX));
        for pair in &self.pairs {
            pair.encode_into(&mut bytes);
        }
        bytes
    }

    /// Decodes terms from exactly their encoding, rejecting an unknown version, a length other
    /// than the pair count's, 0 or more than [`MAX_PAIRS`] pairs, two pairs with the same assets
    /// and any pair [`PairTerms::validate`] rejects.
    pub fn decode(bytes: &[u8]) -> Result<LenderTerms, LenderTermsError> {
        let [version, count, body @ ..] = bytes else {
            return Err(LenderTermsError::BadLength);
        };
        if *version != LENDER_TERMS_VERSION {
            return Err(LenderTermsError::UnknownVersion(*version));
        }
        if *count == 0 || usize::from(*count) > MAX_PAIRS {
            return Err(LenderTermsError::BadPairCount(*count));
        }
        if body.len() != usize::from(*count) * PAIR_LENGTH {
            return Err(LenderTermsError::BadLength);
        }

        let (chunks, _) = body.as_chunks::<PAIR_LENGTH>();
        let pairs: Vec<PairTerms> = chunks.iter().map(PairTerms::decode).collect();
        for (index, pair) in pairs.iter().enumerate() {
            pair.validate()?;
            if pairs[..index]
                .iter()
                .any(|earlier| earlier.has_assets(&pair.principal_asset, &pair.collateral_asset))
            {
                return Err(LenderTermsError::DuplicatePair);
            }
        }

        Ok(LenderTerms { pairs })
    }

    /// Every term of the pair with the proposal's assets that the proposal breaks, in
    /// [`TermBreach`]'s order, or `[UnsupportedPair]` when no pair has its assets.
    ///
    /// A term is in range when `min_term_days · 1440 ≤ term_blocks ≤ max_term_days · 1440`. A
    /// proposal exactly at a minimum or a maximum is within the terms. When [`min_repayment`] or
    /// [`min_collateral`] has no value, the proposal breaks that term. The terms are not
    /// validated; of two pairs with the proposal's assets, the first is used.
    pub fn check_proposal(&self, proposal: &Proposal) -> Vec<TermBreach> {
        let Some(pair) = self
            .pairs
            .iter()
            .find(|pair| pair.has_assets(&proposal.principal_asset, &proposal.collateral_asset))
        else {
            return vec![TermBreach::UnsupportedPair];
        };

        let mut breaches = Vec::new();
        if proposal.principal_amount < pair.min_principal {
            breaches.push(TermBreach::PrincipalBelowRange);
        }
        if proposal.principal_amount > pair.max_principal {
            breaches.push(TermBreach::PrincipalAboveRange);
        }
        let term_blocks = u64::from(proposal.term_blocks);
        if term_blocks < u64::from(pair.min_term_days) * u64::from(BLOCKS_PER_DAY) {
            breaches.push(TermBreach::TermBelowRange);
        }
        if term_blocks > u64::from(pair.max_term_days) * u64::from(BLOCKS_PER_DAY) {
            breaches.push(TermBreach::TermAboveRange);
        }
        let least_repayment = min_repayment(
            proposal.principal_amount,
            pair.min_apr_bps,
            proposal.term_blocks,
        );
        if least_repayment.is_none_or(|least| proposal.repayment_amount < least) {
            breaches.push(TermBreach::AprBelowMinimum);
        }
        let least_collateral =
            min_collateral(proposal.principal_amount, pair.max_principal_per_collateral);
        if least_collateral.is_none_or(|least| proposal.collateral_amount < least) {
            breaches.push(TermBreach::CollateralBelowMinimum);
        }
        breaches
    }
}

/// The least repayment at `min_apr_bps` over `term_blocks`: `principal + ceil(principal ·
/// min_apr_bps · term_blocks / (10_000 · BLOCKS_PER_YEAR))`, or `None` above `u64::MAX`.
pub fn min_repayment(principal: u64, min_apr_bps: u32, term_blocks: u32) -> Option<u64> {
    // below 2^64 · 2^32 · 2^32, so the product fits in a u128
    let scaled = u128::from(principal) * u128::from(min_apr_bps) * u128::from(term_blocks);
    let interest = scaled.div_ceil(APR_DENOMINATOR);
    u64::try_from(u128::from(principal) + interest).ok()
}

/// The least collateral for `principal` at `max_principal_per_collateral`: `ceil(principal ·
/// COLLATERAL_SCALE / max_principal_per_collateral)`, or `None` for a zero divisor or above
/// `u64::MAX`.
pub fn min_collateral(principal: u64, max_principal_per_collateral: u64) -> Option<u64> {
    if max_principal_per_collateral == 0 {
        return None;
    }
    let scaled = u128::from(principal) * u128::from(COLLATERAL_SCALE);
    u64::try_from(scaled.div_ceil(u128::from(max_principal_per_collateral))).ok()
}

/// The APR of a loan in basis points, rounded down: `floor((repayment − principal) · 10_000 ·
/// BLOCKS_PER_YEAR / (principal · term_blocks))`, or `None` if the principal or the term is 0, the
/// repayment is below the principal or the rate is above `u64::MAX`. For display only: the check
/// compares repayments.
pub fn apr_bps(principal: u64, repayment: u64, term_blocks: u32) -> Option<u64> {
    if principal == 0 || term_blocks == 0 {
        return None;
    }
    let interest = repayment.checked_sub(principal)?;
    let scaled = u128::from(interest) * APR_DENOMINATOR;
    u64::try_from(scaled / (u128::from(principal) * u128::from(term_blocks))).ok()
}

/// The principal per [`COLLATERAL_SCALE`] collateral base units, rounded down: `floor(principal ·
/// COLLATERAL_SCALE / collateral)`, or `None` for zero collateral or above `u64::MAX`. For display
/// only.
pub fn principal_per_collateral(principal: u64, collateral: u64) -> Option<u64> {
    if collateral == 0 {
        return None;
    }
    let scaled = u128::from(principal) * u128::from(COLLATERAL_SCALE);
    u64::try_from(scaled / u128::from(collateral)).ok()
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
    use std::fs;

    use elements::hex::ToHex;
    use serde_json::{Value, json};

    use super::*;
    use crate::test_util::sequence;

    const FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/scripts/fixtures/lender-terms-parity.json"
    );

    fn asset(start: u8) -> AssetId {
        AssetId::from_slice(&sequence(start)).unwrap()
    }

    /// TEST lent against tL-BTC: at least 5% a year, at most 30,000 TEST per tL-BTC, 7 days to a
    /// year, 1 to 100,000 TEST, in base units of 8 decimals.
    fn sample_pair() -> PairTerms {
        PairTerms {
            principal_asset: asset(0xa0),
            collateral_asset: asset(0x40),
            min_apr_bps: 500,
            max_principal_per_collateral: 3_000_000_000_000,
            min_term_days: 7,
            max_term_days: 365,
            min_principal: 100_000_000,
            max_principal: 10_000_000_000_000,
        }
    }

    /// A pair whose every field has distinct bytes, so a field order or byte order mistake
    /// changes the encoding.
    fn known_answer_pair() -> PairTerms {
        PairTerms {
            principal_asset: asset(0xa0),
            collateral_asset: asset(0x40),
            min_apr_bps: 0x0102_0304,
            max_principal_per_collateral: 0x1112_1314_1516_1718,
            min_term_days: 7,
            max_term_days: 3650,
            min_principal: 0x2122_2324_2526_2728,
            max_principal: 0x3132_3334_3536_3738,
        }
    }

    /// `count` valid pairs with distinct asset pairs.
    fn distinct_pairs(count: u8) -> Vec<PairTerms> {
        (0..count)
            .map(|i| PairTerms {
                principal_asset: asset(i),
                collateral_asset: asset(0x80 + i),
                min_apr_bps: u32::from(i) * 100,
                min_principal: u64::from(i) + 1,
                ..sample_pair()
            })
            .collect()
    }

    fn one_pair(pair: PairTerms) -> LenderTerms {
        LenderTerms { pairs: vec![pair] }
    }

    /// A proposal for `pair`'s assets with the least repayment and collateral its rates allow.
    fn proposal_at(pair: &PairTerms, principal_amount: u64, term_blocks: u32) -> Proposal {
        Proposal {
            principal_asset: pair.principal_asset,
            collateral_asset: pair.collateral_asset,
            principal_amount,
            collateral_amount: min_collateral(principal_amount, pair.max_principal_per_collateral)
                .unwrap(),
            repayment_amount: min_repayment(principal_amount, pair.min_apr_bps, term_blocks)
                .unwrap(),
            term_blocks,
        }
    }

    #[test]
    fn encode_decode_round_trip() {
        let terms = one_pair(sample_pair());
        let bytes = terms.encode();
        assert_eq!(bytes.len(), 2 + 100);
        assert_eq!(LenderTerms::decode(&bytes).unwrap(), terms);

        let terms = LenderTerms {
            pairs: distinct_pairs(8),
        };
        let bytes = terms.encode();
        assert_eq!(bytes.len(), 2 + 8 * 100);
        assert_eq!(LenderTerms::decode(&bytes).unwrap(), terms);

        // the same two assets the other way round are another pair
        let pair = sample_pair();
        let reversed = PairTerms {
            principal_asset: pair.collateral_asset,
            collateral_asset: pair.principal_asset,
            ..pair
        };
        let terms = LenderTerms {
            pairs: vec![pair, reversed],
        };
        assert_eq!(LenderTerms::decode(&terms.encode()).unwrap(), terms);
    }

    #[test]
    fn decode_rejects_bad_input() {
        let bytes = one_pair(sample_pair()).encode();

        let mut version_2 = bytes.clone();
        version_2[0] = 2;
        assert_eq!(
            LenderTerms::decode(&version_2),
            Err(LenderTermsError::UnknownVersion(2))
        );
        assert_eq!(
            LenderTerms::decode(&bytes[..bytes.len() - 1]),
            Err(LenderTermsError::BadLength)
        );
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(
            LenderTerms::decode(&trailing),
            Err(LenderTermsError::BadLength)
        );
        assert_eq!(LenderTerms::decode(&[]), Err(LenderTermsError::BadLength));
        assert_eq!(LenderTerms::decode(&[1]), Err(LenderTermsError::BadLength));

        assert_eq!(
            LenderTerms::decode(&[1, 0]),
            Err(LenderTermsError::BadPairCount(0))
        );
        let nine = LenderTerms {
            pairs: distinct_pairs(9),
        };
        assert_eq!(
            LenderTerms::decode(&nine.encode()),
            Err(LenderTermsError::BadPairCount(9))
        );

        let duplicate = LenderTerms {
            pairs: vec![
                sample_pair(),
                PairTerms {
                    min_apr_bps: 900,
                    ..sample_pair()
                },
            ],
        };
        assert_eq!(
            LenderTerms::decode(&duplicate.encode()),
            Err(LenderTermsError::DuplicatePair)
        );

        let invalid = [
            (
                PairTerms {
                    collateral_asset: asset(0xa0),
                    ..sample_pair()
                },
                LenderTermsError::SameAssets,
            ),
            (
                PairTerms {
                    max_principal_per_collateral: 0,
                    ..sample_pair()
                },
                LenderTermsError::ZeroPrincipalPerCollateral,
            ),
            (
                PairTerms {
                    min_principal: 0,
                    ..sample_pair()
                },
                LenderTermsError::BadPrincipalRange,
            ),
            (
                PairTerms {
                    min_principal: 10_000_000_000_001,
                    ..sample_pair()
                },
                LenderTermsError::BadPrincipalRange,
            ),
            (
                PairTerms {
                    min_term_days: 0,
                    ..sample_pair()
                },
                LenderTermsError::BadTermRange,
            ),
            (
                PairTerms {
                    min_term_days: 366,
                    ..sample_pair()
                },
                LenderTermsError::BadTermRange,
            ),
            (
                PairTerms {
                    max_term_days: 3651,
                    ..sample_pair()
                },
                LenderTermsError::BadTermRange,
            ),
        ];
        for (pair, error) in invalid {
            assert_eq!(pair.validate(), Err(error));
            assert_eq!(LenderTerms::decode(&one_pair(pair).encode()), Err(error));
            // a valid pair before the invalid one does not hide it
            let terms = LenderTerms {
                pairs: vec![distinct_pairs(1)[0], pair],
            };
            assert_eq!(LenderTerms::decode(&terms.encode()), Err(error));
        }

        // the bounds themselves are valid
        let widest = PairTerms {
            max_principal_per_collateral: 1,
            min_term_days: 1,
            max_term_days: 3650,
            min_principal: 1,
            max_principal: u64::MAX,
            ..sample_pair()
        };
        assert_eq!(widest.validate(), Ok(()));
        let narrowest = PairTerms {
            min_term_days: 3650,
            max_term_days: 3650,
            min_principal: u64::MAX,
            max_principal: u64::MAX,
            ..sample_pair()
        };
        assert_eq!(narrowest.validate(), Ok(()));
    }

    /// The frozen encoding of one pair, so a change of field order, width or byte order fails.
    #[test]
    fn encoding_known_answer() {
        let bytes = one_pair(known_answer_pair()).encode();

        assert_eq!(
            bytes.to_hex(),
            concat!(
                "01",
                "01",
                "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf",
                "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
                "01020304",
                "1112131415161718",
                "00000007",
                "00000e42",
                "2122232425262728",
                "3132333435363738",
            )
        );
    }

    #[test]
    fn min_repayment_rounds_up() {
        // one unit at 0.01% for one block is a fraction of a unit, rounded up to one
        assert_eq!(min_repayment(1, 1, 1), Some(2));
        // 5% for a whole year of 1,000,000 is exactly 50,000
        assert_eq!(min_repayment(1_000_000, 500, 525_600), Some(1_050_000));
        // 10_000 · 525_600 units at 0.01% for one block is exactly one unit
        assert_eq!(min_repayment(5_256_000_000, 1, 1), Some(5_256_000_001));
        assert_eq!(min_repayment(5_256_000_001, 1, 1), Some(5_256_000_003));
        assert_eq!(min_repayment(1_000_000, 0, 525_600), Some(1_000_000));
    }

    #[test]
    fn min_collateral_rounds_up() {
        assert_eq!(min_collateral(1, 1), Some(100_000_000));
        assert_eq!(min_collateral(1, 3), Some(33_333_334));
        assert_eq!(min_collateral(3, 3), Some(100_000_000));
        // 10,000 TEST at 30,000 TEST per tL-BTC is a third of a tL-BTC, rounded up
        assert_eq!(
            min_collateral(1_000_000_000_000, 3_000_000_000_000),
            Some(33_333_334)
        );
        assert_eq!(
            min_collateral(3_000_000_000_000, 3_000_000_000_000),
            Some(100_000_000)
        );
    }

    #[test]
    fn apr_and_principal_per_collateral_round_down() {
        assert_eq!(apr_bps(1_000_000, 1_050_000, 525_600), Some(500));
        assert_eq!(apr_bps(1_000_000, 1_049_999, 525_600), Some(499));
        assert_eq!(apr_bps(1_000_000, 1_000_000, 1440), Some(0));
        assert_eq!(principal_per_collateral(1, 3), Some(33_333_333));
        assert_eq!(
            principal_per_collateral(1_000_000_000_000, 50_000_000),
            Some(2_000_000_000_000)
        );
    }

    #[test]
    fn arithmetic_at_the_edges() {
        // a zero principal needs nothing back and no collateral, and has no rate
        assert_eq!(min_repayment(0, 500, 1440), Some(0));
        assert_eq!(min_collateral(0, 1), Some(0));
        assert_eq!(apr_bps(0, 100, 1440), None);
        assert_eq!(principal_per_collateral(0, 1), Some(0));

        // a zero term adds no interest and has no rate
        assert_eq!(min_repayment(1_000_000, 500, 0), Some(1_000_000));
        assert_eq!(apr_bps(1_000_000, 1_050_000, 0), None);

        // a zero divisor
        assert_eq!(min_collateral(1_000_000, 0), None);
        assert_eq!(principal_per_collateral(1_000_000, 0), None);

        // a repayment below the principal
        assert_eq!(apr_bps(1_000_000, 999_999, 1440), None);

        // u64::MAX amounts overflow to None
        assert_eq!(min_repayment(u64::MAX, 1, 1), None);
        assert_eq!(min_repayment(u64::MAX, u32::MAX, u32::MAX), None);
        assert_eq!(min_repayment(u64::MAX, 0, u32::MAX), Some(u64::MAX));
        assert_eq!(min_collateral(u64::MAX, 1), None);
        assert_eq!(min_collateral(u64::MAX, u64::MAX), Some(100_000_000));
        assert_eq!(apr_bps(1, u64::MAX, 1), None);
        assert_eq!(apr_bps(u64::MAX, u64::MAX - 1, 1), None);
        assert_eq!(apr_bps(u64::MAX, u64::MAX, u32::MAX), Some(0));
        assert_eq!(principal_per_collateral(u64::MAX, 1), None);
        assert_eq!(
            principal_per_collateral(u64::MAX, u64::MAX),
            Some(100_000_000)
        );
    }

    #[test]
    fn check_proposal_names_every_breach() {
        // terms validate rejects, with the minimums above the maximums, so one proposal can be
        // both below and above each range
        let crossed = PairTerms {
            min_principal: 1000,
            max_principal: 10,
            min_term_days: 10,
            max_term_days: 1,
            ..sample_pair()
        };
        assert!(crossed.validate().is_err());
        let proposal = Proposal {
            principal_asset: crossed.principal_asset,
            collateral_asset: crossed.collateral_asset,
            principal_amount: 500,
            collateral_amount: 0,
            repayment_amount: 500,
            term_blocks: 5000,
        };
        assert_eq!(
            one_pair(crossed).check_proposal(&proposal),
            vec![
                TermBreach::PrincipalBelowRange,
                TermBreach::PrincipalAboveRange,
                TermBreach::TermBelowRange,
                TermBreach::TermAboveRange,
                TermBreach::AprBelowMinimum,
                TermBreach::CollateralBelowMinimum,
            ]
        );

        // with valid terms, at most one side of each range
        let terms = one_pair(sample_pair());
        let below = Proposal {
            principal_amount: 99_999_999,
            term_blocks: 7 * 1440 - 1,
            repayment_amount: 99_999_999,
            collateral_amount: 0,
            ..proposal
        };
        assert_eq!(
            terms.check_proposal(&below),
            vec![
                TermBreach::PrincipalBelowRange,
                TermBreach::TermBelowRange,
                TermBreach::AprBelowMinimum,
                TermBreach::CollateralBelowMinimum,
            ]
        );
        let above = Proposal {
            principal_amount: 10_000_000_000_001,
            term_blocks: 365 * 1440 + 1,
            repayment_amount: 20_000_000_000_000,
            collateral_amount: 1_000_000_000,
            ..proposal
        };
        assert_eq!(
            terms.check_proposal(&above),
            vec![TermBreach::PrincipalAboveRange, TermBreach::TermAboveRange]
        );

        // another pair of assets, the same two the other way round included
        let other = Proposal {
            principal_asset: asset(0x60),
            ..proposal_at(&sample_pair(), 1_000_000_000, 30 * 1440)
        };
        assert_eq!(
            terms.check_proposal(&other),
            vec![TermBreach::UnsupportedPair]
        );
        let swapped = Proposal {
            principal_asset: sample_pair().collateral_asset,
            collateral_asset: sample_pair().principal_asset,
            ..other
        };
        assert_eq!(
            terms.check_proposal(&swapped),
            vec![TermBreach::UnsupportedPair]
        );
    }

    #[test]
    fn check_proposal_accepts_the_boundaries() {
        let pair = sample_pair();
        let terms = one_pair(pair);
        let shortest = 7 * 1440;
        let longest = 365 * 1440;

        for proposal in [
            proposal_at(&pair, pair.min_principal, shortest),
            proposal_at(&pair, pair.min_principal, longest),
            proposal_at(&pair, pair.max_principal, shortest),
            proposal_at(&pair, pair.max_principal, longest),
        ] {
            assert_eq!(terms.check_proposal(&proposal), vec![], "{proposal:?}");

            let short_repayment = Proposal {
                repayment_amount: proposal.repayment_amount - 1,
                ..proposal
            };
            assert_eq!(
                terms.check_proposal(&short_repayment),
                vec![TermBreach::AprBelowMinimum]
            );
            let short_collateral = Proposal {
                collateral_amount: proposal.collateral_amount - 1,
                ..proposal
            };
            assert_eq!(
                terms.check_proposal(&short_collateral),
                vec![TermBreach::CollateralBelowMinimum]
            );
        }

        // one unit or one block outside a range, with the least repayment and collateral there
        let cases = [
            (
                proposal_at(&pair, pair.min_principal - 1, shortest),
                TermBreach::PrincipalBelowRange,
            ),
            (
                proposal_at(&pair, pair.max_principal + 1, shortest),
                TermBreach::PrincipalAboveRange,
            ),
            (
                proposal_at(&pair, pair.min_principal, shortest - 1),
                TermBreach::TermBelowRange,
            ),
            (
                proposal_at(&pair, pair.min_principal, longest + 1),
                TermBreach::TermAboveRange,
            ),
        ];
        for (proposal, breach) in cases {
            assert_eq!(terms.check_proposal(&proposal), vec![breach]);
        }
    }

    #[test]
    fn check_proposal_uses_the_matching_pair() {
        let first = sample_pair();
        let second = PairTerms {
            principal_asset: asset(0x60),
            min_apr_bps: 1000,
            min_principal: 1,
            ..sample_pair()
        };
        let terms = LenderTerms {
            pairs: vec![first, second],
        };

        // the second pair's minimum principal and rate apply, not the first's
        let proposal = proposal_at(&second, 1000, 7 * 1440);
        assert_eq!(terms.check_proposal(&proposal), vec![]);
        let short_repayment = Proposal {
            repayment_amount: min_repayment(1000, first.min_apr_bps, 7 * 1440).unwrap(),
            ..proposal
        };
        assert_eq!(
            terms.check_proposal(&short_repayment),
            vec![TermBreach::AprBelowMinimum]
        );
    }

    #[test]
    fn check_proposal_at_u64_max() {
        let pair = PairTerms {
            max_principal_per_collateral: 1,
            max_principal: u64::MAX,
            ..sample_pair()
        };
        let proposal = Proposal {
            principal_asset: pair.principal_asset,
            collateral_asset: pair.collateral_asset,
            principal_amount: u64::MAX,
            collateral_amount: u64::MAX,
            repayment_amount: u64::MAX,
            term_blocks: u32::MAX,
        };
        // the minimums overflow, so the proposal breaks both, and the term is above the range
        assert_eq!(
            one_pair(pair).check_proposal(&proposal),
            vec![
                TermBreach::TermAboveRange,
                TermBreach::AprBelowMinimum,
                TermBreach::CollateralBelowMinimum,
            ]
        );
    }

    /// A parity vector: terms, a proposal and the breaches it must give.
    struct Vector {
        name: &'static str,
        terms: LenderTerms,
        proposal: Proposal,
        breaches: Vec<TermBreach>,
    }

    fn parity_inputs() -> Vec<Vector> {
        let pair = sample_pair();
        let terms = one_pair(pair);
        let month = 30 * 1440;
        let inside = Proposal {
            principal_asset: pair.principal_asset,
            collateral_asset: pair.collateral_asset,
            principal_amount: 1_000_000_000_000,
            collateral_amount: 50_000_000,
            repayment_amount: 1_005_000_000_000,
            term_blocks: month,
        };
        let least = proposal_at(&pair, 1_000_000_000_000, month);
        let second = PairTerms {
            principal_asset: asset(0x60),
            min_apr_bps: 1200,
            max_principal_per_collateral: 100_000_000,
            min_term_days: 1,
            max_term_days: 30,
            min_principal: 1,
            max_principal: 1_000_000,
            ..pair
        };
        let unbounded = PairTerms {
            min_apr_bps: 0,
            max_principal_per_collateral: 1,
            max_principal: u64::MAX,
            ..pair
        };

        vec![
            Vector {
                name: "inside the terms",
                terms: terms.clone(),
                proposal: inside,
                breaches: vec![],
            },
            Vector {
                name: "at every minimum",
                terms: terms.clone(),
                proposal: proposal_at(&pair, pair.min_principal, 7 * 1440),
                breaches: vec![],
            },
            Vector {
                name: "at every maximum",
                terms: terms.clone(),
                proposal: proposal_at(&pair, pair.max_principal, 365 * 1440),
                breaches: vec![],
            },
            Vector {
                name: "repayment one unit short",
                terms: terms.clone(),
                proposal: Proposal {
                    repayment_amount: least.repayment_amount - 1,
                    ..least
                },
                breaches: vec![TermBreach::AprBelowMinimum],
            },
            Vector {
                name: "collateral one unit short",
                terms: terms.clone(),
                proposal: Proposal {
                    collateral_amount: least.collateral_amount - 1,
                    ..least
                },
                breaches: vec![TermBreach::CollateralBelowMinimum],
            },
            Vector {
                name: "below the ranges",
                terms: terms.clone(),
                proposal: Proposal {
                    principal_amount: 99_999_999,
                    collateral_amount: 0,
                    repayment_amount: 99_999_999,
                    term_blocks: 7 * 1440 - 1,
                    ..inside
                },
                breaches: vec![
                    TermBreach::PrincipalBelowRange,
                    TermBreach::TermBelowRange,
                    TermBreach::AprBelowMinimum,
                    TermBreach::CollateralBelowMinimum,
                ],
            },
            Vector {
                name: "above the ranges",
                terms: terms.clone(),
                proposal: Proposal {
                    principal_amount: 10_000_000_000_001,
                    collateral_amount: 1_000_000_000,
                    repayment_amount: 20_000_000_000_000,
                    term_blocks: 365 * 1440 + 1,
                    ..inside
                },
                breaches: vec![TermBreach::PrincipalAboveRange, TermBreach::TermAboveRange],
            },
            Vector {
                name: "unsupported pair",
                terms: terms.clone(),
                proposal: Proposal {
                    principal_asset: pair.collateral_asset,
                    collateral_asset: pair.principal_asset,
                    ..inside
                },
                breaches: vec![TermBreach::UnsupportedPair],
            },
            Vector {
                name: "second pair matches",
                terms: LenderTerms {
                    pairs: vec![pair, second],
                },
                proposal: proposal_at(&second, 500_000, 14 * 1440),
                breaches: vec![],
            },
            Vector {
                name: "repayment minimum overflows",
                terms: terms.clone(),
                proposal: Proposal {
                    principal_amount: u64::MAX,
                    collateral_amount: u64::MAX,
                    repayment_amount: u64::MAX,
                    ..inside
                },
                breaches: vec![TermBreach::PrincipalAboveRange, TermBreach::AprBelowMinimum],
            },
            Vector {
                name: "collateral minimum overflows",
                terms: one_pair(unbounded),
                proposal: Proposal {
                    principal_amount: u64::MAX,
                    collateral_amount: u64::MAX,
                    repayment_amount: u64::MAX,
                    ..inside
                },
                breaches: vec![TermBreach::CollateralBelowMinimum],
            },
            Vector {
                name: "zero amounts and term",
                terms,
                proposal: Proposal {
                    principal_amount: 0,
                    collateral_amount: 0,
                    repayment_amount: 0,
                    term_blocks: 0,
                    ..inside
                },
                breaches: vec![TermBreach::PrincipalBelowRange, TermBreach::TermBelowRange],
            },
        ]
    }

    fn amount_json(amount: Option<u64>) -> Value {
        amount.map_or(Value::Null, |amount| json!(amount.to_string()))
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

    fn proposal_json(proposal: &Proposal) -> Value {
        json!({
            "principal_asset": proposal.principal_asset.to_string(),
            "collateral_asset": proposal.collateral_asset.to_string(),
            "principal_amount": proposal.principal_amount.to_string(),
            "collateral_amount": proposal.collateral_amount.to_string(),
            "repayment_amount": proposal.repayment_amount.to_string(),
            "term_blocks": proposal.term_blocks,
        })
    }

    fn vector_json(vector: &Vector) -> Value {
        let proposal = &vector.proposal;
        let rates = vector
            .terms
            .pairs
            .iter()
            .find(|pair| {
                pair.principal_asset == proposal.principal_asset
                    && pair.collateral_asset == proposal.collateral_asset
            })
            .unwrap_or(&vector.terms.pairs[0]);
        let breaches = vector.terms.check_proposal(proposal);
        assert_eq!(breaches, vector.breaches, "{}", vector.name);

        json!({
            "name": vector.name,
            "terms": {
                "pairs": vector.terms.pairs.iter().map(pair_json).collect::<Vec<_>>(),
            },
            "proposal": proposal_json(proposal),
            "min_repayment": amount_json(min_repayment(
                proposal.principal_amount,
                rates.min_apr_bps,
                proposal.term_blocks,
            )),
            "min_collateral": amount_json(min_collateral(
                proposal.principal_amount,
                rates.max_principal_per_collateral,
            )),
            "apr_bps": amount_json(apr_bps(
                proposal.principal_amount,
                proposal.repayment_amount,
                proposal.term_blocks,
            )),
            "principal_per_collateral": amount_json(principal_per_collateral(
                proposal.principal_amount,
                proposal.collateral_amount,
            )),
            "check_proposal": breaches
                .iter()
                .map(|breach| format!("{breach:?}"))
                .collect::<Vec<_>>(),
        })
    }

    /// The vectors the web's parity check runs through the wasm. Regenerate the fixture with
    /// `WRITE_LENDER_TERMS_FIXTURE=1 cargo test -p private-lending-core parity_vectors`, then
    /// `pnpm exec prettier --write scripts/fixtures/lender-terms-parity.json` in `web`; otherwise
    /// the test compares the fixture with the vectors.
    #[test]
    fn parity_vectors() {
        let fixture = json!({
            "description": concat!(
                "Lender terms vectors from private-lending-core. Each vector's min_repayment and ",
                "min_collateral take the proposal's amounts and term with the rates of the pair ",
                "matching the proposal's assets, or of the first pair when none does; apr_bps and ",
                "principal_per_collateral take the proposal's amounts and term. null is the ",
                "core's None. Written by the parity_vectors test in lender_terms.rs.",
            ),
            "vectors": parity_inputs().iter().map(vector_json).collect::<Vec<_>>(),
        });

        if std::env::var_os("WRITE_LENDER_TERMS_FIXTURE").is_some() {
            let text = serde_json::to_string_pretty(&fixture).unwrap() + "\n";
            fs::write(FIXTURE_PATH, text).unwrap();
        } else {
            let text = fs::read_to_string(FIXTURE_PATH).unwrap();
            let written: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(
                written, fixture,
                "the fixture is stale; regenerate it as this test's documentation says"
            );
        }
    }
}
