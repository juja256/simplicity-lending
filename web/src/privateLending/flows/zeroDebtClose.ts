// The borrower's close of a private loan that owes no amount (`attach_zero_debt_close` in the
// contracts' private lending core):
//   inputs   0 the borrower NFT, explicit; 1 the loan (ZeroDebtClose branch); 2… the borrower's fee
//            coins;
//   outputs  0 burns the borrower NFT (OP_RETURN, explicit); 1 `OP_RETURN` with one 32-byte push of
//            the debt's blinder `k`, explicit, of amount 0; 2 the collateral back to the borrower,
//            blinded to its wallet; then the policy-asset change and the fee.
// A debt of no amount is `k·G`, which no repayment output can equal: Elements refuses an output of
// amount 0 with a range proof. The covenant checks the loan's storage against the witness's debt,
// the borrower NFT burn, that output 1 is exactly `OP_RETURN <k>` with `0 < k < n`, and that `k·G`
// has the debt's x. The revealed `k` lets the lender sweep the installments it has not claimed.
// The app never builds a zero-debt state, because an amount equal to the remaining debt is the full
// repayment; the close is for a loan whose debt a hand-built installment paid off.
// The builder burns the borrower NFT only once it comes from the principal claim, as the full
// repayment does (`principalClaimedBefore`).
import type { Address, WalletTxOut } from 'lwk_wasm'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import {
  NFT_AMOUNT,
  ZERO_DEBT_CLOSE_INPUT,
  ZERO_DEBT_CLOSE_OUTPUT,
} from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import { hexToBytes } from '@/utils/hex'

import type { PrivateFlowDeps } from '../deps'
import { finalizePrivateOfferInput, pinnedAuthCovenant } from '../finalize'
import { borrowerLoanInputs, type Loan } from '../loan'
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

export interface ZeroDebtCloseParams {
  /**
   * The borrower NFT, an explicit output at a wallet address: output 0 of the last installment.
   * The builder walks it back on chain to the claim of this offer's principal, and throws
   * `PrincipalNotClaimedError` otherwise.
   */
  borrowerNftOutpoint: string
  /** The borrower's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /** A confidential address: receives the collateral, blinded to it. */
  collateralReceiver: Address
}

export interface ZeroDebtCloseSummary {
  /** The collateral back to the borrower: `"<txid>:2"`. */
  collateralOutpoint: string
  collateral: bigint
  /** The debt's blinder that output 1 reveals, hex. */
  key: string
}

/**
 * Builds the borrower's close of a loan whose remaining debt is 0, blinded and ready to sign.
 * Throws `PrincipalNotClaimedError` before building unless the borrower NFT comes from the
 * principal claim. `finalize` finalizes the wallet inputs (the borrower NFT among them), then the
 * loan (ZeroDebtClose), running the covenant on the transaction.
 */
export async function buildZeroDebtClose(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  loan: Loan,
  params: ZeroDebtCloseParams,
): Promise<UpdatedPset<ZeroDebtCloseSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'borrower') throw new Error('Only the borrower closes a loan')
  const opened = offer.opened
  const { state } = loan
  const borrowerNft = opened.borrowerNft()
  const lenderNft = opened.lenderNft()
  if (state.remaining === undefined) {
    throw new Error(
      'The amount still owed is unknown: an installment of this loan does not open with this ' +
        "wallet's key",
    )
  }
  if (state.remaining !== 0n) {
    throw new Error(`The loan still owes ${state.remaining}: the full repayment closes it`)
  }
  // Read now: `finalize` may run after the loan's state is freed.
  const debtHash = state.debtHash
  const debtCommitment = state.debtCommitment
  const key = wasmStep('The zero-debt key', () => state.zeroDebtKey())
  const collateral = state.collateral()

  // 1. The inputs.
  const nftRef = parseOutpoint(params.borrowerNftOutpoint)
  const loanRef = parseOutpoint(state.loanOutpoint)
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  const loanInput = `${loanRef.txid}:${loanRef.vout}`
  if (params.feeCoins.length === 0) throw new Error('A zero-debt close needs a fee coin')
  const feeInputs = params.feeCoins.map(outpointOf)
  const inputs = [nftInput, loanInput, ...feeInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error('The borrower NFT, the loan and the fee coins must be distinct')
  }
  if (
    collateral.asset !== opened.collateralAsset() ||
    collateral.amount !== opened.collateralAmount()
  ) {
    throw new Error('The loan does not hold the offer collateral')
  }
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
    'zero-debt close',
  )

  // 3. The outputs: output 1 is exactly one 32-byte push of `k`, which the covenant hashes.
  const keyScript = lwk.Script.newOpReturn(hexToBytes(key))
  if (keyScript.toString() !== `6a20${key}`) {
    throw new Error('The key output is not OP_RETURN with one 32-byte push of the key')
  }
  const burn = burnScript(deps)
  const collateralReceiver = lwk.Address.parse(params.collateralReceiver.toString(), deps.network)
  const principalAuth = pinnedAuthCovenant(deps, offer, 'principal')
  const repaymentAuth = pinnedAuthCovenant(deps, offer, 'repayment')
  const installmentAuth = pinnedAuthCovenant(deps, offer, 'installment')
  const layout: SpendLayout = {
    inputs,
    outputs: [
      {
        script: burn.toString(),
        asset: borrowerNft,
        amount: NFT_AMOUNT,
        blinding: { kind: 'explicit' },
      },
      // as the creation's marker, an explicit output of 0 of the policy asset
      {
        script: keyScript.toString(),
        asset: deps.assets.policy,
        amount: 0n,
        blinding: { kind: 'explicit' },
      },
      {
        script: collateralReceiver.scriptPubkey().toString(),
        asset: collateral.asset,
        amount: collateral.amount,
        blinding: { kind: 'fresh', receiver: collateralReceiver },
      },
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

  // The transactions of the fee coins: finalization needs every prevout.
  const feePrevoutTxs = await fetchPrevoutTxs(deps, feeInputs)

  // 4. The unblinded PSET: the inputs and the leading outputs in layout order.
  const feePrevouts = prevoutsOf(feePrevoutTxs, feeInputs)
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
        maxWeightToSatisfy: PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.ZeroDebtClose,
      },
      ...params.feeCoins.map((coin, index) => walletCoinInput(deps, coin, feePrevouts[index])),
    ],
    outputs: [
      { script: burn, amount: NFT_AMOUNT, asset: lwk.AssetId.fromString(borrowerNft) },
      { script: keyScript, amount: 0n, asset: lwk.AssetId.fromString(deps.assets.policy) },
      {
        script: collateralReceiver.scriptPubkey(),
        amount: collateral.amount,
        asset: lwk.AssetId.fromString(collateral.asset),
        blindingPubkey: collateralReceiver.blindingPubkey(),
      },
    ],
    changeAddress: deps.addresses.nextChange(deps.wollet, 1)[0],
  })

  // 5. The layout of the unblinded PSET.
  assertSpendLayout(deps, unblinded, layout, false, 'Zero-debt close')

  // 6. Blinding: the loan input's secrets are the collateral's after the installments; every
  // blinded output is fresh.
  const blindedBase64 = wasmStep('Blinding the zero-debt close', () =>
    wasm.blindPset(
      unblinded.toString(),
      [
        wasm.InputSecret.explicit(ZERO_DEBT_CLOSE_INPUT.borrowerNft, borrowerNft, NFT_AMOUNT),
        state.loanInputSecret(ZERO_DEBT_CLOSE_INPUT.loan),
        ...params.feeCoins.map((coin, index) =>
          walletInputSecret(deps, coin, ZERO_DEBT_CLOSE_INPUT.loan + 1 + index),
        ),
      ],
      [],
    ),
  )
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, 'Zero-debt close')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(nftTx, nftRef.vout, 'The borrower NFT'),
    requireOutput(loanTx, loanRef.vout, 'The loan'),
    ...prevoutsOf(feePrevoutTxs, feeInputs),
  ]
  const collateralAmount = collateral.amount

  // 8. Sign (by the caller), then finalize the wallet inputs and the covenant.
  return {
    pset: blinded,
    finalize: signedPset => {
      const signed = deps.wollet.finalize(signedPset).extractTx()
      if (signed.txid().toString() !== builtTxid) {
        throw new Error('The signed zero-debt close is not the transaction that was built')
      }
      const finalizedTx = finalizePrivateOfferInput(
        deps,
        signed,
        offer,
        offer.scripts.activeSpendInfoAt(debtHash),
        prevouts(),
        ZERO_DEBT_CLOSE_INPUT.loan,
        { branch: 'ZeroDebtClose', debt: debtCommitment, key },
      )
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) throw new Error('Finalizing changed the zero-debt close')
      assertAllInputsFinalized(finalizedTx, 'The zero-debt close')

      return {
        finalizedTx,
        summary: {
          collateralOutpoint: `${txid}:${ZERO_DEBT_CLOSE_OUTPUT.collateral}`,
          collateral: collateralAmount,
          key,
        },
      }
    },
  }
}
