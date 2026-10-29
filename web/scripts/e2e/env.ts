// Loads `.env.liquidtestnet` and `.env.e2e.local` without dotenv. The seed phrases are read
// here and nowhere printed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// tL-BTC and TEST on Liquid testnet (src/constants/network-config.ts, which pulls in React).
export const TESTNET_ASSETS = {
  policy: '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49',
  collateral: '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49',
  principal: '38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5',
} as const

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

export interface E2eEnv {
  waterfallsUrl: string
  waterfallsRecipient: string
  esploraApi: string
  borrowerMnemonic: string
  lenderMnemonic: string
}

export function loadEnv(): E2eEnv {
  const merged = {
    ...parseEnvFile(path.join(webRoot, '.env.liquidtestnet')),
    ...parseEnvFile(path.join(webRoot, '.env.e2e.local')),
  }
  const need = (name: string): string => {
    const value = process.env[name] ?? merged[name]
    if (!value) throw new Error(`${name} is not set (.env.liquidtestnet / .env.e2e.local)`)
    return value
  }
  return {
    waterfallsUrl: need('VITE_WATERFALLS_URL'),
    waterfallsRecipient: need('VITE_WATERFALLS_RECIPIENT'),
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

/** The stages that spend from the wallets, by the state record that marks each one done. */
export type Stage =
  | 'create'
  | 'accept'
  | 'claim-principal'
  | 'repay'
  | 'claim-repayment'
  | 'cancel'
  | 'liquidate'

const NONE: Need = { lbtc: 0n, test: 0n }

/**
 * What each stage needs from each wallet when it builds. A creation needs two coins besides the
 * collateral (2 × COLLATERAL, as the coins come) and a fee; `cancel` and `liquidate` include their
 * own creation, and `liquidate` its acceptance. The `wallets` stage only moves coins within a
 * wallet and checks its split itself.
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
  repay: {
    // the principal comes from the claim; the interest from the wallet
    borrower: { lbtc: FEE_BUDGET, test: REPAYMENT - PRINCIPAL },
    lender: NONE,
  },
  'claim-repayment': {
    borrower: NONE,
    lender: { lbtc: FEE_BUDGET, test: 0n },
  },
  cancel: {
    // its creation, then the cancellation
    borrower: { lbtc: 2n * COLLATERAL + 2n * FEE_BUDGET, test: 0n },
    lender: NONE,
  },
  liquidate: {
    // its creation; the lender accepts, then liquidates
    borrower: { lbtc: 2n * COLLATERAL + FEE_BUDGET, test: 0n },
    lender: { lbtc: 2n * FEE_BUDGET, test: PRINCIPAL },
  },
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

/** What each wallet must hold, confirmed, to run every stage. */
export const NEEDS = sumNeeds(STAGE_NAMES)

/** Confirmed tL-BTC coins to split each wallet into, and their size. */
export const SPLITS = {
  borrower: { coins: 6, amount: 15_000n },
  lender: { coins: 3, amount: 5_000n },
} as const
