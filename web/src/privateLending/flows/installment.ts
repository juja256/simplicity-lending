// The borrower's installment on a private loan (`attach_installment` in the contracts' private
// lending core), a payment that leaves part of the debt:
//   inputs   0 the borrower NFT, explicit; 1 the loan (Installment branch); 2… the borrower's
//            principal coins, then its fee coins;
//   outputs  0 the borrower NFT back to the borrower, explicit, at a fresh receive address; 1 the
//            successor loan, holding the debt the installment leaves and the collateral re-blinded
//            by one step; 2 the installment at asset_auth(lender NFT, 1, no burn), pinned and
//            blinded to the lender's key; 3 the principal change to the wallet, if any; then the
//            policy-asset change and the fee.
// The covenant checks the loan's storage against the witness's debt `D`, the borrower NFT passing
// from input 0 to output 0, that output 2 is at the installment lock under `A`, and that output 1
// is the loan at `D − V` with the collateral after one more step. It does not check output 2's
// range proof: its nonce derives from the borrower's lending key, the loan outpoint, input 2 and
// output 0's script (`LoanState.planInstallment`), so that both parties rewind it from the chain.
// An installment built otherwise would confirm, and the borrower could no longer rebuild its debt
// from the seed and close the loan. So the plan is made from exactly input 2 and output 0's
// script, and both layout checks require them, and the built transaction is read back with the
// borrower's lending key before it is signed: it must give the loan the plan expects.
// The borrower NFT is spent as a plain input, as in the full repayment. The builder pays no
// installment before the principal is claimed (`principalClaimedBefore`), nor from the expiry
// block on (`installmentTermOpen`).
import type { WalletTxOut } from 'lwk_wasm'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import {
  INSTALLMENT_INPUT,
  INSTALLMENT_OUTPUT,
  NFT_AMOUNT,
} from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from '../deps'
import { finalizePrivateOfferInput, pinnedAuthCovenant } from '../finalize'
import { borrowerLoanInputs, type Loan } from '../loan'
import { INSTALLMENT_AFTER_TERM_NOTE, installmentTermOpen } from '../repayPlan'
import { walletInputSecret } from '../secrets'
import type { VerifiedOffer } from '../verify'
import {
  assertAllInputsFinalized,
  assertSpendLayout,
  buildUnblindedPset,
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

/**
 * An installment refused before building: the tip has reached the loan expiry, from which the
 * lender's liquidation can be mined in the same block, and keep the installment as well. The
 * message is the borrower's (`INSTALLMENT_AFTER_TERM_NOTE`).
 */
export class InstallmentAfterTermError extends Error {
  readonly code = 'installment-after-term'

  constructor(
    readonly loanExpirationTime: number,
    readonly tipHeight: number,
  ) {
    super(INSTALLMENT_AFTER_TERM_NOTE)
    this.name = 'InstallmentAfterTermError'
  }
}

export interface InstallmentParams {
  /** What the installment pays: more than 0 and less than `loan.state.remaining`. */
  amount: bigint
  /**
   * The borrower NFT, an explicit output at a wallet address: output 0 of the principal claim, or
   * of the last installment. The builder walks it back on chain to the claim of this offer's
   * principal, and throws `PrincipalNotClaimedError` otherwise.
   */
  borrowerNftOutpoint: string
  /**
   * The borrower's coins of the principal asset, which pay the installment. The first is input 2,
   * from which the installment's key derives.
   */
  principalCoins: WalletTxOut[]
  /** The borrower's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /**
   * The borrower's lending key, the one the loan was read with: the built installment is read back
   * with it before it is signed.
   */
  lendingKey: LendingKey
  /** The chain tip's height, read just before the build: below the loan expiry. */
  tipHeight: number
}

export interface InstallmentSummary {
  /** The borrower NFT, back in the wallet: `"<txid>:0"`. */
  borrowerNftOutpoint: string
  /** The successor loan: `"<txid>:1"`. */
  loanOutpoint: string
  /** The installment, locked to the lender NFT: `"<txid>:2"`. */
  installmentOutpoint: string
  amount: bigint
  /** What the loan owes after the installment. */
  remaining: bigint
  /** The successor loan's debt hash, `h(A, D − V)`. */
  successorDebtHash: string
}

/**
 * Builds the borrower's installment of `params.amount` on the loan at `loan.state.loanOutpoint`,
 * blinded and ready to sign. Throws `InstallmentAfterTermError` before anything else once
 * `params.tipHeight` has reached the loan expiry, and `PrincipalNotClaimedError` before building
 * unless the borrower NFT comes from the principal claim. `finalize` finalizes the wallet inputs
 * (the borrower NFT among them), then the loan (Installment), running the covenant on the
 * transaction.
 */
export async function buildPrivateInstallment(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  loan: Loan,
  params: InstallmentParams,
): Promise<UpdatedPset<InstallmentSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'borrower') throw new Error('Only the borrower pays an installment')
  const opened = offer.opened
  const expiry = opened.loanExpirationTime()
  if (!Number.isInteger(params.tipHeight) || params.tipHeight <= 0) {
    throw new Error('The tip height must be a block height')
  }
  if (!installmentTermOpen(params.tipHeight, expiry)) {
    throw new InstallmentAfterTermError(expiry, params.tipHeight)
  }
  const { state } = loan
  const { amount } = params
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
  if (amount <= 0n || amount >= owed) {
    throw new Error(
      `An installment pays more than 0 and less than the ${owed} still owed, which the full ` +
        'repayment pays',
    )
  }
  // Read now: `finalize` may run after the loan's state is freed.
  const debtHash = state.debtHash
  const collateral = state.collateral()

  // 1. The inputs.
  const nftRef = parseOutpoint(params.borrowerNftOutpoint)
  const loanRef = parseOutpoint(state.loanOutpoint)
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  const loanInput = `${loanRef.txid}:${loanRef.vout}`
  if (params.principalCoins.length === 0) throw new Error('An installment needs a principal coin')
  if (params.feeCoins.length === 0) throw new Error('An installment needs a fee coin')
  const walletCoins = [...params.principalCoins, ...params.feeCoins]
  const walletInputs = walletCoins.map(outpointOf)
  const inputs = [nftInput, loanInput, ...walletInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error('The borrower NFT, the loan, the principal and fee coins must be distinct')
  }
  const firstWalletInput = inputs[INSTALLMENT_INPUT.firstWalletCoin]
  if (
    collateral.asset !== opened.collateralAsset() ||
    collateral.amount !== opened.collateralAmount()
  ) {
    throw new Error('The loan does not hold the offer collateral')
  }
  let principalIn = 0n
  for (const coin of params.principalCoins) {
    const secrets = coin.unblinded()
    if (secrets.asset().toString() !== principalAsset) {
      throw new Error(`Principal coin ${outpointOf(coin)} is not the principal asset`)
    }
    principalIn += secrets.value()
  }
  if (principalIn < amount) throw new Error('The principal coins hold less than the installment')
  const principalChange = principalIn - amount
  for (const coin of params.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }

  // 2. The borrower NFT and the loan, fetched and tied to this offer, the NFT to the claim.
  const { nftTx, loanTx, loanScript } = await borrowerLoanInputs(
    deps,
    offer,
    loan,
    nftInput,
    'installment',
  )

  // 3. The plan, from exactly input 2 and output 0's script: the borrower NFT goes back explicit
  // to the unconfidential form of a fresh receive address.
  const nftReceiver = deps.addresses.nextReceive(deps.wollet).toUnconfidential()
  const nftReceiverScript = nftReceiver.scriptPubkey().toString()
  const plan = wasmStep('Planning the installment', () =>
    state.planInstallment(amount, firstWalletInput, nftReceiverScript),
  )
  try {
    const debtWitness = plan.debtWitness
    const successorDebtHash = plan.successorDebtHash
    const installment = plan.installment
    const successor = plan.successor
    // `A` and the collateral after one more step: the covenant's checks 3 and 6, checked here too
    const repaymentAsset = opened.pinned(wasm.PinnedRole.Repayment)
    if (
      installment.asset !== principalAsset ||
      installment.amount !== amount ||
      installment.assetCommitment !== repaymentAsset.assetCommitment ||
      successor.asset !== collateral.asset ||
      successor.amount !== collateral.amount ||
      successor.valueCommitment !== collateral.valueCommitment
    ) {
      throw new Error('The installment plan does not carry the loan')
    }

    // 4. The outputs. The successor loan's range proof is blinded to the lender's key, as the
    // contracts' `attach_installment` blinds it: its blinders are pinned (`collateral_after`),
    // which both parties derive, so the key only picks the range proof's nonce.
    const lenderBlindingKey = opened.lenderBlindingKey()
    const successorScript = offer.scripts.activeOfferAt(successorDebtHash)
    const principalAuth = pinnedAuthCovenant(deps, offer, 'principal')
    const repaymentAuth = pinnedAuthCovenant(deps, offer, 'repayment')
    const installmentAuth = pinnedAuthCovenant(deps, offer, 'installment')
    const lenderAddress = (script: string, what: string) =>
      new lwk.Address(
        wasmStep(`The ${what} address`, () =>
          wasm.confidentialAddress(script, lenderBlindingKey, deps.networkName),
        ),
      )
    const successorAddress = lenderAddress(successorScript.toString(), 'successor loan')
    const installmentAddress = lenderAddress(installmentAuth.script.toString(), 'installment')
    // The principal change goes to the wallet's internal chain, and the policy-asset change to the
    // next new internal address, so no two outputs share a script.
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
      // input 2 is the first wallet coin the plan was made from
      inputs,
      outputs: [
        // the receiver script the plan was made from
        {
          script: nftReceiverScript,
          asset: borrowerNft,
          amount: NFT_AMOUNT,
          blinding: { kind: 'explicit' },
        },
        {
          script: successorScript.toString(),
          asset: collateral.asset,
          amount: collateral.amount,
          blinding: { kind: 'pinned', blindingKey: lenderBlindingKey, pinned: successor },
        },
        {
          script: installmentAuth.script.toString(),
          asset: principalAsset,
          amount,
          blinding: { kind: 'pinned', blindingKey: lenderBlindingKey, pinned: installment },
        },
        ...changeOutputs,
      ],
      restrictedAssets: [borrowerNft, lenderNft],
      restrictedScripts: [
        offer.scripts.pendingOffer.toString(),
        offer.scripts.activeOffer.toString(),
        loanScript.toString(),
        successorScript.toString(),
        offer.scripts.lenderNftLock.toString(),
        principalAuth.script.toString(),
        repaymentAuth.script.toString(),
        installmentAuth.script.toString(),
      ],
      policyAsset: deps.assets.policy,
    }

    // The transactions of the wallet coins: finalization needs every prevout.
    const walletPrevoutTxs = await fetchPrevoutTxs(deps, walletInputs)

    // 5. The unblinded PSET: the inputs and the leading outputs in layout order.
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
          maxWeightToSatisfy: PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Installment,
        },
        ...walletCoins.map((coin, index) => walletCoinInput(deps, coin, walletPrevouts[index])),
      ],
      outputs: [
        {
          script: nftReceiver.scriptPubkey(),
          amount: NFT_AMOUNT,
          asset: lwk.AssetId.fromString(borrowerNft),
        },
        {
          script: successorAddress.scriptPubkey(),
          amount: collateral.amount,
          asset: lwk.AssetId.fromString(collateral.asset),
          blindingPubkey: successorAddress.blindingPubkey(),
        },
        {
          script: installmentAddress.scriptPubkey(),
          amount,
          asset: lwk.AssetId.fromString(principalAsset),
          blindingPubkey: installmentAddress.blindingPubkey(),
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

    // 6. The layout of the unblinded PSET.
    assertSpendLayout(deps, unblinded, layout, false, 'Installment')

    // 7. Blinding: the successor and the installment with the plan's blinders; the others fresh.
    const blindedBase64 = wasmStep('Blinding the installment', () =>
      wasm.blindPset(
        unblinded.toString(),
        [
          wasm.InputSecret.explicit(INSTALLMENT_INPUT.borrowerNft, borrowerNft, NFT_AMOUNT),
          state.loanInputSecret(INSTALLMENT_INPUT.loan),
          ...walletCoins.map((coin, index) =>
            walletInputSecret(deps, coin, INSTALLMENT_INPUT.firstWalletCoin + index),
          ),
        ],
        [
          plan.successorBlinding(INSTALLMENT_OUTPUT.loan),
          plan.installmentBlinding(INSTALLMENT_OUTPUT.installment),
        ],
      ),
    )
    const blinded = new lwk.Pset(blindedBase64)

    // 8. The layout again, now blinded.
    assertSpendLayout(deps, blinded, layout, true, 'Installment')
    const builtTx = new lwk.Pset(blindedBase64).extractTx()
    const builtTxid = builtTx.txid().toString()
    const remaining = owed - amount

    // 9. The installment read back as the borrower will read it from the chain. Neither the layout
    // checks nor the covenant look at output 2's range proof: if it did not open with the plan's
    // key, the installment would confirm and the borrower could no longer rebuild the debt.
    assertInstallmentReadsBack(offer, loan, params.lendingKey, builtTx.toString(), {
      loanOutpoint: `${builtTxid}:${INSTALLMENT_OUTPUT.loan}`,
      amount,
      remaining,
      successorDebtHash,
    })
    const prevouts = () => [
      requireOutput(nftTx, nftRef.vout, 'The borrower NFT'),
      requireOutput(loanTx, loanRef.vout, 'The loan'),
      ...prevoutsOf(walletPrevoutTxs, walletInputs),
    ]

    // 10. Sign (by the caller), then finalize the wallet inputs and the covenant.
    return {
      pset: blinded,
      finalize: signedPset => {
        const signed = deps.wollet.finalize(signedPset).extractTx()
        if (signed.txid().toString() !== builtTxid) {
          throw new Error('The signed installment is not the transaction that was built')
        }
        const finalizedTx = finalizePrivateOfferInput(
          deps,
          signed,
          offer,
          offer.scripts.activeSpendInfoAt(debtHash),
          prevouts(),
          INSTALLMENT_INPUT.loan,
          { branch: 'Installment', debt: debtWitness },
        )
        const txid = finalizedTx.txid().toString()
        if (txid !== builtTxid) throw new Error('Finalizing changed the installment')
        assertAllInputsFinalized(finalizedTx, 'The installment')

        return {
          finalizedTx,
          summary: {
            borrowerNftOutpoint: `${txid}:${INSTALLMENT_OUTPUT.borrowerNft}`,
            loanOutpoint: `${txid}:${INSTALLMENT_OUTPUT.loan}`,
            installmentOutpoint: `${txid}:${INSTALLMENT_OUTPUT.installment}`,
            amount,
            remaining,
            successorDebtHash,
          },
        }
      },
    }
  } finally {
    // the plan holds the installment's key
    plan.free()
  }
}

/**
 * Reads the loan again with the built installment `txHex` appended, with `key`, and requires what
 * the plan expects: one more installment, of `expected.amount`, the loan at its output 1 owing
 * `expected.remaining` under `expected.successorDebtHash`. Throws before anything is signed.
 */
export function assertInstallmentReadsBack(
  offer: VerifiedOffer,
  loan: Loan,
  key: LendingKey,
  txHex: string,
  expected: { loanOutpoint: string; amount: bigint; remaining: bigint; successorDebtHash: string },
): void {
  const after = wasmStep('Reading the installment back', () =>
    offer.opened.loanState(key, loan.acceptanceHex, [...loan.installmentHexes, txHex]),
  )
  try {
    const j = after.installmentCount
    const paid = j === loan.installmentHexes.length + 1 ? after.installment(j) : undefined
    let paidAmount: bigint | undefined
    try {
      paidAmount = paid?.amount
    } finally {
      paid?.free()
    }
    if (
      paidAmount !== expected.amount ||
      after.loanOutpoint !== expected.loanOutpoint ||
      after.remaining !== expected.remaining ||
      after.debtHash !== expected.successorDebtHash
    ) {
      throw new Error(
        'The installment does not read back as built: it was not signed. Its amount would not ' +
          'open with your key, and the loan could not be closed after it',
      )
    }
  } finally {
    after.free()
  }
}
