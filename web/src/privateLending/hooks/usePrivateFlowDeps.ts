// Binds the DOM-free private lending code to the app: LWK and the network from `LwkProvider`, the
// wallet from `WalletProvider`, esplora, the indexer and the covenant sources. Only these hooks
// read the app's providers; the builders get everything through `PrivateFlowDeps`.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Wollet } from 'lwk_wasm'
import { useCallback } from 'react'
import { sources } from 'virtual:simplicity-sources'

import { FALLBACK_FEE_RATE_SAT_PER_KVB, fetchFeeRateSatPerKvb } from '@/api/esplora/fee'
import { fetchLatestBlockHeight, fetchTxRaw } from '@/api/esplora/methods'
import { esploraQueryKeys } from '@/api/esplora/queryKeys'
import { env } from '@/constants/env'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { getLwk } from '@/lwk'
import { AddressCursor } from '@/privateLending/addressCursor'
import type { PrivateFlowDeps } from '@/privateLending/deps'
import { getPrivateLendingWasm } from '@/privateLending/wasm'
import { useLwk } from '@/providers/lwk/useLwk'
import { useWallet } from '@/providers/wallet/useWallet'
import type { PrivateLendingSources } from '@/simplicity/private-lending/scripts'

import { lendingKeyIdentityQueryKey } from './queryKeys'

/** The indexer every private hook reads and writes. */
export const PRIVATE_API_BASE_URL = env.VITE_API_URL

const PRIVATE_SOURCES: PrivateLendingSources = {
  privateLending: sources.private_lending,
  assetAuth: sources.asset_auth,
  scriptAuth: sources.script_auth,
}

// A fee rate this fresh is reused.
const FEE_RATE_STALE_MS = 30_000

// The address cursor of each wallet session, keyed by the session's `Wollet`: every connection
// makes a new one, so a disconnect or a switch drops the cursor with the session it belonged to.
const sessionAddresses = new WeakMap<Wollet, AddressCursor>()

function addressesOf(wollet: Wollet): AddressCursor {
  let cursor = sessionAddresses.get(wollet)
  if (!cursor) {
    cursor = new AddressCursor()
    sessionAddresses.set(wollet, cursor)
  }
  return cursor
}

/**
 * The fee rate a build pays, in sat/kvb: esplora's estimate if it is a finite number above zero,
 * else `FALLBACK_FEE_RATE_SAT_PER_KVB`. Esplora's answer passes through unchecked, so it can be
 * negative or infinite (`1e999` parses as `Infinity`).
 */
function usableFeeRate(estimate: unknown): number {
  return typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0
    ? estimate
    : FALLBACK_FEE_RATE_SAT_PER_KVB
}

/**
 * A function that assembles fresh `PrivateFlowDeps` for one build or scan: the connected wallet's
 * `Wollet` and coins, esplora's transactions (checked against the requested txid), its tip height
 * and its fee rate in sat/kvb (`usableFeeRate`; a failed fee query also gives the fallback),
 * and the session's address cursor, the same for every build of the session.
 * Rejects while no wallet is connected. Sync the wallet first when its coins must be current.
 */
export function usePrivateFlowDeps(): () => Promise<PrivateFlowDeps> {
  const { lwkNetwork, network } = useLwk()
  const { getWollet } = useWallet()
  const queryClient = useQueryClient()

  return useCallback(async (): Promise<PrivateFlowDeps> => {
    const [lwk, wasm, wollet, feeRate] = await Promise.all([
      getLwk(),
      getPrivateLendingWasm(),
      getWollet(),
      queryClient
        .fetchQuery({
          queryKey: esploraQueryKeys.feeRate,
          queryFn: () => fetchFeeRateSatPerKvb(),
          staleTime: FEE_RATE_STALE_MS,
        })
        .then(usableFeeRate, () => FALLBACK_FEE_RATE_SAT_PER_KVB),
    ])
    return {
      lwk,
      wasm,
      network: lwkNetwork,
      networkName: network,
      sources: PRIVATE_SOURCES,
      wollet,
      addresses: addressesOf(wollet),
      walletUtxos: () => wollet.utxos(),
      fetchTx: async txid => {
        const tx = lwk.Transaction.fromBytes(await fetchTxRaw(txid))
        if (tx.txid().toString() !== txid.toLowerCase()) {
          throw new Error(`Esplora served another transaction for ${txid}`)
        }
        return tx
      },
      fetchTipHeight: () => fetchLatestBlockHeight(),
      feeRate,
      assets: {
        collateral: NETWORK_CONFIG.collateralAsset.id,
        principal: NETWORK_CONFIG.principalAsset.id,
        policy: lwkNetwork.policyAsset().toString(),
      },
    }
  }, [lwkNetwork, network, getWollet, queryClient])
}

/** The public identity of the session's lending key. */
export interface LendingKeyIdentity {
  /** The x-only key, 64 hex characters: the only part of the key that leaves the browser. */
  pubkey: string
  /** `keyFingerprint` of the key, 16 hex characters (shown in 4×4 groups). */
  fingerprint: string
}

/**
 * The connected wallet's lending-key identity, for display, directory writes and the lender field
 * of offers. Computed locally: nothing is requested with it. Disabled unless a private-capable
 * wallet is ready. Only the public parts are kept, and only for the session.
 */
export function useLendingKeyIdentity() {
  const { isReady, privateCapable, scriptPubkey, getLendingKey } = useWallet()
  return useQuery({
    queryKey: lendingKeyIdentityQueryKey(scriptPubkey),
    enabled: isReady && privateCapable && scriptPubkey !== null,
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<LendingKeyIdentity> => {
      const key = await getLendingKey()
      return { pubkey: key.xOnlyPublicKey(), fingerprint: key.fingerprint() }
    },
  })
}
