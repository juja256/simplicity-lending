// Lender terms in the JSON the wasm (`encodeLenderTerms`, `checkProposal`, `signDirectoryAction`)
// and the indexer's directory take: `{ pairs: [...] }` with the field names of the core's
// `PairTerms`, `u64` amounts as decimal strings, `u32` fields as numbers and asset ids as display
// hex. A proposal has the field names of the core's `Proposal`.
//
// It also turns what a lender types (whole coins, percent, days) into those terms, exactly and
// with `bigint`: the wasm's amount functions wrap a number or a `bigint` outside `u64` at the JS
// boundary, so nothing typed reaches them before it is checked here. This module is pure (no
// React, no `import.meta.env`), so the e2e script and the parity check import it.
import type { PairAsset } from '@/constants/resolve-network-config'

export interface PairTermsInput {
  /** The asset lent, 64 hex characters in display order. */
  principal_asset: string
  /** The asset lent against, 64 hex characters in display order. */
  collateral_asset: string
  /** The least APR, in basis points. */
  min_apr_bps: number
  /** The most principal base units per 10^8 collateral base units, a `u64` as decimal digits. */
  max_principal_per_collateral: string
  /** Days, at least 1. */
  min_term_days: number
  /** Days, at most `MAX_TERM_DAYS`. */
  max_term_days: number
  /** Principal base units, a `u64` as decimal digits, at least 1. */
  min_principal: string
  /** Principal base units, a `u64` as decimal digits. */
  max_principal: string
}

/** A lender's terms: 1 to 8 pairs, no two with the same principal and collateral assets. */
export interface LenderTermsInput {
  pairs: PairTermsInput[]
}

/** A borrower's proposal, as `checkProposal` takes it. */
export interface ProposalInput {
  principal_asset: string
  collateral_asset: string
  /** Base units, a `u64` as decimal digits. */
  principal_amount: string
  collateral_amount: string
  repayment_amount: string
  /** Blocks, a `u32`. */
  term_blocks: number
}

/** The names `checkProposal` gives the terms a proposal breaks, in the core's order. */
export type TermBreachName =
  | 'UnsupportedPair'
  | 'PrincipalBelowRange'
  | 'PrincipalAboveRange'
  | 'TermBelowRange'
  | 'TermAboveRange'
  | 'AprBelowMinimum'
  | 'CollateralBelowMinimum'

export const U64_MAX = 2n ** 64n - 1n
export const U32_MAX = 2 ** 32 - 1
/** The core's `MAX_TERM_DAYS`: the longest term a lender can accept. */
export const MAX_TERM_DAYS = 3650
/** The core's `BLOCKS_PER_DAY`. */
export const BLOCKS_PER_DAY = 1440
/** `max_principal_per_collateral` counts per 10^8 collateral base units (`COLLATERAL_SCALE`). */
const COLLATERAL_SCALE_DECIMALS = 8
/** Basis points are hundredths of a percent. */
const PERCENT_DECIMALS = 2
/** The decimals an asset can have (`resolveNetworkConfig`'s bound). */
const MAX_ASSET_DECIMALS = 18

const DECIMAL = /^(\d+)(?:\.(\d+))?$/

function checkDecimals(decimals: number, what: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ASSET_DECIMALS) {
    throw new RangeError(`${what} decimals must be a whole number from 0 to ${MAX_ASSET_DECIMALS}`)
  }
}

/** A typed decimal as its digits and the count of digits after the point; throws if malformed. */
function parseDecimal(text: string): { digits: bigint; scale: number } {
  const match = DECIMAL.exec(text.trim())
  if (match === null) throw new RangeError('Enter a number, such as 12 or 0.5.')
  const [, whole, fraction = ''] = match
  return { digits: BigInt(whole + fraction), scale: fraction.length }
}

function checkU64(value: bigint): bigint {
  if (value > U64_MAX) throw new RangeError('The amount is too large.')
  return value
}

/**
 * Base units of an amount typed in whole coins, such as `"1.5"` with 3 decimals: `1500n`. Throws
 * a `RangeError` with a message for the user on a malformed amount, more decimals than the asset
 * has, or a value above `u64::MAX`.
 */
export function unitsFromDecimal(text: string, decimals: number): bigint {
  checkDecimals(decimals, 'The asset')
  const { digits, scale } = parseDecimal(text)
  if (scale > decimals) {
    throw new RangeError(`Enter an amount with at most ${decimals} decimals.`)
  }
  return checkU64(digits * 10n ** BigInt(decimals - scale))
}

/**
 * Base units as whole coins, without grouping or trailing zeros: the inverse of
 * `unitsFromDecimal`.
 */
export function unitsToDecimal(units: bigint, decimals: number): string {
  checkDecimals(decimals, 'The asset')
  if (units < 0n) throw new RangeError('The amount is negative.')
  return shiftPoint(units, decimals)
}

/** `value / 10^decimals` written exactly, trailing zeros dropped. */
function shiftPoint(value: bigint, decimals: number): string {
  if (decimals <= 0) return (value * 10n ** BigInt(-decimals)).toString()
  const base = 10n ** BigInt(decimals)
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  const whole = (value / base).toString()
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/**
 * `max_principal_per_collateral` from the principal a lender lends per 1 whole collateral coin, as
 * typed (such as `"50000"` TEST per tL-BTC): principal base units per 10^8 collateral base units,
 * exactly. Throws a `RangeError` with a message for the user on a malformed number, more decimals
 * than the principal asset has, a rate that is not a whole number of base units per 10^8
 * collateral base units (a collateral asset with more than 8 decimals), or one above `u64::MAX`.
 */
export function maxPrincipalPerCollateralFromDisplay(
  display: string,
  principalDecimals: number,
  collateralDecimals: number,
): bigint {
  checkDecimals(principalDecimals, 'The principal')
  checkDecimals(collateralDecimals, 'The collateral')
  const { digits, scale } = parseDecimal(display)
  if (scale > principalDecimals) {
    throw new RangeError(`Enter a rate with at most ${principalDecimals} decimals.`)
  }
  // display · 10^principalDecimals principal base units per 10^collateralDecimals collateral base
  // units, scaled to 10^8 of them
  const exponent = principalDecimals + COLLATERAL_SCALE_DECIMALS - collateralDecimals - scale
  if (exponent >= 0) return checkU64(digits * 10n ** BigInt(exponent))
  const divisor = 10n ** BigInt(-exponent)
  if (digits % divisor !== 0n) {
    throw new RangeError(
      'The rate is not a whole number of base units per 10^8 collateral base units.',
    )
  }
  return checkU64(digits / divisor)
}

/**
 * The principal per 1 whole collateral coin of a `max_principal_per_collateral`, written exactly:
 * the inverse of `maxPrincipalPerCollateralFromDisplay`. With a collateral asset of fewer than 8
 * decimals a rate can need more decimals than the principal asset has; it is still written
 * exactly, and `maxPrincipalPerCollateralFromDisplay` refuses it.
 */
export function maxPrincipalPerCollateralToDisplay(
  value: bigint,
  principalDecimals: number,
  collateralDecimals: number,
): string {
  checkDecimals(principalDecimals, 'The principal')
  checkDecimals(collateralDecimals, 'The collateral')
  if (value < 0n) throw new RangeError('The rate is negative.')
  return shiftPoint(value, principalDecimals + COLLATERAL_SCALE_DECIMALS - collateralDecimals)
}

/** An APR in basis points as a percent, such as `"5.25 %"`. */
export function formatAprBps(bps: number): string {
  return `${shiftPoint(BigInt(bps), PERCENT_DECIMALS)} %`
}

/** A Unix time in seconds as a local date and time, for a terms publication. */
export function formatPublishedAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** The configured asset pair, as the terms form and the lists use it. */
export interface TermsPair {
  collateral: PairAsset
  principal: PairAsset
}

/** The pair of `terms` for the configured assets (ids in any case), if it has one. */
export function findPairTerms(
  terms: LenderTermsInput | null | undefined,
  pair: TermsPair,
): PairTermsInput | undefined {
  return terms?.pairs.find(
    terms =>
      terms.principal_asset.toLowerCase() === pair.principal.id.toLowerCase() &&
      terms.collateral_asset.toLowerCase() === pair.collateral.id.toLowerCase(),
  )
}

/** What a lender types for one pair: whole coins, a percent and days. */
export interface PairTermsForm {
  /** The least APR, in percent, at most 2 decimals. */
  minAprPercent: string
  /** The most principal per 1 whole collateral coin. */
  maxPrincipalPerCollateral: string
  minTermDays: string
  maxTermDays: string
  /** Whole principal coins. */
  minPrincipal: string
  maxPrincipal: string
}

export type PairTermsFormErrors = Partial<Record<keyof PairTermsForm, string>>

export const EMPTY_PAIR_TERMS_FORM: PairTermsForm = {
  minAprPercent: '',
  maxPrincipalPerCollateral: '',
  minTermDays: '',
  maxTermDays: '',
  minPrincipal: '',
  maxPrincipal: '',
}

function days(text: string): number {
  const value = /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TERM_DAYS) {
    throw new RangeError(
      `Enter a whole number of days, 1 to ${MAX_TERM_DAYS.toLocaleString('en-US')}.`,
    )
  }
  return value
}

/** Runs `parse`, putting its `RangeError` message in `errors[field]`; undefined on an error. */
function field<T>(
  errors: PairTermsFormErrors,
  name: keyof PairTermsForm,
  parse: () => T,
): T | undefined {
  try {
    return parse()
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    errors[name] = error.message
    return undefined
  }
}

/**
 * The terms of the configured pair from the form, or the error of each field that is wrong. The
 * checks are `PairTerms::validate`'s and the ranges of the JSON fields, so the wasm and the indexer
 * take the terms this returns.
 */
export function pairTermsFromForm(
  form: PairTermsForm,
  pair: TermsPair,
): { terms: PairTermsInput; errors: null } | { terms: null; errors: PairTermsFormErrors } {
  const { principal, collateral } = pair
  const errors: PairTermsFormErrors = {}

  const minAprBps = field(errors, 'minAprPercent', () => {
    const bps = unitsFromDecimal(form.minAprPercent, PERCENT_DECIMALS)
    if (bps > BigInt(U32_MAX)) throw new RangeError('The APR is too large.')
    return Number(bps)
  })
  const rate = field(errors, 'maxPrincipalPerCollateral', () => {
    const value = maxPrincipalPerCollateralFromDisplay(
      form.maxPrincipalPerCollateral,
      principal.decimals,
      collateral.decimals,
    )
    if (value === 0n) throw new RangeError('Enter a rate above 0.')
    return value
  })
  const minTermDays = field(errors, 'minTermDays', () => days(form.minTermDays))
  const maxTermDays = field(errors, 'maxTermDays', () => {
    const value = days(form.maxTermDays)
    if (minTermDays !== undefined && value < minTermDays) {
      throw new RangeError('The longest term cannot be below the shortest.')
    }
    return value
  })
  const minPrincipal = field(errors, 'minPrincipal', () => {
    const value = unitsFromDecimal(form.minPrincipal, principal.decimals)
    if (value === 0n) throw new RangeError('Enter an amount above 0.')
    return value
  })
  const maxPrincipal = field(errors, 'maxPrincipal', () => {
    const value = unitsFromDecimal(form.maxPrincipal, principal.decimals)
    if (minPrincipal !== undefined && value < minPrincipal) {
      throw new RangeError('The largest principal cannot be below the smallest.')
    }
    return value
  })

  if (
    minAprBps === undefined ||
    rate === undefined ||
    minTermDays === undefined ||
    maxTermDays === undefined ||
    minPrincipal === undefined ||
    maxPrincipal === undefined
  ) {
    return { terms: null, errors }
  }
  return {
    terms: {
      principal_asset: principal.id,
      collateral_asset: collateral.id,
      min_apr_bps: minAprBps,
      max_principal_per_collateral: rate.toString(),
      min_term_days: minTermDays,
      max_term_days: maxTermDays,
      min_principal: minPrincipal.toString(),
      max_principal: maxPrincipal.toString(),
    },
    errors: null,
  }
}

/** The form of published terms, to edit them: the inverse of `pairTermsFromForm`. */
export function pairTermsToForm(terms: PairTermsInput, pair: TermsPair): PairTermsForm {
  const { principal, collateral } = pair
  return {
    minAprPercent: shiftPoint(BigInt(terms.min_apr_bps), PERCENT_DECIMALS),
    maxPrincipalPerCollateral: maxPrincipalPerCollateralToDisplay(
      BigInt(terms.max_principal_per_collateral),
      principal.decimals,
      collateral.decimals,
    ),
    minTermDays: String(terms.min_term_days),
    maxTermDays: String(terms.max_term_days),
    minPrincipal: unitsToDecimal(BigInt(terms.min_principal), principal.decimals),
    maxPrincipal: unitsToDecimal(BigInt(terms.max_principal), principal.decimals),
  }
}
