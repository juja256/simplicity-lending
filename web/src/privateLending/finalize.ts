// Finalizing the Simplicity inputs of private offer transactions: the offer itself, the lender
// NFT at its script_auth lock, and the asset_auth outputs (principal, repayment). Each wraps
// LWK's `finalizeTransactionWithSpendInfo`, which runs the program on the transaction and fails
// if the covenant does not hold.
//
// `prevouts` are the outputs every input of `tx` spends, in input order. LWK consumes them: pass
// a fresh array (fresh `TxOut` objects, e.g. from `tx.outputs`, which copies) to every call.
import type { Script, SimplicityProgram, Transaction, TxOut } from '@lilbonekit/lwk-web'

import { buildAssetAuthWitness } from '@/simplicity/asset-auth/witness'
import {
  lenderNftLockProgram,
  privateAssetAuthProgram,
  toPrivateOfferArguments,
} from '@/simplicity/private-lending/scripts'
import {
  buildPrivateLendingWitness,
  PRIVATE_LENDING_BRANCH_SPENDS_ACTIVE,
  type PrivateLendingBranch,
} from '@/simplicity/private-lending/witness'
import { buildScriptAuthWitness } from '@/simplicity/script-auth/witness'
import { buildCovenantSpendInfo } from '@/simplicity/taproot'
import { toUint32 } from '@/utils/uint'

import type { PrivateFlowDeps } from './deps'
import { wasmStep } from './flows/shared'
import type { VerifiedOffer } from './verify'

/** The two asset_auth outputs of an offer. */
export type PinnedAuthOutput = 'principal' | 'repayment'

function sameScript(a: Script, b: Script): boolean {
  return a.toString() === b.toString()
}

/**
 * The asset_auth program of the offer's principal output (borrower NFT, no burn) or repayment
 * output (lender NFT, burned), and its script. The script is checked against the hash the offer's
 * contract pins, so a builder can never pay or spend another script.
 */
export function pinnedAuthCovenant(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  output: PinnedAuthOutput,
): { program: SimplicityProgram; script: Script } {
  const args = toPrivateOfferArguments(offer.opened.contractArguments())
  const program =
    output === 'principal'
      ? privateAssetAuthProgram(deps.sources, args.borrowerNftAssetId, false)
      : privateAssetAuthProgram(deps.sources, args.lenderNftAssetId, true)
  const script = buildCovenantSpendInfo(program).scriptPubkey
  const pinnedHash =
    output === 'principal'
      ? offer.scripts.principalOutputScriptHash
      : offer.scripts.repaymentOutputScriptHash
  if (script.jet_sha256_hex() !== pinnedHash) {
    throw new Error(`The ${output} asset_auth script is not the one the offer's contract pins`)
  }
  return { program, script }
}

/**
 * Finalizes the offer's input `inputIndex` on `branch`: the pending offer (acceptance,
 * cancellation) or the active one (repayment, liquidation), as `active` says.
 */
export function finalizePrivateOfferInput(
  deps: PrivateFlowDeps,
  tx: Transaction,
  offer: VerifiedOffer,
  active: boolean,
  prevouts: TxOut[],
  inputIndex: number,
  branch: PrivateLendingBranch,
): Transaction {
  if (PRIVATE_LENDING_BRANCH_SPENDS_ACTIVE[branch] !== active) {
    throw new Error(`${branch} spends the ${active ? 'pending' : 'active'} offer`)
  }
  const spendInfo = active ? offer.scripts.activeSpendInfo : offer.scripts.pendingSpendInfo
  return wasmStep(`Finalizing the offer input ${inputIndex} (${branch})`, () =>
    offer.scripts.program.finalizeTransactionWithSpendInfo(
      tx,
      spendInfo,
      prevouts,
      inputIndex,
      buildPrivateLendingWitness(branch),
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
    program.finalizeTransactionWithSpendInfo(
      tx,
      spendInfo,
      prevouts,
      inputIndex,
      buildScriptAuthWitness(toUint32(offerInputIndex, 'offerInputIndex')),
      deps.network,
      deps.lwk.SimplicityLogLevel.None,
    ),
  )
}

/**
 * Finalizes the offer's principal or repayment output, spent at `inputIndex` with its NFT at
 * input `nft.inputIndex` going to output `nft.outputIndex` (burned there for the repayment).
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
    program.finalizeTransactionWithSpendInfo(
      tx,
      buildCovenantSpendInfo(program),
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
