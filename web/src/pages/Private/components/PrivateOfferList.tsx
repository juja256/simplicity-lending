import { Skeleton, Spinner } from '@heroui/react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import Notice from '@/components/Notice'
import { OffersLoadError } from '@/components/OffersLoadError'
import { UiButton } from '@/components/ui/UiButton'
import type { PrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import { ErrorHandler } from '@/utils/errorHandler'

type OffersQuery = UseQueryResult<PrivateOffers>

/** How far the scan of the offers reached, with a spinner while it refreshes. */
export function ScanHeight({ offers }: { offers: OffersQuery }) {
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

interface PrivateOfferListProps {
  offers: OffersQuery
  isEmpty: boolean
  loadingText: string
  emptyText: string
  /** The rows, `<li>` elements. */
  children: ReactNode
}

/**
 * A list of private offers through the scan's states: loading, failed, empty, or the rows. A failed
 * refresh keeps the rows already loaded, under a warning.
 */
export default function PrivateOfferList({
  offers,
  isEmpty,
  loadingText,
  emptyText,
  children,
}: PrivateOfferListProps) {
  if (offers.data === undefined) {
    return offers.isError ? (
      <OffersLoadError error={offers.error} onRetry={() => void offers.refetch()} />
    ) : (
      <div className='flex flex-col gap-2'>
        <p className='text-muted text-sm'>{loadingText}</p>
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className='h-28 w-full rounded-2xl' />
        ))}
      </div>
    )
  }

  return (
    <>
      {offers.isError && (
        <Notice role='alert' className='flex flex-wrap items-center justify-between gap-2'>
          <span>The list could not be refreshed: {ErrorHandler.describe(offers.error)}</span>
          <UiButton size='sm' variant='ghost' onPress={() => void offers.refetch()}>
            Try Again
          </UiButton>
        </Notice>
      )}
      {isEmpty ? (
        <div className='bg-surface border-muted flex h-14 items-center rounded border border-dashed px-4 opacity-50'>
          <span className='text-foreground text-sm font-medium'>{emptyText}</span>
        </div>
      ) : (
        <ul className='flex flex-col gap-2'>{children}</ul>
      )}
    </>
  )
}
