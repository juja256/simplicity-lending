// New receive and change addresses for every private flow of one wallet session. DOM-free, so the
// e2e script uses it too.
import type { Address } from 'lwk_wasm'

/**
 * LWK's gap limit: a scan stops after this many unused addresses in a row, so a restored wallet
 * finds an address only if it is fewer than this many past the last used one.
 */
export const GAP_LIMIT = 20

/** The part of LWK's `Wollet` the cursor reads: an address, or the last unused one, of a chain. */
export interface AddressSource {
  address(index?: number | null): { index(): number; address(): Address }
  change(index?: number | null): { index(): number; address(): Address }
}

export type AddressChain = 'receive' | 'change'

/**
 * Hands out new receive and change addresses across the flows of one wallet session. LWK's last
 * unused index moves only when a scan sees a transaction: applying a broadcast keeps it as it
 * was, so two flows before a scan would get the same addresses. The cursor keeps the highest
 * index it handed out on each chain and gives the next one from the higher of its chain's floor
 * and that one plus one.
 *
 * A receive address starts past LWK's last unused index, the one the wallet button shows
 * (`currentReceiveAddress`): that address stays the user's to share, and a payment to it is not
 * linked to a loan. So the receive floor is the last unused index plus one, which is never index
 * 0, the wallet's identity (`walletIdentityScript`); the change floor is the last unused index.
 * No address is past the last unused index plus `GAP_LIMIT - 1`, the last one a restored wallet
 * still finds. At that bound the cursor hands out the bound again: the funds still reach the
 * wallet, only privacy is lost. Once a scan raises the last unused index, the cursor moves on.
 * Keep one cursor per wallet session and drop it with the session.
 */
export class AddressCursor {
  private readonly next: Record<AddressChain, number> = { receive: 0, change: 0 }

  /** `onHandOut` is told each index handed out, for a log. */
  constructor(
    private readonly onHandOut?: (chain: AddressChain, index: number, address: Address) => void,
  ) {}

  /** A new external address for a builder's receiver, past the one the wallet button shows. */
  nextReceive(wollet: AddressSource): Address {
    const lastUnused = wollet.address(null).index()
    return this.take('receive', lastUnused, lastUnused + 1, 1, index =>
      wollet.address(index).address(),
    )[0]
  }

  /**
   * `count` new internal addresses at consecutive indices, for a flow's change outputs. At the
   * bound they are the last `count` indices up to it, so the ones of one call stay apart.
   */
  nextChange(wollet: AddressSource, count: number): Address[] {
    const lastUnused = wollet.change(null).index()
    return this.take('change', lastUnused, lastUnused, count, index =>
      wollet.change(index).address(),
    )
  }

  private take(
    chain: AddressChain,
    lastUnused: number,
    floor: number,
    count: number,
    addressAt: (index: number) => Address,
  ): Address[] {
    if (!Number.isInteger(count) || count < 1 || count > GAP_LIMIT - (floor - lastUnused)) {
      throw new Error(`Cannot hand out ${count} addresses within the gap limit`)
    }
    const bound = lastUnused + GAP_LIMIT - 1
    const start = Math.min(Math.max(floor, this.next[chain]), bound - count + 1)
    this.next[chain] = Math.max(this.next[chain], start + count)
    return Array.from({ length: count }, (_, offset) => {
      const index = start + offset
      const address = addressAt(index)
      this.onHandOut?.(chain, index, address)
      return address
    })
  }
}
