//! A loan's state, read from its acceptance and its installments on chain, and what each party
//! builds from it: the borrower's installments, full repayment and zero-debt close, and the
//! lender's sweep of the installments.
//!
//! Both parties read the same transactions. The debt follows as a point, `D₀` less each
//! installment's value commitment ([`debt_after`]), so the storage of every loan output is known
//! to both whatever opens. Each installment is also opened for the party: the borrower rebuilds
//! the installment's derived key from its lending key and the transaction, and the lender uses
//! the installment's nonce. The debt's opening, which the borrower needs to close the loan, is
//! known when every installment opened. The same rewind reads the borrower's message on the
//! installment, if any.

use std::collections::HashSet;

use elements::confidential::{self, ValueBlindingFactor};
use elements::encode::serialize;
use elements::secp256k1_zkp::{SECP256K1, SecretKey, XOnlyPublicKey};
use elements::{OutPoint, Script, Transaction, TxOut, TxOutSecrets, Txid};
use private_lending_core::{
    DebtOpening, LendingKey as CoreLendingKey, MessageError, MessagePhase as CoreMessagePhase,
    OfferPinned, OfferSecrets, OpenedOffer as CoreOpenedOffer,
    PinnedBlinding as CorePinnedBlinding, PinnedOutput, debt_after, debt_hash,
    installment_ephemeral_key, open_installment_with_extra_data, sweep_opening, zero_debt_blinder,
    zero_debt_key,
};
use rand::thread_rng;
use wasm_bindgen::prelude::*;

use crate::blind::{InputSecret, PinnedBlinding};
use crate::error::{bad_input, decode_hex, encode_hex, loan_mismatch};
use crate::keys::LendingKey;
use crate::open::{
    OpenedOffer, Party, PinnedOutputInfo, ReadMessage, SignedMessage, carried_message,
    outpoint_string, parse_tx, unreadable,
};
use crate::scan::parse;

/// The creation's output that holds the pending offer, which the acceptance spends.
const CREATION_PENDING_OFFER_OUTPUT: u32 = 3;
/// The acceptance's input that spends the pending offer.
const ACCEPTANCE_OFFER_INPUT: usize = 0;
/// The acceptance's output that holds the loan.
const ACCEPTANCE_LOAN_OUTPUT: u32 = 0;
/// The input of an installment or a close that spends the loan.
const LOAN_INPUT: usize = 1;
/// The input of an installment that the borrower's wallet pays from first.
const FIRST_WALLET_INPUT: usize = 2;
/// The output of an installment that returns the borrower NFT.
const NFT_OUTPUT: usize = 0;
/// The output of an installment that holds the successor loan.
const LOAN_OUTPUT: u32 = 1;
/// The output of an installment that pays it.
const INSTALLMENT_OUTPUT: u32 = 2;
/// The output of a close that pays the full repayment, or reveals the zero debt's key.
const CLOSE_OUTPUT: u32 = 1;

/// One installment of a loan.
struct Installment {
    /// Output 2 of the installment transaction.
    outpoint: OutPoint,
    /// What the party opened of it: `None` when it does not open for the party.
    opening: Option<DebtOpening>,
    /// The borrower's message on it, checked for this installment: `None` when it carries none
    /// or does not open, an error when its field does not decode.
    message: Result<Option<ReadMessage>, MessageError>,
}

/// A loan's state after its acceptance and its installments, read from their transactions for
/// the party that opened the offer.
#[wasm_bindgen]
pub struct LoanState {
    party: Party,
    key: CoreLendingKey,
    /// The creation's txid, which the loan's messages are signed for, and the borrower's key,
    /// which signs the installments' and the full repayment's.
    offer_id: Txid,
    borrower: XOnlyPublicKey,
    pinned: OfferPinned,
    /// The loan's outputs, the acceptance's output 0 and then output 1 of each installment, and
    /// the debt each holds: `D₀`, then the debt each installment leaves.
    loans: Vec<OutPoint>,
    debts: Vec<confidential::Value>,
    installments: Vec<Installment>,
    /// The opening of the debt the last loan output holds, when every installment opened.
    opening: Option<DebtOpening>,
}

#[wasm_bindgen]
impl OpenedOffer {
    /// The state of the loan that the acceptance starts, after the installments in their order
    /// on chain (transactions, hex), read with `key`, the lending key of the party that opened
    /// the offer (`bad-input` for another key).
    ///
    /// A transaction that is not the loan's is `loan-mismatch`, naming the acceptance or the
    /// installment (from 1): the acceptance's output 0 must be the active collateral and its input
    /// 0 must spend the creation's pending offer (output 3), and each installment must spend the
    /// previous loan output at its input 1, put the collateral after it at output 1
    /// (`collateral_after(j)` of the `j`-th installment) and pay the repayment asset `A` at output
    /// 2. These do not check the scripts: the caller requires each loan output's script to be the
    /// active offer at its debt hash (`debtHashAt`).
    #[wasm_bindgen(js_name = loanState)]
    pub fn loan_state(
        &self,
        key: &LendingKey,
        acceptance_tx_hex: &str,
        installment_tx_hexes: Vec<String>,
    ) -> Result<LoanState, String> {
        let offer = self.inner();
        let party_key = match self.party() {
            Party::Borrower => offer.signed_terms.borrower,
            Party::Lender => offer.lender,
        };
        if key.inner().x_only_public_key() != party_key {
            return Err(bad_input(
                "the key is not that of the party that opened the offer",
            ));
        }
        if u32::try_from(installment_tx_hexes.len()).is_err() {
            return Err(bad_input("too many installments"));
        }

        let acceptance = parse_tx(acceptance_tx_hex)?;
        let installments = installment_tx_hexes
            .iter()
            .map(|hex| parse_tx(hex))
            .collect::<Result<Vec<_>, _>>()?;

        LoanState::read(
            offer,
            OutPoint::new(self.creation_txid(), CREATION_PENDING_OFFER_OUTPUT),
            self.party(),
            *key.inner(),
            &acceptance,
            &installments,
        )
    }
}

impl LoanState {
    /// The loan that `acceptance` starts, which must spend `pending_offer`, and `installments`.
    fn read(
        offer: &CoreOpenedOffer,
        pending_offer: OutPoint,
        party: Party,
        key: CoreLendingKey,
        acceptance: &Transaction,
        installments: &[Transaction],
    ) -> Result<LoanState, String> {
        let pinned = offer.pinned;
        let loan = acceptance.output.get(ACCEPTANCE_LOAN_OUTPUT as usize);
        if !loan.is_some_and(|output| pinned.active_collateral.matches(output)) {
            return Err(loan_mismatch(format!(
                "output {ACCEPTANCE_LOAN_OUTPUT} of the acceptance {} is not the offer's active \
                 collateral",
                acceptance.txid()
            )));
        }
        let spent = acceptance
            .input
            .get(ACCEPTANCE_OFFER_INPUT)
            .map(|input| input.previous_output);
        if spent != Some(pending_offer) {
            return Err(loan_mismatch(format!(
                "input {ACCEPTANCE_OFFER_INPUT} of the acceptance {} does not spend the offer's \
                 pending offer {}",
                acceptance.txid(),
                outpoint_string(&pending_offer)
            )));
        }

        let mut state = LoanState {
            party,
            key,
            offer_id: pending_offer.txid,
            borrower: offer.signed_terms.borrower,
            pinned,
            loans: vec![OutPoint::new(acceptance.txid(), ACCEPTANCE_LOAN_OUTPUT)],
            debts: vec![pinned.repayment.value_commitment()],
            installments: Vec::new(),
            opening: Some(DebtOpening::of(&pinned.repayment)),
        };
        for tx in installments {
            state.add_installment(&offer.lender, tx)?;
        }

        Ok(state)
    }

    /// Reads the next installment, `tx`: it must spend the loan, move the collateral by one step
    /// and pay `A`. The debt it leaves follows from its value commitment, and the opening of the
    /// debt from what the party opens of it.
    fn add_installment(&mut self, lender: &XOnlyPublicKey, tx: &Transaction) -> Result<(), String> {
        let j = self.installment_count() + 1;
        let loan = self.loan();
        let mismatch =
            |what: String| loan_mismatch(format!("installment {j} ({}) {what}", tx.txid()));

        let spent = tx.input.get(LOAN_INPUT).map(|input| input.previous_output);
        if spent != Some(loan) {
            return Err(mismatch(format!(
                "does not spend the loan output {} at input {LOAN_INPUT}",
                outpoint_string(&loan)
            )));
        }
        let successor = tx.output.get(LOAN_OUTPUT as usize);
        if !successor.is_some_and(|output| self.pinned.collateral_after(j).matches(output)) {
            return Err(mismatch(format!(
                "does not hold the collateral after {j} installments at output {LOAN_OUTPUT}"
            )));
        }
        let payment = tx
            .output
            .get(INSTALLMENT_OUTPUT as usize)
            .filter(|output| output.asset == self.repayment_asset())
            .ok_or_else(|| {
                mismatch(format!(
                    "does not pay the repayment asset at output {INSTALLMENT_OUTPUT}"
                ))
            })?;
        let debt = debt_after(self.debt(), &payment.value)
            .map_err(|e| mismatch(format!("leaves no debt: {e}")))?;

        let (opening, extra_data) = self.open(lender, tx, loan, payment).unzip();
        let message = extra_data.map_or(Ok(None), |extra_data| {
            ReadMessage::read(
                &extra_data,
                &self.borrower,
                CoreMessagePhase::Installment(j),
                &self.offer_id,
            )
        });
        self.opening = self
            .opening
            .zip(opening)
            .and_then(|(owed, paid)| owed.after(paid));
        self.loans.push(OutPoint::new(tx.txid(), LOAN_OUTPUT));
        self.debts.push(debt);
        self.installments.push(Installment {
            outpoint: OutPoint::new(tx.txid(), INSTALLMENT_OUTPUT),
            opening,
            message,
        });

        Ok(())
    }

    /// What the party opens of `payment`, output 2 of the installment `tx` that spends `loan`,
    /// and the extra data of its range proof. The borrower derives the installment's key from its
    /// lending key, the loan, input 2 and output 0's script; the lender takes the output's nonce.
    ///
    /// `None` whenever it does not open, whatever the reason: a borrower who builds their own
    /// installments can make one the party cannot open, and that must leave the loan's storage
    /// known, or the lender could not liquidate it.
    fn open(
        &self,
        lender: &XOnlyPublicKey,
        tx: &Transaction,
        loan: OutPoint,
        payment: &TxOut,
    ) -> Option<(DebtOpening, Vec<u8>)> {
        let shared_secret = match self.party {
            Party::Borrower => {
                let first_wallet_input = tx.input.get(FIRST_WALLET_INPUT)?.previous_output;
                let nft_receiver = &tx.output.get(NFT_OUTPUT)?.script_pubkey;
                let ephemeral_sk =
                    installment_ephemeral_key(&self.key, loan, first_wallet_input, nft_receiver);
                OfferSecrets::for_borrower(&ephemeral_sk, lender).shared_secret()
            }
            Party::Lender => {
                OfferSecrets::for_lender(&self.key, &payment.nonce.commitment()?).shared_secret()
            }
        };

        open_installment_with_extra_data(payment, shared_secret, &self.pinned.repayment).ok()
    }

    /// The last loan output.
    fn loan(&self) -> OutPoint {
        *self
            .loans
            .last()
            .expect("the acceptance's loan output comes first")
    }

    /// The debt the last loan output holds.
    fn debt(&self) -> &confidential::Value {
        self.debts
            .last()
            .expect("the debt at acceptance comes first")
    }

    /// `A`, the repayment asset every installment and the full repayment carry.
    fn repayment_asset(&self) -> confidential::Asset {
        self.pinned.repayment.asset_commitment()
    }

    /// The secrets of an output under `A` with `opening`'s amount and value blinder. No
    /// commitment is built from them, so the zero opening is allowed.
    fn under_a(&self, opening: DebtOpening) -> TxOutSecrets {
        let repayment = self.pinned.repayment;

        TxOutSecrets::new(
            repayment.asset_id,
            repayment.asset_blinding_factor,
            opening.amount,
            opening.blinder,
        )
    }

    /// The debt's opening, which only the borrower builds from: `bad-input` for the lender, and
    /// when an installment did not open for the borrower or overpaid the debt.
    fn owed(&self) -> Result<DebtOpening, String> {
        if self.party != Party::Borrower {
            return Err(bad_input("only the borrower pays the loan"));
        }

        self.opening.ok_or_else(|| {
            bad_input("the debt is unknown: an installment does not open with the borrower's key")
        })
    }

    /// The sweep of a liquidation: the unclaimed installments that open, each with its opening.
    fn liquidation_sweep(&self, unclaimed: &[&Installment]) -> Result<Sweep, String> {
        let opened: Vec<_> = unclaimed
            .iter()
            .filter_map(|installment| Some((installment.outpoint, installment.opening?)))
            .collect();
        let amount = opened
            .iter()
            .try_fold(0_u64, |sum, (_, opening)| sum.checked_add(opening.amount))
            .ok_or_else(|| bad_input("the installments add up to more than an amount holds"))?;

        Ok(Sweep {
            outpoints: opened.iter().map(|(outpoint, _)| *outpoint).collect(),
            secrets: opened
                .iter()
                .map(|(_, opening)| self.under_a(*opening))
                .collect(),
            amount,
        })
    }

    /// The sweep of the final claim after `close`: the unclaimed installments, those `unspent`
    /// holds, then the full repayment if `close` is one, all with the combined opening. Every
    /// other installment counts as claimed, and must have opened.
    fn final_sweep(
        &self,
        close: &Transaction,
        unspent: &HashSet<OutPoint>,
        unclaimed: &[&Installment],
    ) -> Result<Sweep, String> {
        let claimed = self
            .installments
            .iter()
            .enumerate()
            .filter(|(_, installment)| !unspent.contains(&installment.outpoint))
            .map(|(index, installment)| {
                installment.opening.ok_or_else(|| {
                    bad_input(format!(
                        "installment {} is claimed, but it does not open with the lender's key",
                        index + 1
                    ))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let loan = self.loan();
        let txid = close.txid();
        if close
            .input
            .get(LOAN_INPUT)
            .map(|input| input.previous_output)
            != Some(loan)
        {
            return Err(loan_mismatch(format!(
                "the close {txid} does not spend the loan output {} at input {LOAN_INPUT}",
                outpoint_string(&loan)
            )));
        }
        let output = close.output.get(CLOSE_OUTPUT as usize);
        let key = output.and_then(|output| revealed_key(&output.script_pubkey));
        let (zero_debt, repayment) = match (output, key) {
            (_, Some(key)) => {
                let blinder = zero_debt_blinder(&key, self.debt())
                    .map_err(|e| loan_mismatch(format!("the key the close {txid} reveals: {e}")))?;
                (Some(blinder), None)
            }
            (Some(output), None)
                if output.asset == self.repayment_asset() && output.value == *self.debt() =>
            {
                (None, Some(OutPoint::new(txid, CLOSE_OUTPUT)))
            }
            _ => {
                return Err(loan_mismatch(format!(
                    "output {CLOSE_OUTPUT} of the close {txid} neither repays the debt nor \
                     reveals its key"
                )));
            }
        };

        let outpoints: Vec<_> = unclaimed
            .iter()
            .map(|installment| installment.outpoint)
            .chain(repayment)
            .collect();
        let start = DebtOpening::of(&self.pinned.repayment);
        let opening = match sweep_opening(start, &claimed, zero_debt) {
            Some(opening) if !outpoints.is_empty() => opening,
            None if outpoints.is_empty() => {
                return Ok(Sweep {
                    outpoints,
                    secrets: Vec::new(),
                    amount: 0,
                });
            }
            _ => {
                return Err(loan_mismatch(
                    "the claimed installments and the outputs left do not add up to the debt at \
                     acceptance",
                ));
            }
        };
        let zero = DebtOpening {
            amount: 0,
            blinder: ValueBlindingFactor::zero(),
        };
        let secrets = (0..outpoints.len())
            .map(|position| self.under_a(if position == 0 { opening } else { zero }))
            .collect();

        Ok(Sweep {
            outpoints,
            secrets,
            amount: opening.amount,
        })
    }
}

/// The key that output 1 of a zero-debt close reveals: its script is exactly `OP_RETURN` and one
/// 32-byte push, as the covenant requires.
fn revealed_key(script: &Script) -> Option<[u8; 32]> {
    match script.as_bytes() {
        [0x6a, 0x20, key @ ..] => key.try_into().ok(),
        _ => None,
    }
}

#[wasm_bindgen]
impl LoanState {
    /// The number of installments read.
    #[wasm_bindgen(getter, js_name = installmentCount)]
    pub fn installment_count(&self) -> u32 {
        // `loanState` refuses more installments than a u32 counts
        self.installments.len() as u32
    }

    /// The output that holds the loan now, `"<txid>:<vout>"`: the acceptance's output 0, or the
    /// last installment's output 1.
    #[wasm_bindgen(getter, js_name = loanOutpoint)]
    pub fn loan_outpoint(&self) -> String {
        outpoint_string(&self.loan())
    }

    /// The debt the loan output holds, `D`: its 33-byte consensus encoding, hex.
    #[wasm_bindgen(getter, js_name = debtCommitment)]
    pub fn debt_commitment(&self) -> String {
        encode_hex(&serialize(self.debt()))
    }

    /// `h(A, D)`, which the storage of the loan output holds, hex: the debt hash of the full
    /// repayment's and the liquidation's witnesses.
    #[wasm_bindgen(getter, js_name = debtHash)]
    pub fn debt_hash(&self) -> String {
        encode_hex(&debt_hash(&self.repayment_asset(), self.debt()))
    }

    /// The sum of the installments that opened for the party.
    #[wasm_bindgen(getter)]
    pub fn paid(&self) -> u128 {
        self.installments
            .iter()
            .filter_map(|installment| installment.opening)
            .map(|opening| u128::from(opening.amount))
            .sum()
    }

    /// The amount still owed, when every installment opened for the party; `undefined` when one
    /// did not, or when they paid more than the debt.
    #[wasm_bindgen(getter)]
    pub fn remaining(&self) -> Option<u64> {
        self.opening.map(|opening| opening.amount)
    }

    /// The debt hash the storage of loan output `j` holds, hex: 0 is the acceptance's, and `j`
    /// the `j`-th installment's.
    #[wasm_bindgen(js_name = debtHashAt)]
    pub fn debt_hash_at(&self, j: u32) -> Result<String, String> {
        let debt = self.debts.get(j as usize).ok_or_else(|| {
            bad_input(format!(
                "the loan has no output {j}: it had {} installments",
                self.installment_count()
            ))
        })?;

        Ok(encode_hex(&debt_hash(&self.repayment_asset(), debt)))
    }

    /// The `j`-th installment, from 1: the installment that left loan output `j`.
    pub fn installment(&self, j: u32) -> Result<InstallmentInfo, String> {
        let installment = (j as usize)
            .checked_sub(1)
            .and_then(|index| self.installments.get(index))
            .ok_or_else(|| {
                bad_input(format!(
                    "the loan has no installment {j}: installments count from 1 to {}",
                    self.installment_count()
                ))
            })?;

        Ok(InstallmentInfo {
            outpoint: outpoint_string(&installment.outpoint),
            amount: installment.opening.map(|opening| opening.amount),
            message: installment.message.clone(),
        })
    }

    /// The secrets of the loan output, which the PSET spends as `input_index`: the collateral
    /// after the installments read.
    #[wasm_bindgen(js_name = loanInputSecret)]
    pub fn loan_input_secret(&self, input_index: u32) -> InputSecret {
        InputSecret {
            index: input_index as usize,
            secrets: self.collateral_now().secrets(),
        }
    }

    /// The collateral the loan output holds: `collateral_after` of the installments read.
    pub fn collateral(&self) -> PinnedOutputInfo {
        PinnedOutputInfo::new(&self.collateral_now())
    }

    /// The borrower's next installment, of `amount`: more than 0, and less than the amount still
    /// owed, which the full repayment pays. The installment spends the loan output at input 1,
    /// `first_wallet_input` (`"<txid>:<vout>"`) at input 2, and returns the borrower NFT to
    /// `nft_receiver_script` (hex) at output 0, a fresh receive address: the installment's key
    /// derives from them, so a transaction that differs leaves an installment the borrower cannot
    /// open, and a debt it can no longer close. Each plan draws a random value blinder.
    ///
    /// The installment carries the borrower's `message`, if any, which must be signed for this
    /// installment of this offer, `Installment` with `installmentCount + 1`.
    ///
    /// `bad-input` for the lender, when the amount still owed is unknown, and for a message
    /// signed for anything else.
    #[wasm_bindgen(js_name = planInstallment)]
    pub fn plan_installment(
        &self,
        amount: u64,
        first_wallet_input: &str,
        nft_receiver_script: &str,
        message: Option<SignedMessage>,
    ) -> Result<InstallmentPlan, String> {
        let owed = self.owed()?;
        if amount == 0 || amount >= owed.amount {
            return Err(bad_input(format!(
                "an installment pays more than 0 and less than the {} still owed, which the full \
                 repayment pays",
                owed.amount
            )));
        }
        let first_wallet_input: OutPoint = parse("first wallet input", first_wallet_input)?;
        let nft_receiver = Script::from(decode_hex(nft_receiver_script)?);
        let installments = self
            .installment_count()
            .checked_add(1)
            .ok_or_else(|| bad_input("too many installments"))?;
        let extra_data = carried_message(
            message,
            &self.borrower,
            CoreMessagePhase::Installment(installments),
            &self.offer_id,
            &format!("installment {installments}"),
        )?;

        let payment = PinnedOutput {
            amount,
            value_blinding_factor: ValueBlindingFactor::new(&mut thread_rng()),
            ..self.pinned.repayment
        };
        let left = debt_after(self.debt(), &payment.value_commitment()).map_err(bad_input)?;

        Ok(InstallmentPlan {
            debt: *self.debt(),
            successor_debt_hash: debt_hash(&self.repayment_asset(), &left),
            payment,
            ephemeral_sk: installment_ephemeral_key(
                &self.key,
                self.loan(),
                first_wallet_input,
                &nft_receiver,
            ),
            successor_collateral: self.pinned.collateral_after(installments),
            extra_data,
        })
    }

    /// How to blind the full repayment, output `output_index`: the debt's opening under `A`, so
    /// that its value commitment is the debt itself, and in the range proof the borrower's
    /// `message`, if any, signed for `FullRepayment` of this offer. The PSET output carries the
    /// lender's blinding key. `bad-input` for the lender, when the amount owed is unknown, when it
    /// is 0, which the zero-debt close closes, and for a message signed for anything else.
    #[wasm_bindgen(js_name = repaymentBlinding)]
    pub fn repayment_blinding(
        &self,
        output_index: u32,
        message: Option<SignedMessage>,
    ) -> Result<PinnedBlinding, String> {
        let owed = self.owed()?;
        if owed.amount == 0 {
            return Err(bad_input(
                "no amount is owed: the zero-debt close closes the loan",
            ));
        }
        let extra_data = carried_message(
            message,
            &self.borrower,
            CoreMessagePhase::FullRepayment,
            &self.offer_id,
            "the full repayment",
        )?;

        Ok(PinnedBlinding::from_core(CorePinnedBlinding {
            output_index: output_index as usize,
            pinned: PinnedOutput {
                amount: owed.amount,
                value_blinding_factor: owed.blinder,
                ..self.pinned.repayment
            },
            ephemeral_sk: None,
            extra_data,
        }))
    }

    /// The key the zero-debt close reveals, hex: the debt's blinder `k`, when no amount is owed.
    /// The close's output 1 is `OP_RETURN` with this one 32-byte push, and its witness carries
    /// the debt and the key. `bad-input` for the lender, and while an amount is owed or unknown.
    #[wasm_bindgen(js_name = zeroDebtKey)]
    pub fn zero_debt_key(&self) -> Result<String, String> {
        let owed = self.owed()?;

        match zero_debt_key(&owed) {
            Some(key) => Ok(encode_hex(&key)),
            None if owed.amount > 0 => Err(bad_input(format!(
                "the debt still owes {}: the full repayment closes the loan",
                owed.amount
            ))),
            None => Err(bad_input(
                "the debt is the point at infinity, which nothing closes",
            )),
        }
    }

    /// What the lender's last transaction of the loan sweeps of `unspent`, the installments (as
    /// `"<txid>:<vout>"`) still unspent.
    ///
    /// - After `close_tx_hex`, the full repayment or the zero-debt close (`loan-mismatch` if it
    ///   is neither, of this loan output): every unspent installment, then the full repayment.
    ///   The first takes the combined opening and the others zero, so that the claim balances
    ///   whatever their range proofs hold. Every other installment counts as claimed, and must
    ///   have opened.
    /// - Without one, a liquidation: the unspent installments that open, each with its own
    ///   opening.
    ///
    /// `bad-input` for the borrower, and for an outpoint that is not one of the installments.
    pub fn sweep(
        &self,
        close_tx_hex: Option<String>,
        unspent: Vec<String>,
    ) -> Result<Sweep, String> {
        if self.party != Party::Lender {
            return Err(bad_input("only the lender sweeps the installments"));
        }
        let unspent = unspent
            .iter()
            .map(|outpoint| parse::<OutPoint>("installment outpoint", outpoint))
            .collect::<Result<HashSet<_>, _>>()?;
        if let Some(other) = unspent.iter().find(|outpoint| {
            !self
                .installments
                .iter()
                .any(|installment| installment.outpoint == **outpoint)
        }) {
            return Err(bad_input(format!(
                "{} is not an installment of this loan",
                outpoint_string(other)
            )));
        }

        let unclaimed: Vec<_> = self
            .installments
            .iter()
            .filter(|installment| unspent.contains(&installment.outpoint))
            .collect();

        match close_tx_hex {
            Some(hex) => self.final_sweep(&parse_tx(&hex)?, &unspent, &unclaimed),
            None => self.liquidation_sweep(&unclaimed),
        }
    }
}

impl LoanState {
    /// The collateral the loan output holds after the installments read.
    fn collateral_now(&self) -> PinnedOutput {
        self.pinned.collateral_after(self.installment_count())
    }
}

/// An installment of a loan: its output, and its amount and the borrower's message when it
/// opened for the party.
#[wasm_bindgen]
pub struct InstallmentInfo {
    outpoint: String,
    amount: Option<u64>,
    message: Result<Option<ReadMessage>, MessageError>,
}

#[wasm_bindgen]
impl InstallmentInfo {
    /// Output 2 of the installment, `"<txid>:<vout>"`.
    #[wasm_bindgen(getter)]
    pub fn outpoint(&self) -> String {
        self.outpoint.clone()
    }

    /// The amount, `undefined` when the installment does not open for the party.
    #[wasm_bindgen(getter)]
    pub fn amount(&self) -> Option<u64> {
        self.amount
    }

    /// The borrower's message, read in the same rewind as the amount and checked against the
    /// borrower's key for this installment of this offer. `undefined` when the installment
    /// carries none or does not open for the party; `bad-input` when its message field does not
    /// decode, which leaves the amount and the loan readable.
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> Result<Option<ReadMessage>, String> {
        self.message.clone().map_err(unreadable)
    }
}

/// The borrower's next installment: what the installment branch's witness takes, and how to
/// blind the successor loan (output 1) and the installment (output 2).
#[wasm_bindgen]
pub struct InstallmentPlan {
    debt: confidential::Value,
    successor_debt_hash: [u8; 32],
    payment: PinnedOutput,
    ephemeral_sk: SecretKey,
    successor_collateral: PinnedOutput,
    /// The encoded signed message the installment's range proof carries, empty for none.
    extra_data: Vec<u8>,
}

#[wasm_bindgen]
impl InstallmentPlan {
    /// The debt the loan input's witness carries, `D`: its 33-byte consensus encoding, hex, as
    /// `LoanState.debtCommitment`. The witness takes the low bit of its prefix and the
    /// x-coordinate after it.
    #[wasm_bindgen(getter, js_name = debtWitness)]
    pub fn debt_witness(&self) -> String {
        encode_hex(&serialize(&self.debt))
    }

    /// The debt hash of the successor loan, `h(A, D − V)`, hex: its output 1 is the active offer
    /// at this debt hash.
    #[wasm_bindgen(getter, js_name = successorDebtHash)]
    pub fn successor_debt_hash(&self) -> String {
        encode_hex(&self.successor_debt_hash)
    }

    /// The installment's nonce, the derived key's public key (33-byte compressed, hex): output 2
    /// of the blinded transaction must carry it, or the lender could not open the installment.
    #[wasm_bindgen(getter, js_name = ephemeralPublicKey)]
    pub fn ephemeral_public_key(&self) -> String {
        encode_hex(&self.ephemeral_sk.public_key(SECP256K1).serialize())
    }

    /// How to blind the installment, output `output_index`: its nonce is the derived key's, its
    /// range proof carries the plan's message, and the PSET output must carry the lender's
    /// blinding key (`lenderBlindingKey()`), so that both parties rewind it from the chain.
    #[wasm_bindgen(js_name = installmentBlinding)]
    pub fn installment_blinding(&self, output_index: u32) -> PinnedBlinding {
        PinnedBlinding::from_core(CorePinnedBlinding {
            output_index: output_index as usize,
            pinned: self.payment,
            ephemeral_sk: Some(self.ephemeral_sk),
            extra_data: self.extra_data.clone(),
        })
    }

    /// How to blind the successor loan, output `output_index`: the collateral after one more
    /// installment, whose blinders both parties derive. The contracts' `attach_installment` gives
    /// the PSET output the lender's blinding key.
    #[wasm_bindgen(js_name = successorBlinding)]
    pub fn successor_blinding(&self, output_index: u32) -> PinnedBlinding {
        PinnedBlinding::from_core(CorePinnedBlinding {
            output_index: output_index as usize,
            pinned: self.successor_collateral,
            ephemeral_sk: None,
            extra_data: Vec::new(),
        })
    }

    /// The installment: the amount under `A`, with the plan's random value blinder.
    #[wasm_bindgen(getter)]
    pub fn installment(&self) -> PinnedOutputInfo {
        PinnedOutputInfo::new(&self.payment)
    }

    /// The successor loan: the collateral after one more installment, which `successorBlinding`
    /// blinds. A builder checks the blinded output 1 against its commitments.
    #[wasm_bindgen(getter)]
    pub fn successor(&self) -> PinnedOutputInfo {
        PinnedOutputInfo::new(&self.successor_collateral)
    }
}

/// What the lender's final claim or liquidation sweeps: the outputs, in the order the PSET spends
/// them, and their total.
#[wasm_bindgen]
pub struct Sweep {
    outpoints: Vec<OutPoint>,
    secrets: Vec<TxOutSecrets>,
    amount: u64,
}

#[wasm_bindgen]
impl Sweep {
    /// The outputs to spend, `"<txid>:<vout>"`: empty when nothing is left.
    pub fn outpoints(&self) -> Vec<String> {
        self.outpoints.iter().map(outpoint_string).collect()
    }

    /// Their total, which the claim pays the lender.
    #[wasm_bindgen(getter)]
    pub fn amount(&self) -> u64 {
        self.amount
    }

    /// The secrets of the output at `position` of `outpoints()`, which the PSET spends as
    /// `input_index`. They need not open that output: at a final claim only their sum does.
    #[wasm_bindgen(js_name = inputSecret)]
    pub fn input_secret(&self, position: u32, input_index: u32) -> Result<InputSecret, String> {
        let secrets = self.secrets.get(position as usize).ok_or_else(|| {
            bad_input(format!(
                "the sweep has no output {position}: it has {}",
                self.secrets.len()
            ))
        })?;

        Ok(InputSecret {
            index: input_index as usize,
            secrets: *secrets,
        })
    }
}

#[cfg(test)]
mod tests {
    use elements::confidential::{AssetBlindingFactor, ValueBlindingFactor};
    use elements::encode::serialize;
    use elements::hashes::Hash;
    use elements::hex::ToHex;
    use elements::pset::{Input, Output, PartiallySignedTransaction};
    use elements::secp256k1_zkp::PublicKey;
    use elements::{
        AssetId, OutPoint, Script, Transaction, TxOut, Txid, VerificationError, bitcoin,
    };
    use lending_contracts::programs::private_lending::{
        PrivateLendingOffer, PrivateLendingParameters, verify_offer_as_lender,
    };
    use lending_contracts::programs::program::SimplexProgram;
    use private_lending_core::{
        DebtOpening, Message, MessagePhase as CoreMessagePhase,
        PinnedBlinding as CorePinnedBlinding, PinnedOutput, SignedMessage as CoreSignedMessage,
        installment_ephemeral_key, lift_lending_key,
    };
    use rand::thread_rng;
    use simplex::provider::SimplicityNetwork;

    use super::*;
    use crate::blind::blind_pset;
    use crate::error::encode_hex;
    use crate::open::tests::{creation_hex, fixture, key_of, tx_of};
    use crate::open::{
        MessagePhase, PinnedRole, SignedMessage, open_creation_as_borrower_hex,
        open_creation_as_lender_hex, outpoint_string, sign_message,
    };

    /// The fee of every test transaction, in the principal asset.
    const FEE: u64 = 500;
    /// What a coin holds beyond what a transaction pays from it, returned as change.
    const CHANGE: u64 = 1_000;

    /// The fixture's offer and its loan from regtest: the parties' keys, the contract's
    /// parameters, and the creation, the acceptance and the installment, hex.
    struct Fixture {
        value: serde_json::Value,
        borrower: LendingKey,
        lender: LendingKey,
        parameters: PrivateLendingParameters,
        creation: String,
        acceptance: String,
        installment: String,
    }

    impl Fixture {
        fn load() -> Fixture {
            let value = fixture();
            let creation = creation_hex(&value);
            let lender = key_of(&value, "lender_master_blinding_key");
            let (_, parameters) = verify_offer_as_lender(
                lender.inner(),
                &tx_of(&creation),
                SimplicityNetwork::default_regtest(),
            )
            .unwrap();
            let loan = &value["loan"];

            Fixture {
                borrower: key_of(&value, "borrower_master_blinding_key"),
                lender,
                parameters,
                creation,
                acceptance: loan["acceptance_tx"].as_str().unwrap().to_string(),
                installment: loan["installment_txs"][0].as_str().unwrap().to_string(),
                value,
            }
        }

        /// The installment's amount, which both parties open.
        fn first_amount(&self) -> u64 {
            self.value["loan"]["installment_amount"].as_u64().unwrap()
        }

        /// The loan's state after `installments` (hex), read by the borrower from the offer it
        /// opens afresh.
        fn as_borrower(&self, installments: &[&str]) -> Result<LoanState, String> {
            open_creation_as_borrower_hex(&self.borrower, &self.creation)
                .unwrap()
                .loan_state(&self.borrower, &self.acceptance, strings(installments))
        }

        /// The same, read by the lender.
        fn as_lender(&self, installments: &[&str]) -> Result<LoanState, String> {
            open_creation_as_lender_hex(&self.lender, &self.creation)
                .unwrap()
                .loan_state(&self.lender, &self.acceptance, strings(installments))
        }

        fn repayment(&self) -> PinnedOutput {
            self.parameters.pinned.repayment
        }

        fn principal(&self) -> AssetId {
            self.repayment().asset_id
        }

        fn lender_blinding_key(&self) -> PublicKey {
            lift_lending_key(&self.lender.inner().x_only_public_key())
        }

        fn borrower_blinding_key(&self) -> PublicKey {
            lift_lending_key(&self.borrower.inner().x_only_public_key())
        }

        /// The contract's loan after `installments` installments that left `debt`.
        fn loan(&self, debt: confidential::Value, installments: u32) -> PrivateLendingOffer {
            PrivateLendingOffer::new_active_at(self.parameters, debt, installments)
        }
    }

    fn strings(hexes: &[&str]) -> Vec<String> {
        hexes.iter().map(|hex| hex.to_string()).collect()
    }

    fn tx_hex(tx: &Transaction) -> String {
        encode_hex(&serialize(tx))
    }

    /// The output `outpoint` (`"<txid>:<vout>"`) of `tx`, with its prevout.
    fn output_of(tx: &Transaction, outpoint: &str) -> (OutPoint, TxOut) {
        let outpoint: OutPoint = outpoint.parse().unwrap();
        assert_eq!(outpoint.txid, tx.txid());
        (outpoint, tx.output[outpoint.vout as usize].clone())
    }

    /// An explicit coin of `amount` of `asset` at `outpoint`.
    fn coin_at(outpoint: OutPoint, asset: AssetId, amount: u64) -> (OutPoint, TxOut, InputSecret) {
        let txout = TxOut {
            script_pubkey: Script::from(vec![0x51, 0x01]),
            ..TxOut::new_fee(amount, asset)
        };
        let secret = InputSecret::explicit(0, &asset.to_string(), amount).unwrap();
        (outpoint, txout, secret)
    }

    /// An explicit coin of `amount` of `asset`, at an outpoint of its own.
    fn coin(seed: u8, asset: AssetId, amount: u64) -> (OutPoint, TxOut, InputSecret) {
        coin_at(
            OutPoint::new(Txid::from_byte_array([seed; 32]), 0),
            asset,
            amount,
        )
    }

    fn explicit_output(script: Script, asset: AssetId, amount: u64) -> Output {
        Output::new_explicit(script, amount, asset, None)
    }

    /// An output blinded to `key` by `blind_pset`: freshly, unless a pinned blinding names it.
    fn blinded_output(script: Script, asset: AssetId, amount: u64, key: PublicKey) -> Output {
        let mut output =
            Output::new_explicit(script, amount, asset, Some(bitcoin::PublicKey::new(key)));
        output.blinder_index = Some(0);
        output
    }

    fn change_output(asset: AssetId) -> Output {
        blinded_output(receiver(0x03), asset, CHANGE, change_key())
    }

    fn fee_output(asset: AssetId) -> Output {
        explicit_output(Script::new(), asset, FEE)
    }

    fn burn(asset: AssetId) -> Output {
        explicit_output(Script::new_op_return(b"burn"), asset, 1)
    }

    fn change_key() -> PublicKey {
        PublicKey::from_secret_key(SECP256K1, &SecretKey::from_slice(&[6; 32]).unwrap())
    }

    fn stranger() -> PublicKey {
        PublicKey::from_secret_key(SECP256K1, &SecretKey::new(&mut thread_rng()))
    }

    fn pinned(output_index: usize, pinned: PinnedOutput, key: Option<SecretKey>) -> PinnedBlinding {
        PinnedBlinding::from_core(CorePinnedBlinding {
            output_index,
            pinned,
            ephemeral_sk: key,
            extra_data: Vec::new(),
        })
    }

    /// The transaction that spends `inputs` into `outputs`, blinded by `blind_pset` as the web
    /// blinds, with the pinned outputs `blindings`; and what its proofs and balance verify to.
    fn blind(
        inputs: Vec<(OutPoint, TxOut, InputSecret)>,
        outputs: Vec<Output>,
        blindings: Vec<PinnedBlinding>,
    ) -> (Transaction, Result<(), VerificationError>) {
        let mut pset = PartiallySignedTransaction::new_v2();
        let (mut secrets, mut prevouts) = (Vec::new(), Vec::new());
        for (index, (outpoint, txout, mut secret)) in inputs.into_iter().enumerate() {
            pset.add_input(Input {
                previous_txid: outpoint.txid,
                previous_output_index: outpoint.vout,
                witness_utxo: Some(txout.clone()),
                ..Default::default()
            });
            secret.index = index;
            secrets.push(secret);
            prevouts.push(txout);
        }
        for output in outputs {
            pset.add_output(output);
        }

        let blinded = blind_pset(&pset.to_string(), secrets, blindings).unwrap();
        let tx = blinded
            .parse::<PartiallySignedTransaction>()
            .unwrap()
            .extract_tx()
            .unwrap();
        let verified = tx.verify_tx_amt_proofs(SECP256K1, &prevouts);
        (tx, verified)
    }

    /// [`blind`], whose proofs and balance must verify.
    fn balanced(
        inputs: Vec<(OutPoint, TxOut, InputSecret)>,
        outputs: Vec<Output>,
        blindings: Vec<PinnedBlinding>,
    ) -> Transaction {
        let (tx, verified) = blind(inputs, outputs, blindings);
        verified.unwrap();
        tx
    }

    fn opening_of(payment: &PinnedOutput) -> DebtOpening {
        DebtOpening {
            amount: payment.amount,
            blinder: payment.value_blinding_factor,
        }
    }

    /// Where an installment comes from: the loan's state, the transaction that holds the loan
    /// output, the debt's opening, which the test knows even where the state does not, and the
    /// principal coin that pays and the receiver of the borrower NFT.
    struct Paying<'a> {
        state: &'a LoanState,
        previous: &'a Transaction,
        owed: DebtOpening,
        wallet: OutPoint,
        receiver: Script,
    }

    impl Paying<'_> {
        /// The plan of an installment of `amount` from here.
        fn plan(&self, amount: u64) -> InstallmentPlan {
            self.plan_with(amount, None)
        }

        /// The plan of an installment of `amount` from here that carries `message`.
        fn plan_with(&self, amount: u64, message: Option<SignedMessage>) -> InstallmentPlan {
            self.state
                .plan_installment(
                    amount,
                    &outpoint_string(&self.wallet),
                    &self.receiver.to_hex(),
                    message,
                )
                .unwrap()
        }
    }

    /// An installment of `payment` built as the web builds it, with `blindings` for outputs 1 and
    /// 2:
    /// - inputs 0 the borrower NFT, 1 the loan, 2 the principal coin;
    /// - outputs 0 the borrower NFT to the receiver, 1 the successor loan at the contract's
    ///   script for the debt left, 2 the installment at the installment lock, blinded to
    ///   `installment_key`, then the change and the fee.
    fn installment_tx(
        f: &Fixture,
        from: &Paying,
        payment: &PinnedOutput,
        blindings: Vec<PinnedBlinding>,
        installment_key: PublicKey,
    ) -> Transaction {
        let parameters = &f.parameters;
        let collateral = parameters.pinned.active_collateral;
        let left = from.owed.after(opening_of(payment)).unwrap();
        let successor = f.loan(
            left.commitment(&f.repayment()),
            from.state.installment_count() + 1,
        );
        let (loan, loan_txout) = output_of(from.previous, &from.state.loan_outpoint());

        balanced(
            vec![
                coin(0x30, parameters.borrower_nft_asset_id, 1),
                (loan, loan_txout, from.state.loan_input_secret(1)),
                coin_at(from.wallet, f.principal(), payment.amount + CHANGE + FEE),
            ],
            vec![
                explicit_output(from.receiver.clone(), parameters.borrower_nft_asset_id, 1),
                blinded_output(
                    successor.get_script_pubkey(),
                    collateral.asset_id,
                    collateral.amount,
                    f.lender_blinding_key(),
                ),
                blinded_output(
                    parameters
                        .get_installment_output_asset_auth()
                        .get_script_pubkey(),
                    f.principal(),
                    payment.amount,
                    installment_key,
                ),
                change_output(f.principal()),
                fee_output(f.principal()),
            ],
            blindings,
        )
    }

    /// The installment that `plan` gives, blinded to `installment_key`.
    fn planned(
        f: &Fixture,
        from: &Paying,
        plan: &InstallmentPlan,
        installment_key: PublicKey,
    ) -> Transaction {
        installment_tx(
            f,
            from,
            &plan.payment,
            vec![plan.successor_blinding(1), plan.installment_blinding(2)],
            installment_key,
        )
    }

    /// An installment of all that is owed under another blinder than the debt's, which
    /// `planInstallment` refuses and a borrower can build by hand: it leaves the zero debt `k·G`.
    /// Blinded to the lender with the derived key, so that both parties open it. Returns the
    /// transaction and what the debt's opening becomes.
    fn installment_of_the_rest(f: &Fixture, from: &Paying) -> (Transaction, DebtOpening) {
        let payment = PinnedOutput {
            amount: from.owed.amount,
            value_blinding_factor: ValueBlindingFactor::new(&mut thread_rng()),
            ..f.repayment()
        };
        let loan = from.state.loan_outpoint().parse().unwrap();
        let ephemeral_sk =
            installment_ephemeral_key(f.borrower.inner(), loan, from.wallet, &from.receiver);
        let installments = from.state.installment_count() + 1;
        let tx = installment_tx(
            f,
            from,
            &payment,
            vec![
                pinned(1, f.parameters.pinned.collateral_after(installments), None),
                pinned(2, payment, Some(ephemeral_sk)),
            ],
            f.lender_blinding_key(),
        );

        (tx, from.owed.after(opening_of(&payment)).unwrap())
    }

    /// The full repayment of `owed` on the loan of `state`, whose output is in `previous`, with
    /// `blinding` for the repayment: inputs 0 the borrower NFT, 1 the loan, 2 a principal coin;
    /// outputs 0 the NFT burn, 1 the repayment to the lender, 2 the collateral to the borrower,
    /// then the change and the fee.
    fn full_repayment_tx(
        f: &Fixture,
        state: &LoanState,
        previous: &Transaction,
        owed: u64,
        blinding: PinnedBlinding,
    ) -> Transaction {
        let parameters = &f.parameters;
        let collateral = parameters.pinned.active_collateral;
        let (loan, loan_txout) = output_of(previous, &state.loan_outpoint());

        balanced(
            vec![
                coin(0x40, parameters.borrower_nft_asset_id, 1),
                (loan, loan_txout, state.loan_input_secret(1)),
                coin(0x41, f.principal(), owed + CHANGE + FEE),
            ],
            vec![
                burn(parameters.borrower_nft_asset_id),
                blinded_output(
                    parameters
                        .get_repayment_output_asset_auth()
                        .get_script_pubkey(),
                    f.principal(),
                    owed,
                    f.lender_blinding_key(),
                ),
                blinded_output(
                    receiver(0x04),
                    collateral.asset_id,
                    collateral.amount,
                    f.borrower_blinding_key(),
                ),
                change_output(f.principal()),
                fee_output(f.principal()),
            ],
            vec![blinding],
        )
    }

    /// The zero-debt close of the loan of `state` revealing `key`, the loan output being in
    /// `previous`: inputs 0 the borrower NFT, 1 the loan, 2 a fee coin; outputs 0 the NFT burn, 1
    /// the `OP_RETURN` of `key`, 2 the collateral to the borrower, then the fee. It is not
    /// verified: `verify_tx_amt_proofs` has no value commitment for the zero-value `OP_RETURN`.
    fn zero_debt_close_tx(
        f: &Fixture,
        state: &LoanState,
        previous: &Transaction,
        key: [u8; 32],
    ) -> Transaction {
        let parameters = &f.parameters;
        let collateral = parameters.pinned.active_collateral;
        let (loan, loan_txout) = output_of(previous, &state.loan_outpoint());

        blind(
            vec![
                coin(0x50, parameters.borrower_nft_asset_id, 1),
                (loan, loan_txout, state.loan_input_secret(1)),
                coin(0x51, f.principal(), FEE),
            ],
            vec![
                burn(parameters.borrower_nft_asset_id),
                explicit_output(Script::new_op_return(&key), f.principal(), 0),
                blinded_output(
                    receiver(0x04),
                    collateral.asset_id,
                    collateral.amount,
                    f.borrower_blinding_key(),
                ),
                fee_output(f.principal()),
            ],
            Vec::new(),
        )
        .0
    }

    /// The outputs that `sweep` names, from `txs`, each with the sweep's input secret.
    fn swept(sweep: &Sweep, txs: &[&Transaction]) -> Vec<(OutPoint, TxOut, InputSecret)> {
        sweep
            .outpoints()
            .iter()
            .enumerate()
            .map(|(position, outpoint)| {
                let tx = txs
                    .iter()
                    .find(|tx| outpoint.starts_with(&tx.txid().to_string()))
                    .unwrap();
                let (outpoint, txout) = output_of(tx, outpoint);
                (
                    outpoint,
                    txout,
                    sweep.input_secret(position as u32, 0).unwrap(),
                )
            })
            .collect()
    }

    /// The lender's final claim of `swept`: inputs 0 the lender NFT, 1… the swept outputs, then a
    /// fee coin; outputs 0 the NFT burn, 1 `amount` to the lender, then the fee. Returns what its
    /// proofs and balance verify to.
    fn final_claim(
        f: &Fixture,
        swept: Vec<(OutPoint, TxOut, InputSecret)>,
        amount: u64,
    ) -> Result<(), VerificationError> {
        let mut inputs = vec![coin(0x60, f.parameters.lender_nft_asset_id, 1)];
        inputs.extend(swept);
        inputs.push(coin(0x61, f.principal(), FEE));
        let claimed = blinded_output(
            receiver(0x05),
            f.principal(),
            amount,
            f.lender_blinding_key(),
        );

        blind(
            inputs,
            vec![
                burn(f.parameters.lender_nft_asset_id),
                claimed,
                fee_output(f.principal()),
            ],
            Vec::new(),
        )
        .1
    }

    fn receiver(seed: u8) -> Script {
        Script::from([vec![0x00, 0x14], vec![seed; 20]].concat())
    }

    fn wallet(seed: u8) -> OutPoint {
        OutPoint::new(Txid::from_byte_array([seed; 32]), 1)
    }

    /// Asserts that `result` is an error with `code` whose message contains `names`.
    fn assert_code(result: Result<impl Sized, String>, code: &str, names: &str) {
        let Err(error) = result else {
            panic!("expected a {code} error naming {names:?}");
        };
        assert!(error.starts_with(&format!("{code}: ")), "{error}");
        assert!(error.contains(names), "{error} does not name {names:?}");
    }

    #[test]
    fn the_fixture_loan_reads_the_same_for_both_parties() {
        let f = Fixture::load();
        let loan = &f.value["loan"];
        let installment = tx_of(&f.installment);
        let collateral = f.parameters.pinned.collateral_after(1);
        assert!(collateral.matches(&installment.output[1]));

        for state in [
            f.as_borrower(&[&f.installment]).unwrap(),
            f.as_lender(&[&f.installment]).unwrap(),
        ] {
            assert_eq!(state.installment_count(), 1);
            assert_eq!(state.loan_outpoint(), loan["loan_outpoint"]);
            assert_eq!(state.debt_commitment(), loan["debt_commitment"]);
            assert_eq!(state.debt_hash(), loan["debt_hashes"][1]);
            for j in 0..2 {
                assert_eq!(
                    state.debt_hash_at(j).unwrap(),
                    loan["debt_hashes"][j as usize]
                );
            }
            assert_code(state.debt_hash_at(2), "bad-input", "2");
            let first = state.installment(1).unwrap();
            assert_eq!(first.outpoint(), loan["installment_outpoint"]);
            assert_eq!(first.amount(), Some(f.first_amount()));
            // the borrower's message, signed for the first installment
            let message = first.message().unwrap().unwrap();
            assert_eq!(message.text(), f.value["messages"]["installment"]);
            assert!(message.verified());
            assert_code(state.installment(0), "bad-input", "0");
            assert_code(state.installment(2), "bad-input", "2");
            assert_eq!(state.paid(), u128::from(f.first_amount()));
            assert_eq!(state.remaining(), loan["remaining"].as_u64());
            // the loan output holds the collateral after one installment
            assert_eq!(
                state.collateral().value_commitment(),
                encode_hex(&serialize(&collateral.value_commitment()))
            );
            assert_eq!(state.loan_input_secret(1).secrets, collateral.secrets());
        }

        // before any installment, the debt is the pinned repayment
        let accepted = f.as_lender(&[]).unwrap();
        assert_eq!(accepted.installment_count(), 0);
        assert_eq!(
            accepted.debt_hash(),
            f.value["arguments"]["repayment_commitment"]
        );
        assert_eq!(accepted.remaining(), Some(f.repayment().amount));
        assert_eq!(
            accepted.loan_outpoint(),
            format!("{}:0", tx_of(&f.acceptance).txid())
        );
    }

    #[test]
    fn borrower_rebuilds_its_plan_from_the_chain() {
        let f = Fixture::load();
        let state = f.as_borrower(&[&f.installment]).unwrap();
        let from = Paying {
            state: &state,
            previous: &tx_of(&f.installment),
            owed: state.opening.unwrap(),
            wallet: wallet(0x70),
            receiver: receiver(0x71),
        };
        let plan = from.plan(2_000);
        assert_eq!(plan.debt_witness(), state.debt_commitment());
        let tx = planned(&f, &from, &plan, f.lender_blinding_key());
        let expected = from.owed.after(opening_of(&plan.payment)).unwrap();
        // the installment's nonce, which the lender opens it with, is the plan's ephemeral key
        assert_eq!(
            encode_hex(&serialize(&tx.output[2].nonce)),
            plan.ephemeral_public_key()
        );

        // on a new device, with nothing saved: the seed and the chain
        let key = key_of(&f.value, "borrower_master_blinding_key");
        let rebuilt = open_creation_as_borrower_hex(&key, &f.creation)
            .unwrap()
            .loan_state(
                &key,
                &f.acceptance,
                strings(&[&f.installment, &tx_hex(&tx)]),
            )
            .unwrap();

        assert_eq!(rebuilt.opening, Some(expected));
        assert_eq!(rebuilt.remaining(), Some(from.owed.amount - 2_000));
        assert_eq!(rebuilt.installment(2).unwrap().amount(), Some(2_000));
        assert_eq!(rebuilt.paid(), u128::from(f.first_amount() + 2_000));
        assert_eq!(rebuilt.loan_outpoint(), format!("{}:1", tx.txid()));
        let debt = expected.commitment(&f.repayment());
        assert_eq!(rebuilt.debt_commitment(), encode_hex(&serialize(&debt)));
        // the plan's successor is the contract's loan at that debt, where the installment put it
        let successor = f.loan(debt, 2);
        assert_eq!(
            plan.successor_debt_hash(),
            encode_hex(&successor.get_debt_hash())
        );
        assert_eq!(rebuilt.debt_hash(), plan.successor_debt_hash());
        assert_eq!(tx.output[1].script_pubkey, successor.get_script_pubkey());
        // the plan's successor collateral is what output 1 holds, and what the next state reads
        let collateral = plan.successor();
        assert_eq!(
            collateral.asset_commitment(),
            encode_hex(&serialize(&tx.output[1].asset))
        );
        assert_eq!(
            collateral.value_commitment(),
            encode_hex(&serialize(&tx.output[1].value))
        );
        assert_eq!(
            collateral.asset_commitment(),
            rebuilt.collateral().asset_commitment()
        );
        assert_eq!(
            collateral.value_commitment(),
            rebuilt.collateral().value_commitment()
        );

        // the lender reads the same debt
        let as_lender = f.as_lender(&[&f.installment, &tx_hex(&tx)]).unwrap();
        assert_eq!(as_lender.remaining(), rebuilt.remaining());
        assert_eq!(as_lender.debt_hash(), rebuilt.debt_hash());

        // the rebuilt opening closes the loan: the full repayment is the debt itself, which the
        // lender sweeps with both installments to receive the repayment amount
        let owed = rebuilt.remaining().unwrap();
        let repaid = full_repayment_tx(
            &f,
            &rebuilt,
            &tx,
            owed,
            rebuilt.repayment_blinding(1, None).unwrap(),
        );
        assert_eq!(repaid.output[1].asset, f.repayment().asset_commitment());
        assert_eq!(
            encode_hex(&serialize(&repaid.output[1].value)),
            rebuilt.debt_commitment()
        );
        let both = [1, 2].map(|j| as_lender.installment(j).unwrap().outpoint());
        let sweep = as_lender
            .sweep(Some(tx_hex(&repaid)), both.to_vec())
            .unwrap();
        assert_eq!(sweep.amount(), f.repayment().amount);
        let first = tx_of(&f.installment);
        assert_eq!(
            final_claim(&f, swept(&sweep, &[&first, &tx, &repaid]), sweep.amount()),
            Ok(())
        );
    }

    #[test]
    fn loan_state_refuses_a_foreign_loan_output() {
        let f = Fixture::load();
        let collateral = f.parameters.pinned.active_collateral;
        let active = f
            .loan(f.repayment().value_commitment(), 0)
            .get_script_pubkey();

        // an output at the loan's address with the collateral's asset and amount, blinded afresh
        let foreign = balanced(
            vec![coin(
                0x80,
                collateral.asset_id,
                collateral.amount + CHANGE + FEE,
            )],
            vec![
                blinded_output(active, collateral.asset_id, collateral.amount, change_key()),
                change_output(collateral.asset_id),
                fee_output(collateral.asset_id),
            ],
            Vec::new(),
        );
        let borrower = open_creation_as_borrower_hex(&f.borrower, &f.creation).unwrap();
        let lender = open_creation_as_lender_hex(&f.lender, &f.creation).unwrap();
        for (opened, key) in [(&borrower, &f.borrower), (&lender, &f.lender)] {
            assert_code(
                opened.loan_state(key, &tx_hex(&foreign), Vec::new()),
                "loan-mismatch",
                "acceptance",
            );
        }

        // an installment whose successor is at the loan's next address, but holds the collateral
        // of another step
        let state = f.as_borrower(&[&f.installment]).unwrap();
        let from = Paying {
            state: &state,
            previous: &tx_of(&f.installment),
            owed: state.opening.unwrap(),
            wallet: wallet(0x81),
            receiver: receiver(0x82),
        };
        let plan = from.plan(1_000);
        let other_step = installment_tx(
            &f,
            &from,
            &plan.payment,
            vec![pinned(1, collateral, None), plan.installment_blinding(2)],
            f.lender_blinding_key(),
        );
        assert_code(
            f.as_borrower(&[&f.installment, &tx_hex(&other_step)]),
            "loan-mismatch",
            "installment 2",
        );

        // an installment that pays the principal under another asset blinder than `A`'s
        let not_a = PinnedOutput {
            asset_blinding_factor: AssetBlindingFactor::new(&mut thread_rng()),
            ..plan.payment
        };
        let other_asset = installment_tx(
            &f,
            &from,
            &not_a,
            vec![plan.successor_blinding(1), pinned(2, not_a, None)],
            f.lender_blinding_key(),
        );
        assert_code(
            f.as_lender(&[&f.installment, &tx_hex(&other_asset)]),
            "loan-mismatch",
            "installment 2",
        );
    }

    #[test]
    fn loan_state_refuses_an_acceptance_of_another_creation() {
        let f = Fixture::load();
        let creation = tx_of(&f.creation).txid();
        let other = tx_of(f.value["other_offer"]["creation_tx"].as_str().unwrap()).txid();
        let borrower = open_creation_as_borrower_hex(&f.borrower, &f.creation).unwrap();
        let lender = open_creation_as_lender_hex(&f.lender, &f.creation).unwrap();

        // the acceptance, its outputs unchanged, spending at input 0 another offer's pending offer,
        // or another output of this creation than its pending offer (output 3)
        for spent in [OutPoint::new(other, 3), OutPoint::new(creation, 2)] {
            let mut forged = tx_of(&f.acceptance);
            forged.input[0].previous_output = spent;
            for (opened, key) in [(&borrower, &f.borrower), (&lender, &f.lender)] {
                assert_code(
                    opened.loan_state(key, &tx_hex(&forged), Vec::new()),
                    "loan-mismatch",
                    "acceptance",
                );
            }
        }
        assert!(f.as_borrower(&[]).is_ok());
        assert!(f.as_lender(&[]).is_ok());
    }

    #[test]
    fn loan_state_refuses_a_broken_chain() {
        let f = Fixture::load();
        let state = f.as_borrower(&[&f.installment]).unwrap();
        let from = Paying {
            state: &state,
            previous: &tx_of(&f.installment),
            owed: state.opening.unwrap(),
            wallet: wallet(0x90),
            receiver: receiver(0x91),
        };
        let second = tx_hex(&planned(
            &f,
            &from,
            &from.plan(1_000),
            f.lender_blinding_key(),
        ));
        assert!(f.as_lender(&[&f.installment, &second]).is_ok());

        // the same installment twice: the second does not spend the first's loan output
        assert_code(
            f.as_lender(&[&f.installment, &f.installment]),
            "loan-mismatch",
            "installment 2",
        );
        // the second installment without the first, or before it
        assert_code(f.as_borrower(&[&second]), "loan-mismatch", "installment 1");
        assert_code(
            f.as_lender(&[&second, &f.installment]),
            "loan-mismatch",
            "installment 1",
        );
        // an installment as the acceptance
        assert_code(
            open_creation_as_lender_hex(&f.lender, &f.creation)
                .unwrap()
                .loan_state(&f.lender, &f.installment, Vec::new()),
            "loan-mismatch",
            "acceptance",
        );

        // a second installment on another first installment of the same loan, which the chain
        // does not hold: it moves the collateral by the same step and pays `A`, but it spends
        // another loan output
        let accepted = f.as_borrower(&[]).unwrap();
        let acceptance = tx_of(&f.acceptance);
        let from = Paying {
            state: &accepted,
            previous: &acceptance,
            owed: accepted.opening.unwrap(),
            wallet: wallet(0x92),
            receiver: receiver(0x93),
        };
        let sibling = planned(&f, &from, &from.plan(1_000), f.lender_blinding_key());
        let after_sibling = f.as_borrower(&[&tx_hex(&sibling)]).unwrap();
        let from = Paying {
            state: &after_sibling,
            previous: &sibling,
            owed: after_sibling.opening.unwrap(),
            wallet: wallet(0x94),
            receiver: receiver(0x95),
        };
        let on_the_sibling = tx_hex(&planned(
            &f,
            &from,
            &from.plan(1_000),
            f.lender_blinding_key(),
        ));
        assert!(f.as_lender(&[&tx_hex(&sibling), &on_the_sibling]).is_ok());
        assert_code(
            f.as_lender(&[&f.installment, &on_the_sibling]),
            "loan-mismatch",
            "installment 2",
        );
    }

    #[test]
    fn lender_without_openings_still_knows_the_storage() {
        let f = Fixture::load();
        let borrower = f.as_borrower(&[&f.installment]).unwrap();
        let from = Paying {
            state: &borrower,
            previous: &tx_of(&f.installment),
            owed: borrower.opening.unwrap(),
            wallet: wallet(0xa0),
            receiver: receiver(0xa1),
        };
        let plan = from.plan(2_000);
        // blinded to another key than the lender's: neither party rewinds it
        let tx = planned(&f, &from, &plan, stranger());
        let installments = [f.installment.as_str(), &tx_hex(&tx)];
        let debt = from
            .owed
            .after(opening_of(&plan.payment))
            .unwrap()
            .commitment(&f.repayment());

        let state = f.as_lender(&installments).unwrap();
        assert_eq!(state.remaining(), None);
        assert_eq!(state.installment(2).unwrap().amount(), None);
        assert_eq!(
            state.installment(1).unwrap().amount(),
            Some(f.first_amount())
        );
        assert_eq!(state.paid(), u128::from(f.first_amount()));
        let successor = f.loan(debt, 2);
        assert_eq!(state.debt_hash(), encode_hex(&successor.get_debt_hash()));
        assert_eq!(state.debt_hash_at(2).unwrap(), state.debt_hash());
        assert_eq!(
            state.debt_hash_at(1).unwrap(),
            f.value["loan"]["debt_hashes"][1]
        );
        assert_eq!(state.debt_commitment(), encode_hex(&serialize(&debt)));
        assert_eq!(tx.output[1].script_pubkey, successor.get_script_pubkey());
        assert_eq!(state.loan_outpoint(), format!("{}:1", tx.txid()));

        // nor can the borrower rebuild its debt
        assert_eq!(f.as_borrower(&installments).unwrap().remaining(), None);

        // a liquidation sweeps the installments that open
        let outpoints = [1, 2].map(|j| state.installment(j).unwrap().outpoint());
        let sweep = state.sweep(None, outpoints.to_vec()).unwrap();
        assert_eq!(sweep.outpoints(), [outpoints[0].clone()]);
        assert_eq!(sweep.amount(), f.first_amount());
        // and needs no opening of the installments it leaves out
        let sweep = state.sweep(None, vec![outpoints[0].clone()]).unwrap();
        assert_eq!(sweep.outpoints(), [outpoints[0].clone()]);
    }

    #[test]
    fn plan_refuses_zero_and_overpayment() {
        let f = Fixture::load();
        let state = f.as_borrower(&[&f.installment]).unwrap();
        let owed = state.remaining().unwrap();
        let (wallet, receiver) = (outpoint_string(&wallet(0xb0)), receiver(0xb1).to_hex());
        let plan = |amount| state.plan_installment(amount, &wallet, &receiver, None);

        for amount in [0, owed, owed + 1, u64::MAX] {
            assert_code(plan(amount), "bad-input", "");
        }
        for amount in [1, owed - 1] {
            assert_eq!(plan(amount).unwrap().installment().amount(), amount);
        }
        assert_code(
            state.plan_installment(1, "zz", &receiver, None),
            "bad-input",
            "",
        );
        assert_code(
            state.plan_installment(1, &wallet, "zz", None),
            "bad-input",
            "",
        );

        // the lender plans nothing, and the borrower sweeps nothing
        let lender = f.as_lender(&[&f.installment]).unwrap();
        assert_code(
            lender.plan_installment(1, &wallet, &receiver, None),
            "bad-input",
            "borrower",
        );
        assert_code(lender.repayment_blinding(1, None), "bad-input", "borrower");
        assert_code(lender.zero_debt_key(), "bad-input", "borrower");
        assert_code(state.sweep(None, Vec::new()), "bad-input", "lender");

        // a key that is not the party's
        assert_code(
            open_creation_as_borrower_hex(&f.borrower, &f.creation)
                .unwrap()
                .loan_state(&f.lender, &f.acceptance, Vec::new()),
            "bad-input",
            "key",
        );
    }

    #[test]
    fn sweep_balances() {
        let f = Fixture::load();
        let first = tx_of(&f.installment);
        let borrower = f.as_borrower(&[&f.installment]).unwrap();
        let from = Paying {
            state: &borrower,
            previous: &first,
            owed: borrower.opening.unwrap(),
            wallet: wallet(0xc0),
            receiver: receiver(0xc1),
        };
        // an installment that the lender cannot open: blinded to another key
        let plan = from.plan(2_000);
        let unopened = planned(&f, &from, &plan, stranger());
        let owed = from.owed.after(opening_of(&plan.payment)).unwrap();
        let installments = [f.installment.as_str(), &tx_hex(&unopened)];
        let after_unopened = f.as_borrower(&installments).unwrap();

        // after the full repayment of the rest, with the first installment claimed: the
        // installment and the repayment take the combined opening
        // the borrower cannot open the installment, so the opening is the one the test knows
        let repayment = PinnedOutput {
            amount: owed.amount,
            value_blinding_factor: owed.blinder,
            ..f.repayment()
        };
        let repaid = full_repayment_tx(
            &f,
            &after_unopened,
            &unopened,
            owed.amount,
            pinned(1, repayment, None),
        );
        let state = f.as_lender(&installments).unwrap();
        let unclaimed = state.installment(2).unwrap().outpoint();
        let sweep = state
            .sweep(Some(tx_hex(&repaid)), vec![unclaimed.clone()])
            .unwrap();
        assert_eq!(
            sweep.outpoints(),
            [unclaimed.clone(), format!("{}:1", repaid.txid())]
        );
        assert_eq!(sweep.amount(), f.repayment().amount - f.first_amount());
        let inputs = swept(&sweep, &[&unopened, &repaid]);
        assert_eq!(final_claim(&f, inputs, sweep.amount()), Ok(()));
        // the control: with one value blinder changed, the claim does not balance
        let mut inputs = swept(&sweep, &[&unopened, &repaid]);
        inputs[1].2.secrets.value_bf += ValueBlindingFactor::from_slice(&[1; 32]).unwrap();
        assert_eq!(
            final_claim(&f, inputs, sweep.amount()),
            Err(VerificationError::BalanceCheckFailed)
        );

        // the close must spend the loan, and the swept outputs must be the loan's installments
        assert_code(
            state.sweep(Some(f.installment.clone()), vec![unclaimed.clone()]),
            "loan-mismatch",
            "close",
        );
        assert_code(
            state.sweep(Some(tx_hex(&repaid)), vec![format!("{}:1", repaid.txid())]),
            "bad-input",
            "installment",
        );
        // an installment that does not open cannot count as claimed at the final claim
        assert_code(
            state.sweep(Some(tx_hex(&repaid)), Vec::new()),
            "bad-input",
            "installment 2",
        );

        // after a zero-debt close, with the first installment claimed: an installment of all the
        // rest under another blinder leaves `k·G`, and the close reveals `k`
        let (rest, zero) = installment_of_the_rest(
            &f,
            &Paying {
                state: &after_unopened,
                previous: &unopened,
                owed,
                wallet: wallet(0xc2),
                receiver: receiver(0xc3),
            },
        );
        let installments = [f.installment.as_str(), &tx_hex(&unopened), &tx_hex(&rest)];
        let state = f.as_lender(&installments).unwrap();
        assert_eq!(state.installment(3).unwrap().amount(), Some(owed.amount));
        let key = private_lending_core::zero_debt_key(&zero).unwrap();
        let close = zero_debt_close_tx(&f, &f.as_borrower(&installments).unwrap(), &rest, key);

        let unclaimed = [2, 3].map(|j| state.installment(j).unwrap().outpoint());
        let sweep = state
            .sweep(Some(tx_hex(&close)), unclaimed.to_vec())
            .unwrap();
        assert_eq!(sweep.outpoints(), unclaimed);
        assert_eq!(sweep.amount(), f.repayment().amount - f.first_amount());
        assert_eq!(
            final_claim(&f, swept(&sweep, &[&unopened, &rest]), sweep.amount()),
            Ok(())
        );

        // after a liquidation, the installments that open, each with its own opening
        let all = [1, 2, 3].map(|j| state.installment(j).unwrap().outpoint());
        let sweep = state.sweep(None, all.to_vec()).unwrap();
        assert_eq!(sweep.outpoints(), [all[0].clone(), all[2].clone()]);
        assert_eq!(sweep.amount(), f.first_amount() + owed.amount);
        assert_eq!(
            final_claim(&f, swept(&sweep, &[&first, &rest]), sweep.amount()),
            Ok(())
        );
    }

    #[test]
    fn borrower_closes_a_debt_that_owes_nothing() {
        let f = Fixture::load();
        let first = tx_of(&f.installment);
        let borrower = f.as_borrower(&[&f.installment]).unwrap();
        assert_code(borrower.zero_debt_key(), "bad-input", "owe");
        let (rest, zero) = installment_of_the_rest(
            &f,
            &Paying {
                state: &borrower,
                previous: &first,
                owed: borrower.opening.unwrap(),
                wallet: wallet(0xd0),
                receiver: receiver(0xd1),
            },
        );
        let installments = [f.installment.as_str(), &tx_hex(&rest)];

        // the borrower rebuilds the zero debt, and reveals its blinder
        let state = f.as_borrower(&installments).unwrap();
        assert_eq!(state.remaining(), Some(0));
        let key = state.zero_debt_key().unwrap();
        assert_eq!(key, encode_hex(zero.blinder.into_inner().as_ref()));
        assert_code(
            state.repayment_blinding(1, None),
            "bad-input",
            "zero-debt close",
        );
        assert_code(
            state.plan_installment(
                1,
                &outpoint_string(&wallet(0xd2)),
                &receiver(0xd3).to_hex(),
                None,
            ),
            "bad-input",
            "",
        );

        // the lender sweeps both installments with the close's key
        let key: [u8; 32] = elements::hex::FromHex::from_hex(&key).unwrap();
        let close = zero_debt_close_tx(&f, &state, &rest, key);
        let lender = f.as_lender(&installments).unwrap();
        let both = [1, 2].map(|j| lender.installment(j).unwrap().outpoint());
        let sweep = lender.sweep(Some(tx_hex(&close)), both.to_vec()).unwrap();
        assert_eq!(sweep.amount(), f.repayment().amount);
        assert_eq!(
            final_claim(&f, swept(&sweep, &[&first, &rest]), sweep.amount()),
            Ok(())
        );

        // with both claimed, nothing is left to sweep
        let nothing = lender.sweep(Some(tx_hex(&close)), Vec::new()).unwrap();
        assert!(nothing.outpoints().is_empty());
        assert_eq!(nothing.amount(), 0);
        assert_code(nothing.input_secret(0, 1), "bad-input", "0");

        // a key that opens another debt is not the close of this one
        let mut other = key;
        other[31] ^= 1;
        let forged = zero_debt_close_tx(&f, &state, &rest, other);
        assert_code(
            lender.sweep(Some(tx_hex(&forged)), both.to_vec()),
            "loan-mismatch",
            "key",
        );
    }

    #[test]
    fn a_zero_opening_is_refused_without_a_panic() {
        let f = Fixture::load();
        let mut state = f.as_borrower(&[&f.installment]).unwrap();
        // the opening `(0, 0)`, the point at infinity, which `DebtOpening::commitment` cannot
        // encode: no chain gives it, since the covenant and `debt_after` refuse that installment
        state.opening = Some(DebtOpening {
            amount: 0,
            blinder: ValueBlindingFactor::zero(),
        });
        let (wallet, receiver) = (outpoint_string(&wallet(0xe0)), receiver(0xe1).to_hex());

        assert_code(state.repayment_blinding(1, None), "bad-input", "");
        assert_code(state.zero_debt_key(), "bad-input", "");
        for amount in [0, 1] {
            assert_code(
                state.plan_installment(amount, &wallet, &receiver, None),
                "bad-input",
                "",
            );
        }
    }

    /// The creation's txid, display hex: the offer id the fixture's messages are signed for.
    fn offer_id(f: &Fixture) -> String {
        tx_of(&f.creation).txid().to_string()
    }

    /// The first installment's state as the borrower, and where a second installment comes from.
    fn after_the_first(f: &Fixture) -> (LoanState, Transaction) {
        (
            f.as_borrower(&[&f.installment]).unwrap(),
            tx_of(&f.installment),
        )
    }

    /// An acceptance of the fixture's offer built as the web builds it, the principal carrying
    /// `message`: inputs 0 the pending offer, 1 a principal coin; outputs 0 the active collateral
    /// and 1 the principal, both blinded to the borrower, then the change and the fee.
    fn acceptance_tx(f: &Fixture, message: Option<SignedMessage>) -> Transaction {
        let offer = open_creation_as_lender_hex(&f.lender, &f.creation).unwrap();
        let creation = tx_of(&f.creation);
        let pinned = f.parameters.pinned;
        let (collateral, principal) = (pinned.active_collateral, pinned.principal);

        balanced(
            vec![
                (
                    OutPoint::new(creation.txid(), CREATION_PENDING_OFFER_OUTPUT),
                    creation.output[CREATION_PENDING_OFFER_OUTPUT as usize].clone(),
                    offer.input_secret(PinnedRole::PendingCollateral, 0),
                ),
                coin(0x20, f.principal(), principal.amount + CHANGE + FEE),
            ],
            vec![
                blinded_output(
                    receiver(0x21),
                    collateral.asset_id,
                    collateral.amount,
                    f.borrower_blinding_key(),
                ),
                blinded_output(
                    receiver(0x22),
                    principal.asset_id,
                    principal.amount,
                    f.borrower_blinding_key(),
                ),
                change_output(f.principal()),
                fee_output(f.principal()),
            ],
            vec![
                offer
                    .pinned_blinding(PinnedRole::ActiveCollateral, 0, None)
                    .unwrap(),
                offer
                    .pinned_blinding(PinnedRole::Principal, 1, message)
                    .unwrap(),
            ],
        )
    }

    /// A second installment of 2 000 built by hand, whose range proof carries `extra_data`,
    /// blinded to the lender with the derived key so that both parties open it.
    fn installment_carrying(f: &Fixture, extra_data: Vec<u8>) -> Transaction {
        let (state, first) = after_the_first(f);
        let from = Paying {
            state: &state,
            previous: &first,
            owed: state.opening.unwrap(),
            wallet: wallet(0xf0),
            receiver: receiver(0xf1),
        };
        let payment = PinnedOutput {
            amount: 2_000,
            value_blinding_factor: ValueBlindingFactor::new(&mut thread_rng()),
            ..f.repayment()
        };
        let loan = state.loan_outpoint().parse().unwrap();
        let ephemeral_sk =
            installment_ephemeral_key(f.borrower.inner(), loan, from.wallet, &from.receiver);

        installment_tx(
            f,
            &from,
            &payment,
            vec![
                pinned(1, f.parameters.pinned.collateral_after(2), None),
                PinnedBlinding::from_core(CorePinnedBlinding {
                    output_index: 2,
                    pinned: payment,
                    ephemeral_sk: Some(ephemeral_sk),
                    extra_data,
                }),
            ],
            f.lender_blinding_key(),
        )
    }

    #[test]
    fn acceptance_message_reads_for_the_borrower_only() {
        let f = Fixture::load();
        let id = offer_id(&f);
        let text = "Accepted.\nThe principal is yours 🙂";
        let signed = sign_message(&f.lender, &id, MessagePhase::Acceptance, 0, text).unwrap();
        let tx = tx_hex(&acceptance_tx(&f, Some(signed.clone())));
        let as_borrower = open_creation_as_borrower_hex(&f.borrower, &f.creation).unwrap();
        let as_lender = open_creation_as_lender_hex(&f.lender, &f.creation).unwrap();
        let read = |offer: &OpenedOffer, key: &LendingKey, tx: &str, output: u32| {
            offer
                .read_message(key, &id, tx, output, MessagePhase::Acceptance)
                .unwrap()
        };

        let message = read(&as_borrower, &f.borrower, &tx, 1).unwrap();
        assert_eq!(message.text(), text);
        assert!(message.verified());
        // the principal is blinded to the borrower: the lender's key does not rewind it
        assert!(read(&as_lender, &f.lender, &tx, 1).is_none());
        // the active collateral carries none, and neither does an acceptance without a message
        assert!(read(&as_borrower, &f.borrower, &tx, 0).is_none());
        let without = tx_hex(&acceptance_tx(&f, None));
        assert!(read(&as_borrower, &f.borrower, &without, 1).is_none());
        // read as the full repayment's, the lender's signature does not verify
        let as_repayment = as_borrower
            .read_message(&f.borrower, &id, &tx, 1, MessagePhase::FullRepayment)
            .unwrap()
            .unwrap();
        assert_eq!(as_repayment.text(), text);
        assert!(!as_repayment.verified());

        // the principal takes only the lender's acceptance message of this offer
        assert_code(
            as_lender.pinned_blinding(PinnedRole::ActiveCollateral, 0, Some(signed)),
            "bad-input",
            "principal",
        );
        let other_offer = tx_of(f.value["other_offer"]["creation_tx"].as_str().unwrap())
            .txid()
            .to_string();
        for wrong in [
            sign_message(&f.borrower, &id, MessagePhase::Acceptance, 0, text),
            sign_message(&f.lender, &id, MessagePhase::FullRepayment, 0, text),
            sign_message(&f.lender, &id, MessagePhase::Installment, 1, text),
            sign_message(&f.lender, &other_offer, MessagePhase::Acceptance, 0, text),
        ] {
            assert_code(
                as_lender.pinned_blinding(PinnedRole::Principal, 1, Some(wrong.unwrap())),
                "bad-input",
                "acceptance",
            );
        }

        // the offer id must be this offer's, and an installment's output is read from the loan
        assert_code(
            as_borrower.read_message(&f.borrower, &other_offer, &tx, 1, MessagePhase::Acceptance),
            "bad-input",
            "offer",
        );
        assert_code(
            as_borrower.read_message(&f.borrower, &id, &tx, 1, MessagePhase::Installment),
            "bad-input",
            "installment",
        );
        assert_code(
            as_borrower.read_message(&f.borrower, &id, &tx, 9, MessagePhase::Acceptance),
            "bad-input",
            "9",
        );
    }

    #[test]
    fn installment_message_reads_for_both_parties() {
        let f = Fixture::load();
        let id = offer_id(&f);
        let (state, first) = after_the_first(&f);
        let from = Paying {
            state: &state,
            previous: &first,
            owed: state.opening.unwrap(),
            wallet: wallet(0xa0),
            receiver: receiver(0xa1),
        };
        let text = "Second installment.\nThe rest next month.";
        let signed = sign_message(&f.borrower, &id, MessagePhase::Installment, 2, text).unwrap();
        let tx = planned(
            &f,
            &from,
            &from.plan_with(2_000, Some(signed)),
            f.lender_blinding_key(),
        );
        let plain = planned(&f, &from, &from.plan(2_000), f.lender_blinding_key());
        // the range proof is as long with the message as without
        assert_eq!(
            tx.output[2]
                .witness
                .rangeproof
                .as_ref()
                .unwrap()
                .serialize()
                .len(),
            plain.output[2]
                .witness
                .rangeproof
                .as_ref()
                .unwrap()
                .serialize()
                .len()
        );

        for (with, without) in [
            (
                f.as_borrower(&[&f.installment, &tx_hex(&tx)]).unwrap(),
                f.as_borrower(&[&f.installment, &tx_hex(&plain)]).unwrap(),
            ),
            (
                f.as_lender(&[&f.installment, &tx_hex(&tx)]).unwrap(),
                f.as_lender(&[&f.installment, &tx_hex(&plain)]).unwrap(),
            ),
        ] {
            let second = with.installment(2).unwrap();
            assert_eq!(second.amount(), Some(2_000));
            let message = second.message().unwrap().unwrap();
            assert_eq!(message.text(), text);
            assert!(message.verified());
            assert!(without.installment(2).unwrap().message().unwrap().is_none());
        }
    }

    #[test]
    fn repayment_message_reads_for_the_lender() {
        let f = Fixture::load();
        let id = offer_id(&f);
        let (state, first) = after_the_first(&f);
        let text = "Repaid in full. Thank you!";
        let signed = sign_message(&f.borrower, &id, MessagePhase::FullRepayment, 0, text).unwrap();
        let repaid = full_repayment_tx(
            &f,
            &state,
            &first,
            state.remaining().unwrap(),
            state.repayment_blinding(1, Some(signed)).unwrap(),
        );
        let hex = tx_hex(&repaid);
        let as_lender = open_creation_as_lender_hex(&f.lender, &f.creation).unwrap();
        let as_borrower = open_creation_as_borrower_hex(&f.borrower, &f.creation).unwrap();

        let message = as_lender
            .read_message(&f.lender, &id, &hex, 1, MessagePhase::FullRepayment)
            .unwrap()
            .unwrap();
        assert_eq!(message.text(), text);
        assert!(message.verified());
        // the repayment is blinded to the lender: the borrower's key does not rewind it
        assert!(
            as_borrower
                .read_message(&f.borrower, &id, &hex, 1, MessagePhase::FullRepayment)
                .unwrap()
                .is_none()
        );

        // the repayment takes only the borrower's full repayment message of this offer
        for wrong in [
            sign_message(&f.lender, &id, MessagePhase::FullRepayment, 0, text),
            sign_message(&f.borrower, &id, MessagePhase::Acceptance, 0, text),
            sign_message(&f.borrower, &id, MessagePhase::Installment, 2, text),
        ] {
            assert_code(
                state.repayment_blinding(1, Some(wrong.unwrap())),
                "bad-input",
                "full repayment",
            );
        }
    }

    #[test]
    fn a_message_for_another_installment_is_refused_at_plan() {
        let f = Fixture::load();
        let id = offer_id(&f);
        let (state, _) = after_the_first(&f);
        let (wallet, receiver) = (outpoint_string(&wallet(0xa2)), receiver(0xa3).to_hex());
        let plan = |message: SignedMessage| {
            state.plan_installment(2_000, &wallet, &receiver, Some(message))
        };
        let text = "hello";

        // the next installment is the second
        for (phase, j) in [
            (MessagePhase::Installment, 1),
            (MessagePhase::Installment, 3),
            (MessagePhase::Acceptance, 0),
            (MessagePhase::FullRepayment, 0),
        ] {
            let signed = sign_message(&f.borrower, &id, phase, j, text).unwrap();
            assert_code(plan(signed), "bad-input", "installment 2");
        }
        // signed by the lender, or for another offer
        let by_lender = sign_message(&f.lender, &id, MessagePhase::Installment, 2, text).unwrap();
        assert_code(plan(by_lender), "bad-input", "installment 2");
        let elsewhere = sign_message(
            &f.borrower,
            &"11".repeat(32),
            MessagePhase::Installment,
            2,
            text,
        )
        .unwrap();
        assert_code(plan(elsewhere), "bad-input", "installment 2");

        let right = sign_message(&f.borrower, &id, MessagePhase::Installment, 2, text).unwrap();
        assert!(plan(right).is_ok());
    }

    #[test]
    fn a_moved_message_reads_as_unverified() {
        let f = Fixture::load();
        let text = "the first installment's message";
        // the borrower's message for installment 1, as the lender, who could remake the range
        // proof, might move it to installment 2
        let first = CoreSignedMessage::sign(
            Message::text(text).unwrap(),
            f.borrower.inner(),
            CoreMessagePhase::Installment(1),
            &tx_of(&f.creation).txid(),
        )
        .unwrap();
        let moved = tx_hex(&installment_carrying(&f, first.encode()));

        for state in [
            f.as_borrower(&[&f.installment, &moved]).unwrap(),
            f.as_lender(&[&f.installment, &moved]).unwrap(),
        ] {
            let second = state.installment(2).unwrap();
            assert_eq!(second.amount(), Some(2_000));
            let message = second.message().unwrap().unwrap();
            assert_eq!(message.text(), text);
            assert!(!message.verified());
        }
    }

    #[test]
    fn an_unreadable_installment_message_leaves_the_loan_readable() {
        let f = Fixture::load();
        // version 2 of the message field, which no reader knows, and a text that is not UTF-8
        for field in [vec![2, 1, 0, 1, b'a'], vec![1, 1, 0, 1, 0xff]] {
            let crafted = tx_hex(&installment_carrying(&f, field));
            for state in [
                f.as_borrower(&[&f.installment, &crafted]).unwrap(),
                f.as_lender(&[&f.installment, &crafted]).unwrap(),
            ] {
                let second = state.installment(2).unwrap();
                assert_eq!(second.amount(), Some(2_000));
                assert_code(second.message(), "bad-input", "message");
                assert_eq!(state.installment_count(), 2);
            }
        }
    }
}
