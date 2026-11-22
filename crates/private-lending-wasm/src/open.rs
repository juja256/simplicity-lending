//! Opening offers from their creation transactions, the contract's arguments and bounds, and the
//! private messages of their loans.

use std::cell::OnceCell;
use std::rc::Rc;

use elements::encode::deserialize;
use elements::hex::ToHex;
use elements::secp256k1_zkp::{PublicKey, XOnlyPublicKey};
use elements::{OutPoint, Transaction, TxOut, Txid, confidential};
use private_lending_core::{
    BlinderTree, CARRY_SUPPLY, CreationError, MAX_SIGNED_MESSAGE_BYTES, Message, MessageError,
    MessagePhase as CoreMessagePhase, OfferPinned, OfferSecrets, OfferTerms,
    OpenedOffer as CoreOpenedOffer, PinnedOutput, PinnedRole as CorePinnedRole,
    SignedMessage as CoreSignedMessage, asset_point, check_bounds, expiry_hash, fs_iv,
    lift_lending_key, open_creation_as_borrower, open_creation_as_lender, rewind, value_point,
};
use wasm_bindgen::prelude::*;

use crate::error::{bad_input, creation_error, decode_hex, encode_hex, out_of_bounds};
use crate::keys::LendingKey;
use crate::scan::parse;

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

/// The step of a loan whose output carries a signed message: the lender's acceptance (on the
/// principal), the borrower's installment (on the installment output) or the borrower's full
/// repayment (on the repayment output).
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessagePhase {
    Acceptance,
    Installment,
    FullRepayment,
}

/// A message signed by its sender's lending key for one phase of one offer, which the output of
/// that phase carries: see `OpenedOffer.pinnedBlinding`, `LoanState.planInstallment` and
/// `LoanState.repaymentBlinding`, which consume the handle, as `blindPset` consumes its
/// arguments.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct SignedMessage(CoreSignedMessage);

/// The extra data of the output that carries `message`, empty for none: `bad-input`, naming
/// `what`, the phase, unless `sender` signed it for `phase` of the offer `offer_id`.
pub(crate) fn carried_message(
    message: Option<SignedMessage>,
    sender: &XOnlyPublicKey,
    phase: CoreMessagePhase,
    offer_id: &Txid,
    what: &str,
) -> Result<Vec<u8>, String> {
    let Some(SignedMessage(message)) = message else {
        return Ok(Vec::new());
    };
    message.verify(sender, phase, offer_id).map_err(|_| {
        bad_input(format!(
            "the message is not signed for {what} of this offer by its sender"
        ))
    })?;

    Ok(message.encode())
}

/// Signs `text` with the sender's lending key for `phase` of the offer whose creation transaction
/// is `creation_txid` (display hex): for its `installment`-th installment, from 1, when `phase` is
/// `Installment`, the index being ignored for the other phases.
///
/// `bad-input` for an empty text, a text longer than 3068 bytes (UTF-8), naming its length and
/// the limit, and an installment 0.
#[wasm_bindgen(js_name = signMessage)]
pub fn sign_message(
    sender: &LendingKey,
    creation_txid: &str,
    phase: MessagePhase,
    installment: u32,
    text: &str,
) -> Result<SignedMessage, String> {
    let offer_id: Txid = parse("creation txid", creation_txid)?;
    let phase = match phase {
        MessagePhase::Acceptance => CoreMessagePhase::Acceptance,
        MessagePhase::Installment if installment == 0 => {
            return Err(bad_input("installments count from 1"));
        }
        MessagePhase::Installment => CoreMessagePhase::Installment(installment),
        MessagePhase::FullRepayment => CoreMessagePhase::FullRepayment,
    };
    let message = message_text(text, MAX_SIGNED_MESSAGE_BYTES)?;

    CoreSignedMessage::sign(message, sender.inner(), phase, &offer_id)
        .map(SignedMessage)
        .map_err(bad_input)
}

/// The message of `text`, at most `max` bytes in UTF-8: `bad-input` for an empty text, and for a
/// longer one with its length and the limit.
pub(crate) fn message_text(text: &str, max: usize) -> Result<Message, String> {
    if text.len() > max {
        return Err(bad_input(format!(
            "the message is {} bytes; at most {max} fit",
            text.len()
        )));
    }

    Message::text(text).map_err(bad_input)
}

/// A message read from a loan's output: its text, and whether its sender signed it for the phase
/// and the offer it was read for. An unverified message may have been moved there by the other
/// party, who knows the output's blinders.
#[wasm_bindgen]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadMessage {
    text: String,
    verified: bool,
}

impl ReadMessage {
    /// The signed message at the start of `extra_data`, a rewound range proof's, checked against
    /// `sender`, `phase` and `offer_id`: `None` when the output carries none, an error when its
    /// field does not decode.
    pub(crate) fn read(
        extra_data: &[u8],
        sender: &XOnlyPublicKey,
        phase: CoreMessagePhase,
        offer_id: &Txid,
    ) -> Result<Option<ReadMessage>, MessageError> {
        Ok(
            CoreSignedMessage::decode(extra_data)?.map(|signed| ReadMessage {
                verified: signed.verify(sender, phase, offer_id).is_ok(),
                text: signed.message.as_text().to_owned(),
            }),
        )
    }
}

#[wasm_bindgen]
impl ReadMessage {
    /// The text as it was sent: the caller removes the control characters before showing it.
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.text.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn verified(&self) -> bool {
        self.verified
    }
}

/// The error string of a message field that does not decode.
pub(crate) fn unreadable(error: MessageError) -> String {
    bad_input(format!("unreadable message: {error}"))
}

/// The creation's output that holds the carry supply, `S = 2^50` units of the loan's carry token.
const CREATION_CARRY_OUTPUT: u32 = 4;

/// An offer's tree of blinder commitments, built at most once and shared by the offer, its
/// contract's arguments, its loan states and their plans: building it takes 2,048 scalar
/// multiplications.
pub(crate) type SharedTree = Rc<OnceCell<BlinderTree>>;

/// The tree of `shared`, built from `secrets` on first use.
pub(crate) fn tree_of<'a>(shared: &'a SharedTree, secrets: &OfferSecrets) -> &'a BlinderTree {
    shared.get_or_init(|| BlinderTree::new(secrets))
}

/// Whether an offer of `collateral` and full repayment `repayment` (base units) is within the
/// bounds of proportional release, `1 ≤ C ≤ 2^44` and `1 ≤ R ≤ 2^50 − 2`: `out-of-bounds`
/// otherwise. The lender checks them before accepting (`OpenedOffer.checkOfferBounds`), and the
/// borrower's form before building an offer (`NewOffer.build` refuses one outside them too).
#[wasm_bindgen(js_name = checkOfferBounds)]
pub fn check_offer_bounds(collateral: u64, repayment: u64) -> Result<(), String> {
    check_bounds(collateral, repayment).map_err(out_of_bounds)
}

/// The carry token's supply, `S = 2^50` units, which the creation transaction issues at input 2
/// and holds, explicit, at output 4.
#[wasm_bindgen(js_name = carrySupply)]
pub fn carry_supply() -> u64 {
    CARRY_SUPPLY
}

/// The party of an offer: its borrower or its lender.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Party {
    Borrower,
    Lender,
}

/// An offer opened from its creation transaction by one of its parties, which it remembers: a
/// loan's state reads the installments for that party.
#[wasm_bindgen]
pub struct OpenedOffer {
    offer: CoreOpenedOffer,
    /// The creation transaction's txid: its output 3 is the pending offer, which the acceptance
    /// spends at input 0.
    creation_txid: Txid,
    first_input: String,
    party: Party,
    /// The creation's output 4, the carry supply, when it has one: the loan's carry before its
    /// first installment.
    carry_supply: Option<(OutPoint, TxOut)>,
    tree: SharedTree,
}

impl OpenedOffer {
    pub(crate) fn inner(&self) -> &CoreOpenedOffer {
        &self.offer
    }

    /// The party that opened the offer.
    pub(crate) fn party(&self) -> Party {
        self.party
    }

    /// The creation transaction's txid.
    pub(crate) fn creation_txid(&self) -> Txid {
        self.creation_txid
    }

    /// The creation's output 4 and its outpoint, when it has one.
    pub(crate) fn carry_supply_output(&self) -> Option<(OutPoint, TxOut)> {
        self.carry_supply.clone()
    }

    /// The offer's tree, shared.
    pub(crate) fn shared_tree(&self) -> SharedTree {
        Rc::clone(&self.tree)
    }

    fn new(offer: CoreOpenedOffer, tx: &Transaction, party: Party) -> Result<Self, String> {
        let outpoint = tx
            .input
            .first()
            .ok_or_else(|| bad_input("the transaction has no inputs"))?
            .previous_output;
        let carry_supply = tx.output.get(CREATION_CARRY_OUTPUT as usize).map(|output| {
            (
                OutPoint::new(tx.txid(), CREATION_CARRY_OUTPUT),
                output.clone(),
            )
        });
        Ok(Self {
            offer,
            creation_txid: tx.txid(),
            first_input: outpoint_string(&outpoint),
            party,
            carry_supply,
            tree: SharedTree::default(),
        })
    }
}

/// An outpoint as `"<txid>:<vout>"`, not `OutPoint`'s `Display`, which prefixes "[elements]".
pub(crate) fn outpoint_string(outpoint: &OutPoint) -> String {
    format!("{}:{}", outpoint.txid, outpoint.vout)
}

/// The lifted lending key, hex of the 33-byte compressed public key.
pub(crate) fn lifted(key: &elements::secp256k1_zkp::XOnlyPublicKey) -> String {
    encode_hex(&lift_lending_key(key).serialize())
}

pub(crate) fn parse_tx(hex: &str) -> Result<Transaction, String> {
    deserialize(&decode_hex(hex)?).map_err(|e| bad_input(format!("not a transaction: {e}")))
}

fn open(
    creation_tx_hex: &str,
    party: Party,
    open: impl FnOnce(&Transaction) -> Result<CoreOpenedOffer, CreationError>,
) -> Result<OpenedOffer, String> {
    let tx = parse_tx(creation_tx_hex)?;
    let offer = open(&tx).map_err(creation_error)?;
    OpenedOffer::new(offer, &tx, party)
}

/// Opens the offer of a creation transaction as the lender it is addressed to: `out-of-bounds`
/// for an offer outside the bounds of release (`checkOfferBounds`), which the lender never
/// accepts (proofs, O9).
#[wasm_bindgen(js_name = openCreationAsLender)]
pub fn open_creation_as_lender_hex(
    lender: &LendingKey,
    creation_tx_hex: &str,
) -> Result<OpenedOffer, String> {
    let offer = open(creation_tx_hex, Party::Lender, |tx| {
        open_creation_as_lender(lender.inner(), tx, crate::program_id())
    })?;
    offer.check_offer_bounds()?;

    Ok(offer)
}

/// Opens the offer of a creation transaction as the borrower who created it, even outside the
/// bounds of release, so that the borrower can cancel it.
#[wasm_bindgen(js_name = openCreationAsBorrower)]
pub fn open_creation_as_borrower_hex(
    borrower: &LendingKey,
    creation_tx_hex: &str,
) -> Result<OpenedOffer, String> {
    open(creation_tx_hex, Party::Borrower, |tx| {
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

    /// The salt of the contract's expiry hash, hex: the liquidation's witness carries it with the
    /// expiration.
    #[wasm_bindgen(js_name = expirySalt)]
    pub fn expiry_salt(&self) -> String {
        encode_hex(&self.offer.secrets.expiry_salt())
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

    /// The arguments of the offer's contract, all recomputed from the shared secret and the
    /// terms: with them the address check (`verifyOfferAddresses`) covers the release proof's
    /// points, `FS_IV` and `BLINDER_ROOT` too. The first call builds the offer's tree of blinder
    /// commitments, which the offer keeps.
    #[wasm_bindgen(js_name = contractArguments)]
    pub fn contract_arguments(&self) -> Result<ContractArguments, String> {
        ContractArguments::new(
            &self.offer.signed_terms.terms,
            &self.offer.pinned,
            &self.offer.secrets,
            tree_of(&self.tree, &self.offer.secrets),
        )
    }

    /// Whether the offer is within the bounds of proportional release, `1 ≤ C ≤ 2^44` and
    /// `1 ≤ R ≤ 2^50 − 2` (`out-of-bounds` otherwise): the lender's check before accepting, with
    /// the address check. The release proof is sound only within them, and nothing on chain
    /// bounds `R`.
    #[wasm_bindgen(js_name = checkOfferBounds)]
    pub fn check_offer_bounds(&self) -> Result<(), String> {
        check_offer_bounds(
            self.offer.pinned.active_collateral.amount,
            self.offer.pinned.repayment.amount,
        )
    }

    pub fn pinned(&self, role: PinnedRole) -> PinnedOutputInfo {
        PinnedOutputInfo::new(pinned_output(&self.offer.pinned, role))
    }

    /// The borrower's message to the lender at creation, `undefined` for none. It is part of the
    /// terms, whose signature opening the offer checked; terms whose message does not decode do
    /// not open (`terms-invalid`).
    pub fn message(&self) -> Option<String> {
        self.offer
            .signed_terms
            .message
            .as_ref()
            .map(|message| message.as_text().to_owned())
    }

    /// The message that output `output_index` of the transaction `tx_hex` carries for `phase`,
    /// rewound with `key` and the output's nonce, and checked against the lender's key for
    /// `Acceptance`, the borrower's for `FullRepayment`. `creation_txid` (display hex) must be
    /// this offer's.
    ///
    /// `undefined` when the output does not rewind with `key` or carries no message. `bad-input`
    /// when its message field does not decode, and for `Installment`: the loan's state reads each
    /// installment's message (`LoanState.installment(j).message`), knowing its index.
    #[wasm_bindgen(js_name = readMessage)]
    pub fn read_message(
        &self,
        key: &LendingKey,
        creation_txid: &str,
        tx_hex: &str,
        output_index: u32,
        phase: MessagePhase,
    ) -> Result<Option<ReadMessage>, String> {
        let offer_id: Txid = parse("creation txid", creation_txid)?;
        if offer_id != self.creation_txid {
            return Err(bad_input("the creation txid is not this offer's"));
        }
        let (sender, phase) = match phase {
            MessagePhase::Acceptance => (self.offer.lender, CoreMessagePhase::Acceptance),
            MessagePhase::FullRepayment => (
                self.offer.signed_terms.borrower,
                CoreMessagePhase::FullRepayment,
            ),
            MessagePhase::Installment => {
                return Err(bad_input(
                    "an installment's message is read from the loan state, which knows its index",
                ));
            }
        };
        let tx = parse_tx(tx_hex)?;
        let output = tx
            .output
            .get(output_index as usize)
            .ok_or_else(|| bad_input(format!("the transaction has no output {output_index}")))?;

        let Some(nonce) = output.nonce.commitment() else {
            return Ok(None);
        };
        // the shared secret of a key and a nonce, which the lender's opening of an offer uses too
        let shared_secret = OfferSecrets::for_lender(key.inner(), &nonce).shared_secret();
        let Ok((_, extra_data)) = rewind(output, shared_secret) else {
            return Ok(None);
        };

        ReadMessage::read(&extra_data, &sender, phase, &offer_id).map_err(unreadable)
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

/// The release proof's points that are fixed for a loan, read from the pinned outputs'
/// commitments as the program reads them, as the contracts' `PrivateLendingParameters` reads them.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LoanPoints {
    /// `A`, of the repayment's asset commitment.
    pub(crate) repayment_asset: PublicKey,
    /// `A_c`, of the active collateral's asset commitment.
    pub(crate) collateral_asset: PublicKey,
    /// `V_c0`, of the active collateral's value commitment.
    pub(crate) collateral_value: PublicKey,
    /// `D₀`, of the repayment's value commitment.
    pub(crate) starting_debt: PublicKey,
}

impl LoanPoints {
    /// The points of the offer whose outputs `pinned` pins. A pinned output is always
    /// confidential, so the error is a bug's, not the caller's.
    pub(crate) fn of(pinned: &OfferPinned) -> Result<LoanPoints, String> {
        let (repayment, active) = (pinned.repayment, pinned.active_collateral);
        let point = |point: Result<PublicKey, _>| {
            point.map_err(|e| bad_input(format!("a pinned output is not a commitment: {e}")))
        };

        Ok(LoanPoints {
            repayment_asset: point(asset_point(&repayment.asset_commitment()))?,
            collateral_asset: point(asset_point(&active.asset_commitment()))?,
            collateral_value: point(value_point(&active.value_commitment()))?,
            starting_debt: point(value_point(&repayment.value_commitment()))?,
        })
    }

    /// `FS_IV`, the chaining value of the release proof's challenge, over the points and `J`.
    pub(crate) fn fs_iv(&self) -> [u8; 32] {
        fs_iv(
            &self.repayment_asset,
            &self.collateral_asset,
            &self.collateral_value,
            &self.starting_debt,
        )
    }
}

/// A curve point as the program takes it, a `Ge`: its affine `x ‖ y`, each 32 bytes big-endian,
/// hex.
pub(crate) fn point_hex(point: &PublicKey) -> String {
    encode_hex(&point.serialize_uncompressed()[1..])
}

/// The script-independent arguments of the offer's contract: the 32-byte values are the hex to
/// hand to `SimplicityTypedValue.fromU256Hex`, and the points (`Ge`) their `x ‖ y`.
#[wasm_bindgen]
pub struct ContractArguments {
    borrower_nft_asset_id: String,
    lender_nft_asset_id: String,
    pending_collateral_commitment: String,
    active_collateral_commitment: String,
    principal_commitment: String,
    repayment_commitment: String,
    loan_expiration_time: u32,
    expiry_hash: String,
    repayment_asset_prefix_bit: u8,
    repayment_asset_x: String,
    repayment_asset_point: String,
    collateral_asset_point: String,
    collateral_value_point: String,
    starting_debt_point: String,
    fs_iv: String,
    blinder_root: String,
}

impl ContractArguments {
    /// The arguments of the offer of `terms`, whose outputs `pinned` pins and whose secrets and
    /// tree are `secrets` and `tree`: the contracts' `PrivateLendingParameters::from_terms` and
    /// `build_arguments`, from the same functions of the core.
    pub(crate) fn new(
        terms: &OfferTerms,
        pinned: &OfferPinned,
        secrets: &OfferSecrets,
        tree: &BlinderTree,
    ) -> Result<Self, String> {
        let repayment_asset = elements::encode::serialize(&pinned.repayment.asset_commitment());
        let points = LoanPoints::of(pinned)?;
        Ok(Self {
            borrower_nft_asset_id: encode_hex(&terms.borrower_nft.into_inner().0),
            lender_nft_asset_id: encode_hex(&terms.lender_nft.into_inner().0),
            pending_collateral_commitment: encode_hex(&pinned.pending_collateral.commitment_hash()),
            active_collateral_commitment: encode_hex(&pinned.active_collateral.commitment_hash()),
            principal_commitment: encode_hex(&pinned.principal.commitment_hash()),
            repayment_commitment: encode_hex(&pinned.repayment.commitment_hash()),
            loan_expiration_time: terms.loan_expiration_time,
            expiry_hash: encode_hex(&expiry_hash(
                &secrets.expiry_salt(),
                terms.loan_expiration_time,
            )),
            repayment_asset_prefix_bit: repayment_asset[0] & 1,
            repayment_asset_x: encode_hex(&repayment_asset[1..]),
            repayment_asset_point: point_hex(&points.repayment_asset),
            collateral_asset_point: point_hex(&points.collateral_asset),
            collateral_value_point: point_hex(&points.collateral_value),
            starting_debt_point: point_hex(&points.starting_debt),
            fs_iv: encode_hex(&points.fs_iv()),
            blinder_root: encode_hex(&tree.root()),
        })
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

    /// The expiration, which the program does not take: it is in the liquidation's witness and
    /// its lock time.
    #[wasm_bindgen(getter, js_name = loanExpirationTime)]
    pub fn loan_expiration_time(&self) -> u32 {
        self.loan_expiration_time
    }

    /// `EXPIRY_HASH`, the SHA-256 of the expiry salt and the expiration, which the program takes
    /// in place of the expiration.
    #[wasm_bindgen(getter, js_name = expiryHash)]
    pub fn expiry_hash(&self) -> String {
        self.expiry_hash.clone()
    }

    /// The low bit of the prefix of `A`, the pinned repayment's asset commitment, 0 or 1: 1
    /// exactly when its `y` is not a square. With [`Self::repayment_asset_x`] it is the
    /// program's `REPAYMENT_ASSET`, which takes the bit as a bool.
    #[wasm_bindgen(getter, js_name = repaymentAssetPrefixBit)]
    pub fn repayment_asset_prefix_bit(&self) -> u8 {
        self.repayment_asset_prefix_bit
    }

    /// The x-coordinate of `A`, the 32 bytes after the prefix of its consensus encoding, hex.
    #[wasm_bindgen(getter, js_name = repaymentAssetX)]
    pub fn repayment_asset_x(&self) -> String {
        self.repayment_asset_x.clone()
    }

    /// `REPAYMENT_ASSET_POINT`, `A` as a curve point: the point of `REPAYMENT_ASSET`.
    #[wasm_bindgen(getter, js_name = repaymentAssetPoint)]
    pub fn repayment_asset_point(&self) -> String {
        self.repayment_asset_point.clone()
    }

    /// `COLLATERAL_ASSET_POINT`, `A_c`, of the active collateral's asset commitment.
    #[wasm_bindgen(getter, js_name = collateralAssetPoint)]
    pub fn collateral_asset_point(&self) -> String {
        self.collateral_asset_point.clone()
    }

    /// `COLLATERAL_VALUE_POINT`, `V_c0 = C·A_c + ρ·G`, of the active collateral's value
    /// commitment.
    #[wasm_bindgen(getter, js_name = collateralValuePoint)]
    pub fn collateral_value_point(&self) -> String {
        self.collateral_value_point.clone()
    }

    /// `STARTING_DEBT_POINT`, `D₀ = R·A + r₀·G`, of the repayment's value commitment.
    #[wasm_bindgen(getter, js_name = startingDebtPoint)]
    pub fn starting_debt_point(&self) -> String {
        self.starting_debt_point.clone()
    }

    /// `FS_IV`, the chaining value of the release proof's challenge, over `A`, `A_c`, `V_c0`,
    /// `D₀` and `J`.
    #[wasm_bindgen(getter, js_name = fsIv)]
    pub fn fs_iv(&self) -> String {
        self.fs_iv.clone()
    }

    /// `BLINDER_ROOT`, the root of the tree of the blinder commitments `Y_1 … Y_1024`.
    #[wasm_bindgen(getter, js_name = blinderRoot)]
    pub fn blinder_root(&self) -> String {
        self.blinder_root.clone()
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
        let a = offer.contract_arguments().unwrap();
        vec![
            a.borrower_nft_asset_id(),
            a.lender_nft_asset_id(),
            a.pending_collateral_commitment(),
            a.active_collateral_commitment(),
            a.principal_commitment(),
            a.repayment_commitment(),
            a.loan_expiration_time().to_string(),
            a.expiry_hash(),
            a.repayment_asset_prefix_bit().to_string(),
            a.repayment_asset_x(),
            a.repayment_asset_point(),
            a.collateral_asset_point(),
            a.collateral_value_point(),
            a.starting_debt_point(),
            a.fs_iv(),
            a.blinder_root(),
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
        let first = tx_of(&hex).input[0].previous_output;
        assert_eq!(
            as_lender.first_input(),
            format!("{}:{}", first.txid, first.vout)
        );
        assert!(!as_lender.first_input().starts_with('['));
    }

    /// The `x ‖ y` hex of a point argument.
    fn point_words((x, y): ([u8; 32], [u8; 32])) -> String {
        encode_hex(&[x, y].concat())
    }

    #[test]
    fn contract_arguments_match_the_contract() {
        let fixture = fixture();
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let borrower = key_of(&fixture, "borrower_master_blinding_key");
        // both offers, whose `A` has either prefix bit, as both parties open them
        for hex in [
            creation_hex(&fixture),
            fixture["other_offer"]["creation_tx"]
                .as_str()
                .unwrap()
                .to_string(),
        ] {
            let as_lender = open_creation_as_lender_hex(&lender, &hex).unwrap();
            let as_borrower = open_creation_as_borrower_hex(&borrower, &hex).unwrap();
            assert_eq!(arguments(&as_lender), arguments(&as_borrower));
            assert_matches_the_contract(&as_lender, &lender, &hex);
        }
    }

    /// Every argument of `offer` is the contract's, which `from_terms` rebuilds from the terms and
    /// the shared secret.
    fn assert_matches_the_contract(offer: &OpenedOffer, lender: &LendingKey, hex: &str) {
        let (_, parameters) = verify_offer_as_lender(
            lender.inner(),
            &tx_of(hex),
            SimplicityNetwork::LiquidTestnet,
        )
        .unwrap();
        let expected = parameters.build_arguments();
        let got = offer.contract_arguments().unwrap();

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
        assert_eq!(got.loan_expiration_time(), parameters.loan_expiration_time);
        assert_eq!(got.expiry_hash(), encode_hex(&expected.expiry_hash));
        let (prefix_bit, x) = expected.repayment_asset;
        assert_eq!(got.repayment_asset_prefix_bit(), u8::from(prefix_bit));
        assert_eq!(got.repayment_asset_x(), encode_hex(&x));
        assert_eq!(offer.expiry_salt(), encode_hex(&parameters.expiry_salt));
        // the release proof's points, `FS_IV` and `BLINDER_ROOT`
        assert_eq!(
            got.repayment_asset_point(),
            point_words(expected.repayment_asset_point)
        );
        assert_eq!(
            got.collateral_asset_point(),
            point_words(expected.collateral_asset_point)
        );
        assert_eq!(
            got.collateral_value_point(),
            point_words(expected.collateral_value_point)
        );
        assert_eq!(
            got.starting_debt_point(),
            point_words(expected.starting_debt_point)
        );
        assert_eq!(got.fs_iv(), encode_hex(&expected.fs_iv));
        assert_eq!(got.blinder_root(), encode_hex(&expected.blinder_root));
        // the offer is within the bounds that `verify_offer_as_lender` checked
        assert!(offer.check_offer_bounds().is_ok());
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
            .pinned_blinding(PinnedRole::PendingCollateral, 0, None)
            .err()
            .unwrap();
        assert!(error.starts_with("bad-input:"), "{error}");
        assert!(
            offer
                .pinned_blinding(PinnedRole::Principal, 0, None)
                .is_ok()
        );
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
    fn the_fixture_messages_read_verified() {
        let fixture = fixture();
        let hex = creation_hex(&fixture);
        let id = tx_of(&hex).txid().to_string();
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let borrower = key_of(&fixture, "borrower_master_blinding_key");
        let messages = &fixture["messages"];
        let as_lender = open_creation_as_lender_hex(&lender, &hex).unwrap();
        let as_borrower = open_creation_as_borrower_hex(&borrower, &hex).unwrap();

        // the creation's message, in the terms both parties opened
        for offer in [&as_lender, &as_borrower] {
            assert_eq!(offer.message().unwrap(), messages["creation"]);
        }
        // the lender's acceptance message, on the principal, which only the borrower rewinds
        let acceptance = fixture["loan"]["acceptance_tx"].as_str().unwrap();
        let read = as_borrower
            .read_message(&borrower, &id, acceptance, 1, MessagePhase::Acceptance)
            .unwrap()
            .unwrap();
        assert_eq!(read.text(), messages["acceptance"]);
        assert!(read.verified());
        assert!(
            as_lender
                .read_message(&lender, &id, acceptance, 1, MessagePhase::Acceptance)
                .unwrap()
                .is_none()
        );
        // the other offer was created without one
        let other = fixture["other_offer"]["creation_tx"].as_str().unwrap();
        assert_eq!(
            open_creation_as_lender_hex(&lender, other)
                .unwrap()
                .message(),
            None
        );
    }

    #[test]
    fn sign_message_refuses_empty_long_and_zeroth_installment_texts() {
        let fixture = fixture();
        let lender = key_of(&fixture, "lender_master_blinding_key");
        let id = tx_of(&creation_hex(&fixture)).txid().to_string();
        let sign =
            |phase, installment, text: &str| sign_message(&lender, &id, phase, installment, text);

        let error = sign(MessagePhase::Acceptance, 0, "").err().unwrap();
        assert!(error.starts_with("bad-input:"), "{error}");
        // counted in UTF-8 bytes: 767 emojis are the 3068 bytes that fit, and one byte more does
        // not
        let longest = "🙂".repeat(767);
        assert!(sign(MessagePhase::FullRepayment, 0, &longest).is_ok());
        let error = sign(MessagePhase::FullRepayment, 0, &format!("{longest}a"))
            .err()
            .unwrap();
        assert!(error.starts_with("bad-input:"), "{error}");
        assert!(error.contains("3069") && error.contains("3068"), "{error}");
        // installments count from 1; the index of another phase is ignored
        let error = sign(MessagePhase::Installment, 0, "hi").err().unwrap();
        assert!(error.starts_with("bad-input:"), "{error}");
        assert!(sign(MessagePhase::Installment, 1, "hi").is_ok());
        assert!(sign(MessagePhase::Acceptance, 7, "hi").is_ok());
        let error = sign_message(&lender, "zz", MessagePhase::Acceptance, 0, "hi")
            .err()
            .unwrap();
        assert!(error.starts_with("bad-input:"), "{error}");
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
