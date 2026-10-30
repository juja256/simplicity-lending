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

/** Private lending queries. All of them refetch on `block_indexed`. */
export const privateQueryKeys = {
  all: () => ['private'] as const,
  offers: (network: string, apiBaseUrl: string, scriptPubkeyHex: string) =>
    ['private', 'offers', network, apiBaseUrl, normalizeHex(scriptPubkeyHex)] as const,
  directory: (apiBaseUrl: string) => ['private', 'directory', apiBaseUrl] as const,
  directoryEntry: (apiBaseUrl: string, pubkey: string) =>
    ['private', 'directory', apiBaseUrl, 'entry', normalizeHex(pubkey)] as const,
} as const
