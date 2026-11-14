// The lender directory: signed writes, and the check of what the indexer serves.
//
// Writes are signed with the lending key over a server challenge: request a challenge, sign it
// with `signDirectoryAction`, then write. A put signs the name and the lender's terms together,
// which authenticates the write to the indexer: it refuses a put whose name or terms differ from
// what the key signed. Callers pass terms the lender built (`lenderTermsFromForm`), never terms an
// indexer served: signing those would publish whatever the indexer put there. Only the x-only key
// leaves the browser. A rejected write throws the `ApiError` (`indexerErrorMessage` gives the
// server's message, such as a `401` "unknown, used or expired challenge").
//
// The indexer serves each entry with the challenge and the signature of its last put, so readers
// check the served name and terms against the key (`checkDirectoryEntry`) and use only entries
// that verify. The check proves the key signed this name and these terms once; it cannot prove
// they are the key's latest, as an indexer can serve an older put, nor the time it reports.
import {
  deleteDirectoryEntry,
  type DirectoryEntry,
  putDirectoryEntry,
  requestDirectoryChallenge,
} from '@/api/indexer/private'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'
import type { LenderTermsInput } from './lenderTerms'
import type { PrivateLendingWasm } from './wasm'

/**
 * A served entry checked against its key: `verified` with the terms the key signed together with
 * the name; `unsigned` when the indexer serves no challenge or signature (an entry written before
 * it kept them, or one it stripped); `invalid` when the signature does not verify for the served
 * key, name and terms, the terms could not be read, or the hex is malformed.
 */
export type EntryCheck =
  | { status: 'verified'; terms: LenderTermsInput }
  | { status: 'unsigned' | 'invalid' }

/** Checks a served entry's name and terms against its key (the wasm's `verifyDirectoryEntry`). */
export function checkDirectoryEntry(
  wasm: Pick<PrivateLendingWasm, 'verifyDirectoryEntry'>,
  entry: DirectoryEntry,
): EntryCheck {
  const { pubkey, display_name, terms, signed_challenge, signature } = entry
  if (signed_challenge === null || signature === null) return { status: 'unsigned' }
  // A put always signs terms: an entry served without them cannot be one the key signed.
  if (terms === null) return { status: 'invalid' }
  let verified: boolean
  try {
    verified = wasm.verifyDirectoryEntry(
      pubkey,
      signed_challenge,
      display_name,
      JSON.stringify(terms),
      signature,
    )
  } catch {
    // A `bad-input` error: malformed hex, or a key that is not an x-only public key.
    verified = false
  }
  return verified ? { status: 'verified', terms } : { status: 'invalid' }
}

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
