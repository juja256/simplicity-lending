import { normalizeHex } from '@/utils/hex'

/** Private lending queries that follow the chain: all of them refetch on `block_indexed`. */
export const privateQueryKeys = {
  all: () => ['private'] as const,
  offers: (network: string, apiBaseUrl: string, scriptPubkeyHex: string) =>
    ['private', 'offers', network, apiBaseUrl, normalizeHex(scriptPubkeyHex)] as const,
} as const

/**
 * The lender directory: signed off-chain writes that no block changes, so it stays off the
 * `block_indexed` root and refreshes after its own writes (and when stale).
 */
export const privateDirectoryQueryKeys = {
  all: () => ['private-directory'] as const,
  /** The list and every entry read by key, of one indexer. */
  api: (apiBaseUrl: string) => ['private-directory', apiBaseUrl] as const,
  list: (apiBaseUrl: string) => ['private-directory', apiBaseUrl, 'list'] as const,
  entry: (apiBaseUrl: string, pubkey: string) =>
    ['private-directory', apiBaseUrl, 'entry', normalizeHex(pubkey)] as const,
} as const
