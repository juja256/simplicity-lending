import { z as zod } from 'zod'

import { blockHeightSchema } from '@/utils/zod'

export const INDEXER_EVENT_NAMES = ['block_indexed'] as const
export type IndexerEventName = (typeof INDEXER_EVENT_NAMES)[number]

const indexerEventSchema = zod.discriminatedUnion('type', [
  zod.object({ type: zod.literal('block_indexed'), height: blockHeightSchema }),
])
export type IndexerEvent = zod.infer<typeof indexerEventSchema>

export function parseIndexerEvent(raw: string): IndexerEvent | null {
  try {
    return indexerEventSchema.safeParse(JSON.parse(raw)).data ?? null
  } catch {
    return null
  }
}
