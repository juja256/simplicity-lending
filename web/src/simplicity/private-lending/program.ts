import {
  type Network,
  SimplicityType,
  SimplicityTypedValue,
  SimplicityWitnessValues,
} from '@lilbonekit/lwk-web'
import { sources } from 'virtual:simplicity-sources'

import {
  type PrivateOfferArguments,
  type PrivateOfferScripts,
  privateOfferScripts,
} from './scripts'

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

export function loadPrivateOfferScripts(
  args: PrivateOfferArguments,
  network: Network,
): PrivateOfferScripts {
  return privateOfferScripts(
    {
      privateLending: sources.private_lending,
      assetAuth: sources.asset_auth,
      scriptAuth: sources.script_auth,
    },
    args,
    network,
  )
}

export function buildPrivateLendingWitness(branch: PrivateLendingBranch): SimplicityWitnessValues {
  return new SimplicityWitnessValues().addValue(
    'PATH',
    SimplicityTypedValue.parse(PATH_EXPRESSIONS[branch], SimplicityType.fromString(PATH_TYPE)),
  )
}
