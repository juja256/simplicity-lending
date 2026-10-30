// The connected wallet's private offers, as lender and as borrower: `syncOffers` over the indexer,
// with the scan state kept in a `PersistentKv`. The view refetches on every `block_indexed` event
// (`privateQueryKeys.all()`, invalidated by `invalidateEventQueries`).
//
// A listed result is only what a past sync found. An action must load its `VerifiedOffer` fresh
// with `useLoadVerifiedOffer`, never trust a listed `verified`. The offers and their terms are
// dropped from the cache when the session ends (`removePrivateSessionQueries`).
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { ApiError } from '@/api/errors'
import { fetchPrivateCandidate, type PrivateCandidateDetails } from '@/api/indexer/private'
import { privateQueryKeys } from '@/api/indexer/queryKeys'
import { openIdbBackend } from '@/lib/sync-kv/idbBackend'
import { PersistentKv } from '@/lib/sync-kv/persistentKv'
import type { PrivateFlowDeps } from '@/privateLending/deps'
import {
  loadVerifiedOffer,
  type OfferRole,
  type ScanResult,
  syncOffers,
} from '@/privateLending/scan'
import { kvScanStore } from '@/privateLending/scanStore'
import type { VerifiedOffer } from '@/privateLending/verify'
import { useLwk } from '@/providers/lwk/useLwk'
import { useWallet } from '@/providers/wallet/useWallet'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import { privateOfferTermsQueryKey } from './queryKeys'
import { PRIVATE_API_BASE_URL, usePrivateFlowDeps } from './usePrivateFlowDeps'

/** An offer's terms for display, opened through the gate in this session and never stored. */
export interface PrivateOfferTerms {
  /** x-only keys, hex, and their fingerprints. */
  borrowerPublicKey: string
  borrowerFingerprint: string
  lenderPublicKey: string
  lenderFingerprint: string
  collateralAsset: string
  collateralAmount: bigint
  principalAsset: string
  principalAmount: bigint
  repaymentAmount: bigint
  /** `repaymentAmount − principalAmount`, the only interest to show (never the rate in bps). */
  interest: bigint
  /** The loan's expiry, a block height. */
  loanExpirationTime: number
  borrowerNft: string
  lenderNft: string
}

export interface PrivateOfferItem {
  /** The creation txid. */
  txid: string
  role: OfferRole
  result: 'verified' | 'invalid'
  /** Why an invalid offer is invalid: a wasm or gate code. Invalid offers get no actions. */
  code?: string
  /**
   * The indexer's candidate with its UTXOs (status, outpoints), for display: untrusted, and null
   * if the indexer does not know the offer.
   */
  candidate: PrivateCandidateDetails | null
  /**
   * The terms of a verified offer, or null for an invalid one, or if opening it again failed
   * (then it gets no actions either).
   */
  terms: PrivateOfferTerms | null
}

export interface PrivateOffers {
  /** Offers addressed to the wallet's key as lender: the inbox. */
  lending: PrivateOfferItem[]
  /** The wallet's own offers, as borrower. */
  borrowing: PrivateOfferItem[]
  /** The block height the scan reached; null before the indexer indexed a block. */
  syncedHeight: number | null
}

const SCAN_DB_NAME = 'simplicity-lending:private-scan'
const SCAN_STORE_NAME = 'kv'
const SCAN_KV_PREFIX = 'scan:'

// Terms of a creation transaction never change: opened once, they are kept in memory for a while.
const TERMS_GC_MS = 30 * 60_000

let scanKv: Promise<PersistentKv> | null = null

/** One `PersistentKv` for every scan state; memory-only where IndexedDB is unavailable. */
function getScanKv(): Promise<PersistentKv> {
  scanKv ??= (async () => {
    const backend = await openIdbBackend(SCAN_DB_NAME, SCAN_STORE_NAME)
    const kv = new PersistentKv(backend, SCAN_KV_PREFIX, true)
    await kv.hydrate()
    return kv
  })().catch(error => {
    scanKv = null
    throw error
  })
  return scanKv
}

async function openTerms(
  deps: PrivateFlowDeps,
  key: LendingKey,
  txid: string,
  role: OfferRole,
): Promise<PrivateOfferTerms> {
  const { opened } = await loadVerifiedOffer(deps, key, txid, role, PRIVATE_API_BASE_URL)
  try {
    const borrowerPublicKey = opened.borrowerPublicKey()
    const lenderPublicKey = opened.lenderPublicKey()
    const principalAmount = opened.principalAmount()
    const repaymentAmount = opened.repaymentAmount()
    return {
      borrowerPublicKey,
      borrowerFingerprint: deps.wasm.keyFingerprint(borrowerPublicKey),
      lenderPublicKey,
      lenderFingerprint: deps.wasm.keyFingerprint(lenderPublicKey),
      collateralAsset: opened.collateralAsset(),
      collateralAmount: opened.collateralAmount(),
      principalAsset: opened.principalAsset(),
      principalAmount,
      repaymentAmount,
      interest: repaymentAmount - principalAmount,
      loanExpirationTime: opened.loanExpirationTime(),
      borrowerNft: opened.borrowerNft(),
      lenderNft: opened.lenderNft(),
    }
  } finally {
    // Only the plain values above are kept; the opened offer holds the offer's secrets.
    opened.free()
  }
}

async function fetchCandidate(txid: string): Promise<PrivateCandidateDetails | null> {
  try {
    return await fetchPrivateCandidate(txid, PRIVATE_API_BASE_URL)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

async function offerItem(
  queryClient: QueryClient,
  deps: PrivateFlowDeps,
  key: LendingKey,
  scope: { network: string; fingerprint: string },
  txid: string,
  scanned: ScanResult,
): Promise<PrivateOfferItem> {
  const terms =
    scanned.result !== 'verified'
      ? Promise.resolve(null)
      : queryClient
          .fetchQuery({
            queryKey: privateOfferTermsQueryKey(
              scope.network,
              PRIVATE_API_BASE_URL,
              scope.fingerprint,
              txid,
              scanned.role,
            ),
            queryFn: () => openTerms(deps, key, txid, scanned.role),
            staleTime: Infinity,
            gcTime: TERMS_GC_MS,
          })
          .catch(error => {
            console.warn(`private offer ${txid}: could not open it again`, error)
            return null
          })
  const [candidate, openedTerms] = await Promise.all([fetchCandidate(txid), terms])
  return {
    txid,
    role: scanned.role,
    result: scanned.result,
    ...(scanned.result === 'invalid' ? { code: scanned.code } : {}),
    candidate,
    terms: openedTerms,
  }
}

/** Newest first by the candidate's creation height; offers the indexer lost go last. */
function compareItems(a: PrivateOfferItem, b: PrivateOfferItem): number {
  const heightA = a.candidate?.created_at_height ?? -1
  const heightB = b.candidate?.created_at_height ?? -1
  return heightB - heightA || a.txid.localeCompare(b.txid)
}

/**
 * The wallet's private offers. Each run syncs from the stored height, then fetches the candidate
 * of every offer found (and opens the verified ones not opened yet). Enabled only while a
 * private-capable wallet is ready. A failed sync saves nothing and surfaces as the query's error:
 * only network errors are retried, so a key freed by a disconnect mid-sync fails cleanly once.
 */
export function usePrivateOffers() {
  const { network } = useLwk()
  const { isReady, privateCapable, scriptPubkey, getLendingKey } = useWallet()
  const getDeps = usePrivateFlowDeps()
  const queryClient = useQueryClient()

  return useQuery({
    queryKey: privateQueryKeys.offers(network, PRIVATE_API_BASE_URL, scriptPubkey ?? ''),
    enabled: isReady && privateCapable && scriptPubkey !== null,
    queryFn: async ({ signal }): Promise<PrivateOffers> => {
      const [deps, key, kv] = await Promise.all([getDeps(), getLendingKey(), getScanKv()])
      const scope = { network, fingerprint: key.fingerprint() }
      const store = kvScanStore(kv, { network, apiBaseUrl: PRIVATE_API_BASE_URL })
      const state = await syncOffers(deps, key, PRIVATE_API_BASE_URL, store)
      // A sync outlived by its session (or its last viewer) opens no terms into the cache.
      signal.throwIfAborted()
      const items = await Promise.all(
        Object.entries(state.offers).map(([txid, scanned]) =>
          offerItem(queryClient, deps, key, scope, txid, scanned),
        ),
      )
      items.sort(compareItems)
      return {
        lending: items.filter(item => item.role === 'lender'),
        borrowing: items.filter(item => item.role === 'borrower'),
        syncedHeight: state.syncedHeight,
      }
    },
  })
}

/**
 * Loads an offer's `VerifiedOffer` fresh, for an action: fetches its creation transaction from the
 * indexer and opens it through the gate with the session's lending key. Pass the same `deps` the
 * builder gets. Throws `PrivateOfferError` if it does not verify (now).
 */
export function useLoadVerifiedOffer(): (
  deps: PrivateFlowDeps,
  txid: string,
  role: OfferRole,
) => Promise<VerifiedOffer> {
  const { getLendingKey } = useWallet()
  return useCallback(
    async (deps, txid, role) =>
      loadVerifiedOffer(deps, await getLendingKey(), txid, role, PRIVATE_API_BASE_URL),
    [getLendingKey],
  )
}
