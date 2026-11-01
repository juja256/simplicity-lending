import { EsploraClient, Network } from '@lilbonekit/lwk-web'

import { env, type NetworkName } from '@/constants/env'

import { resolveWaterfallsRecipient } from './waterfallsRecipient'

export type Lwk = typeof import('@lilbonekit/lwk-web')

let lwk: Lwk | null = null

export async function getLwk(): Promise<Lwk> {
  if (!lwk) {
    lwk = await import('@lilbonekit/lwk-web')
    if (typeof lwk.default === 'function') await lwk.default()
  }
  return lwk
}

export function createLwkNetwork(network: NetworkName): Network {
  switch (network) {
    case 'liquid':
      return Network.mainnet()
    case 'liquidtestnet':
      return Network.testnet()
    case 'regtest':
      return Network.regtestDefault()
  }
}

/**
 * Creates an EsploraClient configured for waterfalls scanning.
 * utxoOnly is off: waterfalls caps a reused script at MAX_TXS_SEEN (100) in that mode and
 * fails the whole scan. The full history it downloads instead is deduped against the
 * persistent wallet cache, so only the first scan pays for it.
 */
export async function createEsploraClient(lwkNetwork: Network): Promise<EsploraClient> {
  const client = new EsploraClient(
    lwkNetwork,
    env.VITE_WATERFALLS_URL,
    true, // waterfalls
    8, // concurrency
    false, // utxoOnly
  )
  if (lwkNetwork.isMainnet() || lwkNetwork.isTestnet()) {
    // The server's own key, unless one is pinned: the descriptor is encrypted to it.
    const recipient = await resolveWaterfallsRecipient(
      env.VITE_WATERFALLS_URL,
      env.VITE_WATERFALLS_RECIPIENT,
    )
    await client.setWaterfallsServerRecipient(recipient)
  }
  return client
}
