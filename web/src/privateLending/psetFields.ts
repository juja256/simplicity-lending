// The PSET fields that LWK's `PsetInput`/`PsetOutput` do not expose but the private flows must
// check before signing: each output's blinding key, nonce and commitments, and each input's
// issuance amounts. Read straight from the PSET (BIP-370 maps with the Elements `pset`
// proprietary keys, as in rust-elements `pset::map`).
import { bytesToHex } from '@/utils/hex'

export interface PsetOutputFields {
  /** The 33-byte key the output is blinded to (hex). */
  blindingKey?: string
  /** The input whose owner blinds the output. */
  blinderIndex?: number
  /** The nonce: the ephemeral ECDH key of a blinded output (hex). */
  ecdhPubkey?: string
  /** The consensus-encoded asset commitment (hex). */
  assetCommitment?: string
  /** The consensus-encoded value commitment (hex). */
  valueCommitment?: string
}

export interface PsetInputFields {
  /** The explicit amount the input issues. */
  issuanceValue?: bigint
  /** The explicit amount of reissuance tokens the input issues. */
  issuanceInflationKeys?: bigint
  /** 0 when the issuance stays unblinded. */
  blindedIssuance?: number
}

export interface PsetFields {
  inputs: PsetInputFields[]
  outputs: PsetOutputFields[]
}

const GLOBAL_INPUT_COUNT = 0x04
const GLOBAL_OUTPUT_COUNT = 0x05
const PROPRIETARY = 0xfc
const PSET_PREFIX = 'pset'

const IN_ISSUANCE_VALUE = 0x00
const IN_ISSUANCE_INFLATION_KEYS = 0x0a
const IN_BLINDED_ISSUANCE = 0x15

const OUT_VALUE_COMMITMENT = 0x01
const OUT_ASSET_COMMITMENT = 0x03
const OUT_BLINDING_PUBKEY = 0x06
const OUT_ECDH_PUBKEY = 0x07
const OUT_BLINDER_INDEX = 0x08

class Reader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new Error('truncated PSET')
    const slice = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }

  compactSize(): number {
    const first = this.take(1)[0]
    if (first < 0xfd) return first
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    const value = littleEndian(this.take(width))
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PSET length out of range')
    return Number(value)
  }
}

function littleEndian(bytes: Uint8Array): bigint {
  let value = 0n
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index])
  }
  return value
}

/** Calls `onPair` with each key type, `pset` proprietary subtype (or null) and value. */
function readMap(
  reader: Reader,
  onPair: (type: number, psetSubtype: number | null, value: Uint8Array) => void,
): void {
  for (;;) {
    const keyLength = reader.compactSize()
    if (keyLength === 0) return
    const key = new Reader(reader.take(keyLength))
    const value = reader.take(reader.compactSize())
    const type = key.take(1)[0]
    let psetSubtype: number | null = null
    if (type === PROPRIETARY) {
      const prefix = new TextDecoder().decode(key.take(key.compactSize()))
      if (prefix === PSET_PREFIX) psetSubtype = key.take(1)[0]
    }
    onPair(type, psetSubtype, value)
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.trim())
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** The blinding and issuance fields of every input and output of a PSET (base64). */
export function readPsetFields(psetBase64: string): PsetFields {
  const reader = new Reader(base64ToBytes(psetBase64))
  if (new TextDecoder().decode(reader.take(4)) !== 'pset' || reader.take(1)[0] !== 0xff) {
    throw new Error('not a PSET')
  }

  let inputCount: number | null = null
  let outputCount: number | null = null
  readMap(reader, (type, _subtype, value) => {
    if (type === GLOBAL_INPUT_COUNT) inputCount = new Reader(value).compactSize()
    if (type === GLOBAL_OUTPUT_COUNT) outputCount = new Reader(value).compactSize()
  })
  if (inputCount === null || outputCount === null) throw new Error('not a version 2 PSET')

  const inputs: PsetInputFields[] = []
  for (let index = 0; index < inputCount; index += 1) {
    const fields: PsetInputFields = {}
    readMap(reader, (type, subtype, value) => {
      if (type !== PROPRIETARY) return
      if (subtype === IN_ISSUANCE_VALUE) fields.issuanceValue = littleEndian(value)
      if (subtype === IN_ISSUANCE_INFLATION_KEYS) fields.issuanceInflationKeys = littleEndian(value)
      if (subtype === IN_BLINDED_ISSUANCE) fields.blindedIssuance = value[0]
    })
    inputs.push(fields)
  }

  const outputs: PsetOutputFields[] = []
  for (let index = 0; index < outputCount; index += 1) {
    const fields: PsetOutputFields = {}
    readMap(reader, (type, subtype, value) => {
      if (type !== PROPRIETARY) return
      if (subtype === OUT_VALUE_COMMITMENT) fields.valueCommitment = bytesToHex(value)
      if (subtype === OUT_ASSET_COMMITMENT) fields.assetCommitment = bytesToHex(value)
      if (subtype === OUT_BLINDING_PUBKEY) fields.blindingKey = bytesToHex(value)
      if (subtype === OUT_ECDH_PUBKEY) fields.ecdhPubkey = bytesToHex(value)
      if (subtype === OUT_BLINDER_INDEX) fields.blinderIndex = Number(littleEndian(value))
    })
    outputs.push(fields)
  }
  return { inputs, outputs }
}
