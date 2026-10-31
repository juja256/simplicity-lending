// The borrower's full repayment of a private loan (`attach_full_repayment` in the contracts'
// private lending core):
//   inputs   0 the borrower NFT, explicit; 1 the active offer (FullRepayment branch); 2… the
//            borrower's principal coins, then its fee coins;
//   outputs  0 burns the borrower NFT (OP_RETURN, explicit); 1 the repayment at asset_auth(lender
//            NFT, 1, burn), pinned and blinded to the lender's key; 2 the collateral back to the
//            borrower, blinded to its wallet; 3 the principal change to the wallet, if any; then
//            the policy-asset change and the fee.
// The covenant checks the borrower NFT burn (input 0 to output 0), the active collateral at input
// 1 and the pinned repayment at output 1; it leaves the collateral to the spender. The borrower NFT
// is an explicit output at a wallet address, which LWK does not list among the wallet's coins, so
// it is spent as an external UTXO that the wallet still signs. LWK puts the change of any asset
// but the policy asset before the post-issuance outputs, so the builder pays the principal change
// itself, after them.
// The covenant does not check that the principal was claimed, and the borrower NFT is the only key
// to an unclaimed principal (asset_auth(borrower NFT, 1, no burn)): burning it first would strand
// the principal forever. So the builder spends the NFT only from the principal claim's output 0,
// checked on chain, whatever the indexer says.
import type { Address, WalletTxOut } from '@lilbonekit/lwk-web'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import {
  ACCEPTANCE_INPUT,
  ACCEPTANCE_OUTPUT,
  CREATION_OUTPUT,
  NFT_AMOUNT,
  PRINCIPAL_CLAIM_OUTPUT,
  REPAYMENT_INPUT,
  REPAYMENT_OUTPUT,
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
  type ExpectedOutput,
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
 * The repayment refused before building: the borrower NFT outpoint is not output 0 of a
 * transaction that spends this offer's principal output, so the principal may be unclaimed, and
 * the repayment would burn the only key to it. The message is `"principal-not-claimed: …"`.
 */
export class PrincipalNotClaimedError extends Error {
  readonly code = 'principal-not-claimed'

  constructor(
    readonly borrowerNftOutpoint: string,
    /** The offer's principal output, `"<acceptance txid>:1"`. */
    readonly principalOutpoint: string,
  ) {
    super(
      `principal-not-claimed: the borrower NFT at ${borrowerNftOutpoint} is not output ` +
        `${PRINCIPAL_CLAIM_OUTPUT.borrowerNft} of a transaction that spends the principal ` +
        `${principalOutpoint}. Claim the principal first: the repayment burns the borrower NFT, ` +
        'the only key to it',
    )
    this.name = 'PrincipalNotClaimedError'
  }
}

export interface RepaymentParams {
  /**
   * The active offer, `"<acceptance txid>:0"`. The builder checks that the transaction spends this
   * offer's pending offer at input 0: the acceptance covenant then put the active offer at output
   * 0; a cancellation burns there, which the script check rejects.
   */
  activeOfferOutpoint: string
  /**
   * The borrower NFT: an explicit output at a wallet address, `"<principal claim txid>:0"`. The
   * builder checks on chain that this transaction spends the offer's principal output,
   * `"<acceptance txid>:1"`, and throws `PrincipalNotClaimedError` otherwise: before the claim the
   * NFT sits at `"<creation txid>:0"`, the only key to the principal.
   */
  borrowerNftOutpoint: string
  /** The borrower's coins of the principal asset, which pay the repayment. */
  principalCoins: WalletTxOut[]
  /** The borrower's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /** A confidential address: receives the collateral, blinded to it. */
  collateralReceiver: Address
}

export interface RepaymentSummary {
  /** The repayment, locked to the lender NFT: `"<txid>:1"`. */
  repaymentOutpoint: string
  /** The collateral back to the borrower: `"<txid>:2"`. */
  collateralOutpoint: string
  collateral: bigint
  repayment: bigint
  /** Repayment − principal, in principal units. */
  interest: bigint
}

/**
 * Builds the borrower's full repayment of an accepted offer whose principal was claimed, blinded
 * and ready to sign. Throws `PrincipalNotClaimedError` before building unless the borrower NFT
 * comes from the principal claim. `finalize` finalizes the wallet inputs (the borrower NFT among
 * them), then the offer (FullRepayment), running the covenant on the transaction.
 */
export async function buildPrivateRepayment(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  params: RepaymentParams,
): Promise<UpdatedPset<RepaymentSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'borrower') throw new Error('Only the borrower repays a loan')
  const opened = offer.opened
  const borrowerNft = opened.borrowerNft()
  const lenderNft = opened.lenderNft()
  const principalAsset = opened.principalAsset()

  // 1. The inputs.
  const nftRef = parseOutpoint(params.borrowerNftOutpoint)
  const offerRef = parseOutpoint(params.activeOfferOutpoint)
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  const offerInput = `${offerRef.txid}:${offerRef.vout}`
  if (params.principalCoins.length === 0) throw new Error('A repayment needs a principal coin')
  if (params.feeCoins.length === 0) throw new Error('A repayment needs a fee coin')
  const walletCoins = [...params.principalCoins, ...params.feeCoins]
  const walletInputs = walletCoins.map(outpointOf)
  const inputs = [nftInput, offerInput, ...walletInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error(
      'The borrower NFT, the active offer, the principal and fee coins must be distinct',
    )
  }
  const repayment = opened.pinned(wasm.PinnedRole.Repayment)
  const activeCollateral = opened.pinned(wasm.PinnedRole.ActiveCollateral)
  if (
    repayment.asset !== principalAsset ||
    repayment.amount !== opened.repaymentAmount() ||
    activeCollateral.asset !== opened.collateralAsset() ||
    activeCollateral.amount !== opened.collateralAmount()
  ) {
    throw new Error('The pinned outputs do not carry the offer terms')
  }
  let principalIn = 0n
  for (const coin of params.principalCoins) {
    const secrets = coin.unblinded()
    if (secrets.asset().toString() !== principalAsset) {
      throw new Error(`Principal coin ${outpointOf(coin)} is not the principal asset`)
    }
    principalIn += secrets.value()
  }
  if (principalIn < repayment.amount) {
    throw new Error('The principal coins hold less than the repayment')
  }
  const principalChange = principalIn - repayment.amount
  for (const coin of params.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }
  if (!params.collateralReceiver.isBlinded()) {
    throw new Error('The collateral must go to a confidential address')
  }

  // 2. The covenant input and the borrower NFT, fetched and tied to this offer.
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
  // The NFT's transaction must be the principal claim: it spends the principal output this
  // acceptance pinned, which only the borrower NFT unlocks, and pays the NFT back at its output 0.
  const principalOutpoint = `${offerRef.txid}:${ACCEPTANCE_OUTPUT.principal}`
  const claimsPrincipal = nftTx.inputs.some(input => {
    const spent = input.outpoint()
    return `${spent.txid().toString()}:${spent.vout()}` === principalOutpoint
  })
  if (nftRef.vout !== PRINCIPAL_CLAIM_OUTPUT.borrowerNft || !claimsPrincipal) {
    throw new PrincipalNotClaimedError(nftInput, principalOutpoint)
  }
  const nftOutput = requireOutput(nftTx, nftRef.vout, 'The borrower NFT')
  if (nftOutput.asset()?.toString() !== borrowerNft || nftOutput.value() !== NFT_AMOUNT) {
    throw new Error('The borrower NFT outpoint does not hold exactly the borrower NFT, explicit')
  }

  // 3. The outputs: the pinned repayment carries the lender's blinding key.
  const lenderBlindingKey = opened.lenderBlindingKey()
  const principalAuth = pinnedAuthCovenant(deps, offer, 'principal')
  const repaymentAuth = pinnedAuthCovenant(deps, offer, 'repayment')
  const repaymentAddress = new lwk.Address(
    wasmStep('The repayment output address', () =>
      wasm.confidentialAddress(
        repaymentAuth.script.toString(),
        lenderBlindingKey,
        deps.networkName,
      ),
    ),
  )
  const burn = burnScript(deps)
  const collateralReceiver = lwk.Address.parse(params.collateralReceiver.toString(), deps.network)
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
        script: burn.toString(),
        asset: borrowerNft,
        amount: NFT_AMOUNT,
        blinding: { kind: 'explicit' },
      },
      {
        script: repaymentAuth.script.toString(),
        asset: repayment.asset,
        amount: repayment.amount,
        blinding: { kind: 'pinned', blindingKey: lenderBlindingKey, pinned: repayment },
      },
      {
        script: collateralReceiver.scriptPubkey().toString(),
        asset: activeCollateral.asset,
        amount: activeCollateral.amount,
        blinding: { kind: 'fresh' },
      },
      ...changeOutputs,
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
        nftRef.vout,
        nftTx,
        lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(borrowerNft), NFT_AMOUNT),
        EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
        true,
      ),
      new lwk.ExternalUtxo(
        offerRef.vout,
        offerTx,
        pinnedTxOutSecrets(deps, activeCollateral),
        PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.FullRepayment,
        true,
      ),
    ])
    .addPostIssuanceScriptOutput(burn, NFT_AMOUNT, lwk.AssetId.fromString(borrowerNft))
    .addPostIssuanceRecipient(
      repaymentAddress,
      repayment.amount,
      lwk.AssetId.fromString(repayment.asset),
    )
    .addPostIssuanceRecipient(
      collateralReceiver,
      activeCollateral.amount,
      lwk.AssetId.fromString(activeCollateral.asset),
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
  assertSpendLayout(deps, unblinded, layout, false, 'Repayment')

  // 6. Blinding: the repayment with its pinned blinders; the other outputs fresh.
  const blindedBase64 = wasmStep('Blinding the repayment', () =>
    wasm.blindPset(
      unblinded.toString(),
      [
        wasm.InputSecret.explicit(REPAYMENT_INPUT.borrowerNft, borrowerNft, NFT_AMOUNT),
        opened.inputSecret(wasm.PinnedRole.ActiveCollateral, REPAYMENT_INPUT.offer),
        ...walletCoins.map((coin, index) =>
          walletInputSecret(deps, coin, REPAYMENT_INPUT.offer + 1 + index),
        ),
      ],
      [opened.pinnedBlinding(wasm.PinnedRole.Repayment, REPAYMENT_OUTPUT.repayment)],
    ),
  )
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, 'Repayment')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(nftTx, nftRef.vout, 'The borrower NFT'),
    requireOutput(offerTx, offerRef.vout, 'The active offer'),
    ...prevoutsOf(walletPrevoutTxs, walletInputs),
  ]

  // 8. Sign (by the caller), then finalize the wallet inputs and the covenant.
  return {
    pset: blinded,
    finalize: signedPset => {
      const signed = deps.wollet.finalize(signedPset).extractTx()
      if (signed.txid().toString() !== builtTxid) {
        throw new Error('The signed repayment is not the transaction that was built')
      }
      const finalizedTx = finalizePrivateOfferInput(
        deps,
        signed,
        offer,
        true,
        prevouts(),
        REPAYMENT_INPUT.offer,
        'FullRepayment',
      )
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) throw new Error('Finalizing changed the repayment')
      assertAllInputsFinalized(finalizedTx, 'The repayment')

      return {
        finalizedTx,
        summary: {
          repaymentOutpoint: `${txid}:${REPAYMENT_OUTPUT.repayment}`,
          collateralOutpoint: `${txid}:${REPAYMENT_OUTPUT.collateral}`,
          collateral: activeCollateral.amount,
          repayment: repayment.amount,
          interest: repayment.amount - opened.principalAmount(),
        },
      }
    },
  }
}
