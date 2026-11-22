// The lender's liquidation of an expired private loan (`attach_liquidation` in the contracts'
// private lending core):
//   inputs   0 the loan (Liquidation branch), 1 the lender NFT, explicit; 2… the unclaimed
//            installments that open for the lender, each at asset_auth(lender NFT, 1, no burn);
//            then the lender's fee coins;
//   outputs  0 burns the lender NFT (OP_RETURN, explicit); 1 the collateral to the lender, blinded
//            to its wallet; 2 the swept installments' sum to the lender, blinded to its wallet, if
//            it sweeps any; then the policy-asset change and the fee.
// The covenant checks that the witness's debt hash is the one the loan's storage holds (which shows
// only that the loan is active), the lender NFT burn (input 1 to output 0), that the witness's
// expiry salt and expiry hash to its `EXPIRY_HASH`, and `check_lock_height` of that expiry: the
// transaction's nLockTime must be a height at least the expiry, and some input must not be final,
// or Simplicity reads the lock time as 0. As the contracts' core does, the witness carries the
// debt hash, the offer's salt and expiry, the lock time is the expiry and the loan input's
// sequence is ENABLE_LOCKTIME_NO_RBF; `buildPset`'s defaults (lock time 0, every sequence final)
// would fail. The debt hash is the loan's after its installments (`loan.state.debtHash`), which
// the lender knows from the chain without opening them.
// Consensus then admits the transaction from the block after the expiry, so the builder refuses,
// before building anything, while the tip is below the expiry.
// Burning the lender NFT leaves any unclaimed installment locked for good, so the liquidation
// sweeps those that open, each with its own opening. One that does not open has no known opening
// and stays where it is, a loss to the borrower who built it. Which installments are unclaimed is
// checked on chain against the lender NFT's claims (`lenderNftClaims`), as at the final claim.
// The collateral the loan holds is `c_k` of its step: the lender computes it when it reads every
// installment, and otherwise finds it by the search (`findCollateral`, in a Web Worker in the
// app), from the chain and its offer secrets alone: the loan output's value commitment is
// `c_k·A_c + x_k·G` (the design note's "Liquidation"). The carries stay with the borrower.
// The lender NFT is an explicit output at a wallet address, which LWK does not list among the
// wallet's coins, so it is spent as a plain input, not a wallet coin; the wallet still recognizes
// its script, and signs it.
import type { Address, WalletTxOut } from 'lwk_wasm'

import type { PsetOutputSpec } from '@/lwk/psetBuilder'
import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import {
  LIQUIDATION_INPUT,
  LIQUIDATION_OUTPUT,
  LOCK_TIME_ENABLING_SEQUENCE,
  LOCK_TIME_THRESHOLD,
  NFT_AMOUNT,
} from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import type { LoanState, PinnedOutputInfo } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from '../deps'
import { finalizePrivateOfferInput, pinnedAuthCovenant } from '../finalize'
import type { Loan } from '../loan'
import { walletInputSecret } from '../secrets'
import type { VerifiedOffer } from '../verify'
import {
  assertUnspentInstallments,
  fetchSweptOutputs,
  finalizeSweptInputs,
  lenderNftClaims,
  openedInstallmentAmounts,
  sweptInputSpecs,
  type SweptOutput,
} from './claimInstallments'
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

/** What the search for a loan's collateral takes: the wasm's `CollateralSearch`, as plain values. */
export interface CollateralSearchInput {
  /** `V_k`, the loan output's value commitment, hex. */
  valueCommitment: string
  /** `A_c`, the active collateral's asset commitment, hex. */
  assetCommitment: string
  /** `x_k`, the step's derived blinder, hex: a secret of the offer, which stays on the device. */
  blinder: string
  /** The search's bound, the offer's collateral `C`. */
  max: bigint
}

/**
 * Finds the collateral `c_k` in `[1, max]` that `search` describes, or undefined: the wasm's
 * `findCollateral`, run off the UI thread in the app (`findCollateralInWorker`).
 */
export type CollateralFinder = (search: CollateralSearchInput) => Promise<bigint | undefined>

/**
 * The collateral the loan of `state` holds: computed when the lender read every installment, and
 * otherwise found by `findCollateral` and set on `state` (`setCollateral`, which checks that it
 * opens the loan output). Throws when it cannot be found.
 */
export async function loanCollateral(
  state: LoanState,
  findCollateral: CollateralFinder | undefined,
): Promise<PinnedOutputInfo> {
  const known = state.collateral()
  if (known !== undefined) return known
  if (findCollateral === undefined) {
    throw new Error('An installment does not open for the lender, and no search was given')
  }
  const search = wasmStep('The collateral search', () => state.collateralSearch())
  const input: CollateralSearchInput = {
    valueCommitment: search.valueCommitment,
    assetCommitment: search.assetCommitment,
    blinder: search.blinder,
    max: search.max,
  }
  search.free()
  const found = await findCollateral(input)
  if (found === undefined) {
    throw new Error("The loan output holds no amount of the offer's collateral up to its terms")
  }
  wasmStep('Setting the collateral found', () => state.setCollateral(found))
  const collateral = state.collateral()
  if (collateral === undefined) throw new Error('The collateral found was not kept')
  return collateral
}

export interface LiquidationParams {
  /**
   * The lender NFT, an explicit output at a wallet address: the acceptance's output 2, or output 0
   * of the lender's last installment claim. The builder walks it back on chain to the acceptance.
   */
  lenderNftOutpoint: string
  /**
   * The installments of the loan still unspent, `"<installment txid>:2"`: exactly those no claim
   * of the lender NFT took, which the builder checks on chain. It sweeps those that open.
   */
  unspentInstallments: string[]
  /** The lender's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
  /** A confidential address: receives the collateral, blinded to it. */
  collateralReceiver: Address
  /** The chain tip's height. */
  tipHeight: number
  /**
   * The search for the collateral when an installment does not open for the lender
   * (`loanCollateral`); the app runs it in a Web Worker.
   */
  findCollateral?: CollateralFinder
}

export interface LiquidationSummary {
  /** The collateral to the lender: `"<txid>:1"`. */
  collateralOutpoint: string
  collateral: bigint
  /** The transaction's nLockTime: the loan expiration height. */
  lockTime: number
  /** The swept installments' sum to the lender, `"<txid>:2"`; undefined when none was swept. */
  installmentsOutpoint: string | undefined
  /** That sum, in principal units: 0 when none was swept. */
  installments: bigint
  /** The installments swept, in input order from input 2. */
  swept: string[]
}

/**
 * Builds the lender's liquidation of `loan` once it has expired, blinded and ready to sign: the
 * collateral, and the unclaimed installments that open. Throws `ExpiryNotReachedError` before
 * anything else while `tipHeight` is below the loan expiration. `finalize` finalizes the wallet
 * inputs (the lender NFT among them), then the loan (Liquidation), running the covenant on the
 * transaction, then each swept installment's asset_auth.
 */
export async function buildPrivateLiquidation(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  loan: Loan,
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
  const { state } = loan
  const lenderNft = opened.lenderNft()
  const principalAsset = opened.principalAsset()
  // Read now: `finalize` may run after the loan's state is freed.
  const debtHash = state.debtHash

  // 1. The covenant inputs, and the fee coins.
  const loanRef = parseOutpoint(state.loanOutpoint)
  const nftRef = parseOutpoint(params.lenderNftOutpoint)
  const loanInput = `${loanRef.txid}:${loanRef.vout}`
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  if (params.feeCoins.length === 0) throw new Error('A liquidation needs a fee coin')
  for (const coin of params.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }
  if (!params.collateralReceiver.isBlinded()) {
    throw new Error('The collateral must go to a confidential address')
  }
  // `c_k`: what the installments left of the offer's collateral.
  const collateral = await loanCollateral(state, params.findCollateral)
  if (
    collateral.asset !== opened.collateralAsset() ||
    collateral.amount <= 0n ||
    collateral.amount > opened.collateralAmount()
  ) {
    throw new Error('The loan does not hold the offer terms collateral')
  }

  // 2. The unclaimed installments that open, each with its own opening, in chain order.
  const sweep = wasmStep('Reading the installments', () =>
    state.sweep(undefined, params.unspentInstallments),
  )
  try {
    const claimed = await lenderNftClaims(deps, offer, loan, params.lenderNftOutpoint)
    assertUnspentInstallments(loan, claimed, params.unspentInstallments)
    const amounts = openedInstallmentAmounts(loan)
    const swept = sweep.outpoints().map((outpoint): SweptOutput => {
      const amount = amounts.get(outpoint)
      if (amount === undefined) throw new Error(`${outpoint} has no amount`)
      return { outpoint, lock: 'installment', amount }
    })
    const sweptAmount = sweep.amount
    const sweptInputs = swept.map(output => output.outpoint)
    const feeInputs = params.feeCoins.map(outpointOf)
    const inputs = [loanInput, nftInput, ...sweptInputs, ...feeInputs]
    if (new Set(inputs).size !== inputs.length) {
      throw new Error(
        'The loan, the lender NFT, the installments and the fee coins must be distinct',
      )
    }

    // 3. The loan, the lender NFT and the installments, fetched and checked. The loan's state
    // checked the loan output's commitments (`loadLoan`); its script must be the loan's at its
    // debt.
    const [loanTx, nftTx, sweptTxs] = await Promise.all([
      deps.fetchTx(loanRef.txid),
      deps.fetchTx(nftRef.txid),
      fetchSweptOutputs(deps, offer, swept),
    ])
    const loanScript = offer.scripts.activeOfferAt(debtHash)
    const loanOutput = requireOutput(loanTx, loanRef.vout, 'The loan')
    if (loanOutput.scriptPubkey().toString() !== loanScript.toString()) {
      throw new Error(`The loan output ${loanInput} is not locked to the loan's script at its debt`)
    }
    const nftOutput = requireOutput(nftTx, nftRef.vout, 'The lender NFT')
    if (
      nftOutput.asset()?.toString() !== lenderNft ||
      nftOutput.value() !== NFT_AMOUNT ||
      nftOutput.scriptPubkey().isProvablyUnspendable()
    ) {
      throw new Error('The lender NFT outpoint does not hold exactly the lender NFT, explicit')
    }

    // 4. The outputs, and the lock time with the sequence that enables it.
    const burn = burnScript(deps)
    const collateralReceiver = lwk.Address.parse(params.collateralReceiver.toString(), deps.network)
    const installmentsReceiver =
      swept.length > 0 ? deps.addresses.nextReceive(deps.wollet) : undefined
    const sweptOutputs: ExpectedOutput[] =
      installmentsReceiver === undefined
        ? []
        : [
            {
              script: installmentsReceiver.scriptPubkey().toString(),
              asset: principalAsset,
              amount: sweptAmount,
              blinding: { kind: 'fresh', receiver: installmentsReceiver },
            },
          ]
    const sweptOutputSpecs: PsetOutputSpec[] =
      installmentsReceiver === undefined
        ? []
        : [
            {
              script: installmentsReceiver.scriptPubkey(),
              amount: sweptAmount,
              asset: lwk.AssetId.fromString(principalAsset),
              blindingPubkey: installmentsReceiver.blindingPubkey(),
            },
          ]
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
          asset: collateral.asset,
          amount: collateral.amount,
          blinding: { kind: 'fresh', receiver: collateralReceiver },
        },
        ...sweptOutputs,
      ],
      restrictedAssets: [opened.borrowerNft(), lenderNft],
      restrictedScripts: [
        offer.scripts.pendingOffer.toString(),
        offer.scripts.activeOffer.toString(),
        loanScript.toString(),
        offer.scripts.lenderNftLock.toString(),
        pinnedAuthCovenant(deps, offer, 'principal').script.toString(),
        pinnedAuthCovenant(deps, offer, 'repayment').script.toString(),
        pinnedAuthCovenant(deps, offer, 'installment').script.toString(),
      ],
      policyAsset: deps.assets.policy,
      lockTime: {
        height: expiration,
        sequences: { [LIQUIDATION_INPUT.offer]: LOCK_TIME_ENABLING_SEQUENCE },
      },
    }

    // The transactions of the fee coins: finalization needs every prevout.
    const feePrevoutTxs = await fetchPrevoutTxs(deps, feeInputs)

    // 5. The unblinded PSET: the inputs and the leading outputs in layout order, the lock time at
    // the expiry and the loan input's sequence enabling it.
    const feePrevouts = prevoutsOf(feePrevoutTxs, feeInputs)
    const unblinded = buildUnblindedPset(deps, {
      inputs: [
        {
          outpoint: new lwk.OutPoint(loanInput),
          prevout: requireOutput(loanTx, loanRef.vout, 'The loan'),
          asset: lwk.AssetId.fromString(collateral.asset),
          amount: collateral.amount,
          secrets: pinnedTxOutSecrets(deps, collateral),
          sequence: LOCK_TIME_ENABLING_SEQUENCE,
          maxWeightToSatisfy: PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Liquidation,
        },
        {
          outpoint: new lwk.OutPoint(nftInput),
          prevout: requireOutput(nftTx, nftRef.vout, 'The lender NFT'),
          asset: lwk.AssetId.fromString(lenderNft),
          amount: NFT_AMOUNT,
          secrets: lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(lenderNft), NFT_AMOUNT),
          maxWeightToSatisfy: EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
        },
        ...sweptInputSpecs(deps, offer, swept, sweptTxs),
        ...params.feeCoins.map((coin, index) => walletCoinInput(deps, coin, feePrevouts[index])),
      ],
      outputs: [
        { script: burn, amount: NFT_AMOUNT, asset: lwk.AssetId.fromString(lenderNft) },
        {
          script: collateralReceiver.scriptPubkey(),
          amount: collateral.amount,
          asset: lwk.AssetId.fromString(collateral.asset),
          blindingPubkey: collateralReceiver.blindingPubkey(),
        },
        ...sweptOutputSpecs,
      ],
      changeAddress: deps.addresses.nextChange(deps.wollet, 1)[0],
      lockTime: expiration,
    })

    // 6. The layout of the unblinded PSET, with the lock time and the loan input's sequence.
    assertSpendLayout(deps, unblinded, layout, false, 'Liquidation')

    // 7. Blinding: the loan input with the collateral after its installments, each installment
    // with its own opening; every output is fresh.
    const firstFee = LIQUIDATION_INPUT.firstInstallment + swept.length
    const blindedBase64 = wasmStep('Blinding the liquidation', () =>
      wasm.blindPset(
        unblinded.toString(),
        [
          state.loanInputSecret(LIQUIDATION_INPUT.offer),
          wasm.InputSecret.explicit(LIQUIDATION_INPUT.lenderNft, lenderNft, NFT_AMOUNT),
          ...swept.map((_, position) =>
            sweep.inputSecret(position, LIQUIDATION_INPUT.firstInstallment + position),
          ),
          ...params.feeCoins.map((coin, index) => walletInputSecret(deps, coin, firstFee + index)),
        ],
        [],
      ),
    )
    const blinded = new lwk.Pset(blindedBase64)

    // 8. The layout again, now blinded.
    assertSpendLayout(deps, blinded, layout, true, 'Liquidation')
    const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
    const prevouts = () => [
      requireOutput(loanTx, loanRef.vout, 'The loan'),
      requireOutput(nftTx, nftRef.vout, 'The lender NFT'),
      ...prevoutsOf(sweptTxs, sweptInputs),
      ...prevoutsOf(feePrevoutTxs, feeInputs),
    ]
    const spendInfo = offer.scripts.activeSpendInfoAt(debtHash)
    const salt = opened.expirySalt()

    // 9. Sign (by the caller), then finalize the wallet inputs, the covenant and the installments.
    return {
      pset: blinded,
      finalize: signedPset => {
        const signed = deps.wollet.finalize(signedPset).extractTx()
        // the txid commits to the lock time and the sequences, which signing must not change
        if (signed.txid().toString() !== builtTxid) {
          throw new Error('The signed liquidation is not the transaction that was built')
        }
        const withLoan = finalizePrivateOfferInput(
          deps,
          signed,
          offer,
          spendInfo,
          prevouts(),
          LIQUIDATION_INPUT.offer,
          { branch: 'Liquidation', debtHash, salt, expiry: expiration },
        )
        const finalizedTx = finalizeSweptInputs(
          deps,
          withLoan,
          offer,
          swept,
          prevouts,
          LIQUIDATION_INPUT.firstInstallment,
          {
            inputIndex: LIQUIDATION_INPUT.lenderNft,
            outputIndex: LIQUIDATION_OUTPUT.lenderNftBurn,
          },
        )
        const txid = finalizedTx.txid().toString()
        if (txid !== builtTxid) throw new Error('Finalizing changed the liquidation')
        assertAllInputsFinalized(finalizedTx, 'The liquidation')

        return {
          finalizedTx,
          summary: {
            collateralOutpoint: `${txid}:${LIQUIDATION_OUTPUT.collateral}`,
            collateral: collateral.amount,
            lockTime: expiration,
            installmentsOutpoint:
              swept.length > 0 ? `${txid}:${LIQUIDATION_OUTPUT.installments}` : undefined,
            installments: sweptAmount,
            swept: sweptInputs,
          },
        }
      },
    }
  } finally {
    sweep.free()
  }
}
