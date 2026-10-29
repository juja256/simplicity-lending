// The e2e wallets: a seed signer and a wollet synced through waterfalls, plus the Node setup of
// LWK and the private lending wasm.
import fs from 'node:fs'
import path from 'node:path'

import * as lwk from '@lilbonekit/lwk-web'

import type { PrivateFlowDeps } from '@/privateLending/deps'
import type { PrivateLendingSources } from '@/simplicity/private-lending/scripts'
import * as wasm from '@/wasm/private-lending/private_lending_wasm'

import type { Chain } from './chain'
import { type E2eEnv, TESTNET_ASSETS, webRoot } from './env'

const simfDir = path.resolve(webRoot, '../crates/contracts/simf')

export async function initRuntime(): Promise<void> {
  await lwk.default({
    module_or_path: fs.readFileSync(
      path.join(webRoot, 'node_modules/@lilbonekit/lwk-web/lwk_wasm_bg.wasm'),
    ),
  })
  await wasm.default({
    module_or_path: fs.readFileSync(
      path.join(webRoot, 'src/wasm/private-lending/private_lending_wasm_bg.wasm'),
    ),
  })
}

function readSimf(name: string): string {
  // Trimmed, as simplicitySourcesPlugin does.
  return fs.readFileSync(path.join(simfDir, `${name}.simf`), 'utf-8').trim()
}

export function readSources(): PrivateLendingSources {
  return {
    privateLending: readSimf('private_lending'),
    assetAuth: readSimf('asset_auth'),
    scriptAuth: readSimf('script_auth'),
  }
}

export interface SeedWallet {
  signer: lwk.Signer
  wollet: lwk.Wollet
  network: lwk.Network
  lendingKey: wasm.LendingKey
  sync(): Promise<void>
  utxos(): lwk.WalletTxOut[]
  address(): string
}

export function seedWallet(env: E2eEnv, mnemonic: string): SeedWallet {
  const network = lwk.Network.testnet()
  const signer = new lwk.Signer(new lwk.Mnemonic(mnemonic), network)
  const descriptor = signer.wpkhSlip77Descriptor()
  const wollet = new lwk.Wollet(network, descriptor)
  const client = new lwk.EsploraClient(network, env.waterfallsUrl, true, 8, false)
  client.setWaterfallsServerRecipient(env.waterfallsRecipient)
  return {
    signer,
    wollet,
    network,
    lendingKey: wasm.LendingKey.fromDescriptor(descriptor.toString()),
    async sync() {
      const update = await client.fullScanToIndex(wollet, 0)
      if (update) wollet.applyUpdate(update)
    },
    utxos: () => wollet.utxos(),
    address: () => wollet.address().address().toString(),
  }
}

export function flowDeps(wallet: SeedWallet, chain: Chain): PrivateFlowDeps {
  return {
    lwk,
    wasm,
    network: wallet.network,
    networkName: 'liquidtestnet',
    sources: readSources(),
    wollet: wallet.wollet,
    walletUtxos: () => wallet.utxos(),
    fetchTx: txid => chain.fetchTx(txid),
    feeRate: null,
    assets: { ...TESTNET_ASSETS },
  }
}

/** A lending key fingerprint in groups of four hex characters, as the app shows it. */
export function fingerprintGroups(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/g) ?? []).join(' ')
}
