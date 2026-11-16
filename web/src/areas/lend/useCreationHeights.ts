import { queryOptions, useQueries, type UseQueryResult } from '@tanstack/react-query'
import { useMemo } from 'react'

import { fetchTxStatus } from '@/api/esplora/methods'
import { esploraQueryKeys } from '@/api/esplora/queryKeys'
import { GC_TIME_MS, STALE_TIME_MS } from '@/api/staleTime'

import { creationHeightOf } from './proposalFigures'

/** How often an unconfirmed creation is asked about again. */
const UNCONFIRMED_POLL_MS = 30_000

/** A creation's block height from esplora: null while unconfirmed, kept once confirmed. */
function creationHeightQuery(txid: string) {
  return queryOptions({
    queryKey: esploraQueryKeys.txBlockHeight(txid),
    queryFn: async ({ signal }) => creationHeightOf(await fetchTxStatus(txid, { signal })),
    staleTime: query =>
      typeof query.state.data === 'number' ? STALE_TIME_MS.immutable : STALE_TIME_MS.short,
    gcTime: GC_TIME_MS.long,
    refetchInterval: query => (typeof query.state.data === 'number' ? false : UNCONFIRMED_POLL_MS),
  })
}

function heightsOf(results: UseQueryResult<number | null>[]): (number | null)[] {
  return results.map(result => result.data ?? null)
}

/**
 * The height of the block each creation in `txids` confirmed in, read from esplora: the console's
 * term rule never takes the indexer's height. A creation is missing from the map until esplora
 * reports it confirmed (asked again every 30 s meanwhile); a confirmed height is kept, as it does
 * not change.
 */
export function useCreationHeights(txids: readonly string[]): ReadonlyMap<string, number> {
  const heights = useQueries({
    queries: txids.map(creationHeightQuery),
    combine: heightsOf,
  })
  return useMemo(() => {
    const confirmed = new Map<string, number>()
    txids.forEach((txid, index) => {
      const height = heights[index]
      if (height !== null && height !== undefined) confirmed.set(txid, height)
    })
    return confirmed
  }, [txids, heights])
}
