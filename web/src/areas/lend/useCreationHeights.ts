import { queryOptions, useQueries, type UseQueryResult } from '@tanstack/react-query'
import { useMemo } from 'react'

import { fetchTxStatus } from '@/api/esplora/methods'
import { esploraQueryKeys } from '@/api/esplora/queryKeys'
import { GC_TIME_MS, STALE_TIME_MS } from '@/api/staleTime'

import { creationHeightOf } from './proposalFigures'

/** How often an unconfirmed creation is asked about again. */
const UNCONFIRMED_POLL_MS = 30_000

/**
 * What esplora last answered about a creation: the block it confirmed in, that it is not
 * confirmed yet, or nothing it could read.
 */
export type CreationHeight =
  | { kind: 'confirmed'; height: number }
  | { kind: 'unconfirmed' }
  | { kind: 'failed' }

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

/**
 * A confirmed height is kept; otherwise the latest answer counts, a failed one included. Undefined
 * while the first answer loads.
 */
function heightOf(result: UseQueryResult<number | null>): CreationHeight | undefined {
  if (typeof result.data === 'number') return { kind: 'confirmed', height: result.data }
  if (result.isError) return { kind: 'failed' }
  if (result.data === null) return { kind: 'unconfirmed' }
  return undefined
}

function heightsOf(results: UseQueryResult<number | null>[]): (CreationHeight | undefined)[] {
  return results.map(heightOf)
}

/**
 * What esplora answered about each creation in `txids`: the console's term rule never takes the
 * indexer's height. A creation is missing from the map until esplora's first answer; one not
 * confirmed, or that esplora failed on, is asked about again every 30 s; a confirmed height is
 * kept, as it does not change.
 */
export function useCreationHeights(txids: readonly string[]): ReadonlyMap<string, CreationHeight> {
  const heights = useQueries({
    queries: txids.map(creationHeightQuery),
    combine: heightsOf,
  })
  return useMemo(() => {
    const answered = new Map<string, CreationHeight>()
    txids.forEach((txid, index) => {
      const height = heights[index]
      if (height !== undefined) answered.set(txid, height)
    })
    return answered
  }, [txids, heights])
}
