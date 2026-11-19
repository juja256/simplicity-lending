// Finalizing the Simplicity inputs of private offer transactions: the offer itself, the lender
// NFT at its script_auth lock, and the asset_auth outputs (principal, repayment, installments).
// Each wraps LWK's `finalizeTransaction`, which runs the program on the transaction and fails if
// the covenant does not hold. The control block is that of the program's leaf in its spend info.
//
// `prevouts` are the outputs every input of `tx` spends, in input order. LWK consumes them: pass
// a fresh array (fresh `TxOut` objects, e.g. from `tx.outputs`, which copies) to every call.
import type { Script, SimplicityProgram, StateTaprootSpendInfo, Transaction, TxOut } from 'lwk_wasm'

import { buildAssetAuthWitness } from '@/simplicity/asset-auth/witness'
import {
  lenderNftLockProgram,
  privateAssetAuthProgram,
  toPrivateOfferArguments,
} from '@/simplicity/private-lending/scripts'
import {
  buildPrivateLendingWitness,
  PRIVATE_LENDING_BRANCH_SPENDS_ACTIVE,
  type PrivateLendingWitness,
} from '@/simplicity/private-lending/witness'
import { buildScriptAuthWitness } from '@/simplicity/script-auth/witness'
import { buildCovenantSpendInfo } from '@/simplicity/taproot'
import { toUint32 } from '@/utils/uint'

import type { PrivateFlowDeps } from './deps'
import { wasmStep } from './flows/shared'
import type { VerifiedOffer } from './verify'

/** The asset_auth outputs of an offer. */
export type PinnedAuthOutput = 'principal' | 'repayment' | 'installment'

function sameScript(a: Script, b: Script): boolean {
  return a.toString() === b.toString()
}

/**
 * The asset_auth program of the offer's principal output (borrower NFT, no burn), repayment output
 * (lender NFT, burned) or installments (lender NFT, no burn), and its script. The script is checked
 * against the hash the offer's contract pins, so a builder can never pay or spend another script.
 */
export function pinnedAuthCovenant(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  output: PinnedAuthOutput,
): { program: SimplicityProgram; script: Script } {
  const args = toPrivateOfferArguments(offer.opened.contractArguments())
  const [program, pinnedHash] = {
    principal: () =>
      [
        privateAssetAuthProgram(deps.sources, args.borrowerNftAssetId, false),
        offer.scripts.principalOutputScriptHash,
      ] as const,
    repayment: () =>
      [
        privateAssetAuthProgram(deps.sources, args.lenderNftAssetId, true),
        offer.scripts.repaymentOutputScriptHash,
      ] as const,
    installment: () =>
      [
        privateAssetAuthProgram(deps.sources, args.lenderNftAssetId, false),
        offer.scripts.installmentOutputScriptHash,
      ] as const,
  }[output]()
  const script = buildCovenantSpendInfo(program).scriptPubkey
  if (script.jet_sha256_hex() !== pinnedHash) {
    throw new Error(`The ${output} asset_auth script is not the one the offer's contract pins`)
  }
  return { program, script }
}

/**
 * Finalizes the offer's input `inputIndex` with `witness`. `spendInfo` is that of the output the
 * input spends: the pending offer (`pendingSpendInfo`, acceptance and cancellation) or the loan
 * output at its debt hash (`activeSpendInfoAt(debtHash)`, the installment, the full repayment, the
 * zero-debt close and the liquidation). It must give the script of the input's prevout.
 */
export function finalizePrivateOfferInput(
  deps: PrivateFlowDeps,
  tx: Transaction,
  offer: VerifiedOffer,
  spendInfo: StateTaprootSpendInfo,
  prevouts: TxOut[],
  inputIndex: number,
  witness: PrivateLendingWitness,
): Transaction {
  const { branch } = witness
  const spendsPending = sameScript(spendInfo.scriptPubkey, offer.scripts.pendingOffer)
  if (PRIVATE_LENDING_BRANCH_SPENDS_ACTIVE[branch] === spendsPending) {
    throw new Error(`${branch} spends the ${spendsPending ? 'active' : 'pending'} offer`)
  }
  const prevout = prevouts[inputIndex]
  if (prevout === undefined || !sameScript(prevout.scriptPubkey(), spendInfo.scriptPubkey)) {
    throw new Error(`The offer input ${inputIndex} is not locked to the script of its spend info`)
  }
  const { program } = offer.scripts
  return wasmStep(`Finalizing the offer input ${inputIndex} (${branch})`, () =>
    program.finalizeTransaction(
      tx,
      spendInfo.controlBlock(program.cmr),
      prevouts,
      inputIndex,
      buildPrivateLendingWitness(witness),
      deps.network,
      deps.lwk.SimplicityLogLevel.None,
    ),
  )
}

/**
 * Finalizes the lender NFT's script_auth lock at `inputIndex`, which requires the pending offer
 * at `offerInputIndex` to be spent by the same transaction.
 */
export function finalizeScriptAuthInput(
  deps: PrivateFlowDeps,
  tx: Transaction,
  offer: VerifiedOffer,
  prevouts: TxOut[],
  inputIndex: number,
  offerInputIndex: number,
): Transaction {
  const program = lenderNftLockProgram(deps.sources, offer.scripts.pendingOffer)
  const spendInfo = buildCovenantSpendInfo(program)
  if (!sameScript(spendInfo.scriptPubkey, offer.scripts.lenderNftLock)) {
    throw new Error("The script_auth program does not give the offer's lender NFT lock")
  }
  return wasmStep(`Finalizing the lender NFT lock input ${inputIndex} (script_auth)`, () =>
    program.finalizeTransaction(
      tx,
      spendInfo.controlBlock(program.cmr),
      prevouts,
      inputIndex,
      buildScriptAuthWitness(toUint32(offerInputIndex, 'offerInputIndex')),
      deps.network,
      deps.lwk.SimplicityLogLevel.None,
    ),
  )
}

/**
 * Finalizes the offer's principal, repayment or installment output, spent at `inputIndex` with its
 * NFT at input `nft.inputIndex` going to output `nft.outputIndex` (burned there for the repayment).
 */
export function finalizeAssetAuthInput(
  deps: PrivateFlowDeps,
  tx: Transaction,
  offer: VerifiedOffer,
  output: PinnedAuthOutput,
  prevouts: TxOut[],
  inputIndex: number,
  nft: { inputIndex: number; outputIndex: number },
): Transaction {
  const { program } = pinnedAuthCovenant(deps, offer, output)
  return wasmStep(`Finalizing the ${output} input ${inputIndex} (asset_auth)`, () =>
    program.finalizeTransaction(
      tx,
      buildCovenantSpendInfo(program).controlBlock(program.cmr),
      prevouts,
      inputIndex,
      buildAssetAuthWitness({
        inputAssetIndex: toUint32(nft.inputIndex, 'nftInputIndex'),
        outputAssetIndex: toUint32(nft.outputIndex, 'nftOutputIndex'),
      }),
      deps.network,
      deps.lwk.SimplicityLogLevel.None,
    ),
  )
}
