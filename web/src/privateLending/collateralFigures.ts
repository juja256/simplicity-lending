// The collateral of a loan as the apps show it: what an installment releases, and what is released
// and left at a step. Pure, so tests import it. The wasm decides what a build releases
// (`LoanState.releasePreview`); these figures only preview it for a form, in the same integer
// arithmetic (spec, "Integer arithmetic": every collateral figure is `ceil(a·b / c)` in 128 bits,
// which a bigint holds exactly).

/** `ceil(a / b)` for `a ≥ 0`, `b > 0`. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

/** The terms and the state of a loan that its collateral follows. */
export interface ReleaseInput {
  /** The offer's collateral, `C`, base units. */
  total: bigint
  /** The offer's full repayment, `R`, base units. */
  repayment: bigint
  /** What the loan still owes, `d_k`, base units of the principal. */
  owed: bigint
  /** The collateral the loan holds now, `c_k = ceil(d_k·C/R)`. */
  held: bigint
}

/**
 * The collateral that paying `amount` releases now, `c_k − ceil((d_k − amount)·C/R)`: the whole of
 * `c_k` for the full repayment (`amount ≥ owed`), 0 or more for an installment. Undefined for an
 * amount below 1, or when the figures do not fit the release rule (`held` above `total`, or `held`
 * not what `owed` gives), which the form then leaves out rather than shows wrongly.
 */
export function releaseForPayment(input: ReleaseInput, amount: bigint): bigint | undefined {
  const { total, repayment, owed, held } = input
  if (amount < 1n || repayment < 1n || held < 1n || held > total) return undefined
  if (held !== ceilDiv(owed * total, repayment)) return undefined
  if (amount >= owed) return held
  const left = ceilDiv((owed - amount) * total, repayment)
  return left > held ? undefined : held - left
}

/** What a loan's collateral shows: released so far, and left. */
export type CollateralLeft =
  | { kind: 'unread' }
  | { kind: 'computing' }
  | { kind: 'unknown' }
  | { kind: 'known'; left: bigint; released: bigint }

/** The state of the lender's search for `c_k`, as the query that runs it reports it. */
export interface SearchState {
  status: 'idle' | 'pending' | 'success' | 'error'
  /** The search's answer when it succeeded: undefined when the loan holds no amount up to `C`. */
  amount?: bigint | undefined
}

function known(total: bigint, left: bigint): CollateralLeft {
  // `c_k` is in `[1, C]`: anything else is a figure that cannot be this loan's.
  return left >= 1n && left <= total
    ? { kind: 'known', left, released: total - left }
    : { kind: 'unknown' }
}

/**
 * The collateral released and left of a loan of collateral `total`: `c_k` when the loan was read
 * with it, else the lender's search's state: "computing" while it runs, and unknown when it found
 * nothing, failed, or was not asked for. "Unread" is a loan not read yet.
 */
export function collateralLeft(
  total: bigint,
  loan: { collateral?: bigint | undefined } | undefined,
  search: SearchState,
): CollateralLeft {
  if (loan === undefined) return { kind: 'unread' }
  if (loan.collateral !== undefined) return known(total, loan.collateral)
  switch (search.status) {
    case 'pending':
      return { kind: 'computing' }
    case 'success':
      return search.amount === undefined ? { kind: 'unknown' } : known(total, search.amount)
    default:
      return { kind: 'unknown' }
  }
}
