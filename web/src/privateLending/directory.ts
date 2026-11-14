// Directory writes, signed with the lending key over a server challenge: request a challenge, sign
// it with `signDirectoryAction`, then write. A put signs the name and the lender's terms together,
// which authenticates the write to the indexer: it refuses a put whose name or terms differ from
// what the key signed. Readers cannot check what the indexer serves; verifying served entries in
// the browser comes in phase 4. Callers pass terms the lender built (`lenderTermsFromForm`),
// never terms an indexer served: those carry no signature the app checks, and signing them would
// publish whatever the indexer put there. Only the x-only key leaves the browser. A rejected
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
import type { LenderTermsInput } from './lenderTerms'

/**
 * Creates the key's directory entry, or replaces its name and terms, and returns it. Terms the
 * wasm refuses (`LenderTerms::validate`) throw its `bad-input` error before anything is sent.
 */
export async function registerInDirectory(
  deps: Pick<PrivateFlowDeps, 'wasm'>,
  key: LendingKey,
  displayName: string,
  terms: LenderTermsInput,
  apiBaseUrl: string,
): Promise<DirectoryEntry> {
  const termsJson = JSON.stringify(terms)
  // Checked before the challenge, so invalid terms do not use one up.
  deps.wasm.encodeLenderTerms(termsJson)
  const { challenge } = await requestDirectoryChallenge(apiBaseUrl)
  const signature = deps.wasm.signDirectoryAction(
    key,
    deps.wasm.DirectoryAction.Put,
    challenge,
    displayName,
    termsJson,
  )
  return putDirectoryEntry(
    key.xOnlyPublicKey(),
    { display_name: displayName, challenge, terms, signature },
    apiBaseUrl,
  )
}

/** Removes the key's directory entry; the indexer answers `404` if there is none. */
export async function removeFromDirectory(
  deps: Pick<PrivateFlowDeps, 'wasm'>,
  key: LendingKey,
  apiBaseUrl: string,
): Promise<void> {
  const { challenge } = await requestDirectoryChallenge(apiBaseUrl)
  // A delete is signed over an empty name and no terms, as the indexer verifies it.
  const signature = deps.wasm.signDirectoryAction(
    key,
    deps.wasm.DirectoryAction.Delete,
    challenge,
    '',
  )
  await deleteDirectoryEntry(key.xOnlyPublicKey(), { challenge, signature }, apiBaseUrl)
}
