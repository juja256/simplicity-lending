import { Spinner } from '@heroui/react'
import type { UseQueryResult } from '@tanstack/react-query'

import type { PrivateOffers } from '@/privateLending/hooks/usePrivateOffers'

/** How far the scan of the offers reached, with a spinner while it refreshes. */
export function ScanNote({ offers }: { offers: UseQueryResult<PrivateOffers> }) {
  if (!offers.data) return null
  return (
    <span className='text-muted inline-flex items-center gap-2 text-xs'>
      {offers.isFetching && <Spinner size='sm' />}
      {offers.data.syncedHeight === null
        ? 'Nothing indexed yet'
        : `Scanned up to block #${offers.data.syncedHeight}`}
    </span>
  )
}
