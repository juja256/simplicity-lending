import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { env } from '@/constants/env'

import { STALE_TIME_MS } from '../staleTime'
import { fetchLiquidPricesUsd } from './methods'
import { pricesQueryKeys } from './queryKeys'
import type { AssetPricesUsd } from './schemas'

export function useLiquidPricesUsd(): UseQueryResult<AssetPricesUsd> {
  return useQuery({
    queryKey: pricesQueryKeys.liquidUsd,
    enabled: env.VITE_NETWORK === 'liquid',
    queryFn: ({ signal }) => fetchLiquidPricesUsd({ signal }),
    staleTime: STALE_TIME_MS.short,
    refetchInterval: STALE_TIME_MS.short,
  })
}

export function useAssetPriceUsd(assetId: string): number | null {
  const { data } = useLiquidPricesUsd()
  return data?.[assetId] ?? null
}
