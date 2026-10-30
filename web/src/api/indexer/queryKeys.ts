import { normalizeHex } from '@/utils/hex'

import { type ListOffersParams, toQueryParams } from './methods'

export const offersQueryKeys = {
  all: () => ['offers'] as const,
  lists: () => ['offers', 'list'] as const,
  list: (params: ListOffersParams) => ['offers', 'list', toQueryParams(params)] as const,
  detail: (offerId: string) => ['offers', 'detail', offerId] as const,
  overview: () => ['offers', 'overview'] as const,
} as const

export const borrowerQueryKeys = {
  all: () => ['borrower'] as const,
  overview: (scriptPubkeyHex: string) =>
    ['borrower', 'overview', normalizeHex(scriptPubkeyHex)] as const,
  offers: (scriptPubkeyHex: string, params: ListOffersParams = {}) =>
    ['borrower', 'offers', normalizeHex(scriptPubkeyHex), toQueryParams(params)] as const,
} as const

export const lenderQueryKeys = {
  all: () => ['lender'] as const,
  overview: (scriptPubkeyHex: string) =>
    ['lender', 'overview', normalizeHex(scriptPubkeyHex)] as const,
  offers: (scriptPubkeyHex: string, params: ListOffersParams = {}) =>
    ['lender', 'offers', normalizeHex(scriptPubkeyHex), toQueryParams(params)] as const,
} as const

export const factoryQueryKeys = {
  all: () => ['factories'] as const,
  byScript: (scriptPubkeyHex: string) =>
    ['factories', 'by-script', normalizeHex(scriptPubkeyHex)] as const,
  detail: (factoryId: string) => ['factories', 'detail', factoryId] as const,
} as const

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
  list: (apiBaseUrl: string) => ['private-directory', apiBaseUrl] as const,
} as const
