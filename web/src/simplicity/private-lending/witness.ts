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
// transaction, plus 10 %. Branches not measured yet keep the 4 000 placeholder.
export const PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY: Record<PrivateLendingBranch, number> = {
  // testnet acceptance baf52dd7…b55b2: 2 998 (1 + 2 861 + 32 + 97 bytes, with length prefixes)
  OfferAcceptance: 3298,
  OfferCancellation: 4000,
  FullRepayment: 4000,
  Liquidation: 4000,
}

export function buildPrivateLendingWitness(branch: PrivateLendingBranch): SimplicityWitnessValues {
  return new SimplicityWitnessValues().addValue(
    'PATH',
    SimplicityTypedValue.parse(PATH_EXPRESSIONS[branch], SimplicityType.fromString(PATH_TYPE)),
  )
}
