// The figures of the lender's book, from the indexer's view of the opened offers (untrusted: it
// only decides what to show). Pure, so tests import it: it takes only types from the offer view.
import { BLOCKS_PER_DAY } from '@/privateLending/lenderTerms'
import type { OpenedOfferItem } from '@/privateLending/offerView'

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
  /** The collateral of the active loans, in base units. */
  collateralHeld: bigint
  /** Active loans whose expiry is at most seven days after the tip, and after it. */
  dueWithin7Days: number
  /** Active loans past their expiry. */
  overdue: number
}

const DUE_SOON_BLOCKS = 7 * BLOCKS_PER_DAY

/**
 * The figures of the lender's opened offers at `tipHeight`. While the tip is unknown (0), every
 * pending proposal waits, and no loan is due or overdue.
 */
export function bookSummary(items: OpenedOfferItem[], tipHeight: number): BookSummary {
  const summary: BookSummary = {
    waiting: 0,
    active: 0,
    lent: 0n,
    collateralHeld: 0n,
    dueWithin7Days: 0,
    overdue: 0,
  }
  for (const { candidate, terms } of items) {
    const blocksLeft = terms.loanExpirationTime - tipHeight
    const known = tipHeight > 0
    if (candidate.status === 'pending') {
      // Acceptance ends one block before the expiry, as `canStillAccept` reads it.
      if (!known || blocksLeft > 0) summary.waiting++
    } else if (candidate.status === 'active') {
      summary.active++
      summary.lent += terms.principalAmount
      summary.collateralHeld += terms.collateralAmount
      // Overdue: the tip known and past the expiry, as `isPastExpiry` reads it.
      if (known && blocksLeft < 0) summary.overdue++
      else if (known && blocksLeft > 0 && blocksLeft <= DUE_SOON_BLOCKS) summary.dueWithin7Days++
    }
  }
  return summary
}
