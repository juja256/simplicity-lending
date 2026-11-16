import { describe, expect, it } from 'vitest'

import type { EntryCheck } from '@/privateLending/directory'
import type { PrivateOfferTerms } from '@/privateLending/hooks/usePrivateOffers'
import {
  BLOCKS_PER_DAY,
  type PairTermsInput,
  proposalExpiry,
  TERM_MARGIN_BLOCKS,
  type TermsPair,
} from '@/privateLending/lenderTerms'
import { proposalLimits } from '@/privateLending/proposalCheck'
import { wasm } from '@/test/wasm'

import { creationHeightOf, proposalFigures } from './proposalFigures'

const PAIR_INFO: TermsPair = {
  principal: { id: 'a0'.repeat(32), decimals: 8, symbol: 'TEST' },
  collateral: { id: 'b0'.repeat(32), decimals: 8, symbol: 'tL-BTC' },
}

/** At least 6 %, at most 50,000 TEST per tL-BTC, 30 to 180 days, 1,000 to 50,000 TEST. */
const PAIR: PairTermsInput = {
  principal_asset: PAIR_INFO.principal.id,
  collateral_asset: PAIR_INFO.collateral.id,
  min_apr_bps: 600,
  max_principal_per_collateral: '5000000000000',
  min_term_days: 30,
  max_term_days: 180,
  min_principal: '100000000000',
  max_principal: '5000000000000',
}

const OWN: EntryCheck = { status: 'verified', terms: { pairs: [PAIR] } }

const TIP = 2_000_000
const DAYS = 30
const PRINCIPAL = 3_950n * 10n ** 8n

/** A proposal of 3,950 TEST built at `TIP` for 30 days, at the least collateral and repayment. */
function terms(): PrivateOfferTerms {
  const { minCollateral, minRepayment } = proposalLimits(wasm, PAIR, PRINCIPAL, DAYS)
  return {
    borrowerPublicKey: 'b'.repeat(64),
    borrowerFingerprint: 'b'.repeat(16),
    lenderPublicKey: 'c'.repeat(64),
    lenderFingerprint: 'c'.repeat(16),
    collateralAsset: PAIR.collateral_asset,
    collateralAmount: minCollateral,
    principalAsset: PAIR.principal_asset,
    principalAmount: PRINCIPAL,
    repaymentAmount: minRepayment,
    interest: minRepayment - PRINCIPAL,
    loanExpirationTime: proposalExpiry(TIP, DAYS),
    borrowerNft: 'e'.repeat(64),
    lenderNft: 'f'.repeat(64),
  }
}

describe('creationHeightOf', () => {
  it("takes esplora's block height of a confirmed transaction", () => {
    expect(creationHeightOf({ confirmed: true, block_height: TIP + 1 })).toBe(TIP + 1)
  })

  it('has no height for an unconfirmed transaction', () => {
    expect(creationHeightOf({ confirmed: false })).toBeNull()
    expect(creationHeightOf({ confirmed: false, block_height: TIP + 1 })).toBeNull()
    expect(creationHeightOf({ confirmed: true })).toBeNull()
  })
})

describe('proposalFigures', () => {
  it('shows and checks nothing until the creation height is known', () => {
    expect(proposalFigures(wasm, terms(), undefined, OWN, PAIR_INFO)).toBeUndefined()
    expect(proposalFigures(wasm, terms(), null, OWN, PAIR_INFO)).toBeUndefined()
  })

  it('counts the chosen days, their APR and the verdict from the creation height', () => {
    const offer = terms()
    expect(proposalFigures(wasm, offer, TIP + TERM_MARGIN_BLOCKS, OWN, PAIR_INFO)).toEqual({
      termBlocks: DAYS * BLOCKS_PER_DAY,
      aprBps: wasm.aprBps(offer.principalAmount, offer.repaymentAmount, DAYS * BLOCKS_PER_DAY),
      principalPerCollateral: wasm.principalPerCollateral(
        offer.principalAmount,
        offer.collateralAmount,
      ),
      verdict: { kind: 'within' },
    })
  })

  it('counts a day less, a higher APR and a short term from a later height', () => {
    const offer = terms()
    const atTerm = proposalFigures(wasm, offer, TIP + 1, OWN, PAIR_INFO)
    const later = proposalFigures(wasm, offer, TIP + TERM_MARGIN_BLOCKS + 1, OWN, PAIR_INFO)
    expect(later?.termBlocks).toBe((DAYS - 1) * BLOCKS_PER_DAY)
    expect(later?.aprBps).toBeGreaterThan(atTerm?.aprBps ?? 0n)
    expect(later?.verdict).toEqual({
      kind: 'outside',
      breaches: ['TermBelowRange'],
      labels: ['term shorter than 30 days'],
    })
  })

  it("waits for the lender's own entry before the verdict", () => {
    const figures = proposalFigures(wasm, terms(), TIP + 1, undefined, PAIR_INFO)
    expect(figures?.termBlocks).toBe(DAYS * BLOCKS_PER_DAY)
    expect(figures?.verdict).toBeUndefined()
    expect(proposalFigures(wasm, terms(), TIP + 1, null, PAIR_INFO)?.verdict).toEqual({
      kind: 'unknown',
      reason: 'no-terms',
    })
  })
})
