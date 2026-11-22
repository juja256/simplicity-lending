// The collateral a loan has released and still holds, for the apps' views. The borrower always
// reads it with the loan; the lender reads it while every installment opens, and otherwise finds
// it by the search in a Web Worker (`findCollateralInWorker`), which takes seconds: the view says
// "computing" until it answers.
import { useQueries, useQuery } from '@tanstack/react-query'

import { type CollateralLeft, collateralLeft } from '@/privateLending/collateralFigures'
import { findCollateralInWorker } from '@/privateLending/collateralSearch'
import type { CollateralSearchInput } from '@/privateLending/flows/liquidation'

import { privateCollateralQueryKey } from './queryKeys'
import type { LoanFigures } from './useLoan'

/**
 * The query of the lender's search for the collateral of the loan output `input` describes,
 * shared by every view that shows it, so that a search runs once per loan state. Disabled without
 * an input.
 */
function collateralSearchQuery(input: CollateralSearchInput | undefined) {
  return {
    queryKey: privateCollateralQueryKey(input?.valueCommitment ?? '', input?.assetCommitment ?? ''),
    enabled: input !== undefined,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      if (input === undefined) throw new Error('No search to run')
      // `undefined` is not a query result: none found is `null`.
      return (await findCollateralInWorker(input)) ?? null
    },
  }
}

/**
 * The collateral released and left of a loan of collateral `total`, from its `loan` figures.
 * `search` is false for a loan that is not active: its last loan output is no state worth a
 * search, and the figure is not shown.
 */
export function useCollateralLeft(
  total: bigint,
  loan: LoanFigures | undefined,
  search: boolean,
): CollateralLeft {
  const input = search ? loan?.collateralSearch : undefined
  const query = useQuery(collateralSearchQuery(input))
  return collateralLeft(total, loan, {
    status: input === undefined ? 'idle' : query.status,
    amount: query.data ?? undefined,
  })
}

/**
 * The collateral the lender's search found for each of `loans` (figures by creation txid) whose
 * figures lack it, by creation txid. The searches are the ones `useCollateralLeft` runs, and share
 * their results; a search not answered yet, or that found nothing, is left out.
 */
export function useFoundCollaterals(
  loans: ReadonlyMap<string, LoanFigures>,
): ReadonlyMap<string, bigint> {
  const searched = [...loans].filter(([, loan]) => loan.collateralSearch !== undefined)
  const results = useQueries({
    queries: searched.map(([, loan]) => collateralSearchQuery(loan.collateralSearch)),
  })
  return new Map(
    searched.flatMap(([txid], index) => {
      const amount = results[index]?.data
      return amount === undefined || amount === null ? [] : [[txid, amount] as const]
    }),
  )
}
