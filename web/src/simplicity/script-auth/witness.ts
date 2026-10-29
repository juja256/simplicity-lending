// Free of `virtual:simplicity-sources`, so the DOM-free private flow builders and Node can use it.
import { SimplicityTypedValue, SimplicityWitnessValues } from '@lilbonekit/lwk-web'

import type { Uint32 } from '@/utils/uint'

const WITNESS = {
  INPUT_SCRIPT_INDEX: 'INPUT_SCRIPT_INDEX',
} as const

// ExternalUtxo max-weight-to-satisfy for the ScriptAuth covenant input. Measured from real
// broadcast txs (program + CMR + control block + witness data = 331 bytes), plus margin.
export const SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY = 400

export function buildScriptAuthWitness(inputScriptIndex: Uint32): SimplicityWitnessValues {
  return new SimplicityWitnessValues().addValue(
    WITNESS.INPUT_SCRIPT_INDEX,
    SimplicityTypedValue.fromU32(inputScriptIndex),
  )
}
