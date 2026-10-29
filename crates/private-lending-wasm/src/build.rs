//! Building a new offer.

use elements::{AssetId, ContractHash, OutPoint};
use private_lending_core::{NewOffer as CoreNewOffer, OfferTerms};
use wasm_bindgen::prelude::*;

use crate::blind::PinnedBlinding;
use crate::error::{bad_input, encode_hex};
use crate::keys::LendingKey;
use crate::open::{ContractArguments, PinnedOutputInfo, PinnedRole, pinned_output};
use crate::scan::parse;

/// The terms of an offer to build; validated by [`NewOffer::build`].
#[wasm_bindgen]
pub struct OfferTermsInput(OfferTerms);

#[wasm_bindgen]
impl OfferTermsInput {
    #[wasm_bindgen(constructor)]
    pub fn new(
        principal_asset: &str,
        principal_amount: u64,
        repayment_amount: u64,
        interest_rate_bps: u16,
        loan_expiration_time: u32,
        borrower_nft: &str,
        lender_nft: &str,
    ) -> Result<OfferTermsInput, String> {
        Ok(Self(OfferTerms {
            principal_asset: parse("principal asset", principal_asset)?,
            principal_amount,
            repayment_amount,
            interest_rate_bps,
            loan_expiration_time,
            borrower_nft: parse("borrower NFT", borrower_nft)?,
            lender_nft: parse("lender NFT", lender_nft)?,
        }))
    }
}

/// An offer a borrower is about to create.
#[wasm_bindgen]
pub struct NewOffer {
    pub(crate) inner: CoreNewOffer,
}

#[wasm_bindgen]
impl NewOffer {
    /// Builds the offer from `borrower` to the lender (x-only key, hex) whose creation
    /// transaction spends `first_input` (`"<txid>:<vout>"`) as its input 0.
    pub fn build(
        borrower: &LendingKey,
        lender_x_only: &str,
        first_input: &str,
        collateral_asset: &str,
        collateral_amount: u64,
        terms: &OfferTermsInput,
    ) -> Result<NewOffer, String> {
        let lender = parse("lender key", lender_x_only)?;
        let first_input: OutPoint = parse("first input", first_input)?;
        let inner = CoreNewOffer::build(
            borrower.inner(),
            &lender,
            &first_input,
            crate::program_id(),
            parse::<AssetId>("collateral asset", collateral_asset)?,
            collateral_amount,
            terms.0,
        )
        .map_err(bad_input)?;
        Ok(Self { inner })
    }

    /// The 37-byte marker for the `OP_RETURN` output, hex.
    pub fn marker(&self) -> String {
        encode_hex(&self.inner.marker.encode())
    }

    #[wasm_bindgen(js_name = contractArguments)]
    pub fn contract_arguments(&self) -> ContractArguments {
        ContractArguments::new(&self.inner.signed_terms.terms, &self.inner.pinned)
    }

    pub fn pinned(&self, role: PinnedRole) -> PinnedOutputInfo {
        PinnedOutputInfo::new(pinned_output(&self.inner.pinned, role))
    }

    /// How to blind the pending collateral, output `output_index` of the creation transaction.
    #[wasm_bindgen(js_name = collateralBlinding)]
    pub fn collateral_blinding(&self, output_index: u32) -> PinnedBlinding {
        PinnedBlinding::from_core(self.inner.collateral_blinding(output_index as usize))
    }

    /// The lender's x-only public key, hex.
    #[wasm_bindgen(js_name = lenderPublicKey)]
    pub fn lender_public_key(&self) -> String {
        encode_hex(&self.inner.lender.serialize())
    }
}

/// The id of the asset that issuing from `outpoint` (`"<txid>:<vout>"`) with the contract hash
/// creates, known before the transaction exists.
#[wasm_bindgen(js_name = issuedAssetId)]
pub fn issued_asset_id(outpoint: &str, contract_hash: &str) -> Result<String, String> {
    let outpoint: OutPoint = parse("outpoint", outpoint)?;
    let contract_hash: ContractHash = parse("contract hash", contract_hash)?;
    Ok(AssetId::from_entropy(AssetId::generate_asset_entropy(outpoint, contract_hash)).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blind::{InputSecret, blind_pset};
    use crate::error::encode_hex;
    use crate::keys::LendingKey;
    use crate::open::open_creation_as_lender_hex;
    use elements::encode::serialize;
    use elements::hashes::Hash;
    use elements::pset::{Input, Output, PartiallySignedTransaction};
    use elements::{
        AssetId, ContractHash, OutPoint, Script, TxOut, TxOutWitness, Txid, bitcoin,
        confidential::{Asset, Nonce, Value},
    };
    use private_lending_core::lift_lending_key;

    const BORROWER_HASH: [u8; 32] = [0x21; 32];
    const LENDER_HASH: [u8; 32] = [0x22; 32];

    fn asset(byte: u8) -> AssetId {
        AssetId::from_slice(&[byte; 32]).unwrap()
    }

    fn script(byte: u8) -> Script {
        Script::from(vec![0x51, byte])
    }

    fn key(byte: u8) -> LendingKey {
        LendingKey::from_master_blinding_key(&encode_hex(&[byte; 32])).unwrap()
    }

    fn first_input() -> OutPoint {
        OutPoint::new(Txid::from_byte_array([7; 32]), 1)
    }

    fn lender_coin() -> OutPoint {
        OutPoint::new(Txid::from_byte_array([0xee; 32]), 1)
    }

    fn terms_input(principal: u64) -> OfferTermsInput {
        let borrower_nft = issued_asset_id(
            &first_input().to_string(),
            &ContractHash::from_byte_array(BORROWER_HASH).to_string(),
        )
        .unwrap();
        let lender_nft = issued_asset_id(
            &lender_coin().to_string(),
            &ContractHash::from_byte_array(LENDER_HASH).to_string(),
        )
        .unwrap();
        OfferTermsInput::new(
            &asset(0xaa).to_string(),
            principal,
            11_000,
            1_000,
            1_000,
            &borrower_nft,
            &lender_nft,
        )
        .unwrap()
    }

    fn build_offer(principal: u64) -> Result<NewOffer, String> {
        NewOffer::build(
            &key(1),
            &key(2).x_only_public_key(),
            &first_input().to_string(),
            &asset(0xcc).to_string(),
            50_000,
            &terms_input(principal),
        )
    }

    fn issuing_coin(
        outpoint: OutPoint,
        asset_id: AssetId,
        amount: u64,
        hash: [u8; 32],
    ) -> (Input, TxOut) {
        let txout = TxOut {
            asset: Asset::Explicit(asset_id),
            value: Value::Explicit(amount),
            nonce: Nonce::Null,
            script_pubkey: script(0xc0),
            witness: TxOutWitness::default(),
        };
        let input = Input {
            previous_txid: outpoint.txid,
            previous_output_index: outpoint.vout,
            witness_utxo: Some(txout.clone()),
            issuance_value_amount: Some(1),
            issuance_asset_entropy: Some(hash),
            blinded_issuance: Some(0),
            ..Default::default()
        };
        (input, txout)
    }

    #[test]
    fn new_offer_round_trips_through_opening() {
        let offer = build_offer(10_000).unwrap();
        let terms = offer.inner.signed_terms.terms;

        let mut pset = PartiallySignedTransaction::new_v2();
        let mut secrets = Vec::new();
        for (index, (outpoint, asset_id, amount, hash)) in [
            (first_input(), asset(0xcc), 50_000, BORROWER_HASH),
            (lender_coin(), asset(0xaa), 1_000, LENDER_HASH),
        ]
        .into_iter()
        .enumerate()
        {
            pset.add_input(issuing_coin(outpoint, asset_id, amount, hash).0);
            secrets
                .push(InputSecret::explicit(index as u32, &asset_id.to_string(), amount).unwrap());
        }

        let lender_key = bitcoin::PublicKey::new(lift_lending_key(&offer.inner.lender));
        let change_key =
            bitcoin::PublicKey::new(lift_lending_key(&key(3).inner().x_only_public_key()));
        let mut change = Output::new_explicit(script(0x14), 900, asset(0xaa), Some(change_key));
        change.blinder_index = Some(1);
        let mut collateral =
            Output::new_explicit(script(0x13), 50_000, asset(0xcc), Some(lender_key));
        collateral.blinder_index = Some(0);
        for output in [
            Output::new_explicit(script(0x10), 1, terms.borrower_nft, None),
            Output::new_explicit(script(0x11), 1, terms.lender_nft, None),
            Output::new_explicit(
                Script::new_op_return(&hex_bytes(&offer.marker())),
                0,
                asset(0xaa),
                None,
            ),
            collateral,
            change,
            Output::new_explicit(Script::new(), 100, asset(0xaa), None),
        ] {
            pset.add_output(output);
        }

        let blinded = blind_pset(
            &pset.to_string(),
            secrets,
            vec![offer.collateral_blinding(3)],
        )
        .unwrap();
        let tx = blinded
            .parse::<PartiallySignedTransaction>()
            .unwrap()
            .extract_tx()
            .unwrap();

        let opened = open_creation_as_lender_hex(&key(2), &encode_hex(&serialize(&tx))).unwrap();
        let (a, b) = (opened.contract_arguments(), offer.contract_arguments());
        assert_eq!(a.borrower_nft_asset_id(), b.borrower_nft_asset_id());
        assert_eq!(a.lender_nft_asset_id(), b.lender_nft_asset_id());
        assert_eq!(
            a.pending_collateral_commitment(),
            b.pending_collateral_commitment()
        );
        assert_eq!(
            a.active_collateral_commitment(),
            b.active_collateral_commitment()
        );
        assert_eq!(a.principal_commitment(), b.principal_commitment());
        assert_eq!(a.repayment_commitment(), b.repayment_commitment());
        assert_eq!(a.loan_expiration_time(), b.loan_expiration_time());
        assert_eq!(opened.lender_public_key(), offer.lender_public_key());
    }

    fn hex_bytes(hex: &str) -> Vec<u8> {
        crate::error::decode_hex(hex).unwrap()
    }

    #[test]
    fn issued_asset_id_matches_elements() {
        let hash = ContractHash::from_byte_array([0x33; 32]);
        let outpoint = first_input();
        let expected = AssetId::from_entropy(AssetId::generate_asset_entropy(outpoint, hash));
        assert_eq!(
            issued_asset_id(&outpoint.to_string(), &hash.to_string()).unwrap(),
            expected.to_string()
        );
        assert!(issued_asset_id("nope", &hash.to_string()).is_err());
    }

    #[test]
    fn bad_inputs_are_rejected() {
        let error = build_offer(0).err().unwrap();
        assert!(error.starts_with("bad-input:"), "{error}");
        let error = OfferTermsInput::new("zz", 1, 1, 0, 1, "zz", "zz")
            .err()
            .unwrap();
        assert!(error.starts_with("bad-input:"), "{error}");
    }
}
