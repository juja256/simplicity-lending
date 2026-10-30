// The lender directory: the whole list with a lookup by x-only key, the wallet's own entry, and
// the signed writes. Names are chosen by whoever holds a key and are never verified: always show
// them (inside <bdi>) next to the key's fingerprint.
//
// Reads never carry the wallet's key: its own entry is found in the list. The x-only key leaves
// the browser only in a write (and in the offers it creates).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { type DirectoryEntry, fetchDirectory, indexerErrorMessage } from '@/api/indexer/private'
import { privateDirectoryQueryKeys } from '@/api/indexer/queryKeys'
import { registerInDirectory, removeFromDirectory } from '@/privateLending/directory'
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
  const own = useLendingKeyIdentity().data

  const directory = useQuery({
    queryKey: privateDirectoryQueryKeys.list(PRIVATE_API_BASE_URL),
    queryFn: ({ signal }) => fetchWholeDirectory(signal),
    staleTime: DIRECTORY_STALE_MS,
  })

  const entries = useMemo(() => directory.data ?? [], [directory.data])
  const byPubkey = useMemo(() => new Map(entries.map(entry => [entry.pubkey, entry])), [entries])
  /** The entry of an x-only key (any case), if the directory lists it. */
  const lookup = useCallback(
    (pubkey: string): DirectoryEntry | undefined => byPubkey.get(normalizeHex(pubkey)),
    [byPubkey],
  )

  /** Applies a write the indexer accepted to the loaded list, until the refetch replaces it. */
  const updateList = useCallback(
    (update: (entries: DirectoryEntry[]) => DirectoryEntry[]) =>
      queryClient.setQueryData<DirectoryEntry[]>(
        privateDirectoryQueryKeys.list(PRIVATE_API_BASE_URL),
        loaded => (loaded === undefined ? loaded : update(loaded)),
      ),
    [queryClient],
  )
  const invalidateDirectory = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: privateDirectoryQueryKeys.list(PRIVATE_API_BASE_URL),
      }),
    [queryClient],
  )

  /** Creates or renames the wallet's entry. */
  const register = useMutation({
    mutationFn: async (displayName: string): Promise<DirectoryEntry> => {
      try {
        const [wasm, key] = await Promise.all([getPrivateLendingWasm(), getLendingKey()])
        return await registerInDirectory({ wasm }, key, displayName, PRIVATE_API_BASE_URL)
      } catch (error) {
        throw toDirectoryWriteError(error)
      }
    },
    onSuccess: entry =>
      updateList(loaded =>
        loaded.some(listed => listed.pubkey === entry.pubkey)
          ? loaded.map(listed => (listed.pubkey === entry.pubkey ? entry : listed))
          : [...loaded, entry],
      ),
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
      updateList(loaded => loaded.filter(listed => listed.pubkey !== pubkey))
    },
    onSettled: invalidateDirectory,
  })

  return {
    /** The list query: loading and error state, `refetch`. */
    directory,
    /** Every entry, ordered by name, then key. */
    entries,
    lookup,
    /** The wallet's lending-key identity; undefined until known (or without a capable wallet). */
    own,
    /**
     * The wallet's entry, found in the loaded list: undefined until the list and the identity are
     * known, null if the list does not have it.
     */
    ownEntry: own !== undefined && directory.isSuccess ? (lookup(own.pubkey) ?? null) : undefined,
    register,
    remove,
  }
}
