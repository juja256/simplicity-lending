import type { QueryClient } from '@tanstack/react-query'

import { softAssertNever } from '@/utils/assert'

import type { IndexerEvent } from './events'
import { privateQueryKeys } from './queryKeys'

export function invalidateEventQueries(event: IndexerEvent, queryClient: QueryClient): void {
  switch (event.type) {
    case 'block_indexed':
      // Private offers emit no event of their own: their views refetch on each indexed block.
      queryClient.invalidateQueries({ queryKey: privateQueryKeys.all() })
      break

    default:
      softAssertNever(event.type)
  }
}
