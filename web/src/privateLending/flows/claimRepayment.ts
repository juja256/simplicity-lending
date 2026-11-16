// The lender's claim of the repayment that a full repayment locked to its lender NFT
// (asset_auth(lender NFT, 1, burn)):
//   inputs   0 the repayment output (asset_auth), 1 the lender NFT, 2… fee coins;
//   outputs  0 burns the lender NFT (OP_RETURN, explicit), 1 the repayment to the lender, blinded
//            to its wallet; change and fee follow.
// The lender NFT is an explicit output at a wallet address (the acceptance's output 2). LWK lists
// only blinded coins as the wallet's, so it is spent as a plain input, not a wallet coin; LWK still
// recognizes its script, so the wallet signs and finalizes it.
import type { Address, WalletTxOut } from 'lwk_wasm'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'
import {
  ACCEPTANCE_INPUT,
  ACCEPTANCE_OUTPUT,
  CREATION_OUTPUT,
  NFT_AMOUNT,
  REPAYMENT_CLAIM_INPUT,
  REPAYMENT_CLAIM_OUTPUT,
  REPAYMENT_INPUT,
  REPAYMENT_OUTPUT,
} from '@/simplicity/private-lending/layout'

import type { PrivateFlowDeps } from '../deps'
import { finalizeAssetAuthInput, pinnedAuthCovenant } from '../finalize'
import { walletInputSecret } from '../secrets'
import type { VerifiedOffer } from '../verify'
import {
  assertAllInputsFinalized,
  assertSpendLayout,
  buildUnblindedPset,
  burnScript,
  fetchPrevoutTxs,
  outpointOf,
  parseOutpoint,
  pinnedTxOutSecrets,
  prevoutsOf,
  requireOutput,
  type SpendLayout,
  walletCoinInput,
  wasmStep,
} from './shared'

export interface RepaymentClaimParams {
  /**
   * The full repayment's repayment output, `"<repayment txid>:1"`. The builder checks that the
   * transaction spends this offer's active offer at input 1, the active offer being output 0 of
   * the transaction that spends this offer's pending offer at input 0: only the full repayment
   * spends the active offer there, and its covenant pinned this output to the repayment.
   */
  repaymentOutpoint: string
  /** The lender NFT: an explicit output at a wallet address, `"<acceptance txid>:2"`. */
  lenderNftOutpoint: string
  /** The lender's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /** A confidential wallet address: receives the repayment, blinded to it. */
  receiver: Address
}

export interface RepaymentClaimSummary {
  /** The claimed repayment in the wallet, `"<txid>:1"`. */
  repaymentOutpoint: string
  repayment: bigint
}

/**
 * Builds the lender's claim of the repayment of a repaid offer, blinded and ready to sign.
 * `finalize` finalizes the wallet inputs (the lender NFT among them), then the repayment's
 * asset_auth, running it on the transaction.
 */
export async function buildRepaymentClaim(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  params: RepaymentClaimParams,
): Promise<UpdatedPset<RepaymentClaimSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'lender') throw new Error('Only the lender claims the repayment')
  const opened = offer.opened
  const lenderNft = opened.lenderNft()

  // 1. The inputs.
  const repaymentRef = parseOutpoint(params.repaymentOutpoint)
  const nftRef = parseOutpoint(params.lenderNftOutpoint)
  const repaymentInput = `${repaymentRef.txid}:${repaymentRef.vout}`
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  if (params.feeCoins.length === 0) throw new Error('A repayment claim needs a fee coin')
  for (const coin of params.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }
  const feeInputs = params.feeCoins.map(outpointOf)
  const inputs = [repaymentInput, nftInput, ...feeInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error('The repayment, the lender NFT and the fee coins must be distinct')
  }
  if (!params.receiver.isBlinded()) {
    throw new Error('The repayment must go to a confidential address')
  }

  // 2. The repayment, tied to this offer through its active offer, and the lender NFT.
  const [repaymentTx, nftTx] = await Promise.all([
    deps.fetchTx(repaymentRef.txid),
    deps.fetchTx(nftRef.txid),
  ])
  // The active offer is spent at input 1 only by the full repayment (a liquidation spends it at
  // input 0), whose covenant pins output 1 to the repayment at the repayment asset_auth.
  const spentOffer = repaymentTx.inputs[REPAYMENT_INPUT.offer]?.outpoint()
  if (
    repaymentRef.vout !== REPAYMENT_OUTPUT.repayment ||
    spentOffer === undefined ||
    spentOffer.vout() !== ACCEPTANCE_OUTPUT.activeOffer
  ) {
    throw new Error('The repayment outpoint is not output 1 of a full repayment')
  }
  // Only this offer's acceptance or cancellation spends its pending offer, at input 0, and a
  // cancellation's output 0 is a burn, which nothing spends.
  const acceptanceTx = await deps.fetchTx(spentOffer.txid().toString())
  const pendingOffer = `${offer.creationTx.txid().toString()}:${CREATION_OUTPUT.pendingOffer}`
  const acceptanceOffer = acceptanceTx.inputs[ACCEPTANCE_INPUT.offer]?.outpoint()
  if (
    acceptanceOffer === undefined ||
    `${acceptanceOffer.txid().toString()}:${acceptanceOffer.vout()}` !== pendingOffer
  ) {
    throw new Error("The repayment outpoint does not repay this offer's active offer")
  }
  const principalAuth = pinnedAuthCovenant(deps, offer, 'principal')
  const repaymentAuth = pinnedAuthCovenant(deps, offer, 'repayment')
  const repaymentOutput = requireOutput(repaymentTx, repaymentRef.vout, 'The repayment')
  if (repaymentOutput.scriptPubkey().toString() !== repaymentAuth.script.toString()) {
    throw new Error("The repayment outpoint is not locked to the offer's repayment asset_auth")
  }
  const nftOutput = requireOutput(nftTx, nftRef.vout, 'The lender NFT')
  if (nftOutput.asset()?.toString() !== lenderNft || nftOutput.value() !== NFT_AMOUNT) {
    throw new Error('The lender NFT outpoint does not hold exactly the lender NFT, explicit')
  }
  const repayment = opened.pinned(wasm.PinnedRole.Repayment)
  if (
    repayment.asset !== opened.principalAsset() ||
    repayment.amount !== opened.repaymentAmount()
  ) {
    throw new Error('The pinned repayment does not carry the offer terms')
  }

  // 3. The outputs.
  const burn = burnScript(deps)
  const repaymentReceiver = lwk.Address.parse(params.receiver.toString(), deps.network)
  const layout: SpendLayout = {
    inputs,
    outputs: [
      {
        script: burn.toString(),
        asset: lenderNft,
        amount: NFT_AMOUNT,
        blinding: { kind: 'explicit' },
      },
      {
        script: repaymentReceiver.scriptPubkey().toString(),
        asset: repayment.asset,
        amount: repayment.amount,
        blinding: { kind: 'fresh', receiver: repaymentReceiver },
      },
    ],
    restrictedAssets: [opened.borrowerNft(), lenderNft],
    restrictedScripts: [
      offer.scripts.pendingOffer.toString(),
      offer.scripts.activeOffer.toString(),
      offer.scripts.lenderNftLock.toString(),
      principalAuth.script.toString(),
      repaymentAuth.script.toString(),
    ],
    policyAsset: deps.assets.policy,
  }

  // The transactions of the fee coins: finalization needs every prevout.
  const feePrevoutTxs = await fetchPrevoutTxs(deps, feeInputs)

  // 4. The unblinded PSET: the inputs and the leading outputs in layout order.
  const feePrevouts = prevoutsOf(feePrevoutTxs, feeInputs)
  const unblinded = buildUnblindedPset(deps, {
    inputs: [
      {
        outpoint: new lwk.OutPoint(repaymentInput),
        prevout: requireOutput(repaymentTx, repaymentRef.vout, 'The repayment'),
        asset: lwk.AssetId.fromString(repayment.asset),
        amount: repayment.amount,
        secrets: pinnedTxOutSecrets(deps, repayment),
        maxWeightToSatisfy: ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY,
      },
      {
        outpoint: new lwk.OutPoint(nftInput),
        prevout: requireOutput(nftTx, nftRef.vout, 'The lender NFT'),
        asset: lwk.AssetId.fromString(lenderNft),
        amount: NFT_AMOUNT,
        secrets: lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(lenderNft), NFT_AMOUNT),
        maxWeightToSatisfy: EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
      },
      ...params.feeCoins.map((coin, index) => walletCoinInput(deps, coin, feePrevouts[index])),
    ],
    outputs: [
      { script: burn, amount: NFT_AMOUNT, asset: lwk.AssetId.fromString(lenderNft) },
      {
        script: repaymentReceiver.scriptPubkey(),
        amount: repayment.amount,
        asset: lwk.AssetId.fromString(repayment.asset),
        blindingPubkey: repaymentReceiver.blindingPubkey(),
      },
    ],
    changeAddress: deps.addresses.nextChange(deps.wollet, 1)[0],
  })

  // 5. The layout of the unblinded PSET.
  assertSpendLayout(deps, unblinded, layout, false, 'Repayment claim')

  // 6. Blinding: the repayment input's secrets are the pinned ones; every output is fresh.
  const blindedBase64 = wasmStep('Blinding the repayment claim', () =>
    wasm.blindPset(
      unblinded.toString(),
      [
        opened.inputSecret(wasm.PinnedRole.Repayment, REPAYMENT_CLAIM_INPUT.repayment),
        wasm.InputSecret.explicit(REPAYMENT_CLAIM_INPUT.lenderNft, lenderNft, NFT_AMOUNT),
        ...params.feeCoins.map((coin, index) =>
          walletInputSecret(deps, coin, REPAYMENT_CLAIM_INPUT.lenderNft + 1 + index),
        ),
      ],
      [],
    ),
  )
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, 'Repayment claim')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(repaymentTx, repaymentRef.vout, 'The repayment'),
    requireOutput(nftTx, nftRef.vout, 'The lender NFT'),
    ...prevoutsOf(feePrevoutTxs, feeInputs),
  ]

  // 8. Sign (by the caller), then finalize the wallet inputs and the asset_auth.
  return {
    pset: blinded,
    finalize: signedPset => {
      const signed = deps.wollet.finalize(signedPset).extractTx()
      if (signed.txid().toString() !== builtTxid) {
        throw new Error('The signed repayment claim is not the transaction that was built')
      }
      const finalizedTx = finalizeAssetAuthInput(
        deps,
        signed,
        offer,
        'repayment',
        prevouts(),
        REPAYMENT_CLAIM_INPUT.repayment,
        {
          inputIndex: REPAYMENT_CLAIM_INPUT.lenderNft,
          outputIndex: REPAYMENT_CLAIM_OUTPUT.lenderNftBurn,
        },
      )
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) throw new Error('Finalizing changed the repayment claim')
      assertAllInputsFinalized(finalizedTx, 'The repayment claim')

      return {
        finalizedTx,
        summary: {
          repaymentOutpoint: `${txid}:${REPAYMENT_CLAIM_OUTPUT.repayment}`,
          repayment: repayment.amount,
        },
      }
    },
  }
}
