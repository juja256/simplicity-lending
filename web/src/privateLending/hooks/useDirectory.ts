// The lender directory: the lenders whose served entries verify, with a lookup of their names by
// x-only key, the wallet's own entry, and the signed writes. Each entry is checked against its key
// (`checkDirectoryEntry`): only verified names and terms are shown or used, and an entry that does
// not verify is hidden from the lenders and counted. Names are chosen by whoever holds a key and
// are never an identity, verified or not: always show them (inside <bdi>) next to the key's
// fingerprint.
//
// The wallet's own entry is read by its x-only key, the one part of the key that leaves the
// browser (also in the writes and the offers it creates), and checked like any other.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { ApiError } from '@/api/errors'
import {
  type DirectoryEntry,
  fetchDirectory,
  fetchDirectoryEntry,
  indexerErrorMessage,
} from '@/api/indexer/private'
import { privateDirectoryQueryKeys } from '@/api/indexer/queryKeys'
import {
  checkDirectoryEntry,
  type EntryCheck,
  registerInDirectory,
  removeFromDirectory,
} from '@/privateLending/directory'
import type { LenderTermsInput } from '@/privateLending/lenderTerms'
import { getPrivateLendingWasm } from '@/privateLending/wasm'
import { useWallet } from '@/providers/wallet/useWallet'
import { normalizeHex } from '@/utils/hex'

import { PRIVATE_API_BASE_URL, useLendingKeyIdentity } from './usePrivateFlowDeps'

/** The indexer's largest page. */
const DIRECTORY_PAGE_LIMIT = 100
/** A bound on the pages read, against an indexer that never ends the list. */
const MAX_DIRECTORY_PAGES = 50
/** No block changes the directory: it refreshes after its own writes, or once this old. */
const DIRECTORY_STALE_MS = 5 * 60_000
const LIST_KEY = privateDirectoryQueryKeys.list(PRIVATE_API_BASE_URL)

/** A served entry and its check against its key. */
interface CheckedEntry {
  entry: DirectoryEntry
  check: EntryCheck
}

/** A listed lender whose entry verified, with the terms its key signed. */
export interface VerifiedLender {
  entry: DirectoryEntry
  terms: LenderTermsInput
}

/** The wallet's own entry, read by its key: both null when the indexer has none (a `404`). */
export interface OwnEntry {
  entry: DirectoryEntry | null
  check: EntryCheck | null
}

const NO_OWN_ENTRY: OwnEntry = { entry: null, check: null }

/** Every entry, in the indexer's order, up to `MAX_DIRECTORY_PAGES` pages. */
async function fetchWholeDirectory(signal: AbortSignal): Promise<DirectoryEntry[]> {
  const entries = new Map<string, DirectoryEntry>()
  let offset = 0
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page++) {
    const list = await fetchDirectory(
      { limit: DIRECTORY_PAGE_LIMIT, offset },
      PRIVATE_API_BASE_URL,
      { signal },
    )
    const fresh = list.items.filter(entry => !entries.has(entry.pubkey))
    for (const entry of fresh) entries.set(entry.pubkey, entry)
    offset += list.items.length
    // An empty page ends the list; so does one that only repeats (an indexer ignoring `offset`).
    if (fresh.length === 0 || offset >= list.total) break
  }
  return [...entries.values()]
}

/** Every listed entry with its check, in the indexer's order. */
async function fetchCheckedDirectory(signal: AbortSignal): Promise<CheckedEntry[]> {
  const [entries, wasm] = await Promise.all([fetchWholeDirectory(signal), getPrivateLendingWasm()])
  return entries.map(entry => ({ entry, check: checkDirectoryEntry(wasm, entry) }))
}

/** The entry of `pubkey` with its check, or `NO_OWN_ENTRY` when the indexer answers `404`. */
async function fetchCheckedEntry(pubkey: string, signal: AbortSignal): Promise<OwnEntry> {
  const [entry, wasm] = await Promise.all([
    fetchDirectoryEntry(pubkey, PRIVATE_API_BASE_URL, { signal }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }),
    getPrivateLendingWasm(),
  ])
  return entry === null ? NO_OWN_ENTRY : { entry, check: checkDirectoryEntry(wasm, entry) }
}

/**
 * A rejected write with the indexer's own message (such as a `401` "unknown, used or expired
 * challenge" or "invalid signature"), so it is shown as the server worded it.
 */
function toDirectoryWriteError(error: unknown): unknown {
  const message = indexerErrorMessage(error)
  return message === undefined ? error : new Error(message, { cause: error })
}

export function useDirectory() {
  const queryClient = useQueryClient()
  const { getLendingKey } = useWallet()
  const identity = useLendingKeyIdentity().data

  const directory = useQuery({
    queryKey: LIST_KEY,
    queryFn: ({ signal }) => fetchCheckedDirectory(signal),
    staleTime: DIRECTORY_STALE_MS,
  })

  const ownQuery = useQuery({
    queryKey: privateDirectoryQueryKeys.entry(PRIVATE_API_BASE_URL, identity?.pubkey ?? ''),
    queryFn: ({ signal }) => fetchCheckedEntry(identity!.pubkey, signal),
    enabled: identity !== undefined,
    staleTime: DIRECTORY_STALE_MS,
  })

  const checked = useMemo(() => directory.data ?? [], [directory.data])
  const lenders = useMemo(
    () =>
      checked.flatMap(({ entry, check }): VerifiedLender[] =>
        check.status === 'verified' ? [{ entry, terms: check.terms }] : [],
      ),
    [checked],
  )
  const byPubkey = useMemo(
    () => new Map(lenders.map(({ entry }) => [entry.pubkey, entry])),
    [lenders],
  )
  /**
   * The verified entry of an x-only key (any case), if the directory lists one. The signature
   * binds the name, so a key whose entry did not verify, or is not listed, gets undefined: show
   * its fingerprint with no name.
   */
  const lookup = useCallback(
    (pubkey: string): DirectoryEntry | undefined => byPubkey.get(normalizeHex(pubkey)),
    [byPubkey],
  )

  /**
   * Applies a write the indexer accepted to the loaded list and to the wallet's entry, until the
   * refetch replaces them. `written` is null for a removal.
   */
  const applyWrite = useCallback(
    (pubkey: string, written: CheckedEntry | null) => {
      queryClient.setQueryData<CheckedEntry[]>(LIST_KEY, loaded => {
        if (loaded === undefined) return loaded
        if (written === null) return loaded.filter(listed => listed.entry.pubkey !== pubkey)
        return loaded.some(listed => listed.entry.pubkey === pubkey)
          ? loaded.map(listed => (listed.entry.pubkey === pubkey ? written : listed))
          : [...loaded, written]
      })
      queryClient.setQueryData<OwnEntry>(
        privateDirectoryQueryKeys.entry(PRIVATE_API_BASE_URL, pubkey),
        written ?? NO_OWN_ENTRY,
      )
    },
    [queryClient],
  )
  const invalidateDirectory = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: privateDirectoryQueryKeys.api(PRIVATE_API_BASE_URL),
      }),
    [queryClient],
  )

  /** Creates the wallet's entry, or replaces its name and terms; the written entry is checked. */
  const register = useMutation({
    mutationFn: async ({
      displayName,
      terms,
    }: {
      displayName: string
      terms: LenderTermsInput
    }): Promise<CheckedEntry> => {
      try {
        const [wasm, key] = await Promise.all([getPrivateLendingWasm(), getLendingKey()])
        const entry = await registerInDirectory(
          { wasm },
          key,
          displayName,
          terms,
          PRIVATE_API_BASE_URL,
        )
        return { entry, check: checkDirectoryEntry(wasm, entry) }
      } catch (error) {
        throw toDirectoryWriteError(error)
      }
    },
    onSuccess: written => applyWrite(written.entry.pubkey, written),
    onSettled: invalidateDirectory,
  })

  /** Removes the wallet's entry; fails with the indexer's message if there is none. */
  const remove = useMutation({
    mutationFn: async (): Promise<void> => {
      let pubkey: string
      try {
        const [wasm, key] = await Promise.all([getPrivateLendingWasm(), getLendingKey()])
        pubkey = key.xOnlyPublicKey()
        await removeFromDirectory({ wasm }, key, PRIVATE_API_BASE_URL)
      } catch (error) {
        throw toDirectoryWriteError(error)
      }
      applyWrite(pubkey, null)
    },
    onSettled: invalidateDirectory,
  })

  return {
    /** The list query: loading and error state, `refetch`. */
    directory,
    /**
     * The listed lenders whose entries verified, ordered by name, then key, each with the terms
     * its key signed. The wallet's own entry is among them when it verified.
     */
    lenders,
    /** Listed entries that did not verify, left out of `lenders`. */
    hiddenCount: checked.length - lenders.length,
    lookup,
    /** The wallet's lending-key identity; undefined until known (or without a capable wallet). */
    identity,
    /** The query of the wallet's own entry: loading and error state, `refetch`. */
    ownQuery,
    /**
     * The wallet's entry, read by its key and checked: undefined until the identity and the
     * entry are known. An entry without terms (written before the directory carried them) is
     * here too, though the list leaves it out.
     */
    own: ownQuery.data,
    register,
    remove,
  }
}
