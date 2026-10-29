import { SimplicityArguments, SimplicityTypedValue } from '@lilbonekit/lwk-web'

import { bytes32ToHex } from '@/utils/hex'
import type { Bytes32, Uint64 } from '@/utils/uint'

const ARGUMENTS = {
  ASSET_ID: 'ASSET_ID',
  ASSET_AMOUNT: 'ASSET_AMOUNT',
  WITH_ASSET_BURN: 'WITH_ASSET_BURN',
} as const

export interface AssetAuthProgramParams {
  assetId: Bytes32
  assetAmount: Uint64
  withAssetBurn: boolean
}

export function buildAssetAuthArguments(params: AssetAuthProgramParams): SimplicityArguments {
  return new SimplicityArguments()
    .addValue(ARGUMENTS.ASSET_ID, SimplicityTypedValue.fromU256Hex(bytes32ToHex(params.assetId)))
    .addValue(ARGUMENTS.ASSET_AMOUNT, SimplicityTypedValue.fromU64(params.assetAmount))
    .addValue(ARGUMENTS.WITH_ASSET_BURN, SimplicityTypedValue.fromBoolean(params.withAssetBurn))
}
