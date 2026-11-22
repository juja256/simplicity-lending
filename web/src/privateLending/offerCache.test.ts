import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'
import { dropOpenedOffers, OpenedOfferCache, openedOffersOf } from './offerCache'
import { type ScanState, type ScanStore, syncOffers, withVerifiedOffer } from './scan'
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

/** Puts `offer` in `cache` as a scan does: opened by the cache's first reader, then left there. */
const keep = (cache: OpenedOfferCache, txid: string, offer: VerifiedOffer) =>
  cache.use(
    txid,
    'lender',
    async () => offer,
    () => {},
  )

describe('the opened offers cache', () => {
  beforeEach(() => {
    dropOpenedOffers()
    verify.open.mockReset()
    indexer.candidates.mockReset()
    indexer.creationTx.mockReset()
  })

  it('frees only the offers no longer listed, and all of them at the end of the session', async () => {
    const cache = new OpenedOfferCache()
    const [a, b] = [opened(), opened()]
    await keep(cache, TXID_A, a)
    await keep(cache, TXID_B, b)
    cache.retain([TXID_A])
    expect(a.free).not.toHaveBeenCalled()
    expect(b.free).toHaveBeenCalledOnce()
    expect(cache.has(TXID_B, 'lender')).toBe(false)
    cache.clear()
    expect(a.free).toHaveBeenCalledOnce()
    expect(b.free).toHaveBeenCalledOnce()
  })

  it('starts a cache for another key and frees the old key’s offers', async () => {
    const first = openedOffersOf(key)
    const offer = opened()
    await keep(first, TXID_A, offer)
    expect(openedOffersOf(key)).toBe(first)
    const other = openedOffersOf({ fingerprint: () => 'other' } as unknown as LendingKey)
    expect(other).not.toBe(first)
    expect(offer.free).toHaveBeenCalledOnce()
    expect(other.size).toBe(0)
  })

  it('opens an offer once for many reads, also concurrent ones', async () => {
    let finish: (offer: VerifiedOffer) => void = () => {}
    verify.open.mockImplementation(() => new Promise<VerifiedOffer>(resolve => (finish = resolve)))
    indexer.creationTx.mockResolvedValue(TXID_A)
    const cache = new OpenedOfferCache()
    const seen: VerifiedOffer[] = []
    const read = () =>
      withVerifiedOffer(cache, deps, key, TXID_A, 'lender', 'http://indexer', offer => {
        seen.push(offer)
      })
    const reads = Promise.all([read(), read()])
    await vi.waitFor(() => expect(verify.open).toHaveBeenCalledTimes(1))
    const offer = opened()
    finish(offer)
    await reads
    await read()
    expect(verify.open).toHaveBeenCalledTimes(1)
    expect(indexer.creationTx).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([offer, offer, offer])
    expect(offer.free).not.toHaveBeenCalled()
  })

  it('does not forget a failed opening: the next read opens again', async () => {
    const cache = new OpenedOfferCache()
    const failing = () =>
      cache.use(
        TXID_A,
        'lender',
        () => Promise.reject(new Error('no')),
        () => {},
      )
    await expect(failing()).rejects.toThrow('no')
    await keep(cache, TXID_A, opened())
    expect(cache.has(TXID_A, 'lender')).toBe(true)
  })

  it('does not free an offer under a reader that is inside it: the last reader frees it', async () => {
    const cache = new OpenedOfferCache()
    const offer = opened()
    await keep(cache, TXID_A, offer)
    let release: () => void = () => {}
    const holding = cache.use(
      TXID_A,
      'lender',
      async () => opened(),
      () => new Promise<void>(resolve => (release = resolve)),
    )
    await vi.waitFor(() => expect(release).not.toBe(undefined))
    // dropped from the listing, and then the session ends, while the reader is still inside
    cache.retain([])
    cache.clear()
    expect(offer.free).not.toHaveBeenCalled()
    release()
    await holding
    expect(offer.free).toHaveBeenCalledOnce()
    // the dropped entry is gone: the next read opens its own
    expect(cache.has(TXID_A, 'lender')).toBe(false)
  })

  it('shares one opening between a scan and a reader that overlap', async () => {
    let finish: (offer: VerifiedOffer) => void = () => {}
    verify.open.mockImplementation(() => new Promise<VerifiedOffer>(resolve => (finish = resolve)))
    indexer.creationTx.mockImplementation(async (txid: string) => txid)
    indexer.candidates.mockResolvedValue({ last_indexed_height: 50, items: [candidate(TXID_A)] })
    const cache = new OpenedOfferCache()
    const reader = withVerifiedOffer(
      cache,
      deps,
      key,
      TXID_A,
      'lender',
      'http://indexer',
      offer => offer,
    )
    await vi.waitFor(() => expect(verify.open).toHaveBeenCalledTimes(1))
    const store = { get: async () => undefined, set: async () => {} }
    const scan = syncOffers(deps, key, 'http://indexer', store, cache)
    const offer = opened()
    finish(offer)
    const [read] = await Promise.all([reader, scan])
    expect(read).toBe(offer)
    expect(verify.open).toHaveBeenCalledTimes(1)
    expect(offer.free).not.toHaveBeenCalled()
  })

  it('does not open an unchanged offer again in a second scan, and opens only the new one', async () => {
    const offers: ReturnType<typeof opened>[] = []
    verify.open.mockImplementation(async () => {
      offers.push(opened())
      return offers[offers.length - 1]
    })
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
    expect(cache.has(TXID_A, 'lender')).toBe(true)

    // a refresh with a new offer: only the new one is opened, the first is kept, not freed
    listed.push(candidate(TXID_B))
    await syncOffers(deps, key, 'http://indexer', makeStore(), cache)
    expect(verify.open).toHaveBeenCalledTimes(2)
    expect(cache.has(TXID_A, 'lender')).toBe(true)
    expect(offers[0].free).not.toHaveBeenCalled()

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
    await keep(cache, TXID_B, gone)
    const store = { get: async () => undefined, set: async () => {} }
    await syncOffers(deps, key, 'http://indexer', store, cache)
    expect(gone.free).toHaveBeenCalledOnce()
    expect(cache.has(TXID_B, 'lender')).toBe(false)
    expect(cache.has(TXID_A, 'lender')).toBe(true)
  })
})
