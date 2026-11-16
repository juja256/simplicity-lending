// What the console shows of a pending proposal beyond its amounts: its term, its APR, its rate and
// its check against the lender's own terms. The term is counted by the term rule from the block
// its creation confirmed in, as esplora reports it (`creationHeightOf`), never from the indexer's
// `created_at_height`: the indexer is untrusted, and a later height from it would count a shorter
// term and a higher APR, and could pass a proposal outside the terms as within them. Pure, so
// tests import it: it takes only types from the esplora schemas and the offer view.
import type { TxStatus } from '@/api/esplora/schemas'
import type { EntryCheck } from '@/privateLending/directory'
import type { PrivateOfferTerms } from '@/privateLending/hooks/usePrivateOffers'
import { termBlocksOf, type TermsPair } from '@/privateLending/lenderTerms'
import {
  checkAgainstTerms,
  proposalOfOffer,
  type TermsVerdict,
} from '@/privateLending/proposalCheck'
import type { PrivateLendingWasm } from '@/privateLending/wasm'

export interface ProposalFigures {
  /** The term, counted by the term rule from the block its creation confirmed in. */
  termBlocks: number
  /** Null when the wasm cannot give one: a term of 0, or a repayment below the principal. */
  aprBps: bigint | null
  /** Principal base units per 10^8 collateral base units; null for 0 collateral. */
  principalPerCollateral: bigint | null
  /** Undefined until the lender's own entry is loaded. */
  verdict: TermsVerdict | undefined
}

/**
 * The height of the block a transaction confirmed in, from esplora's status of it; null while it
 * is unconfirmed. Once confirmed it does not change, so a caller may keep it.
 */
export function creationHeightOf(status: TxStatus): number | null {
  return status.confirmed && status.block_height !== undefined ? status.block_height : null
}

function orNull<T>(compute: () => T): T | null {
  try {
    return compute()
  } catch {
    // A `bad-input` error of a display rule: the figure is not shown.
    return null
  }
}

/**
 * The figures of a proposal whose creation confirmed at `createdAtHeight`, by esplora: undefined
 * while that height is not known (null or undefined), so nothing is shown or checked before it.
 * `own` is the lender's own entry as checked (null when it has none), undefined until it is loaded:
 * the verdict waits for it.
 */
export function proposalFigures(
  wasm: PrivateLendingWasm,
  terms: PrivateOfferTerms,
  createdAtHeight: number | null | undefined,
  own: EntryCheck | null | undefined,
  pair: TermsPair,
): ProposalFigures | undefined {
  if (createdAtHeight === null || createdAtHeight === undefined) return undefined
  const termBlocks = termBlocksOf(terms.loanExpirationTime, createdAtHeight)
  return {
    termBlocks,
    aprBps: orNull(() => wasm.aprBps(terms.principalAmount, terms.repaymentAmount, termBlocks)),
    principalPerCollateral: orNull(() =>
      wasm.principalPerCollateral(terms.principalAmount, terms.collateralAmount),
    ),
    // The proposal against the terms the lender's key signed, by the same term rule.
    verdict:
      own === undefined
        ? undefined
        : checkAgainstTerms(wasm, own, proposalOfOffer(terms, createdAtHeight), pair),
  }
}
