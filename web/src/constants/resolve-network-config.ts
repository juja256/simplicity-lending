// The asset pair the app lends in, read from the build configuration. Covenants are
// asset-agnostic: this is the one place that says which asset is the collateral and which the
// principal. Each network has a default pair, and each of the six `VITE_*_ASSET_*` settings
// overrides one field of it.
//
// This module is pure (no `import.meta.env`, no React) so Node scripts can import it;
// `network-config.ts` calls it with `import.meta.env` and adds the icons.

export type NetworkName = 'liquid' | 'liquidtestnet' | 'regtest'

export interface PairAsset {
  /** Asset id, 64 lowercase hex characters. */
  id: string
  decimals: number
  symbol: string
}

export interface NetworkConfig {
  collateralAsset: PairAsset
  principalAsset: PairAsset
  /** Display unit for the policy asset's base unit (sats). */
  policyAssetSatsUnit: string
}

export const PAIR_SETTINGS = [
  'VITE_COLLATERAL_ASSET_ID',
  'VITE_COLLATERAL_ASSET_DECIMALS',
  'VITE_COLLATERAL_ASSET_SYMBOL',
  'VITE_PRINCIPAL_ASSET_ID',
  'VITE_PRINCIPAL_ASSET_DECIMALS',
  'VITE_PRINCIPAL_ASSET_SYMBOL',
] as const

export type PairSetting = (typeof PAIR_SETTINGS)[number]

/** The pair settings as the build sees them; an undefined one is unset. */
export type PairEnv = { readonly [Setting in PairSetting]?: string }

const MAX_DECIMALS = 18

const DEFAULTS: Record<NetworkName, NetworkConfig> = {
  liquid: {
    collateralAsset: {
      id: '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d',
      decimals: 8,
      symbol: 'LBTC',
    },
    // USDT on Liquid mainnet has 8 decimals.
    principalAsset: {
      id: 'ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2',
      decimals: 8,
      symbol: 'USDT',
    },
    policyAssetSatsUnit: 'Lsats',
  },
  liquidtestnet: {
    collateralAsset: {
      id: '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49',
      decimals: 8,
      symbol: 'tL-BTC',
    },
    // liquidtestnet.com's "Testnet Asset" (ticker TEST) stands in for USDT as the principal. It
    // keeps its own label and icon so it is not mistaken for real USDT.
    principalAsset: {
      id: '38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5',
      decimals: 3,
      symbol: 'TEST',
    },
    policyAssetSatsUnit: 'tLsats',
  },
  regtest: {
    collateralAsset: {
      id: '5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225',
      decimals: 8,
      symbol: 'LBTC',
    },
    principalAsset: {
      id: '25b17682b0e4f7b0711de7e8ee2e33cd01d65680eed82cce1af84cfbdde30064',
      decimals: 2,
      symbol: 'USDT',
    },
    policyAssetSatsUnit: 'Lsats',
  },
}

/**
 * The network's config with the pair settings in `env` applied. An unset setting keeps the
 * network's default; a malformed one throws an error that names it, so a bad build fails at
 * startup instead of running with a wrong id or `NaN` decimals.
 */
export function resolveNetworkConfig(network: NetworkName, env: PairEnv): NetworkConfig {
  const defaults = DEFAULTS[network]
  if (!defaults) throw new Error(`Unknown network ${JSON.stringify(network)}.`)
  return {
    collateralAsset: resolveAsset(defaults.collateralAsset, 'COLLATERAL', env),
    principalAsset: resolveAsset(defaults.principalAsset, 'PRINCIPAL', env),
    policyAssetSatsUnit: defaults.policyAssetSatsUnit,
  }
}

function resolveAsset(
  defaults: PairAsset,
  role: 'COLLATERAL' | 'PRINCIPAL',
  env: PairEnv,
): PairAsset {
  const id = env[`VITE_${role}_ASSET_ID`]
  const decimals = env[`VITE_${role}_ASSET_DECIMALS`]
  const symbol = env[`VITE_${role}_ASSET_SYMBOL`]
  return {
    id: id === undefined ? defaults.id : parseAssetId(`VITE_${role}_ASSET_ID`, id),
    decimals:
      decimals === undefined
        ? defaults.decimals
        : parseDecimals(`VITE_${role}_ASSET_DECIMALS`, decimals),
    symbol:
      symbol === undefined ? defaults.symbol : parseSymbol(`VITE_${role}_ASSET_SYMBOL`, symbol),
  }
}

function parseAssetId(setting: PairSetting, raw: string): string {
  const value = raw.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw invalid(setting, raw, 'must be an asset id of 64 hex characters')
  }
  return value.toLowerCase()
}

function parseDecimals(setting: PairSetting, raw: string): number {
  const value = raw.trim()
  // Digits only, so `1.5`, `-1`, `1e1`, `0x8` and the empty string are all refused.
  const decimals = /^\d{1,2}$/.test(value) ? Number(value) : NaN
  if (!Number.isInteger(decimals) || decimals > MAX_DECIMALS) {
    throw invalid(setting, raw, `must be an integer from 0 to ${MAX_DECIMALS}`)
  }
  return decimals
}

function parseSymbol(setting: PairSetting, raw: string): string {
  const value = raw.trim()
  if (!value) throw invalid(setting, raw, 'must not be empty')
  return value
}

function invalid(setting: PairSetting, raw: string, rule: string): Error {
  return new Error(`Invalid build setting ${setting}=${JSON.stringify(raw)}: ${rule}.`)
}
