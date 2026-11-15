// Display and gating rules of the private offers, shared by the lender console, the private page
// and their modals. The indexer's candidate (status, UTXOs) is untrusted: it only decides what to
// show and which action to offer. Every action loads its offer fresh through the gate, and its
// builder checks every outpoint it is given. The rules that read outpoints from the candidate are
// in `./candidate`.
import type { ReactNode } from 'react'

import type {
  PrivateCandidateDetails,
  PrivateOfferStatus,
  PrivateUtxoType,
} from '@/api/indexer/private'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { unspentUtxo } from '@/privateLending/candidate'
import type { PrivateOfferItem, PrivateOfferTerms } from '@/privateLending/hooks/usePrivateOffers'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { formatTermLeft } from '@/utils/format'

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
  if (item.candidate === null) return 'The indexer no longer lists this offer.'
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

/** What each tracked UTXO is, for messages. */
export const PRIVATE_UTXO_LABEL: Record<PrivateUtxoType, string> = {
  pending_offer: 'pending offer',
  active_offer: 'active offer',
  principal: 'principal',
  repayment: 'repayment',
}

/** The status an offer shows: the indexer's status, or `claimed` for a claimed repayment. */
export type OfferStatus = PrivateOfferStatus | 'claimed'

/**
 * The status to show for a candidate. A repaid offer whose every repayment UTXO is spent shows
 * as claimed.
 */
export function displayStatus(candidate: PrivateCandidateDetails): OfferStatus {
  if (candidate.status !== 'repaid') return candidate.status
  const repayments = candidate.utxos.filter(utxo => utxo.utxo_type === 'repayment')
  return repayments.length > 0 && repayments.every(utxo => utxo.spent_txid !== null)
    ? 'claimed'
    : 'repaid'
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
        record.offerTxid === offerTxid && (kinds as readonly PrivateTxKind[]).includes(record.kind),
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

export type LenderAction = 'accept' | 'claim' | 'liquidate'

/**
 * The names of the lender's actions in the console, where "Review" opens the acceptance. Each page
 * tracks only the transactions of the actions it shows (`OfferActions.actionOfKind`).
 */
export const LENDER_ACTION_LABELS: Record<LenderAction, string> = {
  accept: 'Review',
  claim: 'Claim',
  liquidate: 'Liquidate',
}

/**
 * What the lender can do with an offer, from the indexer's view of it (untrusted: the action's
 * builder checks every outpoint): accept a pending offer while `canStillAccept` (nothing while the
 * tip is unknown), claim an unspent repayment, liquidate an active loan once the tip is past its
 * expiry.
 */
export function lenderView(item: OpenedOfferItem, tipHeight: number): OfferView<LenderAction> {
  const { candidate, terms } = item
  const expired = isPastExpiry(terms, tipHeight)
  switch (candidate.status) {
    case 'pending':
      if (tipHeight === 0) return { note: TIP_UNKNOWN_NOTE }
      return canStillAccept(terms, tipHeight) ? { action: 'accept' } : { note: TERM_PASSED_NOTE }
    case 'active':
      if (unspentUtxo(candidate, 'active_offer') === undefined) return {}
      return expired
        ? { action: 'liquidate', note: 'The loan has expired unpaid.' }
        : { note: `Liquidation opens after block #${terms.loanExpirationTime}.` }
    case 'repaid':
      return unspentUtxo(candidate, 'repayment') !== undefined
        ? { action: 'claim', note: 'The borrower repaid the loan.' }
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
