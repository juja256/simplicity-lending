// A proposal against a lender's terms: the lender's console checks a received proposal against its
// own verified terms (`checkAgainstTerms`), and the borrower's form checks what the borrower types
// against the chosen lender's terms (`proposalFormErrors`) before anything is built.
//
// The rules are the core's, through the wasm (`checkProposal`, `minCollateral`, `minRepayment`); a
// term is counted by the term rule (`termBlocksOf`). This module is pure (no React, no
// `import.meta.env`, nothing from the hooks), so tests and the e2e script import it.
import type { PairAsset } from '@/constants/resolve-network-config'

import type { EntryCheck } from './directory'
import {
  BLOCKS_PER_DAY,
  findPairTerms,
  formatAprBps,
  maxPrincipalPerCollateralToDisplay,
  type PairTermsInput,
  PERCENT_DECIMALS,
  type ProposalInput,
  termBlocksOf,
  type TermBreachName,
  type TermsPair,
  U32_MAX,
  unitsFromDecimal,
  unitsToDecimal,
} from './lenderTerms'
import type { PrivateLendingWasm } from './wasm'

/** What a proposal is made of in an opened offer's terms (`PrivateOfferTerms` has them all). */
export interface OfferProposalTerms {
  principalAsset: string
  collateralAsset: string
  principalAmount: bigint
  collateralAmount: bigint
  repaymentAmount: bigint
  /** The loan's expiry, a block height. */
  loanExpirationTime: number
}

/** The proposal of an opened offer, its term counted from `createdAtHeight` by the term rule. */
export function proposalOfOffer(terms: OfferProposalTerms, createdAtHeight: number): ProposalInput {
  return {
    principal_asset: terms.principalAsset,
    collateral_asset: terms.collateralAsset,
    principal_amount: terms.principalAmount.toString(),
    collateral_amount: terms.collateralAmount.toString(),
    repayment_amount: terms.repaymentAmount.toString(),
    term_blocks: termBlocksOf(terms.loanExpirationTime, createdAtHeight),
  }
}

/**
 * A proposal against the lender's own terms: `within` them; `outside` them, with the terms it
 * breaks in the core's order and a label for each; or `unknown` when the lender has no entry
 * (`no-terms`) or its entry does not verify (`unverified`).
 */
export type TermsVerdict =
  | { kind: 'within' }
  | { kind: 'outside'; breaches: TermBreachName[]; labels: string[] }
  | { kind: 'unknown'; reason: 'no-terms' | 'unverified' }

const UNSUPPORTED_PAIR_LABEL = 'pair you do not lend'

/**
 * Checks `proposal` against the configured pair of the lender's own entry, as checked by
 * `checkDirectoryEntry` (null when the lender has none). Only the configured pair counts, as the
 * app publishes and shows no other: a proposal of other assets, or verified terms without the
 * pair, give `UnsupportedPair`. Throws the wasm's `bad-input` error for a proposal whose amounts
 * are not `u64`s or whose term is not a `u32`.
 */
export function checkAgainstTerms(
  wasm: Pick<PrivateLendingWasm, 'checkProposal' | 'minCollateral'>,
  own: EntryCheck | null,
  proposal: ProposalInput,
  pairInfo: TermsPair,
): TermsVerdict {
  if (own === null) return { kind: 'unknown', reason: 'no-terms' }
  if (own.status !== 'verified') return { kind: 'unknown', reason: 'unverified' }
  const pair = findPairTerms(own.terms, pairInfo)
  if (pair === undefined) {
    return { kind: 'outside', breaches: ['UnsupportedPair'], labels: [UNSUPPORTED_PAIR_LABEL] }
  }
  const breaches = wasm.checkProposal(
    JSON.stringify({ pairs: [pair] }),
    JSON.stringify(proposal),
  ) as TermBreachName[]
  if (breaches.length === 0) return { kind: 'within' }
  let leastCollateral: bigint | undefined
  try {
    leastCollateral = wasm.minCollateral(
      BigInt(proposal.principal_amount),
      BigInt(pair.max_principal_per_collateral),
    )
  } catch {
    // No least collateral above `u64::MAX`: the label names the rate instead.
  }
  const labels = breaches.map(breach => breachLabel(breach, pair, pairInfo, leastCollateral))
  return { kind: 'outside', breaches, labels }
}

/** A decimal with its whole part grouped, such as `"50,000.5"`. */
function grouped(decimal: string): string {
  const [whole, fraction] = decimal.split('.')
  const wholeGrouped = BigInt(whole).toLocaleString('en-US')
  return fraction === undefined ? wholeGrouped : `${wholeGrouped}.${fraction}`
}

/** Base units as grouped whole coins with the asset's symbol, such as `"1,000 TEST"`. */
function coins(units: bigint, asset: PairAsset): string {
  return `${grouped(unitsToDecimal(units, asset.decimals))} ${asset.symbol}`
}

function dayCount(days: number): string {
  return `${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`
}

/** `low to high`, or one figure when they are equal. */
function range(low: string, high: string): string {
  return low === high ? low : `${low} to ${high}`
}

/**
 * The term a breach breaks, in plain words with the lender's figure from `pair`, such as `"APR
 * below 6 %"`. A collateral breach names `leastCollateral`, the least collateral for the
 * proposal's principal (`minCollateral`), when it is given, and the lender's rate otherwise.
 */
export function breachLabel(
  breach: TermBreachName,
  pair: PairTermsInput,
  pairInfo: TermsPair,
  leastCollateral?: bigint,
): string {
  const { principal, collateral } = pairInfo
  switch (breach) {
    case 'UnsupportedPair':
      return UNSUPPORTED_PAIR_LABEL
    case 'PrincipalBelowRange':
      return `principal below ${coins(BigInt(pair.min_principal), principal)}`
    case 'PrincipalAboveRange':
      return `principal above ${coins(BigInt(pair.max_principal), principal)}`
    case 'TermBelowRange':
      return `term shorter than ${dayCount(pair.min_term_days)}`
    case 'TermAboveRange':
      return `term longer than ${dayCount(pair.max_term_days)}`
    case 'AprBelowMinimum':
      return `APR below ${formatAprBps(pair.min_apr_bps)}`
    case 'CollateralBelowMinimum': {
      if (leastCollateral !== undefined) {
        return `collateral below ${coins(leastCollateral, collateral)}`
      }
      const rate = maxPrincipalPerCollateralToDisplay(
        BigInt(pair.max_principal_per_collateral),
        principal.decimals,
        collateral.decimals,
      )
      return `collateral below 1 ${collateral.symbol} per ${grouped(rate)} ${principal.symbol}`
    }
  }
}

/**
 * The least collateral and the least repayment the pair takes for `principal` over `days`, from
 * the wasm (rounded up). Throws its `bad-input` error when either is above `u64::MAX`.
 */
export function proposalLimits(
  wasm: Pick<PrivateLendingWasm, 'minCollateral' | 'minRepayment'>,
  pair: PairTermsInput,
  principal: bigint,
  days: number,
): { minCollateral: bigint; minRepayment: bigint } {
  return {
    minCollateral: wasm.minCollateral(principal, BigInt(pair.max_principal_per_collateral)),
    minRepayment: repaymentAt(wasm, principal, pair.min_apr_bps, days),
  }
}

/**
 * The repayment of `principal` over `days` at the borrower's APR in basis points: the wasm's
 * `minRepayment` at that APR, rounded up. Throws its `bad-input` error above `u64::MAX`.
 */
export function repaymentAt(
  wasm: Pick<PrivateLendingWasm, 'minRepayment'>,
  principal: bigint,
  aprBps: number,
  days: number,
): bigint {
  return wasm.minRepayment(principal, aprBps, days * BLOCKS_PER_DAY)
}

/** What a borrower types: whole coins, days and a percent. */
export interface ProposalForm {
  /** Whole principal coins. */
  principal: string
  days: string
  /** Whole collateral coins. */
  collateral: string
  /** The APR, in percent, at most 2 decimals (a basis point). */
  aprPercent: string
}

export type ProposalFormErrors = Partial<Record<keyof ProposalForm, string>>

/**
 * The error of each field of the borrower's form that the lender's `pair` refuses, each naming the
 * lender's figure: a malformed number or more decimals than the asset has, a principal or a term
 * outside the lender's range, collateral below `minCollateral` for the principal, an APR below the
 * lender's least. When it is empty, the proposal the form makes (its repayment `repaymentAt` the
 * APR, its term the days) is within the pair's terms. The collateral is checked against its least
 * only once the principal is valid.
 */
export function proposalFormErrors(
  wasm: Pick<PrivateLendingWasm, 'minCollateral'>,
  pair: PairTermsInput,
  pairInfo: TermsPair,
  form: ProposalForm,
): ProposalFormErrors {
  const { principal: principalAsset, collateral: collateralAsset } = pairInfo
  const errors: ProposalFormErrors = {}

  const principal = field(errors, 'principal', () => {
    const value = unitsFromDecimal(form.principal, principalAsset.decimals)
    const min = BigInt(pair.min_principal)
    const max = BigInt(pair.max_principal)
    if (value < min || value > max) {
      const low = grouped(unitsToDecimal(min, principalAsset.decimals))
      const high = grouped(unitsToDecimal(max, principalAsset.decimals))
      throw new RangeError(`The lender lends ${range(low, high)} ${principalAsset.symbol}.`)
    }
    return value
  })

  field(errors, 'days', () => {
    const text = form.days.trim()
    if (!/^\d+$/.test(text)) throw new RangeError('Enter a whole number of days.')
    const days = Number(text)
    if (days < pair.min_term_days || days > pair.max_term_days) {
      const low = pair.min_term_days.toLocaleString('en-US')
      const high = pair.max_term_days.toLocaleString('en-US')
      const unit = pair.max_term_days === 1 ? 'day' : 'days'
      throw new RangeError(`The lender lends for ${range(low, high)} ${unit}.`)
    }
  })

  field(errors, 'collateral', () => {
    const value = unitsFromDecimal(form.collateral, collateralAsset.decimals)
    if (principal === undefined) return
    let least: bigint
    try {
      least = wasm.minCollateral(principal, BigInt(pair.max_principal_per_collateral))
    } catch {
      // A `bad-input` error: the least collateral is above `u64::MAX`.
      throw new RangeError('The lender needs more collateral for this principal than can exist.')
    }
    if (value < least) {
      throw new RangeError(
        `The lender needs at least ${coins(least, collateralAsset)} for this principal.`,
      )
    }
  })

  field(errors, 'aprPercent', () => {
    let bps: bigint
    try {
      bps = unitsFromDecimal(form.aprPercent, PERCENT_DECIMALS)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      throw new RangeError('Enter the APR as a percent, such as 6 or 6.25.')
    }
    if (bps > BigInt(U32_MAX)) throw new RangeError('The APR is too large.')
    if (bps < BigInt(pair.min_apr_bps)) {
      throw new RangeError(`The lender's least APR is ${formatAprBps(pair.min_apr_bps)}.`)
    }
  })

  return errors
}

/** Runs `parse`, putting its `RangeError` message in `errors[name]`; undefined on an error. */
function field<T>(
  errors: ProposalFormErrors,
  name: keyof ProposalForm,
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
