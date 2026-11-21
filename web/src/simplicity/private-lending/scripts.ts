// Pure: takes the contract sources as input, so it never imports `virtual:simplicity-sources`
// and can run in Node (the parity check) as well as in the browser.
import {
  type Network,
  type Script,
  SimplicityArguments,
  SimplicityProgram,
  SimplicityTypedValue,
  StateTaprootBuilder,
  type StateTaprootSpendInfo,
  type Transaction,
  XOnlyPublicKey,
} from 'lwk_wasm'

import { buildAssetAuthArguments } from '@/simplicity/asset-auth/arguments'
import { buildScriptAuthArguments } from '@/simplicity/script-auth/arguments'
import { buildCovenantSpendInfo, UNSPENDABLE_TAPROOT_PUBKEY } from '@/simplicity/taproot'
import { hexToBytes, isHexStringOfByteLength } from '@/utils/hex'
import { toBytes32, toUint64 } from '@/utils/uint'
import type { ContractArguments } from '@/wasm/private-lending/private_lending_wasm'

import { CREATION_OUTPUT, NFT_AMOUNT } from './layout'

export interface PrivateLendingSources {
  privateLending: string
  assetAuth: string
  scriptAuth: string
}

export interface PrivateOfferArguments {
  borrowerNftAssetId: string
  lenderNftAssetId: string
  pendingCollateralCommitment: string
  activeCollateralCommitment: string
  principalCommitment: string
  repaymentCommitment: string
  /** The SHA-256 of the expiry salt and the expiry: the program never takes the expiry itself. */
  expiryHash: string
  /**
   * `A`, the pinned repayment's asset commitment, which every installment and repayment carries:
   * the low bit of its prefix (0 or 1, 1 exactly when its `y` is not a square) and its x-coordinate
   * (32 bytes, hex).
   */
  repaymentAssetPrefixBit: number
  repaymentAssetX: string
}

export interface PrivateOfferScripts {
  pendingOffer: Script
  /** The loan at acceptance, whose debt hash is the repayment commitment: `activeOfferAt` of it. */
  activeOffer: Script
  lenderNftLock: Script
  principalOutputScriptHash: string
  repaymentOutputScriptHash: string
  installmentOutputScriptHash: string
  pendingSpendInfo: StateTaprootSpendInfo
  activeSpendInfo: StateTaprootSpendInfo
  /**
   * The loan whose storage holds the debt hash `debtHash` (32 bytes, hex), `h(A, D)`: after
   * installments, `LoanState.debtHashAt(j)` of loan output `j`. Throws on a malformed hash.
   */
  activeOfferAt(debtHash: string): Script
  activeSpendInfoAt(debtHash: string): StateTaprootSpendInfo
  program: SimplicityProgram
}

export function toPrivateOfferArguments(args: ContractArguments): PrivateOfferArguments {
  return {
    borrowerNftAssetId: args.borrowerNftAssetId,
    lenderNftAssetId: args.lenderNftAssetId,
    pendingCollateralCommitment: args.pendingCollateralCommitment,
    activeCollateralCommitment: args.activeCollateralCommitment,
    principalCommitment: args.principalCommitment,
    repaymentCommitment: args.repaymentCommitment,
    expiryHash: args.expiryHash,
    repaymentAssetPrefixBit: args.repaymentAssetPrefixBit,
    repaymentAssetX: args.repaymentAssetX,
  }
}

// With debug symbols, as the Rust contracts compile them: simplex calls simplicityhl's
// `CompiledProgram::new` with them, and they change the CMR, so without them the offer scripts
// would differ from Rust's. Upstream's public programs load the same way.
function loadProgram(source: string, args: SimplicityArguments): SimplicityProgram {
  return SimplicityProgram.loadWithDebugSymbols(source, args, true)
}

function scriptHash(program: SimplicityProgram): string {
  return buildCovenantSpendInfo(program).scriptPubkey.jet_sha256_hex()
}

function u256(hex: string): SimplicityTypedValue {
  return SimplicityTypedValue.fromU256Hex(hex)
}

/**
 * A commitment as the program takes it, `(bool, u256)`: whether the low bit of its prefix is set,
 * and x. The program converts the bool to the `u1` of Elements' encoding.
 */
function commitment(prefixBit: number, x: string): SimplicityTypedValue {
  if (prefixBit !== 0 && prefixBit !== 1) throw new Error('A prefix bit is 0 or 1')
  return SimplicityTypedValue.fromElements([
    SimplicityTypedValue.fromBoolean(prefixBit === 1),
    u256(x),
  ])
}

/** The program's storage: whether the offer is active, and the debt hash, `h(A, D)`. */
function storageSpendInfo(
  program: SimplicityProgram,
  isActive: boolean,
  debtHash: string,
): StateTaprootSpendInfo {
  if (!isHexStringOfByteLength(debtHash, 32)) throw new Error('A debt hash is 32 bytes of hex')
  const isActiveSlot = new Uint8Array(32)
  isActiveSlot[31] = isActive ? 1 : 0

  return new StateTaprootBuilder()
    .addSimplicityLeaf(2, program.cmr)
    .addDataLeaf(2, isActiveSlot)
    .addDataLeaf(1, hexToBytes(debtHash))
    .finalize(XOnlyPublicKey.fromString(UNSPENDABLE_TAPROOT_PUBKEY))
}

/**
 * The asset_auth program that locks a pinned output to one unit of an NFT: the principal
 * (borrower NFT, no burn), the repayment (lender NFT, burned) or an installment (lender NFT, no
 * burn). `nftAssetId` is in the internal byte order of `ContractArguments`.
 */
export function privateAssetAuthProgram(
  sources: PrivateLendingSources,
  nftAssetId: string,
  withAssetBurn: boolean,
): SimplicityProgram {
  return loadProgram(
    sources.assetAuth,
    buildAssetAuthArguments({
      assetId: toBytes32(hexToBytes(nftAssetId), 'assetId'),
      assetAmount: toUint64(NFT_AMOUNT),
      withAssetBurn,
    }),
  )
}

/** The script_auth program that locks the lender NFT to the pending offer's script. */
export function lenderNftLockProgram(
  sources: PrivateLendingSources,
  pendingOffer: Script,
): SimplicityProgram {
  return loadProgram(
    sources.scriptAuth,
    buildScriptAuthArguments(
      toBytes32(hexToBytes(pendingOffer.jet_sha256_hex()), 'pendingOfferScriptHash'),
    ),
  )
}

export function privateOfferScripts(
  sources: PrivateLendingSources,
  args: PrivateOfferArguments,
  network: Network,
): PrivateOfferScripts {
  const principalOutputScriptHash = scriptHash(
    privateAssetAuthProgram(sources, args.borrowerNftAssetId, false),
  )
  const repaymentOutputScriptHash = scriptHash(
    privateAssetAuthProgram(sources, args.lenderNftAssetId, true),
  )
  const installmentOutputScriptHash = scriptHash(
    privateAssetAuthProgram(sources, args.lenderNftAssetId, false),
  )

  const program = loadProgram(
    sources.privateLending,
    new SimplicityArguments()
      .addValue('BORROWER_NFT_ASSET_ID', u256(args.borrowerNftAssetId))
      .addValue('LENDER_NFT_ASSET_ID', u256(args.lenderNftAssetId))
      .addValue('PENDING_COLLATERAL_COMMITMENT', u256(args.pendingCollateralCommitment))
      .addValue('ACTIVE_COLLATERAL_COMMITMENT', u256(args.activeCollateralCommitment))
      .addValue('PRINCIPAL_COMMITMENT', u256(args.principalCommitment))
      .addValue('REPAYMENT_COMMITMENT', u256(args.repaymentCommitment))
      .addValue('EXPIRY_HASH', u256(args.expiryHash))
      .addValue('REPAYMENT_ASSET', commitment(args.repaymentAssetPrefixBit, args.repaymentAssetX))
      .addValue('PRINCIPAL_OUTPUT_SCRIPT_HASH', u256(principalOutputScriptHash))
      .addValue('REPAYMENT_OUTPUT_SCRIPT_HASH', u256(repaymentOutputScriptHash))
      .addValue('INSTALLMENT_OUTPUT_SCRIPT_HASH', u256(installmentOutputScriptHash)),
  )

  // Until the first installment, the debt is the pinned repayment.
  const pendingSpendInfo = storageSpendInfo(program, false, args.repaymentCommitment)
  const activeSpendInfoAt = (debtHash: string) => storageSpendInfo(program, true, debtHash)
  const activeSpendInfo = activeSpendInfoAt(args.repaymentCommitment)

  const pendingOffer = pendingSpendInfo.scriptPubkey
  const lenderNftLock = lenderNftLockProgram(sources, pendingOffer)
    .createP2trAddress(XOnlyPublicKey.fromString(UNSPENDABLE_TAPROOT_PUBKEY), network)
    .scriptPubkey()

  return {
    pendingOffer,
    activeOffer: activeSpendInfo.scriptPubkey,
    lenderNftLock,
    principalOutputScriptHash,
    repaymentOutputScriptHash,
    installmentOutputScriptHash,
    pendingSpendInfo,
    activeSpendInfo,
    activeOfferAt: debtHash => activeSpendInfoAt(debtHash).scriptPubkey,
    activeSpendInfoAt,
    program,
  }
}

function sameScript(a: Script, b: Script): boolean {
  const left = a.bytes()
  const right = b.bytes()
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

/** Whether the creation transaction pays the pending offer and the lender NFT to these scripts. */
export function verifyOfferAddresses(
  scripts: PrivateOfferScripts,
  creationTx: Transaction,
): boolean {
  const outputs = creationTx.outputs
  const pending = outputs[CREATION_OUTPUT.pendingOffer]
  const lenderNft = outputs[CREATION_OUTPUT.lenderNft]
  if (!pending || !lenderNft) return false
  return (
    sameScript(pending.scriptPubkey(), scripts.pendingOffer) &&
    sameScript(lenderNft.scriptPubkey(), scripts.lenderNftLock)
  )
}
