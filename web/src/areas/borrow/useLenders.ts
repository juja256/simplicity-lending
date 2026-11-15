// The lenders a borrower can propose to: the directory's verified entries with terms for the
// configured pair, never the session's own key.
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { NETWORK_CONFIG } from '@/constants/network-config'
import { privateLendingWasmQueryKey } from '@/privateLending/hooks/queryKeys'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { useFingerprintOf } from '@/privateLending/hooks/useFingerprintOf'
import { useLendingKeyIdentity } from '@/privateLending/hooks/usePrivateFlowDeps'
import { findPairTerms, type PairTermsInput, type TermsPair } from '@/privateLending/lenderTerms'
import { getPrivateLendingWasm, type PrivateLendingWasm } from '@/privateLending/wasm'
import { normalizeHex } from '@/utils/hex'

export const PAIR: TermsPair = {
  collateral: NETWORK_CONFIG.collateralAsset,
  principal: NETWORK_CONFIG.principalAsset,
}

export interface Lender {
  /** The x-only key, lowercase. */
  pubkey: string
  fingerprint: string
  /** Chosen by whoever holds the key: show it inside <bdi>, next to the fingerprint. */
  name: string
  /** The verified terms for the configured pair. */
  pair: PairTermsInput
  /** Unix seconds; null when the indexer gives no time. Not signed. */
  publishedAt: number | null
}

/** Why the lenders are not known yet. */
export type LendersPending =
  | { kind: 'loading' }
  | { kind: 'directory-error'; error: Error; retry: () => void }
  | { kind: 'identity-error'; error: Error }
  | { kind: 'wasm-error'; error: Error }

/**
 * The lenders in the directory's order, once the directory, the session's own key and the wasm
 * are known (`pending` until then), with the count of entries that did not verify. Directory
 * entries are untrusted: only verified terms are used, and only their configured pair.
 */
export function useLenders(): {
  lenders: Lender[]
  hiddenCount: number
  ownKey: string | undefined
  /** Loaded once `pending` is null. */
  wasm: PrivateLendingWasm | undefined
  pending: LendersPending | null
} {
  const { directory, lenders: verified, hiddenCount } = useDirectory()
  const identity = useLendingKeyIdentity()
  const fingerprintOf = useFingerprintOf()
  const wasm = useQuery({
    queryKey: privateLendingWasmQueryKey(),
    queryFn: getPrivateLendingWasm,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const ownKey = identity.data?.pubkey.toLowerCase()

  const lenders = useMemo(
    () =>
      verified.flatMap(({ entry, terms }): Lender[] => {
        const pubkey = normalizeHex(entry.pubkey)
        const fingerprint = fingerprintOf(pubkey)
        const pair = findPairTerms(terms, PAIR)
        if (!fingerprint || pair === undefined || pubkey === ownKey) return []
        return [
          {
            pubkey,
            fingerprint,
            name: entry.display_name,
            pair,
            publishedAt: entry.terms_published_at,
          },
        ]
      }),
    [verified, fingerprintOf, ownKey],
  )

  let pending: LendersPending | null = null
  if (identity.isError) {
    pending = { kind: 'identity-error', error: identity.error }
  } else if (wasm.isError) {
    pending = { kind: 'wasm-error', error: wasm.error }
  } else if (directory.isError) {
    pending = {
      kind: 'directory-error',
      error: directory.error,
      retry: () => void directory.refetch(),
    }
  } else if (directory.isPending || ownKey === undefined || wasm.data === undefined) {
    pending = { kind: 'loading' }
  }

  return { lenders, hiddenCount, ownKey, wasm: wasm.data, pending }
}
