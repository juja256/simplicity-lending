// Helpers shared by the private flow builders, and the one PSET layout checker they all use.
import type { Pset, Transaction, TxOut, TxOutSecrets, WalletTxOut } from '@lilbonekit/lwk-web'

import { NFT_AMOUNT, NO_REISSUANCE_TOKEN } from '@/simplicity/private-lending/layout'
import type { PinnedOutputInfo } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from '../deps'
import { inspectPset } from '../inspectPset'

export function outpointOf(utxo: WalletTxOut): string {
  const outpoint = utxo.outpoint()
  return `${outpoint.txid().toString()}:${outpoint.vout()}`
}

/** Splits `"<txid>:<vout>"`. */
export function parseOutpoint(outpoint: string): { txid: string; vout: number } {
  const match = /^([0-9a-f]{64}):(\d+)$/.exec(outpoint.trim().toLowerCase())
  if (!match) throw new Error(`Not an outpoint: ${outpoint}`)
  return { txid: match[1], vout: Number(match[2]) }
}

/**
 * Runs a wasm call (the private lending module's or LWK's), turning what it throws, often a bare
 * `"<code>: <message>"` string, into an `Error` that names the step.
 */
export function wasmStep<T>(step: string, run: () => T): T {
  try {
    return run()
  } catch (error) {
    const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
    throw new Error(`${step}: ${text || 'unknown error'}`, { cause: error })
  }
}

/** Output `vout` of `tx`, a fresh `TxOut` (LWK copies on every `outputs` access). */
export function requireOutput(tx: Transaction, vout: number, label: string): TxOut {
  const output = tx.outputs[vout]
  if (!output)
    throw new Error(`${label}: transaction ${tx.txid().toString()} has no output ${vout}`)
  return output
}

/** The LWK secrets of a pinned output, for spending it as an `ExternalUtxo`. */
export function pinnedTxOutSecrets(deps: PrivateFlowDeps, info: PinnedOutputInfo): TxOutSecrets {
  const { lwk } = deps
  return new lwk.TxOutSecrets(
    lwk.AssetId.fromString(info.asset),
    lwk.AssetBlindingFactor.fromString(info.assetBlinder),
    info.amount,
    lwk.ValueBlindingFactor.fromString(info.valueBlinder),
  )
}

/** The transactions of `outpoints`, by txid, fetched once each. */
export async function fetchPrevoutTxs(
  deps: PrivateFlowDeps,
  outpoints: string[],
): Promise<Map<string, Transaction>> {
  const txids = [...new Set(outpoints.map(outpoint => parseOutpoint(outpoint).txid))]
  const txs = await Promise.all(txids.map(txid => deps.fetchTx(txid)))
  return new Map(txids.map((txid, index) => [txid, txs[index]]))
}

/** Fresh `TxOut`s of `outpoints`, from transactions fetched with `fetchPrevoutTxs`. */
export function prevoutsOf(txs: Map<string, Transaction>, outpoints: string[]): TxOut[] {
  return outpoints.map(outpoint => {
    const { txid, vout } = parseOutpoint(outpoint)
    const tx = txs.get(txid)
    if (!tx) throw new Error(`The transaction of ${outpoint} was not fetched`)
    return requireOutput(tx, vout, outpoint)
  })
}

/** Throws unless every input of `tx` carries a witness, so the transaction can be broadcast. */
export function assertAllInputsFinalized(tx: Transaction, label: string): void {
  tx.inputs.forEach((input, index) => {
    if (input.witness().isEmpty()) throw new Error(`${label}: input ${index} is not finalized`)
  })
}

/** How an expected output is blinded. */
export type ExpectedBlinding =
  | { kind: 'explicit' }
  /** Blinded with the pinned blinders, to exactly `blindingKey`. */
  | {
      kind: 'pinned'
      blindingKey: string
      pinned: { assetCommitment: string; valueCommitment: string }
    }
  /** Blinded freshly to its recipient's key, as a wallet output is. */
  | { kind: 'fresh' }

export interface ExpectedOutput {
  script: string
  asset: string
  amount: bigint
  blinding: ExpectedBlinding
}

/** What a private flow's PSET must hold, checked after `finish` and again after blinding. */
export interface SpendLayout {
  /** The prevouts, in input order. */
  inputs: string[]
  /**
   * The NFT each input newly issues, by input index: exactly one explicit unit, no reissuance
   * token, the issuance unblinded. An input with no entry (or `undefined`) issues nothing.
   */
  issuances?: (string | undefined)[]
  /** The leading outputs; change and the fee follow. */
  outputs: ExpectedOutput[]
  /**
   * Assets no other output may carry: the offer's NFTs. The issued NFTs and their reissuance
   * token ids are added to them.
   */
  restrictedAssets: string[]
  /** Scripts no other output may pay: the offer's covenants. */
  restrictedScripts: string[]
  /** The fee asset; the last output must be the fee. */
  policyAsset: string
}

/**
 * Checks a PSET against its layout through `inspectPset`, with every negative check against an
 * explicit null. Before blinding nothing may be blinded; after it the pinned outputs must carry
 * their pinned commitments and both blind proofs, and every output with a blinding key must be
 * blinded.
 */
export function assertSpendLayout(
  deps: PrivateFlowDeps,
  pset: Pset,
  layout: SpendLayout,
  blinded: boolean,
  label: string,
): void {
  function fail(what: string): never {
    throw new Error(`${label} PSET ${blinded ? 'after blinding' : 'after finish'}: ${what}`)
  }
  const { inputs, outputs } = inspectPset(deps.wasm, pset.toString())

  if (inputs.length !== layout.inputs.length) {
    fail(`${inputs.length} inputs instead of ${layout.inputs.length}`)
  }
  const issued: string[] = []
  inputs.forEach((input, index) => {
    if (input.prevout !== layout.inputs[index]) {
      fail(`input ${index} spends ${input.prevout} instead of ${layout.inputs[index]}`)
    }
    const nft = layout.issuances?.[index]
    const issuance = input.issuance
    if (nft === undefined) {
      if (issuance !== null) fail(`input ${index} issues ${issuance.assetId}`)
      return
    }
    if (issuance === null) fail(`input ${index} does not issue ${nft}`)
    issued.push(nft, issuance.tokenId)
    if (issuance.assetId !== nft || issuance.isReissuance) {
      fail(`input ${index} does not newly issue ${nft}`)
    }
    if (issuance.amount !== NFT_AMOUNT || issuance.amountCommitment !== null) {
      fail(`input ${index} does not issue exactly one explicit unit`)
    }
    if (
      !(issuance.inflationKeys === null || issuance.inflationKeys === NO_REISSUANCE_TOKEN) ||
      issuance.inflationKeysCommitment !== null
    ) {
      fail(`input ${index} issues reissuance tokens`)
    }
    if (issuance.blindedIssuance !== 0) fail(`input ${index}'s issuance is not marked unblinded`)
  })

  // the expected outputs, then at least the fee
  if (outputs.length <= layout.outputs.length) fail(`only ${outputs.length} outputs`)
  layout.outputs.forEach((expected, index) => {
    const output = outputs[index]
    if (output.script !== expected.script) {
      fail(`output ${index} pays ${output.script}, not ${expected.script}`)
    }
    if (output.asset !== expected.asset || output.amount !== expected.amount) {
      fail(`output ${index} holds ${output.amount} of ${output.asset}`)
    }
    const { blinding } = expected
    if (blinding.kind === 'explicit') {
      if (output.blindingKey !== null) fail(`output ${index} has a blinding key`)
      if (
        output.assetCommitment !== null ||
        output.amountCommitment !== null ||
        output.ecdhPubkey !== null
      ) {
        fail(`output ${index} is blinded`)
      }
      return
    }
    if (blinding.kind === 'pinned' && output.blindingKey !== blinding.blindingKey) {
      fail(`output ${index} has blinding key ${output.blindingKey}, not ${blinding.blindingKey}`)
    }
    if (output.blindingKey === null) fail(`output ${index} has no blinding key`)
    if (output.blinderIndex === null) fail(`output ${index} has no blinder index`)
    if (!blinded) return
    if (blinding.kind === 'pinned') {
      if (
        output.assetCommitment !== blinding.pinned.assetCommitment ||
        output.amountCommitment !== blinding.pinned.valueCommitment
      ) {
        fail(`output ${index} is not blinded to its pinned commitments`)
      }
      // a hardware wallet checks the pinned output against its explicit values with these
      if (!output.hasBlindValueProof || !output.hasBlindAssetProof) {
        fail(`output ${index} lacks its blind value or asset proof`)
      }
    }
  })

  const restrictedAssets = new Set([...layout.restrictedAssets, ...issued])
  const restrictedScripts = new Set(layout.restrictedScripts)
  for (let index = layout.outputs.length; index < outputs.length; index += 1) {
    const output = outputs[index]
    if (output.asset === null) fail(`output ${index} has no explicit asset`)
    if (restrictedAssets.has(output.asset)) {
      fail(`output ${index} carries an NFT of the offer or its token`)
    }
    if (restrictedScripts.has(output.script)) fail(`output ${index} pays a covenant of the offer`)
  }
  const fee = outputs[outputs.length - 1]
  if (fee.script !== '' || fee.asset !== layout.policyAsset || fee.blindingKey !== null) {
    fail('the last output is not the fee')
  }
  outputs.slice(0, -1).forEach((output, index) => {
    if (output.script === '') fail(`output ${index} is a second fee output`)
  })

  outputs.forEach((output, index) => {
    if (!blinded) {
      // `skipBlinding`: nothing is blinded before `blindPset`
      if (output.assetCommitment !== null || output.amountCommitment !== null) {
        fail(`output ${index} is blinded already`)
      }
    } else if (
      output.blindingKey !== null &&
      (output.assetCommitment === null ||
        output.amountCommitment === null ||
        output.ecdhPubkey === null)
    ) {
      fail(`output ${index} has a blinding key but was not blinded`)
    }
  })
}
