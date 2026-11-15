import { describe, expect, it } from 'vitest'

import {
  BLOCKS_PER_DAY,
  type LenderTermsInput,
  type PairTermsInput,
  proposalExpiry,
  TERM_MARGIN_BLOCKS,
  termBlocksOf,
  type TermsPair,
  termsToPublish,
} from './lenderTerms'

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

describe('the terms a lender publishes', () => {
  const pair: TermsPair = {
    collateral: { id: 'cc'.repeat(32), symbol: 'C', decimals: 8 },
    principal: { id: 'dd'.repeat(32), symbol: 'P', decimals: 2 },
  }
  const configured: PairTermsInput = {
    principal_asset: pair.principal.id,
    collateral_asset: pair.collateral.id,
    min_apr_bps: 600,
    max_principal_per_collateral: '5000000',
    min_term_days: 1,
    max_term_days: 30,
    min_principal: '100',
    max_principal: '100000',
  }
  const published: PairTermsInput = { ...configured, min_apr_bps: 500, max_term_days: 60 }
  const other: PairTermsInput = { ...configured, principal_asset: 'ab'.repeat(32) }
  const formTerms: LenderTermsInput = { pairs: [configured] }

  it("publishes the form's pair alone without verified terms", () => {
    expect(termsToPublish(formTerms, null, pair)).toEqual({ pairs: [configured] })
  })

  it("replaces the verified terms' configured pair with the form's", () => {
    expect(termsToPublish(formTerms, { pairs: [published] }, pair)).toEqual({
      pairs: [configured],
    })
  })

  it('keeps the verified pairs for other assets', () => {
    expect(termsToPublish(formTerms, { pairs: [published, other] }, pair)).toEqual({
      pairs: [configured, other],
    })
  })
})
