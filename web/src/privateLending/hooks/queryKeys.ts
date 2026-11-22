// Query keys of the data read or opened with a session's lending key: the identity, the offers,
// their terms, their loans and the loans' messages. None of it may outlive the session, so the
// wallet provider drops it all (`removePrivateSessionQueries`) when it frees the key. Free of
// React hooks, so the provider can import it.
import type { QueryClient } from '@tanstack/react-query'

import { privateQueryKeys } from '@/api/indexer/queryKeys'
import { clearFoundCollaterals } from '@/privateLending/collateralSearch'
import { dropOpenedOffers } from '@/privateLending/offerCache'

const LENDING_KEY_IDENTITY_ROOT = 'lending-key-identity'
const PRIVATE_OFFER_TERMS_ROOT = 'private-offer-terms'
const PRIVATE_LOAN_ROOT = 'private-loan'
const PRIVATE_LOAN_MESSAGES_ROOT = 'private-loan-messages'
const PRIVATE_COLLATERAL_ROOT = 'private-loan-collateral'
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

/**
 * A loan read from its loan output (`useLoan`). What leads to a loan output never changes, so this
 * key also stays off the per-block root: a new installment or a close is a new loan output.
 */
export function privateLoanQueryKey(
  network: string,
  apiBaseUrl: string,
  fingerprint: string,
  txid: string,
  role: string,
  loanOutpoint: string,
) {
  return [PRIVATE_LOAN_ROOT, network, apiBaseUrl, fingerprint, txid, role, loanOutpoint] as const
}

/**
 * What `useLoanMessages` reads beside the loan: the full repayment's message and this wallet's
 * records of the messages it sent. Keyed by the loan output and the full repayment, so a new
 * installment or a close reads them again.
 */
export function privateLoanMessagesQueryKey(
  network: string,
  apiBaseUrl: string,
  fingerprint: string,
  txid: string,
  role: string,
  loanOutpoint: string,
  repaymentTxid: string,
) {
  return [
    PRIVATE_LOAN_MESSAGES_ROOT,
    network,
    apiBaseUrl,
    fingerprint,
    txid,
    role,
    loanOutpoint,
    repaymentTxid,
  ] as const
}

/**
 * The lender's search for a loan's collateral (`useCollateralLeft`), keyed by the loan output's
 * commitments, which name the state the search answers for.
 */
export function privateCollateralQueryKey(valueCommitment: string, assetCommitment: string) {
  return [PRIVATE_COLLATERAL_ROOT, valueCommitment, assetCommitment] as const
}

const SESSION_QUERY_ROOTS: readonly (readonly unknown[])[] = [
  privateQueryKeys.all(),
  [PRIVATE_OFFER_TERMS_ROOT],
  [PRIVATE_LOAN_ROOT],
  [PRIVATE_LOAN_MESSAGES_ROOT],
  [PRIVATE_COLLATERAL_ROOT],
  [LENDING_KEY_IDENTITY_ROOT],
]

/**
 * Removes every query of a session's private data. The public directory list is not session
 * data and stays.
 */
export function removePrivateSessionQueries(queryClient: QueryClient): void {
  for (const queryKey of SESSION_QUERY_ROOTS) queryClient.removeQueries({ queryKey })
  dropOpenedOffers()
  clearFoundCollaterals()
}
