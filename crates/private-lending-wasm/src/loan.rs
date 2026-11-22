//! A loan's state, read from its acceptance and its installments on chain, and what each party
//! builds from it: the borrower's installments, which release collateral, and full repayment, and
//! the lender's sweep of the installments and its search for the collateral it cannot read.
//!
//! Both parties read the same transactions. The debt follows as a point, `D₀` less each
//! installment's value commitment ([`debt_after`]), so the storage of every loan output is known
//! to both whatever opens. Each installment is also opened for the party: the borrower rebuilds
//! the installment's derived key from its lending key and the transaction, and the lender uses
//! the installment's nonce. The debt's opening, which the borrower needs to close the loan, is
//! known when every installment opened. The same rewind reads the borrower's message on the
//! installment, if any.
//!
//! The collateral at step `k` holds `c_k = ceil(d_k·C/R)`, with the asset blinder `a_c + k` and
//! the value blinder `x_k − c_k·k`: known whenever the debt's opening is. A lender that cannot read
//! an installment finds `c_k` by the search ([`find_collateral_hex`], in a Web Worker) and sets it
//! ([`LoanState::set_collateral`]).
//!
//! The release arithmetic of the core panics on a repayment of 0, a debt above the repayment and a
//! payment above the debt. Every export here checks its inputs first: a loan outside the bounds of
//! release does not read (`out-of-bounds`), and the amounts are checked against the debt.

use std::collections::HashSet;

use elements::confidential::{self, AssetBlindingFactor, ValueBlindingFactor};
use elements::encode::{deserialize, serialize};
use elements::hashes::{HashEngine, sha256};
use elements::secp256k1_zkp::{PublicKey, SECP256K1, Scalar, SecretKey, XOnlyPublicKey};
use elements::{OutPoint, Script, Transaction, TxOut, TxOutSecrets, Txid};
use private_lending_core::{
    CARRY_SUPPLY, DebtOpening, LEAF_IV, LendingKey as CoreLendingKey, MAX_COLLATERAL, MAX_STEPS,
    MessageError, MessagePhase as CoreMessagePhase, OfferPinned, OfferSecrets,
    PinnedBlinding as CorePinnedBlinding, PinnedOutput, ReleaseProof, ReleaseSecrets,
    ReleaseStatement, asset_point, carry_remainder, collateral_at, collateral_opening, debt_after,
    debt_hash, find_collateral, fold_path, installment_ephemeral_key,
    open_installment_with_extra_data, prove, release_j, release_of, rewind, sweep_opening,
    value_point, verify,
};
use rand::thread_rng;
use wasm_bindgen::prelude::*;

use crate::blind::{InputSecret, PinnedBlinding};
use crate::error::{bad_input, decode_hex, decode_hex_array, encode_hex, err, loan_mismatch};
use crate::keys::LendingKey;
use crate::open::{
    LoanPoints, OpenedOffer, Party, PinnedOutputInfo, ReadMessage, SharedTree, SignedMessage,
    carried_message, outpoint_string, parse_tx, point_hex, tree_of, unreadable,
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
/// The outputs of an installment that hold the carries `W1` (`e + 1` units) and `W2` (`R − e`).
const CARRY_OUTPUTS: [u32; 2] = [3, 4];
/// The output of a full repayment that pays the debt.
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
    secrets: OfferSecrets,
    tree: SharedTree,
    /// The loan's outputs, the acceptance's output 0 and then output 1 of each installment, and
    /// the debt each holds: `D₀`, then the debt each installment leaves.
    loans: Vec<OutPoint>,
    debts: Vec<confidential::Value>,
    /// The last loan output, which the collateral's opening must open.
    loan_output: TxOut,
    installments: Vec<Installment>,
    /// The opening of the debt the last loan output holds, when every installment opened.
    opening: Option<DebtOpening>,
    /// `c_k`, the collateral the last loan output holds: `C` at acceptance, then
    /// `ceil(d_k·C/R)` when the debt's opening is known, or the search's amount once set.
    collateral: Option<u64>,
    /// The carry supply, the creation's output 4, when the creation has one.
    carry_supply: Option<(OutPoint, TxOut)>,
    /// The loan's carries after the last installment, its outputs 3 and 4: empty before the
    /// first, when the carry supply is the carry.
    carries: Vec<(OutPoint, TxOut)>,
}

#[wasm_bindgen]
impl OpenedOffer {
    /// The state of the loan that the acceptance starts, after the installments in their order
    /// on chain (transactions, hex), read with `key`, the lending key of the party that opened
    /// the offer (`bad-input` for another key).
    ///
    /// `out-of-bounds` for an offer outside the bounds of release (`checkOfferBounds`), which no
    /// lender accepts. A transaction that is not the loan's is `loan-mismatch`, naming the
    /// acceptance or the installment (from 1):
    /// - the acceptance's output 0 must be the active collateral and its input 0 must spend the
    ///   creation's pending offer (output 3);
    /// - each installment must spend the previous loan output at its input 1 and pay the
    ///   repayment asset `A` at output 2;
    /// - its output 1 must hold the collateral of its step `j`, the asset commitment `A_c + j·G`,
    ///   and, when the party knows the debt it leaves, exactly `ceil(d_j·C/R)` with the step's
    ///   blinders;
    /// - a loan has at most 1024 installments.
    ///
    /// These do not check the scripts: the caller requires each loan output's script to be the
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
        self.check_offer_bounds()?;
        if installment_tx_hexes.len() > MAX_STEPS as usize {
            return Err(loan_mismatch(format!(
                "a loan has at most {MAX_STEPS} installments, and {} were given",
                installment_tx_hexes.len()
            )));
        }

        let acceptance = parse_tx(acceptance_tx_hex)?;
        let installments = installment_tx_hexes
            .iter()
            .map(|hex| parse_tx(hex))
            .collect::<Result<Vec<_>, _>>()?;

        LoanState::read(self, *key.inner(), &acceptance, &installments)
    }
}

impl LoanState {
    /// The loan of `offer` that `acceptance` starts, which must spend the creation's pending
    /// offer, and `installments`. The offer is within the bounds of release, and there are at
    /// most 1024 installments.
    fn read(
        offer: &OpenedOffer,
        key: CoreLendingKey,
        acceptance: &Transaction,
        installments: &[Transaction],
    ) -> Result<LoanState, String> {
        let pending_offer = OutPoint::new(offer.creation_txid(), CREATION_PENDING_OFFER_OUTPUT);
        let core = offer.inner();
        let pinned = core.pinned;
        let loan = acceptance
            .output
            .get(ACCEPTANCE_LOAN_OUTPUT as usize)
            .filter(|output| pinned.active_collateral.matches(output))
            .ok_or_else(|| {
                loan_mismatch(format!(
                    "output {ACCEPTANCE_LOAN_OUTPUT} of the acceptance {} is not the offer's \
                     active collateral",
                    acceptance.txid()
                ))
            })?;
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
            party: offer.party(),
            key,
            offer_id: pending_offer.txid,
            borrower: core.signed_terms.borrower,
            pinned,
            secrets: core.secrets,
            tree: offer.shared_tree(),
            loans: vec![OutPoint::new(acceptance.txid(), ACCEPTANCE_LOAN_OUTPUT)],
            debts: vec![pinned.repayment.value_commitment()],
            loan_output: loan.clone(),
            installments: Vec::new(),
            opening: Some(DebtOpening::of(&pinned.repayment)),
            collateral: Some(pinned.active_collateral.amount),
            carry_supply: offer.carry_supply_output(),
            carries: Vec::new(),
        };
        for tx in installments {
            state.add_installment(&core.lender, tx)?;
        }

        Ok(state)
    }

    /// Reads the next installment, `tx`: it must spend the loan, move the collateral by one step
    /// and pay `A`. The debt it leaves follows from its value commitment, the opening of the debt
    /// from what the party opens of it, and the collateral from the opening.
    fn add_installment(&mut self, lender: &XOnlyPublicKey, tx: &Transaction) -> Result<(), String> {
        let j = self.installment_count() + 1;
        let loan = self.loan();
        let mismatch =
            |what: String| loan_mismatch(format!("installment {j} ({}) {what}", tx.txid()));
        if j > MAX_STEPS {
            return Err(mismatch(format!(
                "is past the last step: a loan has at most {MAX_STEPS} installments"
            )));
        }

        let spent = tx.input.get(LOAN_INPUT).map(|input| input.previous_output);
        if spent != Some(loan) {
            return Err(mismatch(format!(
                "does not spend the loan output {} at input {LOAN_INPUT}",
                outpoint_string(&loan)
            )));
        }
        // the asset commitment of step `j`, `A_c + j·G`, whatever the amount
        let successor = tx
            .output
            .get(LOAN_OUTPUT as usize)
            .filter(|output| output.asset == self.stepped_collateral(j, 1).asset_commitment())
            .ok_or_else(|| {
                mismatch(format!(
                    "does not hold the collateral of step {j} at output {LOAN_OUTPUT}"
                ))
            })?;
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
        let left = self
            .opening
            .zip(opening)
            .and_then(|(owed, paid)| owed.after(paid));
        // the collateral the debt left gives, which output 1 must hold exactly
        let collateral = match left {
            Some(left) if left.amount == 0 => {
                return Err(mismatch(
                    "pays the whole debt, which only the full repayment pays".to_string(),
                ));
            }
            Some(left) => {
                let (collateral, full) = self.terms();
                let held = collateral_at(left.amount, collateral, full);
                if !self.stepped_collateral(j, held).matches(successor) {
                    return Err(mismatch(format!(
                        "does not hold {held} of the collateral, what the debt it leaves gives, \
                         at output {LOAN_OUTPUT}"
                    )));
                }
                Some(held)
            }
            None => None,
        };

        self.opening = left;
        self.collateral = collateral;
        self.loan_output = successor.clone();
        self.loans.push(OutPoint::new(tx.txid(), LOAN_OUTPUT));
        self.debts.push(debt);
        self.carries = CARRY_OUTPUTS
            .iter()
            .filter_map(|&vout| {
                let output = tx.output.get(vout as usize)?;
                Some((OutPoint::new(tx.txid(), vout), output.clone()))
            })
            .collect();
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

    /// `(C, R)`, the collateral and the full repayment: within the bounds of release, which
    /// [`OpenedOffer::loan_state`] checked.
    fn terms(&self) -> (u64, u64) {
        (
            self.pinned.active_collateral.amount,
            self.pinned.repayment.amount,
        )
    }

    /// The collateral of `amount` at step `step`, from 1 to 1024: the asset blinder `a_c + step`
    /// and the value blinder `x_step − amount·step`, as the contracts'
    /// `PrivateLendingParameters::loan_collateral`. Callers keep `step` within 1 to 1024, which
    /// [`OfferSecrets::release_blinders`] requires.
    fn stepped_collateral(&self, step: u32, amount: u64) -> PinnedOutput {
        let active = self.pinned.active_collateral;
        let (x, _) = self.secrets.release_blinders(step);
        let (asset_blinding_factor, value_blinding_factor) =
            collateral_opening(step, amount, &active.asset_blinding_factor, &x);

        PinnedOutput {
            amount,
            asset_blinding_factor,
            value_blinding_factor,
            ..active
        }
    }

    /// The collateral the loan output holds, when its amount is known.
    fn collateral_now(&self) -> Option<PinnedOutput> {
        let amount = self.collateral?;

        Some(match self.installment_count() {
            0 => self.pinned.active_collateral,
            step => self.stepped_collateral(step, amount),
        })
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

    /// The loan's carries, opened by the borrower: the creation's carry supply before the first
    /// installment, then the last installment's outputs 3 and 4. They must be of the creation's
    /// carry token, and the installment's must hold `e + 1` and `R − e` units, or `R + 1` in all
    /// when the debt is unknown.
    fn opened_carries(&self) -> Result<Vec<(OutPoint, TxOutSecrets)>, String> {
        if self.party != Party::Borrower {
            return Err(bad_input("only the borrower opens the carries"));
        }
        let (supply, carry_asset) = self
            .carry_supply
            .as_ref()
            .and_then(|(outpoint, output)| {
                let asset = output.asset.explicit()?;
                (output.value.explicit() == Some(CARRY_SUPPLY)).then_some((*outpoint, asset))
            })
            .ok_or_else(|| {
                loan_mismatch(format!(
                    "the creation's output 4 is not the carry supply, {CARRY_SUPPLY} explicit \
                     units"
                ))
            })?;
        let step = self.installment_count();
        if step == 0 {
            let secrets = TxOutSecrets::new(
                carry_asset,
                AssetBlindingFactor::zero(),
                CARRY_SUPPLY,
                ValueBlindingFactor::zero(),
            );
            return Ok(vec![(supply, secrets)]);
        }

        let mismatch = |what: String| loan_mismatch(format!("installment {step}'s carries {what}"));
        if self.carries.len() != CARRY_OUTPUTS.len() {
            return Err(mismatch("are not at outputs 3 and 4".to_string()));
        }
        let opened = self
            .carries
            .iter()
            .map(|(outpoint, output)| {
                let secrets = output
                    .nonce
                    .commitment()
                    .and_then(|nonce| {
                        let shared_secret =
                            OfferSecrets::for_lender(&self.key, &nonce).shared_secret();
                        rewind(output, shared_secret).ok()
                    })
                    .map(|(secrets, _)| secrets)
                    .filter(|secrets| {
                        // the rewound asset and blinders come from the range proof's message,
                        // which nothing ties to the commitments, so they are compared too
                        let pinned = PinnedOutput {
                            asset_id: secrets.asset,
                            amount: secrets.value,
                            asset_blinding_factor: secrets.asset_bf,
                            value_blinding_factor: secrets.value_bf,
                        };
                        pinned.matches(output)
                    })
                    .ok_or_else(|| {
                        mismatch(format!(
                            "do not open with the borrower's key at output {}",
                            outpoint.vout
                        ))
                    })?;
                if secrets.asset != carry_asset {
                    return Err(mismatch(format!(
                        "are not of the creation's carry token at output {}",
                        outpoint.vout
                    )));
                }
                Ok((*outpoint, secrets))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let (collateral, full) = self.terms();
        let amounts: Vec<u64> = opened.iter().map(|(_, secrets)| secrets.value).collect();
        let fits = match self.opening {
            Some(debt) => {
                let e = carry_remainder(debt.amount, collateral, full);
                amounts == [e + 1, full - e]
            }
            None => {
                amounts
                    .iter()
                    .try_fold(0_u64, |sum, amount| sum.checked_add(*amount))
                    == Some(full + 1)
            }
        };
        if !fits {
            return Err(mismatch(format!(
                "hold {amounts:?} units, not the remainder of the debt"
            )));
        }

        Ok(opened)
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

    /// The sweep of the final claim after `close`, the full repayment: the unclaimed
    /// installments, those `unspent` holds, then the full repayment, all with the combined
    /// opening. Every other installment counts as claimed, and must have opened.
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
        let repays = close
            .output
            .get(CLOSE_OUTPUT as usize)
            .is_some_and(|output| {
                output.asset == self.repayment_asset() && output.value == *self.debt()
            });
        if !repays {
            return Err(loan_mismatch(format!(
                "output {CLOSE_OUTPUT} of the close {txid} does not repay the debt"
            )));
        }

        let outpoints: Vec<_> = unclaimed
            .iter()
            .map(|installment| installment.outpoint)
            .chain([OutPoint::new(txid, CLOSE_OUTPUT)])
            .collect();
        let start = DebtOpening::of(&self.pinned.repayment);
        let opening = sweep_opening(start, &claimed, None).ok_or_else(|| {
            loan_mismatch(
                "the claimed installments and the outputs left do not add up to the debt at \
                 acceptance",
            )
        })?;
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

    /// The borrower's next installment, as [`LoanState::plan_installment`] describes it, with the
    /// installment's, the carries' and the leftover burn's blinders taken from `blinders`.
    fn plan(
        &self,
        amount: u64,
        first_wallet_input: &str,
        nft_receiver_script: &str,
        message: Option<SignedMessage>,
        blinders: PlanBlinders,
    ) -> Result<InstallmentPlan, String> {
        let owed = self.owed()?;
        let step = self.installment_count();
        if step >= MAX_STEPS {
            return Err(bad_input(format!(
                "the loan has had {MAX_STEPS} installments: only the full repayment is left"
            )));
        }
        if amount == 0 || amount >= owed.amount {
            return Err(bad_input(format!(
                "an installment pays more than 0 and less than the {} still owed, which the full \
                 repayment pays",
                owed.amount
            )));
        }
        let first_wallet_input: OutPoint = parse("first wallet input", first_wallet_input)?;
        let nft_receiver = Script::from(decode_hex(nft_receiver_script)?);
        let next = step + 1;
        let extra_data = carried_message(
            message,
            &self.borrower,
            CoreMessagePhase::Installment(next),
            &self.offer_id,
            &format!("installment {next}"),
        )?;

        let (repayment, active) = (self.pinned.repayment, self.pinned.active_collateral);
        let payment = PinnedOutput {
            amount,
            value_blinding_factor: blinders.payment,
            ..repayment
        };
        let left = debt_after(self.debt(), &payment.value_commitment()).map_err(bad_input)?;
        let debt_left = owed
            .after(DebtOpening::of(&payment))
            .filter(|debt_left| debt_left.commitment(&repayment) == left)
            .ok_or_else(|| bad_input("the debt's opening is not the loan's"))?;

        let carries = self.opened_carries()?;
        let carry_asset = carries[0].1.asset;
        let carried = carries
            .iter()
            .try_fold(0_u64, |sum, (_, secrets)| sum.checked_add(secrets.value));
        let (collateral, full) = self.terms();
        let leftover = carried
            .and_then(|carried| carried.checked_sub(full + 1))
            .ok_or_else(|| loan_mismatch("the carries hold fewer than R + 1 units"))?;

        let held = self
            .collateral
            .ok_or_else(|| bad_input("the collateral is unknown"))?;
        let held_next = collateral_at(debt_left.amount, collateral, full);
        let remainder = carry_remainder(debt_left.amount, collateral, full);
        let successor = self.stepped_collateral(next, held_next);
        let [w1, w2] = [
            (remainder + 1, blinders.carries[0]),
            (full - remainder, blinders.carries[1]),
        ]
        .map(
            |(amount, (asset_blinding_factor, value_blinding_factor))| PinnedOutput {
                asset_id: carry_asset,
                amount,
                asset_blinding_factor,
                value_blinding_factor,
            },
        );

        let (x, y) = self.secrets.release_blinders(next);
        let blinder_commitment = blinder_commitment(&x, &y)?;
        let tree = tree_of(&self.tree, &self.secrets);
        let path = tree.path(step);
        let points = LoanPoints::of(&self.pinned)?;
        let value = |value: confidential::Value| {
            value_point(&value).map_err(|e| bad_input(format!("not a value commitment: {e}")))
        };
        let asset = |asset: confidential::Asset| {
            asset_point(&asset).map_err(|e| bad_input(format!("not an asset commitment: {e}")))
        };
        let statement = ReleaseStatement {
            a: points.repayment_asset,
            a_c: points.collateral_asset,
            v_c0: points.collateral_value,
            d0: points.starting_debt,
            d_next: value(left)?,
            v_s: value(successor.value_commitment())?,
            w1: value(w1.value_commitment())?,
            a_w1: asset(w1.asset_commitment())?,
            w2: value(w2.value_commitment())?,
            a_w2: asset(w2.asset_commitment())?,
            y: blinder_commitment,
        };
        let secrets = ReleaseSecrets::new(
            &active,
            &repayment,
            debt_left,
            (x, y),
            (w1.value_blinding_factor, w2.value_blinding_factor),
        );
        let proof = prove(&statement, &secrets, &self.key);
        check_release(
            &statement,
            &proof,
            &points.fs_iv(),
            &path,
            step,
            &tree.root(),
        )?;

        let (asset_blinding_factor, value_blinding_factor) = blinders.burn;
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
            successor_collateral: successor,
            extra_data,
            step,
            blinder_commitment,
            path,
            proof,
            carries: [w1, w2],
            release: held - held_next,
            leftover: (leftover > 0).then_some(PinnedOutput {
                asset_id: carry_asset,
                amount: leftover,
                asset_blinding_factor,
                value_blinding_factor,
            }),
        })
    }
}

/// The blinders an installment's plan draws: the installment's value blinder, the carries' asset
/// and value blinders, and the leftover burn's.
pub(crate) struct PlanBlinders {
    pub(crate) payment: ValueBlindingFactor,
    pub(crate) carries: [(AssetBlindingFactor, ValueBlindingFactor); 2],
    pub(crate) burn: (AssetBlindingFactor, ValueBlindingFactor),
}

impl PlanBlinders {
    fn random() -> PlanBlinders {
        let rng = &mut thread_rng();
        let mut pair = || (AssetBlindingFactor::new(rng), ValueBlindingFactor::new(rng));

        PlanBlinders {
            carries: [pair(), pair()],
            burn: pair(),
            payment: ValueBlindingFactor::new(&mut thread_rng()),
        }
    }
}

/// `Y = x·G + y·J`, the blinder commitment of a step whose blinders are `x` and `y`.
fn blinder_commitment(x: &SecretKey, y: &SecretKey) -> Result<PublicKey, String> {
    let point_at_infinity = || bad_input("the blinder commitment is the point at infinity");
    let y_j = release_j()
        .mul_tweak(SECP256K1, &Scalar::from(*y))
        .map_err(|_| point_at_infinity())?;

    PublicKey::from_secret_key(SECP256K1, x)
        .combine(&y_j)
        .map_err(|_| point_at_infinity())
}

/// The leaf of a blinder commitment, `compress(LEAF_IV, Y.x, Y.y)`: SHA-256's compression of
/// `x ‖ y` from the chaining value `LEAF_IV`, as the program's `jet::sha_256_block`.
fn blinder_leaf(y: &PublicKey) -> [u8; 32] {
    let iv = sha256::Midstate::from_byte_array(LEAF_IV);
    let mut engine = sha256::HashEngine::from_midstate(iv, 0);
    engine.input(&y.serialize_uncompressed()[1..]);

    // the engine has compressed the full block and holds no partial one
    engine.midstate().to_byte_array()
}

/// The gate before a plan leaves the wasm (proofs, O7): the release proof verifies with the
/// loan's `FS_IV`, the one the contract's arguments carry, and its `Y` is leaf `step` of the tree
/// by `path`, which equation M checks. `proof-invalid` otherwise, which is a bug: the borrower
/// must not broadcast the installment.
fn check_release(
    statement: &ReleaseStatement,
    proof: &ReleaseProof,
    fs_iv: &[u8; 32],
    path: &[(bool, [u8; 32]); 10],
    step: u32,
    root: &[u8; 32],
) -> Result<(), String> {
    if !verify(statement, proof, fs_iv) {
        return Err(err("proof-invalid", "the release proof does not verify"));
    }
    if fold_path(blinder_leaf(&statement.y), path) != (*root, step) {
        return Err(err(
            "proof-invalid",
            format!("the blinder commitment is not leaf {step} of the blinder root"),
        ));
    }

    Ok(())
}

#[wasm_bindgen]
impl LoanState {
    /// The number of installments read.
    #[wasm_bindgen(getter, js_name = installmentCount)]
    pub fn installment_count(&self) -> u32 {
        // `loanState` refuses more than 1024 installments
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

    /// The secrets of the loan output, which the PSET spends as `input_index`: the collateral it
    /// holds. `bad-input` while its amount is unknown: a lender that cannot read an installment
    /// searches for it (`collateralSearch`, `findCollateral`) and sets it (`setCollateral`).
    #[wasm_bindgen(js_name = loanInputSecret)]
    pub fn loan_input_secret(&self, input_index: u32) -> Result<InputSecret, String> {
        let collateral = self.collateral_now().ok_or_else(|| {
            bad_input("the collateral is unknown: search for it and set it with setCollateral")
        })?;

        Ok(InputSecret {
            index: input_index as usize,
            secrets: collateral.secrets(),
        })
    }

    /// The collateral the loan output holds, `c_k` of the active collateral's asset, with its
    /// blinders: `undefined` while its amount is unknown (see `loanInputSecret`). The collateral
    /// released so far is the offer's `collateralAmount()` less its amount.
    pub fn collateral(&self) -> Option<PinnedOutputInfo> {
        self.collateral_now()
            .map(|collateral| PinnedOutputInfo::new(&collateral))
    }

    /// What the search for the collateral of the loan output takes (`findCollateral`), for a
    /// party that cannot compute it: `bad-input` before the first installment, when the loan
    /// holds the active collateral.
    #[wasm_bindgen(js_name = collateralSearch)]
    pub fn collateral_search(&self) -> Result<CollateralSearch, String> {
        let step = self.installment_count();
        if step == 0 {
            return Err(bad_input(
                "before its first installment the loan holds the active collateral",
            ));
        }
        let (x, _) = self.secrets.release_blinders(step);
        let (collateral, _) = self.terms();

        Ok(CollateralSearch {
            value_commitment: encode_hex(&serialize(&self.loan_output.value)),
            asset_commitment: encode_hex(&serialize(
                &self.pinned.active_collateral.asset_commitment(),
            )),
            blinder: encode_hex(&x.secret_bytes()),
            max: collateral,
        })
    }

    /// Sets the collateral the loan output holds to `amount`, the search's result: `bad-input`
    /// before the first installment, and unless the collateral of `amount` at this step opens the
    /// loan output.
    #[wasm_bindgen(js_name = setCollateral)]
    pub fn set_collateral(&mut self, amount: u64) -> Result<(), String> {
        let step = self.installment_count();
        if step == 0 {
            return Err(bad_input(
                "before its first installment the loan holds the active collateral",
            ));
        }
        if amount == 0
            || !self
                .stepped_collateral(step, amount)
                .matches(&self.loan_output)
        {
            return Err(bad_input(format!(
                "{amount} of the collateral does not open the loan output"
            )));
        }
        self.collateral = Some(amount);

        Ok(())
    }

    /// The collateral that paying `amount` releases now, `c_k − ceil((d_k − amount)·C/R)`, for
    /// the borrower's form: from 1 to the amount still owed, which releases all the collateral
    /// left. `bad-input` for another amount, and while the debt is unknown.
    #[wasm_bindgen(js_name = releasePreview)]
    pub fn release_preview(&self, amount: u64) -> Result<u64, String> {
        let debt = self.opening.ok_or_else(|| {
            bad_input("the debt is unknown: an installment does not open with the party's key")
        })?;
        if amount == 0 || amount > debt.amount {
            return Err(bad_input(format!(
                "a payment is more than 0 and at most the {} still owed",
                debt.amount
            )));
        }
        let (collateral, full) = self.terms();

        Ok(release_of(debt.amount, amount, collateral, full))
    }

    /// The loan's carries, which the next installment or the full repayment spends after the
    /// principal coins, opened by the borrower from the chain: the creation's carry supply (output
    /// 4) before the first installment, then the last installment's outputs 3 and 4, rewound with
    /// the borrower's lending key. `bad-input` for the lender; `loan-mismatch` when they are not
    /// the loan's carries: not of the creation's carry token, or not holding the remainder of the
    /// debt, `e + 1` and `R − e` units.
    pub fn carries(&self) -> Result<Vec<Carry>, String> {
        Ok(self
            .opened_carries()?
            .into_iter()
            .map(|(outpoint, secrets)| Carry { outpoint, secrets })
            .collect())
    }

    /// The full repayment's burn of every carry unit: an `OP_RETURN` of all the carries hold
    /// (the sum of `carries()`), of their asset, with blinders drawn once for the `CarrySweep`.
    /// As `carries()` otherwise.
    #[wasm_bindgen(js_name = carrySweep)]
    pub fn carry_sweep(&self) -> Result<CarrySweep, String> {
        let carries = self.opened_carries()?;
        let amount = carries
            .iter()
            .try_fold(0_u64, |sum, (_, secrets)| sum.checked_add(secrets.value))
            .ok_or_else(|| loan_mismatch("the carries hold more than an amount holds"))?;
        let rng = &mut thread_rng();

        Ok(CarrySweep {
            burn: PinnedOutput {
                asset_id: carries[0].1.asset,
                amount,
                asset_blinding_factor: AssetBlindingFactor::new(rng),
                value_blinding_factor: ValueBlindingFactor::new(rng),
            },
        })
    }

    /// The borrower's next installment, of `amount`: more than 0, and less than the amount still
    /// owed, which the full repayment pays. The installment spends the loan output at input 1,
    /// `first_wallet_input` (`"<txid>:<vout>"`) at input 2, and returns the borrower NFT to
    /// `nft_receiver_script` (hex) at output 0, a fresh receive address: the installment's key
    /// derives from them, so a transaction that differs leaves an installment the borrower cannot
    /// open, and a debt it can no longer close. Each plan draws a random value blinder for the
    /// installment and random blinders for the carries.
    ///
    /// The plan proves the release, and verifies the proof with the loan's `FS_IV` and its `Y`
    /// against the blinder root before it returns (`proof-invalid` otherwise, a bug).
    ///
    /// The installment carries the borrower's `message`, if any, which must be signed for this
    /// installment of this offer, `Installment` with `installmentCount + 1`.
    ///
    /// `bad-input` for the lender, when the amount still owed is unknown, after 1024 installments,
    /// and for a message signed for anything else. As `carries()` for the carries it spends.
    #[wasm_bindgen(js_name = planInstallment)]
    pub fn plan_installment(
        &self,
        amount: u64,
        first_wallet_input: &str,
        nft_receiver_script: &str,
        message: Option<SignedMessage>,
    ) -> Result<InstallmentPlan, String> {
        self.plan(
            amount,
            first_wallet_input,
            nft_receiver_script,
            message,
            PlanBlinders::random(),
        )
    }

    /// How to blind the full repayment, output `output_index`: the debt's opening under `A`, so
    /// that its value commitment is the debt itself, and in the range proof the borrower's
    /// `message`, if any, signed for `FullRepayment` of this offer. The PSET output carries the
    /// lender's blinding key. `bad-input` for the lender, when the amount owed is unknown or 0,
    /// and for a message signed for anything else.
    #[wasm_bindgen(js_name = repaymentBlinding)]
    pub fn repayment_blinding(
        &self,
        output_index: u32,
        message: Option<SignedMessage>,
    ) -> Result<PinnedBlinding, String> {
        let owed = self.owed()?;
        if owed.amount == 0 {
            return Err(bad_input("no amount is owed"));
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

    /// What the lender's last transaction of the loan sweeps of `unspent`, the installments (as
    /// `"<txid>:<vout>"`) still unspent.
    ///
    /// - After `close_tx_hex`, the full repayment (`loan-mismatch` if it is not one, of this loan
    ///   output): every unspent installment, then the full repayment. The first takes the
    ///   combined opening and the others zero, so that the claim balances whatever their range
    ///   proofs hold. Every other installment counts as claimed, and must have opened.
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

/// The collateral `c_k ∈ [1, max]` of a loan output whose value commitment is `value_commitment`
/// (`V_k`, 33 bytes, hex), with `asset_commitment` the active collateral's asset commitment
/// (`A_c`, 33 bytes, hex) and `blinder` the step's `x_k` (32 bytes, hex), all as
/// `LoanState.collateralSearch()` gives them: the one amount with `c_k·A_c = V_k − x_k·G`, or
/// `undefined` if none is in `[1, max]`. `bad-input` for malformed hex, a commitment that is not
/// one, and `max` outside `[1, 2^44]`.
///
/// It takes plain values so that a Web Worker can run it: about 1 s in wasm and 32 MiB at
/// `max = 2^44`.
#[wasm_bindgen(js_name = findCollateral)]
pub fn find_collateral_hex(
    value_commitment: &str,
    asset_commitment: &str,
    blinder: &str,
    max: u64,
) -> Result<Option<u64>, String> {
    if !(1..=MAX_COLLATERAL).contains(&max) {
        return Err(bad_input(format!(
            "the search's bound is from 1 to {MAX_COLLATERAL}, not {max}"
        )));
    }
    let value: confidential::Value = deserialize(&decode_hex(value_commitment)?)
        .map_err(|e| bad_input(format!("not a value commitment: {e}")))?;
    let v_k = value_point(&value).map_err(|e| bad_input(format!("not a value commitment: {e}")))?;
    let asset: confidential::Asset = deserialize(&decode_hex(asset_commitment)?)
        .map_err(|e| bad_input(format!("not an asset commitment: {e}")))?;
    let a_c =
        asset_point(&asset).map_err(|e| bad_input(format!("not an asset commitment: {e}")))?;
    let x_k = SecretKey::from_slice(&decode_hex_array::<32>(blinder)?)
        .map_err(|_| bad_input("the blinder is not a scalar"))?;

    Ok(find_collateral(&v_k, &a_c, &x_k, max))
}

/// The blinders of the collateral of `amount` at step `step`, from 1 to 1024: the asset blinder
/// `a_c + step` and the value blinder `x_step − amount·step`, from the active collateral's asset
/// blinder `asset_blinder` (in the format of `PinnedOutputInfo.assetBlinder`) and the step's
/// `blinder` (`CollateralSearch.blinder`). `bad-input` for another step and for malformed input.
#[wasm_bindgen(js_name = collateralOpening)]
pub fn collateral_opening_hex(
    step: u32,
    amount: u64,
    asset_blinder: &str,
    blinder: &str,
) -> Result<CollateralOpening, String> {
    if !(1..=MAX_STEPS).contains(&step) {
        return Err(bad_input(format!(
            "a loan's steps after an installment are 1 to {MAX_STEPS}, not {step}"
        )));
    }
    let asset_blinder: AssetBlindingFactor = parse("asset blinder", asset_blinder)?;
    let x_k = SecretKey::from_slice(&decode_hex_array::<32>(blinder)?)
        .map_err(|_| bad_input("the blinder is not a scalar"))?;
    let (asset_blinder, value_blinder) = collateral_opening(step, amount, &asset_blinder, &x_k);

    Ok(CollateralOpening {
        asset_blinder: asset_blinder.to_string(),
        value_blinder: value_blinder.to_string(),
    })
}

/// What the search for a loan's collateral takes: plain values, which a Web Worker receives.
#[wasm_bindgen]
pub struct CollateralSearch {
    value_commitment: String,
    asset_commitment: String,
    blinder: String,
    max: u64,
}

#[wasm_bindgen]
impl CollateralSearch {
    /// `V_k`, the loan output's value commitment: its 33-byte consensus encoding, hex.
    #[wasm_bindgen(getter, js_name = valueCommitment)]
    pub fn value_commitment(&self) -> String {
        self.value_commitment.clone()
    }

    /// `A_c`, the active collateral's asset commitment: its 33-byte consensus encoding, hex.
    #[wasm_bindgen(getter, js_name = assetCommitment)]
    pub fn asset_commitment(&self) -> String {
        self.asset_commitment.clone()
    }

    /// `x_k`, the step's derived blinder, 32 bytes big-endian, hex: a secret of the offer, which
    /// stays on the device.
    #[wasm_bindgen(getter)]
    pub fn blinder(&self) -> String {
        self.blinder.clone()
    }

    /// The search's bound, the offer's collateral `C`.
    #[wasm_bindgen(getter)]
    pub fn max(&self) -> u64 {
        self.max
    }
}

/// The blinders of a loan's collateral at a step, in the format of `PinnedOutputInfo`.
#[wasm_bindgen]
pub struct CollateralOpening {
    asset_blinder: String,
    value_blinder: String,
}

#[wasm_bindgen]
impl CollateralOpening {
    #[wasm_bindgen(getter, js_name = assetBlinder)]
    pub fn asset_blinder(&self) -> String {
        self.asset_blinder.clone()
    }

    #[wasm_bindgen(getter, js_name = valueBlinder)]
    pub fn value_blinder(&self) -> String {
        self.value_blinder.clone()
    }
}

/// One of a loan's carries, opened by the borrower.
#[wasm_bindgen]
pub struct Carry {
    outpoint: OutPoint,
    secrets: TxOutSecrets,
}

#[wasm_bindgen]
impl Carry {
    /// The carry's output, `"<txid>:<vout>"`: the creation's output 4, or output 3 or 4 of the
    /// last installment.
    #[wasm_bindgen(getter)]
    pub fn outpoint(&self) -> String {
        outpoint_string(&self.outpoint)
    }

    /// The carry token's asset id.
    #[wasm_bindgen(getter)]
    pub fn asset(&self) -> String {
        self.secrets.asset.to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn amount(&self) -> u64 {
        self.secrets.value
    }

    /// The carry's secrets, which the PSET spends as `input_index`.
    #[wasm_bindgen(js_name = inputSecret)]
    pub fn input_secret(&self, input_index: u32) -> InputSecret {
        InputSecret {
            index: input_index as usize,
            secrets: self.secrets,
        }
    }
}

/// The burn of a loan's carries at its full repayment: a confidential `OP_RETURN` pinned with
/// random blinders, since Elements' own blinding refuses an `OP_RETURN`.
#[wasm_bindgen]
pub struct CarrySweep {
    burn: PinnedOutput,
}

#[wasm_bindgen]
impl CarrySweep {
    /// The burn: the carry token, all the carries' units, and the commitments the blinded output
    /// must have.
    #[wasm_bindgen(getter)]
    pub fn burn(&self) -> PinnedOutputInfo {
        PinnedOutputInfo::new(&self.burn)
    }

    /// How to blind the burn, output `output_index`, whose PSET output carries the borrower's
    /// blinding key (`borrowerBlindingKey()`).
    pub fn blinding(&self, output_index: u32) -> PinnedBlinding {
        InstallmentPlan::blinding(self.burn, output_index)
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
/// blind the successor loan (output 1), the installment (output 2), the carries (outputs 3 and
/// 4) and, at the first installment, the burn of the carries' leftover.
#[wasm_bindgen]
pub struct InstallmentPlan {
    debt: confidential::Value,
    successor_debt_hash: [u8; 32],
    payment: PinnedOutput,
    ephemeral_sk: SecretKey,
    successor_collateral: PinnedOutput,
    /// The encoded signed message the installment's range proof carries, empty for none.
    extra_data: Vec<u8>,
    /// `i`, the loan's step before the installment.
    step: u32,
    /// `Y_(i+1)`.
    blinder_commitment: PublicKey,
    path: [(bool, [u8; 32]); 10],
    proof: ReleaseProof,
    /// `W1` of `e + 1` and `W2` of `R − e` units.
    carries: [PinnedOutput; 2],
    release: u64,
    /// The carry units beyond `R + 1` that the first installment burns.
    leftover: Option<PinnedOutput>,
}

impl InstallmentPlan {
    /// How to blind `pinned` at `output_index`, with a random nonce and no message.
    fn blinding(pinned: PinnedOutput, output_index: u32) -> PinnedBlinding {
        PinnedBlinding::from_core(CorePinnedBlinding {
            output_index: output_index as usize,
            pinned,
            ephemeral_sk: None,
            extra_data: Vec::new(),
        })
    }

    /// Carry `carry`, 0 for `W1` or 1 for `W2`.
    fn carry_output(&self, carry: u32) -> Result<PinnedOutput, String> {
        self.carries
            .get(carry as usize)
            .copied()
            .ok_or_else(|| bad_input(format!("an installment has carries 0 and 1, not {carry}")))
    }
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

    /// The witness's index, `i`: the number of installments the loan has had.
    #[wasm_bindgen(getter)]
    pub fn index(&self) -> u32 {
        self.step
    }

    /// The witness's `Y = x_(i+1)·G + y_(i+1)·J`, a `Ge`: its `x ‖ y`, hex.
    #[wasm_bindgen(getter, js_name = blinderCommitment)]
    pub fn blinder_commitment(&self) -> String {
        point_hex(&self.blinder_commitment)
    }

    /// The witness's Merkle path of leaf `i`, from the leaf up: whether the node is the right
    /// child at each of the 10 levels, 1 or 0 (bit `k` of `i` at level `k`).
    #[wasm_bindgen(getter, js_name = pathIsRight)]
    pub fn path_is_right(&self) -> Vec<u8> {
        self.path
            .iter()
            .map(|(is_right, _)| u8::from(*is_right))
            .collect()
    }

    /// The siblings of the Merkle path, from the leaf up, each 32 bytes, hex.
    #[wasm_bindgen(getter, js_name = pathSiblings)]
    pub fn path_siblings(&self) -> Vec<String> {
        self.path
            .iter()
            .map(|(_, sibling)| encode_hex(sibling))
            .collect()
    }

    /// The release proof's commitments `T1 … T7`, each a `Ge`: its `x ‖ y`, hex.
    #[wasm_bindgen(getter)]
    pub fn commitments(&self) -> Vec<String> {
        self.proof.t.iter().map(point_hex).collect()
    }

    /// The release proof's eleven responses, `z_C, z_ρ, z_c', z_x, z_y, z_e, z_w1, z_R, z_r₀,
    /// z_w2, z_τ`, each 32 bytes big-endian, hex.
    #[wasm_bindgen(getter)]
    pub fn responses(&self) -> Vec<String> {
        self.proof
            .z
            .iter()
            .map(|z| encode_hex(&z.to_be_bytes()))
            .collect()
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

    /// How to blind the successor loan, output `output_index`: the collateral of the next step,
    /// `ceil(d'·C/R)` with the blinders both parties derive. The PSET output carries the lender's
    /// blinding key.
    #[wasm_bindgen(js_name = successorBlinding)]
    pub fn successor_blinding(&self, output_index: u32) -> PinnedBlinding {
        Self::blinding(self.successor_collateral, output_index)
    }

    /// The installment: the amount under `A`, with the plan's random value blinder.
    #[wasm_bindgen(getter)]
    pub fn installment(&self) -> PinnedOutputInfo {
        PinnedOutputInfo::new(&self.payment)
    }

    /// The successor loan: the collateral of the next step, which `successorBlinding` blinds. A
    /// builder checks the blinded output 1 against its commitments.
    #[wasm_bindgen(getter)]
    pub fn successor(&self) -> PinnedOutputInfo {
        PinnedOutputInfo::new(&self.successor_collateral)
    }

    /// Carry `carry` of the installment: 0 for `W1`, output 3, of `e + 1` units, and 1 for `W2`,
    /// output 4, of `R − e`, both of the loan's carry token. `bad-input` for another.
    pub fn carry(&self, carry: u32) -> Result<PinnedOutputInfo, String> {
        Ok(PinnedOutputInfo::new(&self.carry_output(carry)?))
    }

    /// How to blind carry `carry` (see `carry`), output `output_index`: a random nonce, and the
    /// PSET output must carry the borrower's blinding key (`borrowerBlindingKey()`), with which
    /// the borrower rewinds it from the chain.
    #[wasm_bindgen(js_name = carryBlinding)]
    pub fn carry_blinding(&self, carry: u32, output_index: u32) -> Result<PinnedBlinding, String> {
        Ok(Self::blinding(self.carry_output(carry)?, output_index))
    }

    /// The collateral the installment releases to the borrower, `c_k − c_(k+1)`, which can be 0.
    #[wasm_bindgen(getter)]
    pub fn release(&self) -> u64 {
        self.release
    }

    /// The carry units the first installment burns beyond the `R + 1` its carries hold,
    /// `S − R − 1`: 0 from the second installment on.
    #[wasm_bindgen(getter)]
    pub fn leftover(&self) -> u64 {
        self.leftover.map_or(0, |burn| burn.amount)
    }

    /// The burn of the leftover: `leftover` units of the carry token, with random blinders drawn
    /// once for the plan, and the commitments the blinded output must have. `undefined` when
    /// nothing is left over.
    #[wasm_bindgen(getter, js_name = leftoverBurn)]
    pub fn leftover_burn(&self) -> Option<PinnedOutputInfo> {
        self.leftover.map(|burn| PinnedOutputInfo::new(&burn))
    }

    /// How to blind the burn of the leftover, output `output_index`: an `OP_RETURN` whose PSET
    /// output carries the borrower's blinding key, pinned to `leftoverBurn`, since Elements' own
    /// blinding refuses an `OP_RETURN`. `undefined` when nothing is left over.
    #[wasm_bindgen(js_name = leftoverBlinding)]
    pub fn leftover_blinding(&self, output_index: u32) -> Option<PinnedBlinding> {
        self.leftover.map(|burn| Self::blinding(burn, output_index))
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
    /// parameters and the offer's secrets, and the creation, the acceptance and the installment,
    /// hex.
    struct Fixture {
        value: serde_json::Value,
        borrower: LendingKey,
        lender: LendingKey,
        parameters: PrivateLendingParameters,
        secrets: OfferSecrets,
        creation: String,
        acceptance: String,
        installment: String,
    }

    impl Fixture {
        fn load() -> Fixture {
            let value = fixture();
            let creation = creation_hex(&value);
            let lender = key_of(&value, "lender_master_blinding_key");
            let (opened, parameters) = verify_offer_as_lender(
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
                secrets: opened.secrets,
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

        /// `(C, R)`.
        fn terms(&self) -> (u64, u64) {
            (
                self.parameters.pinned.active_collateral.amount,
                self.repayment().amount,
            )
        }

        /// The contract's collateral of `amount` at `step`: the test's oracle.
        fn collateral(&self, step: u32, amount: u64) -> PinnedOutput {
            self.parameters.loan_collateral(&self.secrets, step, amount)
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
        // a tampered pinned output's asset and amount, which `blind_pset` requires of the PSET
        for blinding in &blindings {
            let output = &mut pset.outputs_mut()[blinding.0.output_index];
            output.asset = Some(blinding.0.pinned.asset_id);
            output.amount = Some(blinding.0.pinned.amount);
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

    /// The loan's carries that `state` opens, as inputs: the creation's carry supply, or the
    /// outputs 3 and 4 of `previous`, the last installment.
    fn carry_inputs(
        f: &Fixture,
        state: &LoanState,
        previous: &Transaction,
    ) -> Vec<(OutPoint, TxOut, InputSecret)> {
        let creation = tx_of(&f.creation);
        state
            .carries()
            .unwrap()
            .iter()
            .map(|carry| {
                let tx = [&creation, previous]
                    .into_iter()
                    .find(|tx| carry.outpoint().starts_with(&tx.txid().to_string()))
                    .unwrap();
                let (outpoint, txout) = output_of(tx, &carry.outpoint());
                (outpoint, txout, carry.input_secret(0))
            })
            .collect()
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

    /// The blindings of a plan's pinned outputs in the installment layout: the successor (1),
    /// the installment (2), the carries (3 and 4) and the leftover burn, if any (6 when the
    /// installment releases collateral at 5, else 5).
    fn plan_blindings(plan: &InstallmentPlan) -> Vec<PinnedBlinding> {
        let burn_index = if plan.release() > 0 { 6 } else { 5 };
        [
            plan.successor_blinding(1),
            plan.installment_blinding(2),
            plan.carry_blinding(0, 3).unwrap(),
            plan.carry_blinding(1, 4).unwrap(),
        ]
        .into_iter()
        .chain(plan.leftover_blinding(burn_index))
        .collect()
    }

    /// An installment of `payment` built as the web builds it from `plan`, with `blindings` for
    /// its pinned outputs (see [`plan_blindings`]):
    /// - inputs 0 the borrower NFT, 1 the loan, 2 the principal coin, then the carries;
    /// - outputs 0 the borrower NFT to the receiver, 1 the successor loan at the contract's
    ///   script for the debt left, 2 the installment at the installment lock, blinded to
    ///   `installment_key`, 3 and 4 the carries, then the release, the leftover's burn, the
    ///   change and the fee.
    ///
    /// Returns what its proofs and balance verify to as well: a tampered blinding need not
    /// balance.
    fn installment_tx_with(
        f: &Fixture,
        from: &Paying,
        plan: &InstallmentPlan,
        payment: &PinnedOutput,
        blindings: Vec<PinnedBlinding>,
        installment_key: PublicKey,
    ) -> (Transaction, Result<(), VerificationError>) {
        let parameters = &f.parameters;
        let collateral = parameters.pinned.active_collateral;
        let left = from.owed.after(opening_of(payment)).unwrap();
        let successor = f.loan(
            left.commitment(&f.repayment()),
            from.state.installment_count() + 1,
        );
        let (loan, loan_txout) = output_of(from.previous, &from.state.loan_outpoint());
        let carry_lock = parameters
            .get_principal_output_asset_auth()
            .get_script_pubkey();
        let carries = [0, 1].map(|carry| plan.carry(carry).unwrap());
        let carry_asset: AssetId = carries[0].asset().parse().unwrap();

        let mut inputs = vec![
            coin(0x30, parameters.borrower_nft_asset_id, 1),
            (loan, loan_txout, from.state.loan_input_secret(1).unwrap()),
            coin_at(from.wallet, f.principal(), payment.amount + CHANGE + FEE),
        ];
        inputs.extend(carry_inputs(f, from.state, from.previous));
        let mut outputs = vec![
            explicit_output(from.receiver.clone(), parameters.borrower_nft_asset_id, 1),
            blinded_output(
                successor.get_script_pubkey(),
                collateral.asset_id,
                plan.successor().amount(),
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
        ];
        for carry in &carries {
            outputs.push(blinded_output(
                carry_lock.clone(),
                carry_asset,
                carry.amount(),
                f.borrower_blinding_key(),
            ));
        }
        if plan.release() > 0 {
            outputs.push(blinded_output(
                receiver(0x06),
                collateral.asset_id,
                plan.release(),
                f.borrower_blinding_key(),
            ));
        }
        if plan.leftover() > 0 {
            outputs.push(blinded_output(
                Script::new_op_return(b"burn"),
                carry_asset,
                plan.leftover(),
                f.borrower_blinding_key(),
            ));
        }
        outputs.extend([change_output(f.principal()), fee_output(f.principal())]);

        blind(inputs, outputs, blindings)
    }

    /// [`installment_tx_with`], which must balance.
    fn installment_tx(
        f: &Fixture,
        from: &Paying,
        plan: &InstallmentPlan,
        payment: &PinnedOutput,
        blindings: Vec<PinnedBlinding>,
        installment_key: PublicKey,
    ) -> Transaction {
        let (tx, verified) =
            installment_tx_with(f, from, plan, payment, blindings, installment_key);
        verified.unwrap();
        tx
    }

    /// The installment that `plan` gives, its installment blinded to `installment_key`.
    fn planned(
        f: &Fixture,
        from: &Paying,
        plan: &InstallmentPlan,
        installment_key: PublicKey,
    ) -> Transaction {
        installment_tx(
            f,
            from,
            plan,
            &plan.payment,
            plan_blindings(plan),
            installment_key,
        )
    }

    /// The full repayment of `owed` on the loan of `state`, whose output is in `previous`, with
    /// `blinding` for the repayment: inputs 0 the borrower NFT, 1 the loan, 2 a principal coin,
    /// then the carries; outputs 0 the NFT burn, 1 the repayment to the lender, 2 the collateral
    /// to the borrower, 3 the burn of the carries, then the change and the fee.
    fn full_repayment_tx(
        f: &Fixture,
        state: &LoanState,
        previous: &Transaction,
        owed: u64,
        blinding: PinnedBlinding,
    ) -> Transaction {
        let parameters = &f.parameters;
        let collateral = state.collateral().unwrap();
        let (loan, loan_txout) = output_of(previous, &state.loan_outpoint());
        let carries = state.carries().unwrap();
        let carry_asset: AssetId = carries[0].asset().parse().unwrap();
        let carried = carries.iter().map(Carry::amount).sum();
        let sweep = state.carry_sweep().unwrap();
        assert_eq!(sweep.burn().amount(), carried);

        let mut inputs = vec![
            coin(0x40, parameters.borrower_nft_asset_id, 1),
            (loan, loan_txout, state.loan_input_secret(1).unwrap()),
            coin(0x41, f.principal(), owed + CHANGE + FEE),
        ];
        inputs.extend(carry_inputs(f, state, previous));
        let repaid = balanced(
            inputs,
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
                    collateral.asset().parse().unwrap(),
                    collateral.amount(),
                    f.borrower_blinding_key(),
                ),
                blinded_output(
                    Script::new_op_return(b"burn"),
                    carry_asset,
                    carried,
                    f.borrower_blinding_key(),
                ),
                change_output(f.principal()),
                fee_output(f.principal()),
            ],
            vec![blinding, sweep.blinding(3)],
        );
        // the burn is blinded to the sweep's commitments, which the flow checks after blinding
        let burn = sweep.burn();
        assert_eq!(
            burn.asset_commitment(),
            encode_hex(&serialize(&repaid.output[3].asset))
        );
        assert_eq!(
            burn.value_commitment(),
            encode_hex(&serialize(&repaid.output[3].value))
        );
        repaid
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

    /// The 32 bytes that count up from `first`, as the parity fixture's blinders.
    fn counting_from(first: u8) -> [u8; 32] {
        std::array::from_fn(|i| first + i as u8)
    }

    #[test]
    fn the_fixture_loan_reads_the_same_for_both_parties() {
        let f = Fixture::load();
        let loan = &f.value["loan"];
        let installment = tx_of(&f.installment);
        let held = loan["collateral"][1].as_u64().unwrap();
        let collateral = f.collateral(1, held);
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
            // the loan output holds the contract's collateral of step 1, `ceil(d_1·C/R)`
            let read = state.collateral().unwrap();
            assert_eq!(read.amount(), held);
            assert_eq!(
                read.value_commitment(),
                encode_hex(&serialize(&collateral.value_commitment()))
            );
            assert_eq!(
                state.loan_input_secret(1).unwrap().secrets,
                collateral.secrets()
            );
        }

        // before any installment, the debt is the pinned repayment and the collateral the active
        // collateral
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
        assert_eq!(
            accepted.loan_input_secret(1).unwrap().secrets,
            f.parameters.pinned.active_collateral.secrets()
        );
        // and the first installment released what the fixture says
        assert_eq!(
            accepted.release_preview(f.first_amount()).unwrap(),
            loan["release"].as_u64().unwrap()
        );
    }

    #[test]
    fn the_borrower_opens_the_carries_from_the_chain() {
        let f = Fixture::load();
        let (collateral, full) = f.terms();
        let carry_asset = f.value["carry_asset_id"].as_str().unwrap();

        // before the first installment, the creation's explicit supply
        let accepted = f.as_borrower(&[]).unwrap();
        let carries = accepted.carries().unwrap();
        assert_eq!(carries.len(), 1);
        assert_eq!(
            carries[0].outpoint(),
            format!("{}:4", tx_of(&f.creation).txid())
        );
        assert_eq!(carries[0].asset(), carry_asset);
        assert_eq!(carries[0].amount(), private_lending_core::CARRY_SUPPLY);

        // after it, its outputs 3 and 4, of `e + 1` and `R − e` units
        let state = f.as_borrower(&[&f.installment]).unwrap();
        let e = carry_remainder(state.remaining().unwrap(), collateral, full);
        let carries = state.carries().unwrap();
        let txid = tx_of(&f.installment).txid();
        assert_eq!(
            carries.iter().map(Carry::outpoint).collect::<Vec<_>>(),
            [format!("{txid}:3"), format!("{txid}:4")]
        );
        assert_eq!(
            carries.iter().map(Carry::amount).collect::<Vec<_>>(),
            [e + 1, full - e]
        );
        assert!(carries.iter().all(|carry| carry.asset() == carry_asset));
        let installment = tx_of(&f.installment);
        for (carry, output) in carries.iter().zip(&installment.output[3..5]) {
            let secrets = carry.input_secret(0).secrets;
            let opened = PinnedOutput {
                asset_id: secrets.asset,
                amount: secrets.value,
                asset_blinding_factor: secrets.asset_bf,
                value_blinding_factor: secrets.value_bf,
            };
            assert!(opened.matches(output));
        }

        // the lender opens none
        for state in [
            f.as_lender(&[]).unwrap(),
            f.as_lender(&[&f.installment]).unwrap(),
        ] {
            assert_code(state.carries(), "bad-input", "borrower");
            assert_code(state.carry_sweep(), "bad-input", "borrower");
        }
    }

    #[test]
    fn the_plan_is_the_fixtures_witness() {
        let f = Fixture::load();
        let vector = &f.value["witness_vectors"]["installment"];
        let accepted = f.as_borrower(&[]).unwrap();
        // the fixture's installment of 3 000 at acceptance, with its fixed blinders
        let blinders = PlanBlinders {
            payment: ValueBlindingFactor::from_slice(&counting_from(0x50)).unwrap(),
            carries: [(0x10, 0x30), (0x20, 0x40)].map(|(asset, value)| {
                (
                    AssetBlindingFactor::from_slice(&counting_from(asset)).unwrap(),
                    ValueBlindingFactor::from_slice(&counting_from(value)).unwrap(),
                )
            }),
            burn: (
                AssetBlindingFactor::new(&mut thread_rng()),
                ValueBlindingFactor::new(&mut thread_rng()),
            ),
        };
        let plan = accepted
            .plan(
                3_000,
                &outpoint_string(&wallet(0x10)),
                &receiver(0x11).to_hex(),
                None,
                blinders,
            )
            .unwrap();

        // the plan's outputs 1 to 4 are the vector's, so its statement is the vector's
        let tx = tx_of(vector["tx"].as_str().unwrap());
        let pinned = [
            plan.successor_collateral,
            plan.payment,
            plan.carries[0],
            plan.carries[1],
        ];
        for (output, pinned) in tx.output[1..5].iter().zip(pinned) {
            assert!(pinned.matches(output));
        }
        // and its witness is the fixture's, which the contract's program ran
        assert_eq!(plan.debt_witness(), vector["debt"]);
        assert_eq!(u64::from(plan.index()), vector["index"].as_u64().unwrap());
        assert_eq!(plan.blinder_commitment(), vector["blinder_commitment"]);
        let path = vector["path"].as_array().unwrap();
        assert_eq!(
            plan.path_is_right(),
            path.iter()
                .map(|node| u8::from(node["is_right"].as_bool().unwrap()))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            plan.path_siblings(),
            path.iter()
                .map(|node| node["sibling"].as_str().unwrap())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            plan.commitments(),
            vector["commitments"].as_array().unwrap().clone()
        );
        assert_eq!(
            plan.responses(),
            vector["responses"].as_array().unwrap().clone()
        );

        // the first installment burns the supply's leftover, `S − R − 1`
        let (collateral, full) = f.terms();
        assert_eq!(
            plan.leftover(),
            private_lending_core::CARRY_SUPPLY - full - 1
        );
        let held = collateral_at(full - 3_000, collateral, full);
        assert_eq!(plan.release(), collateral - held);
        assert_eq!(plan.successor().amount(), held);
    }

    /// The fixture's release proof and the statement its vector's outputs give.
    fn fixture_release(f: &Fixture) -> (ReleaseStatement, ReleaseProof, [(bool, [u8; 32]); 10]) {
        let vector = &f.value["witness_vectors"]["installment"];
        let tx = tx_of(vector["tx"].as_str().unwrap());
        let point = |hex: &serde_json::Value| {
            let words: [u8; 64] = decode_hex_array(hex.as_str().unwrap()).unwrap();
            PublicKey::from_slice(&[&[0x04][..], &words].concat()).unwrap()
        };
        let scalar = |hex: &serde_json::Value| {
            Scalar::from_be_bytes(decode_hex_array(hex.as_str().unwrap()).unwrap()).unwrap()
        };
        let points = LoanPoints::of(&f.parameters.pinned).unwrap();
        let debt = f.repayment().value_commitment();
        let statement = ReleaseStatement {
            a: points.repayment_asset,
            a_c: points.collateral_asset,
            v_c0: points.collateral_value,
            d0: points.starting_debt,
            d_next: value_point(&debt_after(&debt, &tx.output[2].value).unwrap()).unwrap(),
            v_s: value_point(&tx.output[1].value).unwrap(),
            w1: value_point(&tx.output[3].value).unwrap(),
            a_w1: asset_point(&tx.output[3].asset).unwrap(),
            w2: value_point(&tx.output[4].value).unwrap(),
            a_w2: asset_point(&tx.output[4].asset).unwrap(),
            y: point(&vector["blinder_commitment"]),
        };
        let commitments = vector["commitments"].as_array().unwrap();
        let responses = vector["responses"].as_array().unwrap();
        let proof = ReleaseProof {
            t: std::array::from_fn(|m| point(&commitments[m])),
            z: std::array::from_fn(|m| scalar(&responses[m])),
        };
        let path = std::array::from_fn(|k| {
            let node = &vector["path"][k];
            (
                node["is_right"].as_bool().unwrap(),
                decode_hex_array(node["sibling"].as_str().unwrap()).unwrap(),
            )
        });

        (statement, proof, path)
    }

    #[test]
    fn the_gate_refuses_a_proof_that_does_not_verify() {
        let f = Fixture::load();
        let (statement, proof, path) = fixture_release(&f);
        let points = LoanPoints::of(&f.parameters.pinned).unwrap();
        let fs_iv = points.fs_iv();
        let root = f.parameters.blinder_root;
        assert_eq!(fs_iv, f.parameters.fs_iv());
        // `Y`'s leaf, by the local compression, is the core's leaf 0
        let tree = private_lending_core::BlinderTree::new(&f.secrets);
        assert_eq!(blinder_leaf(&statement.y), tree.leaf(0));
        let (x, y) = f.secrets.release_blinders(1);
        assert_eq!(blinder_commitment(&x, &y).unwrap(), statement.y);

        // the honest proof at step 0 passes
        assert_eq!(
            check_release(&statement, &proof, &fs_iv, &path, 0, &root),
            Ok(())
        );

        // a response flipped, a commitment of another proof, another FS_IV
        let mut flipped = proof;
        flipped.z[3] = Scalar::from_be_bytes({
            let mut bytes = flipped.z[3].to_be_bytes();
            bytes[31] ^= 1;
            bytes
        })
        .unwrap();
        let mut moved = proof;
        moved.t.swap(0, 1);
        let mut other_iv = fs_iv;
        other_iv[0] ^= 1;
        for (proof, fs_iv) in [(flipped, fs_iv), (moved, fs_iv), (proof, other_iv)] {
            assert_code(
                check_release(&statement, &proof, &fs_iv, &path, 0, &root),
                "proof-invalid",
                "does not verify",
            );
        }
        // the path at another step, or of another leaf, or to another root
        let mut other_root = root;
        other_root[0] ^= 1;
        assert_code(
            check_release(&statement, &proof, &fs_iv, &path, 1, &root),
            "proof-invalid",
            "leaf 1",
        );
        assert_code(
            check_release(&statement, &proof, &fs_iv, &tree.path(1), 0, &root),
            "proof-invalid",
            "leaf 0",
        );
        assert_code(
            check_release(&statement, &proof, &fs_iv, &path, 0, &other_root),
            "proof-invalid",
            "leaf 0",
        );
    }

    #[test]
    fn the_release_preview_is_the_cores_arithmetic() {
        let f = Fixture::load();
        let (collateral, full) = f.terms();
        // `ceil(a·b/c)` in u128, independently of the core
        let held = |debt: u64| {
            ((u128::from(debt) * u128::from(collateral)).div_ceil(u128::from(full))) as u64
        };
        for state in [
            f.as_borrower(&[]).unwrap(),
            f.as_borrower(&[&f.installment]).unwrap(),
            f.as_lender(&[&f.installment]).unwrap(),
        ] {
            let debt = state.remaining().unwrap();
            for amount in [1, 2, 7, debt / 3, debt - 1, debt] {
                assert_eq!(
                    state.release_preview(amount).unwrap(),
                    held(debt) - held(debt - amount),
                    "{amount} of {debt}"
                );
            }
            // the full repayment releases all that is left
            assert_eq!(
                state.release_preview(debt).unwrap(),
                state.collateral().unwrap().amount()
            );
            for amount in [0, debt + 1, u64::MAX] {
                assert_code(state.release_preview(amount), "bad-input", "");
            }
        }

        // the releases of a sequence of payments add up to the collateral
        let accepted = f.as_borrower(&[]).unwrap();
        let mut debt = full;
        let mut released = 0;
        for amount in [1_000, 3_333, 1, 2_500] {
            released += release_of(debt, amount, collateral, full);
            debt -= amount;
        }
        released += release_of(debt, debt, collateral, full);
        assert_eq!(released, collateral);
        assert_eq!(
            accepted.release_preview(full).unwrap(),
            collateral,
            "the whole repayment releases the whole collateral"
        );
    }

    #[test]
    fn borrower_rebuilds_its_plan_from_the_chain() {
        let f = Fixture::load();
        let (collateral, full) = f.terms();
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
        assert_eq!(plan.index(), 1);
        // from the second installment on, the carries balance: nothing is left over
        assert_eq!(plan.leftover(), 0);
        assert!(plan.leftover_burn().is_none());
        assert!(plan.leftover_blinding(5).is_none());
        assert_code(plan.carry(2), "bad-input", "2");
        assert_code(plan.carry_blinding(2, 5), "bad-input", "2");
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
        // the plan's successor holds the contract's collateral of step 2, `ceil(d_2·C/R)`, what
        // output 1 holds and what the next state reads, and the plan releases the difference
        let held = collateral_at(expected.amount, collateral, full);
        assert!(f.collateral(2, held).matches(&tx.output[1]));
        assert_eq!(plan.successor().amount(), held);
        assert_eq!(rebuilt.collateral().unwrap().amount(), held);
        assert_eq!(plan.release(), state.collateral().unwrap().amount() - held);
        assert_eq!(plan.release(), state.release_preview(2_000).unwrap());
        assert_eq!(
            plan.successor().value_commitment(),
            rebuilt.collateral().unwrap().value_commitment()
        );
        // the carries the borrower reads back are the plan's
        let e = carry_remainder(expected.amount, collateral, full);
        assert_eq!(
            rebuilt
                .carries()
                .unwrap()
                .iter()
                .map(Carry::amount)
                .collect::<Vec<_>>(),
            [e + 1, full - e]
        );
        assert_eq!(plan.carry(0).unwrap().amount(), e + 1);
        assert_eq!(plan.carry(1).unwrap().amount(), full - e);

        // the lender reads the same debt and collateral
        let as_lender = f.as_lender(&[&f.installment, &tx_hex(&tx)]).unwrap();
        assert_eq!(as_lender.remaining(), rebuilt.remaining());
        assert_eq!(as_lender.debt_hash(), rebuilt.debt_hash());
        assert_eq!(as_lender.collateral().unwrap().amount(), held);

        // the rebuilt opening closes the loan: the full repayment is the debt itself, which the
        // lender sweeps with both installments to receive the repayment amount; the carries burn
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
        assert!(repaid.output[3].script_pubkey.is_op_return());
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
    fn the_first_installment_burns_the_leftover() {
        let f = Fixture::load();
        let (_, full) = f.terms();
        let accepted = f.as_borrower(&[]).unwrap();
        let acceptance = tx_of(&f.acceptance);
        let from = Paying {
            state: &accepted,
            previous: &acceptance,
            owed: accepted.opening.unwrap(),
            wallet: wallet(0x72),
            receiver: receiver(0x73),
        };
        let plan = from.plan(1_000);
        let leftover = private_lending_core::CARRY_SUPPLY - full - 1;
        assert_eq!(plan.leftover(), leftover);
        let tx = planned(&f, &from, &plan, f.lender_blinding_key());

        // a confidential burn, blinded to the plan's commitments, which the borrower opens to the
        // leftover
        let burn = &tx.output[6];
        assert!(burn.script_pubkey.is_op_return());
        let pinned = plan.leftover_burn().unwrap();
        assert_eq!(pinned.amount(), leftover);
        assert_eq!(
            pinned.asset_commitment(),
            encode_hex(&serialize(&burn.asset))
        );
        assert_eq!(
            pinned.value_commitment(),
            encode_hex(&serialize(&burn.value))
        );
        let nonce = burn.nonce.commitment().unwrap();
        let shared_secret = OfferSecrets::for_lender(f.borrower.inner(), &nonce).shared_secret();
        let (secrets, _) = rewind(burn, shared_secret).unwrap();
        assert_eq!(secrets.value, leftover);
        assert_eq!(secrets.asset.to_string(), f.value["carry_asset_id"]);
        // and the state after it opens its carries
        let after = f.as_borrower(&[&tx_hex(&tx)]).unwrap();
        assert_eq!(
            after
                .carries()
                .unwrap()
                .iter()
                .map(Carry::amount)
                .sum::<u64>(),
            full + 1
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

        let state = f.as_borrower(&[&f.installment]).unwrap();
        let from = Paying {
            state: &state,
            previous: &tx_of(&f.installment),
            owed: state.opening.unwrap(),
            wallet: wallet(0x81),
            receiver: receiver(0x82),
        };
        let plan = from.plan(1_000);
        let held = plan.successor().amount();
        let tampered = |successor: PinnedOutput| {
            let mut blindings = plan_blindings(&plan);
            blindings[0] = pinned(1, successor, None);
            tx_hex(
                &installment_tx_with(
                    &f,
                    &from,
                    &plan,
                    &plan.payment,
                    blindings,
                    f.lender_blinding_key(),
                )
                .0,
            )
        };

        // the successor at the loan's next address with the collateral of another step: the
        // asset commitment of step 3 or 4, which neither party reads as step 2 (step 1's is the
        // loan input's, of which no surjection proof can be made)
        for step in [3, 4] {
            let other_step = tampered(f.collateral(step, held));
            for state in [
                f.as_borrower(&[&f.installment, &other_step]),
                f.as_lender(&[&f.installment, &other_step]),
            ] {
                assert_code(state, "loan-mismatch", "installment 2");
            }
        }
        // the successor of step 2 holding one unit more or less than `ceil(d_2·C/R)`: refused
        // by a party that knows the debt
        for amount in [held + 1, held - 1] {
            let other_amount = tampered(f.collateral(2, amount));
            for state in [
                f.as_borrower(&[&f.installment, &other_amount]),
                f.as_lender(&[&f.installment, &other_amount]),
            ] {
                assert_code(state, "loan-mismatch", "installment 2");
            }
        }

        // an installment that pays the principal under another asset blinder than `A`'s
        let not_a = PinnedOutput {
            asset_blinding_factor: AssetBlindingFactor::new(&mut thread_rng()),
            ..plan.payment
        };
        let mut blindings = plan_blindings(&plan);
        blindings[1] = pinned(2, not_a, None);
        let other_asset =
            installment_tx(&f, &from, &plan, &not_a, blindings, f.lender_blinding_key());
        assert_code(
            f.as_lender(&[&f.installment, &tx_hex(&other_asset)]),
            "loan-mismatch",
            "installment 2",
        );
    }

    #[test]
    fn loan_state_refuses_an_installment_of_the_whole_debt() {
        let f = Fixture::load();
        let state = f.as_borrower(&[&f.installment]).unwrap();
        let owed = state.opening.unwrap();
        let from = Paying {
            state: &state,
            previous: &tx_of(&f.installment),
            owed,
            wallet: wallet(0x83),
            receiver: receiver(0x84),
        };
        let plan = from.plan(1_000);
        // all that is owed, under another blinder than the debt's, which leaves the debt `k·G`:
        // the program alone would take it with a successor of one unit, which consensus refuses
        let payment = PinnedOutput {
            amount: owed.amount,
            value_blinding_factor: ValueBlindingFactor::new(&mut thread_rng()),
            ..f.repayment()
        };
        let loan = state.loan_outpoint().parse().unwrap();
        let ephemeral_sk =
            installment_ephemeral_key(f.borrower.inner(), loan, from.wallet, &from.receiver);
        let mut blindings = plan_blindings(&plan);
        blindings[0] = pinned(1, f.collateral(2, 1), None);
        blindings[1] = pinned(2, payment, Some(ephemeral_sk));
        let (whole, _) = installment_tx_with(
            &f,
            &from,
            &plan,
            &payment,
            blindings,
            f.lender_blinding_key(),
        );

        for state in [
            f.as_borrower(&[&f.installment, &tx_hex(&whole)]),
            f.as_lender(&[&f.installment, &tx_hex(&whole)]),
        ] {
            assert_code(state, "loan-mismatch", "whole debt");
        }
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
        // more installments than the tree has leaves, refused before they are read
        assert_code(
            open_creation_as_lender_hex(&f.lender, &f.creation)
                .unwrap()
                .loan_state(&f.lender, &f.acceptance, vec!["zz".to_string(); 1025]),
            "loan-mismatch",
            "1024",
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
    fn lender_without_openings_liquidates_by_the_search() {
        let f = Fixture::load();
        let (collateral, full) = f.terms();
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
        let left = from.owed.after(opening_of(&plan.payment)).unwrap();
        let debt = left.commitment(&f.repayment());
        let held = collateral_at(left.amount, collateral, full);

        let mut state = f.as_lender(&installments).unwrap();
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
        assert_code(state.release_preview(1), "bad-input", "unknown");

        // nor can the borrower rebuild its debt
        assert_eq!(f.as_borrower(&installments).unwrap().remaining(), None);

        // the collateral is unknown until the search finds it, from the chain and the offer's
        // secrets alone
        assert!(state.collateral().is_none());
        assert_code(state.loan_input_secret(0), "bad-input", "setCollateral");
        let search = state.collateral_search().unwrap();
        assert_eq!(search.max(), collateral);
        assert_eq!(
            search.value_commitment(),
            encode_hex(&serialize(&tx.output[1].value))
        );
        let found = find_collateral_hex(
            &search.value_commitment(),
            &search.asset_commitment(),
            &search.blinder(),
            search.max(),
        )
        .unwrap();
        assert_eq!(found, Some(held));
        for wrong in [0, held - 1, held + 1, collateral + 1] {
            assert_code(state.set_collateral(wrong), "bad-input", "does not open");
        }
        assert!(state.collateral().is_none());
        state.set_collateral(held).unwrap();
        let opened = f.collateral(2, held);
        assert!(opened.matches(&tx.output[1]));
        assert_eq!(
            state.loan_input_secret(0).unwrap().secrets,
            opened.secrets()
        );
        assert_eq!(state.collateral().unwrap().amount(), held);
        // `collateralOpening` gives the same blinders
        let opening = collateral_opening_hex(
            2,
            held,
            &f.parameters
                .pinned
                .active_collateral
                .asset_blinding_factor
                .to_string(),
            &search.blinder(),
        )
        .unwrap();
        assert_eq!(
            opening.asset_blinder(),
            opened.asset_blinding_factor.to_string()
        );
        assert_eq!(
            opening.value_blinder(),
            opened.value_blinding_factor.to_string()
        );

        // a liquidation sweeps the installments that open
        let outpoints = [1, 2].map(|j| state.installment(j).unwrap().outpoint());
        let sweep = state.sweep(None, outpoints.to_vec()).unwrap();
        assert_eq!(sweep.outpoints(), [outpoints[0].clone()]);
        assert_eq!(sweep.amount(), f.first_amount());
        // and needs no opening of the installments it leaves out
        let sweep = state.sweep(None, vec![outpoints[0].clone()]).unwrap();
        assert_eq!(sweep.outpoints(), [outpoints[0].clone()]);

        // before the first installment, the loan holds the active collateral
        let mut accepted = f.as_lender(&[]).unwrap();
        assert_code(
            accepted.collateral_search(),
            "bad-input",
            "active collateral",
        );
        assert_code(accepted.set_collateral(collateral), "bad-input", "active");
    }

    #[test]
    fn the_search_finds_collateral_at_2_to_the_24() {
        let f = Fixture::load();
        let active = f.parameters.pinned.active_collateral;
        let asset = encode_hex(&serialize(&active.asset_commitment()));
        let max = 1 << 24;
        // the collateral of `amount` at step 5, as an installment pins it
        let at_step = |amount: u64| {
            let (x, _) = f.secrets.release_blinders(5);
            let (asset_blinding_factor, value_blinding_factor) =
                collateral_opening(5, amount, &active.asset_blinding_factor, &x);
            let pinned = PinnedOutput {
                amount,
                asset_blinding_factor,
                value_blinding_factor,
                ..active
            };
            (
                encode_hex(&serialize(&pinned.value_commitment())),
                encode_hex(&x.secret_bytes()),
            )
        };

        for amount in [1, 2, 12_345, max - 1, max] {
            let (value, blinder) = at_step(amount);
            assert_eq!(
                find_collateral_hex(&value, &asset, &blinder, max).unwrap(),
                Some(amount),
                "{amount}"
            );
        }
        // nothing in `[1, max]` opens an amount above it
        let (value, blinder) = at_step(max + 1);
        assert_eq!(
            find_collateral_hex(&value, &asset, &blinder, max).unwrap(),
            None
        );

        // malformed input and bounds outside `[1, 2^44]` are refused, not a panic
        let (value, blinder) = at_step(7);
        for bound in [0, (1 << 44) + 1, u64::MAX] {
            assert_code(
                find_collateral_hex(&value, &asset, &blinder, bound),
                "bad-input",
                "bound",
            );
        }
        for (value, asset, blinder) in [
            ("zz", asset.as_str(), blinder.as_str()),
            (asset.as_str(), asset.as_str(), blinder.as_str()),
            (value.as_str(), value.as_str(), blinder.as_str()),
            (value.as_str(), asset.as_str(), "00"),
            (value.as_str(), asset.as_str(), &"00".repeat(32)),
        ] {
            assert_code(
                find_collateral_hex(value, asset, blinder, max),
                "bad-input",
                "",
            );
        }
        let asset_blinder = active.asset_blinding_factor.to_string();
        for step in [0, 1025] {
            assert_code(
                collateral_opening_hex(step, 7, &asset_blinder, &blinder),
                "bad-input",
                "1024",
            );
        }
        assert_code(
            collateral_opening_hex(1, 7, "zz", &blinder),
            "bad-input",
            "",
        );
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
    fn plan_refuses_the_step_after_the_last() {
        let f = Fixture::load();
        let mut state = f.as_borrower(&[&f.installment]).unwrap();
        let (wallet, receiver) = (outpoint_string(&wallet(0xb2)), receiver(0xb3).to_hex());
        assert!(state.plan_installment(1, &wallet, &receiver, None).is_ok());
        // a loan at step 1024, which the tree has no leaf after: only the full repayment is left
        while state.installment_count() < MAX_STEPS {
            state.installments.push(Installment {
                outpoint: OutPoint::default(),
                opening: None,
                message: Ok(None),
            });
        }
        assert_code(
            state.plan_installment(1, &wallet, &receiver, None),
            "bad-input",
            "1024",
        );
        assert!(state.release_preview(1).is_ok());
    }

    #[test]
    fn the_plan_refuses_what_does_not_prove_or_open_the_debt() {
        let f = Fixture::load();
        let (wallet, receiver) = (outpoint_string(&wallet(0xb4)), receiver(0xb5).to_hex());

        // the tree of another offer's secrets: `Y` is not a leaf of it, so the plan's own gate
        // refuses the plan
        let mut state = f.as_borrower(&[&f.installment]).unwrap();
        assert!(state.plan_installment(1, &wallet, &receiver, None).is_ok());
        let other = f.secrets.release_blinders(7).0;
        state.tree = SharedTree::default();
        assert!(
            state
                .tree
                .set(private_lending_core::BlinderTree::new(
                    &OfferSecrets::for_borrower(&other, &f.lender.inner().x_only_public_key())
                ))
                .is_ok()
        );
        assert_code(
            state.plan_installment(1, &wallet, &receiver, None),
            "proof-invalid",
            "leaf 1",
        );

        // an opening one unit off the debt the loan holds
        let mut state = f.as_borrower(&[&f.installment]).unwrap();
        let owed = state.opening.unwrap();
        state.opening = Some(DebtOpening {
            amount: owed.amount + 1,
            ..owed
        });
        assert_code(
            state.plan_installment(1, &wallet, &receiver, None),
            "bad-input",
            "opening is not the loan's",
        );
    }

    #[test]
    fn sweep_balances() {
        let f = Fixture::load();
        let (collateral, full) = f.terms();
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
        let mut after_unopened = f.as_borrower(&installments).unwrap();
        // the borrower cannot open it either, so the test sets the collateral it knows
        after_unopened
            .set_collateral(collateral_at(owed.amount, collateral, full))
            .unwrap();

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

        // the close must spend the loan and repay the debt, and the swept outputs must be the
        // loan's installments
        assert_code(
            state.sweep(Some(f.installment.clone()), vec![unclaimed.clone()]),
            "loan-mismatch",
            "close",
        );
        let mut not_repaid = repaid.clone();
        not_repaid.output[1].value = first.output[2].value;
        assert_code(
            state.sweep(Some(tx_hex(&not_repaid)), vec![unclaimed.clone()]),
            "loan-mismatch",
            "does not repay",
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

        // after a liquidation, the installments that open, each with its own opening
        let all = [1, 2].map(|j| state.installment(j).unwrap().outpoint());
        let sweep = state.sweep(None, all.to_vec()).unwrap();
        assert_eq!(sweep.outpoints(), [all[0].clone()]);
        assert_eq!(sweep.amount(), f.first_amount());
        assert_eq!(
            final_claim(&f, swept(&sweep, &[&first]), sweep.amount()),
            Ok(())
        );
    }

    #[test]
    fn carries_that_are_not_the_loans_are_refused() {
        let f = Fixture::load();
        let (collateral, full) = f.terms();
        let state = f.as_borrower(&[&f.installment]).unwrap();
        let from = Paying {
            state: &state,
            previous: &tx_of(&f.installment),
            owed: state.opening.unwrap(),
            wallet: wallet(0xc4),
            receiver: receiver(0xc5),
        };
        let plan = from.plan(1_500);
        let left = from.owed.after(opening_of(&plan.payment)).unwrap();
        let e = carry_remainder(left.amount, collateral, full);
        let with_carries = |carries: [PinnedOutput; 2]| {
            let mut blindings = plan_blindings(&plan);
            blindings[2] = pinned(3, carries[0], None);
            blindings[3] = pinned(4, carries[1], None);
            let (tx, _) = installment_tx_with(
                &f,
                &from,
                &plan,
                &plan.payment,
                blindings,
                f.lender_blinding_key(),
            );
            tx_hex(&tx)
        };
        let [w1, w2] = plan.carries;

        // the honest carries read, and the debt reads either way
        let honest = with_carries([w1, w2]);
        assert!(
            f.as_borrower(&[&f.installment, &honest])
                .unwrap()
                .carries()
                .is_ok()
        );
        // split as `(e + 2, R − e − 1)`, which sums to `R + 1` but is not the remainder
        let split = with_carries([w1.with_amount(e + 2), w2.with_amount(full - e - 1)]);
        let after = f.as_borrower(&[&f.installment, &split]).unwrap();
        assert_code(after.carries(), "loan-mismatch", "remainder");
        assert_code(after.carry_sweep(), "loan-mismatch", "remainder");
        // of another asset
        let other_asset = PinnedOutput {
            asset_id: f.principal(),
            ..w1
        };
        let foreign = with_carries([other_asset, w2]);
        let after = f.as_borrower(&[&f.installment, &foreign]).unwrap();
        assert_code(after.carries(), "loan-mismatch", "carry token");
        assert_code(
            after.plan_installment(
                1,
                &outpoint_string(&wallet(0xc6)),
                &receiver(0xc7).to_hex(),
                None,
            ),
            "loan-mismatch",
            "carry token",
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
        for amount in [0, 1] {
            assert_code(
                state.plan_installment(amount, &wallet, &receiver, None),
                "bad-input",
                "",
            );
            assert_code(state.release_preview(amount), "bad-input", "");
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

    /// A second installment of 2 000 built from a plan, whose range proof carries `extra_data`,
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
        let plan = from.plan(2_000);
        let loan = state.loan_outpoint().parse().unwrap();
        let ephemeral_sk =
            installment_ephemeral_key(f.borrower.inner(), loan, from.wallet, &from.receiver);
        let mut blindings = plan_blindings(&plan);
        blindings[1] = PinnedBlinding::from_core(CorePinnedBlinding {
            output_index: 2,
            pinned: plan.payment,
            ephemeral_sk: Some(ephemeral_sk),
            extra_data,
        });

        installment_tx(
            f,
            &from,
            &plan,
            &plan.payment,
            blindings,
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
