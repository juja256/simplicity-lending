// Loads `.env.liquidtestnet` and `.env.e2e.local` without dotenv. The seed phrases are read
// here and nowhere printed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  type NetworkConfig,
  PAIR_SETTINGS,
  type PairEnv,
  resolveNetworkConfig,
} from '@/constants/resolve-network-config'

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value[value.length - 1] === value[0]
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const fileSettings = {
  ...parseEnvFile(path.join(webRoot, '.env.liquidtestnet')),
  ...parseEnvFile(path.join(webRoot, '.env.e2e.local')),
}

/** A setting of the process environment, else of `.env.e2e.local`, else of `.env.liquidtestnet`. */
function readSetting(name: string): string | undefined {
  return process.env[name] ?? fileSettings[name]
}

/** Liquid testnet's policy asset, tL-BTC, which pays every fee. */
const TESTNET_POLICY_ASSET = '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49'

/**
 * The testnet asset pair as the app's build resolves it (`resolveNetworkConfig`): the network's
 * defaults, tL-BTC and TEST, unless the pair settings replace them.
 */
export const TESTNET_PAIR: NetworkConfig = resolveNetworkConfig(
  'liquidtestnet',
  Object.fromEntries(PAIR_SETTINGS.map(name => [name, readSetting(name)])) as PairEnv,
)

// The e2e takes the collateral and the fees from the same tL-BTC coins (`STAGE_NEEDS`).
if (TESTNET_PAIR.collateralAsset.id !== TESTNET_POLICY_ASSET) {
  throw new Error(
    `the e2e needs tL-BTC (${TESTNET_POLICY_ASSET}) as the collateral, not ` +
      `${TESTNET_PAIR.collateralAsset.id} (VITE_COLLATERAL_ASSET_ID)`,
  )
}

export const TESTNET_ASSETS = {
  policy: TESTNET_POLICY_ASSET,
  collateral: TESTNET_PAIR.collateralAsset.id,
  principal: TESTNET_PAIR.principalAsset.id,
} as const

export interface E2eEnv {
  waterfallsUrl: string
  /** A pinned waterfalls key; unset, the server's own is fetched. */
  waterfallsRecipient: string | undefined
  esploraApi: string
  /** The indexer API (`VITE_API_URL`), which the `scan` stage reads; the app's default if unset. */
  apiUrl: string
  borrowerMnemonic: string
  lenderMnemonic: string
}

export function loadEnv(): E2eEnv {
  const need = (name: string): string => {
    const value = readSetting(name)
    if (!value) throw new Error(`${name} is not set (.env.liquidtestnet / .env.e2e.local)`)
    return value
  }
  const apiUrl = readSetting('VITE_API_URL') ?? 'http://localhost:8000'
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    waterfallsUrl: need('VITE_WATERFALLS_URL'),
    waterfallsRecipient: readSetting('VITE_WATERFALLS_RECIPIENT')?.trim() || undefined,
    esploraApi: `${need('VITE_ESPLORA_BASE_URL').replace(/\/+$/, '')}/api`,
    borrowerMnemonic: need('PRIVATE_E2E_BORROWER_MNEMONIC'),
    lenderMnemonic: need('PRIVATE_E2E_LENDER_MNEMONIC'),
  }
}

// Amounts of the e2e run, in tL-sats (collateral) and TEST units (principal, repayment).
export const COLLATERAL = 20_000n
export const PRINCIPAL = 1_000n
export const REPAYMENT = 1_100n
/** tL-sats reserved per transaction. */
export const FEE_BUDGET = 2_000n

export type Wallet = 'borrower' | 'lender'

/** What a wallet must hold, confirmed: tL-sats and TEST units. */
export interface Need {
  lbtc: bigint
  test: bigint
}

/**
 * The state records of the transactions that spend from the wallets, one per transaction. Most
 * stages broadcast one; `repay-partial` broadcasts two installments (`repay-partial-1`,
 * `repay-partial-2`), `cancel` its own creation (`cancel-create`), then the cancellation, and
 * `liquidate` its creation (`liquidate-create`), the lender's acceptance (`liquidate-accept`), then
 * the liquidation. `scan` and `directory` broadcast nothing (they read
 * the indexer and write the directory, off-chain), so they never have a record.
 */
export type Stage =
  | 'create'
  | 'accept'
  | 'claim-principal'
  | 'repay-partial-1'
  | 'repay-partial-2'
  | 'repay'
  | 'claim-repayment'
  | 'cancel-create'
  | 'cancel'
  | 'liquidate-create'
  | 'liquidate-accept'
  | 'liquidate'
  | 'scan'
  | 'directory'
  | 'short-proposal'

const NONE: Need = { lbtc: 0n, test: 0n }

/**
 * What each record's transaction needs from each wallet when it is built. A creation needs two
 * coins besides the collateral (2 × COLLATERAL, as the coins come) and a fee. The `wallets` stage
 * only moves coins within a wallet and checks its split itself; `scan` and `directory` need
 * nothing.
 */
export const STAGE_NEEDS: Record<Stage, Record<Wallet, Need>> = {
  create: {
    borrower: { lbtc: 2n * COLLATERAL + FEE_BUDGET, test: 0n },
    lender: NONE,
  },
  accept: {
    borrower: NONE,
    lender: { lbtc: FEE_BUDGET, test: PRINCIPAL },
  },
  'claim-principal': {
    borrower: { lbtc: FEE_BUDGET, test: 0n },
    lender: NONE,
  },
  // the installments pay from the claimed principal
  'repay-partial-1': {
    borrower: { lbtc: FEE_BUDGET, test: 0n },
    lender: NONE,
  },
  'repay-partial-2': {
    borrower: { lbtc: FEE_BUDGET, test: 0n },
    lender: NONE,
  },
  repay: {
    // the rest of the principal comes from the claim; the interest from the wallet
    borrower: { lbtc: FEE_BUDGET, test: REPAYMENT - PRINCIPAL },
    lender: NONE,
  },
  'claim-repayment': {
    borrower: NONE,
    lender: { lbtc: FEE_BUDGET, test: 0n },
  },
  'cancel-create': {
    borrower: { lbtc: 2n * COLLATERAL + FEE_BUDGET, test: 0n },
    lender: NONE,
  },
  cancel: {
    // the collateral comes back from the offer
    borrower: { lbtc: FEE_BUDGET, test: 0n },
    lender: NONE,
  },
  'liquidate-create': {
    borrower: { lbtc: 2n * COLLATERAL + FEE_BUDGET, test: 0n },
    lender: NONE,
  },
  'liquidate-accept': {
    borrower: NONE,
    lender: { lbtc: FEE_BUDGET, test: PRINCIPAL },
  },
  liquidate: {
    // the collateral comes from the offer
    borrower: NONE,
    lender: { lbtc: FEE_BUDGET, test: 0n },
  },
  scan: { borrower: NONE, lender: NONE },
  directory: { borrower: NONE, lender: NONE },
  'short-proposal': {
    borrower: { lbtc: 2n * COLLATERAL + FEE_BUDGET, test: 0n },
    lender: NONE,
  },
}

/**
 * The records of the stages that run only when named: `short-proposal`, for the testnet demo
 * (`pnpm demo:testnet`). A run that does not name them does not need their funds.
 */
export const ON_REQUEST_STAGES: readonly Stage[] = ['short-proposal']

/** Whether `stage` needs nothing from either wallet, as `scan` and `directory`. */
export function needsNothing(stage: Stage): boolean {
  const { borrower, lender } = STAGE_NEEDS[stage]
  return borrower.lbtc === 0n && borrower.test === 0n && lender.lbtc === 0n && lender.test === 0n
}

export const STAGE_NAMES = Object.keys(STAGE_NEEDS) as Stage[]

/** The sum of the needs of `stages`, per wallet. */
export function sumNeeds(stages: readonly Stage[]): Record<Wallet, Need> {
  const total: Record<Wallet, Need> = { borrower: { ...NONE }, lender: { ...NONE } }
  for (const stage of stages) {
    for (const wallet of ['borrower', 'lender'] as const) {
      total[wallet].lbtc += STAGE_NEEDS[stage][wallet].lbtc
      total[wallet].test += STAGE_NEEDS[stage][wallet].test
    }
  }
  return total
}

/** What each wallet must hold, confirmed, to run every stage that runs unnamed. */
export const NEEDS = sumNeeds(STAGE_NAMES.filter(stage => !ON_REQUEST_STAGES.includes(stage)))

/** Confirmed tL-BTC coins to split each wallet into, and their size. */
export const SPLITS = {
  borrower: { coins: 6, amount: 15_000n },
  lender: { coins: 3, amount: 5_000n },
} as const
