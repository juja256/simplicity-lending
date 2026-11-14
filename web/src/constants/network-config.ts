import type { ComponentType, SVGProps } from 'react'

import CoinsIcon from '@/components/icons/CoinsIcon'
import LbtcIcon from '@/components/icons/LbtcIcon'
import TestAssetIcon from '@/components/icons/TestAssetIcon'
import TestnetLbtcIcon from '@/components/icons/TestnetLbtcIcon'
import UsdtIcon from '@/components/icons/UsdtIcon'
import { env } from '@/constants/env'
import { type PairAsset, resolveNetworkConfig } from '@/constants/resolve-network-config'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

export interface ConfigAsset extends PairAsset {
  icon: IconComponent
}

// The icon follows the symbol; a symbol the app has no icon for gets a generic one.
const ICON_BY_SYMBOL = new Map<string, IconComponent>([
  ['LBTC', LbtcIcon],
  ['tL-BTC', TestnetLbtcIcon],
  ['USDT', UsdtIcon],
  ['TEST', TestAssetIcon],
])

function withIcon(asset: PairAsset): ConfigAsset {
  return { ...asset, icon: ICON_BY_SYMBOL.get(asset.symbol) ?? CoinsIcon }
}

// The pair comes from the build settings (see `resolve-network-config.ts`); a malformed setting
// throws here, at startup. Each setting is read by name, as in `env.ts`: passing
// `import.meta.env` whole would put every `VITE_*` variable of the build into the bundle.
const resolved = resolveNetworkConfig(env.VITE_NETWORK, {
  VITE_COLLATERAL_ASSET_ID: import.meta.env.VITE_COLLATERAL_ASSET_ID,
  VITE_COLLATERAL_ASSET_DECIMALS: import.meta.env.VITE_COLLATERAL_ASSET_DECIMALS,
  VITE_COLLATERAL_ASSET_SYMBOL: import.meta.env.VITE_COLLATERAL_ASSET_SYMBOL,
  VITE_PRINCIPAL_ASSET_ID: import.meta.env.VITE_PRINCIPAL_ASSET_ID,
  VITE_PRINCIPAL_ASSET_DECIMALS: import.meta.env.VITE_PRINCIPAL_ASSET_DECIMALS,
  VITE_PRINCIPAL_ASSET_SYMBOL: import.meta.env.VITE_PRINCIPAL_ASSET_SYMBOL,
})

export const NETWORK_CONFIG = {
  collateralAsset: withIcon(resolved.collateralAsset),
  principalAsset: withIcon(resolved.principalAsset),
  policyAssetSatsUnit: resolved.policyAssetSatsUnit,
}
