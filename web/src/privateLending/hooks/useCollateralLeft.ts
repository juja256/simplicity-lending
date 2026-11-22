// The collateral a loan has released and still holds, for the apps' views. The borrower always
// reads it with the loan; the lender reads it while every installment opens, and otherwise finds
// it by the search in a Web Worker (`findCollateralInWorker`), which takes seconds: the view says
// "computing" until it answers.
import { useQuery } from '@tanstack/react-query'

import { type CollateralLeft, collateralLeft } from '@/privateLending/collateralFigures'
import { findCollateralInWorker } from '@/privateLending/collateralSearch'

import { privateCollateralQueryKey } from './queryKeys'
import type { LoanFigures } from './useLoan'

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
  const query = useQuery({
    queryKey: privateCollateralQueryKey(input?.valueCommitment ?? '', input?.assetCommitment ?? ''),
    enabled: input !== undefined,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      if (input === undefined) throw new Error('No search to run')
      // `undefined` is not a query result: none found is `null`.
      return (await findCollateralInWorker(input)) ?? null
    },
  })
  return collateralLeft(total, loan, {
    status: input === undefined ? 'idle' : query.status,
    amount: query.data ?? undefined,
  })
}
