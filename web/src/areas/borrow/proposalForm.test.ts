import { describe, expect, it } from 'vitest'

import {
  BLOCKS_PER_DAY,
  type PairTermsInput,
  proposalExpiry,
  type TermsPair,
} from '@/privateLending/lenderTerms'
import { proposalFormErrors, proposalLimits } from '@/privateLending/proposalCheck'
import { wasm } from '@/test/wasm'

import {
  amountText,
  dateAfterBlocks,
  editProposalForm,
  formatDay,
  loanAmounts,
  openProposalForm,
  type ProposalFormState,
  proposalOfForm,
  timeAgo,
} from './proposalForm'

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

const opened = () => openProposalForm(wasm, PAIR, PAIR_INFO)
const edit = (state: ProposalFormState, field: keyof ProposalFormState['form'], value: string) =>
  editProposalForm(wasm, PAIR, PAIR_INFO, state, field, value)

describe('openProposalForm', () => {
  it("opens at the lender's minimums, the collateral the least for the least principal", () => {
    expect(opened()).toEqual({
      form: { principal: '1000', days: '30', collateral: '0.02', aprPercent: '6' },
      typedCollateral: null,
    })
  })

  it('opens on a proposal within the terms, at the least repayment', () => {
    const { form } = opened()
    expect(proposalFormErrors(wasm, PAIR, PAIR_INFO, form)).toEqual({})
    const result = proposalOfForm(wasm, PAIR, PAIR_INFO, form)
    const limits = proposalLimits(wasm, PAIR, 1000n * 10n ** 8n, 30)
    expect(result.proposal).toEqual({
      principal: 1000n * 10n ** 8n,
      collateral: limits.minCollateral,
      repayment: limits.minRepayment,
      days: 30,
      aprBps: 600,
    })
  })
})

describe('editProposalForm', () => {
  it('raises the collateral to the least for a larger principal', () => {
    const state = edit(opened(), 'principal', '3950')
    expect(state.form.collateral).toBe('0.079')
  })

  it('follows the least down while the borrower has typed no collateral', () => {
    const state = edit(edit(opened(), 'principal', '3950'), 'principal', '2000')
    expect(state.form.collateral).toBe('0.04')
  })

  it('keeps the collateral typed when it is above the least for the new principal', () => {
    let state = edit(opened(), 'collateral', '0.1')
    state = edit(state, 'principal', '3950')
    expect(state.form.collateral).toBe('0.1')
    state = edit(state, 'principal', '1000')
    expect(state.form.collateral).toBe('0.1')
  })

  it('raises the collateral typed to the least, and returns to it when the principal drops', () => {
    let state = edit(opened(), 'collateral', '0.05')
    state = edit(state, 'principal', '5000')
    expect(state.form.collateral).toBe('0.1')
    // A principal on its way to a larger figure must not leave the collateral raised.
    state = edit(state, 'principal', '2000')
    expect(state.form.collateral).toBe('0.05')
  })

  it('keeps the collateral as typed, with its own zeros, when it covers the least', () => {
    const state = edit(edit(opened(), 'collateral', '0.050'), 'principal', '2000')
    expect(state.form.collateral).toBe('0.050')
  })

  it('raises a collateral typed below the least when the term changes', () => {
    let state = edit(opened(), 'collateral', '0.01')
    expect(state.form.collateral).toBe('0.01')
    state = edit(state, 'days', '45')
    expect(state.form).toMatchObject({ days: '45', collateral: '0.02' })
  })

  it('replaces a collateral typed that is not an amount with the least', () => {
    const state = edit(edit(opened(), 'collateral', '0.0x'), 'principal', '1500')
    expect(state.form.collateral).toBe('0.03')
  })

  it('leaves the collateral alone while the principal is not an amount', () => {
    let state = edit(opened(), 'principal', '')
    expect(state.form.collateral).toBe('0.02')
    state = edit(state, 'principal', '12.')
    expect(state.form.collateral).toBe('0.02')
  })

  it('leaves the collateral alone when the APR changes', () => {
    const state = edit(edit(opened(), 'collateral', '0.01'), 'aprPercent', '7')
    expect(state.form).toMatchObject({ collateral: '0.01', aprPercent: '7' })
  })
})

describe('proposalOfForm', () => {
  it("gives the errors of the lender's terms and no proposal", () => {
    const form = { principal: '999', days: '29', collateral: '0.01', aprPercent: '5.99' }
    const result = proposalOfForm(wasm, PAIR, PAIR_INFO, form)
    expect(result.proposal).toBeNull()
    expect(Object.keys(result.errors ?? {}).sort()).toEqual(['aprPercent', 'days', 'principal'])
  })

  it('repays at the APR typed over the days typed', () => {
    const form = { principal: '5000', days: '90', collateral: '0.1', aprPercent: '7.25' }
    const result = proposalOfForm(wasm, PAIR, PAIR_INFO, form)
    expect(result.errors).toBeNull()
    expect(result.proposal?.repayment).toBe(
      wasm.minRepayment(5000n * 10n ** 8n, 725, 90 * BLOCKS_PER_DAY),
    )
    expect(result.proposal?.aprBps).toBe(725)
  })

  it("refuses a message a byte over its limit with the counter's error, sends one at it", () => {
    const { form } = opened()
    // 728 emoji of 4 bytes and 3 bytes of ASCII: 2915 bytes, counted in UTF-8
    const atLimit = '😀'.repeat(728) + 'abc'
    expect(proposalOfForm(wasm, PAIR, PAIR_INFO, form, atLimit + 'd')).toEqual({
      proposal: null,
      errors: { message: 'The message is 2916 bytes; at most 2915 fit.' },
    })
    expect(proposalOfForm(wasm, PAIR, PAIR_INFO, form, atLimit).proposal?.message).toBe(atLimit)
  })

  it('sends no message for an empty or blank one, and a message exactly as typed', () => {
    const { form } = opened()
    for (const blank of [undefined, '', ' \n\t ']) {
      const result = proposalOfForm(wasm, PAIR, PAIR_INFO, form, blank)
      expect(result.errors).toBeNull()
      expect(result.proposal).not.toHaveProperty('message')
    }
    const typed = '  Two lines,\nkept as typed.  '
    expect(proposalOfForm(wasm, PAIR, PAIR_INFO, form, typed).proposal?.message).toBe(typed)
  })

  it('refuses an interest the creation cannot carry', () => {
    const form = { principal: '1000', days: '180', collateral: '0.02', aprPercent: '1400' }
    expect(proposalOfForm(wasm, PAIR, PAIR_INFO, form)).toEqual({
      proposal: null,
      errors: {
        aprPercent: 'The interest over this term cannot be above 655.35 % of the principal.',
      },
    })
  })
})

describe('the words of the summary', () => {
  it('writes amounts grouped, with at least the decimals asked for', () => {
    expect(amountText(508_630_000_000n, 8, 2)).toBe('5,086.30')
    expect(amountText(508_630_136_986n, 8, 2)).toBe('5,086.30136986')
    expect(amountText(8_500_000n, 8)).toBe('0.085')
    expect(amountText(500_000n, 0, 2)).toBe('500,000')
  })

  it('names what a loan pays out and what it repays, the repayment with cents', () => {
    expect(loanAmounts(2_000_000_000_000n, 302_140_000_000n, PAIR_INFO.principal)).toEqual({
      receive: '20,000 TEST',
      repay: '3,021.40 TEST',
    })
  })

  it('dates the end of a term the days and the margin after now', () => {
    const now = new Date('2026-11-12T12:00:00Z')
    const tip = 3_000_000
    const ends = dateAfterBlocks(now, proposalExpiry(tip, 90) - tip)
    expect(ends.toISOString()).toBe('2027-02-10T13:00:00.000Z')
    expect(formatDay(ends, 'UTC')).toBe('10 February 2027')
  })

  it('says how long ago terms were published', () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    const at = (ms: number) => Math.floor((now - ms) / 1000)
    expect(timeAgo(at(20_000), now)).toBe('just now')
    expect(timeAgo(at(-60_000), now)).toBe('just now')
    expect(timeAgo(at(5 * 60_000), now)).toBe('5 minutes ago')
    expect(timeAgo(at(3 * 3_600_000 + 1_000), now)).toBe('3 hours ago')
    expect(timeAgo(at(30 * 3_600_000), now)).toBe('yesterday')
    expect(timeAgo(at(3 * 86_400_000), now)).toBe('3 days ago')
    expect(timeAgo(at(400 * 86_400_000), now)).toBe('last year')
  })
})
