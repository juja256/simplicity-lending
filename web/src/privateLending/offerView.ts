// Display and gating rules of the private offers, shared by the private page and its modals. The
// indexer's candidate (status, UTXOs) is untrusted: it only decides what to show and which action
// to offer. Every action loads its offer fresh through the gate, and its builder checks every
// outpoint it is given. The rules that read outpoints from the candidate are in `./candidate`.
import type { PrivateCandidateDetails, PrivateUtxoType } from '@/api/indexer/private'
import type { OfferStatus } from '@/api/indexer/schemas'
import { NETWORK_CONFIG } from '@/constants/network-config'
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

/**
 * The status to show for a candidate. A repaid offer whose every repayment UTXO is spent shows
 * as claimed, as the public pages do.
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
