//! Building an offer, and opening one found on chain as its lender or its borrower.

use std::fmt;

use elements::confidential::Nonce;
use elements::secp256k1_zkp::{PublicKey, SECP256K1, SecretKey, XOnlyPublicKey};
use elements::{AssetId, OutPoint, TxOut, TxOutSecrets};

use crate::{
    LendingKey, Marker, OfferSecrets, OfferTerms, PinnedBlinding, PinnedOutput, PinnedRole,
    RewindError, SignedTerms, TermsError, ephemeral_key, rewind,
};

/// The four pinned outputs of an offer, their blinding factors derived from the offer's shared
/// secret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OfferPinned {
    /// The collateral of the pending offer, the output of the creation transaction.
    pub pending_collateral: PinnedOutput,
    /// The same collateral once the offer is accepted.
    pub active_collateral: PinnedOutput,
    /// The principal paid to the borrower on acceptance.
    pub principal: PinnedOutput,
    /// The repayment paid to the lender on full repayment, in the principal asset.
    pub repayment: PinnedOutput,
}

impl OfferPinned {
    /// The pinned outputs of an offer with these secrets, collateral and terms: both collaterals
    /// hold the collateral asset and amount, the principal the principal asset and amount, and the
    /// repayment the principal asset and the repayment amount.
    pub fn derive(
        secrets: &OfferSecrets,
        collateral_asset: AssetId,
        collateral_amount: u64,
        terms: &OfferTerms,
    ) -> OfferPinned {
        let pinned = |role, asset_id, amount| {
            let (asset_blinding_factor, value_blinding_factor) = secrets.blinders(role);
            PinnedOutput {
                asset_id,
                amount,
                asset_blinding_factor,
                value_blinding_factor,
            }
        };

        OfferPinned {
            pending_collateral: pinned(
                PinnedRole::PendingCollateral,
                collateral_asset,
                collateral_amount,
            ),
            active_collateral: pinned(
                PinnedRole::ActiveCollateral,
                collateral_asset,
                collateral_amount,
            ),
            principal: pinned(
                PinnedRole::Principal,
                terms.principal_asset,
                terms.principal_amount,
            ),
            repayment: pinned(
                PinnedRole::Repayment,
                terms.principal_asset,
                terms.repayment_amount,
            ),
        }
    }
}

/// An offer a borrower is about to create: everything its creation transaction needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NewOffer {
    /// The key whose public key becomes the collateral output's nonce.
    pub ephemeral_sk: SecretKey,
    pub secrets: OfferSecrets,
    pub signed_terms: SignedTerms,
    pub pinned: OfferPinned,
    /// The marker of the creation transaction's `OP_RETURN` output.
    pub marker: Marker,
}

impl NewOffer {
    /// Builds the offer from `borrower` to `lender` whose creation transaction spends
    /// `first_input` as its input 0, with `program_id` in the marker.
    ///
    /// # Errors
    /// Returns an error if the collateral or the principal amount is zero (confidential amounts
    /// must be positive) or the repayment amount is below the principal amount.
    pub fn build(
        borrower: &LendingKey,
        lender: &XOnlyPublicKey,
        first_input: &OutPoint,
        program_id: [u8; 4],
        collateral_asset: AssetId,
        collateral_amount: u64,
        terms: OfferTerms,
    ) -> Result<NewOffer, OfferError> {
        if collateral_amount == 0 || terms.principal_amount == 0 {
            return Err(OfferError::ZeroAmount);
        }
        if terms.repayment_amount < terms.principal_amount {
            return Err(OfferError::RepaymentBelowPrincipal);
        }

        let ephemeral_sk = ephemeral_key(borrower, first_input);
        let secrets = OfferSecrets::for_borrower(&ephemeral_sk, lender);

        Ok(NewOffer {
            ephemeral_sk,
            secrets,
            signed_terms: SignedTerms::sign(terms, borrower, lender, first_input),
            pinned: OfferPinned::derive(&secrets, collateral_asset, collateral_amount, &terms),
            marker: Marker::new(program_id, &secrets, lender, borrower, first_input),
        })
    }

    /// How [`blind_pset`](crate::blind_pset) blinds the pending collateral, output
    /// `output_index` of the creation transaction: its nonce is the ephemeral public key and its
    /// range proof carries the signed terms.
    pub fn collateral_blinding(&self, output_index: usize) -> PinnedBlinding {
        PinnedBlinding {
            output_index,
            pinned: self.pinned.pending_collateral,
            ephemeral_sk: Some(self.ephemeral_sk),
            extra_data: self.signed_terms.encode(),
        }
    }
}

/// An offer opened by its lender or its borrower.
///
/// The terms are signed by `signed_terms.borrower` for `lender` and the creation transaction's
/// first input, and the collateral output is exactly the pinned pending collateral. Opening does
/// not check the output's script pubkey: the caller still has to recompute the offer's address
/// from the terms and `pinned`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenedOffer {
    pub signed_terms: SignedTerms,
    pub lender: XOnlyPublicKey,
    /// The secrets of the collateral output, rewound from its range proof.
    pub collateral: TxOutSecrets,
    pub secrets: OfferSecrets,
    pub pinned: OfferPinned,
}

/// Why [`NewOffer::build`] refused an offer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfferError {
    /// The collateral or the principal amount is zero.
    ZeroAmount,
    /// The repayment amount is below the principal amount.
    RepaymentBelowPrincipal,
}

impl fmt::Display for OfferError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroAmount => f.write_str("the collateral or the principal amount is zero"),
            Self::RepaymentBelowPrincipal => {
                f.write_str("the repayment amount is below the principal amount")
            }
        }
    }
}

impl std::error::Error for OfferError {}

/// Why an offer did not open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// The marker's view tag is not the shared secret's: the offer is for another lender.
    ViewTagMismatch,
    /// The offer is not this key's: its nonce is not a public key or, opening as the borrower,
    /// the nonce is not this borrower's ephemeral public key, the marker holds no lender key
    /// encrypted by this borrower, or another borrower key signed the terms.
    NotMine,
    /// The collateral output's range proof does not rewind with the shared secret, as when
    /// another lender's offer has the same view tag.
    Rewind(RewindError),
    /// The rewound terms do not decode, or they are not signed for this lender and first input.
    Terms(TermsError),
    /// The collateral output is not the pending collateral that the shared secret and the terms
    /// pin: its rewound secrets or its commitments differ.
    CollateralMismatch,
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ViewTagMismatch => f.write_str("the offer's view tag is another lender's"),
            Self::NotMine => f.write_str("the offer is not this key's"),
            Self::Rewind(_) => f.write_str("the collateral output does not rewind"),
            Self::Terms(_) => f.write_str("invalid offer terms"),
            Self::CollateralMismatch => {
                f.write_str("the collateral output is not the pinned pending collateral")
            }
        }
    }
}

impl std::error::Error for OpenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Rewind(e) => Some(e),
            Self::Terms(e) => Some(e),
            Self::ViewTagMismatch | Self::NotMine | Self::CollateralMismatch => None,
        }
    }
}

/// Opens `offer`, the pending collateral output of a creation transaction that spends
/// `first_input` as its input 0 and carries `marker`, with the lender's key.
///
/// The view tag is checked first, so most offers to other lenders fail without a rewind.
///
/// # Errors
/// Returns an error if the offer is not addressed to `lender`, its terms are not signed for
/// `lender` and `first_input`, or its collateral output is not the pinned pending collateral.
pub fn open_as_lender(
    lender: &LendingKey,
    offer: &TxOut,
    first_input: &OutPoint,
    marker: &Marker,
) -> Result<OpenedOffer, OpenError> {
    let nonce = offer.nonce.commitment().ok_or(OpenError::NotMine)?;
    let secrets = OfferSecrets::for_lender(lender, &nonce);

    open(
        offer,
        first_input,
        marker,
        lender.x_only_public_key(),
        secrets,
    )
}

/// Opens `offer`, the pending collateral output of a creation transaction that spends
/// `first_input` as its input 0 and carries `marker`, with the borrower's key: the offer's
/// ephemeral key and the lender's key, decrypted from the marker, give the shared secret.
///
/// # Errors
/// Returns an error if the borrower did not create the offer, its terms are not signed by the
/// borrower for the decrypted lender and `first_input`, or its collateral output is not the
/// pinned pending collateral.
pub fn open_as_borrower(
    borrower: &LendingKey,
    offer: &TxOut,
    first_input: &OutPoint,
    marker: &Marker,
) -> Result<OpenedOffer, OpenError> {
    let ephemeral_sk = ephemeral_key(borrower, first_input);
    let ephemeral_pk = PublicKey::from_secret_key(SECP256K1, &ephemeral_sk);
    if offer.nonce != Nonce::Confidential(ephemeral_pk) {
        return Err(OpenError::NotMine);
    }
    let lender = marker
        .decrypt_lender_key(borrower, first_input)
        .ok_or(OpenError::NotMine)?;
    let secrets = OfferSecrets::for_borrower(&ephemeral_sk, &lender);

    let opened = open(offer, first_input, marker, lender, secrets)?;
    if opened.signed_terms.borrower != borrower.x_only_public_key() {
        return Err(OpenError::NotMine);
    }

    Ok(opened)
}

/// The steps both sides share once they have the offer's secrets: check the view tag, rewind the
/// collateral, check the terms and the collateral against the outputs they pin.
fn open(
    offer: &TxOut,
    first_input: &OutPoint,
    marker: &Marker,
    lender: XOnlyPublicKey,
    secrets: OfferSecrets,
) -> Result<OpenedOffer, OpenError> {
    if marker.view_tag != secrets.view_tag() {
        return Err(OpenError::ViewTagMismatch);
    }

    let (collateral, extra_data) =
        rewind(offer, secrets.shared_secret()).map_err(OpenError::Rewind)?;
    let signed_terms = SignedTerms::decode(&extra_data).map_err(OpenError::Terms)?;
    signed_terms
        .verify(&lender, first_input)
        .map_err(OpenError::Terms)?;

    let pinned = OfferPinned::derive(
        &secrets,
        collateral.asset,
        collateral.value,
        &signed_terms.terms,
    );
    // the rewound asset and asset blinder come from the range proof's message, which nothing ties
    // to the asset commitment, so the commitments are compared too
    if pinned.pending_collateral.secrets() != collateral
        || !pinned.pending_collateral.matches(offer)
    {
        return Err(OpenError::CollateralMismatch);
    }

    Ok(OpenedOffer {
        signed_terms,
        lender,
        collateral,
        secrets,
        pinned,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::LazyLock;

    use elements::confidential::{self, AssetBlindingFactor, ValueBlindingFactor};
    use elements::hashes::Hash;
    use elements::pset::{Input, Output, PartiallySignedTransaction};
    use elements::secp256k1_zkp::RangeProof;
    use elements::{RangeProofMessage, Script, TxOutWitness, Txid, bitcoin};
    use rand::thread_rng;

    use super::*;
    use crate::{blind_pset, lift_lending_key};

    const PROGRAM_ID: [u8; 4] = [0x10, 0x11, 0x12, 0x13];
    const COLLATERAL_AMOUNT: u64 = 50_000;

    static BORROWER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[1; 32]));
    static LENDER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[2; 32]));
    static OTHER_BORROWER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[3; 32]));
    /// The txid bytes 0x00..=0x1f in internal order and a vout whose bytes differ.
    static FIRST_INPUT: LazyLock<OutPoint> = LazyLock::new(|| {
        OutPoint::new(
            Txid::from_byte_array(std::array::from_fn(|i| i as u8)),
            0x0102_0304,
        )
    });

    fn asset(byte: u8) -> AssetId {
        AssetId::from_slice(&[byte; 32]).unwrap()
    }

    fn collateral_asset() -> AssetId {
        asset(0xcc)
    }

    /// The asset of the principal and of the fee.
    fn policy_asset() -> AssetId {
        asset(0xaa)
    }

    fn sample_terms() -> OfferTerms {
        OfferTerms {
            principal_asset: policy_asset(),
            principal_amount: 10_000,
            repayment_amount: 11_000,
            interest_rate_bps: 1_000,
            loan_expiration_time: 1_000,
            borrower_nft: asset(0x44),
            lender_nft: asset(0x55),
        }
    }

    fn build(collateral_amount: u64, terms: OfferTerms) -> Result<NewOffer, OfferError> {
        NewOffer::build(
            &BORROWER,
            &LENDER.x_only_public_key(),
            &FIRST_INPUT,
            PROGRAM_ID,
            collateral_asset(),
            collateral_amount,
            terms,
        )
    }

    /// The offer from [`BORROWER`] to [`LENDER`] of the sample terms.
    fn sample_offer() -> NewOffer {
        build(COLLATERAL_AMOUNT, sample_terms()).unwrap()
    }

    fn explicit_coin(index: u32, asset_id: AssetId, amount: u64) -> (Input, TxOutSecrets) {
        let input = Input {
            previous_txid: Txid::from_byte_array([0xee; 32]),
            previous_output_index: index,
            witness_utxo: Some(TxOut {
                asset: confidential::Asset::Explicit(asset_id),
                value: confidential::Value::Explicit(amount),
                nonce: Nonce::Null,
                script_pubkey: Script::from(vec![0x51, 0xc0]),
                witness: TxOutWitness::default(),
            }),
            ..Default::default()
        };
        let secrets = TxOutSecrets::new(
            asset_id,
            AssetBlindingFactor::zero(),
            amount,
            ValueBlindingFactor::zero(),
        );
        (input, secrets)
    }

    /// The pinned output 0 of a transaction blinded with `blinding` (whose output index must be
    /// 0), addressed to [`LENDER`], with a confidential change and an explicit fee.
    fn blinded_collateral(blinding: PinnedBlinding) -> TxOut {
        assert_eq!(blinding.output_index, 0);
        let pinned = blinding.pinned;

        let mut pset = PartiallySignedTransaction::new_v2();
        let mut input_secrets = HashMap::new();
        let coins = [
            explicit_coin(0, pinned.asset_id, pinned.amount),
            explicit_coin(1, policy_asset(), 1_000),
        ];
        for (index, (input, secrets)) in coins.into_iter().enumerate() {
            pset.add_input(input);
            input_secrets.insert(index, secrets);
        }

        let lender_key = bitcoin::PublicKey::new(lift_lending_key(&LENDER.x_only_public_key()));
        pset.add_output(Output::new_explicit(
            Script::from(vec![0x51, 0x01]),
            pinned.amount,
            pinned.asset_id,
            Some(lender_key),
        ));
        let change_key =
            PublicKey::from_secret_key(SECP256K1, &SecretKey::from_slice(&[6; 32]).unwrap());
        let mut change = Output::new_explicit(
            Script::from(vec![0x51, 0x02]),
            900,
            policy_asset(),
            Some(bitcoin::PublicKey::new(change_key)),
        );
        change.blinder_index = Some(1);
        pset.add_output(change);
        pset.add_output(Output::new_explicit(
            Script::new(),
            100,
            policy_asset(),
            None,
        ));

        blind_pset(&mut pset, &input_secrets, &[blinding], &mut thread_rng()).unwrap();
        pset.extract_tx().unwrap().output.swap_remove(0)
    }

    /// The offer's pending collateral output, blinded as the creation transaction blinds it.
    fn blinded_offer_output(new: &NewOffer) -> TxOut {
        blinded_collateral(new.collateral_blinding(0))
    }

    /// An output of the offer's collateral nonce and terms whose commitments and range proof hold
    /// `actual`, while the range proof message claims the asset and asset blinder of `claimed`.
    fn forged_collateral(new: &NewOffer, actual: &PinnedOutput, claimed: &PinnedOutput) -> TxOut {
        let script_pubkey = Script::from(vec![0x51, 0x01]);
        let mut message = RangeProofMessage {
            asset: claimed.asset_id,
            bf: claimed.asset_blinding_factor,
        }
        .to_bytes()
        .to_vec();
        message.extend_from_slice(&new.signed_terms.encode());

        let (asset, value) = (actual.asset_commitment(), actual.value_commitment());
        let (generator, commitment) = (asset.commitment().unwrap(), value.commitment().unwrap());
        let rangeproof = RangeProof::new(
            SECP256K1,
            TxOut::RANGEPROOF_MIN_VALUE,
            commitment,
            actual.amount,
            actual.value_blinding_factor.into_inner(),
            &message,
            script_pubkey.as_bytes(),
            new.secrets.shared_secret(),
            TxOut::RANGEPROOF_EXP_SHIFT,
            TxOut::RANGEPROOF_MIN_PRIV_BITS,
            generator,
        )
        .unwrap();

        TxOut {
            asset,
            value,
            nonce: Nonce::Confidential(PublicKey::from_secret_key(SECP256K1, &new.ephemeral_sk)),
            script_pubkey,
            witness: TxOutWitness {
                surjection_proof: None,
                rangeproof: Some(Box::new(rangeproof)),
            },
        }
    }

    #[test]
    fn lender_opens_offer() {
        let new = sample_offer();
        let offer = blinded_offer_output(&new);

        let opened = open_as_lender(&LENDER, &offer, &FIRST_INPUT, &new.marker).unwrap();
        assert_eq!(opened.signed_terms, new.signed_terms);
        assert_eq!(opened.signed_terms.terms, sample_terms());
        assert_eq!(opened.lender, LENDER.x_only_public_key());
        assert_eq!(
            (opened.collateral.asset, opened.collateral.value),
            (collateral_asset(), COLLATERAL_AMOUNT)
        );
        assert_eq!(opened.secrets, new.secrets);
        assert_eq!(opened.pinned, new.pinned);
    }

    #[test]
    fn borrower_recovers_offer() {
        let new = sample_offer();
        let offer = blinded_offer_output(&new);

        let recovered = open_as_borrower(&BORROWER, &offer, &FIRST_INPUT, &new.marker).unwrap();
        assert_eq!(recovered.lender, LENDER.x_only_public_key());
        assert_eq!(
            recovered,
            open_as_lender(&LENDER, &offer, &FIRST_INPUT, &new.marker).unwrap()
        );
    }

    #[test]
    fn other_borrower_cannot_recover() {
        let new = sample_offer();
        let offer = blinded_offer_output(&new);

        assert_eq!(
            open_as_borrower(&OTHER_BORROWER, &offer, &FIRST_INPUT, &new.marker),
            Err(OpenError::NotMine)
        );
    }

    #[test]
    fn offer_opened_with_another_first_input_is_rejected() {
        let new = sample_offer();
        let offer = blinded_offer_output(&new);
        let other_input = OutPoint::new(FIRST_INPUT.txid, FIRST_INPUT.vout + 1);

        // the lender's secrets do not depend on the first input, but the signature does
        assert_eq!(
            open_as_lender(&LENDER, &offer, &other_input, &new.marker),
            Err(OpenError::Terms(TermsError::BadSignature))
        );
        assert_eq!(
            open_as_borrower(&BORROWER, &offer, &other_input, &new.marker),
            Err(OpenError::NotMine)
        );
    }

    #[test]
    fn view_tag_collision_with_wrong_key_is_rejected() {
        let new = sample_offer();
        let offer = blinded_offer_output(&new);
        let nonce = PublicKey::from_secret_key(SECP256K1, &new.ephemeral_sk);

        // about one key in 256 shares a one-byte view tag, so the 256 keys `[i; 32]` may all
        // miss: search master blinding keys `i_be16 ‖ 0..` instead
        let impostor = (0..=u16::MAX)
            .map(|i| {
                let mut mbk = [0; 32];
                mbk[..2].copy_from_slice(&i.to_be_bytes());
                LendingKey::from_master_blinding_key(&mbk)
            })
            .find(|key| {
                *key != *LENDER
                    && OfferSecrets::for_lender(key, &nonce).view_tag() == new.marker.view_tag
            })
            .expect("another key shares the view tag");

        assert!(matches!(
            open_as_lender(&impostor, &offer, &FIRST_INPUT, &new.marker),
            Err(OpenError::Rewind(RewindError::RangeProof(_)))
        ));
    }

    #[test]
    fn wrong_view_tag_is_rejected_before_rewinding() {
        let new = sample_offer();
        let mut offer = blinded_offer_output(&new);
        offer.witness.rangeproof = None; // rewinding would fail with MissingRangeProof
        let mut marker = new.marker;
        marker.view_tag ^= 1;

        assert_eq!(
            open_as_lender(&LENDER, &offer, &FIRST_INPUT, &marker),
            Err(OpenError::ViewTagMismatch)
        );
        assert_eq!(
            open_as_borrower(&BORROWER, &offer, &FIRST_INPUT, &marker),
            Err(OpenError::ViewTagMismatch)
        );
    }

    #[test]
    fn collateral_with_foreign_blinders_is_rejected() {
        let new = sample_offer();
        let mut rng = thread_rng();
        let foreign = PinnedOutput {
            asset_blinding_factor: AssetBlindingFactor::new(&mut rng),
            value_blinding_factor: ValueBlindingFactor::new(&mut rng),
            ..new.pinned.pending_collateral
        };
        let offer = blinded_collateral(PinnedBlinding {
            pinned: foreign,
            ..new.collateral_blinding(0)
        });

        assert_eq!(
            open_as_lender(&LENDER, &offer, &FIRST_INPUT, &new.marker),
            Err(OpenError::CollateralMismatch)
        );
        assert_eq!(
            open_as_borrower(&BORROWER, &offer, &FIRST_INPUT, &new.marker),
            Err(OpenError::CollateralMismatch)
        );
    }

    #[test]
    fn collateral_of_another_asset_is_rejected() {
        let new = sample_offer();
        let pending = new.pinned.pending_collateral;
        let other_asset = PinnedOutput {
            asset_id: asset(0xdd),
            ..pending
        };
        let offer = forged_collateral(&new, &other_asset, &pending);

        // the range proof message claims exactly the pinned secrets: only the commitments differ
        let (rewound, _) = rewind(&offer, new.secrets.shared_secret()).unwrap();
        assert_eq!(rewound, pending.secrets());

        assert_eq!(
            open_as_lender(&LENDER, &offer, &FIRST_INPUT, &new.marker),
            Err(OpenError::CollateralMismatch)
        );
    }

    #[test]
    fn collateral_message_with_another_asset_blinder_is_rejected() {
        let new = sample_offer();
        let pending = new.pinned.pending_collateral;
        let other_blinder = PinnedOutput {
            asset_blinding_factor: AssetBlindingFactor::new(&mut thread_rng()),
            ..pending
        };
        let offer = forged_collateral(&new, &pending, &other_blinder);

        // the commitments are the pinned ones: only the rewound secrets differ
        assert!(pending.matches(&offer));

        assert_eq!(
            open_as_lender(&LENDER, &offer, &FIRST_INPUT, &new.marker),
            Err(OpenError::CollateralMismatch)
        );
    }

    #[test]
    fn borrower_rejects_terms_signed_by_another_key() {
        let mut new = sample_offer();
        new.signed_terms = SignedTerms::sign(
            sample_terms(),
            &OTHER_BORROWER,
            &LENDER.x_only_public_key(),
            &FIRST_INPUT,
        );
        let offer = blinded_offer_output(&new);

        // the lender sees a valid offer from the key that signed the terms
        let opened = open_as_lender(&LENDER, &offer, &FIRST_INPUT, &new.marker).unwrap();
        assert_eq!(
            opened.signed_terms.borrower,
            OTHER_BORROWER.x_only_public_key()
        );
        assert_eq!(
            open_as_borrower(&BORROWER, &offer, &FIRST_INPUT, &new.marker),
            Err(OpenError::NotMine)
        );
    }

    #[test]
    fn build_rejects_invalid_amounts() {
        let terms = sample_terms();

        let zero_principal = OfferTerms {
            principal_amount: 0,
            ..terms
        };
        assert_eq!(
            build(COLLATERAL_AMOUNT, zero_principal).err(),
            Some(OfferError::ZeroAmount)
        );

        let repayment_below_principal = OfferTerms {
            repayment_amount: terms.principal_amount - 1,
            ..terms
        };
        assert_eq!(
            build(COLLATERAL_AMOUNT, repayment_below_principal).err(),
            Some(OfferError::RepaymentBelowPrincipal)
        );

        assert_eq!(build(0, terms).err(), Some(OfferError::ZeroAmount));

        let no_interest = OfferTerms {
            repayment_amount: terms.principal_amount,
            ..terms
        };
        assert!(build(COLLATERAL_AMOUNT, no_interest).is_ok());
    }
}
