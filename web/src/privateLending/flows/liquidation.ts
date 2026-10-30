// The lender's liquidation of an expired private loan (`attach_liquidation` in the contracts'
// private lending core):
//   inputs   0 the active offer (Liquidation branch), 1 the lender NFT, explicit; 2… the lender's
//            fee coins;
//   outputs  0 burns the lender NFT (OP_RETURN, explicit); 1 the collateral to the lender, blinded
//            to its wallet; then the policy-asset change and the fee.
// The covenant checks the active collateral at input 0, the lender NFT burn (input 1 to output 0)
// and `check_lock_height(LOAN_EXPIRATION_TIME)`: the transaction's nLockTime must be a height at
// least the expiry, and some input must not be final, or Simplicity reads the lock time as 0. As
// the contracts' core does, the lock time is the expiry and the offer input's sequence is
// ENABLE_LOCKTIME_NO_RBF; LWK's defaults (lock time 0, every sequence final) would fail. Consensus
// then admits the transaction from the block after the expiry, so the builder refuses, before
// building anything, while the tip is below the expiry.
// The lender NFT is an explicit output at a wallet address (the acceptance's output 2), which LWK
// does not list among the wallet's coins, so it is spent as an external UTXO that the wallet still
// signs. The collateral is paid explicitly: LWK would put the change of any asset but the policy
// asset before the burn.
import type { Address, WalletTxOut } from '@lilbonekit/lwk-web'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import {
  ACCEPTANCE_INPUT,
  ACCEPTANCE_OUTPUT,
  CREATION_OUTPUT,
  LIQUIDATION_INPUT,
  LIQUIDATION_OUTPUT,
  LOCK_TIME_ENABLING_SEQUENCE,
  LOCK_TIME_THRESHOLD,
  NFT_AMOUNT,
} from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'

import type { PrivateFlowDeps } from '../deps'
import { finalizePrivateOfferInput, pinnedAuthCovenant } from '../finalize'
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

/**
 * The liquidation refused before building: the tip is below the loan expiration, so a transaction
 * locked to it could not be mined yet. The message is `"expiry-not-reached: …"`.
 */
export class ExpiryNotReachedError extends Error {
  readonly code = 'expiry-not-reached'

  constructor(
    /** The block height from which the lender may liquidate. */
    readonly loanExpirationTime: number,
    readonly tipHeight: number,
  ) {
    super(
      `expiry-not-reached: the loan expires at block ${loanExpirationTime}, ` +
        `and the tip is at block ${tipHeight}`,
    )
    this.name = 'ExpiryNotReachedError'
  }
}

export interface LiquidationParams {
  /**
   * The active offer, `"<acceptance txid>:0"`. The builder checks that the transaction spends this
   * offer's pending offer at input 0: the acceptance covenant then put the active offer at output
   * 0; a cancellation burns there, which the script check rejects.
   */
  activeOfferOutpoint: string
  /** The lender NFT: an explicit output at a wallet address, `"<acceptance txid>:2"`. */
  lenderNftOutpoint: string
  /** The lender's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /** A confidential address: receives the collateral, blinded to it. */
  collateralReceiver: Address
  /** The chain tip's height. */
  tipHeight: number
}

export interface LiquidationSummary {
  /** The collateral to the lender: `"<txid>:1"`. */
  collateralOutpoint: string
  collateral: bigint
  /** The transaction's nLockTime: the loan expiration height. */
  lockTime: number
}

/**
 * Builds the lender's liquidation of an accepted offer whose loan has expired, blinded and ready
 * to sign. Throws `ExpiryNotReachedError` before anything else while `tipHeight` is below the
 * loan expiration. `finalize` finalizes the wallet inputs (the lender NFT among them), then the
 * offer (Liquidation), running the covenant on the transaction.
 */
export async function buildPrivateLiquidation(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  params: LiquidationParams,
): Promise<UpdatedPset<LiquidationSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'lender') throw new Error('Only the lender liquidates a loan')
  const opened = offer.opened
  const expiration = opened.loanExpirationTime()
  if (!Number.isInteger(params.tipHeight) || params.tipHeight < 0) {
    throw new Error('The tip height must be a block height')
  }
  if (!Number.isInteger(expiration) || expiration < 0 || expiration >= LOCK_TIME_THRESHOLD) {
    throw new Error('The loan expiration is not a block height')
  }
  // A transaction locked to the expiry is final from block expiry + 1, the next block once the
  // tip has reached the expiry.
  if (params.tipHeight < expiration) {
    throw new ExpiryNotReachedError(expiration, params.tipHeight)
  }
  const lenderNft = opened.lenderNft()

  // 1. The inputs.
  const offerRef = parseOutpoint(params.activeOfferOutpoint)
  const nftRef = parseOutpoint(params.lenderNftOutpoint)
  const offerInput = `${offerRef.txid}:${offerRef.vout}`
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  if (params.feeCoins.length === 0) throw new Error('A liquidation needs a fee coin')
  for (const coin of params.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }
  const feeInputs = params.feeCoins.map(outpointOf)
  const inputs = [offerInput, nftInput, ...feeInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error('The active offer, the lender NFT and the fee coins must be distinct')
  }
  const activeCollateral = opened.pinned(wasm.PinnedRole.ActiveCollateral)
  if (
    activeCollateral.asset !== opened.collateralAsset() ||
    activeCollateral.amount !== opened.collateralAmount()
  ) {
    throw new Error('The pinned collateral does not carry the offer terms')
  }
  if (!params.collateralReceiver.isBlinded()) {
    throw new Error('The collateral must go to a confidential address')
  }

  // 2. The covenant input, tied to this offer, and the lender NFT.
  const [offerTx, nftTx] = await Promise.all([
    deps.fetchTx(offerRef.txid),
    deps.fetchTx(nftRef.txid),
  ])
  // Only this offer's acceptance or cancellation spends its pending offer, at input 0.
  const pendingOffer = `${offer.creationTx.txid().toString()}:${CREATION_OUTPUT.pendingOffer}`
  const acceptanceOffer = offerTx.inputs[ACCEPTANCE_INPUT.offer]?.outpoint()
  if (
    offerRef.vout !== ACCEPTANCE_OUTPUT.activeOffer ||
    acceptanceOffer === undefined ||
    `${acceptanceOffer.txid().toString()}:${acceptanceOffer.vout()}` !== pendingOffer
  ) {
    throw new Error("The active offer outpoint is not output 0 of this offer's acceptance")
  }
  const offerOutput = requireOutput(offerTx, offerRef.vout, 'The active offer')
  if (offerOutput.scriptPubkey().toString() !== offer.scripts.activeOffer.toString()) {
    throw new Error("The active offer outpoint is not locked to the offer's active script")
  }
  const nftOutput = requireOutput(nftTx, nftRef.vout, 'The lender NFT')
  if (nftOutput.asset()?.toString() !== lenderNft || nftOutput.value() !== NFT_AMOUNT) {
    throw new Error('The lender NFT outpoint does not hold exactly the lender NFT, explicit')
  }

  // 3. The outputs, and the lock time with the sequence that enables it.
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
        script: collateralReceiver.scriptPubkey().toString(),
        asset: activeCollateral.asset,
        amount: activeCollateral.amount,
        blinding: { kind: 'fresh' },
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
    lockTime: {
      height: expiration,
      sequences: { [LIQUIDATION_INPUT.offer]: LOCK_TIME_ENABLING_SEQUENCE },
    },
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
        offerRef.vout,
        offerTx,
        pinnedTxOutSecrets(deps, activeCollateral),
        PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Liquidation,
        true,
      ),
      new lwk.ExternalUtxo(
        nftRef.vout,
        nftTx,
        lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(lenderNft), NFT_AMOUNT),
        EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
        true,
      ),
    ])
    .addPostIssuanceScriptOutput(burn, NFT_AMOUNT, lwk.AssetId.fromString(lenderNft))
    .addPostIssuanceRecipient(
      collateralReceiver,
      activeCollateral.amount,
      lwk.AssetId.fromString(activeCollateral.asset),
    )
    .skipBlinding()
  builder = wasmStep('Setting the lock time', () => builder.setFallbackLocktimeHeight(expiration))
    // after every other builder call, which would reset it (LWK's `setInputSequence`)
    .setInputSequence(new lwk.OutPoint(offerInput), LOCK_TIME_ENABLING_SEQUENCE)
  const unblinded = builder.finish(deps.wollet)

  // 5. The layout LWK built, with the lock time and the offer input's sequence.
  assertSpendLayout(deps, unblinded, layout, false, 'Liquidation')

  // 6. Blinding: the offer input's secrets are the pinned ones; every output is fresh.
  const blindedBase64 = wasmStep('Blinding the liquidation', () =>
    wasm.blindPset(
      unblinded.toString(),
      [
        opened.inputSecret(wasm.PinnedRole.ActiveCollateral, LIQUIDATION_INPUT.offer),
        wasm.InputSecret.explicit(LIQUIDATION_INPUT.lenderNft, lenderNft, NFT_AMOUNT),
        ...params.feeCoins.map((coin, index) =>
          walletInputSecret(deps, coin, LIQUIDATION_INPUT.lenderNft + 1 + index),
        ),
      ],
      [],
    ),
  )
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, 'Liquidation')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(offerTx, offerRef.vout, 'The active offer'),
    requireOutput(nftTx, nftRef.vout, 'The lender NFT'),
    ...prevoutsOf(feePrevoutTxs, feeInputs),
  ]

  // 8. Sign (by the caller), then finalize the wallet inputs and the covenant.
  return {
    pset: blinded,
    finalize: signedPset => {
      const signed = deps.wollet.finalize(signedPset).extractTx()
      // the txid commits to the lock time and the sequences, which signing must not change
      if (signed.txid().toString() !== builtTxid) {
        throw new Error('The signed liquidation is not the transaction that was built')
      }
      const finalizedTx = finalizePrivateOfferInput(
        deps,
        signed,
        offer,
        true,
        prevouts(),
        LIQUIDATION_INPUT.offer,
        'Liquidation',
      )
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) throw new Error('Finalizing changed the liquidation')
      assertAllInputsFinalized(finalizedTx, 'The liquidation')

      return {
        finalizedTx,
        summary: {
          collateralOutpoint: `${txid}:${LIQUIDATION_OUTPUT.collateral}`,
          collateral: activeCollateral.amount,
          lockTime: expiration,
        },
      }
    },
  }
}
