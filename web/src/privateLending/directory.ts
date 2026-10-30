// Directory writes, signed with the lending key over a server challenge: request a challenge, sign
// it with `signDirectoryAction`, then write. Only the x-only key leaves the browser. A rejected
// write throws the `ApiError` (`indexerErrorMessage` gives the server's message, such as a `401`
// "unknown, used or expired challenge").
import {
  deleteDirectoryEntry,
  type DirectoryEntry,
  putDirectoryEntry,
  requestDirectoryChallenge,
} from '@/api/indexer/private'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'

/** Creates or renames the key's directory entry; returns it. */
export async function registerInDirectory(
  deps: PrivateFlowDeps,
  key: LendingKey,
  displayName: string,
  apiBaseUrl: string,
): Promise<DirectoryEntry> {
  const { challenge } = await requestDirectoryChallenge(apiBaseUrl)
  const signature = deps.wasm.signDirectoryAction(
    key,
    deps.wasm.DirectoryAction.Put,
    challenge,
    displayName,
  )
  return putDirectoryEntry(
    key.xOnlyPublicKey(),
    { display_name: displayName, challenge, signature },
    apiBaseUrl,
  )
}

/** Removes the key's directory entry; the indexer answers `404` if there is none. */
export async function removeFromDirectory(
  deps: PrivateFlowDeps,
  key: LendingKey,
  apiBaseUrl: string,
): Promise<void> {
  const { challenge } = await requestDirectoryChallenge(apiBaseUrl)
  // A delete is signed over an empty name, as the indexer verifies it.
  const signature = deps.wasm.signDirectoryAction(
    key,
    deps.wasm.DirectoryAction.Delete,
    challenge,
    '',
  )
  await deleteDirectoryEntry(key.xOnlyPublicKey(), { challenge, signature }, apiBaseUrl)
}
