// Free of `virtual:simplicity-sources`, so the DOM-free private flow builders and Node can use it.
import { SimplicityTypedValue, SimplicityWitnessValues } from '@lilbonekit/lwk-web'

import type { Uint32 } from '@/utils/uint'

const WITNESS = {
  INPUT_ASSET_INDEX: 'INPUT_ASSET_INDEX',
  OUTPUT_ASSET_INDEX: 'OUTPUT_ASSET_INDEX',
} as const

// ExternalUtxo max-weight-to-satisfy for the AssetAuth covenant input. Measured from a real
// broadcast tx (program + CMR + control block + witness data = 706 bytes), plus margin.
export const ASSET_AUTH_MAX_WEIGHT_TO_SATISFY = 800

// The same with WITH_ASSET_BURN, whose program also checks the OP_RETURN, plus 10 %: measured on
// the testnet private repayment claim 9fdf6079…7c7f, 812 (8 + 732 + 32 + 33 bytes, with length
// prefixes).
export const ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY = 894

export interface AssetAuthWitnessParams {
  inputAssetIndex: Uint32
  outputAssetIndex: Uint32
}

export function buildAssetAuthWitness(params: AssetAuthWitnessParams): SimplicityWitnessValues {
  return new SimplicityWitnessValues()
    .addValue(WITNESS.INPUT_ASSET_INDEX, SimplicityTypedValue.fromU32(params.inputAssetIndex))
    .addValue(WITNESS.OUTPUT_ASSET_INDEX, SimplicityTypedValue.fromU32(params.outputAssetIndex))
}
