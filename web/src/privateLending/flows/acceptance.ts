// The lender's acceptance of a private offer (`attach_acceptance` in the contracts' private
// lending core):
//   inputs   0 pending offer (OfferAcceptance branch), 1 lender NFT at its script_auth lock,
//            2… the lender's principal coins, then its fee coins;
//   outputs  0 active offer, 1 principal at asset_auth(borrower NFT, 1, no burn): both pinned and
//            blinded to the borrower's key; 2 lender NFT to the lender, explicit; 3 the principal
//            change to the wallet, if any; then the policy-asset change and the fee.
// LWK puts the change of any asset but the policy asset before the post-issuance outputs, so the
// builder pays the principal change itself, after them (as the public acceptance does).
import type { Address, WalletTxOut } from '@lilbonekit/lwk-web'

import type { UpdatedPset } from '@/lwk/updatedPset'
import {
  ACCEPTANCE_INPUT,
  ACCEPTANCE_OUTPUT,
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
  type ExpectedOutput,
  fetchPrevoutTxs,
  outpointOf,
  pinnedTxOutSecrets,
  prevoutsOf,
  requireOutput,
  type SpendLayout,
  wasmStep,
} from './shared'

export interface AcceptanceParams {
  /** The lender's coins of the principal asset, which pay the principal. */
  principalCoins: WalletTxOut[]
  /** The lender's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /** Receives the lender NFT, as an explicit output. */
  lenderNftReceiver: Address
}

export interface AcceptanceSummary {
  /** `"<txid>:0"`. */
  activeOfferOutpoint: string
  /** The principal, locked to the borrower NFT: `"<txid>:1"`. */
  principalOutpoint: string
  /** `"<txid>:2"`. */
  lenderNftOutpoint: string
  collateral: bigint
  principal: bigint
  /** Repayment − principal, in principal units. */
  interest: bigint
}

/**
 * Builds the lender's acceptance of a verified offer, blinded and ready to sign. `finalize`
 * finalizes the wallet inputs, then the offer (OfferAcceptance) and the lender NFT lock
 * (script_auth), running both covenants on the transaction.
 */
export async function buildPrivateAcceptance(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  params: AcceptanceParams,
): Promise<UpdatedPset<AcceptanceSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'lender') throw new Error('Only the lender accepts an offer')
  const opened = offer.opened
  const creationTx = offer.creationTx
  const creationTxid = creationTx.txid().toString()
  const offerInput = `${creationTxid}:${CREATION_OUTPUT.pendingOffer}`
  const lenderNftInput = `${creationTxid}:${CREATION_OUTPUT.lenderNft}`
  const borrowerNft = opened.borrowerNft()
  const lenderNft = opened.lenderNft()
  const principalAsset = opened.principalAsset()
  const principalAmount = opened.principalAmount()

  // 1. The wallet coins.
  if (params.principalCoins.length === 0) throw new Error('An acceptance needs a principal coin')
  if (params.feeCoins.length === 0) throw new Error('An acceptance needs a fee coin')
  const walletCoins = [...params.principalCoins, ...params.feeCoins]
  const walletInputs = walletCoins.map(outpointOf)
  const inputs = [offerInput, lenderNftInput, ...walletInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error('The principal and fee coins must be distinct')
  }
  let principalIn = 0n
  for (const coin of params.principalCoins) {
    const secrets = coin.unblinded()
    if (secrets.asset().toString() !== principalAsset) {
      throw new Error(`Principal coin ${outpointOf(coin)} is not the principal asset`)
    }
    principalIn += secrets.value()
  }
  if (principalIn < principalAmount) {
    throw new Error('The principal coins hold less than the principal')
  }
  const principalChange = principalIn - principalAmount
  for (const coin of params.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }

  // 2. The covenant inputs: the creation outputs the gate verified.
  const lockOutput = requireOutput(creationTx, CREATION_OUTPUT.lenderNft, 'The lender NFT lock')
  if (lockOutput.asset()?.toString() !== lenderNft || lockOutput.value() !== NFT_AMOUNT) {
    throw new Error('The lender NFT lock does not hold exactly the lender NFT')
  }
  const pendingCollateral = opened.pinned(wasm.PinnedRole.PendingCollateral)
  const activeCollateral = opened.pinned(wasm.PinnedRole.ActiveCollateral)
  const principal = opened.pinned(wasm.PinnedRole.Principal)
  if (
    activeCollateral.asset !== opened.collateralAsset() ||
    activeCollateral.amount !== opened.collateralAmount() ||
    principal.asset !== principalAsset ||
    principal.amount !== principalAmount
  ) {
    throw new Error('The pinned outputs do not carry the offer terms')
  }

  // 3. The outputs: the pinned ones carry the borrower's blinding key.
  const borrowerBlindingKey = opened.borrowerBlindingKey()
  const principalAuth = pinnedAuthCovenant(deps, offer, 'principal')
  const activeOfferAddress = new lwk.Address(
    wasmStep('The active offer address', () =>
      wasm.confidentialAddress(
        offer.scripts.activeOffer.toString(),
        borrowerBlindingKey,
        deps.networkName,
      ),
    ),
  )
  const principalAddress = new lwk.Address(
    wasmStep('The principal output address', () =>
      wasm.confidentialAddress(
        principalAuth.script.toString(),
        borrowerBlindingKey,
        deps.networkName,
      ),
    ),
  )
  const lenderNftReceiver = lwk.Address.parse(
    params.lenderNftReceiver.toString(),
    deps.network,
  ).toUnconfidential()
  // the wallet's last unused address, confidential: the change is blinded to the wallet
  const changeAddress = deps.wollet.address(null).address()
  const changeOutputs: ExpectedOutput[] =
    principalChange > 0n
      ? [
          {
            script: changeAddress.scriptPubkey().toString(),
            asset: principalAsset,
            amount: principalChange,
            blinding: { kind: 'fresh' },
          },
        ]
      : []

  const layout: SpendLayout = {
    inputs,
    outputs: [
      {
        script: offer.scripts.activeOffer.toString(),
        asset: activeCollateral.asset,
        amount: activeCollateral.amount,
        blinding: {
          kind: 'pinned',
          blindingKey: borrowerBlindingKey,
          pinned: activeCollateral,
        },
      },
      {
        script: principalAuth.script.toString(),
        asset: principal.asset,
        amount: principal.amount,
        blinding: { kind: 'pinned', blindingKey: borrowerBlindingKey, pinned: principal },
      },
      {
        script: lenderNftReceiver.scriptPubkey().toString(),
        asset: lenderNft,
        amount: NFT_AMOUNT,
        blinding: { kind: 'explicit' },
      },
      ...changeOutputs,
    ],
    restrictedAssets: [borrowerNft, lenderNft],
    restrictedScripts: [
      offer.scripts.pendingOffer.toString(),
      offer.scripts.activeOffer.toString(),
      offer.scripts.lenderNftLock.toString(),
      principalAuth.script.toString(),
    ],
    policyAsset: deps.assets.policy,
  }

  // The transactions of the wallet coins: finalization needs every prevout.
  const walletPrevoutTxs = await fetchPrevoutTxs(deps, walletInputs)

  // 4. The unblinded PSET.
  let builder = new lwk.TxBuilder(deps.network)
  if (deps.feeRate !== null) builder = builder.feeRate(deps.feeRate)
  builder = builder
    .setWalletUtxos(walletInputs.map(outpoint => new lwk.OutPoint(outpoint)))
    .setInputOrder(inputs.map(outpoint => new lwk.OutPoint(outpoint)))
    .addExternalUtxos([
      new lwk.ExternalUtxo(
        CREATION_OUTPUT.pendingOffer,
        creationTx,
        pinnedTxOutSecrets(deps, pendingCollateral),
        PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferAcceptance,
        true,
      ),
      new lwk.ExternalUtxo(
        CREATION_OUTPUT.lenderNft,
        creationTx,
        lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(lenderNft), NFT_AMOUNT),
        SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY,
        true,
      ),
    ])
    .addPostIssuanceRecipient(
      activeOfferAddress,
      activeCollateral.amount,
      lwk.AssetId.fromString(activeCollateral.asset),
    )
    .addPostIssuanceRecipient(
      principalAddress,
      principal.amount,
      lwk.AssetId.fromString(principal.asset),
    )
    .addPostIssuanceScriptOutput(
      lenderNftReceiver.scriptPubkey(),
      NFT_AMOUNT,
      lwk.AssetId.fromString(lenderNft),
    )
  if (principalChange > 0n) {
    builder = builder.addPostIssuanceRecipient(
      changeAddress,
      principalChange,
      lwk.AssetId.fromString(principalAsset),
    )
  }
  // last, so that no later builder call can reset it
  builder = builder.skipBlinding()
  const unblinded = builder.finish(deps.wollet)

  // 5. The layout LWK built.
  assertSpendLayout(deps, unblinded, layout, false, 'Acceptance')

  // 6. Blinding: the active collateral and the principal with their pinned blinders.
  const blindedBase64 = wasmStep('Blinding the acceptance', () =>
    wasm.blindPset(
      unblinded.toString(),
      [
        opened.inputSecret(wasm.PinnedRole.PendingCollateral, ACCEPTANCE_INPUT.offer),
        wasm.InputSecret.explicit(ACCEPTANCE_INPUT.lenderNft, lenderNft, NFT_AMOUNT),
        ...walletCoins.map((coin, index) =>
          walletInputSecret(deps, coin, ACCEPTANCE_INPUT.lenderNft + 1 + index),
        ),
      ],
      [
        opened.pinnedBlinding(wasm.PinnedRole.ActiveCollateral, ACCEPTANCE_OUTPUT.activeOffer),
        opened.pinnedBlinding(wasm.PinnedRole.Principal, ACCEPTANCE_OUTPUT.principal),
      ],
    ),
  )
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, 'Acceptance')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(creationTx, CREATION_OUTPUT.pendingOffer, 'The pending offer'),
    requireOutput(creationTx, CREATION_OUTPUT.lenderNft, 'The lender NFT lock'),
    ...prevoutsOf(walletPrevoutTxs, walletInputs),
  ]

  // 8. Sign (by the caller), then finalize the wallet inputs and the covenants.
  return {
    pset: blinded,
    finalize: signedPset => {
      const signed = deps.wollet.finalize(signedPset).extractTx()
      if (signed.txid().toString() !== builtTxid) {
        throw new Error('The signed acceptance is not the transaction that was built')
      }
      const withOffer = finalizePrivateOfferInput(
        deps,
        signed,
        offer,
        false,
        prevouts(),
        ACCEPTANCE_INPUT.offer,
        'OfferAcceptance',
      )
      const finalizedTx = finalizeScriptAuthInput(
        deps,
        withOffer,
        offer,
        prevouts(),
        ACCEPTANCE_INPUT.lenderNft,
        ACCEPTANCE_INPUT.offer,
      )
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) throw new Error('Finalizing changed the acceptance')
      assertAllInputsFinalized(finalizedTx, 'The acceptance')

      return {
        finalizedTx,
        summary: {
          activeOfferOutpoint: `${txid}:${ACCEPTANCE_OUTPUT.activeOffer}`,
          principalOutpoint: `${txid}:${ACCEPTANCE_OUTPUT.principal}`,
          lenderNftOutpoint: `${txid}:${ACCEPTANCE_OUTPUT.lenderNft}`,
          collateral: activeCollateral.amount,
          principal: principalAmount,
          interest: opened.repaymentAmount() - principalAmount,
        },
      }
    },
  }
}
