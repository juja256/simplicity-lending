//! Opening offers from their creation transactions.

use elements::encode::deserialize;
use elements::hex::ToHex;
use elements::{Transaction, confidential};
use private_lending_core::{
    CreationError, OfferPinned, OfferTerms, OpenedOffer as CoreOpenedOffer, PinnedOutput,
    PinnedRole as CorePinnedRole, lift_lending_key, open_creation_as_borrower,
    open_creation_as_lender,
};
use wasm_bindgen::prelude::*;

use crate::error::{bad_input, creation_error, decode_hex, encode_hex};
use crate::keys::LendingKey;

/// The outputs of the offer contract whose blinding factors derive from the shared secret.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PinnedRole {
    PendingCollateral,
    ActiveCollateral,
    Principal,
    Repayment,
}

impl From<PinnedRole> for CorePinnedRole {
    fn from(role: PinnedRole) -> Self {
        match role {
            PinnedRole::PendingCollateral => CorePinnedRole::PendingCollateral,
            PinnedRole::ActiveCollateral => CorePinnedRole::ActiveCollateral,
            PinnedRole::Principal => CorePinnedRole::Principal,
            PinnedRole::Repayment => CorePinnedRole::Repayment,
        }
    }
}

/// An offer opened from its creation transaction.
#[wasm_bindgen]
pub struct OpenedOffer {
    offer: CoreOpenedOffer,
    first_input: String,
}

impl OpenedOffer {
    pub(crate) fn inner(&self) -> &CoreOpenedOffer {
        &self.offer
    }

    fn new(offer: CoreOpenedOffer, tx: &Transaction) -> Result<Self, String> {
        let outpoint = tx
            .input
            .first()
            .ok_or_else(|| bad_input("the transaction has no inputs"))?
            .previous_output;
        // not `OutPoint`'s `Display`, which prefixes "[elements]"
        let first_input = format!("{}:{}", outpoint.txid, outpoint.vout);
        Ok(Self { offer, first_input })
    }
}

/// The lifted lending key, hex of the 33-byte compressed public key.
pub(crate) fn lifted(key: &elements::secp256k1_zkp::XOnlyPublicKey) -> String {
    encode_hex(&lift_lending_key(key).serialize())
}

fn parse_tx(hex: &str) -> Result<Transaction, String> {
    deserialize(&decode_hex(hex)?).map_err(|e| bad_input(format!("not a transaction: {e}")))
}

fn open(
    creation_tx_hex: &str,
    open: impl FnOnce(&Transaction) -> Result<CoreOpenedOffer, CreationError>,
) -> Result<OpenedOffer, String> {
    let tx = parse_tx(creation_tx_hex)?;
    let offer = open(&tx).map_err(creation_error)?;
    OpenedOffer::new(offer, &tx)
}

/// Opens the offer of a creation transaction as the lender it is addressed to.
#[wasm_bindgen(js_name = openCreationAsLender)]
pub fn open_creation_as_lender_hex(
    lender: &LendingKey,
    creation_tx_hex: &str,
) -> Result<OpenedOffer, String> {
    open(creation_tx_hex, |tx| {
        open_creation_as_lender(lender.inner(), tx, crate::program_id())
    })
}

/// Opens the offer of a creation transaction as the borrower who created it.
#[wasm_bindgen(js_name = openCreationAsBorrower)]
pub fn open_creation_as_borrower_hex(
    borrower: &LendingKey,
    creation_tx_hex: &str,
) -> Result<OpenedOffer, String> {
    open(creation_tx_hex, |tx| {
        open_creation_as_borrower(borrower.inner(), tx, crate::program_id())
    })
}

#[wasm_bindgen]
impl OpenedOffer {
    #[wasm_bindgen(js_name = principalAsset)]
    pub fn principal_asset(&self) -> String {
        self.offer.signed_terms.terms.principal_asset.to_string()
    }

    #[wasm_bindgen(js_name = principalAmount)]
    pub fn principal_amount(&self) -> u64 {
        self.offer.signed_terms.terms.principal_amount
    }

    #[wasm_bindgen(js_name = repaymentAmount)]
    pub fn repayment_amount(&self) -> u64 {
        self.offer.signed_terms.terms.repayment_amount
    }

    /// For display only: the interest is the difference of the two amounts.
    #[wasm_bindgen(js_name = interestRateBps)]
    pub fn interest_rate_bps(&self) -> u16 {
        self.offer.signed_terms.terms.interest_rate_bps
    }

    #[wasm_bindgen(js_name = loanExpirationTime)]
    pub fn loan_expiration_time(&self) -> u32 {
        self.offer.signed_terms.terms.loan_expiration_time
    }

    #[wasm_bindgen(js_name = borrowerNft)]
    pub fn borrower_nft(&self) -> String {
        self.offer.signed_terms.terms.borrower_nft.to_string()
    }

    #[wasm_bindgen(js_name = lenderNft)]
    pub fn lender_nft(&self) -> String {
        self.offer.signed_terms.terms.lender_nft.to_string()
    }

    /// The borrower's x-only public key, hex.
    #[wasm_bindgen(js_name = borrowerPublicKey)]
    pub fn borrower_public_key(&self) -> String {
        encode_hex(&self.offer.signed_terms.borrower.serialize())
    }

    /// The lender's x-only public key, hex.
    #[wasm_bindgen(js_name = lenderPublicKey)]
    pub fn lender_public_key(&self) -> String {
        encode_hex(&self.offer.lender.serialize())
    }

    #[wasm_bindgen(js_name = collateralAsset)]
    pub fn collateral_asset(&self) -> String {
        self.offer.collateral.asset.to_string()
    }

    #[wasm_bindgen(js_name = collateralAmount)]
    pub fn collateral_amount(&self) -> u64 {
        self.offer.collateral.value
    }

    /// The outpoint `"<txid>:<vout>"` that input 0 of the creation transaction spends.
    #[wasm_bindgen(js_name = firstInput)]
    pub fn first_input(&self) -> String {
        self.first_input.clone()
    }

    /// The blinding key, the lifted lender key (33-byte compressed public key, hex), that the
    /// creation transaction's collateral output carries. Outputs spent into the lender's
    /// control must carry it.
    #[wasm_bindgen(js_name = lenderBlindingKey)]
    pub fn lender_blinding_key(&self) -> String {
        lifted(&self.offer.lender)
    }

    /// The blinding key, the lifted borrower key (33-byte compressed public key, hex), that
    /// the outputs of acceptance must carry: the PSET output must have exactly this blinding
    /// key.
    #[wasm_bindgen(js_name = borrowerBlindingKey)]
    pub fn borrower_blinding_key(&self) -> String {
        lifted(&self.offer.signed_terms.borrower)
    }

    /// The arguments of the offer's contract.
    #[wasm_bindgen(js_name = contractArguments)]
    pub fn contract_arguments(&self) -> ContractArguments {
        ContractArguments::new(&self.offer.signed_terms.terms, &self.offer.pinned)
    }

    pub fn pinned(&self, role: PinnedRole) -> PinnedOutputInfo {
        PinnedOutputInfo::new(pinned_output(&self.offer.pinned, role))
    }
}

/// The pinned output of a role.
pub(crate) fn pinned_output(pinned: &OfferPinned, role: PinnedRole) -> &PinnedOutput {
    match role {
        PinnedRole::PendingCollateral => &pinned.pending_collateral,
        PinnedRole::ActiveCollateral => &pinned.active_collateral,
        PinnedRole::Principal => &pinned.principal,
        PinnedRole::Repayment => &pinned.repayment,
    }
}

/// The script-independent arguments of the offer's contract, each the hex to hand to
/// `SimplicityTypedValue.fromU256Hex`.
#[wasm_bindgen]
pub struct ContractArguments {
    borrower_nft_asset_id: String,
    lender_nft_asset_id: String,
    pending_collateral_commitment: String,
    active_collateral_commitment: String,
    principal_commitment: String,
    repayment_commitment: String,
    loan_expiration_time: u32,
}

impl ContractArguments {
    pub(crate) fn new(terms: &OfferTerms, pinned: &OfferPinned) -> Self {
        Self {
            borrower_nft_asset_id: encode_hex(&terms.borrower_nft.into_inner().0),
            lender_nft_asset_id: encode_hex(&terms.lender_nft.into_inner().0),
            pending_collateral_commitment: encode_hex(&pinned.pending_collateral.commitment_hash()),
            active_collateral_commitment: encode_hex(&pinned.active_collateral.commitment_hash()),
            principal_commitment: encode_hex(&pinned.principal.commitment_hash()),
            repayment_commitment: encode_hex(&pinned.repayment.commitment_hash()),
            loan_expiration_time: terms.loan_expiration_time,
        }
    }
}

#[wasm_bindgen]
impl ContractArguments {
    #[wasm_bindgen(getter, js_name = borrowerNftAssetId)]
    pub fn borrower_nft_asset_id(&self) -> String {
        self.borrower_nft_asset_id.clone()
    }

    #[wasm_bindgen(getter, js_name = lenderNftAssetId)]
    pub fn lender_nft_asset_id(&self) -> String {
        self.lender_nft_asset_id.clone()
    }

    #[wasm_bindgen(getter, js_name = pendingCollateralCommitment)]
    pub fn pending_collateral_commitment(&self) -> String {
        self.pending_collateral_commitment.clone()
    }

    #[wasm_bindgen(getter, js_name = activeCollateralCommitment)]
    pub fn active_collateral_commitment(&self) -> String {
        self.active_collateral_commitment.clone()
    }

    #[wasm_bindgen(getter, js_name = principalCommitment)]
    pub fn principal_commitment(&self) -> String {
        self.principal_commitment.clone()
    }

    #[wasm_bindgen(getter, js_name = repaymentCommitment)]
    pub fn repayment_commitment(&self) -> String {
        self.repayment_commitment.clone()
    }

    #[wasm_bindgen(getter, js_name = loanExpirationTime)]
    pub fn loan_expiration_time(&self) -> u32 {
        self.loan_expiration_time
    }
}

/// A pinned output: its asset, amount, blinding factors and commitments.
#[wasm_bindgen]
pub struct PinnedOutputInfo {
    asset: String,
    amount: u64,
    asset_blinder: String,
    value_blinder: String,
    asset_commitment: confidential::Asset,
    value_commitment: confidential::Value,
}

impl PinnedOutputInfo {
    pub(crate) fn new(output: &PinnedOutput) -> Self {
        Self {
            asset: output.asset_id.to_string(),
            amount: output.amount,
            asset_blinder: output.asset_blinding_factor.to_string(),
            value_blinder: output.value_blinding_factor.to_string(),
            asset_commitment: output.asset_commitment(),
            value_commitment: output.value_commitment(),
        }
    }
}

#[wasm_bindgen]
impl PinnedOutputInfo {
    #[wasm_bindgen(getter)]
    pub fn asset(&self) -> String {
        self.asset.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn amount(&self) -> u64 {
        self.amount
    }

    #[wasm_bindgen(getter, js_name = assetBlinder)]
    pub fn asset_blinder(&self) -> String {
        self.asset_blinder.clone()
    }

    #[wasm_bindgen(getter, js_name = valueBlinder)]
    pub fn value_blinder(&self) -> String {
        self.value_blinder.clone()
    }

    /// The consensus-encoded `confidential::Asset`, hex.
    #[wasm_bindgen(getter, js_name = assetCommitment)]
    pub fn asset_commitment(&self) -> String {
        elements::encode::serialize(&self.asset_commitment).to_hex()
    }

    /// The consensus-encoded `confidential::Value`, hex.
    #[wasm_bindgen(getter, js_name = valueCommitment)]
    pub fn value_commitment(&self) -> String {
        elements::encode::serialize(&self.value_commitment).to_hex()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::scan::view_tag_matches;
    use lending_contracts::programs::private_lending::verify_offer_as_lender;
    use private_lending_core::find_offer;
    use simplex::provider::SimplicityNetwork;

    pub(crate) fn fixture() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../web/scripts/fixtures/private-lending-parity.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    pub(crate) fn key_of(fixture: &serde_json::Value, field: &str) -> LendingKey {
        LendingKey::from_master_blinding_key(fixture[field].as_str().unwrap()).unwrap()
    }

    pub(crate) fn creation_hex(fixture: &serde_json::Value) -> String {
        fixture["creation_tx"].as_str().unwrap().to_string()
    }

    pub(crate) fn tx_of(hex: &str) -> Transaction {
        parse_tx(hex).unwrap()
    }

    fn arguments(offer: &OpenedOffer) -> Vec<String> {
        let a = offer.contract_arguments();
        vec![
            a.borrower_nft_asset_id(),
            a.lender_nft_asset_id(),
            a.pending_collateral_commitment(),
            a.active_collateral_commitment(),
            a.principal_commitment(),
            a.repayment_commitment(),
            a.loan_expiration_time().to_string(),
        ]
    }

    #[test]
    fn lender_and_borrower_open_the_fixture_offer() {
        let fixture = fixture();
        let hex = creation_hex(&fixture);
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let borrower = key_of(&fixture, "borrower_master_blinding_key");

        let as_lender = open_creation_as_lender_hex(&lender, &hex).unwrap();
        let as_borrower = open_creation_as_borrower_hex(&borrower, &hex).unwrap();

        assert_eq!(arguments(&as_lender), arguments(&as_borrower));
        assert_eq!(as_lender.lender_public_key(), lender.x_only_public_key());
        assert_eq!(
            as_borrower.borrower_public_key(),
            borrower.x_only_public_key()
        );
        assert!(as_lender.repayment_amount() >= as_lender.principal_amount());
        // input 0 of the fixture's creation transaction, as "<txid>:<vout>"
        assert_eq!(
            as_lender.first_input(),
            "e9c3ff06972d7e7ef13b315c654bc5b6a199babf498f25dbf934ead44bc88b51:0"
        );
    }

    #[test]
    fn contract_arguments_match_the_contract() {
        let fixture = fixture();
        let hex = creation_hex(&fixture);
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let offer = open_creation_as_lender_hex(&lender, &hex).unwrap();

        let (_, parameters) = verify_offer_as_lender(
            lender.inner(),
            &tx_of(&hex),
            SimplicityNetwork::LiquidTestnet,
        )
        .unwrap();
        let expected = parameters.build_arguments();
        let got = offer.contract_arguments();

        assert_eq!(
            got.borrower_nft_asset_id(),
            encode_hex(&expected.borrower_nft_asset_id)
        );
        assert_eq!(
            got.lender_nft_asset_id(),
            encode_hex(&expected.lender_nft_asset_id)
        );
        assert_eq!(
            got.pending_collateral_commitment(),
            encode_hex(&expected.pending_collateral_commitment)
        );
        assert_eq!(
            got.active_collateral_commitment(),
            encode_hex(&expected.active_collateral_commitment)
        );
        assert_eq!(
            got.principal_commitment(),
            encode_hex(&expected.principal_commitment)
        );
        assert_eq!(
            got.repayment_commitment(),
            encode_hex(&expected.repayment_commitment)
        );
        assert_eq!(got.loan_expiration_time(), expected.loan_expiration_time);
    }

    #[test]
    fn pinned_outputs_match_the_creation_transaction() {
        let fixture = fixture();
        let hex = creation_hex(&fixture);
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let offer = open_creation_as_lender_hex(&lender, &hex).unwrap();
        let tx = tx_of(&hex);

        let pending = offer.pinned(PinnedRole::PendingCollateral);
        assert_eq!(
            pending.asset_commitment(),
            elements::encode::serialize(&tx.output[3].asset).to_hex()
        );
        assert_eq!(
            pending.value_commitment(),
            elements::encode::serialize(&tx.output[3].value).to_hex()
        );
        assert_eq!(pending.asset(), offer.collateral_asset());
        assert_eq!(pending.amount(), offer.collateral_amount());

        let repayment = offer.pinned(PinnedRole::Repayment);
        assert_eq!(repayment.asset(), offer.principal_asset());
        assert_eq!(repayment.amount(), offer.repayment_amount());
        assert_eq!(
            offer.pinned(PinnedRole::Principal).amount(),
            offer.principal_amount()
        );
    }

    #[test]
    fn view_tag_collision_is_not_addressed_to_the_key() {
        let fixture = fixture();
        let hex = creation_hex(&fixture);
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let tx = tx_of(&hex);
        let found = find_offer(&tx, crate::program_id()).unwrap();
        let nonce = encode_hex(&found.offer.nonce.commitment().unwrap().serialize());

        // about one key in 256 shares the view tag, so search master blinding keys from a u16
        // counter: 65536 candidates always contain one
        let colliding = (0..=u16::MAX)
            .map(|i| {
                let mut mbk = [0; 32];
                mbk[..2].copy_from_slice(&i.to_be_bytes());
                LendingKey::from_master_blinding_key(&encode_hex(&mbk)).unwrap()
            })
            .find(|key| {
                key.x_only_public_key() != lender.x_only_public_key()
                    && view_tag_matches(key, &nonce, found.marker.view_tag).unwrap()
            })
            .expect("a colliding key among 65536 candidates");

        let error = open_creation_as_lender_hex(&colliding, &hex).err().unwrap();
        assert!(error.starts_with("rewind-failed:"), "{error}");
    }

    #[test]
    fn pending_collateral_blinding_is_bad_input() {
        let fixture = fixture();
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let offer = open_creation_as_lender_hex(&lender, &creation_hex(&fixture)).unwrap();
        let error = offer
            .pinned_blinding(PinnedRole::PendingCollateral, 0)
            .err()
            .unwrap();
        assert!(error.starts_with("bad-input:"), "{error}");
        assert!(offer.pinned_blinding(PinnedRole::Principal, 0).is_ok());
    }

    #[test]
    fn lifted_keys_match_the_core() {
        let fixture = fixture();
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let borrower = key_of(&fixture, "borrower_master_blinding_key");
        for key in [&lender, &borrower] {
            let x_only = key.x_only_public_key();
            let expected = private_lending_core::lift_lending_key(&key.inner().x_only_public_key());
            assert_eq!(
                crate::keys::lift_lending_key(&x_only).unwrap(),
                encode_hex(&expected.serialize())
            );
        }
        assert!(crate::keys::lift_lending_key("+a").is_err());
    }

    #[test]
    fn the_creation_output_decodes_with_the_lenders_blinding_key() {
        let fixture = fixture();
        let hex = creation_hex(&fixture);
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let borrower = key_of(&fixture, "borrower_master_blinding_key");

        let as_lender = open_creation_as_lender_hex(&lender, &hex).unwrap();
        let as_borrower = open_creation_as_borrower_hex(&borrower, &hex).unwrap();

        let lender_key = crate::keys::lift_lending_key(&lender.x_only_public_key()).unwrap();
        let borrower_key = crate::keys::lift_lending_key(&borrower.x_only_public_key()).unwrap();
        assert_eq!(as_lender.lender_blinding_key(), lender_key);
        assert_eq!(as_borrower.lender_blinding_key(), lender_key);
        assert_eq!(as_lender.borrower_blinding_key(), borrower_key);
        assert_eq!(as_borrower.borrower_blinding_key(), borrower_key);
    }

    #[test]
    fn stranger_cannot_open_as_borrower() {
        let fixture = fixture();
        let hex = creation_hex(&fixture);
        let stranger = LendingKey::from_master_blinding_key(&encode_hex(&[9; 32])).unwrap();
        let error = open_creation_as_borrower_hex(&stranger, &hex)
            .err()
            .unwrap();
        assert!(error.starts_with("not-mine:"), "{error}");
    }

    #[test]
    fn malformed_transaction_hex_is_bad_input() {
        let fixture = fixture();
        let hex = creation_hex(&fixture);
        let lender = key_of(&fixture, "lender_master_blinding_key");
        for bad in ["zz", &hex[..hex.len() / 2]] {
            let error = open_creation_as_lender_hex(&lender, bad).err().unwrap();
            assert!(error.starts_with("bad-input:"), "{error}");
        }
    }
}
