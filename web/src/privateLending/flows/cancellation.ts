// The borrower's cancellation of a pending private offer (`attach_cancellation` in the contracts'
// private lending core):
//   inputs   0 the pending offer (OfferCancellation branch), 1 the lender NFT at its script_auth
//            lock, 2 the borrower NFT, explicit; 3… the borrower's fee coins;
//   outputs  0 burns the lender NFT and 1 the borrower NFT (OP_RETURN, explicit); 2 the
//            collateral back to the borrower, blinded to its wallet; then the policy-asset change
//            and the fee.
// The covenant checks the pending collateral at input 0 and both burns (input 1 to output 0,
// input 2 to output 1); it leaves the collateral to the spender. The script_auth lock releases the
// lender NFT to a transaction that spends the pending offer at input 0. The borrower NFT is an
// explicit output at a wallet address, which LWK does not list among the wallet's coins, so it is
// spent as an external UTXO that the wallet still signs. The collateral is paid explicitly: LWK
// would put the change of any asset but the policy asset before the burns.
import type { Address, WalletTxOut } from '@lilbonekit/lwk-web'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import {
  CANCELLATION_INPUT,
  CANCELLATION_OUTPUT,
  CREATION_OUTPUT,
  NFT_AMOUNT,
} from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import { SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/script-auth/witness'

import type { PrivateFlowDeps } from '../deps'
import { finalizePrivateOfferInput, finalizeScriptAuthInput, pinnedAuthCovenant } from '../finalize'
import { walletInputSecret } from '../secrets'
import type { VerifiedOffer } from '../verify'
import {
  assertAllInputsFinalized,
  assertSpendLayout,
  burnScript,
  fetchPrevoutTxs,
  outpointOf,
  parseOutpoint,
  pinnedTxOutSecrets,
  prevoutsOf,
  requireOutput,
  type SpendLayout,
  wasmStep,
} from './shared'

export interface CancellationParams {
  /**
   * The borrower NFT: an explicit output at a wallet address, `"<creation txid>:0"` unless the
   * borrower moved it.
   */
  borrowerNftOutpoint: string
  /** The borrower's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /** A confidential address: receives the collateral, blinded to it. */
  collateralReceiver: Address
}

export interface CancellationSummary {
  /** The collateral back to the borrower: `"<txid>:2"`. */
  collateralOutpoint: string
  collateral: bigint
}

/**
 * Builds the borrower's cancellation of a pending offer, blinded and ready to sign. `finalize`
 * finalizes the wallet inputs (the borrower NFT among them), then the offer (OfferCancellation)
 * and the lender NFT lock (script_auth), running both covenants on the transaction.
 */
export async function buildPrivateCancellation(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  params: CancellationParams,
): Promise<UpdatedPset<CancellationSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'borrower') throw new Error('Only the borrower cancels an offer')
  const opened = offer.opened
  const creationTx = offer.creationTx
  const creationTxid = creationTx.txid().toString()
  const offerInput = `${creationTxid}:${CREATION_OUTPUT.pendingOffer}`
  const lockInput = `${creationTxid}:${CREATION_OUTPUT.lenderNft}`
  const borrowerNft = opened.borrowerNft()
  const lenderNft = opened.lenderNft()

  // 1. The inputs.
  const nftRef = parseOutpoint(params.borrowerNftOutpoint)
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  if (params.feeCoins.length === 0) throw new Error('A cancellation needs a fee coin')
  for (const coin of params.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }
  const feeInputs = params.feeCoins.map(outpointOf)
  const inputs = [offerInput, lockInput, nftInput, ...feeInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error(
      'The offer, the lender NFT lock, the borrower NFT and the fee coins must differ',
    )
  }
  if (!params.collateralReceiver.isBlinded()) {
    throw new Error('The collateral must go to a confidential address')
  }

  // 2. The covenant inputs, the creation outputs the gate verified, and the borrower NFT.
  const lockOutput = requireOutput(creationTx, CREATION_OUTPUT.lenderNft, 'The lender NFT lock')
  if (lockOutput.asset()?.toString() !== lenderNft || lockOutput.value() !== NFT_AMOUNT) {
    throw new Error('The lender NFT lock does not hold exactly the lender NFT')
  }
  const pendingCollateral = opened.pinned(wasm.PinnedRole.PendingCollateral)
  if (
    pendingCollateral.asset !== opened.collateralAsset() ||
    pendingCollateral.amount !== opened.collateralAmount()
  ) {
    throw new Error('The pinned collateral does not carry the offer terms')
  }
  const nftTx = await deps.fetchTx(nftRef.txid)
  const nftOutput = requireOutput(nftTx, nftRef.vout, 'The borrower NFT')
  if (nftOutput.asset()?.toString() !== borrowerNft || nftOutput.value() !== NFT_AMOUNT) {
    throw new Error('The borrower NFT outpoint does not hold exactly the borrower NFT, explicit')
  }

  // 3. The outputs.
  const principalAuth = pinnedAuthCovenant(deps, offer, 'principal')
  const repaymentAuth = pinnedAuthCovenant(deps, offer, 'repayment')
  const burn = burnScript(deps)
  const collateralReceiver = lwk.Address.parse(params.collateralReceiver.toString(), deps.network)
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
        script: burn.toString(),
        asset: borrowerNft,
        amount: NFT_AMOUNT,
        blinding: { kind: 'explicit' },
      },
      {
        script: collateralReceiver.scriptPubkey().toString(),
        asset: pendingCollateral.asset,
        amount: pendingCollateral.amount,
        blinding: { kind: 'fresh' },
      },
    ],
    restrictedAssets: [borrowerNft, lenderNft],
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

  // 4. The unblinded PSET.
  let builder = new lwk.TxBuilder(deps.network)
  if (deps.feeRate !== null) builder = builder.feeRate(deps.feeRate)
  builder = builder
    .setWalletUtxos(feeInputs.map(outpoint => new lwk.OutPoint(outpoint)))
    .setInputOrder(inputs.map(outpoint => new lwk.OutPoint(outpoint)))
    .addExternalUtxos([
      new lwk.ExternalUtxo(
        CREATION_OUTPUT.pendingOffer,
        creationTx,
        pinnedTxOutSecrets(deps, pendingCollateral),
        PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferCancellation,
        true,
      ),
      new lwk.ExternalUtxo(
        CREATION_OUTPUT.lenderNft,
        creationTx,
        lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(lenderNft), NFT_AMOUNT),
        SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY,
        true,
      ),
      new lwk.ExternalUtxo(
        nftRef.vout,
        nftTx,
        lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(borrowerNft), NFT_AMOUNT),
        EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
        true,
      ),
    ])
    .addPostIssuanceScriptOutput(burn, NFT_AMOUNT, lwk.AssetId.fromString(lenderNft))
    .addPostIssuanceScriptOutput(burn, NFT_AMOUNT, lwk.AssetId.fromString(borrowerNft))
    .addPostIssuanceRecipient(
      collateralReceiver,
      pendingCollateral.amount,
      lwk.AssetId.fromString(pendingCollateral.asset),
    )
    // last, so that no later builder call can reset it
    .skipBlinding()
  const unblinded = builder.finish(deps.wollet)

  // 5. The layout LWK built.
  assertSpendLayout(deps, unblinded, layout, false, 'Cancellation')

  // 6. Blinding: the offer input's secrets are the pinned ones; every output is fresh.
  const blindedBase64 = wasmStep('Blinding the cancellation', () =>
    wasm.blindPset(
      unblinded.toString(),
      [
        opened.inputSecret(wasm.PinnedRole.PendingCollateral, CANCELLATION_INPUT.offer),
        wasm.InputSecret.explicit(CANCELLATION_INPUT.lenderNft, lenderNft, NFT_AMOUNT),
        wasm.InputSecret.explicit(CANCELLATION_INPUT.borrowerNft, borrowerNft, NFT_AMOUNT),
        ...params.feeCoins.map((coin, index) =>
          walletInputSecret(deps, coin, CANCELLATION_INPUT.borrowerNft + 1 + index),
        ),
      ],
      [],
    ),
  )
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, 'Cancellation')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(creationTx, CREATION_OUTPUT.pendingOffer, 'The pending offer'),
    requireOutput(creationTx, CREATION_OUTPUT.lenderNft, 'The lender NFT lock'),
    requireOutput(nftTx, nftRef.vout, 'The borrower NFT'),
    ...prevoutsOf(feePrevoutTxs, feeInputs),
  ]

  // 8. Sign (by the caller), then finalize the wallet inputs and the covenants.
  return {
    pset: blinded,
    finalize: signedPset => {
      const signed = deps.wollet.finalize(signedPset).extractTx()
      if (signed.txid().toString() !== builtTxid) {
        throw new Error('The signed cancellation is not the transaction that was built')
      }
      const withOffer = finalizePrivateOfferInput(
        deps,
        signed,
        offer,
        false,
        prevouts(),
        CANCELLATION_INPUT.offer,
        'OfferCancellation',
      )
      const finalizedTx = finalizeScriptAuthInput(
        deps,
        withOffer,
        offer,
        prevouts(),
        CANCELLATION_INPUT.lenderNft,
        CANCELLATION_INPUT.offer,
      )
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) throw new Error('Finalizing changed the cancellation')
      assertAllInputsFinalized(finalizedTx, 'The cancellation')

      return {
        finalizedTx,
        summary: {
          collateralOutpoint: `${txid}:${CANCELLATION_OUTPUT.collateral}`,
          collateral: pendingCollateral.amount,
        },
      }
    },
  }
}
