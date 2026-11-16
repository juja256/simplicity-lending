import { describe, expect, it } from 'vitest'

import { wasm } from '@/test/wasm'

import type { EntryCheck } from './directory'
import type { PrivateOfferTerms } from './hooks/usePrivateOffers'
import {
  BLOCKS_PER_DAY,
  type PairTermsInput,
  pairTermsToForm,
  proposalExpiry,
  type ProposalInput,
  TERM_MARGIN_BLOCKS,
  type TermsPair,
  unitsFromDecimal,
  unitsToDecimal,
} from './lenderTerms'
import {
  breachLabel,
  checkAgainstTerms,
  type ProposalForm,
  proposalFormErrors,
  proposalLimits,
  proposalOfOffer,
  repaymentAt,
} from './proposalCheck'

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

const TEST = (whole: bigint): bigint => whole * 10n ** 8n

/** A proposal of `principal` over `days` at the least collateral and the least repayment. */
function leastProposal(principal: bigint, days: number): ProposalInput {
  const limits = proposalLimits(wasm, PAIR, principal, days)
  return {
    principal_asset: PAIR.principal_asset,
    collateral_asset: PAIR.collateral_asset,
    principal_amount: principal.toString(),
    collateral_amount: limits.minCollateral.toString(),
    repayment_amount: limits.minRepayment.toString(),
    term_blocks: days * BLOCKS_PER_DAY,
  }
}

describe('checkAgainstTerms', () => {
  it('finds a proposal exactly at every minimum within the terms', () => {
    const proposal = leastProposal(BigInt(PAIR.min_principal), PAIR.min_term_days)
    expect(checkAgainstTerms(wasm, OWN, proposal, PAIR_INFO)).toEqual({ kind: 'within' })
  })

  it('finds a proposal exactly at every maximum within the terms', () => {
    const proposal = leastProposal(BigInt(PAIR.max_principal), PAIR.max_term_days)
    expect(checkAgainstTerms(wasm, OWN, proposal, PAIR_INFO)).toEqual({ kind: 'within' })
  })

  it('names the least collateral for one unit of collateral below it', () => {
    const proposal = leastProposal(TEST(3_950n), PAIR.min_term_days)
    expect(proposal.collateral_amount).toBe('7900000')
    const below = { ...proposal, collateral_amount: '7899999' }
    expect(checkAgainstTerms(wasm, OWN, below, PAIR_INFO)).toEqual({
      kind: 'outside',
      breaches: ['CollateralBelowMinimum'],
      labels: ['collateral below 0.079 tL-BTC'],
    })
  })

  it('names the least APR for a repayment one unit below the least', () => {
    const proposal = leastProposal(TEST(3_950n), PAIR.min_term_days)
    const below = { ...proposal, repayment_amount: String(BigInt(proposal.repayment_amount) - 1n) }
    expect(checkAgainstTerms(wasm, OWN, below, PAIR_INFO)).toEqual({
      kind: 'outside',
      breaches: ['AprBelowMinimum'],
      labels: ['APR below 6 %'],
    })
  })

  it('names every term a proposal breaks, in the core order', () => {
    const proposal: ProposalInput = {
      ...leastProposal(TEST(60_000n), 200),
      collateral_amount: '1',
      repayment_amount: TEST(60_000n).toString(),
    }
    expect(checkAgainstTerms(wasm, OWN, proposal, PAIR_INFO)).toEqual({
      kind: 'outside',
      breaches: [
        'PrincipalAboveRange',
        'TermAboveRange',
        'AprBelowMinimum',
        'CollateralBelowMinimum',
      ],
      labels: [
        'principal above 50,000 TEST',
        'term longer than 180 days',
        'APR below 6 %',
        'collateral below 1.2 tL-BTC',
      ],
    })
  })

  it('finds a proposal of other assets outside the terms', () => {
    const proposal = {
      ...leastProposal(BigInt(PAIR.min_principal), PAIR.min_term_days),
      collateral_asset: 'c0'.repeat(32),
    }
    expect(checkAgainstTerms(wasm, OWN, proposal, PAIR_INFO)).toEqual({
      kind: 'outside',
      breaches: ['UnsupportedPair'],
      labels: ['pair you do not lend'],
    })
  })

  it('finds every proposal outside verified terms without the pair', () => {
    const other = { ...PAIR, collateral_asset: 'c0'.repeat(32) }
    const own: EntryCheck = { status: 'verified', terms: { pairs: [other] } }
    const proposal = leastProposal(BigInt(PAIR.min_principal), PAIR.min_term_days)
    expect(checkAgainstTerms(wasm, own, proposal, PAIR_INFO)).toEqual({
      kind: 'outside',
      breaches: ['UnsupportedPair'],
      labels: ['pair you do not lend'],
    })
  })

  it('knows nothing without terms that verify', () => {
    const proposal = leastProposal(BigInt(PAIR.min_principal), PAIR.min_term_days)
    expect(checkAgainstTerms(wasm, null, proposal, PAIR_INFO)).toEqual({
      kind: 'unknown',
      reason: 'no-terms',
    })
    expect(checkAgainstTerms(wasm, { status: 'invalid' }, proposal, PAIR_INFO)).toEqual({
      kind: 'unknown',
      reason: 'unverified',
    })
    expect(checkAgainstTerms(wasm, { status: 'unsigned' }, proposal, PAIR_INFO)).toEqual({
      kind: 'unknown',
      reason: 'unverified',
    })
  })
})

describe('breachLabel', () => {
  it("names each breach with the lender's figure", () => {
    const label = (breach: Parameters<typeof breachLabel>[0]) =>
      breachLabel(breach, PAIR, PAIR_INFO)
    expect(label('UnsupportedPair')).toBe('pair you do not lend')
    expect(label('PrincipalBelowRange')).toBe('principal below 1,000 TEST')
    expect(label('PrincipalAboveRange')).toBe('principal above 50,000 TEST')
    expect(label('TermBelowRange')).toBe('term shorter than 30 days')
    expect(label('TermAboveRange')).toBe('term longer than 180 days')
    expect(label('AprBelowMinimum')).toBe('APR below 6 %')
    expect(label('CollateralBelowMinimum')).toBe('collateral below 1 tL-BTC per 50,000 TEST')
    expect(breachLabel('CollateralBelowMinimum', PAIR, PAIR_INFO, 7_900_000n)).toBe(
      'collateral below 0.079 tL-BTC',
    )
  })

  it('says a single day', () => {
    const oneDay = { ...PAIR, min_term_days: 1, max_term_days: 1 }
    expect(breachLabel('TermBelowRange', oneDay, PAIR_INFO)).toBe('term shorter than 1 day')
    expect(breachLabel('TermAboveRange', oneDay, PAIR_INFO)).toBe('term longer than 1 day')
  })
})

describe('the proposal form', () => {
  /** The form at the least principal, term, collateral and APR of the pair. */
  function leastForm(): ProposalForm {
    const principal = BigInt(PAIR.min_principal)
    const { minCollateral } = proposalLimits(wasm, PAIR, principal, PAIR.min_term_days)
    return {
      principal: unitsToDecimal(principal, PAIR_INFO.principal.decimals),
      days: String(PAIR.min_term_days),
      collateral: unitsToDecimal(minCollateral, PAIR_INFO.collateral.decimals),
      aprPercent: pairTermsToForm(PAIR, PAIR_INFO).minAprPercent,
    }
  }

  const errors = (form: Partial<ProposalForm>) =>
    proposalFormErrors(wasm, PAIR, PAIR_INFO, { ...leastForm(), ...form })

  it('takes the least principal, term, collateral and APR', () => {
    expect(leastForm()).toEqual({
      principal: '1000',
      days: '30',
      collateral: '0.02',
      aprPercent: '6',
    })
    expect(errors({})).toEqual({})
  })

  it('refuses an APR a basis point below the least', () => {
    expect(errors({ aprPercent: '5.99' })).toEqual({ aprPercent: "The lender's least APR is 6 %." })
  })

  it('refuses an APR with more than two decimals', () => {
    expect(Object.keys(errors({ aprPercent: '6.001' }))).toEqual(['aprPercent'])
  })

  it('refuses one unit of collateral below the least, naming the least', () => {
    expect(errors({ collateral: '0.01999999' })).toEqual({
      collateral: 'The lender needs at least 0.02 tL-BTC for this principal.',
    })
  })

  it('refuses a term outside the range', () => {
    const outside = { days: 'The lender lends for 30 to 180 days.' }
    expect(errors({ days: '29' })).toEqual(outside)
    expect(errors({ days: '181' })).toEqual(outside)
  })

  it('refuses 0 days and the most days a lender can allow plus one', () => {
    const wide = { ...PAIR, min_term_days: 1, max_term_days: 3650 }
    const form = { ...leastForm(), days: '0' }
    const outside = { days: 'The lender lends for 1 to 3,650 days.' }
    expect(proposalFormErrors(wasm, wide, PAIR_INFO, form)).toEqual(outside)
    expect(proposalFormErrors(wasm, wide, PAIR_INFO, { ...form, days: '3651' })).toEqual(outside)
    expect(Object.keys(errors({ days: '30.5' }))).toEqual(['days'])
  })

  it('refuses a principal outside the range', () => {
    const outside = { principal: 'The lender lends 1,000 to 50,000 TEST.' }
    expect(errors({ principal: '999.99999999' })).toEqual(outside)
    expect(errors({ principal: '50000.00000001', collateral: '2' })).toEqual(outside)
    expect(errors({ principal: '0' })).toEqual(outside)
  })

  it('refuses more decimals than the asset has', () => {
    const tooPrecise = { principal: '1.000000001', collateral: '1.000000001' }
    expect(errors(tooPrecise)).toEqual({
      principal: 'Enter an amount with at most 8 decimals.',
      collateral: 'Enter an amount with at most 8 decimals.',
    })
  })

  it('refuses a malformed number', () => {
    const result = errors({ principal: 'ten', days: '', collateral: '-1', aprPercent: 'six' })
    expect(Object.keys(result).sort()).toEqual(['aprPercent', 'collateral', 'days', 'principal'])
  })

  it('repays the least repayment at the least APR', () => {
    const principal = TEST(3_950n)
    const { minRepayment } = proposalLimits(wasm, PAIR, principal, 45)
    expect(repaymentAt(wasm, principal, PAIR.min_apr_bps, 45)).toBe(minRepayment)
    expect(repaymentAt(wasm, principal, PAIR.min_apr_bps - 1, 45)).toBeLessThan(minRepayment)
  })

  it('builds a proposal within the terms from its least values', () => {
    const form = leastForm()
    const principal = BigInt(PAIR.min_principal)
    const days = Number(form.days)
    const proposal: ProposalInput = {
      principal_asset: PAIR.principal_asset,
      collateral_asset: PAIR.collateral_asset,
      principal_amount: principal.toString(),
      collateral_amount: unitsFromDecimal(
        form.collateral,
        PAIR_INFO.collateral.decimals,
      ).toString(),
      repayment_amount: repaymentAt(wasm, principal, PAIR.min_apr_bps, days).toString(),
      term_blocks: days * BLOCKS_PER_DAY,
    }
    expect(checkAgainstTerms(wasm, OWN, proposal, PAIR_INFO)).toEqual({ kind: 'within' })
  })
})

describe('proposalOfOffer', () => {
  it("counts the offer's term by the term rule", () => {
    const tip = 2_000_000
    const terms = {
      principalAsset: PAIR.principal_asset,
      collateralAsset: PAIR.collateral_asset,
      principalAmount: TEST(3_950n),
      collateralAmount: 7_900_000n,
      repaymentAmount: TEST(4_000n),
      loanExpirationTime: proposalExpiry(tip, 30),
    } as PrivateOfferTerms
    const proposal = {
      principal_asset: PAIR.principal_asset,
      collateral_asset: PAIR.collateral_asset,
      principal_amount: '395000000000',
      collateral_amount: '7900000',
      repayment_amount: '400000000000',
      term_blocks: 30 * BLOCKS_PER_DAY,
    }
    expect(proposalOfOffer(terms, tip + 1)).toEqual(proposal)
    expect(proposalOfOffer(terms, tip + 61)).toEqual({
      ...proposal,
      term_blocks: 29 * BLOCKS_PER_DAY,
    })
  })

  it('flags a confirmation later than the margin as shorter than the shortest term', () => {
    const tip = 2_000_000
    const days = PAIR.min_term_days
    const principal = TEST(3_950n)
    const { minCollateral, minRepayment } = proposalLimits(wasm, PAIR, principal, days)
    const terms: PrivateOfferTerms = {
      borrowerPublicKey: 'b'.repeat(64),
      borrowerFingerprint: 'b'.repeat(16),
      lenderPublicKey: 'c'.repeat(64),
      lenderFingerprint: 'c'.repeat(16),
      collateralAsset: PAIR.collateral_asset,
      collateralAmount: minCollateral,
      principalAsset: PAIR.principal_asset,
      principalAmount: principal,
      repaymentAmount: minRepayment,
      interest: minRepayment - principal,
      loanExpirationTime: proposalExpiry(tip, days),
      borrowerNft: 'e'.repeat(64),
      lenderNft: 'f'.repeat(64),
    }

    const onTime = proposalOfOffer(terms, tip + TERM_MARGIN_BLOCKS)
    expect(onTime.term_blocks).toBe(days * BLOCKS_PER_DAY)
    expect(checkAgainstTerms(wasm, OWN, onTime, PAIR_INFO)).toEqual({ kind: 'within' })

    const late = proposalOfOffer(terms, tip + TERM_MARGIN_BLOCKS + 1)
    expect(late.term_blocks).toBe((days - 1) * BLOCKS_PER_DAY)
    expect(checkAgainstTerms(wasm, OWN, late, PAIR_INFO)).toEqual({
      kind: 'outside',
      breaches: ['TermBelowRange'],
      labels: ['term shorter than 30 days'],
    })
  })
})
