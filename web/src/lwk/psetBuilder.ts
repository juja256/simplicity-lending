import {
  type Address,
  type AssetId,
  assetIdFromIssuance,
  type ContractHash,
  LockTime,
  type Network,
  type OutPoint,
  type Pset,
  PsetBuilder,
  type PsetInput,
  PsetInputBuilder,
  PsetOutputBuilder,
  type PublicKey,
  reissuanceTokenFromIssuance,
  Script,
  TxOut,
  TxOutSecrets,
  TxSequence,
} from 'lwk_wasm'

// Builds a PSET without TxBuilder: the caller decides every input and output and their
// order. This module only appends the L-BTC change and the fee outputs, computes the fee
// and blinds, unless the blinding is left to the wallet or the caller.

export interface PsetInputSpec {
  outpoint: OutPoint
  /** The previous output as found on chain. */
  prevout: TxOut
  asset: AssetId
  amount: bigint
  /** Secrets with blinding factors; required to blind locally when `prevout` is confidential. */
  secrets?: TxOutSecrets
  sequence?: number
  maxWeightToSatisfy: number
  /** New unblinded issuance on this input. */
  issuance?: PsetIssuanceSpec
  /** A coin from the user's wallet. With `wallet` or `none` blinding, the first is the blinder. */
  walletCoin?: boolean
}

export interface PsetIssuanceSpec {
  assetAmount: bigint
  tokenAmount: bigint
  /** Zero hash when the asset has no contract. */
  contractHash: ContractHash
}

export interface PsetOutputSpec {
  script: Script
  amount: bigint
  asset: AssetId
  /** Set to make the output confidential. */
  blindingPubkey?: PublicKey
}

// `local`: blind here with the inputs' secrets (seed, Jade).
// `wallet`: leave blinding to the wallet that owns the `walletCoin` inputs (e.g. Humid, which
// does not share its blinding secrets).
// `none`: leave blinding to the caller, which blinds the returned PSET itself (the private
// lending flows, whose wasm pins the blinding factors of some outputs). The confidential outputs
// keep their blinding key and name the first `walletCoin` input as their blinder, or input 0
// without one. The fee is still estimated on a blinded trial copy.
const MAX_FEE_RATE_SAT_PER_KVB = 1_000_000

/**
 * A confidential burn's stand-in in the fee estimate's trial copy: a P2WPKH script (22 bytes), the
 * shortest that has an address form, longer than any `OP_RETURN "burn"` the flows blind.
 */
const TRIAL_BURN_SCRIPT_HEX = `0014${'00'.repeat(20)}`

export type PsetBlinding = 'local' | 'wallet' | 'none'

export interface BuildPsetParams {
  network: Network
  inputs: PsetInputSpec[]
  outputs: PsetOutputSpec[]
  /** Receives the L-BTC change, appended after `outputs` and before the fee output. */
  changeAddress: Address
  feeRateSatPerKvb: number
  fallbackLocktime?: number
  blinding: PsetBlinding
}

export interface BuiltPset {
  pset: Pset
  fee: bigint
}

// Note: blinding consumes the `secrets` of the inputs, so build once per set of specs.
export function buildPset(params: BuildPsetParams): BuiltPset {
  if (params.feeRateSatPerKvb > MAX_FEE_RATE_SAT_PER_KVB) {
    throw new Error(
      `Fee rate ${params.feeRateSatPerKvb} sat/kvb is above ${MAX_FEE_RATE_SAT_PER_KVB}`,
    )
  }
  const policyAsset = params.network.policyAsset().toString()
  assertNonPolicyAssetsBalance(params, policyAsset)

  const isPolicy = (asset: AssetId) => asset.toString() === policyAsset
  const lbtcIn = sum(params.inputs.filter(input => isPolicy(input.asset)).map(i => i.amount))
  const lbtcOut = sum(params.outputs.filter(output => isPolicy(output.asset)).map(o => o.amount))

  const fee = estimateFee(params, lbtcIn - lbtcOut)
  const change = lbtcIn - lbtcOut - fee
  if (change <= 0n) {
    throw new Error(`Insufficient L-BTC: missing ${(1n - change).toString()} sats`)
  }

  return { pset: assemble(params, change, fee, false), fee }
}

// Same as LWK TxBuilder: blind a trial copy, take its discounted size and add the weight
// needed to satisfy each input. Prevouts are not part of the transaction, so replacing them
// with explicit ones (blindable without the wallet's secrets) doesn't change its size.
function estimateFee(params: BuildPsetParams, lbtcAvailable: bigint): bigint {
  const trialTx = assemble(params, lbtcAvailable, 0n, true).extractTx()
  const satisfyWeight = params.inputs.reduce((acc, input) => acc + input.maxWeightToSatisfy, 0)
  const vsize = Math.ceil((trialTx.discountVsize() * 4 + satisfyWeight) / 4)
  return BigInt(Math.ceil((vsize * params.feeRateSatPerKvb) / 1000))
}

function assemble(params: BuildPsetParams, change: bigint, fee: bigint, trial: boolean): Pset {
  const policyAsset = params.network.policyAsset()
  let builder = PsetBuilder.newV2()

  for (const input of params.inputs) {
    builder = builder.addInput(buildInput(input, trial))
  }

  const outputs: PsetOutputSpec[] = [
    ...params.outputs,
    {
      script: params.changeAddress.scriptPubkey(),
      amount: change,
      asset: policyAsset,
      blindingPubkey: params.changeAddress.blindingPubkey(),
    },
    { script: Script.empty(), amount: fee, asset: policyAsset },
  ]
  const blinderIndex = trial ? 0 : outputBlinderIndex(params)
  for (const output of outputs) {
    // LWK's blinding refuses an `OP_RETURN` with a blinding key, which the caller blinds itself
    // (`none`): the trial copy gives it a spendable script of an address form instead, a few
    // bytes longer, so the estimate is a little high, never low.
    const script =
      trial && output.blindingPubkey && output.script.isProvablyUnspendable()
        ? new Script(TRIAL_BURN_SCRIPT_HEX)
        : output.script
    let outputBuilder = PsetOutputBuilder.newExplicit(script, output.amount, output.asset)
    if (output.blindingPubkey) {
      outputBuilder = outputBuilder.blindingPubkey(output.blindingPubkey).blinderIndex(blinderIndex)
    }
    builder = builder.addOutput(outputBuilder.build())
  }

  if (params.fallbackLocktime !== undefined) {
    builder = builder.setFallbackLocktime(new LockTime(params.fallbackLocktime))
  }

  const blindHere = trial || params.blinding === 'local'
  if (blindHere && outputs.some(output => output.blindingPubkey)) {
    const secrets = params.inputs.map(input => blindingSecrets(input, trial))
    builder = builder.blindLast(Uint32Array.from(params.inputs.map((_, i) => i)), secrets)
  }

  return builder.build()
}

function buildInput(input: PsetInputSpec, trial: boolean): PsetInput {
  const prevout = trial
    ? TxOut.fromExplicit(input.prevout.scriptPubkey(), input.asset, input.amount)
    : input.prevout
  let builder = PsetInputBuilder.fromPrevout(input.outpoint).witnessUtxo(prevout)
  if (input.sequence !== undefined) {
    builder = builder.sequence(new TxSequence(input.sequence))
  }
  // Same fields LWK TxBuilder sets for a new issuance.
  if (input.issuance) {
    const { assetAmount, tokenAmount, contractHash } = input.issuance
    if (assetAmount > 0n) builder = builder.issuanceValueAmount(assetAmount)
    if (tokenAmount > 0n) builder = builder.issuanceInflationKeys(tokenAmount)
    builder = builder.issuanceAssetEntropy(contractHash).blindedIssuance(false)
  }
  return builder.build()
}

function outputBlinderIndex(params: BuildPsetParams): number {
  switch (params.blinding) {
    case 'local':
      return 0
    case 'wallet':
      return walletBlinderIndex(params)
    case 'none': {
      const index = params.inputs.findIndex(input => input.walletCoin)
      return index === -1 ? 0 : index
    }
  }
}

function walletBlinderIndex(params: BuildPsetParams): number {
  const index = params.inputs.findIndex(input => input.walletCoin)
  if (index === -1) throw new Error('Wallet blinding needs at least one walletCoin input')
  return index
}

function blindingSecrets(input: PsetInputSpec, trial: boolean): TxOutSecrets {
  if (trial || input.prevout.value() !== undefined) {
    return TxOutSecrets.fromExplicit(input.asset, input.amount)
  }
  if (!input.secrets) throw new Error('Missing secrets to blind a confidential input')
  return input.secrets
}

function assertNonPolicyAssetsBalance(params: BuildPsetParams, policyAsset: string): void {
  const balances = new Map<string, bigint>()
  const add = (asset: AssetId, amount: bigint) => {
    const key = asset.toString()
    if (key !== policyAsset) balances.set(key, (balances.get(key) ?? 0n) + amount)
  }
  params.inputs.forEach(input => {
    add(input.asset, input.amount)
    if (input.issuance) {
      const { assetAmount, tokenAmount, contractHash } = input.issuance
      add(assetIdFromIssuance(input.outpoint, contractHash), assetAmount)
      add(reissuanceTokenFromIssuance(input.outpoint, contractHash, false), tokenAmount)
    }
  })
  params.outputs.forEach(output => add(output.asset, -output.amount))
  for (const [asset, delta] of balances) {
    if (delta !== 0n) {
      throw new Error(`Asset ${asset} does not balance (inputs - outputs = ${delta.toString()})`)
    }
  }
}

function sum(values: bigint[]): bigint {
  return values.reduce((acc, value) => acc + value, 0n)
}
