import type { Address } from 'lwk_wasm'
import { describe, expect, it } from 'vitest'

import { AddressCursor, GAP_LIMIT } from './addressCursor'

/**
 * A wallet whose last unused external and internal indices are set by the test. Its addresses
 * are stand-ins that name their chain and index, like `external/3`.
 */
function fakeWollet() {
  const lastUnused = { external: 0, internal: 0 }
  const result = (chain: 'external' | 'internal', index: number) => ({
    index: () => index,
    address: () => ({ toString: () => `${chain}/${index}` }) as unknown as Address,
  })
  return {
    lastUnused,
    address: (index?: number | null) => result('external', index ?? lastUnused.external),
    change: (index?: number | null) => result('internal', index ?? lastUnused.internal),
  }
}

const names = (addresses: Address[]) => addresses.map(address => address.toString())

describe('AddressCursor', () => {
  it("starts receiving past the wallet's last unused index, the wallet button's", () => {
    const wollet = fakeWollet()
    wollet.lastUnused.external = 4
    const cursor = new AddressCursor()
    expect(cursor.nextReceive(wollet).toString()).toBe('external/5')
  })

  it('gives two receive calls two indices', () => {
    const wollet = fakeWollet()
    wollet.lastUnused.external = 4
    const cursor = new AddressCursor()
    expect(cursor.nextReceive(wollet).toString()).toBe('external/5')
    expect(cursor.nextReceive(wollet).toString()).toBe('external/6')
  })

  it("follows the wallet's last unused index once it moves past the ones handed out", () => {
    const wollet = fakeWollet()
    wollet.lastUnused.external = 4
    const cursor = new AddressCursor()
    cursor.nextReceive(wollet)
    cursor.nextReceive(wollet)
    wollet.lastUnused.external = 9
    expect(cursor.nextReceive(wollet).toString()).toBe('external/10')
  })

  it('never gives a fresh wallet its address 0, its identity', () => {
    const wollet = fakeWollet()
    const cursor = new AddressCursor()
    expect(cursor.nextReceive(wollet).toString()).toBe('external/1')
    expect(cursor.nextReceive(wollet).toString()).toBe('external/2')
  })

  it('gives two consecutive change indices, and the next call continues after them', () => {
    const wollet = fakeWollet()
    wollet.lastUnused.internal = 7
    const cursor = new AddressCursor()
    expect(names(cursor.nextChange(wollet, 2))).toEqual(['internal/7', 'internal/8'])
    expect(names(cursor.nextChange(wollet, 1))).toEqual(['internal/9'])
  })

  it('keeps the receive and change chains apart', () => {
    const wollet = fakeWollet()
    wollet.lastUnused.external = 3
    wollet.lastUnused.internal = 3
    const cursor = new AddressCursor()
    expect(cursor.nextReceive(wollet).toString()).toBe('external/4')
    expect(names(cursor.nextChange(wollet, 1))).toEqual(['internal/3'])
  })

  it('repeats the receive address at the gap limit bound', () => {
    const wollet = fakeWollet()
    wollet.lastUnused.external = 10
    const cursor = new AddressCursor()
    const bound = 10 + GAP_LIMIT - 1
    // From the last unused index plus one to the bound.
    const handedOut = Array.from({ length: GAP_LIMIT - 1 }, () =>
      cursor.nextReceive(wollet).toString(),
    )
    expect(new Set(handedOut).size).toBe(GAP_LIMIT - 1)
    expect(handedOut[0]).toBe('external/11')
    expect(handedOut.at(-1)).toBe(`external/${bound}`)
    expect(cursor.nextReceive(wollet).toString()).toBe(`external/${bound}`)
    expect(cursor.nextReceive(wollet).toString()).toBe(`external/${bound}`)
  })

  it('moves on from the bound once a scan raises the last unused index', () => {
    const wollet = fakeWollet()
    wollet.lastUnused.external = 10
    const cursor = new AddressCursor()
    const bound = 10 + GAP_LIMIT - 1
    for (let i = 0; i < GAP_LIMIT + 2; i += 1) cursor.nextReceive(wollet)
    expect(cursor.nextReceive(wollet).toString()).toBe(`external/${bound}`)
    // A scan saw a transaction to index 12: LWK's last unused index is 13.
    wollet.lastUnused.external = 13
    expect(cursor.nextReceive(wollet).toString()).toBe(`external/${bound + 1}`)
    expect(cursor.nextReceive(wollet).toString()).toBe(`external/${bound + 2}`)
  })

  it('repeats the last change addresses at the bound, still two apart from each other', () => {
    const wollet = fakeWollet()
    const cursor = new AddressCursor()
    const bound = GAP_LIMIT - 1
    for (let i = 0; i < GAP_LIMIT; i += 1) cursor.nextChange(wollet, 1)
    expect(names(cursor.nextChange(wollet, 1))).toEqual([`internal/${bound}`])
    expect(names(cursor.nextChange(wollet, 2))).toEqual([
      `internal/${bound - 1}`,
      `internal/${bound}`,
    ])
  })

  it('reports each address it hands out', () => {
    const wollet = fakeWollet()
    const handedOut: string[] = []
    const cursor = new AddressCursor((chain, index) => handedOut.push(`${chain} ${index}`))
    cursor.nextReceive(wollet)
    cursor.nextChange(wollet, 2)
    expect(handedOut).toEqual(['receive 1', 'change 0', 'change 1'])
  })

  it('refuses a change count it cannot hand out within the gap limit', () => {
    const cursor = new AddressCursor()
    expect(() => cursor.nextChange(fakeWollet(), 0)).toThrow()
    expect(() => cursor.nextChange(fakeWollet(), GAP_LIMIT + 1)).toThrow()
  })
})
