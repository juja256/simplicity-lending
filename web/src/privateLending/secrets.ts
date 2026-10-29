import type { WalletTxOut } from '@lilbonekit/lwk-web'

import type { InputSecret } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'

/** The blinding secrets of a wallet coin, as the wasm `blindPset` needs them for its input. */
export function walletInputSecret(
  deps: PrivateFlowDeps,
  utxo: WalletTxOut,
  inputIndex: number,
): InputSecret {
  const secrets = utxo.unblinded()
  const asset = secrets.asset().toString()
  const value = secrets.value()
  if (secrets.isExplicit()) {
    return deps.wasm.InputSecret.explicit(inputIndex, asset, value)
  }
  return new deps.wasm.InputSecret(
    inputIndex,
    asset,
    secrets.assetBlindingFactor().toString(),
    value,
    secrets.valueBlindingFactor().toString(),
  )
}
