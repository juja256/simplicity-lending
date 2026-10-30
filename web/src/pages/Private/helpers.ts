// Display and gating rules of the private page, shared by its lending and borrowing sections. The
// indexer's candidate (status, UTXOs) is untrusted: it only decides what to show and which action
// to offer. Every action loads its offer fresh through the gate, and its builder checks every
// outpoint it is given.
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'

import type { PrivateCandidateDetails, PrivateUtxo, PrivateUtxoType } from '@/api/indexer/private'
import type { OfferStatus } from '@/api/indexer/schemas'
import { NETWORK_CONFIG } from '@/constants/network-config'
import type { PrivateOfferItem, PrivateOfferTerms } from '@/privateLending/hooks/usePrivateOffers'
import { getPrivateLendingWasm } from '@/privateLending/wasm'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'

/** The indexer's limit on a directory display name, in Unicode scalar values. */
export const MAX_DISPLAY_NAME_CHARS = 64

// Rust's `str::trim` strips `char::is_whitespace`, the Unicode White_Space property.
const EDGE_WHITESPACE = /^\p{White_Space}|\p{White_Space}$/u
// Rust's `char::is_control`: the Cc category.
const CONTROL_CHARACTER = /\p{Cc}/u
// A lone surrogate is not text: it cannot be sent as UTF-8.
const LONE_SURROGATE = /\p{Cs}/u

/**
 * Why the indexer would refuse a display name (`validate_display_name`: 1 to 64 characters, no
 * leading or trailing whitespace, no control characters), or null if it accepts it.
 */
export function displayNameError(name: string): string | null {
  if (LONE_SURROGATE.test(name)) return 'The name contains an invalid character.'
  const chars = [...name].length
  if (chars === 0 || chars > MAX_DISPLAY_NAME_CHARS) {
    return `A name has 1 to ${MAX_DISPLAY_NAME_CHARS} characters.`
  }
  if (EDGE_WHITESPACE.test(name)) return 'A name cannot start or end with a space.'
  if (CONTROL_CHARACTER.test(name)) return 'A name cannot contain control characters.'
  return null
}

/** A key fingerprint in groups of four characters: `1aa0 5299 d34b b9f5`. */
export function groupFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint
}

/**
 * `keyFingerprint` of any x-only key, for keys the session's own offers do not carry (directory
 * entries): undefined while the wasm loads, null for a key that is not a valid x-only key.
 */
export function useFingerprintOf(): (pubkey: string) => string | null | undefined {
  const { data: wasm } = useQuery({
    queryKey: ['private-lending-wasm'],
    queryFn: getPrivateLendingWasm,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  return useCallback(
    (pubkey: string) => {
      if (wasm === undefined) return undefined
      try {
        return wasm.keyFingerprint(pubkey)
      } catch {
        return null
      }
    },
    [wasm],
  )
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

/** Whether the offer uses the network's collateral and principal assets, the only ones shown. */
export function usesConfiguredAssets(terms: PrivateOfferTerms): boolean {
  return (
    terms.collateralAsset === NETWORK_CONFIG.collateralAsset.id &&
    terms.principalAsset === NETWORK_CONFIG.principalAsset.id
  )
}

/** The first UTXO of a type the indexer tracks for the offer that is still unspent. */
export function unspentUtxo(
  candidate: PrivateCandidateDetails,
  type: PrivateUtxoType,
): PrivateUtxo | undefined {
  return candidate.utxos.find(utxo => utxo.utxo_type === type && utxo.spent_txid === null)
}

/** The acceptance transaction, as the indexer saw it: the one that created the active offer. */
export function acceptanceTxid(candidate: PrivateCandidateDetails): string | undefined {
  return candidate.utxos.find(utxo => utxo.utxo_type === 'active_offer')?.txid
}

export function outpointOf(utxo: PrivateUtxo): string {
  return `${utxo.txid}:${utxo.vout}`
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
