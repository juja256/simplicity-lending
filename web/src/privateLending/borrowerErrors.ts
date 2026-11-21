// The builders' refusals in the borrower's words, for the repay and close modals: no "NFT",
// "offer" or error code. Pure (no React, no app config), so tests import it.
import { PrincipalNotClaimedError } from './loan'

/** Why nothing is paid on a loan whose principal was not received. */
const NOT_RECEIVED =
  'Receive the loan first: the app takes no payment before you have received what the lender ' +
  'sent.'

/** Why a transaction read as the loan's is refused: the indexer's view and the chain disagree. */
const NOT_THE_LOAN = 'This payment does not belong to your loan. Refresh the page and try again.'

/** The wasm's `loan-mismatch`, bare or after the step `wasmStep` names. */
const LOAN_MISMATCH = /(^|: )loan-mismatch: /

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

/** `error` and the causes it wraps, outermost first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  for (let at = error; at !== undefined && !chain.includes(at); ) {
    chain.push(at)
    at = at instanceof Error ? at.cause : undefined
  }
  return chain
}

/** The borrower's sentence for `error`, if it is one of the refusals worded here. */
function mapped(error: unknown): string | undefined {
  const chain = causeChain(error)
  if (chain.some(at => at instanceof PrincipalNotClaimedError)) return NOT_RECEIVED
  if (chain.some(at => LOAN_MISMATCH.test(messageOf(at)))) return NOT_THE_LOAN
  return undefined
}

/**
 * The text a borrower's modal shows for `error`: a `PrincipalNotClaimedError` or a wasm
 * `loan-mismatch` (also wrapped, as `wasmStep` throws it) as a plain sentence; any other error as
 * its message.
 */
export function borrowerErrorText(error: unknown): string {
  return mapped(error) ?? messageOf(error)
}

/**
 * `error` for display: an `Error` with `borrowerErrorText` as its message (and `error` as its
 * cause) when that words it, or else `error` itself, so the app's other wordings still apply.
 */
export function asBorrowerError(error: unknown): unknown {
  const text = mapped(error)
  return text === undefined ? error : new Error(text, { cause: error })
}
