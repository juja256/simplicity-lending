// Query keys of the data read or opened with a session's lending key: the identity, the offers
// and their terms. None of it may outlive the session, so the wallet provider drops it all
// (`removePrivateSessionQueries`) when it frees the key. Free of React hooks, so the provider can
// import it.
import type { QueryClient } from '@tanstack/react-query'

import { privateQueryKeys } from '@/api/indexer/queryKeys'

const LENDING_KEY_IDENTITY_ROOT = 'lending-key-identity'
const PRIVATE_OFFER_TERMS_ROOT = 'private-offer-terms'
const PRIVATE_LENDING_WASM_ROOT = 'private-lending-wasm'

/** The private lending wasm module, loaded once. Not session data: it holds no key. */
export function privateLendingWasmQueryKey() {
  return [PRIVATE_LENDING_WASM_ROOT] as const
}

export function lendingKeyIdentityQueryKey(scriptPubkeyHex: string | null) {
  return [LENDING_KEY_IDENTITY_ROOT, scriptPubkeyHex] as const
}

/** Terms never change for a creation transaction, so this key stays off the per-block root. */
export function privateOfferTermsQueryKey(
  network: string,
  apiBaseUrl: string,
  fingerprint: string,
  txid: string,
  role: string,
) {
  return [PRIVATE_OFFER_TERMS_ROOT, network, apiBaseUrl, fingerprint, txid, role] as const
}

const SESSION_QUERY_ROOTS: readonly (readonly unknown[])[] = [
  privateQueryKeys.all(),
  [PRIVATE_OFFER_TERMS_ROOT],
  [LENDING_KEY_IDENTITY_ROOT],
]

/**
 * Removes every query of a session's private data. The public directory list is not session
 * data and stays.
 */
export function removePrivateSessionQueries(queryClient: QueryClient): void {
  for (const queryKey of SESSION_QUERY_ROOTS) queryClient.removeQueries({ queryKey })
}
