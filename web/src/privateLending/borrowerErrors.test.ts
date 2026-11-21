import { describe, expect, it } from 'vitest'

import { asBorrowerError, borrowerErrorText } from './borrowerErrors'
import { PrincipalNotClaimedError } from './loan'

const NFT = `${'ab'.repeat(32)}:0`
/** A `loan-mismatch` from the wasm, as `wasmStep` wraps it. */
const MISMATCH = new Error(
  'Reading the loan: loan-mismatch: installment 1 does not spend the loan output',
  { cause: 'loan-mismatch: installment 1 does not spend the loan output' },
)

/** Whether `text` names the borrower NFT, the offer, or starts with a `code:` prefix. */
function hasJargon(text: string): boolean {
  return /NFT|offer/i.test(text) || /^[a-z]+(-[a-z]+)*:/.test(text)
}

describe('borrowerErrorText', () => {
  it('asks for the loan to be received first when the principal is not claimed', () => {
    for (const action of ['installment', 'repayment', 'zero-debt close']) {
      const text = borrowerErrorText(new PrincipalNotClaimedError(NFT, action))
      expect(text).toMatch(/^Receive the loan first: /)
      expect(hasJargon(text)).toBe(false)
    }
  })

  it('says a payment that is not the loan’s does not belong to it', () => {
    const sentence = 'This payment does not belong to your loan. Refresh the page and try again.'
    expect(borrowerErrorText(MISMATCH)).toBe(sentence)
    // as the wasm throws it, a bare string
    expect(borrowerErrorText('loan-mismatch: the acceptance is not the offer’s')).toBe(sentence)
    // inside an error that wraps it
    expect(borrowerErrorText(new Error('Not built', { cause: MISMATCH }))).toBe(sentence)
    expect(hasJargon(sentence)).toBe(false)
  })

  it('passes other errors through as their message', () => {
    expect(borrowerErrorText(new Error('The amount still owed is unknown'))).toBe(
      'The amount still owed is unknown',
    )
    expect(borrowerErrorText('bad-input: not hex')).toBe('bad-input: not hex')
  })
})

describe('asBorrowerError', () => {
  it('keeps an error it does not map, and words one it maps', () => {
    const other = new Error('Request timed out')
    expect(asBorrowerError(other)).toBe(other)
    const mapped = asBorrowerError(MISMATCH)
    expect(mapped).toBeInstanceOf(Error)
    expect((mapped as Error).message).toBe(borrowerErrorText(MISMATCH))
    expect((mapped as Error).cause).toBe(MISMATCH)
  })
})
