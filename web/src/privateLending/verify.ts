// The verification gate: the only producer of a `VerifiedOffer`. Every builder that spends an
// offer takes one, so an offer that was not opened with the user's key and checked against the
// addresses of its own terms can never be spent.
import type { Transaction } from 'lwk_wasm'

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

/**
 * The lender's check of the bounds of proportional release before it accepts (proofs, O9):
 * `1 ≤ C ≤ 2^44` and `1 ≤ R ≤ 2^50 − 2`, by the offer's own check and by the free one on its
 * terms. The release proof is sound only within them, and nothing on chain bounds `R`. Throws
 * `PrivateOfferError` `out-of-bounds`, an offer addressed to the key that it must not accept.
 */
export function checkLenderBounds(
  wasm: Pick<PrivateFlowDeps['wasm'], 'checkOfferBounds'>,
  opened: Pick<OpenedOffer, 'checkOfferBounds' | 'collateralAmount' | 'repaymentAmount'>,
): void {
  try {
    opened.checkOfferBounds()
    wasm.checkOfferBounds(opened.collateralAmount(), opened.repaymentAmount())
  } catch (error) {
    const refusal = toOfferError(error)
    throw new PrivateOfferError(refusal.code, refusal.message, true)
  }
}

/**
 * Opens the creation `creationTxHex` with `key` as `role` and checks it against the addresses of
 * its own terms, every argument recomputed from the shared secret and the terms, the release
 * proof's points, `FS_IV` and `BLINDER_ROOT` included (`contractArguments()`). The lender's also
 * checks the bounds of release (`checkLenderBounds`). Throws `PrivateOfferError`.
 */
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

  try {
    if (role === 'lender') checkLenderBounds(deps.wasm, opened)
    const creationTx = deps.lwk.Transaction.fromString(creationTxHex)
    let args
    try {
      args = opened.contractArguments()
    } catch (error) {
      // The arguments are recomputed from the shared secret and the terms: a failure is the
      // offer's, never "not addressed to this key".
      const refusal = toOfferError(error)
      throw new PrivateOfferError(refusal.code, refusal.message, true)
    }
    const scripts = privateOfferScripts(deps.sources, toPrivateOfferArguments(args), deps.network)
    if (!verifyOfferAddresses(scripts, creationTx)) {
      throw new PrivateOfferError(
        'address-mismatch',
        'the pending offer or the lender NFT is not locked to the scripts of the offer terms',
        true,
      )
    }
    return { role, creationTx, opened, scripts } as VerifiedOffer
  } catch (error) {
    // The opened offer holds the offer's secrets, and no caller gets it to free.
    opened.free()
    throw error
  }
}
