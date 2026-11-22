// The borrower's installment on a private loan (`attach_installment` in the contracts' private
// lending core), a payment that leaves part of the debt and releases the collateral it pays for:
//   inputs   0 the borrower NFT, explicit; 1 the loan (Installment branch); 2… the borrower's
//            principal coins, then the loan's carries (the creation's carry supply before the
//            first installment, then the last installment's outputs 3 and 4), then its fee coins;
//   outputs  0 the borrower NFT back to the borrower, explicit, at a fresh receive address; 1 the
//            successor loan, holding `c' = ceil(d'·C/R)` of the collateral with the next step's
//            blinders; 2 the installment at asset_auth(lender NFT, 1, no burn), pinned and
//            blinded to the lender's key; 3 and 4 the carries `W1` and `W2`, `e + 1` and `R − e`
//            units at the principal's asset_auth, blinded to the borrower's key; 5 the collateral
//            released, `c_k − c'`, to the wallet, or when nothing is released one more
//            confidential output to the wallet (`R2_EXTRA_OUTPUT_AMOUNT` of the policy asset), so
//            that the count does not tell (proofs, R2); 6 at the first installment the
//            confidential burn of the carry supply's leftover, `S − R − 1`; then the principal
//            change to the wallet, if any, the policy-asset change and the fee.
// The covenant checks the loan's storage against the witness's debt `D`, the borrower NFT passing
// from input 0 to output 0, that output 2 is at the installment lock under `A`, the index of the
// loan's step, and the release proof: that output 1 holds `ceil(d'·C/R)` with the blinder `Y`
// commits to, with the remainder `e` carried by outputs 3 and 4 (the design note's statement).
// It does not check output 2's range proof: its nonce derives from the borrower's lending key,
// the loan outpoint, input 2 and output 0's script (`LoanState.planInstallment`), so that both
// parties rewind it from the chain. An installment built otherwise would confirm, and the
// borrower could no longer rebuild its debt from the seed and close the loan. So the plan is
// made from exactly input 2 and output 0's script, and both layout checks require them, and the
// built transaction is read back with the borrower's lending key before it is signed: it must
// give the loan the plan expects, and carries that open. That read rebuilds the borrower's key and
// never reads output 2's nonce, which the lender opens it with, so the blinded PSET's nonce must
// be the plan's ephemeral key too (`installmentNonceMatches`).
// Input 2 is the first principal coin, never a carry (proofs, O11): every build at one step
// spends the same carries, so a carry there would give every rebuild the same output-2 key. Two
// builds at one step share the successor's blinder, so a loan state is rebuilt only with the same
// amount, from a first wallet input no earlier build used (`installmentRebuildRefusal`).
// The borrower NFT is spent as a plain input, as in the full repayment, and unlocks the carries'
// asset_auth at input 0 and output 0. The builder pays no installment before the principal is
// claimed (`principalClaimedBefore`), nor from the expiry block on (`installmentTermOpen`), nor at
// step `MAX_LOAN_INSTALLMENTS`, where only the full repayment is left.
import type { PublicKey, WalletTxOut } from 'lwk_wasm'

import type { PsetOutputSpec } from '@/lwk/psetBuilder'
import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { ASSET_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'
import {
  CARRY_SUPPLY,
  INSTALLMENT_INPUT,
  INSTALLMENT_OUTPUT,
  MAX_LOAN_INSTALLMENTS,
  NFT_AMOUNT,
} from '@/simplicity/private-lending/layout'
import {
  type InstallmentWitness,
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY,
} from '@/simplicity/private-lending/witness'
import { normalizeHex } from '@/utils/hex'
import type { LendingKey, PinnedOutputInfo } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from '../deps'
import { finalizeAssetAuthInput, finalizePrivateOfferInput, pinnedAuthCovenant } from '../finalize'
import { inspectPset } from '../inspectPset'
import { borrowerLoanInputs, type Loan, type LoanCarry, verifiedLoanCarries } from '../loan'
import { checkedMessage } from '../messages'
import {
  type EarlierInstallment,
  INSTALLMENT_AFTER_TERM_NOTE,
  INSTALLMENT_LIMIT_NOTE,
  installmentRebuildRefusal,
  installmentTermOpen,
} from '../repayPlan'
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

/**
 * The policy asset the installment gives the borrower's wallet at output 5 when it releases no
 * collateral: one more confidential output in the release's place, so that the number of outputs
 * does not tell whether the installment released anything (proofs, R2). The contracts' tests give
 * the same amount.
 */
export const R2_EXTRA_OUTPUT_AMOUNT = 1_000n

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
  /** The borrower's policy-asset coins, which pay the fee and the extra output of R2. */
  feeCoins: WalletTxOut[]
  /**
   * The loan's carries as the indexer lists them unspent (`unspentCarries`), `"<txid>:<vout>"`:
   * the builder requires exactly the carries the loan opens on chain (`verifiedLoanCarries`).
   */
  carryOutpoints: readonly string[]
  /**
   * Every installment of this loan output that this browser saved, discarded or that failed, as
   * consensus hex (`installmentTraces`): the new build is a rebuild of them, so it must pay the
   * same amount from another first wallet input (`installmentRebuildRefusal`). Empty for the
   * first build of a loan state.
   */
  earlierBuilds: readonly string[]
  /**
   * The borrower's lending key, the one the loan was read with: the built installment is read back
   * with it before it is signed.
   */
  lendingKey: LendingKey
  /** The chain tip's height, read just before the build: below the loan expiry. */
  tipHeight: number
  /**
   * The borrower's private message to the lender, in the installment's range proof: at most
   * `MESSAGE_LIMITS.signed` UTF-8 bytes. An empty or blank one is none. It is signed for this
   * installment, the loan's `installmentCount + 1`-th.
   */
  message?: string
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
  /** The collateral released to the wallet, which can be 0. */
  release: bigint
  /** The release, `"<txid>:5"`; undefined when nothing is released (output 5 is then R2's). */
  releaseOutpoint: string | undefined
}

/**
 * Builds the borrower's installment of `params.amount` on the loan at `loan.state.loanOutpoint`,
 * blinded and ready to sign. Throws first for a message that does not fit, then
 * `InstallmentAfterTermError` once `params.tipHeight` has reached the loan expiry, then at the
 * loan's last step and for an amount the rebuild rule refuses, and `PrincipalNotClaimedError`
 * before building unless the borrower NFT comes from the principal claim. `finalize` finalizes
 * the wallet inputs (the borrower NFT among them), then the loan (Installment), running the
 * covenant on the transaction, then the carries' asset_auth.
 */
export async function buildPrivateInstallment(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  loan: Loan,
  params: InstallmentParams,
): Promise<UpdatedPset<InstallmentSummary>> {
  const { lwk, wasm } = deps
  if (offer.role !== 'borrower') throw new Error('Only the borrower pays an installment')
  const message = checkedMessage(params.message, 'signed')
  const opened = offer.opened
  const expiry = opened.loanExpirationTime()
  if (!Number.isInteger(params.tipHeight) || params.tipHeight <= 0) {
    throw new Error('The tip height must be a block height')
  }
  if (!installmentTermOpen(params.tipHeight, expiry)) {
    throw new InstallmentAfterTermError(expiry, params.tipHeight)
  }
  const { state } = loan
  if (state.installmentCount >= MAX_LOAN_INSTALLMENTS) throw new Error(INSTALLMENT_LIMIT_NOTE)
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
  if (collateral === undefined || collateral.asset !== opened.collateralAsset()) {
    throw new Error('The loan does not hold the offer collateral')
  }

  // 1. The wallet coins. Input 2 is the first principal coin.
  const nftRef = parseOutpoint(params.borrowerNftOutpoint)
  const loanRef = parseOutpoint(state.loanOutpoint)
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  const loanInput = `${loanRef.txid}:${loanRef.vout}`
  if (params.principalCoins.length === 0) throw new Error('An installment needs a principal coin')
  if (params.feeCoins.length === 0) throw new Error('An installment needs a fee coin')
  const principalInputs = params.principalCoins.map(outpointOf)
  const feeInputs = params.feeCoins.map(outpointOf)
  const firstWalletInput = principalInputs[0]

  // 2. The rebuild rule, against every earlier build of this loan state that may be public.
  const earlier = earlierInstallments(lwk, offer, loan, params.lendingKey, params.earlierBuilds)
  const refusal = installmentRebuildRefusal(earlier, amount, firstWalletInput)
  if (refusal !== undefined) throw new Error(refusal)

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

  // 3. The borrower NFT and the loan, fetched and tied to this offer, the NFT to the claim; then
  // the carries, checked on chain.
  const { nftTx, loanTx, loanScript } = await borrowerLoanInputs(
    deps,
    offer,
    loan,
    nftInput,
    'installment',
  )
  const carries = await verifiedLoanCarries(deps, offer, loan, params.carryOutpoints)
  const buildWithCarries = async (): Promise<UpdatedPset<InstallmentSummary>> => {
    const carryInputs = carries.map(carry => carry.outpoint)
    const inputs = [nftInput, loanInput, ...principalInputs, ...carryInputs, ...feeInputs]
    if (new Set(inputs).size !== inputs.length) {
      throw new Error(
        'The borrower NFT, the loan, the principal coins, the carries and the fee coins must be ' +
          'distinct',
      )
    }
    // O11: the first wallet input, from which output 2's key derives, is a principal coin.
    if (inputs[INSTALLMENT_INPUT.firstWalletCoin] !== firstWalletInput) {
      throw new Error('Input 2 of the installment must be its first principal coin')
    }
    if (carryInputs.includes(inputs[INSTALLMENT_INPUT.firstWalletCoin])) {
      throw new Error('A carry must never be input 2 of the installment')
    }
    const carryAsset = carries[0].asset
    const firstCarryInput = INSTALLMENT_INPUT.firstWalletCoin + principalInputs.length
    const firstFeeInput = firstCarryInput + carries.length

    // 4. The plan, from exactly input 2 and output 0's script: the borrower NFT goes back
    // explicit to the unconfidential form of a fresh receive address. The message is signed for
    // this installment just before the call that takes it (and consumes it).
    const nftReceiver = deps.addresses.nextReceive(deps.wollet).toUnconfidential()
    const nftReceiverScript = nftReceiver.scriptPubkey().toString()
    const installmentIndex = state.installmentCount + 1
    const creationTxid = offer.creationTx.txid().toString()
    const plan = wasmStep('Planning the installment', () =>
      state.planInstallment(
        amount,
        firstWalletInput,
        nftReceiverScript,
        message === undefined
          ? undefined
          : wasm.signMessage(
              params.lendingKey,
              creationTxid,
              wasm.MessagePhase.Installment,
              installmentIndex,
              message,
            ),
      ),
    )
    try {
      // Everything `finalize` needs of the plan is copied now: the plan is freed on return.
      const witness: InstallmentWitness = {
        debt: plan.debtWitness,
        index: plan.index,
        blinderCommitment: plan.blinderCommitment,
        path: [...plan.pathIsRight].map((isRight, k) => ({
          isRight: isRight === 1,
          sibling: plan.pathSiblings[k],
        })),
        commitments: plan.commitments,
        responses: plan.responses,
      }
      const successorDebtHash = plan.successorDebtHash
      const ephemeralPublicKey = plan.ephemeralPublicKey
      const installment = plan.installment
      const successor = plan.successor
      const planCarries = [plan.carry(0), plan.carry(1)]
      const release = plan.release
      const leftover = plan.leftover
      const leftoverBurn = plan.leftoverBurn
      // `A`, and the collateral of the next step: the covenant's checks, checked here too. The
      // release is the collateral the step lets go, as the repay form previews it.
      const repaymentAsset = opened.pinned(wasm.PinnedRole.Repayment)
      const carried = carries.reduce((sum, carry) => sum + carry.amount, 0n)
      const repayment = opened.repaymentAmount()
      if (
        witness.index !== state.installmentCount ||
        installment.asset !== principalAsset ||
        installment.amount !== amount ||
        installment.assetCommitment !== repaymentAsset.assetCommitment ||
        successor.asset !== collateral.asset ||
        release < 0n ||
        successor.amount !== collateral.amount - release ||
        release !== state.releasePreview(amount) ||
        planCarries.some(carry => carry.asset !== carryAsset) ||
        planCarries[0].amount + planCarries[1].amount !== repayment + 1n ||
        carried !== repayment + 1n + leftover ||
        (state.installmentCount === 0
          ? leftover !== CARRY_SUPPLY - repayment - 1n || leftoverBurn === undefined
          : leftover !== 0n || leftoverBurn !== undefined)
      ) {
        throw new Error('The installment plan does not carry the loan')
      }

      // 5. The outputs. The successor loan's range proof is blinded to the lender's key, as the
      // contracts' `attach_installment` blinds it: its blinders are pinned, which both parties
      // derive, so the key only picks the range proof's nonce. The carries and the leftover's burn
      // are blinded to the borrower's key, with which it rewinds them from the chain.
      const lenderBlindingKey = opened.lenderBlindingKey()
      const borrowerBlindingKey = opened.borrowerBlindingKey()
      const successorScript = offer.scripts.activeOfferAt(successorDebtHash)
      const principalAuth = pinnedAuthCovenant(deps, offer, 'principal')
      const repaymentAuth = pinnedAuthCovenant(deps, offer, 'repayment')
      const installmentAuth = pinnedAuthCovenant(deps, offer, 'installment')
      const pinnedAddress = (script: string, key: string, what: string) =>
        new lwk.Address(
          wasmStep(`The ${what} address`, () =>
            wasm.confidentialAddress(script, key, deps.networkName),
          ),
        )
      const successorAddress = pinnedAddress(
        successorScript.toString(),
        lenderBlindingKey,
        'successor loan',
      )
      const installmentAddress = pinnedAddress(
        installmentAuth.script.toString(),
        lenderBlindingKey,
        'installment',
      )
      const carryAddress = pinnedAddress(
        principalAuth.script.toString(),
        borrowerBlindingKey,
        'carry',
      )
      const burn = burnScript(deps)
      // The release (or R2's output in its place), the principal change and the policy-asset
      // change each go to a new internal address, so no two outputs share a script.
      const [releaseAddress, changeAddress, policyChangeAddress] = deps.addresses.nextChange(
        deps.wollet,
        3,
      )
      const releaseOutput =
        release > 0n
          ? { asset: collateral.asset, amount: release }
          : { asset: deps.assets.policy, amount: R2_EXTRA_OUTPUT_AMOUNT }
      const pinnedOutput = (
        script: string,
        key: string,
        pinned: PinnedOutputInfo,
      ): ExpectedOutput => ({
        script,
        asset: pinned.asset,
        amount: pinned.amount,
        blinding: { kind: 'pinned', blindingKey: key, pinned },
      })
      const trailing: ExpectedOutput[] = [
        {
          script: releaseAddress.scriptPubkey().toString(),
          ...releaseOutput,
          blinding: { kind: 'fresh', receiver: releaseAddress },
        },
        ...(leftoverBurn === undefined
          ? []
          : [pinnedOutput(burn.toString(), borrowerBlindingKey, leftoverBurn)]),
        ...(principalChange > 0n
          ? [
              {
                script: changeAddress.scriptPubkey().toString(),
                asset: principalAsset,
                amount: principalChange,
                blinding: { kind: 'fresh', receiver: changeAddress } as const,
              },
            ]
          : []),
      ]

      const layout: SpendLayout = {
        // input 2 is the first principal coin the plan was made from; the carries follow the
        // principal coins
        inputs,
        outputs: [
          // the receiver script the plan was made from
          {
            script: nftReceiverScript,
            asset: borrowerNft,
            amount: NFT_AMOUNT,
            blinding: { kind: 'explicit' },
          },
          pinnedOutput(successorScript.toString(), lenderBlindingKey, successor),
          pinnedOutput(installmentAuth.script.toString(), lenderBlindingKey, installment),
          pinnedOutput(principalAuth.script.toString(), borrowerBlindingKey, planCarries[0]),
          pinnedOutput(principalAuth.script.toString(), borrowerBlindingKey, planCarries[1]),
          ...trailing,
        ],
        restrictedAssets: [borrowerNft, lenderNft, carryAsset],
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

      // The transactions of the wallet coins and the carries: finalization needs every prevout.
      const spentInputs = [...principalInputs, ...carryInputs, ...feeInputs]
      const prevoutTxs = await fetchPrevoutTxs(deps, spentInputs)
      const principalPrevouts = () => prevoutsOf(prevoutTxs, principalInputs)
      const feePrevouts = () => prevoutsOf(prevoutTxs, feeInputs)

      // 6. The unblinded PSET: the inputs and the leading outputs in layout order.
      const outputSpec = (
        expected: ExpectedOutput,
        blindingPubkey?: PublicKey,
      ): PsetOutputSpec => ({
        script: new lwk.Script(expected.script),
        amount: expected.amount,
        asset: lwk.AssetId.fromString(expected.asset),
        ...(blindingPubkey === undefined ? {} : { blindingPubkey }),
      })
      const [nftOut, successorOut, installmentOut, w1Out, w2Out, ...trailingOut] = layout.outputs
      const blindingPubkeyOf = (expected: ExpectedOutput) => {
        if (expected.blinding.kind === 'fresh') return expected.blinding.receiver.blindingPubkey()
        if (expected.blinding.kind === 'pinned') {
          return lwk.PublicKey.fromString(expected.blinding.blindingKey)
        }
        return undefined
      }
      const principalCoinPrevouts = principalPrevouts()
      const feeCoinPrevouts = feePrevouts()
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
          ...params.principalCoins.map((coin, index) =>
            walletCoinInput(deps, coin, principalCoinPrevouts[index]),
          ),
          ...carries.map(carry => carryInputSpec(deps, carry)),
          ...params.feeCoins.map((coin, index) =>
            walletCoinInput(deps, coin, feeCoinPrevouts[index]),
          ),
        ],
        outputs: [
          outputSpec(nftOut),
          outputSpec(successorOut, successorAddress.blindingPubkey()),
          outputSpec(installmentOut, installmentAddress.blindingPubkey()),
          outputSpec(w1Out, carryAddress.blindingPubkey()),
          outputSpec(w2Out, carryAddress.blindingPubkey()),
          ...trailingOut.map(expected => outputSpec(expected, blindingPubkeyOf(expected))),
        ],
        changeAddress: policyChangeAddress,
      })

      // 7. The layout of the unblinded PSET.
      assertSpendLayout(deps, unblinded, layout, false, 'Installment')

      // 8. Blinding: the successor, the installment, the carries and the leftover's burn with the
      // plan's blinders (O7: exactly the outputs the plan proved); the others fresh.
      const leftoverBlindings = () => {
        const blinding = plan.leftoverBlinding(INSTALLMENT_OUTPUT.leftoverBurn)
        return blinding === undefined ? [] : [blinding]
      }
      const blindedBase64 = wasmStep('Blinding the installment', () =>
        wasm.blindPset(
          unblinded.toString(),
          [
            wasm.InputSecret.explicit(INSTALLMENT_INPUT.borrowerNft, borrowerNft, NFT_AMOUNT),
            state.loanInputSecret(INSTALLMENT_INPUT.loan),
            ...params.principalCoins.map((coin, index) =>
              walletInputSecret(deps, coin, INSTALLMENT_INPUT.firstWalletCoin + index),
            ),
            ...carries.map(({ carry }, index) => carry.inputSecret(firstCarryInput + index)),
            ...params.feeCoins.map((coin, index) =>
              walletInputSecret(deps, coin, firstFeeInput + index),
            ),
          ],
          [
            plan.successorBlinding(INSTALLMENT_OUTPUT.loan),
            plan.installmentBlinding(INSTALLMENT_OUTPUT.installment),
            plan.carryBlinding(0, INSTALLMENT_OUTPUT.carry),
            plan.carryBlinding(1, INSTALLMENT_OUTPUT.secondCarry),
            ...leftoverBlindings(),
          ],
        ),
      )
      const blinded = new lwk.Pset(blindedBase64)

      // 9. The layout again, now blinded: outputs 1 to 4, and the burn, carry the plan's
      // commitments.
      assertSpendLayout(deps, blinded, layout, true, 'Installment')
      const builtTx = new lwk.Pset(blindedBase64).extractTx()
      const builtTxid = builtTx.txid().toString()
      const remaining = owed - amount

      // 10. The installment read back as the parties will read it from the chain. Neither the
      // layout checks nor the covenant look at output 2's range proof: if it did not open with the
      // plan's key, the installment would confirm and the borrower could no longer rebuild the
      // debt, nor the lender open it from its nonce.
      if (!installmentNonceMatches(wasm, blindedBase64, ephemeralPublicKey)) {
        throw new Error(
          "The installment's nonce is not the planned one, so the lender could not open its " +
            'amount: it was not signed.',
        )
      }
      assertInstallmentReadsBack(offer, loan, params.lendingKey, builtTx.toString(), {
        loanOutpoint: `${builtTxid}:${INSTALLMENT_OUTPUT.loan}`,
        amount,
        remaining,
        successorDebtHash,
        collateral: successor.amount,
        carries: planCarries.map(carry => carry.amount),
        message,
      })
      const prevouts = () => [
        requireOutput(nftTx, nftRef.vout, 'The borrower NFT'),
        requireOutput(loanTx, loanRef.vout, 'The loan'),
        ...prevoutsOf(prevoutTxs, spentInputs),
      ]

      // 11. Sign (by the caller), then finalize the wallet inputs, the covenant and the carries.
      return {
        pset: blinded,
        finalize: signedPset => {
          const signed = deps.wollet.finalize(signedPset).extractTx()
          if (signed.txid().toString() !== builtTxid) {
            throw new Error('The signed installment is not the transaction that was built')
          }
          const withLoan = finalizePrivateOfferInput(
            deps,
            signed,
            offer,
            offer.scripts.activeSpendInfoAt(debtHash),
            prevouts(),
            INSTALLMENT_INPUT.loan,
            { branch: 'Installment', ...witness },
          )
          const finalizedTx = carryInputs.reduce(
            (tx, _, index) =>
              finalizeAssetAuthInput(
                deps,
                tx,
                offer,
                'principal',
                prevouts(),
                firstCarryInput + index,
                {
                  inputIndex: INSTALLMENT_INPUT.borrowerNft,
                  outputIndex: INSTALLMENT_OUTPUT.borrowerNft,
                },
              ),
            withLoan,
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
              release,
              releaseOutpoint: release > 0n ? `${txid}:${INSTALLMENT_OUTPUT.release}` : undefined,
            },
          }
        },
      }
    } finally {
      // the plan holds the installment's key
      plan.free()
    }
  }
  try {
    return await buildWithCarries()
  } finally {
    carries.forEach(({ carry }) => carry.free())
  }
}

/** A carry as a PSET input: its prevout as found on chain, unlocked by the borrower NFT. */
function carryInputSpec(deps: PrivateFlowDeps, carry: LoanCarry) {
  const { lwk } = deps
  return {
    outpoint: new lwk.OutPoint(carry.outpoint),
    prevout: carry.prevout,
    asset: lwk.AssetId.fromString(carry.asset),
    amount: carry.amount,
    maxWeightToSatisfy: ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
  }
}

/**
 * The earlier builds of this loan state, `txHexes` (`InstallmentParams.earlierBuilds`), as the
 * rebuild rule reads them: each one's first wallet input, and its amount read back with `key` as
 * the loan's next installment. A transaction that does not spend this loan output at input 1 is
 * not a build of this state, and is left out; one that spends it but does not read back keeps an
 * unknown amount, which the rule refuses.
 */
export function earlierInstallments(
  lwk: Pick<PrivateFlowDeps['lwk'], 'Transaction'>,
  offer: VerifiedOffer,
  loan: Loan,
  key: LendingKey,
  txHexes: readonly string[],
): EarlierInstallment[] {
  const builds: EarlierInstallment[] = []
  for (const hex of txHexes) {
    const tx = lwk.Transaction.fromString(hex)
    const spent = (index: number) => {
      const outpoint = tx.inputs[index]?.outpoint()
      return outpoint && `${outpoint.txid().toString()}:${outpoint.vout()}`
    }
    if (spent(INSTALLMENT_INPUT.loan) !== loan.state.loanOutpoint) continue
    let amount: bigint | undefined
    try {
      const after = offer.opened.loanState(key, loan.acceptanceHex, [...loan.installmentHexes, hex])
      try {
        const j = loan.installmentHexes.length + 1
        if (after.installmentCount === j) {
          const paid = after.installment(j)
          amount = paid.amount
          paid.free()
        }
      } finally {
        after.free()
      }
    } catch {
      amount = undefined
    }
    builds.push({
      txid: tx.txid().toString(),
      firstWalletInput: spent(INSTALLMENT_INPUT.firstWalletCoin),
      amount,
    })
  }
  return builds
}

/**
 * Whether output 2 of the blinded PSET `psetBase64`, the installment, carries the nonce
 * `ephemeralPublicKey` (a 33-byte compressed public key, hex): the plan's, with which the lender
 * opens the installment. It reads the output's ECDH key through the wasm's `inspectPset`: for an
 * output with a blinding key and blinded fields, which the blinded layout check requires of output
 * 2, rust-elements' `extract_tx` takes the transaction's nonce from that key. False, never a
 * throw, for a PSET that does not parse, has no output 2, or whose output 2 is not blinded.
 */
export function installmentNonceMatches(
  wasm: PrivateFlowDeps['wasm'],
  psetBase64: string,
  ephemeralPublicKey: string,
): boolean {
  let output
  try {
    output = inspectPset(wasm, psetBase64).outputs[INSTALLMENT_OUTPUT.installment]
  } catch {
    return false
  }
  return (
    output !== undefined &&
    output.blindingKey !== null &&
    output.ecdhPubkey !== null &&
    output.ecdhPubkey === normalizeHex(ephemeralPublicKey)
  )
}

/**
 * Reads the loan again with the built installment `txHex` appended, with `key`, and requires what
 * the plan expects: one more installment, of `expected.amount`, the loan at its output 1 owing
 * `expected.remaining` under `expected.successorDebtHash`; when given, the collateral
 * `expected.collateral` there and carries of `expected.carries` units that open with `key`, which
 * the next installment and the full repayment spend; and, when `expected.message` was sent, that
 * message, verified: signed by `key` for this installment of this offer. Throws before anything
 * is signed.
 */
export function assertInstallmentReadsBack(
  offer: VerifiedOffer,
  loan: Loan,
  key: LendingKey,
  txHex: string,
  expected: {
    loanOutpoint: string
    amount: bigint
    remaining: bigint
    successorDebtHash: string
    collateral?: bigint
    carries?: bigint[]
    message?: string
  },
): void {
  const after = wasmStep('Reading the installment back', () =>
    offer.opened.loanState(key, loan.acceptanceHex, [...loan.installmentHexes, txHex]),
  )
  try {
    const j = after.installmentCount
    const paid = j === loan.installmentHexes.length + 1 ? after.installment(j) : undefined
    let paidAmount: bigint | undefined
    let messageReadsBack = expected.message === undefined
    try {
      paidAmount = paid?.amount
      if (paid !== undefined && expected.message !== undefined) {
        const read = paid.message
        try {
          messageReadsBack = read?.verified === true && read.text === expected.message
        } finally {
          read?.free()
        }
      }
    } finally {
      paid?.free()
    }
    // The count and the amount first: when they fail, the message cannot read back either, and
    // the amount is what matters.
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
    if (expected.collateral !== undefined) {
      const collateral = after.collateral()
      const held = collateral?.amount
      collateral?.free()
      if (held !== expected.collateral) {
        throw new Error(
          'The installment does not read back as built: it was not signed. The loan would not ' +
            'hold the collateral the installment leaves',
        )
      }
    }
    if (expected.carries !== undefined) {
      let amounts: bigint[] | undefined
      try {
        const carries = after.carries()
        amounts = carries.map(carry => carry.amount)
        carries.forEach(carry => carry.free())
      } catch {
        amounts = undefined
      }
      if (
        amounts === undefined ||
        amounts.length !== expected.carries.length ||
        amounts.some((amount, i) => amount !== expected.carries?.[i])
      ) {
        throw new Error(
          'The installment does not read back as built: it was not signed. Its carries would not ' +
            'open with your key, and the loan could take no further installment nor be repaid',
        )
      }
    }
    if (!messageReadsBack) {
      throw new Error(
        'The installment does not read back as built: it was not signed. Its message does not ' +
          'read back as yours',
      )
    }
  } finally {
    after.free()
  }
}
