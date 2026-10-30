// The private lending witness and input weights. Free of `virtual:simplicity-sources`, so the
// DOM-free private flow builders and Node can use them; `program.ts` re-exports them.
import { SimplicityType, SimplicityTypedValue, SimplicityWitnessValues } from '@lilbonekit/lwk-web'

export type PrivateLendingBranch =
  | 'OfferAcceptance'
  | 'OfferCancellation'
  | 'FullRepayment'
  | 'Liquidation'

const PATH_TYPE = 'Either<Either<(), ()>, Either<Either<(), ()>, ()>>'

const PATH_EXPRESSIONS: Record<PrivateLendingBranch, string> = {
  OfferAcceptance: 'Left(Left(()))',
  OfferCancellation: 'Left(Right(()))',
  FullRepayment: 'Right(Left(Right(())))',
  Liquidation: 'Right(Right(()))',
}

/** Whether the branch spends the active offer (true) or the pending one (false). */
export const PRIVATE_LENDING_BRANCH_SPENDS_ACTIVE: Record<PrivateLendingBranch, boolean> = {
  OfferAcceptance: false,
  OfferCancellation: false,
  FullRepayment: true,
  Liquidation: true,
}

// ExternalUtxo max-weight-to-satisfy for the private lending covenant input, per branch: the
// serialized script witness (witness data + program + CMR + control block) of a real broadcast
// transaction, plus 10 %, rounded up.
export const PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY: Record<PrivateLendingBranch, number> = {
  // testnet acceptance baf52dd7…b55b2: 2 998 (1 + 2 861 + 32 + 97 bytes, with length prefixes)
  OfferAcceptance: 3298,
  // testnet cancellation da907491…1d79: 2 881 (1 + 2 744 + 32 + 97 bytes, with length prefixes)
  OfferCancellation: 3170,
  // testnet repayment 1d30ea1c…11aa: 3 028 (1 + 2 891 + 32 + 97 bytes, with length prefixes)
  FullRepayment: 3331,
  // testnet liquidation 56af64c2…70e6: 2 853 (1 + 2 716 + 32 + 97 bytes, with length prefixes)
  Liquidation: 3139,
}

export function buildPrivateLendingWitness(branch: PrivateLendingBranch): SimplicityWitnessValues {
  return new SimplicityWitnessValues().addValue(
    'PATH',
    SimplicityTypedValue.parse(PATH_EXPRESSIONS[branch], SimplicityType.fromString(PATH_TYPE)),
  )
}
