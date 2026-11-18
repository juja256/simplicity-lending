// The private lending witness and input weights. Free of `virtual:simplicity-sources`, so the
// DOM-free private flow builders and Node can use them; `program.ts` re-exports them.
import { SimplicityType, SimplicityTypedValue, SimplicityWitnessValues } from 'lwk_wasm'

import { isHexStringOfByteLength, normalizeHex } from '@/utils/hex'
import { toUint32 } from '@/utils/uint'

/** The witness of a branch of the private lending covenant, with the data the branch takes. */
export type PrivateLendingWitness =
  | { branch: 'OfferAcceptance' }
  | { branch: 'OfferCancellation' }
  | { branch: 'FullRepayment' }
  /**
   * The expiry salt (32 bytes, hex, `OpenedOffer.expirySalt()`) and the loan expiration: the
   * covenant checks that their SHA-256 is its `EXPIRY_HASH`.
   */
  | { branch: 'Liquidation'; salt: string; expiry: number }

export type PrivateLendingBranch = PrivateLendingWitness['branch']

const PATH_TYPE = 'Either<Either<(), ()>, Either<Either<(), ()>, (u256, u32)>>'

function pathExpression(witness: PrivateLendingWitness): string {
  switch (witness.branch) {
    case 'OfferAcceptance':
      return 'Left(Left(()))'
    case 'OfferCancellation':
      return 'Left(Right(()))'
    case 'FullRepayment':
      return 'Right(Left(Right(())))'
    case 'Liquidation': {
      if (!isHexStringOfByteLength(witness.salt, 32)) {
        throw new Error('The expiry salt must be 32 bytes of hex')
      }
      const expiry = toUint32(witness.expiry, 'expiry')
      return `Right(Right((0x${normalizeHex(witness.salt)}, ${expiry})))`
    }
  }
}

/** Whether the branch spends the active offer (true) or the pending one (false). */
export const PRIVATE_LENDING_BRANCH_SPENDS_ACTIVE: Record<PrivateLendingBranch, boolean> = {
  OfferAcceptance: false,
  OfferCancellation: false,
  FullRepayment: true,
  Liquidation: true,
}

// `PsetInputSpec.maxWeightToSatisfy` for the private lending covenant input, per branch: the
// serialized script witness (witness data + program + CMR + control block) of a real broadcast
// transaction, plus 10 %, rounded up.
export const PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY: Record<PrivateLendingBranch, number> = {
  // testnet acceptance baf52dd7…b55b2: 2 998 (1 + 2 861 + 32 + 97 bytes, with length prefixes)
  OfferAcceptance: 3298,
  // testnet cancellation da907491…1d79: 2 881 (1 + 2 744 + 32 + 97 bytes, with length prefixes)
  OfferCancellation: 3170,
  // testnet repayment 1d30ea1c…11aa: 3 028 (1 + 2 891 + 32 + 97 bytes, with length prefixes)
  FullRepayment: 3331,
  // a liquidation of the parity fixture's offer, with the expiry salt and the expiry in its
  // witness, finalized offline: 3 213 (37 + 3 040 + 32 + 97 bytes, with length prefixes)
  Liquidation: 3535,
}

export function buildPrivateLendingWitness(
  witness: PrivateLendingWitness,
): SimplicityWitnessValues {
  return new SimplicityWitnessValues().addValue(
    'PATH',
    SimplicityTypedValue.parse(pathExpression(witness), SimplicityType.fromString(PATH_TYPE)),
  )
}
