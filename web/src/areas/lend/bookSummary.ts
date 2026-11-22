// The figures of the lender's book, from the indexer's view of the opened offers and the loans read
// on chain (`useLoan`), both only for display. Pure, so tests import it.
import type { LoanFigures } from '@/privateLending/hooks/useLoan'
import { BLOCKS_PER_DAY } from '@/privateLending/lenderTerms'
import { displayStatus, type OpenedOfferItem } from '@/privateLending/offerView'

export interface BookSummary {
  /**
   * Pending proposals that can still be accepted: the tip below their expiry, as `canStillAccept`
   * reads it.
   */
  waiting: number
  /** Active loans, overdue ones included. */
  active: number
  /** The principal of the active loans, in base units. */
  lent: bigint
  /**
   * The collateral the active loans hold, in base units: `c_k` where the loan was read with it or
   * the lender's search found it, else the offer's collateral, which is the most it can hold.
   */
  collateralHeld: bigint
  /**
   * Whether `collateralHeld` is exact: every active loan's `c_k` is known. Otherwise it is at most
   * that, while a loan is unread or its search runs.
   */
  collateralHeldExact: boolean
  /** Active loans whose expiry is at most seven days after the tip, and after it. */
  dueWithin7Days: number
  /** Active loans past their expiry. */
  overdue: number
  /** `LoanBookFigures.repaid` of the loans read, in base units. */
  repaid: bigint
  /** `LoanBookFigures.claimable` of the loans read, in base units: amounts unknown are left out. */
  claimable: bigint
}

/** A loan's row in the lender's book, in base units of the principal asset. */
export interface LoanBookFigures {
  /**
   * What the borrower repaid as the lender reads it: the installments that opened, or the whole
   * repayment once the loan closed.
   */
  repaid: bigint
  /**
   * What the loan still owes: exact when every installment opened, else at most the repayment less
   * what opened; null once the collateral was taken.
   */
  remaining: { amount: bigint; exact: boolean } | null
  /**
   * What the lender can claim now, of the amounts it reads. While the loan is active: the
   * installments listed unspent that open. Once it closed: the final claim's sweep, the repayment
   * less the installments claimed, which the combined opening balances whatever opened.
   */
  claimable: bigint
  /**
   * The installments listed unspent whose amount the lender cannot read while the loan is active:
   * only the final claim can take them ("amount unknown").
   */
  unknownClaimable: number
}

const DUE_SOON_BLOCKS = 7 * BLOCKS_PER_DAY

/**
 * The row of a lender's loan with its figures `loan`, or null until they are read. The indexer
 * says which installments are unspent; a spent one was claimed, since the loan is still active or
 * the final claim did not run yet.
 */
export function loanBookFigures(
  item: OpenedOfferItem,
  loan: LoanFigures | undefined,
): LoanBookFigures | null {
  if (loan === undefined) return null
  const { candidate, terms } = item
  const amounts = new Map(loan.installments.map(({ outpoint, amount }) => [outpoint, amount]))
  const listed = candidate.utxos.filter(utxo => utxo.utxo_type === 'installment')
  const amountOf = (utxo: (typeof listed)[number]) => amounts.get(`${utxo.txid}:${utxo.vout}`)
  const unspent = listed.filter(utxo => utxo.spent_txid === null)
  const status = displayStatus(candidate)

  if (status === 'repaid' || status === 'claimed') {
    const claimed = listed.filter(utxo => utxo.spent_txid !== null).map(amountOf)
    const known = claimed.every(amount => amount !== undefined)
    const claimedSum = claimed.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n)
    const sweep = terms.repaymentAmount - claimedSum
    return {
      repaid: terms.repaymentAmount,
      remaining: { amount: 0n, exact: true },
      claimable: status === 'repaid' && known && sweep > 0n ? sweep : 0n,
      unknownClaimable: status === 'repaid' && !known ? 1 : 0,
    }
  }
  if (status === 'liquidated') {
    return { repaid: loan.paid, remaining: null, claimable: 0n, unknownClaimable: 0 }
  }
  const atMost = terms.repaymentAmount > loan.paid ? terms.repaymentAmount - loan.paid : 0n
  const opened = unspent.map(amountOf)
  return {
    repaid: loan.paid,
    remaining:
      loan.remaining === undefined
        ? { amount: atMost, exact: false }
        : { amount: loan.remaining, exact: true },
    claimable: opened.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n),
    unknownClaimable: opened.filter(amount => amount === undefined).length,
  }
}

/**
 * The figures of the lender's opened offers at `tipHeight`, with `loans`, the figures of the loans
 * read so far by creation txid: `repaid` and `claimable` count only those. `found` holds, by
 * creation txid, the collateral the lender's search found for a loan whose figures lack it. While
 * the tip is unknown (0), every pending proposal waits, and no loan is due or overdue.
 */
export function bookSummary(
  items: OpenedOfferItem[],
  tipHeight: number,
  loans: ReadonlyMap<string, LoanFigures> = new Map(),
  found: ReadonlyMap<string, bigint> = new Map(),
): BookSummary {
  const summary: BookSummary = {
    waiting: 0,
    active: 0,
    lent: 0n,
    collateralHeld: 0n,
    collateralHeldExact: true,
    dueWithin7Days: 0,
    overdue: 0,
    repaid: 0n,
    claimable: 0n,
  }
  for (const item of items) {
    const { candidate, terms } = item
    const blocksLeft = terms.loanExpirationTime - tipHeight
    const known = tipHeight > 0
    if (candidate.status === 'pending') {
      // Acceptance ends one block before the expiry, as `canStillAccept` reads it.
      if (!known || blocksLeft > 0) summary.waiting++
    } else if (candidate.status === 'active') {
      summary.active++
      summary.lent += terms.principalAmount
      // `c_k` is in `[1, C]`: anything else is a figure that cannot be this loan's.
      const held = loans.get(item.txid)?.collateral ?? found.get(item.txid)
      if (held !== undefined && held >= 1n && held <= terms.collateralAmount) {
        summary.collateralHeld += held
      } else {
        summary.collateralHeld += terms.collateralAmount
        summary.collateralHeldExact = false
      }
      // Overdue: the tip known and past the expiry, as `isPastExpiry` reads it.
      if (known && blocksLeft < 0) summary.overdue++
      else if (known && blocksLeft > 0 && blocksLeft <= DUE_SOON_BLOCKS) summary.dueWithin7Days++
    }
    const figures = loanBookFigures(item, loans.get(item.txid))
    if (figures !== null) {
      summary.repaid += figures.repaid
      summary.claimable += figures.claimable
    }
  }
  return summary
}
