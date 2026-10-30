// Finds a lending key's private offers by scanning the indexer's candidates, as lender and as
// borrower in one pass, following the sync recipe of `crates/indexer/README.md`.
//
// The indexer is untrusted. Only candidates that pass a cheap local check have their transaction
// fetched (the lender's view tag, the borrower's own nonce, both from the indexer's candidate,
// never from transaction bytes); a fetched transaction must have the candidate's txid; and every
// match is opened through the verification gate. The store keeps only the synced height and each
// offer's verification result, never terms or secrets.
import { ApiError } from '@/api/errors'
import {
  fetchPrivateCandidates,
  fetchPrivateCreationTx,
  type PrivateCandidate,
} from '@/api/indexer/private'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'
import { openAndVerifyOffer, PrivateOfferError, type VerifiedOffer } from './verify'

export type OfferRole = 'lender' | 'borrower'

export type ScanResult =
  | { role: OfferRole; result: 'verified' }
  | { role: OfferRole; result: 'invalid'; code: string }

export interface ScanState {
  /** The last block height scanned, or null before the first sync that saw an indexed block. */
  syncedHeight: number | null
  /** By creation txid: only offers addressed to the key, verified or not. */
  offers: Record<string, ScanResult>
}

/** Where `syncOffers` keeps each key's state, by lending-key fingerprint. */
export interface ScanStore {
  get(fingerprint: string): Promise<ScanState | undefined>
  set(fingerprint: string, state: ScanState): Promise<void>
}

/**
 * The code of an offer whose transaction, as the indexer served it, does not have the candidate's
 * txid (or does not parse): the indexer lied, and the real offer cannot be checked.
 */
export const CREATION_TX_MISMATCH = 'creation-tx-mismatch'

/**
 * Codes that say nothing final about the offer: the indexer's answer (`CREATION_TX_MISMATCH`), or
 * a failure inside the gate that may be a local fault (`unknown`). Each sync checks these offers
 * again; every other result is final.
 */
const INDETERMINATE_CODES: ReadonlySet<string> = new Set([CREATION_TX_MISMATCH, 'unknown'])

/** The indexer's largest page. */
const CANDIDATE_PAGE_LIMIT = 500

/**
 * Scans the candidates the indexer added since the stored state, opens the ones addressed to
 * `key`, saves the new state and returns it. An offer already in the state is not opened again,
 * unless its result is indeterminate (`INDETERMINATE_CODES`): it is checked again, by txid, in
 * its stored role. Nothing is saved if a request fails or a cheap check hits a local fault, so the
 * next sync scans the same heights again.
 */
export async function syncOffers(
  deps: PrivateFlowDeps,
  key: LendingKey,
  apiBaseUrl: string,
  store: ScanStore,
): Promise<ScanState> {
  const fingerprint = key.fingerprint()
  const stored = await store.get(fingerprint)
  const storedHeight = stored?.syncedHeight ?? null
  const offers: Record<string, ScanResult> = { ...stored?.offers }
  const fromHeight = storedHeight === null ? 0 : storedHeight + 1

  for (const [txid, stale] of Object.entries(offers)) {
    if (stale.result !== 'invalid' || !INDETERMINATE_CODES.has(stale.code)) continue
    try {
      const result = await checkOffer(deps, key, txid, [stale.role], apiBaseUrl)
      if (result === undefined) delete offers[txid]
      else offers[txid] = result
    } catch (error) {
      // An indexer that no longer knows the offer (a re-indexed database) leaves it as it was.
      if (!(error instanceof ApiError && error.status === 404)) throw error
    }
  }

  // The first page's sync height bounds every later page, so candidates indexed meanwhile wait
  // for the next sync instead of shifting the pages.
  let lastIndexed: number | null = null
  const seen = new Set<string>()
  for (let offset = 0; ; ) {
    const page = await fetchPrivateCandidates(
      {
        fromHeight,
        toHeight: lastIndexed ?? undefined,
        limit: CANDIDATE_PAGE_LIMIT,
        offset,
      },
      apiBaseUrl,
    )
    if (offset === 0) lastIndexed = page.last_indexed_height
    // Nothing indexed yet: the items cannot be placed below a height, so the next sync redoes them.
    if (lastIndexed === null) break
    const fresh = page.items.filter(candidate => !seen.has(candidate.creation_txid))
    // An empty page ends the scan; so does one that only repeats (an indexer ignoring `offset`).
    if (fresh.length === 0) break
    for (const candidate of fresh) {
      seen.add(candidate.creation_txid)
      if (offers[candidate.creation_txid] !== undefined) continue
      const result = await scanCandidate(deps, key, candidate, apiBaseUrl)
      if (result !== undefined) offers[candidate.creation_txid] = result
    }
    offset += page.items.length
  }

  const syncedHeight =
    lastIndexed === null || (storedHeight !== null && storedHeight > lastIndexed)
      ? storedHeight
      : lastIndexed
  const state: ScanState = { syncedHeight, offers }
  await store.set(fingerprint, state)
  return state
}

/**
 * The offer of a creation transaction, fetched from the indexer and opened through the gate as
 * `role`. Throws `PrivateOfferError` with `CREATION_TX_MISMATCH` if the indexer serves a
 * transaction with another txid.
 */
export async function loadVerifiedOffer(
  deps: PrivateFlowDeps,
  key: LendingKey,
  txid: string,
  role: OfferRole,
  apiBaseUrl: string,
): Promise<VerifiedOffer> {
  const hex = await fetchCreationTx(deps, txid, apiBaseUrl)
  if (hex === undefined) {
    throw new PrivateOfferError(
      CREATION_TX_MISMATCH,
      `the indexer served another transaction for ${txid}`,
      true,
    )
  }
  return openAndVerifyOffer(deps, role, key, hex)
}

/** The candidate's transaction as the indexer serves it, or undefined unless it has that txid. */
async function fetchCreationTx(
  deps: PrivateFlowDeps,
  txid: string,
  apiBaseUrl: string,
): Promise<string | undefined> {
  const hex = await fetchPrivateCreationTx(txid, apiBaseUrl)
  try {
    return deps.lwk.Transaction.fromString(hex).txid().toString() === txid.toLowerCase()
      ? hex
      : undefined
  } catch {
    return undefined
  }
}

/**
 * A wasm check of indexer data: malformed data (`bad-input`) is simply no match. Any other error
 * is a local fault (a key from another wasm instance, a freed key, a broken instance) and is
 * rethrown: taken as "no match", it would advance the synced height past offers never checked.
 */
function passes(check: () => boolean): boolean {
  try {
    return check()
  } catch (error) {
    if (typeof error === 'string' && error.startsWith('bad-input:')) return false
    throw error
  }
}

/**
 * The roles in which `candidate` may be addressed to `key`, by the cheap checks: the borrower's
 * own nonce (exact), then the lender's view tag (one in 256 other offers passes it).
 */
function candidateRoles(
  deps: PrivateFlowDeps,
  key: LendingKey,
  candidate: PrivateCandidate,
): OfferRole[] {
  const { first_input: firstInput, nonce } = candidate
  const roles: OfferRole[] = []
  const own = passes(() =>
    deps.wasm.isOwnCandidate(
      key,
      `${firstInput.txid}:${firstInput.vout}`,
      candidate.borrower_nft_asset_id,
      candidate.lender_nft_asset_id,
      nonce,
    ),
  )
  if (own) roles.push('borrower')
  if (passes(() => deps.wasm.viewTagMatches(key, nonce, candidate.view_tag))) roles.push('lender')
  return roles
}

/** The result for one candidate, or undefined if it is not addressed to `key`. */
async function scanCandidate(
  deps: PrivateFlowDeps,
  key: LendingKey,
  candidate: PrivateCandidate,
  apiBaseUrl: string,
): Promise<ScanResult | undefined> {
  const roles = candidateRoles(deps, key, candidate)
  if (roles.length === 0) return undefined
  return checkOffer(deps, key, candidate.creation_txid, roles, apiBaseUrl)
}

/**
 * Fetches the creation transaction `txid`, requires that txid, and opens it through the gate in
 * `roles`, in order: the first role whose opening gets past "not addressed" decides, and the offer
 * is not opened in the other. Undefined if it is addressed to `key` in none of them.
 */
async function checkOffer(
  deps: PrivateFlowDeps,
  key: LendingKey,
  txid: string,
  roles: OfferRole[],
  apiBaseUrl: string,
): Promise<ScanResult | undefined> {
  const hex = await fetchCreationTx(deps, txid, apiBaseUrl)
  if (hex === undefined) return { role: roles[0], result: 'invalid', code: CREATION_TX_MISMATCH }

  for (const role of roles) {
    try {
      await openAndVerifyOffer(deps, role, key, hex)
      return { role, result: 'verified' }
    } catch (error) {
      if (!(error instanceof PrivateOfferError)) {
        // The gate throws other errors only once the offer opened, while it builds the offer's
        // scripts: the offer is addressed to the key. An offer that always throws must not stop
        // every later sync, so it is listed as invalid, `unknown`, and checked again next sync.
        console.error(`private offer ${txid}:`, error)
        return { role, result: 'invalid', code: 'unknown' }
      }
      if (error.addressedToKey) return { role, result: 'invalid', code: error.code }
    }
  }
  return undefined
}
