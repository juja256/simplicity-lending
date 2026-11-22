// The offers opened and verified in this session, kept across scans and reads so that a refresh
// opens only the new ones: opening an offer builds a 1,024-leaf blinder tree in wasm (about 138 ms).
// Keyed by the creation txid and the role it was opened in. The cache owns what it holds: a
// reader never frees a cached offer (`cachedVerifiedOffer`), and the cache frees an offer when
// the scan no longer lists it (`retain`), when another key's session starts, and when the session
// ends (`dropOpenedOffers`). Actions never read from here: they load their offer fresh through the
// gate (`loadVerifiedOffer`), as they free it themselves.
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { VerifiedOffer } from './verify'

export class OpenedOfferCache {
  private readonly entries = new Map<string, VerifiedOffer>()

  private static keyOf(txid: string, role: string): string {
    return `${role}:${txid.toLowerCase()}`
  }

  get(txid: string, role: string): VerifiedOffer | undefined {
    return this.entries.get(OpenedOfferCache.keyOf(txid, role))
  }

  /** Keeps `offer`, which the cache now owns; an offer already kept for the same key is freed. */
  put(txid: string, role: string, offer: VerifiedOffer): void {
    const key = OpenedOfferCache.keyOf(txid, role)
    const previous = this.entries.get(key)
    if (previous !== undefined && previous !== offer) previous.opened.free()
    this.entries.set(key, offer)
  }

  /** Frees the offers whose creation txid is not in `listed`. */
  retain(listed: Iterable<string>): void {
    const keep = new Set([...listed].map(txid => txid.toLowerCase()))
    for (const [key, offer] of this.entries) {
      if (keep.has(key.slice(key.indexOf(':') + 1))) continue
      offer.opened.free()
      this.entries.delete(key)
    }
  }

  /** Frees every offer. */
  clear(): void {
    for (const offer of this.entries.values()) offer.opened.free()
    this.entries.clear()
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
