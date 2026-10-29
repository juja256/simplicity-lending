// The PSET fields that LWK's JS API does not expose, read by the wasm module's `inspectPset`
// (rust-elements' PSET parser). Every absent field is `null`: negative checks compare with null
// explicitly, never through a default.
import type { PrivateFlowDeps } from './deps'

export interface InspectedIssuance {
  assetId: string
  tokenId: string
  isReissuance: boolean
  /** The explicit amount issued. */
  amount: bigint | null
  amountCommitment: string | null
  /** The explicit amount of reissuance tokens issued. */
  inflationKeys: bigint | null
  inflationKeysCommitment: string | null
  /** 0 when the issuance stays unblinded. */
  blindedIssuance: number | null
}

export interface InspectedInput {
  /** `"<txid>:<vout>"`. */
  prevout: string
  issuance: InspectedIssuance | null
}

export interface InspectedOutput {
  /** The script pubkey, hex. */
  script: string
  asset: string | null
  amount: bigint | null
  assetCommitment: string | null
  amountCommitment: string | null
  /** The nonce: the ephemeral ECDH key of a blinded output. */
  ecdhPubkey: string | null
  /** The key the output is blinded to. */
  blindingKey: string | null
  /** The input whose owner blinds the output. */
  blinderIndex: number | null
  hasBlindValueProof: boolean
  hasBlindAssetProof: boolean
}

export interface InspectedPset {
  inputs: InspectedInput[]
  outputs: InspectedOutput[]
}

type Raw<T> = {
  [K in keyof T]: T[K] extends bigint | null ? string | null : T[K]
}

interface RawPset {
  inputs: { prevout: string; issuance: Raw<InspectedIssuance> | null }[]
  outputs: Raw<InspectedOutput>[]
}

function amount(value: string | null): bigint | null {
  return value === null ? null : BigInt(value)
}

/** The inspected fields of a PSET (base64). */
export function inspectPset(wasm: PrivateFlowDeps['wasm'], psetBase64: string): InspectedPset {
  let json: string
  try {
    json = wasm.inspectPset(psetBase64)
  } catch (error) {
    const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
    throw new Error(`Inspecting the PSET: ${text || 'unknown error'}`, { cause: error })
  }
  const raw = JSON.parse(json) as RawPset
  return {
    inputs: raw.inputs.map(input => ({
      prevout: input.prevout,
      issuance:
        input.issuance === null
          ? null
          : {
              ...input.issuance,
              amount: amount(input.issuance.amount),
              inflationKeys: amount(input.issuance.inflationKeys),
            },
    })),
    outputs: raw.outputs.map(output => ({ ...output, amount: amount(output.amount) })),
  }
}
