// The verification gate: the only producer of a `VerifiedOffer`. Every builder that spends an
// offer takes one, so an offer that was not opened with the user's key and checked against the
// addresses of its own terms can never be spent.
import type { Transaction } from '@lilbonekit/lwk-web'

import {
  type PrivateOfferScripts,
  privateOfferScripts,
  toPrivateOfferArguments,
  verifyOfferAddresses,
} from '@/simplicity/private-lending/scripts'
import type { LendingKey, OpenedOffer } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'

declare const verifiedBrand: unique symbol

export interface VerifiedOffer {
  readonly [verifiedBrand]: true
  readonly role: 'lender' | 'borrower'
  readonly creationTx: Transaction
  readonly opened: OpenedOffer
  readonly scripts: PrivateOfferScripts
}

/** The wasm codes of a transaction that is simply not addressed to this key. */
const NOT_ADDRESSED_CODES: ReadonlySet<string> = new Set([
  'not-found',
  'view-tag-mismatch',
  'not-mine',
  'rewind-failed',
])

export class PrivateOfferError extends Error {
  constructor(
    /**
     * The wasm error code, `address-mismatch`, `terms-mismatch` (the creation's self-check: the
     * opened offer differs from the requested one), or `unknown`.
     */
    readonly code: string,
    message: string,
    /** False when the transaction is not addressed to the key, true otherwise (a bad offer). */
    readonly addressedToKey: boolean,
  ) {
    super(message)
    this.name = 'PrivateOfferError'
  }
}

// The wasm throws strings of the form "<code>: <message>".
function toOfferError(error: unknown): PrivateOfferError {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  const match = /^([a-z][a-z0-9-]*): ([\s\S]*)$/.exec(text)
  if (!match) return new PrivateOfferError('unknown', text || 'unknown error', true)
  const [, code, message] = match
  return new PrivateOfferError(code, message, !NOT_ADDRESSED_CODES.has(code))
}

export async function openAndVerifyOffer(
  deps: PrivateFlowDeps,
  role: 'lender' | 'borrower',
  key: LendingKey,
  creationTxHex: string,
): Promise<VerifiedOffer> {
  let opened: OpenedOffer
  try {
    opened =
      role === 'lender'
        ? deps.wasm.openCreationAsLender(key, creationTxHex)
        : deps.wasm.openCreationAsBorrower(key, creationTxHex)
  } catch (error) {
    throw toOfferError(error)
  }

  const creationTx = deps.lwk.Transaction.fromString(creationTxHex)
  const scripts = privateOfferScripts(
    deps.sources,
    toPrivateOfferArguments(opened.contractArguments()),
    deps.network,
  )
  if (!verifyOfferAddresses(scripts, creationTx)) {
    throw new PrivateOfferError(
      'address-mismatch',
      'the pending offer or the lender NFT is not locked to the scripts of the offer terms',
      true,
    )
  }
  return { role, creationTx, opened, scripts } as VerifiedOffer
}
