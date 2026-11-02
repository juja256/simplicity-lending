import type { Network } from '@lilbonekit/lwk-web'
import { sources } from 'virtual:simplicity-sources'

import {
  type PrivateOfferArguments,
  type PrivateOfferScripts,
  privateOfferScripts,
} from './scripts'
import {
  buildPrivateLendingWitness,
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY,
  type PrivateLendingBranch,
} from './witness'

export {
  buildPrivateLendingWitness,
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY,
  type PrivateLendingBranch,
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
