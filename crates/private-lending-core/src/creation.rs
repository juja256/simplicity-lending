//! Finding an offer in its creation transaction, and opening and checking it there: the
//! checks that do not need the contract's addresses.

use std::fmt;

use elements::locktime::LOCK_TIME_THRESHOLD;
use elements::opcodes::all::OP_RETURN;
use elements::script::Instruction;
use elements::secp256k1_zkp::ZERO_TWEAK;
use elements::{AssetId, OutPoint, Script, Transaction, TxIn, TxOut, confidential};

use crate::offer::{open_as_borrower, open_as_lender};
use crate::{LendingKey, Marker, OpenError, OpenedOffer};

/// The output of a creation transaction that carries the borrower NFT.
const BORROWER_NFT_OUTPUT_INDEX: usize = 0;
/// The output of a creation transaction that carries the lender NFT.
const LENDER_NFT_OUTPUT_INDEX: usize = 1;
/// The output of a creation transaction that carries the marker.
const MARKER_OUTPUT_INDEX: usize = 2;
/// The output of a creation transaction that holds the pending offer.
const OFFER_OUTPUT_INDEX: usize = 3;
/// The input of a creation transaction that issues the lender NFT.
const LENDER_NFT_INPUT_INDEX: usize = 1;

/// An offer found in its creation transaction, not opened yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FoundOffer {
    /// The marker, the `OP_RETURN` payload of output 2.
    pub marker: Marker,
    /// The pending offer, output 3.
    pub offer: TxOut,
    /// The outpoint of the pending offer.
    pub offer_outpoint: OutPoint,
    /// The outpoint input 0 spends, the offer's first input.
    pub first_input: OutPoint,
    /// The asset of output 0, the borrower NFT.
    pub borrower_nft: AssetId,
    /// The asset of output 1, the lender NFT.
    pub lender_nft: AssetId,
}

/// Why a creation transaction does not carry an offer that this key may act on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreationError {
    /// The transaction does not carry an offer of this program in the creation layout: no input,
    /// outputs 0 and 1 without explicit assets, no marker of this program at output 2, or no
    /// output 3.
    NotFound,
    /// The offer does not open with this key.
    Open(OpenError),
    /// The terms lend nothing, ask back less than they lend, or expire at a lock time from
    /// 500 000 000 on, a timestamp, which a block height never reaches: the lender could never
    /// liquidate.
    InvalidTerms,
    /// Input 1 does not newly issue exactly one unit of the terms' lender NFT without a
    /// reissuance token. Another unit could claim the repayment or liquidate.
    LenderNftNotUnique,
    /// Outputs 0 and 1 are not one explicit unit each of the terms' borrower NFT and lender NFT.
    NftOutputMismatch,
}

impl fmt::Display for CreationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => f.write_str("the transaction does not create an offer"),
            Self::Open(_) => f.write_str("the offer does not open"),
            Self::InvalidTerms => f.write_str(
                "the principal is zero, the repayment is below the principal or the expiration is \
                 not a block height",
            ),
            Self::LenderNftNotUnique => f.write_str(
                "the creation transaction does not issue the lender NFT as a single unit",
            ),
            Self::NftOutputMismatch => {
                f.write_str("outputs 0 and 1 are not one unit each of the terms' NFTs")
            }
        }
    }
}

impl std::error::Error for CreationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Open(e) => Some(e),
            Self::NotFound
            | Self::InvalidTerms
            | Self::LenderNftNotUnique
            | Self::NftOutputMismatch => None,
        }
    }
}

/// The offer of the program `program_id` that `creation_tx` creates, found by the creation
/// layout: the marker at output 2, the pending offer at output 3, the first input at input 0,
/// and the NFTs at outputs 0 and 1.
///
/// Returns `None` if `creation_tx` has no input, outputs 0 or 1 have no explicit asset, output
/// 2 does not carry a marker with `program_id`, or there is no output 3. The offer is neither
/// opened nor checked; see [`open_creation_as_lender`] and [`open_creation_as_borrower`].
pub fn find_offer(creation_tx: &Transaction, program_id: [u8; 4]) -> Option<FoundOffer> {
    let marker_output = creation_tx.output.get(MARKER_OUTPUT_INDEX)?;
    let marker = Marker::decode(op_return_payload(&marker_output.script_pubkey)?)?;
    if marker.program_id != program_id {
        return None;
    }

    let explicit_asset = |index: usize| creation_tx.output.get(index)?.asset.explicit();

    Some(FoundOffer {
        marker,
        offer: creation_tx.output.get(OFFER_OUTPUT_INDEX)?.clone(),
        offer_outpoint: OutPoint::new(creation_tx.txid(), OFFER_OUTPUT_INDEX as u32),
        first_input: creation_tx.input.first()?.previous_output,
        borrower_nft: explicit_asset(BORROWER_NFT_OUTPUT_INDEX)?,
        lender_nft: explicit_asset(LENDER_NFT_OUTPUT_INDEX)?,
    })
}

/// Finds, opens and checks the offer of the program `program_id` that `creation_tx` creates,
/// with the lender's key: what a lender runs before accepting an offer.
///
/// Opening checks the borrower's signature of the terms for this lender and the first input, and
/// that the collateral is the pinned pending collateral. Then this checks that:
/// - the terms lend something, ask back at least as much, and expire at a block height;
/// - input 1 newly issues exactly one unit of the terms' lender NFT and no reissuance token, so
///   the lender NFT that unlocks the repayment and the liquidation has no other copy;
/// - outputs 0 and 1 are one explicit unit each of the terms' borrower NFT and lender NFT.
///
/// It does not check the addresses, which need the contract: the caller still checks that output
/// 3 is at the pending offer address that the terms and the pinned outputs give, and that output
/// 1 locks the lender NFT to that offer.
///
/// # Errors
/// Returns [`CreationError::NotFound`], [`CreationError::Open`],
/// [`CreationError::InvalidTerms`], [`CreationError::LenderNftNotUnique`] or
/// [`CreationError::NftOutputMismatch`], in this order, for the first step that fails.
pub fn open_creation_as_lender(
    lender: &LendingKey,
    creation_tx: &Transaction,
    program_id: [u8; 4],
) -> Result<OpenedOffer, CreationError> {
    let found = find_offer(creation_tx, program_id).ok_or(CreationError::NotFound)?;
    let opened = open_as_lender(lender, &found).map_err(CreationError::Open)?;
    check_creation(creation_tx, &opened)?;

    Ok(opened)
}

/// [`open_creation_as_lender`] with the borrower's key: the offer's ephemeral key and the
/// lender's key, decrypted from the marker, give the shared secret.
///
/// The borrower runs it to recover its offers from the chain and, with the address checks, on
/// its finished creation transaction before broadcasting it: an offer that fails would never be
/// accepted, and the borrower could not rebuild it from the chain to cancel it, which strands the
/// collateral.
///
/// # Errors
/// As [`open_creation_as_lender`]; opening fails with [`OpenError::NotMine`] if the borrower did
/// not create the offer.
pub fn open_creation_as_borrower(
    borrower: &LendingKey,
    creation_tx: &Transaction,
    program_id: [u8; 4],
) -> Result<OpenedOffer, CreationError> {
    let found = find_offer(creation_tx, program_id).ok_or(CreationError::NotFound)?;
    let opened = open_as_borrower(borrower, &found).map_err(CreationError::Open)?;
    check_creation(creation_tx, &opened)?;

    Ok(opened)
}

/// The checks of an opened offer against its terms and its creation transaction, shared by both
/// sides.
fn check_creation(creation_tx: &Transaction, opened: &OpenedOffer) -> Result<(), CreationError> {
    let terms = &opened.signed_terms.terms;
    if terms.principal_amount == 0
        || terms.repayment_amount < terms.principal_amount
        || terms.loan_expiration_time >= LOCK_TIME_THRESHOLD
    {
        return Err(CreationError::InvalidTerms);
    }

    let lender_nft_input = creation_tx.input.get(LENDER_NFT_INPUT_INDEX);
    if !lender_nft_input.is_some_and(|input| issues_single_unit(input, terms.lender_nft)) {
        return Err(CreationError::LenderNftNotUnique);
    }

    let is_single_unit = |index: usize, asset_id| {
        creation_tx.output.get(index).is_some_and(|output| {
            output.asset == confidential::Asset::Explicit(asset_id)
                && output.value == confidential::Value::Explicit(1)
        })
    };
    if !is_single_unit(BORROWER_NFT_OUTPUT_INDEX, terms.borrower_nft)
        || !is_single_unit(LENDER_NFT_OUTPUT_INDEX, terms.lender_nft)
    {
        return Err(CreationError::NftOutputMismatch);
    }

    Ok(())
}

/// Whether `input` issues `asset_id` for the first time (a new issuance, not a reissuance), one
/// explicit unit and no reissuance token: then that unit is the asset's whole supply.
fn issues_single_unit(input: &TxIn, asset_id: AssetId) -> bool {
    let issuance = &input.asset_issuance;

    issuance.asset_blinding_nonce == ZERO_TWEAK
        && issuance.amount == confidential::Value::Explicit(1)
        && matches!(
            issuance.inflation_keys,
            confidential::Value::Null | confidential::Value::Explicit(0)
        )
        && input.issuance_ids().0 == asset_id
}

/// The data pushed after `OP_RETURN`, if `script` starts with `OP_RETURN` and a push.
fn op_return_payload(script: &Script) -> Option<&[u8]> {
    let mut instructions = script.instructions_minimal();

    match instructions.next()? {
        Ok(Instruction::Op(OP_RETURN)) => {}
        _ => return None,
    }

    instructions.next()?.ok()?.push_bytes()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::LazyLock;

    use elements::confidential::{AssetBlindingFactor, Nonce, ValueBlindingFactor};
    use elements::hashes::Hash;
    use elements::pset::{Input, Output, PartiallySignedTransaction};
    use elements::secp256k1_zkp::{SECP256K1, Tweak};
    use elements::{ContractHash, TxOutSecrets, TxOutWitness, Txid, bitcoin};
    use rand::thread_rng;

    use super::*;
    use crate::{
        NewOffer, OfferPinned, OfferSecrets, OfferTerms, SignedTerms, blind_pset, ephemeral_key,
        lift_lending_key,
    };

    const PROGRAM_ID: [u8; 4] = [0x10, 0x11, 0x12, 0x13];
    const COLLATERAL_AMOUNT: u64 = 50_000;
    /// The contract hashes of the NFT issuances.
    const BORROWER_NFT_CONTRACT_HASH: [u8; 32] = [0x21; 32];
    const LENDER_NFT_CONTRACT_HASH: [u8; 32] = [0x22; 32];

    static BORROWER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[1; 32]));
    static LENDER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[2; 32]));
    static STRANGER: LazyLock<LendingKey> =
        LazyLock::new(|| LendingKey::from_master_blinding_key(&[3; 32]));
    /// Input 0 of the creation transaction, which issues the borrower NFT.
    static FIRST_INPUT: LazyLock<OutPoint> = LazyLock::new(|| {
        OutPoint::new(
            Txid::from_byte_array(std::array::from_fn(|i| i as u8)),
            0x0102_0304,
        )
    });
    /// Input 1 of the creation transaction, which issues the lender NFT.
    static LENDER_NFT_COIN: LazyLock<OutPoint> =
        LazyLock::new(|| OutPoint::new(Txid::from_byte_array([0xee; 32]), 1));

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

    fn script(byte: u8) -> Script {
        Script::from(vec![0x51, byte])
    }

    fn issuance_entropy(
        coin: OutPoint,
        contract_hash: [u8; 32],
    ) -> elements::hashes::sha256::Midstate {
        AssetId::generate_asset_entropy(coin, ContractHash::from_byte_array(contract_hash))
    }

    fn borrower_nft() -> AssetId {
        AssetId::from_entropy(issuance_entropy(*FIRST_INPUT, BORROWER_NFT_CONTRACT_HASH))
    }

    fn lender_nft() -> AssetId {
        AssetId::from_entropy(issuance_entropy(*LENDER_NFT_COIN, LENDER_NFT_CONTRACT_HASH))
    }

    fn sample_terms() -> OfferTerms {
        OfferTerms {
            principal_asset: policy_asset(),
            principal_amount: 10_000,
            repayment_amount: 11_000,
            interest_rate_bps: 1_000,
            loan_expiration_time: 1_000,
            borrower_nft: borrower_nft(),
            lender_nft: lender_nft(),
        }
    }

    /// The offer of `terms` from [`BORROWER`] to [`LENDER`], built without the checks of
    /// [`NewOffer::build`], as a dishonest borrower may.
    fn unchecked_offer(terms: OfferTerms) -> NewOffer {
        let lender = LENDER.x_only_public_key();
        let ephemeral_sk = ephemeral_key(
            &BORROWER,
            &FIRST_INPUT,
            terms.borrower_nft,
            terms.lender_nft,
        );
        let secrets = OfferSecrets::for_borrower(&ephemeral_sk, &lender);

        NewOffer {
            lender,
            first_input: *FIRST_INPUT,
            ephemeral_sk,
            secrets,
            signed_terms: SignedTerms::sign(terms, &BORROWER, &lender, &FIRST_INPUT),
            pinned: OfferPinned::derive(&secrets, collateral_asset(), COLLATERAL_AMOUNT, &terms),
            marker: Marker::new(
                PROGRAM_ID,
                &secrets,
                &lender,
                &BORROWER,
                &FIRST_INPUT,
                terms.borrower_nft,
                terms.lender_nft,
            ),
        }
    }

    fn sample_offer() -> NewOffer {
        NewOffer::build(
            &BORROWER,
            &LENDER.x_only_public_key(),
            &FIRST_INPUT,
            PROGRAM_ID,
            collateral_asset(),
            COLLATERAL_AMOUNT,
            sample_terms(),
        )
        .unwrap()
    }

    /// An explicit coin at `outpoint` that issues one unit with `contract_hash`.
    fn issuing_coin(
        outpoint: OutPoint,
        asset_id: AssetId,
        amount: u64,
        contract_hash: [u8; 32],
    ) -> (Input, TxOut, TxOutSecrets) {
        let txout = TxOut {
            asset: confidential::Asset::Explicit(asset_id),
            value: confidential::Value::Explicit(amount),
            nonce: Nonce::Null,
            script_pubkey: script(0xc0),
            witness: TxOutWitness::default(),
        };
        let input = Input {
            previous_txid: outpoint.txid,
            previous_output_index: outpoint.vout,
            witness_utxo: Some(txout.clone()),
            issuance_value_amount: Some(1),
            issuance_asset_entropy: Some(contract_hash),
            // an explicit issuance, which the PSET blinder leaves alone
            blinded_issuance: Some(0),
            ..Default::default()
        };
        let secrets = TxOutSecrets::new(
            asset_id,
            AssetBlindingFactor::zero(),
            amount,
            ValueBlindingFactor::zero(),
        );
        (input, txout, secrets)
    }

    /// The creation transaction of `new`, unsigned, with the spent coins: inputs 0 and 1 issue
    /// the NFTs of its terms, outputs 0 and 1 hold them, output 2 carries the marker and output
    /// 3 the pending collateral blinded to the lender; a confidential change and an explicit fee
    /// follow.
    fn creation_tx_spending(new: &NewOffer) -> (Transaction, Vec<TxOut>) {
        let terms = new.signed_terms.terms;
        let coins = [
            issuing_coin(
                *FIRST_INPUT,
                collateral_asset(),
                COLLATERAL_AMOUNT,
                BORROWER_NFT_CONTRACT_HASH,
            ),
            issuing_coin(
                *LENDER_NFT_COIN,
                policy_asset(),
                1_000,
                LENDER_NFT_CONTRACT_HASH,
            ),
        ];

        let mut pset = PartiallySignedTransaction::new_v2();
        let mut input_secrets = HashMap::new();
        let mut spent = Vec::new();
        for (index, (input, txout, secrets)) in coins.into_iter().enumerate() {
            pset.add_input(input);
            input_secrets.insert(index, secrets);
            spent.push(txout);
        }

        let lender_key = bitcoin::PublicKey::new(lift_lending_key(&new.lender));
        let change_key = bitcoin::PublicKey::new(lift_lending_key(&STRANGER.x_only_public_key()));
        let mut change = Output::new_explicit(script(0x14), 900, policy_asset(), Some(change_key));
        change.blinder_index = Some(1);
        for output in [
            Output::new_explicit(script(0x10), 1, terms.borrower_nft, None),
            Output::new_explicit(script(0x11), 1, terms.lender_nft, None),
            Output::new_explicit(
                Script::new_op_return(&new.marker.encode()),
                0,
                policy_asset(),
                None,
            ),
            Output::new_explicit(
                script(0x13),
                COLLATERAL_AMOUNT,
                collateral_asset(),
                Some(lender_key),
            ),
            change,
            Output::new_explicit(Script::new(), 100, policy_asset(), None),
        ] {
            pset.add_output(output);
        }

        blind_pset(
            &mut pset,
            &input_secrets,
            &[new.collateral_blinding(OFFER_OUTPUT_INDEX)],
            &mut thread_rng(),
        )
        .unwrap();

        (pset.extract_tx().unwrap(), spent)
    }

    fn creation_tx(new: &NewOffer) -> Transaction {
        creation_tx_spending(new).0
    }

    /// Both sides' results for `creation_tx`.
    fn open_both(creation_tx: &Transaction) -> [Result<OpenedOffer, CreationError>; 2] {
        [
            open_creation_as_lender(&LENDER, creation_tx, PROGRAM_ID),
            open_creation_as_borrower(&BORROWER, creation_tx, PROGRAM_ID),
        ]
    }

    #[test]
    fn creation_transaction_balances() {
        let (mut tx, spent) = creation_tx_spending(&sample_offer());

        // the verifier refuses explicit zero values, and the marker carries nothing
        tx.output.remove(MARKER_OUTPUT_INDEX);
        tx.verify_tx_amt_proofs(SECP256K1, &spent).unwrap();
    }

    #[test]
    fn lender_and_borrower_open_the_creation_transaction() {
        let new = sample_offer();
        let tx = creation_tx(&new);

        let opened = open_creation_as_lender(&LENDER, &tx, PROGRAM_ID).unwrap();
        assert_eq!(opened.signed_terms, new.signed_terms);
        assert_eq!(opened.lender, new.lender);
        assert_eq!(opened.pinned, new.pinned);

        // the borrower recovers the offer from its key and the chain alone
        assert_eq!(
            open_creation_as_borrower(&BORROWER, &tx, PROGRAM_ID),
            Ok(opened)
        );
    }

    #[test]
    fn find_offer_reads_the_creation_layout() {
        let new = sample_offer();
        let tx = creation_tx(&new);

        assert_eq!(
            find_offer(&tx, PROGRAM_ID),
            Some(FoundOffer {
                marker: new.marker,
                offer: tx.output[3].clone(),
                offer_outpoint: OutPoint::new(tx.txid(), 3),
                first_input: *FIRST_INPUT,
                borrower_nft: borrower_nft(),
                lender_nft: lender_nft(),
            })
        );
    }

    #[test]
    fn transaction_without_an_offer_is_not_found() {
        let tx = creation_tx(&sample_offer());
        let with = |change: fn(&mut Transaction)| {
            let mut tx = tx.clone();
            change(&mut tx);
            tx
        };

        let not_found = [
            with(|tx| tx.input.clear()),
            // a confidential output 0 names no borrower NFT
            with(|tx| tx.output[0] = tx.output[4].clone()),
            with(|tx| tx.output[1].asset = tx.output[4].asset),
            with(|tx| tx.output[2].script_pubkey = Script::new_op_return(&[0; 37])),
            with(|tx| tx.output[2].script_pubkey = Script::new_op_return(&[0; 36])),
            with(|tx| tx.output[2].script_pubkey = script(0x12)),
            with(|tx| tx.output.truncate(3)),
        ];
        for tx in &not_found {
            assert_eq!(find_offer(tx, PROGRAM_ID), None);
            assert_eq!(open_both(tx), [Err(CreationError::NotFound); 2]);
        }

        // another program's marker
        assert_eq!(find_offer(&tx, [0x10, 0x11, 0x12, 0x14]), None);
    }

    #[test]
    fn offer_for_another_key_does_not_open() {
        let tx = creation_tx(&sample_offer());

        assert!(matches!(
            open_creation_as_lender(&STRANGER, &tx, PROGRAM_ID),
            Err(CreationError::Open(_))
        ));
        assert_eq!(
            open_creation_as_borrower(&STRANGER, &tx, PROGRAM_ID),
            Err(CreationError::Open(OpenError::NotMine))
        );
    }

    #[test]
    fn invalid_terms_are_rejected() {
        let terms = sample_terms();
        let invalid = [
            OfferTerms {
                principal_amount: 0,
                ..terms
            },
            OfferTerms {
                repayment_amount: terms.principal_amount - 1,
                ..terms
            },
            // a lock time from 500_000_000 on is a timestamp: the lender could never liquidate
            OfferTerms {
                loan_expiration_time: 500_000_000,
                ..terms
            },
        ];
        for terms in invalid {
            let tx = creation_tx(&unchecked_offer(terms));

            assert_eq!(open_both(&tx), [Err(CreationError::InvalidTerms); 2]);
        }

        let last_height = OfferTerms {
            loan_expiration_time: 499_999_999,
            ..terms
        };
        let tx = creation_tx(&unchecked_offer(last_height));
        assert!(open_both(&tx).iter().all(Result::is_ok));
    }

    #[test]
    fn non_unique_lender_nft_is_rejected() {
        let tx = creation_tx(&sample_offer());
        let with = |change: fn(&mut Transaction)| {
            let mut tx = tx.clone();
            change(&mut tx);
            tx
        };

        let not_unique = [
            // a second unit
            with(|tx| tx.input[1].asset_issuance.amount = confidential::Value::Explicit(2)),
            // a reissuance token
            with(|tx| {
                tx.input[1].asset_issuance.inflation_keys = confidential::Value::Explicit(1);
            }),
            // no issuance at all
            with(|tx| tx.input[1].asset_issuance.amount = confidential::Value::Null),
            // a reissuance: input 1 gives the NFT's asset id, but the NFT exists already
            with(|tx| {
                let reissuance = &mut tx.input[1].asset_issuance;
                reissuance.asset_blinding_nonce = Tweak::from_slice(&[1; 32]).unwrap();
                reissuance.asset_entropy =
                    issuance_entropy(*LENDER_NFT_COIN, LENDER_NFT_CONTRACT_HASH).to_byte_array();
            }),
            with(|tx| tx.input.truncate(1)),
        ];
        assert_eq!(not_unique[3].input[1].issuance_ids().0, lender_nft());
        for tx in &not_unique {
            assert_eq!(open_both(tx), [Err(CreationError::LenderNftNotUnique); 2]);
        }

        // terms that name another lender NFT than the one input 1 issues
        let other_nft = OfferTerms {
            lender_nft: asset(0x55),
            ..sample_terms()
        };
        let tx = creation_tx(&unchecked_offer(other_nft));
        assert_eq!(open_both(&tx), [Err(CreationError::LenderNftNotUnique); 2]);
    }

    #[test]
    fn nft_outputs_must_hold_one_unit_of_the_terms_nfts() {
        let tx = creation_tx(&sample_offer());
        let with = |change: fn(&mut Transaction)| {
            let mut tx = tx.clone();
            change(&mut tx);
            tx
        };

        // the lender sees the terms, so it checks outputs 0 and 1 against them
        let mismatched = [
            with(|tx| tx.output[0].value = confidential::Value::Explicit(2)),
            with(|tx| tx.output[1].value = confidential::Value::Explicit(0)),
            with(|tx| tx.output[0].asset = confidential::Asset::Explicit(asset(0x44))),
            with(|tx| tx.output[1].asset = confidential::Asset::Explicit(asset(0x55))),
        ];
        for tx in &mismatched {
            assert_eq!(
                open_creation_as_lender(&LENDER, tx, PROGRAM_ID),
                Err(CreationError::NftOutputMismatch)
            );
        }

        // the borrower's ephemeral key depends on the NFTs in outputs 0 and 1: with others, the
        // offer is not its
        assert_eq!(
            open_creation_as_borrower(&BORROWER, &mismatched[0], PROGRAM_ID),
            Err(CreationError::NftOutputMismatch)
        );
        assert_eq!(
            open_creation_as_borrower(&BORROWER, &mismatched[3], PROGRAM_ID),
            Err(CreationError::Open(OpenError::NotMine))
        );
    }
}
