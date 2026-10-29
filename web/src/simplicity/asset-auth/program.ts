import { SimplicityProgram } from '@lilbonekit/lwk-web'
import { sources } from 'virtual:simplicity-sources'

import { type AssetAuthProgramParams, buildAssetAuthArguments } from './arguments'
import {
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
  type AssetAuthWitnessParams,
  buildAssetAuthWitness,
} from './witness'

export {
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
  type AssetAuthProgramParams,
  type AssetAuthWitnessParams,
  buildAssetAuthArguments,
  buildAssetAuthWitness,
}

export function loadAssetAuthProgram(params: AssetAuthProgramParams): SimplicityProgram {
  return SimplicityProgram.load(sources.asset_auth, buildAssetAuthArguments(params))
}
