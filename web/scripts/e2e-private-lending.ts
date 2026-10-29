// Testnet end-to-end run of the private lending flows.
//   npx pnpm@10.33.0 e2e:private [stage...]
// Stages run in the order given. Seed phrases come from `.env.e2e.local` and are never printed.
//
// Resuming: every transaction is finalized and saved to `.e2e-private/state.json` (status
// `built`) BEFORE it is broadcast, then marked `broadcast` and `confirmed`. A re-run
// rebroadcasts the saved hex of a `built`/`broadcast` stage ("already known" is success) and
// waits for its confirmation; it never builds that transaction again.
//
// Funding: every invocation first checks that both wallets hold the need-based minimums of
// `NEEDS` (env.ts) in confirmed coins, and exits 1 naming each shortfall and the address to fund.
import * as lwk from '@lilbonekit/lwk-web'

import { createChain, submitStage } from './e2e/chain'
import { FEE_BUDGET, loadEnv, NEEDS, SPLITS, TESTNET_ASSETS } from './e2e/env'
import { getRecord } from './e2e/state'
import { fingerprintGroups, initRuntime, type SeedWallet, seedWallet } from './e2e/wallet'

type Name = 'borrower' | 'lender'
interface Context {
  chain: ReturnType<typeof createChain>
  wallets: Record<Name, SeedWallet>
}

const NAMES: Name[] = ['borrower', 'lender']

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function confirmedBalance(wallet: SeedWallet, asset: string): bigint {
  let total = 0n
  for (const utxo of wallet.utxos()) {
    if (utxo.height() === undefined) continue
    const secrets = utxo.unblinded()
    if (secrets.asset().toString() === asset) total += secrets.value()
  }
  return total
}

function confirmedLbtcCoins(wallet: SeedWallet): number {
  return wallet
    .utxos()
    .filter(
      utxo =>
        utxo.height() !== undefined &&
        utxo.unblinded().asset().toString() === TESTNET_ASSETS.policy,
    ).length
}

/** Exits 1, naming each shortfall and the address to fund. */
function requireFunding(ctx: Context): void {
  const short: string[] = []
  for (const name of NAMES) {
    const wallet = ctx.wallets[name]
    const lbtc = confirmedBalance(wallet, TESTNET_ASSETS.policy)
    const test = confirmedBalance(wallet, TESTNET_ASSETS.principal)
    const need = NEEDS[name]
    if (lbtc < need.lbtc) {
      short.push(`${name}: ${need.lbtc - lbtc} more tL-sats (has ${lbtc}, needs ${need.lbtc})`)
    }
    if (test < need.test) {
      short.push(`${name}: ${need.test - test} more TEST units (has ${test}, needs ${need.test})`)
    }
    if (lbtc < need.lbtc || test < need.test) short.push(`  fund ${wallet.address()}`)
  }
  if (short.length > 0) {
    console.error(`\nUnderfunded:\n${short.map(line => `  ${line}`).join('\n')}`)
    process.exit(1)
  }
}

async function walletsStage(ctx: Context): Promise<void> {
  for (const name of NAMES) {
    const wallet = ctx.wallets[name]
    out(name)
    out(`  address     ${wallet.address()}`)
    out(`  tL-BTC      ${confirmedBalance(wallet, TESTNET_ASSETS.policy)} sats (confirmed)`)
    out(`  TEST        ${confirmedBalance(wallet, TESTNET_ASSETS.principal)} units (confirmed)`)
    out(`  lending key ${fingerprintGroups(wallet.lendingKey)}`)
  }

  for (const name of NAMES) {
    const wallet = ctx.wallets[name]
    const stage = `wallets-split-${name}`
    const { coins: target, amount } = SPLITS[name]
    const coins = confirmedLbtcCoins(wallet)
    const recorded = await resumeRecorded(ctx, stage)
    if (recorded) {
      await wallet.sync()
      continue
    }
    if (coins >= target) {
      out(`${name}: ${coins} confirmed tL-BTC coins, no split needed`)
      continue
    }
    const needed = BigInt(target) * amount + FEE_BUDGET
    const have = confirmedBalance(wallet, TESTNET_ASSETS.policy)
    if (have < needed) {
      console.error(`${name}: cannot split, needs ${needed} tL-sats, has ${have}`)
      process.exit(1)
    }
    out(`${name}: ${coins} confirmed tL-BTC coins, splitting into ${target} x ${amount}`)
    await submitStage(
      ctx.chain,
      stage,
      () => {
        const address = new lwk.Address(wallet.address())
        let builder = new lwk.TxBuilder(wallet.network)
        for (let i = 0; i < target; i += 1) builder = builder.addLbtcRecipient(address, amount)
        const pset = wallet.signer.sign(builder.finish(wallet.wollet))
        return wallet.wollet.finalize(pset).extractTx().toString()
      },
      out,
    )
    await wallet.sync()
    out(`${name}: ${confirmedLbtcCoins(wallet)} confirmed tL-BTC coins`)
  }
  out('\nwallets: ok')
}

// A stage with a saved record is resumed from it, never rebuilt.
async function resumeRecorded(ctx: Context, stage: string): Promise<boolean> {
  if (!getRecord(stage)) return false
  await submitStage(
    ctx.chain,
    stage,
    () => {
      throw new Error('unreachable: a record exists')
    },
    out,
  )
  return true
}

const STAGES: Record<string, (ctx: Context) => Promise<void>> = {
  wallets: walletsStage,
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2)
  const names = requested.length > 0 ? requested : Object.keys(STAGES)
  for (const name of names) {
    if (!STAGES[name]) {
      throw new Error(`unknown stage "${name}"; known: ${Object.keys(STAGES).join(', ')}`)
    }
  }
  await initRuntime()
  const env = loadEnv()
  const ctx: Context = {
    chain: createChain(env.esploraApi),
    wallets: {
      borrower: seedWallet(env, env.borrowerMnemonic),
      lender: seedWallet(env, env.lenderMnemonic),
    },
  }
  await ctx.wallets.borrower.sync()
  await ctx.wallets.lender.sync()
  requireFunding(ctx)
  for (const name of names) {
    out(`== ${name}`)
    await STAGES[name](ctx)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
