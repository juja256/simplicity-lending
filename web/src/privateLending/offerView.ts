// Display and gating rules of the private offers, shared by the lender console, the borrower's
// loans and their modals. The indexer's candidate (status, UTXOs) is untrusted: it only decides
// what to show and which action to offer. Every action loads its offer fresh through the gate, and
// its builder checks every outpoint it is given. The rules that read outpoints from the candidate
// are in `./candidate`.
import type { ReactNode } from 'react'

import type {
  PrivateCandidateDetails,
  PrivateOfferStatus,
  PrivateUtxoType,
} from '@/api/indexer/private'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { repaymentBorrowerNftOutpoint, unspentUtxo, utxoOutpoint } from '@/privateLending/candidate'
import type { LoanFigures } from '@/privateLending/hooks/useLoan'
import type { PrivateOfferItem, PrivateOfferTerms } from '@/privateLending/hooks/usePrivateOffers'
import { proposalExpiryIsStale } from '@/privateLending/lenderTerms'
import { installmentTermOpen } from '@/privateLending/repayPlan'
import type {
  CreationTerm,
  PrivateTxKind,
  PrivateTxRecord,
} from '@/providers/pendingTransactions/types'
import { formatBlockSpan, formatTermLeft } from '@/utils/format'

/** A key fingerprint in groups of four characters: `1aa0 5299 d34b b9f5`. */
export function groupFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint
}

/** A verified offer whose terms are open and that the indexer still lists. */
export type OpenedOfferItem = PrivateOfferItem & {
  result: 'verified'
  terms: PrivateOfferTerms
  candidate: PrivateCandidateDetails
}

/**
 * Whether an item can be acted on at all: verified in a past sync, its terms open, the indexer
 * listing it, and with the network's assets. Invalid offers never are.
 */
export function isOpenedOffer(item: PrivateOfferItem): item is OpenedOfferItem {
  return (
    item.result === 'verified' &&
    item.terms !== null &&
    item.candidate !== null &&
    usesConfiguredAssets(item.terms)
  )
}

/**
 * Why an offer gets no action whatever its status: it failed verification, its terms could not be
 * opened again, the indexer no longer lists it, or it uses assets this app does not support. Null
 * exactly when `isOpenedOffer` holds.
 */
export function blockedNote(item: PrivateOfferItem): string | null {
  if (item.result === 'invalid') return 'It failed verification: no action is possible.'
  if (item.terms === null) return 'Its terms could not be opened; retried on the next sync.'
  if (item.candidate === null) return 'The indexer no longer lists this proposal.'
  if (!usesConfiguredAssets(item.terms)) return 'It uses assets this app does not support.'
  return null
}

/** Whether the offer uses the network's collateral and principal assets, the only ones shown. */
export function usesConfiguredAssets(terms: PrivateOfferTerms): boolean {
  return (
    terms.collateralAsset === NETWORK_CONFIG.collateralAsset.id &&
    terms.principalAsset === NETWORK_CONFIG.principalAsset.id
  )
}

/** The other side of the offer, as the session sees it: the borrower in the lender's inbox. */
export interface Counterparty {
  role: 'borrower' | 'lender'
  publicKey: string
  fingerprint: string
}

export function counterpartyOf(item: OpenedOfferItem): Counterparty
export function counterpartyOf(item: PrivateOfferItem): Counterparty | null
export function counterpartyOf(item: PrivateOfferItem): Counterparty | null {
  if (item.terms === null) return null
  return item.role === 'lender'
    ? {
        role: 'borrower',
        publicKey: item.terms.borrowerPublicKey,
        fingerprint: item.terms.borrowerFingerprint,
      }
    : {
        role: 'lender',
        publicKey: item.terms.lenderPublicKey,
        fingerprint: item.terms.lenderFingerprint,
      }
}

/** What each tracked UTXO is, for messages that both areas show. */
export const PRIVATE_UTXO_LABEL: Record<PrivateUtxoType, string> = {
  pending_offer: 'proposal',
  active_offer: 'loan',
  principal: 'principal',
  repayment: 'repayment',
  installment: 'installment',
}

/** The status an offer shows: the indexer's status, or `claimed` once the final claim ran. */
export type OfferStatus = PrivateOfferStatus | 'claimed'

/**
 * The status to show for a candidate. A repaid offer shows as claimed once nothing of it is left
 * for the lender: no repayment and no installment unspent. The full repayment leaves a repayment
 * UTXO, and the zero-debt close none, so after the close only the installments count.
 */
export function displayStatus(candidate: PrivateCandidateDetails): OfferStatus {
  if (candidate.status !== 'repaid') return candidate.status
  const unclaimed = candidate.utxos.some(
    utxo =>
      (utxo.utxo_type === 'repayment' || utxo.utxo_type === 'installment') &&
      utxo.spent_txid === null,
  )
  return unclaimed ? 'repaid' : 'claimed'
}

/**
 * The installments the lender can claim now, from the indexer's view (untrusted: the claim's
 * builder checks each one): those listed unspent whose amount `loan` opened, with that amount.
 */
export function claimableInstallments(
  candidate: PrivateCandidateDetails,
  loan: LoanFigures | undefined,
): { outpoint: string; amount: bigint }[] {
  if (loan === undefined) return []
  const amounts = new Map(loan.installments.map(({ outpoint, amount }) => [outpoint, amount]))
  return candidate.utxos
    .filter(utxo => utxo.utxo_type === 'installment' && utxo.spent_txid === null)
    .flatMap(utxo => {
      const amount = amounts.get(utxoOutpoint(utxo))
      return amount === undefined ? [] : [{ outpoint: utxoOutpoint(utxo), amount }]
    })
}

/** Whether the tip is known and past the loan expiry. */
export function isPastExpiry(terms: PrivateOfferTerms, tipHeight: number): boolean {
  return tipHeight > 0 && tipHeight > terms.loanExpirationTime
}

/**
 * Whether a pending offer can still be accepted at `tipHeight`: the tip known (not 0) and below
 * the expiry, so an acceptance mined in the next block is not past it. The acceptance sets no lock
 * time and the covenant does not check the expiry: this rule is the only guard.
 */
export function canStillAccept(terms: PrivateOfferTerms, tipHeight: number): boolean {
  return tipHeight > 0 && tipHeight < terms.loanExpirationTime
}

export const TIP_UNKNOWN_NOTE = 'Waiting for the chain tip.'
export const TERM_PASSED_NOTE = 'Its term has passed.'

/**
 * Throws a message for the lender unless `canStillAccept`: before an acceptance is built, and
 * again before it is broadcast, with the tip read at that moment.
 */
export function checkStillAcceptable(terms: PrivateOfferTerms, tipHeight: number): void {
  if (!(tipHeight > 0)) {
    throw new Error("The chain tip is not known, so the proposal's term cannot be checked.")
  }
  if (!canStillAccept(terms, tipHeight)) throw new Error(TERM_PASSED_NOTE)
}

/**
 * The expiry block, with the term left while the offer is pending or active and the tip is known
 * (0 while unknown): `#2685018 (~3h)`.
 */
export function expiryLabel(
  loanExpirationTime: number,
  status: OfferStatus | null,
  tipHeight: number,
): string {
  const isLive = status === 'pending' || status === 'active'
  return isLive && tipHeight > 0
    ? `#${loanExpirationTime} (${formatTermLeft(loanExpirationTime - tipHeight)})`
    : `#${loanExpirationTime}`
}

/**
 * A transaction this browser made for an offer that the indexer may not show yet:
 * - `unsent`: saved, but no broadcast was accepted. Offer to broadcast it again (never rebuild
 *   it while it may still be broadcast), or to discard it.
 * - `processing`: broadcast and not yet final. Offer no new action meanwhile.
 */
export interface OfferTxState<K extends PrivateTxKind = PrivateTxKind> {
  state: 'unsent' | 'processing'
  record: PrivateTxRecord & { kind: K }
}

/** The state of the latest transaction of one of `kinds` this browser made for the offer. */
export function offerTxState<K extends PrivateTxKind>(
  privateTxs: PrivateTxRecord[],
  offerTxid: string,
  kinds: readonly K[],
): OfferTxState<K> | null {
  const records = privateTxs
    .filter(
      (record): record is PrivateTxRecord & { kind: K } =>
        record.offerTxid === offerTxid &&
        record.discardedAt === undefined &&
        (kinds as readonly PrivateTxKind[]).includes(record.kind),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
  const unsent = records.find(record => record.broadcastStatus === 'built')
  if (unsent) return { state: 'unsent', record: unsent }
  const processing = records.find(
    record =>
      record.confirmationStatus === 'processing' || record.confirmationStatus === 'confirmed',
  )
  return processing ? { state: 'processing', record: processing } : null
}

/** What the session may do with an opened offer, from the indexer's view of it (untrusted). */
export interface OfferView<A extends string> {
  action?: A
  note?: ReactNode
}

/** One side's actions on its offers. */
export interface OfferActions<A extends string, K extends PrivateTxKind> {
  labels: Record<A, string>
  /** The action shown as a danger button. */
  danger: A
  /** The action of each transaction kind: its modal broadcasts a saved one again. */
  actionOfKind: Record<K, A>
}

/**
 * The button an offer gets: its action on `item` (`open`), with the saved transaction to send
 * again; or `discard`, which drops a saved transaction that can no longer be sent.
 */
export type OfferActionButton<A extends string> =
  | {
      kind: 'open'
      action: A
      item: OpenedOfferItem
      unsentTx?: PrivateTxRecord
      label: string
      variant: 'primary' | 'secondary' | 'danger-soft'
    }
  | { kind: 'discard'; record: PrivateTxRecord; label: string; variant: 'secondary' }

/**
 * Whether a saved transaction may still be broadcast: `expired` once it no longer may, `unknown`
 * while that cannot be told (the tip not known yet).
 */
export type Sendable = 'yes' | 'expired' | 'unknown'

/** An offer's action and note, as both sides show them. */
export interface OfferActionState<A extends string> {
  note: ReactNode
  /** A transaction of this browser for the offer waits for its confirmation. */
  isProcessing: boolean
  button: OfferActionButton<A> | null
}

/**
 * An offer's action, by the same rules on both sides. This browser's own transaction for the
 * offer, which the indexer may not show yet, comes first:
 * - one saved but not broadcast gets only "Broadcast again", which opens its action's modal on the
 *   saved transaction: a retry never rebuilds, and no new build is offered meanwhile. When
 *   `sendable` says it can no longer be sent, it gets only "Discard"; while that cannot be told,
 *   nothing;
 * - one broadcast and not yet final gets no action until it is.
 *
 * Otherwise the offer gets the side's `viewOf` when it can be acted on at all, and only the note
 * why when it cannot (`blockedNote`).
 */
export function offerActionState<A extends string, K extends PrivateTxKind>(
  privateTxs: PrivateTxRecord[],
  item: PrivateOfferItem,
  actions: OfferActions<A, K>,
  viewOf: (item: OpenedOfferItem) => OfferView<A>,
  sendable: (record: PrivateTxRecord, item: OpenedOfferItem) => Sendable = () => 'yes',
): OfferActionState<A> {
  const kinds = Object.keys(actions.actionOfKind) as K[]
  const txState = offerTxState(privateTxs, item.txid, kinds)
  const opened = isOpenedOffer(item) ? item : null
  if (txState?.state === 'unsent') {
    const { record } = txState
    const unsent = 'Your transaction was signed but not broadcast'
    switch (opened ? sendable(record, opened) : 'yes') {
      case 'unknown':
        return { note: `${unsent}. ${TIP_UNKNOWN_NOTE}`, isProcessing: false, button: null }
      case 'expired':
        return {
          note: `${unsent}, and it can no longer be sent: ${TERM_PASSED_NOTE.toLowerCase()}`,
          isProcessing: false,
          button: { kind: 'discard', record, label: 'Discard', variant: 'secondary' },
        }
      case 'yes':
        return {
          note: `${unsent}.`,
          isProcessing: false,
          button: opened && {
            kind: 'open',
            action: actions.actionOfKind[record.kind],
            item: opened,
            unsentTx: record,
            label: 'Broadcast again',
            variant: 'secondary',
          },
        }
    }
  }
  if (txState?.state === 'processing') {
    return {
      note: 'Your transaction waits for its confirmation.',
      isProcessing: true,
      button: null,
    }
  }
  const view: OfferView<A> = opened ? viewOf(opened) : { note: blockedNote(item) }
  const action = view.action
  return {
    note: view.note,
    isProcessing: false,
    button:
      opened && action !== undefined
        ? {
            kind: 'open',
            action,
            item: opened,
            label: actions.labels[action],
            variant: action === actions.danger ? 'danger-soft' : 'primary',
          }
        : null,
  }
}

export type LenderAction = 'accept' | 'claimInstallments' | 'claimRepayment' | 'liquidate'

/**
 * The names of the lender's actions in the console, where "Review" opens the acceptance, "Claim"
 * claims installments and "Claim repayment" is the final claim. Each page tracks only the
 * transactions of the actions it shows (`OfferActions.actionOfKind`).
 */
export const LENDER_ACTION_LABELS: Record<LenderAction, string> = {
  accept: 'Review',
  claimInstallments: 'Claim',
  claimRepayment: 'Claim repayment',
  liquidate: 'Liquidate',
}

/**
 * What the lender can do with an offer, from the indexer's view of it and `loan`, its figures once
 * read (untrusted: the action's builder checks every outpoint). One action at a time:
 * - accept a pending offer while `canStillAccept` (nothing while the tip is unknown);
 * - liquidate an active loan once the tip is past its expiry, which also sweeps the installments
 *   that open;
 * - before that, claim the installments listed unspent that open (`claimableInstallments`);
 * - once the loan closed, by the full repayment or the zero-debt close, claim the repayment: the
 *   final claim, which sweeps every unclaimed installment, until nothing is left (`claimed`).
 */
export function lenderView(
  item: OpenedOfferItem,
  tipHeight: number,
  loan?: LoanFigures,
): OfferView<LenderAction> {
  const { candidate, terms } = item
  const expired = isPastExpiry(terms, tipHeight)
  switch (candidate.status) {
    case 'pending':
      if (tipHeight === 0) return { note: TIP_UNKNOWN_NOTE }
      return canStillAccept(terms, tipHeight) ? { action: 'accept' } : { note: TERM_PASSED_NOTE }
    case 'active':
      if (unspentUtxo(candidate, 'active_offer') === undefined) return {}
      if (expired) return { action: 'liquidate', note: 'The loan has expired unpaid.' }
      if (claimableInstallments(candidate, loan).length > 0) {
        return { action: 'claimInstallments', note: 'The borrower paid an installment.' }
      }
      return { note: `Liquidation opens after block #${terms.loanExpirationTime}.` }
    case 'repaid':
      return displayStatus(candidate) === 'repaid'
        ? { action: 'claimRepayment', note: 'The borrower repaid the loan.' }
        : {}
    default:
      return {}
  }
}

/**
 * Whether the lender's saved transaction may still be broadcast at `tipHeight`: an acceptance
 * only while `canStillAccept`, and not while the tip is unknown; the other kinds always.
 */
export function lenderSendable(
  tipHeight: number,
): (record: PrivateTxRecord, item: OpenedOfferItem) => Sendable {
  return (record, item) => {
    if (record.kind !== 'private_accept_offer') return 'yes'
    if (tipHeight === 0) return 'unknown'
    return canStillAccept(item.terms, tipHeight) ? 'yes' : 'expired'
  }
}

/** Why a saved creation can no longer be sent: the chain moved on while it waited. */
export const STALE_CREATION_NOTE =
  'The chain moved on since it was signed: sent now, it would run fewer days than you chose.'
/** Why a saved creation without its term cannot be sent. */
export const UNCHECKED_CREATION_NOTE =
  'It was saved without its term, so it cannot be checked before it is sent.'

/**
 * Whether the borrower's saved creation may be broadcast at `tipHeight`, by the rule the build
 * applies (`proposalExpiryIsStale`): `expired` once a confirmation in the next block would count
 * fewer days than the borrower chose, as the lender could then refuse it, or once its term passed,
 * when the lender can never accept it. A creation saved without its term cannot be checked, so it
 * is `expired` too; `unknown` while the tip is not known.
 */
export function creationSendable(term: CreationTerm | undefined, tipHeight: number): Sendable {
  if (!(tipHeight > 0)) return 'unknown'
  if (term === undefined) return 'expired'
  return proposalExpiryIsStale(term.loanExpirationTime, tipHeight, term.termDays)
    ? 'expired'
    : 'yes'
}

/** Why a saved creation that `creationSendable` finds `expired` cannot be sent. */
export function creationExpiredNote(term: CreationTerm | undefined): string {
  return term === undefined ? UNCHECKED_CREATION_NOTE : STALE_CREATION_NOTE
}

/**
 * Throws a plain message for the borrower unless `creationSendable` says `yes`: before a creation
 * is first broadcast, and again before every retry, with the tip read at that moment.
 */
export function checkCreationSendable(term: CreationTerm | undefined, tipHeight: number): void {
  switch (creationSendable(term, tipHeight)) {
    case 'unknown':
      throw new Error("The chain tip is not known, so the proposal's term cannot be checked.")
    case 'expired':
      throw new Error(`Not sent. ${creationExpiredNote(term)} Discard it and propose again.`)
    case 'yes':
      return
  }
}

export type BorrowerAction = 'cancel' | 'claimPrincipal' | 'repay' | 'closeZeroDebt'

type BorrowerTxKind =
  | 'private_cancel_offer'
  | 'private_claim_principal'
  | 'private_installment'
  | 'private_repay_offer'
  | 'private_zero_debt_close'

/**
 * The borrower's actions on one loan, each named with what it moves: "Cancel", "Receive 20,000
 * TEST", "Repay 3,021.40 TEST", "Close the loan". `amounts` are the loan's principal and what it
 * still owes as the page writes them, or null when its terms are not open (it then gets no action
 * anyway). An installment and the full repayment share the repay form, and so its action.
 */
export function borrowerActions(
  amounts: { receive: string; repay: string } | null,
): OfferActions<BorrowerAction, BorrowerTxKind> {
  return {
    labels: {
      cancel: 'Cancel',
      claimPrincipal: amounts ? `Receive ${amounts.receive}` : 'Receive',
      repay: amounts ? `Repay ${amounts.repay}` : 'Repay',
      closeZeroDebt: 'Close the loan',
    },
    danger: 'cancel',
    actionOfKind: {
      private_cancel_offer: 'cancel',
      private_claim_principal: 'claimPrincipal',
      private_installment: 'repay',
      private_repay_offer: 'repay',
      private_zero_debt_close: 'closeZeroDebt',
    },
  }
}

/**
 * Whether the borrower's saved transaction may still be broadcast at `tipHeight`: an installment
 * only while `installmentTermOpen`, as the repay form pays one (`unknown` while the tip is not
 * known); the other kinds always, the full repayment past the term too.
 */
export function borrowerSendable(
  tipHeight: number,
): (record: PrivateTxRecord, item: OpenedOfferItem) => Sendable {
  return (record, item) => {
    if (record.kind !== 'private_installment') return 'yes'
    if (tipHeight === 0) return 'unknown'
    return installmentTermOpen(tipHeight, item.terms.loanExpirationTime) ? 'yes' : 'expired'
  }
}

/**
 * What the borrower can do with its loan, from the indexer's view of it and `loan`, its figures
 * once read (untrusted: the action's builder checks every outpoint): cancel a pending proposal,
 * receive the principal while it is unspent, then repay an active loan, in installments or in
 * full, or close it once its installments paid the whole debt. Repaying burns the borrower NFT,
 * the only key to an unclaimed principal, so it is offered only on positive evidence that the
 * principal was claimed (`repaymentBorrowerNftOutpoint`): a candidate that omits the principal gets
 * no Repay. The notes are in the borrower's words: no "offer", "NFT" or "lending key".
 */
export function borrowerView(
  item: OpenedOfferItem,
  tipHeight: number,
  loan?: LoanFigures,
): OfferView<BorrowerAction> {
  const { candidate, terms } = item
  const principalUnclaimed = unspentUtxo(candidate, 'principal') !== undefined
  switch (candidate.status) {
    case 'pending':
      if (unspentUtxo(candidate, 'pending_offer') === undefined) return {}
      return {
        action: 'cancel',
        note:
          tipHeight === 0 || canStillAccept(terms, tipHeight)
            ? 'You can cancel until the lender accepts.'
            : 'Its term has passed. Cancel it to take your collateral back.',
      }
    case 'active':
      if (principalUnclaimed) return { action: 'claimPrincipal' }
      if (unspentUtxo(candidate, 'active_offer') === undefined) return {}
      if (repaymentBorrowerNftOutpoint(item.txid, candidate) === undefined) {
        return {
          note: 'The indexer lists no receipt of your principal, so the loan cannot be repaid yet.',
        }
      }
      if (loan !== undefined && loan.remaining === undefined) {
        return {
          note:
            'A payment on this loan does not open with your key, so what it still owes is ' +
            'unknown and the app cannot repay it.',
        }
      }
      if (loan?.remaining === 0n) {
        return {
          action: 'closeZeroDebt',
          note: 'Your installments paid the debt: close the loan to get your collateral back.',
        }
      }
      return isPastExpiry(terms, tipHeight)
        ? {
            action: 'repay',
            note: 'The term has ended: the lender may take your collateral at any time.',
          }
        : { action: 'repay' }
    case 'liquidated':
      // The lender took the collateral; the principal it paid is still the borrower's.
      return principalUnclaimed
        ? { action: 'claimPrincipal', note: 'The principal is still yours.' }
        : {}
    case 'repaid':
    case 'cancelled':
      return { note: 'Your collateral came back to you.' }
    default:
      return {}
  }
}

/**
 * A loan's status in the borrower's words:
 * - `waiting` for the lender, while the proposal can still be accepted (or the tip is unknown);
 * - `notAccepted` once its term passed unaccepted;
 * - `accepted`, the principal waiting to be received;
 * - `active`, with the blocks left to its expiry (negative past it, null while the tip is unknown),
 *   and what its installments repaid once the loan is read;
 * - `repaid`, `cancelled`, `collateralTaken`: how it ended.
 */
export type BorrowerStatus =
  | { kind: 'waiting' }
  | { kind: 'notAccepted' }
  | { kind: 'accepted' }
  | { kind: 'active'; blocksLeft: number | null; paid?: bigint }
  | { kind: 'repaid' }
  | { kind: 'cancelled' }
  | { kind: 'collateralTaken' }

/**
 * The status of an opened loan, from the indexer's view of it and `loan`, its figures once read
 * (untrusted, for display).
 */
export function borrowerStatus(
  item: OpenedOfferItem,
  tipHeight: number,
  loan?: LoanFigures,
): BorrowerStatus {
  const { candidate, terms } = item
  switch (displayStatus(candidate)) {
    case 'pending':
      return tipHeight === 0 || canStillAccept(terms, tipHeight)
        ? { kind: 'waiting' }
        : { kind: 'notAccepted' }
    case 'active':
      if (unspentUtxo(candidate, 'principal') !== undefined) return { kind: 'accepted' }
      return {
        kind: 'active',
        blocksLeft: tipHeight === 0 ? null : terms.loanExpirationTime - tipHeight,
        ...(loan === undefined ? {} : { paid: loan.paid }),
      }
    case 'repaid':
    case 'claimed':
      return { kind: 'repaid' }
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'liquidated':
      return { kind: 'collateralTaken' }
  }
}

/** When an active loan is due, from the blocks left: `due in 12 days`, `overdue by 2 days`. */
export function dueText(blocksLeft: number): string {
  if (blocksLeft === 0) return 'due now'
  return blocksLeft > 0
    ? `due in ${formatBlockSpan(blocksLeft)}`
    : `overdue by ${formatBlockSpan(-blocksLeft)}`
}
