// Checks how the build configuration picks the asset pair. Run it with `pnpm check:config`.
// With no pair setting, each network keeps the assets it had before the pair became configurable.
// The settings replace an asset three at a time (id, decimals and symbol), the two assets must
// differ, and a missing or malformed setting throws with its name, so the app never starts with a
// wrong id or `NaN` decimals. An empty or blank setting counts as unset, as a Docker build passes
// an unset build arg.
import assert from 'node:assert/strict'

import {
  type NetworkConfig,
  PAIR_SETTINGS,
  type PairEnv,
  type PairSetting,
  resolveNetworkConfig,
} from '@/constants/resolve-network-config'

const TESTNET: NetworkConfig = {
  collateralAsset: {
    id: '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49',
    decimals: 8,
    symbol: 'tL-BTC',
  },
  principalAsset: {
    id: '38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5',
    decimals: 3,
    symbol: 'TEST',
  },
  policyAssetSatsUnit: 'tLsats',
}

const LIQUID: NetworkConfig = {
  collateralAsset: {
    id: '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d',
    decimals: 8,
    symbol: 'LBTC',
  },
  principalAsset: {
    id: 'ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2',
    decimals: 8,
    symbol: 'USDT',
  },
  policyAssetSatsUnit: 'Lsats',
}

const REGTEST: NetworkConfig = {
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
}

const OTHER_ID = 'ab'.repeat(32)

let checks = 0
function check(name: string, run: () => void): void {
  try {
    run()
    checks += 1
  } catch (error) {
    console.error(`network config: ${name} failed`)
    throw error
  }
}

check('defaults', () => {
  assert.deepEqual(resolveNetworkConfig('liquidtestnet', {}), TESTNET)
  assert.deepEqual(resolveNetworkConfig('liquid', {}), LIQUID)
  assert.deepEqual(resolveNetworkConfig('regtest', {}), REGTEST)
  // A setting present but undefined is unset, as `import.meta.env` reports it.
  assert.deepEqual(
    resolveNetworkConfig('liquidtestnet', {
      VITE_COLLATERAL_ASSET_ID: undefined,
      VITE_PRINCIPAL_ASSET_DECIMALS: undefined,
    }),
    TESTNET,
  )
})

check('empty and blank settings are unset', () => {
  const blank = Object.fromEntries(PAIR_SETTINGS.map(setting => [setting, ''])) as PairEnv
  assert.deepEqual(resolveNetworkConfig('liquidtestnet', blank), TESTNET)
  assert.deepEqual(
    resolveNetworkConfig('liquid', {
      VITE_COLLATERAL_ASSET_ID: ' ',
      VITE_COLLATERAL_ASSET_DECIMALS: '\t',
      VITE_PRINCIPAL_ASSET_SYMBOL: '',
    }),
    LIQUID,
  )
})

// A full replacement of each asset: its id, decimals and symbol together.
const COLLATERAL_ENV: PairEnv = {
  VITE_COLLATERAL_ASSET_ID: OTHER_ID,
  VITE_COLLATERAL_ASSET_DECIMALS: '0',
  VITE_COLLATERAL_ASSET_SYMBOL: 'L-BTC',
}
const PRINCIPAL_ENV: PairEnv = {
  VITE_PRINCIPAL_ASSET_ID: 'cd'.repeat(32),
  VITE_PRINCIPAL_ASSET_DECIMALS: '18',
  VITE_PRINCIPAL_ASSET_SYMBOL: 'USDt',
}

check('the collateral asset replaced, the principal kept', () => {
  assert.deepEqual(resolveNetworkConfig('liquidtestnet', COLLATERAL_ENV), {
    ...TESTNET,
    collateralAsset: { id: OTHER_ID, decimals: 0, symbol: 'L-BTC' },
  })
})

check('the principal asset replaced, the collateral kept', () => {
  assert.deepEqual(resolveNetworkConfig('liquidtestnet', PRINCIPAL_ENV), {
    ...TESTNET,
    principalAsset: { id: 'cd'.repeat(32), decimals: 18, symbol: 'USDt' },
  })
})

check('both assets replaced, on another network', () => {
  assert.deepEqual(resolveNetworkConfig('regtest', { ...COLLATERAL_ENV, ...PRINCIPAL_ENV }), {
    collateralAsset: { id: OTHER_ID, decimals: 0, symbol: 'L-BTC' },
    principalAsset: { id: 'cd'.repeat(32), decimals: 18, symbol: 'USDt' },
    policyAssetSatsUnit: 'Lsats',
  })
})

check('ids are lowercased and values trimmed', () => {
  const config = resolveNetworkConfig('liquidtestnet', {
    VITE_PRINCIPAL_ASSET_ID: ` ${'AB'.repeat(32)} `,
    VITE_PRINCIPAL_ASSET_DECIMALS: ' 6 ',
    VITE_PRINCIPAL_ASSET_SYMBOL: ' USDt ',
  })
  assert.deepEqual(config.principalAsset, { id: OTHER_ID, decimals: 6, symbol: 'USDt' })
})

function throwsNaming(env: PairEnv, prefix: string): void {
  assert.throws(
    () => resolveNetworkConfig('liquidtestnet', env),
    (error: unknown) => error instanceof Error && error.message.startsWith(prefix),
  )
}

// An asset's settings go together: with one of the three left out, or left empty or blank, the
// error names it.
for (const full of [COLLATERAL_ENV, PRINCIPAL_ENV]) {
  for (const missing of Object.keys(full) as PairSetting[]) {
    for (const value of [undefined, '', '  ']) {
      check(`${missing}=${JSON.stringify(value)} while the other two are set`, () => {
        const env = { ...full, [missing]: value }
        throwsNaming(env, `Invalid build setting ${missing}: unset while `)
      })
    }
  }
}

check('one non-empty setting needs the other two, even when they are empty', () => {
  throwsNaming(
    { VITE_PRINCIPAL_ASSET_ID: '', VITE_PRINCIPAL_ASSET_SYMBOL: 'USDt' },
    'Invalid build setting VITE_PRINCIPAL_ASSET_ID: unset while VITE_PRINCIPAL_ASSET_SYMBOL is set',
  )
})

// The two assets must differ, whether one or both are replaced, whatever the case of the ids.
const SAME_IDS = 'Invalid build settings VITE_COLLATERAL_ASSET_ID and VITE_PRINCIPAL_ASSET_ID:'
check('a principal equal to the default collateral is refused', () => {
  throwsNaming({ ...PRINCIPAL_ENV, VITE_PRINCIPAL_ASSET_ID: TESTNET.collateralAsset.id }, SAME_IDS)
})
check('the same id for both assets is refused', () => {
  throwsNaming(
    { ...COLLATERAL_ENV, ...PRINCIPAL_ENV, VITE_PRINCIPAL_ASSET_ID: OTHER_ID.toUpperCase() },
    SAME_IDS,
  )
})

// Each malformed value, in an otherwise valid asset, throws with the setting's name.
const malformed: { setting: PairSetting; values: string[] }[] = [
  {
    setting: 'VITE_COLLATERAL_ASSET_ID',
    values: ['abc', 'ab'.repeat(31), 'ab'.repeat(33), 'g'.repeat(64), `0x${'ab'.repeat(31)}`],
  },
  {
    setting: 'VITE_COLLATERAL_ASSET_DECIMALS',
    values: ['-1', '19', '1.5', '8.0', 'eight', '1e1', '0x8', 'NaN', 'Infinity', '8 8'],
  },
  { setting: 'VITE_PRINCIPAL_ASSET_ID', values: ['xyz', 'ab'.repeat(33)] },
  { setting: 'VITE_PRINCIPAL_ASSET_DECIMALS', values: ['-0', '100', '3.', 'three'] },
]

for (const { setting, values } of malformed) {
  const full = setting.startsWith('VITE_COLLATERAL_') ? COLLATERAL_ENV : PRINCIPAL_ENV
  for (const value of values) {
    check(`malformed ${setting}=${JSON.stringify(value)}`, () => {
      throwsNaming({ ...full, [setting]: value }, `Invalid build setting ${setting}=`)
    })
  }
}

process.stdout.write(`network config: ok (${checks} checks)\n`)
