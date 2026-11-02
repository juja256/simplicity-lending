import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'

import { getPrivateLendingWasm } from '@/privateLending/wasm'

import { privateLendingWasmQueryKey } from './queryKeys'

/** Whether a string has the shape of an x-only key: 64 hex characters. */
export const X_ONLY_KEY_HEX = /^[0-9a-fA-F]{64}$/

/**
 * `keyFingerprint` of any x-only key, for keys the session's own offers do not carry (directory
 * entries, a pasted lender key): undefined while the wasm loads, null for a key that is not a
 * valid x-only key. `keyFingerprint` only reads 32 bytes, so `liftLendingKey` checks first that
 * they are a point's x coordinate.
 */
export function useFingerprintOf(): (pubkey: string) => string | null | undefined {
  const { data: wasm } = useQuery({
    queryKey: privateLendingWasmQueryKey(),
    queryFn: getPrivateLendingWasm,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  return useCallback(
    (pubkey: string) => {
      if (wasm === undefined) return undefined
      if (!X_ONLY_KEY_HEX.test(pubkey)) return null
      try {
        wasm.liftLendingKey(pubkey)
        return wasm.keyFingerprint(pubkey)
      } catch {
        return null
      }
    },
    [wasm],
  )
}
