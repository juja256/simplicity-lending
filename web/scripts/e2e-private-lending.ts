// Testnet end-to-end run of the private lending flows.
//   npx pnpm@10.33.0 e2e:private [stage...]
// Stages run in the order given. Seed phrases come from `.env.e2e.local` and are never printed.
import * as lwk from '@lilbonekit/lwk-web'

import { createChain } from './e2e/chain'
import { loadEnv, TESTNET_ASSETS } from './e2e/env'
import { getRecord, saveRecord } from './e2e/state'
import { fingerprintGroups, initRuntime, type SeedWallet, seedWallet } from './e2e/wallet'

const SPLIT_COINS = 6
const SPLIT_AMOUNT = 15_000n
const MIN_CONFIRMED_LBTC_COINS = 6

// Minimums for three created offers, two of them accepted.
const MINIMUMS = {
  borrower: { lbtc: 100_000n, test: 200n },
  lender: { lbtc: 20_000n, test: 2_500n },
} as const

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function balanceOf(wallet: SeedWallet, asset: string): bigint {
  let total = 0n
  for (const utxo of wallet.utxos()) {
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

async function walletsStage(): Promise<void> {
  const env = loadEnv()
  const chain = createChain(env.esploraApi)
  const wallets = {
    borrower: seedWallet(env, env.borrowerMnemonic),
    lender: seedWallet(env, env.lenderMnemonic),
  }

  const short: string[] = []
  for (const [name, wallet] of Object.entries(wallets) as [keyof typeof wallets, SeedWallet][]) {
    await wallet.sync()
    const lbtc = balanceOf(wallet, TESTNET_ASSETS.policy)
    const test = balanceOf(wallet, TESTNET_ASSETS.principal)
    out(`${name}`)
    out(`  address     ${wallet.address()}`)
    out(`  tL-BTC      ${lbtc} sats`)
    out(`  TEST        ${test} units`)
    out(`  lending key ${fingerprintGroups(wallet.lendingKey)}`)
    const min = MINIMUMS[name]
    // After a recorded split the fee is already paid, so the tL-BTC minimum no longer applies.
    const split = getRecord(`wallets-split-${name}`) !== undefined
    if ((!split && lbtc < min.lbtc) || test < min.test) {
      short.push(
        `${name} needs at least ${min.lbtc} tL-sats and ${min.test} TEST units; fund ${wallet.address()}`,
      )
    }
  }
  if (short.length > 0) {
    console.error(`\nUnderfunded:\n${short.map(line => `  ${line}`).join('\n')}`)
    process.exit(1)
  }

  for (const [name, wallet] of Object.entries(wallets) as [keyof typeof wallets, SeedWallet][]) {
    const stage = `wallets-split-${name}`
    const record = getRecord(stage)
    if (record) {
      if (record.status === 'broadcast') {
        out(`${name}: split ${record.txid} already broadcast, waiting for confirmation`)
        await chain.waitForConfirmation(record.txid)
        saveRecord({ ...record, status: 'confirmed' })
      } else {
        out(`${name}: split ${record.txid} already confirmed`)
      }
      continue
    }
    const coins = confirmedLbtcCoins(wallet)
    if (coins >= MIN_CONFIRMED_LBTC_COINS) {
      out(`${name}: ${coins} confirmed tL-BTC coins, no split needed`)
      continue
    }
    out(`${name}: ${coins} confirmed tL-BTC coins, splitting into ${SPLIT_COINS} x ${SPLIT_AMOUNT}`)
    const address = new lwk.Address(wallet.address())
    let builder = new lwk.TxBuilder(wallet.network)
    for (let i = 0; i < SPLIT_COINS; i += 1)
      builder = builder.addLbtcRecipient(address, SPLIT_AMOUNT)
    const pset = wallet.signer.sign(builder.finish(wallet.wollet))
    const hex = wallet.wollet.finalize(pset).extractTx().toString()
    const txid = await chain.broadcast(hex)
    saveRecord({ stage, txid, hex, status: 'broadcast' })
    out(`${name}: split broadcast ${txid}`)
    await chain.waitForConfirmation(txid)
    saveRecord({ stage, txid, hex, status: 'confirmed' })
    out(`${name}: split confirmed`)
    await wallet.sync()
    out(`${name}: ${confirmedLbtcCoins(wallet)} confirmed tL-BTC coins`)
  }
  out('\nwallets: ok')
}

const STAGES: Record<string, () => Promise<void>> = {
  wallets: walletsStage,
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2)
  const names = requested.length > 0 ? requested : Object.keys(STAGES)
  for (const name of names) {
    if (!STAGES[name])
      throw new Error(`unknown stage "${name}"; known: ${Object.keys(STAGES).join(', ')}`)
  }
  await initRuntime()
  for (const name of names) {
    out(`== ${name}`)
    await STAGES[name]()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
