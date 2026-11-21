// The indexer's private lending endpoints: candidates and the lender directory, with the shapes of
// `crates/indexer/README.md` ("Private lending", "Lender directory"). Every function takes the API
// base URL, so Node (the e2e script) runs the same code; the app passes `env.VITE_API_URL`.
//
// The indexer is untrusted: it can hide candidates, invent them, or pair a candidate with another
// transaction. Callers verify every offer (`privateLending/scan.ts`) and show key fingerprints.
import { z as zod } from 'zod'

import type { LenderTermsInput, PairTermsInput } from '@/privateLending/lenderTerms'

import { deleteJson, postJson, putJson, requestJson, type RequestParams } from '../client'
import { ApiError } from '../errors'

/** Plain hex of exactly `bytes` bytes, lowercased. */
function hexBytes(bytes: number) {
  return zod
    .string()
    .regex(new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`), `must be ${bytes} bytes of hex`)
    .transform(value => value.toLowerCase())
}

const hex32 = hexBytes(32)
const countSchema = zod.number().int().nonnegative()
const heightSchema = zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const unixSecondsSchema = zod.number().int()
const u32Schema = zod
  .number()
  .int()
  .min(0)
  .max(2 ** 32 - 1)
/** A `u64` as decimal digits, as the indexer writes the terms' amounts. */
const u64Schema = zod
  .string()
  .regex(/^\d{1,20}$/, 'must be decimal digits')
  .refine(value => BigInt(value) < 2n ** 64n, 'must be at most u64::MAX')

export const privateOfferStatusSchema = zod.enum([
  'pending',
  'active',
  'cancelled',
  'repaid',
  'liquidated',
])
export type PrivateOfferStatus = zod.infer<typeof privateOfferStatusSchema>

/**
 * `active_offer` is the loan: an installment spends it and leaves its successor at output 1 and the
 * `installment` at output 2. `repayment` is the full repayment's output; a zero-debt close leaves
 * none.
 */
export const privateUtxoTypeSchema = zod.enum([
  'pending_offer',
  'active_offer',
  'principal',
  'repayment',
  'installment',
])
export type PrivateUtxoType = zod.infer<typeof privateUtxoTypeSchema>

export const privateCandidateSchema = zod.object({
  /** Display order. The offer is output 3 of this transaction. */
  creation_txid: hex32,
  /** Output 3's nonce: a 33-byte compressed public key. */
  nonce: hexBytes(33),
  view_tag: zod.number().int().min(0).max(255),
  encrypted_lender_key: hex32,
  first_input: zod.object({ txid: hex32, vout: countSchema }),
  borrower_nft_asset_id: hex32,
  lender_nft_asset_id: hex32,
  /** Meaningless for a fake candidate: trust it only for an offer that verifies. */
  status: privateOfferStatusSchema,
  created_at_height: heightSchema,
  updated_at_height: heightSchema,
})
export type PrivateCandidate = zod.infer<typeof privateCandidateSchema>

export const privateCandidateListSchema = zod.object({
  items: zod.array(privateCandidateSchema),
  /** Candidates in the height range, ignoring paging. */
  total: countSchema,
  limit: countSchema,
  offset: countSchema,
  /** The height the items go up to; null before the first block is indexed. */
  last_indexed_height: heightSchema.nullable(),
})
export type PrivateCandidateList = zod.infer<typeof privateCandidateListSchema>

export const privateUtxoSchema = zod.object({
  utxo_type: privateUtxoTypeSchema,
  txid: hex32,
  vout: countSchema,
  created_at_height: heightSchema,
  /** Null while unspent. */
  spent_txid: hex32.nullable(),
  spent_at_height: heightSchema.nullable(),
})
export type PrivateUtxo = zod.infer<typeof privateUtxoSchema>

export const privateCandidateDetailsSchema = privateCandidateSchema.extend({
  /** Ordered by creation height, then `vout`. */
  utxos: zod.array(privateUtxoSchema),
})
export type PrivateCandidateDetails = zod.infer<typeof privateCandidateDetailsSchema>

const privateCreationTxSchema = zod.object({
  tx_hex: zod.string().regex(/^(?:[0-9a-fA-F]{2})+$/, 'must be hex'),
})

export const directoryChallengeSchema = zod.object({
  challenge: hex32,
  /** Unix seconds. */
  expires_at: unixSecondsSchema,
})
export type DirectoryChallenge = zod.infer<typeof directoryChallengeSchema>

/** One pair of a lender's terms, with the core's `PairTerms` field names (`lenderTerms.ts`). */
export const pairTermsSchema = zod
  .object({
    principal_asset: hex32,
    collateral_asset: hex32,
    min_apr_bps: u32Schema,
    max_principal_per_collateral: u64Schema,
    min_term_days: u32Schema,
    max_term_days: u32Schema,
    min_principal: u64Schema,
    max_principal: u64Schema,
  })
  .strict() satisfies zod.ZodType<PairTermsInput, zod.ZodTypeDef, unknown>

export const lenderTermsSchema = zod
  .object({ pairs: zod.array(pairTermsSchema).min(1).max(8) })
  .strict() satisfies zod.ZodType<LenderTermsInput, zod.ZodTypeDef, unknown>

export const directoryEntrySchema = zod.object({
  /** The x-only lending key. */
  pubkey: hex32,
  /** Chosen by whoever holds the key: never a verified identity. */
  display_name: zod.string(),
  /**
   * The lender's terms, unchecked beyond their shape: use them only as `checkDirectoryEntry`
   * returns them, verified. Null for an entry without terms, and for terms the indexer could not
   * decode or served malformed: one such entry must not hide the others.
   */
  terms: lenderTermsSchema.nullable().catch(null),
  /** Unix seconds of the terms' publication; null when the entry has no terms. Not signed. */
  terms_published_at: unixSecondsSchema.nullable(),
  /**
   * The challenge the last put consumed and the signature it carried, as served: hex the wasm
   * checks (`checkDirectoryEntry`), so malformed hex fails that check instead of the whole list.
   * Null for an entry written before the indexer kept them, and for a value that is not a string.
   */
  signed_challenge: zod.string().nullable().catch(null),
  signature: zod.string().nullable().catch(null),
  /** Unix seconds. */
  created_at: unixSecondsSchema,
  updated_at: unixSecondsSchema,
})
export type DirectoryEntry = zod.infer<typeof directoryEntrySchema>

export const directoryListSchema = zod.object({
  items: zod.array(directoryEntrySchema),
  /** Entries with terms, ignoring paging. */
  total: countSchema,
  limit: countSchema,
  offset: countSchema,
})
export type DirectoryList = zod.infer<typeof directoryListSchema>

export interface PutDirectoryEntryBody {
  display_name: string
  challenge: string
  /** Signed together with the name. */
  terms: LenderTermsInput
  signature: string
}

export interface DeleteDirectoryEntryBody {
  challenge: string
  signature: string
}

export interface CandidatesParams {
  fromHeight: number
  /** Capped by the indexer at its sync height. */
  toHeight?: number
  /** At most 500 (the indexer answers `400` above it); 100 by default. */
  limit?: number
  offset?: number
}

export interface DirectoryParams {
  /** At most 100 (the indexer answers `400` above it); 50 by default. */
  limit?: number
  offset?: number
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString()
  return query ? `${baseUrl}${path}?${query}` : `${baseUrl}${path}`
}

function candidateUrl(baseUrl: string, txid: string, suffix = ''): string {
  return buildUrl(baseUrl, `/private/candidates/${encodeURIComponent(txid)}${suffix}`)
}

function directoryEntryUrl(baseUrl: string, pubkey: string): string {
  return buildUrl(baseUrl, `/private/directory/${encodeURIComponent(pubkey)}`)
}

/** Candidates created in a height range, ordered by `(created_at_height, id)`. */
export async function fetchPrivateCandidates(
  { fromHeight, toHeight, limit, offset }: CandidatesParams,
  baseUrl: string,
  options: RequestParams = {},
): Promise<PrivateCandidateList> {
  const params: Record<string, string> = { from_height: String(fromHeight) }
  if (toHeight !== undefined) params.to_height = String(toHeight)
  if (limit !== undefined) params.limit = String(limit)
  if (offset !== undefined) params.offset = String(offset)
  return requestJson(buildUrl(baseUrl, '/private/candidates', params), privateCandidateListSchema, {
    signal: options.signal,
  })
}

/** One candidate with its tracked UTXOs; `404` if the indexer does not know it. */
export async function fetchPrivateCandidate(
  txid: string,
  baseUrl: string,
  options: RequestParams = {},
): Promise<PrivateCandidateDetails> {
  return requestJson(candidateUrl(baseUrl, txid), privateCandidateDetailsSchema, {
    signal: options.signal,
  })
}

/**
 * The creation transaction the indexer stores for a candidate, as consensus-encoded hex. It may be
 * any transaction: check its txid before trusting it (`privateLending/scan.ts`).
 */
export async function fetchPrivateCreationTx(
  txid: string,
  baseUrl: string,
  options: RequestParams = {},
): Promise<string> {
  const url = candidateUrl(baseUrl, txid, '/tx')
  const { tx_hex } = await requestJson(url, privateCreationTxSchema, { signal: options.signal })
  return tx_hex.toLowerCase()
}

/** Directory entries with terms, ordered by `(display_name, pubkey)`. */
export async function fetchDirectory(
  { limit, offset }: DirectoryParams,
  baseUrl: string,
  options: RequestParams = {},
): Promise<DirectoryList> {
  const params: Record<string, string> = {}
  if (limit !== undefined) params.limit = String(limit)
  if (offset !== undefined) params.offset = String(offset)
  return requestJson(buildUrl(baseUrl, '/private/directory', params), directoryListSchema, {
    signal: options.signal,
  })
}

/** One directory entry, with or without terms; `404` if the key has none. */
export async function fetchDirectoryEntry(
  pubkey: string,
  baseUrl: string,
  options: RequestParams = {},
): Promise<DirectoryEntry> {
  return requestJson(directoryEntryUrl(baseUrl, pubkey), directoryEntrySchema, {
    signal: options.signal,
  })
}

/** A single-use challenge for one directory write, valid for 300 seconds. */
export async function requestDirectoryChallenge(baseUrl: string): Promise<DirectoryChallenge> {
  return postJson(
    buildUrl(baseUrl, '/private/directory/challenges'),
    undefined,
    directoryChallengeSchema,
  )
}

/** Creates or replaces the name and the terms of the entry of `pubkey`; returns it. */
export async function putDirectoryEntry(
  pubkey: string,
  body: PutDirectoryEntryBody,
  baseUrl: string,
): Promise<DirectoryEntry> {
  return putJson(directoryEntryUrl(baseUrl, pubkey), body, directoryEntrySchema)
}

/** Removes the entry of `pubkey`; `404` if there is none. */
export async function deleteDirectoryEntry(
  pubkey: string,
  body: DeleteDirectoryEntryBody,
  baseUrl: string,
): Promise<void> {
  await deleteJson(directoryEntryUrl(baseUrl, pubkey), body)
}

const indexerErrorBodySchema = zod.object({
  error: zod.object({ code: zod.string(), message: zod.string() }),
})

/**
 * The server's message of an indexer error response (`{ error: { code, message } }`), such as a
 * directory write's `401` "invalid signature" or "unknown, used or expired challenge"; undefined
 * for any other error.
 */
export function indexerErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.body) return undefined
  try {
    const parsed = indexerErrorBodySchema.safeParse(JSON.parse(error.body))
    return parsed.success ? parsed.data.error.message : undefined
  } catch {
    return undefined
  }
}
