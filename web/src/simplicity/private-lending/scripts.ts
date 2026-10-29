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
} from '@lilbonekit/lwk-web'

import { buildAssetAuthArguments } from '@/simplicity/asset-auth/arguments'
import { buildScriptAuthArguments } from '@/simplicity/script-auth/arguments'
import { buildCovenantSpendInfo, UNSPENDABLE_TAPROOT_PUBKEY } from '@/simplicity/taproot'
import { hexToBytes } from '@/utils/hex'
import { toBytes32, toUint32, toUint64 } from '@/utils/uint'
import type { ContractArguments } from '@/wasm/private-lending/private_lending_wasm'

// Output indexes of the creation transaction (private-lending-core `creation`).
const LENDER_NFT_OUTPUT_INDEX = 1
const PENDING_OFFER_OUTPUT_INDEX = 3

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
  loanExpirationTime: number
}

export interface PrivateOfferScripts {
  pendingOffer: Script
  activeOffer: Script
  lenderNftLock: Script
  principalOutputScriptHash: string
  repaymentOutputScriptHash: string
  pendingSpendInfo: StateTaprootSpendInfo
  activeSpendInfo: StateTaprootSpendInfo
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
    loanExpirationTime: args.loanExpirationTime,
  }
}

function scriptHash(program: SimplicityProgram): string {
  return buildCovenantSpendInfo(program).scriptPubkey.jet_sha256_hex()
}

function u256(hex: string): SimplicityTypedValue {
  return SimplicityTypedValue.fromU256Hex(hex)
}

function storageSpendInfo(
  program: SimplicityProgram,
  isActive: boolean,
  repaymentCommitment: string,
): StateTaprootSpendInfo {
  const isActiveSlot = new Uint8Array(32)
  isActiveSlot[31] = isActive ? 1 : 0

  return new StateTaprootBuilder()
    .addSimplicityLeaf(2, program.cmr)
    .addDataLeaf(2, isActiveSlot)
    .addDataLeaf(1, hexToBytes(repaymentCommitment))
    .finalize(XOnlyPublicKey.fromString(UNSPENDABLE_TAPROOT_PUBKEY))
}

export function privateOfferScripts(
  sources: PrivateLendingSources,
  args: PrivateOfferArguments,
  network: Network,
): PrivateOfferScripts {
  const loadAssetAuth = (assetId: string, withAssetBurn: boolean) =>
    SimplicityProgram.load(
      sources.assetAuth,
      buildAssetAuthArguments({
        assetId: toBytes32(hexToBytes(assetId), 'assetId'),
        assetAmount: toUint64(1n),
        withAssetBurn,
      }),
    )

  const principalOutputScriptHash = scriptHash(loadAssetAuth(args.borrowerNftAssetId, false))
  const repaymentOutputScriptHash = scriptHash(loadAssetAuth(args.lenderNftAssetId, true))

  const program = SimplicityProgram.load(
    sources.privateLending,
    new SimplicityArguments()
      .addValue('BORROWER_NFT_ASSET_ID', u256(args.borrowerNftAssetId))
      .addValue('LENDER_NFT_ASSET_ID', u256(args.lenderNftAssetId))
      .addValue('PENDING_COLLATERAL_COMMITMENT', u256(args.pendingCollateralCommitment))
      .addValue('ACTIVE_COLLATERAL_COMMITMENT', u256(args.activeCollateralCommitment))
      .addValue('PRINCIPAL_COMMITMENT', u256(args.principalCommitment))
      .addValue('REPAYMENT_COMMITMENT', u256(args.repaymentCommitment))
      .addValue(
        'LOAN_EXPIRATION_TIME',
        SimplicityTypedValue.fromU32(toUint32(args.loanExpirationTime, 'loanExpirationTime')),
      )
      .addValue('PRINCIPAL_OUTPUT_SCRIPT_HASH', u256(principalOutputScriptHash))
      .addValue('REPAYMENT_OUTPUT_SCRIPT_HASH', u256(repaymentOutputScriptHash)),
  )

  const pendingSpendInfo = storageSpendInfo(program, false, args.repaymentCommitment)
  const activeSpendInfo = storageSpendInfo(program, true, args.repaymentCommitment)

  const pendingOffer = pendingSpendInfo.scriptPubkey
  const lenderNftLock = SimplicityProgram.load(
    sources.scriptAuth,
    buildScriptAuthArguments(
      toBytes32(hexToBytes(pendingOffer.jet_sha256_hex()), 'pendingOfferScriptHash'),
    ),
  )
    .createP2trAddress(XOnlyPublicKey.fromString(UNSPENDABLE_TAPROOT_PUBKEY), network)
    .scriptPubkey()

  return {
    pendingOffer,
    activeOffer: activeSpendInfo.scriptPubkey,
    lenderNftLock,
    principalOutputScriptHash,
    repaymentOutputScriptHash,
    pendingSpendInfo,
    activeSpendInfo,
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
  const pending = outputs[PENDING_OFFER_OUTPUT_INDEX]
  const lenderNft = outputs[LENDER_NFT_OUTPUT_INDEX]
  if (!pending || !lenderNft) return false
  return (
    sameScript(pending.scriptPubkey(), scripts.pendingOffer) &&
    sameScript(lenderNft.scriptPubkey(), scripts.lenderNftLock)
  )
}
