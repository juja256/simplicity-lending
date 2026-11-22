import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'
import { dropOpenedOffers, OpenedOfferCache, openedOffersOf } from './offerCache'
import { cachedVerifiedOffer, type ScanState, type ScanStore, syncOffers } from './scan'
import type { VerifiedOffer } from './verify'

const TXID_A = 'aa'.repeat(32)
const TXID_B = 'bb'.repeat(32)

const verify = vi.hoisted(() => ({ open: vi.fn() }))
const indexer = vi.hoisted(() => ({
  candidates: vi.fn(),
  creationTx: vi.fn(),
}))

vi.mock('./verify', async importOriginal => ({
  ...(await importOriginal<typeof import('./verify')>()),
  openAndVerifyOffer: verify.open,
}))
vi.mock('@/api/indexer/private', () => ({
  fetchPrivateCandidates: indexer.candidates,
  fetchPrivateCreationTx: indexer.creationTx,
}))

/** An opened offer whose `free` is watched. */
function opened(): VerifiedOffer & { free: ReturnType<typeof vi.fn> } {
  const free = vi.fn()
  return { opened: { free }, free } as unknown as VerifiedOffer & { free: typeof free }
}

const key = { fingerprint: () => 'fp' } as unknown as LendingKey

/** Deps over which every candidate is addressed to the key, as lender, with txid-matching txs. */
const deps = {
  lwk: {
    Transaction: { fromString: (hex: string) => ({ txid: () => ({ toString: () => hex }) }) },
  },
  wasm: { isOwnCandidate: () => false, viewTagMatches: () => true },
  fetchTipHeight: async () => 100,
} as unknown as PrivateFlowDeps

function candidate(txid: string) {
  return {
    creation_txid: txid,
    first_input: { txid: 'cc'.repeat(32), vout: 0 },
    nonce: '00',
    view_tag: 0,
    borrower_nft_asset_id: '',
    lender_nft_asset_id: '',
  }
}

describe('the opened offers cache', () => {
  beforeEach(() => {
    dropOpenedOffers()
    verify.open.mockReset()
    indexer.candidates.mockReset()
    indexer.creationTx.mockReset()
  })

  it('frees only the offers no longer listed, and all of them at the end of the session', () => {
    const cache = new OpenedOfferCache()
    const [a, b] = [opened(), opened()]
    cache.put(TXID_A, 'lender', a)
    cache.put(TXID_B, 'lender', b)
    cache.retain([TXID_A])
    expect(a.free).not.toHaveBeenCalled()
    expect(b.free).toHaveBeenCalledOnce()
    expect(cache.get(TXID_B, 'lender')).toBeUndefined()
    dropOpenedOffers()
    cache.clear()
    expect(a.free).toHaveBeenCalledOnce()
  })

  it('starts a cache for another key and frees the old key’s offers', () => {
    const first = openedOffersOf(key)
    const offer = opened()
    first.put(TXID_A, 'lender', offer)
    expect(openedOffersOf(key)).toBe(first)
    const other = openedOffersOf({ fingerprint: () => 'other' } as unknown as LendingKey)
    expect(other).not.toBe(first)
    expect(offer.free).toHaveBeenCalledOnce()
    expect(other.size).toBe(0)
  })

  it('opens an offer once for many reads', async () => {
    verify.open.mockImplementation(async () => opened())
    indexer.creationTx.mockResolvedValue(TXID_A)
    const cache = new OpenedOfferCache()
    const read = () => cachedVerifiedOffer(cache, deps, key, TXID_A, 'lender', 'http://indexer')
    const first = await read()
    expect(await read()).toBe(first)
    expect(verify.open).toHaveBeenCalledTimes(1)
    expect(indexer.creationTx).toHaveBeenCalledTimes(1)
  })

  it('does not open an unchanged offer again in a second scan, and opens only the new one', async () => {
    verify.open.mockImplementation(async () => opened())
    indexer.creationTx.mockImplementation(async (txid: string) => txid)
    const listed = [candidate(TXID_A)]
    indexer.candidates.mockImplementation(async () => ({
      last_indexed_height: 50,
      items: listed,
    }))
    const stored: { state?: ScanState } = {}
    const makeStore = (): ScanStore => ({
      get: async () => stored.state,
      set: async (_fingerprint, state) => {
        stored.state = state
      },
    })
    const cache = new OpenedOfferCache()

    await syncOffers(deps, key, 'http://indexer', makeStore(), cache)
    expect(verify.open).toHaveBeenCalledTimes(1)
    const kept = cache.get(TXID_A, 'lender')
    expect(kept).toBeDefined()

    // a refresh with a new offer: only the new one is opened, the first is kept, not freed
    listed.push(candidate(TXID_B))
    await syncOffers(deps, key, 'http://indexer', makeStore(), cache)
    expect(verify.open).toHaveBeenCalledTimes(2)
    expect(cache.get(TXID_A, 'lender')).toBe(kept)
    expect((kept?.opened.free as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)

    // a scan that lost its state (a cleared store) finds the offers kept, and opens none again
    stored.state = undefined
    await syncOffers(deps, key, 'http://indexer', makeStore(), cache)
    expect(verify.open).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(2)
  })

  it('frees the entry of an offer the scan no longer lists', async () => {
    verify.open.mockImplementation(async () => opened())
    indexer.creationTx.mockImplementation(async (txid: string) => txid)
    indexer.candidates.mockResolvedValue({ last_indexed_height: 50, items: [candidate(TXID_A)] })
    const cache = new OpenedOfferCache()
    const gone = opened()
    cache.put(TXID_B, 'lender', gone)
    const store = { get: async () => undefined, set: async () => {} }
    await syncOffers(deps, key, 'http://indexer', store, cache)
    expect(gone.free).toHaveBeenCalledOnce()
    expect(cache.get(TXID_B, 'lender')).toBeUndefined()
    expect(cache.get(TXID_A, 'lender')).toBeDefined()
  })
})
