// The offers opened and verified in this session, kept across scans and reads so that a refresh
// opens only the new ones: opening an offer builds a 1,024-leaf blinder tree in wasm (about 138 ms).
// Keyed by the creation txid and the role it was opened in. The cache owns what it holds: a
// reader works with a cached offer inside `use` and never frees it, and the cache frees an offer
// when the scan no longer lists it (`retain`), when another key's session starts, and when the
// session ends (`dropOpenedOffers`), each time once no reader is inside `use` with it. Actions never read from here: they load their offer fresh through the
// gate (`loadVerifiedOffer`), as they free it themselves.
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { VerifiedOffer } from './verify'

interface Entry {
  offer: Promise<VerifiedOffer>
  /** The offer once opened. */
  loaded?: VerifiedOffer
  /** Readers inside `use`, the entry's opening included. */
  users: number
  /** Dropped from the cache: freed when its last reader is done. */
  retired: boolean
}

export class OpenedOfferCache {
  private readonly entries = new Map<string, Entry>()

  private static keyOf(txid: string, role: string): string {
    return `${role}:${txid.toLowerCase()}`
  }

  /** Whether an offer for the key is opened and kept. */
  has(txid: string, role: string): boolean {
    return this.entries.get(OpenedOfferCache.keyOf(txid, role))?.loaded !== undefined
  }

  /**
   * Runs `read` with the offer of the key, opened by `open` when the cache has none: concurrent
   * readers of one key share one opening, and a failed opening is not kept. The cache owns the
   * offer, so `read` must not free it, and must not keep it past its return. An offer dropped
   * meanwhile (`retain`, `clear`) is freed only when its last reader is done.
   */
  async use<T>(
    txid: string,
    role: string,
    open: () => Promise<VerifiedOffer>,
    read: (offer: VerifiedOffer) => Promise<T> | T,
  ): Promise<T> {
    const key = OpenedOfferCache.keyOf(txid, role)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      const created: Entry = { offer: open(), users: 0, retired: false }
      created.offer.then(
        offer => {
          created.loaded = offer
        },
        () => {
          if (this.entries.get(key) === created) this.entries.delete(key)
        },
      )
      this.entries.set(key, created)
      entry = created
    }
    entry.users += 1
    try {
      return await read(await entry.offer)
    } finally {
      entry.users -= 1
      this.release(entry)
    }
  }

  private release(entry: Entry): void {
    if (!entry.retired || entry.users > 0 || entry.loaded === undefined) return
    entry.loaded.opened.free()
    entry.loaded = undefined
  }

  private retire(key: string, entry: Entry): void {
    this.entries.delete(key)
    entry.retired = true
    this.release(entry)
  }

  /** Drops the offers whose creation txid is not in `listed`; a reader keeps its offer meanwhile. */
  retain(listed: Iterable<string>): void {
    const keep = new Set([...listed].map(txid => txid.toLowerCase()))
    for (const [key, entry] of [...this.entries]) {
      if (!keep.has(key.slice(key.indexOf(':') + 1))) this.retire(key, entry)
    }
  }

  /** Drops every offer. */
  clear(): void {
    for (const [key, entry] of [...this.entries]) this.retire(key, entry)
  }

  get size(): number {
    return this.entries.size
  }
}

let current: { key: LendingKey; cache: OpenedOfferCache } | null = null

/**
 * The cache of `key`'s session. Another key starts a new one: the old session's offers are freed,
 * as they were opened with a key that is gone.
 */
export function openedOffersOf(key: LendingKey): OpenedOfferCache {
  if (current?.key === key) return current.cache
  current?.cache.clear()
  current = { key, cache: new OpenedOfferCache() }
  return current.cache
}

/** Frees every cached offer: the session ended. */
export function dropOpenedOffers(): void {
  current?.cache.clear()
  current = null
}
