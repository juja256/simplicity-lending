import { SimplicityProgram } from 'lwk_wasm'
import { sources } from 'virtual:simplicity-sources'

import type { Bytes32 } from '@/utils/uint'

import { buildScriptAuthArguments } from './arguments'
import { buildScriptAuthWitness, SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY } from './witness'

export { buildScriptAuthArguments, buildScriptAuthWitness, SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY }

export function loadScriptAuthProgram(scriptHash: Bytes32): SimplicityProgram {
  return SimplicityProgram.loadWithDebugSymbols(
    sources.script_auth,
    buildScriptAuthArguments(scriptHash),
    true,
  )
}
