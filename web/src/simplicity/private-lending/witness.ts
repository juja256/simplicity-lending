// The private lending witness and input weights. Free of `virtual:simplicity-sources`, so the
// DOM-free private flow builders and Node can use them; `program.ts` re-exports them.
import { SimplicityType, SimplicityTypedValue, SimplicityWitnessValues } from 'lwk_wasm'

import { isHexStringOfByteLength, normalizeHex } from '@/utils/hex'
import { toUint32 } from '@/utils/uint'

/** The witness of a branch of the private lending covenant, with the data the branch takes. */
export type PrivateLendingWitness =
  | { branch: 'OfferAcceptance' }
  | { branch: 'OfferCancellation' }
  /**
   * The debt the loan's storage holds, `D`: its 33-byte consensus encoding, hex
   * (`InstallmentPlan.debtWitness`). The covenant checks that the loan input's storage is
   * `h(A, D)`.
   */
  | { branch: 'Installment'; debt: string }
  /**
   * The debt hash (32 bytes, hex) the loan's storage holds, `h(A, D)`: the covenant checks that
   * the repayment at output 1 has it. Until the first installment it is the repayment commitment.
   */
  | { branch: 'FullRepayment'; debtHash: string }
  /**
   * The debt, as for the installment, and the key output 1 reveals (32 bytes, hex,
   * `LoanState.zeroDebtKey()`): the covenant checks that `k·G` has the debt's x.
   */
  | { branch: 'ZeroDebtClose'; debt: string; key: string }
  /**
   * The debt hash the loan's storage holds, then the expiry salt (32 bytes, hex,
   * `OpenedOffer.expirySalt()`) and the loan expiration: the covenant checks that their SHA-256 is
   * its `EXPIRY_HASH`.
   */
  | { branch: 'Liquidation'; debtHash: string; salt: string; expiry: number }

export type PrivateLendingBranch = PrivateLendingWitness['branch']

// The installment's and the zero-debt close's debts are `(bool, u256)`: whether the low bit of the
// commitment's prefix is set, and x.
const PATH_TYPE =
  'Either<Either<(), ()>, Either<Either<(bool, u256), Either<u256, ((bool, u256), u256)>>, ' +
  '(u256, u256, u32)>>'

function u256Literal(hex: string, what: string): string {
  if (!isHexStringOfByteLength(hex, 32)) throw new Error(`The ${what} must be 32 bytes of hex`)
  return `0x${normalizeHex(hex)}`
}

/**
 * A debt as the program takes it, `(bool, u256)`: a value commitment's prefix is 08 or 09, and the
 * bool is its low bit, true exactly when `y` is not a square; x is the 32 bytes after it.
 */
function debtLiteral(hex: string): string {
  const debt = isHexStringOfByteLength(hex, 33) ? normalizeHex(hex) : ''
  const prefix = debt.slice(0, 2)
  if (prefix !== '08' && prefix !== '09') {
    throw new Error('The debt must be a value commitment: 33 bytes of hex, prefix 08 or 09')
  }
  return `(${prefix === '09'}, 0x${debt.slice(2)})`
}

/** The witness's `PATH` value, in the expression syntax of the program's types. */
export function privateLendingPath(witness: PrivateLendingWitness): string {
  switch (witness.branch) {
    case 'OfferAcceptance':
      return 'Left(Left(()))'
    case 'OfferCancellation':
      return 'Left(Right(()))'
    case 'Installment':
      return `Right(Left(Left(${debtLiteral(witness.debt)})))`
    case 'FullRepayment':
      return `Right(Left(Right(Left(${u256Literal(witness.debtHash, 'debt hash')}))))`
    case 'ZeroDebtClose': {
      const debt = debtLiteral(witness.debt)
      const key = u256Literal(witness.key, 'zero-debt key')
      return `Right(Left(Right(Right((${debt}, ${key})))))`
    }
    case 'Liquidation': {
      const debtHash = u256Literal(witness.debtHash, 'debt hash')
      const salt = u256Literal(witness.salt, 'expiry salt')
      const expiry = toUint32(witness.expiry, 'expiry')
      return `Right(Right((${debtHash}, ${salt}, ${expiry})))`
    }
  }
}

/** Whether the branch spends the active offer (true) or the pending one (false). */
export const PRIVATE_LENDING_BRANCH_SPENDS_ACTIVE: Record<PrivateLendingBranch, boolean> = {
  OfferAcceptance: false,
  OfferCancellation: false,
  Installment: true,
  FullRepayment: true,
  ZeroDebtClose: true,
  Liquidation: true,
}

// `PsetInputSpec.maxWeightToSatisfy` for the private lending covenant input, per branch: the
// serialized script witness (witness data + program + CMR + control block, with length prefixes)
// of a real broadcast transaction of this program, plus 10 %, rounded up. Each is a testnet
// transaction of the private lending e2e or of the scripted demo, except the zero-debt close,
// which no testnet run has made.
export const PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY: Record<PrivateLendingBranch, number> = {
  // testnet acceptance 59289a8a…c607: 2 998 (1 + 2 861 + 32 + 97 bytes)
  OfferAcceptance: 3298,
  // testnet cancellation 93e7cc4c…6634: 2 881 (1 + 2 744 + 32 + 97 bytes)
  OfferCancellation: 3170,
  // testnet installment 6254ad10…104c: 4 095 (33 + 3 926 + 32 + 97 bytes). The pruned program
  // varies with the branches its square-ness tests take: this is the largest of five testnet
  // installments, which weighed 4 026 to 4 095
  Installment: 4505,
  // testnet repayment 9b7e98ee…7e2c: 2 971 (33 + 2 802 + 32 + 97 bytes)
  FullRepayment: 3269,
  // regtest, from the contract tests' zero-debt close (`simplicity_spend` prints it): 3 362
  // (65 + 3 161 + 32 + 97 bytes)
  ZeroDebtClose: 3699,
  // testnet liquidation af4c39b7…e8d1: 2 816 (69 + 2 611 + 32 + 97 bytes)
  Liquidation: 3098,
}

export function buildPrivateLendingWitness(
  witness: PrivateLendingWitness,
): SimplicityWitnessValues {
  return new SimplicityWitnessValues().addValue(
    'PATH',
    SimplicityTypedValue.parse(privateLendingPath(witness), SimplicityType.fromString(PATH_TYPE)),
  )
}
