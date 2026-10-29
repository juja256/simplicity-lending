import {
  SimplicityProgram,
  SimplicityTypedValue,
  SimplicityWitnessValues,
} from '@lilbonekit/lwk-web'
import { sources } from 'virtual:simplicity-sources'

import type { Uint32 } from '@/utils/uint'

import { type AssetAuthProgramParams, buildAssetAuthArguments } from './arguments'

export { type AssetAuthProgramParams, buildAssetAuthArguments }

const WITNESS = {
  INPUT_ASSET_INDEX: 'INPUT_ASSET_INDEX',
  OUTPUT_ASSET_INDEX: 'OUTPUT_ASSET_INDEX',
} as const

// ExternalUtxo max-weight-to-satisfy for the AssetAuth covenant input. Measured from a real
// broadcast tx (program + CMR + control block + witness data = 706 bytes), plus margin.
export const ASSET_AUTH_MAX_WEIGHT_TO_SATISFY = 800

export interface AssetAuthWitnessParams {
  inputAssetIndex: Uint32
  outputAssetIndex: Uint32
}

export function loadAssetAuthProgram(params: AssetAuthProgramParams): SimplicityProgram {
  return SimplicityProgram.load(sources.asset_auth, buildAssetAuthArguments(params))
}

export function buildAssetAuthWitness(params: AssetAuthWitnessParams): SimplicityWitnessValues {
  return new SimplicityWitnessValues()
    .addValue(WITNESS.INPUT_ASSET_INDEX, SimplicityTypedValue.fromU32(params.inputAssetIndex))
    .addValue(WITNESS.OUTPUT_ASSET_INDEX, SimplicityTypedValue.fromU32(params.outputAssetIndex))
}
