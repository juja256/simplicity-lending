// The borrower's full repayment of what a private loan still owes (`attach_full_repayment` in the
// contracts' private lending core):
//   inputs   0 the borrower NFT, explicit; 1 the loan (FullRepayment branch); 2… the borrower's
//            principal coins, then its fee coins;
//   outputs  0 burns the borrower NFT (OP_RETURN, explicit); 1 the repayment at asset_auth(lender
//            NFT, 1, burn), pinned and blinded to the lender's key; 2 the collateral back to the
//            borrower, blinded to its wallet; 3 the principal change to the wallet, if any; then
//            the policy-asset change and the fee.
// The covenant checks that the witness's debt hash is the one the loan's storage holds, the
// borrower NFT burn (input 0 to output 0) and that the repayment at output 1 has that debt hash; it
// leaves the collateral to the spender. The repayment is the debt itself: the amount still owed
// under the repayment's asset commitment `A`, with the debt's blinder, so that its value
// commitment is the debt `D` of the loan's state. Before any installment, that is the pinned
// repayment.
// The borrower NFT is an explicit output at a wallet address, which LWK does not list among the
// wallet's coins, so it is spent as a plain input, not a wallet coin; the wallet still recognizes
// its script, and signs it. `buildPset` adds only the policy-asset change, after the given outputs,
// so the builder pays the principal change itself, at output 3.
// The covenant does not check that the principal was claimed, and the borrower NFT is the only key
// to an unclaimed principal (asset_auth(borrower NFT, 1, no burn)): burning it first would strand
// the principal forever. So the builder spends the NFT only once it comes from the principal
// claim, checked on chain (`principalClaimedBefore`), whatever the indexer says.
import type { Address, WalletTxOut } from 'lwk_wasm'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { NFT_AMOUNT, REPAYMENT_INPUT, REPAYMENT_OUTPUT } from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from '../deps'
import { finalizePrivateOfferInput, pinnedAuthCovenant } from '../finalize'
import { borrowerLoanInputs, type Loan } from '../loan'
import { checkedMessage } from '../messages'
import { walletInputSecret } from '../secrets'
import type { VerifiedOffer } from '../verify'
import {
  assertAllInputsFinalized,
  assertSpendLayout,
  buildUnblindedPset,
  burnScript,
  type ExpectedOutput,
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

export { PrincipalNotClaimedError } from '../loan'

export interface RepaymentParams {
  /**
   * The borrower NFT, an explicit output at a wallet address: output 0 of the principal claim, or
   * of the last installment after it. The builder walks it back on chain to the claim of this
   * offer's principal and throws `PrincipalNotClaimedError` otherwise: before the claim the NFT
   * sits at `"<creation txid>:0"`, the only key to the principal.
   */
  borrowerNftOutpoint: string
  /** The borrower's coins of the principal asset, which pay the repayment. */
  principalCoins: WalletTxOut[]
  /** The borrower's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /** A confidential address: receives the collateral, blinded to it. */
  collateralReceiver: Address
  /** The borrower's lending key, the one the loan was read with: it signs the message. */
  lendingKey: LendingKey
  /**
   * The borrower's private message to the lender, in the repayment's range proof: at most
   * `MESSAGE_LIMITS.signed` UTF-8 bytes. An empty or blank one is none.
   */
  message?: string
}

export interface RepaymentSummary {
  /** The repayment, locked to the lender NFT: `"<txid>:1"`. */
  repaymentOutpoint: string
  /** The collateral back to the borrower: `"<txid>:2"`. */
  collateralOutpoint: string
  collateral: bigint
  /** What this repayment pays: the amount the loan still owed. */
  repayment: bigint
  /** The loan's interest, its repayment amount − principal, in principal units. */
  interest: bigint
}

/**
 * Builds the borrower's full repayment of `loan.state.remaining` at `loan.state.loanOutpoint`,
 * blinded and ready to sign. Throws `PrincipalNotClaimedError` before building unless the borrower
 * NFT comes from the principal claim. `finalize` finalizes the wallet inputs (the borrower NFT
 * among them), then the loan (FullRepayment), running the covenant on the transaction.
 */
export async function buildPrivateRepayment(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  loan: Loan,
  params: RepaymentParams,
): Promise<UpdatedPset<RepaymentSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'borrower') throw new Error('Only the borrower repays a loan')
  const message = checkedMessage(params.message, 'signed')
  const opened = offer.opened
  if (params.lendingKey.xOnlyPublicKey() !== opened.borrowerPublicKey()) {
    throw new Error("This wallet is not the loan's borrower")
  }
  const { state } = loan
  const borrowerNft = opened.borrowerNft()
  const lenderNft = opened.lenderNft()
  const principalAsset = opened.principalAsset()
  const owed = state.remaining
  if (owed === undefined) {
    throw new Error(
      'The amount still owed is unknown: an installment of this loan does not open with this ' +
        "wallet's key",
    )
  }
  if (owed === 0n) throw new Error('Nothing is owed: the zero-debt close closes this loan')
  // Read now: `finalize` may run after the loan's state is freed.
  const debtHash = state.debtHash
  const debtCommitment = state.debtCommitment
  const collateral = state.collateral()

  // 1. The inputs.
  const nftRef = parseOutpoint(params.borrowerNftOutpoint)
  const loanRef = parseOutpoint(state.loanOutpoint)
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  const loanInput = `${loanRef.txid}:${loanRef.vout}`
  if (params.principalCoins.length === 0) throw new Error('A repayment needs a principal coin')
  if (params.feeCoins.length === 0) throw new Error('A repayment needs a fee coin')
  const walletCoins = [...params.principalCoins, ...params.feeCoins]
  const walletInputs = walletCoins.map(outpointOf)
  const inputs = [nftInput, loanInput, ...walletInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error('The borrower NFT, the loan, the principal and fee coins must be distinct')
  }
  // `A`, which the repayment carries: the pinned repayment's asset commitment.
  const repaymentAsset = opened.pinned(wasm.PinnedRole.Repayment)
  if (
    repaymentAsset.asset !== principalAsset ||
    collateral.asset !== opened.collateralAsset() ||
    collateral.amount !== opened.collateralAmount()
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
  if (principalIn < owed) throw new Error('The principal coins hold less than the repayment')
  const principalChange = principalIn - owed
  for (const coin of params.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }
  if (!params.collateralReceiver.isBlinded()) {
    throw new Error('The collateral must go to a confidential address')
  }

  // 2. The borrower NFT and the loan, fetched and tied to this offer, the NFT to the claim.
  const { nftTx, loanTx, loanScript } = await borrowerLoanInputs(
    deps,
    offer,
    loan,
    nftInput,
    'repayment',
  )

  // 3. The outputs: the repayment is the debt, pinned, and carries the lender's blinding key.
  const lenderBlindingKey = opened.lenderBlindingKey()
  const principalAuth = pinnedAuthCovenant(deps, offer, 'principal')
  const repaymentAuth = pinnedAuthCovenant(deps, offer, 'repayment')
  const installmentAuth = pinnedAuthCovenant(deps, offer, 'installment')
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
  // The principal change goes to the wallet's internal chain, confidential, so it never shares a
  // script with the receiver (an external address). The policy-asset change takes the next new
  // internal address, so the two changes never share one either.
  const [changeAddress, policyChangeAddress] = deps.addresses.nextChange(deps.wollet, 2)
  const changeOutputs: ExpectedOutput[] =
    principalChange > 0n
      ? [
          {
            script: changeAddress.scriptPubkey().toString(),
            asset: principalAsset,
            amount: principalChange,
            blinding: { kind: 'fresh', receiver: changeAddress },
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
        asset: principalAsset,
        amount: owed,
        blinding: {
          kind: 'pinned',
          blindingKey: lenderBlindingKey,
          pinned: {
            assetCommitment: repaymentAsset.assetCommitment,
            valueCommitment: debtCommitment,
          },
        },
      },
      {
        script: collateralReceiver.scriptPubkey().toString(),
        asset: collateral.asset,
        amount: collateral.amount,
        blinding: { kind: 'fresh', receiver: collateralReceiver },
      },
      ...changeOutputs,
    ],
    restrictedAssets: [borrowerNft, lenderNft],
    restrictedScripts: [
      offer.scripts.pendingOffer.toString(),
      offer.scripts.activeOffer.toString(),
      loanScript.toString(),
      offer.scripts.lenderNftLock.toString(),
      principalAuth.script.toString(),
      repaymentAuth.script.toString(),
      installmentAuth.script.toString(),
    ],
    policyAsset: deps.assets.policy,
  }

  // The transactions of the wallet coins: finalization needs every prevout.
  const walletPrevoutTxs = await fetchPrevoutTxs(deps, walletInputs)

  // 4. The unblinded PSET: the inputs and the leading outputs in layout order.
  const walletPrevouts = prevoutsOf(walletPrevoutTxs, walletInputs)
  const unblinded = buildUnblindedPset(deps, {
    inputs: [
      {
        outpoint: new lwk.OutPoint(nftInput),
        prevout: requireOutput(nftTx, nftRef.vout, 'The borrower NFT'),
        asset: lwk.AssetId.fromString(borrowerNft),
        amount: NFT_AMOUNT,
        secrets: lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(borrowerNft), NFT_AMOUNT),
        maxWeightToSatisfy: EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
      },
      {
        outpoint: new lwk.OutPoint(loanInput),
        prevout: requireOutput(loanTx, loanRef.vout, 'The loan'),
        asset: lwk.AssetId.fromString(collateral.asset),
        amount: collateral.amount,
        secrets: pinnedTxOutSecrets(deps, collateral),
        maxWeightToSatisfy: PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.FullRepayment,
      },
      ...walletCoins.map((coin, index) => walletCoinInput(deps, coin, walletPrevouts[index])),
    ],
    outputs: [
      { script: burn, amount: NFT_AMOUNT, asset: lwk.AssetId.fromString(borrowerNft) },
      {
        script: repaymentAddress.scriptPubkey(),
        amount: owed,
        asset: lwk.AssetId.fromString(principalAsset),
        blindingPubkey: repaymentAddress.blindingPubkey(),
      },
      {
        script: collateralReceiver.scriptPubkey(),
        amount: collateral.amount,
        asset: lwk.AssetId.fromString(collateral.asset),
        blindingPubkey: collateralReceiver.blindingPubkey(),
      },
      ...(principalChange > 0n
        ? [
            {
              script: changeAddress.scriptPubkey(),
              amount: principalChange,
              asset: lwk.AssetId.fromString(principalAsset),
              blindingPubkey: changeAddress.blindingPubkey(),
            },
          ]
        : []),
    ],
    changeAddress: policyChangeAddress,
  })

  // 5. The layout of the unblinded PSET.
  assertSpendLayout(deps, unblinded, layout, false, 'Repayment')

  // 6. Blinding: the repayment with the debt's opening and the borrower's message, signed just
  // before the call that takes it (and consumes it); the other outputs fresh.
  const creationTxid = offer.creationTx.txid().toString()
  const blindedBase64 = wasmStep('Blinding the repayment', () =>
    wasm.blindPset(
      unblinded.toString(),
      [
        wasm.InputSecret.explicit(REPAYMENT_INPUT.borrowerNft, borrowerNft, NFT_AMOUNT),
        state.loanInputSecret(REPAYMENT_INPUT.offer),
        ...walletCoins.map((coin, index) =>
          walletInputSecret(deps, coin, REPAYMENT_INPUT.offer + 1 + index),
        ),
      ],
      [
        state.repaymentBlinding(
          REPAYMENT_OUTPUT.repayment,
          message === undefined
            ? undefined
            : wasm.signMessage(
                params.lendingKey,
                creationTxid,
                wasm.MessagePhase.FullRepayment,
                0,
                message,
              ),
        ),
      ],
    ),
  )
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, 'Repayment')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(nftTx, nftRef.vout, 'The borrower NFT'),
    requireOutput(loanTx, loanRef.vout, 'The loan'),
    ...prevoutsOf(walletPrevoutTxs, walletInputs),
  ]
  const interest = opened.repaymentAmount() - opened.principalAmount()
  const collateralAmount = collateral.amount

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
        offer.scripts.activeSpendInfoAt(debtHash),
        prevouts(),
        REPAYMENT_INPUT.offer,
        { branch: 'FullRepayment', debtHash },
      )
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) throw new Error('Finalizing changed the repayment')
      assertAllInputsFinalized(finalizedTx, 'The repayment')

      return {
        finalizedTx,
        summary: {
          repaymentOutpoint: `${txid}:${REPAYMENT_OUTPUT.repayment}`,
          collateralOutpoint: `${txid}:${REPAYMENT_OUTPUT.collateral}`,
          collateral: collateralAmount,
          repayment: owed,
          interest,
        },
      }
    },
  }
}
