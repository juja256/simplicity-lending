import { Skeleton } from '@heroui/react'
import type { UseQueryResult } from '@tanstack/react-query'

import Notice from '@/components/Notice'
import { UiButton } from '@/components/ui/UiButton'
import type { OwnEntry } from '@/privateLending/hooks/useDirectory'
import { useLendingKeyIdentity } from '@/privateLending/hooks/usePrivateFlowDeps'
import { ErrorHandler } from '@/utils/errorHandler'

/**
 * The wallet's directory entry while it is not known: why it failed (the lending key, or the
 * indexer, with a retry), or a placeholder while it loads.
 */
export default function OwnEntryPending({ ownQuery }: { ownQuery: UseQueryResult<OwnEntry> }) {
  const identity = useLendingKeyIdentity()

  if (identity.isError) {
    return (
      <Notice tone='danger' role='alert'>
        Your lending key could not be derived: {ErrorHandler.describe(identity.error)}
      </Notice>
    )
  }
  if (ownQuery.isError) {
    return (
      <Notice tone='danger' role='alert' className='flex flex-wrap items-center gap-2'>
        <span className='flex-1'>
          Your directory entry could not be loaded: {ErrorHandler.describe(ownQuery.error)}
        </span>
        <UiButton size='sm' variant='ghost' onPress={() => void ownQuery.refetch()}>
          Try again
        </UiButton>
      </Notice>
    )
  }
  return <Skeleton className='h-24 w-full rounded-2xl' />
}
