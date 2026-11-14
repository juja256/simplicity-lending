import { describe, expect, it } from 'vitest'

import { BLOCKS_PER_DAY, proposalExpiry, TERM_MARGIN_BLOCKS, termBlocksOf } from './lenderTerms'

describe('the term rule', () => {
  const tip = 1_000_000
  const days = 30
  const expiry = proposalExpiry(tip, days)

  it('sets the expiry the days and the margin after the tip', () => {
    expect(expiry).toBe(tip + days * BLOCKS_PER_DAY + TERM_MARGIN_BLOCKS)
    expect(TERM_MARGIN_BLOCKS).toBe(60)
  })

  it('counts the chosen days for a creation one block after the tip', () => {
    expect(termBlocksOf(expiry, tip + 1)).toBe(days * BLOCKS_PER_DAY)
  })

  it('counts the chosen days for a creation the margin after the tip', () => {
    expect(termBlocksOf(expiry, tip + TERM_MARGIN_BLOCKS)).toBe(days * BLOCKS_PER_DAY)
  })

  it('counts a day less for a creation one block later', () => {
    expect(termBlocksOf(expiry, tip + TERM_MARGIN_BLOCKS + 1)).toBe((days - 1) * BLOCKS_PER_DAY)
  })

  it('counts no term for an expiry at or before the creation block', () => {
    expect(termBlocksOf(expiry, expiry)).toBe(0)
    expect(termBlocksOf(expiry, expiry + 1)).toBe(0)
    expect(termBlocksOf(expiry, expiry + 10 * BLOCKS_PER_DAY)).toBe(0)
  })

  it('counts no term for an expiry less than a day after the creation block', () => {
    expect(termBlocksOf(expiry, expiry - BLOCKS_PER_DAY + 1)).toBe(0)
    expect(termBlocksOf(expiry, expiry - BLOCKS_PER_DAY)).toBe(BLOCKS_PER_DAY)
  })
})
