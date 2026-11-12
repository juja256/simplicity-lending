import { SimplicityProgram } from 'lwk_wasm'
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
  return SimplicityProgram.loadWithDebugSymbols(
    sources.asset_auth,
    buildAssetAuthArguments(params),
    true,
  )
}
