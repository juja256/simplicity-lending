import { SimplicityArguments, SimplicityTypedValue } from '@lilbonekit/lwk-web'

import { bytes32ToHex } from '@/utils/hex'
import type { Bytes32 } from '@/utils/uint'

const ARGUMENTS = {
  SCRIPT_HASH: 'SCRIPT_HASH',
} as const

export function buildScriptAuthArguments(scriptHash: Bytes32): SimplicityArguments {
  return new SimplicityArguments().addValue(
    ARGUMENTS.SCRIPT_HASH,
    SimplicityTypedValue.fromU256Hex(bytes32ToHex(scriptHash)),
  )
}
