// The borrower's proposal form as state: where it opens, how its collateral follows the principal,
// and the proposal it makes once every field is within the lender's terms; with the words the
// borrower app writes amounts, dates and ages in. This module is pure (no React, no
// `import.meta.env`), so tests import it.
import {
  type PairTermsInput,
  PERCENT_DECIMALS,
  type TermsPair,
  unitsFromDecimal,
  unitsToDecimal,
} from '@/privateLending/lenderTerms'
import {
  type ProposalForm,
  type ProposalFormErrors,
  proposalFormErrors,
  repaymentAt,
} from '@/privateLending/proposalCheck'
import type { PrivateLendingWasm } from '@/privateLending/wasm'

type FormWasm = Pick<PrivateLendingWasm, 'minCollateral' | 'minRepayment'>

/**
 * The creation builder's limit (`flows/creation.ts`): the interest is at most 0xffff basis points
 * of the principal.
 */
const MAX_INTEREST_BPS = 0xffffn

export interface ProposalFormState {
  form: ProposalForm
  /**
   * The collateral the borrower typed last: the collateral never goes below it when the principal
   * or the term changes. Null until the borrower types one, while the form follows the least.
   */
  typedCollateral: string | null
}

/** The least collateral the pair takes for `principal`; undefined above `u64::MAX`. */
function leastCollateral(
  wasm: Pick<PrivateLendingWasm, 'minCollateral'>,
  pair: PairTermsInput,
  principal: bigint,
): bigint | undefined {
  try {
    return wasm.minCollateral(principal, BigInt(pair.max_principal_per_collateral))
  } catch {
    return undefined
  }
}

/** Base units of a typed amount, or undefined when it is not one. */
function parsedUnits(text: string, decimals: number): bigint | undefined {
  try {
    return unitsFromDecimal(text, decimals)
  } catch {
    return undefined
  }
}

/**
 * The form at the lender's minimums: the least principal, the shortest term, the least collateral
 * for that principal and the least APR.
 */
export function openProposalForm(
  wasm: Pick<PrivateLendingWasm, 'minCollateral'>,
  pair: PairTermsInput,
  pairInfo: TermsPair,
): ProposalFormState {
  const principal = BigInt(pair.min_principal)
  const collateral = leastCollateral(wasm, pair, principal)
  return {
    form: {
      principal: unitsToDecimal(principal, pairInfo.principal.decimals),
      days: String(pair.min_term_days),
      collateral:
        collateral === undefined ? '' : unitsToDecimal(collateral, pairInfo.collateral.decimals),
      aprPercent: unitsToDecimal(BigInt(pair.min_apr_bps), PERCENT_DECIMALS),
    },
    typedCollateral: null,
  }
}

/**
 * The collateral for the principal typed: what the borrower typed when it is at least the least
 * collateral for that principal, and the least otherwise. While the principal is not an amount,
 * or its least collateral cannot exist, the collateral stays as it is.
 */
function followingCollateral(
  wasm: Pick<PrivateLendingWasm, 'minCollateral'>,
  pair: PairTermsInput,
  pairInfo: TermsPair,
  state: ProposalFormState,
  principalText: string,
): string {
  const principal = parsedUnits(principalText, pairInfo.principal.decimals)
  if (principal === undefined) return state.form.collateral
  const least = leastCollateral(wasm, pair, principal)
  if (least === undefined) return state.form.collateral
  const { decimals } = pairInfo.collateral
  if (state.typedCollateral !== null) {
    const typed = parsedUnits(state.typedCollateral, decimals)
    if (typed !== undefined && typed >= least) return state.typedCollateral
  }
  return unitsToDecimal(least, decimals)
}

/**
 * The form after the borrower typed `value` into `field`. When the principal or the term
 * changes, the collateral rises to the least for the principal, but never drops below what the
 * borrower typed into it.
 */
export function editProposalForm(
  wasm: Pick<PrivateLendingWasm, 'minCollateral'>,
  pair: PairTermsInput,
  pairInfo: TermsPair,
  state: ProposalFormState,
  field: keyof ProposalForm,
  value: string,
): ProposalFormState {
  if (field === 'collateral') {
    return { form: { ...state.form, collateral: value }, typedCollateral: value }
  }
  const form = { ...state.form, [field]: value }
  if (field === 'aprPercent') return { ...state, form }
  return {
    ...state,
    form: { ...form, collateral: followingCollateral(wasm, pair, pairInfo, state, form.principal) },
  }
}

/** A proposal the form makes, in base units, days and basis points. */
export interface ProposalAmounts {
  principal: bigint
  collateral: bigint
  /** `repaymentAt` the APR over the days, rounded up. */
  repayment: bigint
  days: number
  aprBps: number
}

/**
 * The proposal of the form, or the error of each field that the lender's `pair` refuses
 * (`proposalFormErrors`), or that the creation cannot carry: a repayment above `u64::MAX`, or an
 * interest above 655.35 % of the principal, both on the APR.
 */
export function proposalOfForm(
  wasm: FormWasm,
  pair: PairTermsInput,
  pairInfo: TermsPair,
  form: ProposalForm,
): { proposal: ProposalAmounts; errors: null } | { proposal: null; errors: ProposalFormErrors } {
  const errors = proposalFormErrors(wasm, pair, pairInfo, form)
  if (Object.keys(errors).length > 0) return { proposal: null, errors }

  const principal = unitsFromDecimal(form.principal, pairInfo.principal.decimals)
  const collateral = unitsFromDecimal(form.collateral, pairInfo.collateral.decimals)
  const days = Number(form.days.trim())
  const aprBps = Number(unitsFromDecimal(form.aprPercent, PERCENT_DECIMALS))
  let repayment: bigint
  try {
    repayment = repaymentAt(wasm, principal, aprBps, days)
  } catch {
    // A `bad-input` error: the repayment is above `u64::MAX`.
    return { proposal: null, errors: { aprPercent: 'The repayment at this APR is too large.' } }
  }
  if (principal <= 0n || ((repayment - principal) * 10_000n) / principal > MAX_INTEREST_BPS) {
    return {
      proposal: null,
      errors: {
        aprPercent: 'The interest over this term cannot be above 655.35 % of the principal.',
      },
    }
  }
  return { proposal: { principal, collateral, repayment, days, aprBps }, errors: null }
}

/**
 * Base units as grouped whole coins, such as `"5,086.3"`, with at least `minFraction` decimals
 * when the asset has them (`"5,086.30"`).
 */
export function amountText(units: bigint, decimals: number, minFraction = 0): string {
  const [whole, fraction = ''] = unitsToDecimal(units, decimals).split('.')
  const padded = fraction.padEnd(Math.min(minFraction, decimals), '0')
  const grouped = BigInt(whole).toLocaleString('en-US')
  return padded === '' ? grouped : `${grouped}.${padded}`
}

/** About when a block `blocksAhead` of the tip comes, at Liquid's minute a block. */
export function dateAfterBlocks(now: Date, blocksAhead: number): Date {
  return new Date(now.getTime() + blocksAhead * 60_000)
}

/** A date as the borrower app writes it, such as `"10 February 2027"`. */
export function formatDay(date: Date, timeZone?: string): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  })
}

const AGE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/**
 * How long ago a time in Unix seconds was, such as `"3 hours ago"` or `"yesterday"`; `"just now"`
 * under a minute, and for a time ahead of `nowMs` (a clock that runs behind the indexer's).
 */
export function timeAgo(unixSeconds: number, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000) - unixSeconds
  const unit = AGE_UNITS.find(([, length]) => seconds >= length)
  if (unit === undefined) return 'just now'
  const [name, length] = unit
  return new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(
    -Math.floor(seconds / length),
    name,
  )
}
