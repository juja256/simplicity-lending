// The borrower's full repayment of what a private loan still owes (`attach_full_repayment` and
// `attach_carry_sweep` in the contracts' private lending core):
//   inputs   0 the borrower NFT, explicit; 1 the loan (FullRepayment branch); 2… the borrower's
//            principal coins, then the loan's carries (the creation's carry supply before any
//            installment, then the last installment's outputs 3 and 4), then its fee coins;
//   outputs  0 burns the borrower NFT (OP_RETURN, explicit); 1 the repayment at asset_auth(lender
//            NFT, 1, burn), pinned and blinded to the lender's key; 2 the collateral the loan
//            holds now, `c_k`, back to the borrower, blinded to its wallet; 3 the confidential burn
//            of every carry unit (OP_RETURN, blinded to the borrower's key with the range proof of
//            every other confidential output, so that it does not reveal `R + 1`: proofs, O10);
//            4 the principal change to the wallet, if any; then the policy-asset change and the
//            fee.
// The covenant checks that the witness's debt hash is the one the loan's storage holds, the
// borrower NFT burn (input 0 to output 0) and that the repayment at output 1 has that debt hash; it
// leaves the collateral to the spender. The repayment is the debt itself: the amount still owed
// under the repayment's asset commitment `A`, with the debt's blinder, so that its value
// commitment is the debt `D` of the loan's state. Before any installment, that is the pinned
// repayment.
// The contract does not require the carries' sweep, but the borrower NFT, which this transaction
// burns, is the only key to their asset_auth: left out, they would stay locked for ever. The
// no-burn lock accepts the NFT's burn at output 0.
// The borrower NFT is an explicit output at a wallet address, which LWK does not list among the
// wallet's coins, so it is spent as a plain input, not a wallet coin; the wallet still recognizes
// its script, and signs it. `buildPset` adds only the policy-asset change, after the given outputs,
// so the builder pays the principal change itself, at output 4.
// The covenant does not check that the principal was claimed, and the borrower NFT is the only key
// to an unclaimed principal (asset_auth(borrower NFT, 1, no burn)): burning it first would strand
// the principal forever. So the builder spends the NFT only once it comes from the principal
// claim, checked on chain (`principalClaimedBefore`), whatever the indexer says.
import type { Address, WalletTxOut } from 'lwk_wasm'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { ASSET_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'
import { NFT_AMOUNT, REPAYMENT_INPUT, REPAYMENT_OUTPUT } from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from '../deps'
import { finalizeAssetAuthInput, finalizePrivateOfferInput, pinnedAuthCovenant } from '../finalize'
import { borrowerLoanInputs, type Loan, verifiedLoanCarries } from '../loan'
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
  /**
   * The loan's carries as the indexer lists them unspent (`unspentCarries`), `"<txid>:<vout>"`:
   * the builder requires exactly the carries the loan opens on chain (`verifiedLoanCarries`), and
   * burns them.
   */
  carryOutpoints: readonly string[]
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
  /** The collateral the loan held, `c_k`: what its installments did not release. */
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
 * among them), then the loan (FullRepayment), running the covenant on the transaction, then the
 * carries' asset_auth.
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
  // An installment never pays the whole debt, so a loan read never owes nothing.
  if (owed === 0n) throw new Error('Nothing is owed on this loan')
  // Read now: `finalize` may run after the loan's state is freed.
  const debtHash = state.debtHash
  const debtCommitment = state.debtCommitment
  const collateral = state.collateral()
  if (collateral === undefined) throw new Error('The collateral the loan holds is unknown')

  // 1. The wallet coins.
  const nftRef = parseOutpoint(params.borrowerNftOutpoint)
  const loanRef = parseOutpoint(state.loanOutpoint)
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  const loanInput = `${loanRef.txid}:${loanRef.vout}`
  if (params.principalCoins.length === 0) throw new Error('A repayment needs a principal coin')
  if (params.feeCoins.length === 0) throw new Error('A repayment needs a fee coin')
  const principalInputs = params.principalCoins.map(outpointOf)
  const feeInputs = params.feeCoins.map(outpointOf)
  // `A`, which the repayment carries: the pinned repayment's asset commitment. The collateral is
  // what the installments left of the offer's.
  const repaymentAsset = opened.pinned(wasm.PinnedRole.Repayment)
  if (
    repaymentAsset.asset !== principalAsset ||
    collateral.asset !== opened.collateralAsset() ||
    collateral.amount <= 0n ||
    collateral.amount > opened.collateralAmount()
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

  // 2. The borrower NFT and the loan, fetched and tied to this offer, the NFT to the claim; then
  // the carries, checked on chain, and their burn, whose blinders are drawn once for the build.
  const { nftTx, loanTx, loanScript } = await borrowerLoanInputs(
    deps,
    offer,
    loan,
    nftInput,
    'repayment',
  )
  const carries = await verifiedLoanCarries(deps, offer, loan, params.carryOutpoints)
  let sweep
  try {
    sweep = wasmStep("The carries' burn", () => state.carrySweep())
  } catch (error) {
    carries.forEach(({ carry }) => carry.free())
    throw error
  }
  const carryBurn = sweep.burn
  const carryInputs = carries.map(carry => carry.outpoint)
  const firstCarryInput = REPAYMENT_INPUT.offer + 1 + principalInputs.length
  const firstFeeInput = firstCarryInput + carries.length
  const inputs = [nftInput, loanInput, ...principalInputs, ...carryInputs, ...feeInputs]
  let blindedBase64: string
  let layout: SpendLayout
  let prevoutTxs: Awaited<ReturnType<typeof fetchPrevoutTxs>>
  const spentInputs = [...principalInputs, ...carryInputs, ...feeInputs]
  try {
    if (new Set(inputs).size !== inputs.length) {
      throw new Error(
        'The borrower NFT, the loan, the principal coins, the carries and the fee coins must be ' +
          'distinct',
      )
    }
    const carryAsset = carries[0].asset
    if (
      carryBurn.asset !== carryAsset ||
      carryBurn.amount !== carries.reduce((sum, carry) => sum + carry.amount, 0n)
    ) {
      throw new Error("The carries' burn does not burn every carry unit")
    }

    // 3. The outputs: the repayment is the debt, pinned, and carries the lender's blinding key;
    // the carries' burn is pinned to the sweep's blinders and carries the borrower's.
    const lenderBlindingKey = opened.lenderBlindingKey()
    const borrowerBlindingKey = opened.borrowerBlindingKey()
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
    // The principal change goes to the wallet's internal chain, confidential, so it never shares
    // a script with the receiver (an external address). The policy-asset change takes the next
    // new internal address, so the two changes never share one either.
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

    layout = {
      // the carries follow the principal coins
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
        {
          script: burn.toString(),
          asset: carryAsset,
          amount: carryBurn.amount,
          blinding: { kind: 'pinned', blindingKey: borrowerBlindingKey, pinned: carryBurn },
        },
        ...changeOutputs,
      ],
      restrictedAssets: [borrowerNft, lenderNft, carryAsset],
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

    // The transactions of the wallet coins and the carries: finalization needs every prevout.
    prevoutTxs = await fetchPrevoutTxs(deps, spentInputs)

    // 4. The unblinded PSET: the inputs and the leading outputs in layout order.
    const principalPrevouts = prevoutsOf(prevoutTxs, principalInputs)
    const feePrevouts = prevoutsOf(prevoutTxs, feeInputs)
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
        ...params.principalCoins.map((coin, index) =>
          walletCoinInput(deps, coin, principalPrevouts[index]),
        ),
        ...carries.map(carry => ({
          outpoint: new lwk.OutPoint(carry.outpoint),
          prevout: carry.prevout,
          asset: lwk.AssetId.fromString(carry.asset),
          amount: carry.amount,
          maxWeightToSatisfy: ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
        })),
        ...params.feeCoins.map((coin, index) => walletCoinInput(deps, coin, feePrevouts[index])),
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
        {
          script: burn,
          amount: carryBurn.amount,
          asset: lwk.AssetId.fromString(carryAsset),
          blindingPubkey: lwk.PublicKey.fromString(borrowerBlindingKey),
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
    // before the call that takes it (and consumes it), and the carries' burn with the sweep's
    // blinders; the other outputs fresh.
    const creationTxid = offer.creationTx.txid().toString()
    blindedBase64 = wasmStep('Blinding the repayment', () =>
      wasm.blindPset(
        unblinded.toString(),
        [
          wasm.InputSecret.explicit(REPAYMENT_INPUT.borrowerNft, borrowerNft, NFT_AMOUNT),
          state.loanInputSecret(REPAYMENT_INPUT.offer),
          ...params.principalCoins.map((coin, index) =>
            walletInputSecret(deps, coin, REPAYMENT_INPUT.offer + 1 + index),
          ),
          ...carries.map(({ carry }, index) => carry.inputSecret(firstCarryInput + index)),
          ...params.feeCoins.map((coin, index) =>
            walletInputSecret(deps, coin, firstFeeInput + index),
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
          sweep.blinding(REPAYMENT_OUTPUT.carryBurn),
        ],
      ),
    )
  } finally {
    sweep.free()
    carries.forEach(({ carry }) => carry.free())
  }
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded: the burn carries the sweep's commitments.
  assertSpendLayout(deps, blinded, layout, true, 'Repayment')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(nftTx, nftRef.vout, 'The borrower NFT'),
    requireOutput(loanTx, loanRef.vout, 'The loan'),
    ...prevoutsOf(prevoutTxs, spentInputs),
  ]
  const interest = opened.repaymentAmount() - opened.principalAmount()
  const collateralAmount = collateral.amount

  // 8. Sign (by the caller), then finalize the wallet inputs, the covenant and the carries.
  return {
    pset: blinded,
    finalize: signedPset => {
      const signed = deps.wollet.finalize(signedPset).extractTx()
      if (signed.txid().toString() !== builtTxid) {
        throw new Error('The signed repayment is not the transaction that was built')
      }
      const withLoan = finalizePrivateOfferInput(
        deps,
        signed,
        offer,
        offer.scripts.activeSpendInfoAt(debtHash),
        prevouts(),
        REPAYMENT_INPUT.offer,
        { branch: 'FullRepayment', debtHash },
      )
      // the no-burn lock accepts the borrower NFT's burn at output 0
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
              inputIndex: REPAYMENT_INPUT.borrowerNft,
              outputIndex: REPAYMENT_OUTPUT.borrowerNftBurn,
            },
          ),
        withLoan,
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
