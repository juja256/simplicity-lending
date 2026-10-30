// The scan store over a key-value store (the app's `PersistentKv`; a `Map` in Node). Each state is
// saved under its network, indexer and lending-key fingerprint: a synced height means nothing to
// another chain or another indexer's database, and applied there it would skip blocks.
//
// It holds exactly what `ScanState` holds: the synced height and, by creation txid, the role and
// the verification result. Never terms, candidates, nonces or secrets. A stored value that does
// not decode reads as no state, so the next sync starts over from block 0.
import { z as zod } from 'zod'

import type { ScanResult, ScanState, ScanStore } from './scan'

/** The part of `PersistentKv` the store uses. */
export interface ScanKv {
  get(key: string): Uint8Array | undefined
  put(key: string, value: Uint8Array): void
}

/** Where scan states belong: one chain and one indexer. */
export interface ScanScope {
  network: string
  apiBaseUrl: string
}

const STATE_VERSION = 1

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const roleSchema = zod.enum(['lender', 'borrower'])

const resultSchema = zod.discriminatedUnion('result', [
  zod.object({ role: roleSchema, result: zod.literal('verified') }).strict(),
  zod
    .object({ role: roleSchema, result: zod.literal('invalid'), code: zod.string().min(1) })
    .strict(),
])

const storedStateSchema = zod
  .object({
    version: zod.literal(STATE_VERSION),
    syncedHeight: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    offers: zod.record(zod.string().regex(/^[0-9a-f]{64}$/), resultSchema),
  })
  .strict()

/** The key of a state: network, indexer API base URL (without trailing slashes), fingerprint. */
export function scanStoreKey(scope: ScanScope, fingerprint: string): string {
  const apiBaseUrl = scope.apiBaseUrl.trim().replace(/\/+$/, '')
  return JSON.stringify([scope.network, apiBaseUrl, fingerprint])
}

/** Copies only the fields of `ScanState`, so nothing else a caller attached is ever stored. */
function toStored(state: ScanState) {
  const offers: Record<string, ScanResult> = {}
  for (const [txid, offer] of Object.entries(state.offers)) {
    offers[txid] =
      offer.result === 'verified'
        ? { role: offer.role, result: 'verified' }
        : { role: offer.role, result: 'invalid', code: offer.code }
  }
  return { version: STATE_VERSION, syncedHeight: state.syncedHeight, offers }
}

export function encodeScanState(state: ScanState): Uint8Array {
  return encoder.encode(JSON.stringify(toStored(state)))
}

/** The state of `bytes`, or undefined if they are not a valid stored state. */
export function decodeScanState(bytes: Uint8Array): ScanState | undefined {
  try {
    const parsed = storedStateSchema.safeParse(JSON.parse(decoder.decode(bytes)))
    if (!parsed.success) return undefined
    return { syncedHeight: parsed.data.syncedHeight, offers: parsed.data.offers }
  } catch {
    return undefined
  }
}

/** A `ScanStore` that keeps each fingerprint's state in `kv` under `scope`. */
export function kvScanStore(kv: ScanKv, scope: ScanScope): ScanStore {
  return {
    async get(fingerprint) {
      const bytes = kv.get(scanStoreKey(scope, fingerprint))
      return bytes === undefined ? undefined : decodeScanState(bytes)
    },
    async set(fingerprint, state) {
      kv.put(scanStoreKey(scope, fingerprint), encodeScanState(state))
    },
  }
}
