// The borrower's claim of the principal that acceptance locked to its borrower NFT
// (asset_auth(borrower NFT, 1, no burn)):
//   inputs   0 the principal output (asset_auth), 1 the borrower NFT, 2… fee coins;
//   outputs  0 the borrower NFT back to the borrower, explicit, 1 the principal to the borrower,
//            blinded to its wallet; change and fee follow.
// The borrower NFT is an explicit output at a wallet address. LWK lists only blinded coins as
// the wallet's, so it is spent as an external UTXO; LWK still recognizes its script, so the
// wallet signs and finalizes it.
import type { Address, WalletTxOut } from '@lilbonekit/lwk-web'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { ASSET_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'
import {
  ACCEPTANCE_INPUT,
  ACCEPTANCE_OUTPUT,
  CREATION_OUTPUT,
  NFT_AMOUNT,
  PRINCIPAL_CLAIM_INPUT,
  PRINCIPAL_CLAIM_OUTPUT,
} from '@/simplicity/private-lending/layout'

import type { PrivateFlowDeps } from '../deps'
import { finalizeAssetAuthInput, pinnedAuthCovenant } from '../finalize'
import { walletInputSecret } from '../secrets'
import type { VerifiedOffer } from '../verify'
import {
  assertAllInputsFinalized,
  assertSpendLayout,
  fetchPrevoutTxs,
  outpointOf,
  parseOutpoint,
  pinnedTxOutSecrets,
  prevoutsOf,
  requireOutput,
  type SpendLayout,
  wasmStep,
} from './shared'

export interface PrincipalClaimParams {
  /**
   * The acceptance's principal output, `"<acceptance txid>:1"`. The builder checks that the
   * transaction spends this offer's pending offer at input 0: the acceptance covenant then pinned
   * this output to the principal.
   */
  principalOutpoint: string
  /**
   * The borrower NFT: an explicit output at a wallet address, `"<creation txid>:0"` until a
   * claim moves it.
   */
  borrowerNftOutpoint: string
  /** The borrower's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /**
   * A confidential wallet address: receives the principal, blinded to it, and the borrower NFT,
   * explicit, at its unconfidential form.
   */
  receiver: Address
}

export interface PrincipalClaimSummary {
  /** The claimed principal in the wallet, `"<txid>:1"`. */
  principalOutpoint: string
  /** `"<txid>:0"`. */
  borrowerNftOutpoint: string
  principal: bigint
}

/**
 * Builds the borrower's claim of the principal of an accepted offer, blinded and ready to sign.
 * `finalize` finalizes the wallet inputs (the borrower NFT among them), then the principal's
 * asset_auth, running it on the transaction.
 */
export async function buildPrincipalClaim(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  params: PrincipalClaimParams,
): Promise<UpdatedPset<PrincipalClaimSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'borrower') throw new Error('Only the borrower claims the principal')
  const opened = offer.opened
  const borrowerNft = opened.borrowerNft()

  // 1. The inputs.
  const principalRef = parseOutpoint(params.principalOutpoint)
  const nftRef = parseOutpoint(params.borrowerNftOutpoint)
  const principalInput = `${principalRef.txid}:${principalRef.vout}`
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  if (params.feeCoins.length === 0) throw new Error('A principal claim needs a fee coin')
  for (const coin of params.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }
  const feeInputs = params.feeCoins.map(outpointOf)
  const inputs = [principalInput, nftInput, ...feeInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error('The principal, the borrower NFT and the fee coins must be distinct')
  }
  if (!params.receiver.isBlinded()) {
    throw new Error('The principal must go to a confidential address')
  }

  const [principalTx, nftTx] = await Promise.all([
    deps.fetchTx(principalRef.txid),
    deps.fetchTx(nftRef.txid),
  ])
  // Only this offer's acceptance or cancellation spends its pending offer, at input 0. The
  // acceptance covenant pins output 1 to the principal; a cancellation burns there, which the
  // script check below rejects. That ties the outpoint to this offer.
  const pendingOffer = `${offer.creationTx.txid().toString()}:${CREATION_OUTPUT.pendingOffer}`
  const acceptanceOffer = principalTx.inputs[ACCEPTANCE_INPUT.offer]?.outpoint()
  if (
    principalRef.vout !== ACCEPTANCE_OUTPUT.principal ||
    acceptanceOffer === undefined ||
    `${acceptanceOffer.txid().toString()}:${acceptanceOffer.vout()}` !== pendingOffer
  ) {
    throw new Error("The principal outpoint is not output 1 of this offer's acceptance")
  }
  const principalAuth = pinnedAuthCovenant(deps, offer, 'principal')
  const principalOutput = requireOutput(principalTx, principalRef.vout, 'The principal')
  if (principalOutput.scriptPubkey().toString() !== principalAuth.script.toString()) {
    throw new Error("The principal outpoint is not locked to the offer's principal asset_auth")
  }
  const nftOutput = requireOutput(nftTx, nftRef.vout, 'The borrower NFT')
  if (nftOutput.asset()?.toString() !== borrowerNft || nftOutput.value() !== NFT_AMOUNT) {
    throw new Error('The borrower NFT outpoint does not hold exactly the borrower NFT, explicit')
  }
  const principal = opened.pinned(wasm.PinnedRole.Principal)

  // 2. The outputs.
  const nftReceiver = lwk.Address.parse(params.receiver.toString(), deps.network).toUnconfidential()
  const principalReceiver = lwk.Address.parse(params.receiver.toString(), deps.network)
  const layout: SpendLayout = {
    inputs,
    outputs: [
      {
        script: nftReceiver.scriptPubkey().toString(),
        asset: borrowerNft,
        amount: NFT_AMOUNT,
        blinding: { kind: 'explicit' },
      },
      {
        script: principalReceiver.scriptPubkey().toString(),
        asset: principal.asset,
        amount: principal.amount,
        blinding: { kind: 'fresh' },
      },
    ],
    restrictedAssets: [borrowerNft, opened.lenderNft()],
    restrictedScripts: [
      offer.scripts.pendingOffer.toString(),
      offer.scripts.activeOffer.toString(),
      offer.scripts.lenderNftLock.toString(),
      principalAuth.script.toString(),
    ],
    policyAsset: deps.assets.policy,
  }

  // The transactions of the fee coins: finalization needs every prevout.
  const feePrevoutTxs = await fetchPrevoutTxs(deps, feeInputs)

  // 3. The unblinded PSET.
  let builder = new lwk.TxBuilder(deps.network)
  if (deps.feeRate !== null) builder = builder.feeRate(deps.feeRate)
  builder = builder
    .setWalletUtxos(feeInputs.map(outpoint => new lwk.OutPoint(outpoint)))
    .setInputOrder(inputs.map(outpoint => new lwk.OutPoint(outpoint)))
    .addExternalUtxos([
      new lwk.ExternalUtxo(
        principalRef.vout,
        principalTx,
        pinnedTxOutSecrets(deps, principal),
        ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
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
    .addPostIssuanceScriptOutput(
      nftReceiver.scriptPubkey(),
      NFT_AMOUNT,
      lwk.AssetId.fromString(borrowerNft),
    )
    .addPostIssuanceRecipient(
      principalReceiver,
      principal.amount,
      lwk.AssetId.fromString(principal.asset),
    )
    // last, so that no later builder call can reset it
    .skipBlinding()
  const unblinded = builder.finish(deps.wollet)

  // 4. The layout LWK built.
  assertSpendLayout(deps, unblinded, layout, false, 'Principal claim')

  // 5. Blinding: the principal input's secrets are the pinned ones; every output is fresh.
  const blindedBase64 = wasmStep('Blinding the principal claim', () =>
    wasm.blindPset(
      unblinded.toString(),
      [
        opened.inputSecret(wasm.PinnedRole.Principal, PRINCIPAL_CLAIM_INPUT.principal),
        wasm.InputSecret.explicit(PRINCIPAL_CLAIM_INPUT.borrowerNft, borrowerNft, NFT_AMOUNT),
        ...params.feeCoins.map((coin, index) =>
          walletInputSecret(deps, coin, PRINCIPAL_CLAIM_INPUT.borrowerNft + 1 + index),
        ),
      ],
      [],
    ),
  )
  const blinded = new lwk.Pset(blindedBase64)

  // 6. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, 'Principal claim')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(principalTx, principalRef.vout, 'The principal'),
    requireOutput(nftTx, nftRef.vout, 'The borrower NFT'),
    ...prevoutsOf(feePrevoutTxs, feeInputs),
  ]

  // 7. Sign (by the caller), then finalize the wallet inputs and the asset_auth.
  return {
    pset: blinded,
    finalize: signedPset => {
      const signed = deps.wollet.finalize(signedPset).extractTx()
      if (signed.txid().toString() !== builtTxid) {
        throw new Error('The signed principal claim is not the transaction that was built')
      }
      const finalizedTx = finalizeAssetAuthInput(
        deps,
        signed,
        offer,
        'principal',
        prevouts(),
        PRINCIPAL_CLAIM_INPUT.principal,
        {
          inputIndex: PRINCIPAL_CLAIM_INPUT.borrowerNft,
          outputIndex: PRINCIPAL_CLAIM_OUTPUT.borrowerNft,
        },
      )
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) throw new Error('Finalizing changed the principal claim')
      assertAllInputsFinalized(finalizedTx, 'The principal claim')

      return {
        finalizedTx,
        summary: {
          principalOutpoint: `${txid}:${PRINCIPAL_CLAIM_OUTPUT.principal}`,
          borrowerNftOutpoint: `${txid}:${PRINCIPAL_CLAIM_OUTPUT.borrowerNft}`,
          principal: principal.amount,
        },
      }
    },
  }
}
