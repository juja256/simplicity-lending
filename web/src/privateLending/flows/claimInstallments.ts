// The lender's claims of the outputs locked to its lender NFT: the installments, and at the final
// claim the full repayment after them (`claimRepayment.ts`):
//   inputs   0 the lender NFT, explicit; 1… the locked outputs, each at its asset_auth (an
//            installment at (lender NFT, 1, no burn), the repayment at (lender NFT, 1, burn)); then
//            the lender's fee coins;
//   outputs  0 the lender NFT back to the lender, explicit, at a fresh receive address, or burned
//            at the final claim (OP_RETURN, explicit); 1 what was claimed, to the lender, blinded
//            to its wallet; then the policy-asset change and the fee.
// Each asset_auth checks only that the lender NFT passes from input 0 to output 0, and the no-burn
// lock accepts the burn as the NFT's output. Every locked output carries the repayment asset
// commitment `A`, so the claim balances on the sum of their openings: a claim of installments
// gives each the opening the lender rewinds from its range proof, and the final claim gives the
// first output the combined opening and the others zero (`LoanState.sweep`).
// The lender NFT is an explicit output at a wallet address, which LWK does not list among the
// wallet's coins, so it is spent as a plain input; the wallet still recognizes its script, and
// signs it. Before it is spent, it is walked back on chain through the lender's earlier claims to
// where the acceptance put it (`lenderNftClaims`), which shows which installments the lender took.
import type { Transaction, TxOut, WalletTxOut } from 'lwk_wasm'

import type { PsetInputSpec } from '@/lwk/psetBuilder'
import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import {
  ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY,
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
} from '@/simplicity/asset-auth/witness'
import {
  ACCEPTANCE_OUTPUT,
  CLAIM_INPUT,
  CLAIM_OUTPUT,
  INSTALLMENT_OUTPUT,
  NFT_AMOUNT,
} from '@/simplicity/private-lending/layout'
import type { Sweep } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from '../deps'
import { finalizeAssetAuthInput, pinnedAuthCovenant } from '../finalize'
import { type Loan, MAX_INSTALLMENTS } from '../loan'
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
  prevoutsOf,
  requireOutput,
  type SpendLayout,
  walletCoinInput,
  wasmStep,
} from './shared'

export interface InstallmentClaimParams {
  /**
   * The installments to claim, `"<installment txid>:2"`: installments of `loan` that open with the
   * lender's key and that no claim of the lender NFT took yet.
   */
  installments: string[]
  /**
   * The lender NFT, an explicit output at a wallet address: the acceptance's output 2, or output 0
   * of the lender's last installment claim. The builder walks it back on chain to the acceptance.
   */
  lenderNftOutpoint: string
  /** The lender's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
}

export interface ClaimSummary {
  /** What was claimed, in the wallet: `"<txid>:1"`. */
  claimedOutpoint: string
  /** Its amount, in principal units. */
  claimed: bigint
  /** The locked outputs the claim spent, in input order from input 1. */
  swept: string[]
  /**
   * The lender NFT back in the wallet, `"<txid>:0"`; undefined at the final claim, which burns
   * it.
   */
  lenderNftOutpoint: string | undefined
}

/** An output a claim or a liquidation sweeps, and what its PSET input declares. */
export interface SweptOutput {
  /** `"<txid>:<vout>"`. */
  outpoint: string
  /** Its asset_auth: an installment's (no burn) or the full repayment's (burn). */
  lock: 'installment' | 'repayment'
  /**
   * The amount of the secrets it is spent with: its own amount, or at the final claim the total on
   * the first output and 0 on the others.
   */
  amount: bigint
}

function spentAt(tx: Transaction, input: number): string | undefined {
  const outpoint = tx.inputs[input]?.outpoint()
  return outpoint && `${outpoint.txid().toString()}:${outpoint.vout()}`
}

/** Whether `output` holds exactly one explicit unit of the lender NFT, not burned. */
function holdsLenderNft(offer: VerifiedOffer, output: TxOut | undefined): boolean {
  return (
    output !== undefined &&
    output.asset()?.toString() === offer.opened.lenderNft() &&
    output.value() === NFT_AMOUNT &&
    !output.scriptPubkey().isProvablyUnspendable()
  )
}

/** The outpoints of `loan`'s installments, `"<txid>:2"`, in chain order. */
export function installmentOutpoints(loan: Loan): string[] {
  return loan.installmentTxids.map(txid => `${txid}:${INSTALLMENT_OUTPUT.installment}`)
}

/**
 * The installments of `loan` that the lender NFT at `lenderNftOutpoint` claimed on its way from
 * the acceptance, each mapped to the claim that took it. The walk goes back through the claims:
 * each holds the NFT at output 0, explicit and unburned, takes it from its input 0 and spends at
 * least one installment of the loan; it ends at the acceptance's output 2, where the acceptance
 * put the NFT. Throws, naming the outpoint, if the walk meets anything else: the outpoint is then
 * not this loan's lender NFT, or the NFT moved in a way the app does not follow.
 */
export async function lenderNftClaims(
  deps: Pick<PrivateFlowDeps, 'fetchTx'>,
  offer: VerifiedOffer,
  loan: Loan,
  lenderNftOutpoint: string,
): Promise<Map<string, string>> {
  const origin = `${loan.acceptanceTxid}:${ACCEPTANCE_OUTPUT.lenderNft}`
  const installments = new Set(installmentOutpoints(loan))
  const claimed = new Map<string, string>()
  const start = parseOutpoint(lenderNftOutpoint)
  let at = `${start.txid}:${start.vout}`
  for (let step = 0; at !== origin; step += 1) {
    if (step > MAX_INSTALLMENTS) {
      throw new Error(`The lender NFT at ${lenderNftOutpoint} went through too many claims`)
    }
    const { txid, vout } = parseOutpoint(at)
    const tx = await deps.fetchTx(txid)
    if (tx.txid().toString() !== txid) throw new Error(`Fetched another transaction than ${txid}`)
    if (vout !== CLAIM_OUTPUT.lenderNft || !holdsLenderNft(offer, tx.outputs[vout])) {
      throw new Error(
        `${at} does not hold the lender NFT as this loan's acceptance or a claim of its ` +
          'installments does',
      )
    }
    const taken = tx.inputs
      .slice(CLAIM_INPUT.firstLocked)
      .map(input => `${input.outpoint().txid().toString()}:${input.outpoint().vout()}`)
      .filter(outpoint => installments.has(outpoint))
    const previous = spentAt(tx, CLAIM_INPUT.lenderNft)
    if (taken.length === 0 || previous === undefined) {
      throw new Error(`${txid} holds the lender NFT but claims no installment of this loan`)
    }
    for (const outpoint of taken) claimed.set(outpoint, txid)
    at = previous
  }
  return claimed
}

/**
 * Checks `unspent`, the installments the caller (from the indexer) lists as unspent, against the
 * lender NFT's claims: every installment of `loan` that no claim took must be listed, or the
 * transaction that burns the lender NFT would leave it stranded, and none that a claim took may be.
 */
export function assertUnspentInstallments(
  loan: Loan,
  claimed: Map<string, string>,
  unspent: string[],
): void {
  const listed = new Set(
    unspent.map(outpoint => {
      const { txid, vout } = parseOutpoint(outpoint)
      return `${txid}:${vout}`
    }),
  )
  const installments = installmentOutpoints(loan)
  for (const outpoint of listed) {
    if (!installments.includes(outpoint)) {
      throw new Error(`${outpoint} is not an installment of this loan`)
    }
    const claim = claimed.get(outpoint)
    if (claim !== undefined) {
      throw new Error(`${outpoint} is listed as unspent, but the lender's claim ${claim} spent it`)
    }
  }
  for (const outpoint of installments) {
    if (!listed.has(outpoint) && !claimed.has(outpoint)) {
      throw new Error(
        `Installment ${outpoint} is neither listed as unspent nor claimed by the lender NFT: ` +
          'burning the NFT now would leave it stranded',
      )
    }
  }
}

/** The amount of each installment of `loan` that opened for its party, by outpoint. */
export function openedInstallmentAmounts(loan: Loan): Map<string, bigint> {
  const amounts = new Map<string, bigint>()
  for (let j = 1; j <= loan.state.installmentCount; j += 1) {
    const installment = loan.state.installment(j)
    if (installment.amount !== undefined) amounts.set(installment.outpoint, installment.amount)
    installment.free()
  }
  return amounts
}

/**
 * The transactions of the swept outputs, fetched, with each output checked to be at its lock: an
 * installment at the offer's installment asset_auth, the repayment at its repayment asset_auth.
 */
export async function fetchSweptOutputs(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  swept: SweptOutput[],
): Promise<Map<string, Transaction>> {
  const scripts = {
    installment: pinnedAuthCovenant(deps, offer, 'installment').script.toString(),
    repayment: pinnedAuthCovenant(deps, offer, 'repayment').script.toString(),
  }
  const outpoints = swept.map(output => output.outpoint)
  const txs = await fetchPrevoutTxs(deps, outpoints)
  prevoutsOf(txs, outpoints).forEach((prevout, position) => {
    const { outpoint, lock } = swept[position]
    if (prevout.scriptPubkey().toString() !== scripts[lock]) {
      throw new Error(`${outpoint} is not locked to the offer's ${lock} asset_auth`)
    }
  })
  return txs
}

/** The PSET inputs of the swept outputs, under the principal asset, in `swept` order. */
export function sweptInputSpecs(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  swept: SweptOutput[],
  txs: Map<string, Transaction>,
): PsetInputSpec[] {
  const { lwk } = deps
  const outpoints = swept.map(output => output.outpoint)
  const prevouts = prevoutsOf(txs, outpoints)
  return swept.map((output, position) => ({
    outpoint: new lwk.OutPoint(output.outpoint),
    prevout: prevouts[position],
    asset: lwk.AssetId.fromString(offer.opened.principalAsset()),
    amount: output.amount,
    maxWeightToSatisfy:
      output.lock === 'installment'
        ? ASSET_AUTH_MAX_WEIGHT_TO_SATISFY
        : ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY,
  }))
}

/**
 * Finalizes the swept inputs, from input `firstInput` in `swept` order, each at its own asset_auth
 * with the lender NFT going from input `nft.inputIndex` to output `nft.outputIndex`. `prevouts`
 * gives a fresh array of every input's prevout for each call.
 */
export function finalizeSweptInputs(
  deps: PrivateFlowDeps,
  tx: Transaction,
  offer: VerifiedOffer,
  swept: SweptOutput[],
  prevouts: () => TxOut[],
  firstInput: number,
  nft: { inputIndex: number; outputIndex: number },
): Transaction {
  return swept.reduce(
    (finalized, output, position) =>
      finalizeAssetAuthInput(
        deps,
        finalized,
        offer,
        output.lock,
        prevouts(),
        firstInput + position,
        nft,
      ),
    tx,
  )
}

/**
 * Builds a lender claim of `swept`, the outputs of `sweep` in its order, blinded and ready to
 * sign: the lender NFT at input 0, back to the lender at output 0 or burned (`burn`), and the
 * sweep's total to the lender at output 1. The caller keeps `sweep` alive until this returns, and
 * frees it.
 */
export async function buildLenderClaim(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  loan: Loan,
  spec: {
    sweep: Sweep
    swept: SweptOutput[]
    lenderNftOutpoint: string
    feeCoins: WalletTxOut[]
    burn: boolean
    label: string
  },
): Promise<UpdatedPset<ClaimSummary>> {
  const { lwk, wasm } = deps
  const { sweep, swept, burn, label } = spec
  const opened = offer.opened
  const lenderNft = opened.lenderNft()
  const principalAsset = opened.principalAsset()
  const claimed = sweep.amount
  if (swept.length === 0) throw new Error(`${label}: nothing to claim`)
  if (swept.reduce((total, output) => total + output.amount, 0n) !== claimed) {
    throw new Error(`${label}: the swept outputs do not add up to the sweep's total`)
  }

  // 1. The inputs.
  const nftRef = parseOutpoint(spec.lenderNftOutpoint)
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  if (spec.feeCoins.length === 0) throw new Error(`${label}: a fee coin is needed`)
  for (const coin of spec.feeCoins) {
    if (coin.unblinded().asset().toString() !== deps.assets.policy) {
      throw new Error(`Fee coin ${outpointOf(coin)} is not the policy asset`)
    }
  }
  const feeInputs = spec.feeCoins.map(outpointOf)
  const lockedInputs = swept.map(output => output.outpoint)
  const inputs = [nftInput, ...lockedInputs, ...feeInputs]
  if (new Set(inputs).size !== inputs.length) {
    throw new Error(
      `${label}: the lender NFT, the claimed outputs and the fee coins must be distinct`,
    )
  }

  // 2. The lender NFT and the locked outputs, fetched and checked.
  const [nftTx, sweptTxs] = await Promise.all([
    deps.fetchTx(nftRef.txid),
    fetchSweptOutputs(deps, offer, swept),
  ])
  if (!holdsLenderNft(offer, requireOutput(nftTx, nftRef.vout, 'The lender NFT'))) {
    throw new Error('The lender NFT outpoint does not hold exactly the lender NFT, explicit')
  }

  // 3. The outputs: the claimed total to a fresh receive address, blinded to it, and the NFT back
  // to another one, explicit, unless it is burned.
  const claimReceiver = deps.addresses.nextReceive(deps.wollet)
  const nftScript = burn
    ? burnScript(deps)
    : deps.addresses.nextReceive(deps.wollet).toUnconfidential().scriptPubkey()
  const restrictedScripts = [
    offer.scripts.pendingOffer.toString(),
    offer.scripts.activeOffer.toString(),
    offer.scripts.activeOfferAt(loan.state.debtHash).toString(),
    offer.scripts.lenderNftLock.toString(),
    pinnedAuthCovenant(deps, offer, 'principal').script.toString(),
    pinnedAuthCovenant(deps, offer, 'repayment').script.toString(),
    pinnedAuthCovenant(deps, offer, 'installment').script.toString(),
  ]
  const leading: ExpectedOutput[] = [
    {
      script: nftScript.toString(),
      asset: lenderNft,
      amount: NFT_AMOUNT,
      blinding: { kind: 'explicit' },
    },
    {
      script: claimReceiver.scriptPubkey().toString(),
      asset: principalAsset,
      amount: claimed,
      blinding: { kind: 'fresh', receiver: claimReceiver },
    },
  ]
  const layout: SpendLayout = {
    inputs,
    outputs: leading,
    restrictedAssets: [opened.borrowerNft(), lenderNft],
    restrictedScripts,
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
        prevout: requireOutput(nftTx, nftRef.vout, 'The lender NFT'),
        asset: lwk.AssetId.fromString(lenderNft),
        amount: NFT_AMOUNT,
        secrets: lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(lenderNft), NFT_AMOUNT),
        maxWeightToSatisfy: EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
      },
      ...sweptInputSpecs(deps, offer, swept, sweptTxs),
      ...spec.feeCoins.map((coin, index) => walletCoinInput(deps, coin, feePrevouts[index])),
    ],
    outputs: [
      { script: nftScript, amount: NFT_AMOUNT, asset: lwk.AssetId.fromString(lenderNft) },
      {
        script: claimReceiver.scriptPubkey(),
        amount: claimed,
        asset: lwk.AssetId.fromString(principalAsset),
        blindingPubkey: claimReceiver.blindingPubkey(),
      },
    ],
    changeAddress: deps.addresses.nextChange(deps.wollet, 1)[0],
  })

  // 5. The layout of the unblinded PSET.
  assertSpendLayout(deps, unblinded, layout, false, label)

  // 6. Blinding: the locked inputs with the sweep's secrets; every output is fresh.
  const firstFee = CLAIM_INPUT.firstLocked + swept.length
  const blindedBase64 = wasmStep(`Blinding the ${label.toLowerCase()}`, () =>
    wasm.blindPset(
      unblinded.toString(),
      [
        wasm.InputSecret.explicit(CLAIM_INPUT.lenderNft, lenderNft, NFT_AMOUNT),
        ...swept.map((_, position) =>
          sweep.inputSecret(position, CLAIM_INPUT.firstLocked + position),
        ),
        ...spec.feeCoins.map((coin, index) => walletInputSecret(deps, coin, firstFee + index)),
      ],
      [],
    ),
  )
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, label)
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()
  const prevouts = () => [
    requireOutput(nftTx, nftRef.vout, 'The lender NFT'),
    ...prevoutsOf(sweptTxs, lockedInputs),
    ...prevoutsOf(feePrevoutTxs, feeInputs),
  ]

  // 8. Sign (by the caller), then finalize the wallet inputs and each locked output's asset_auth.
  return {
    pset: blinded,
    finalize: signedPset => {
      const signed = deps.wollet.finalize(signedPset).extractTx()
      if (signed.txid().toString() !== builtTxid) {
        throw new Error(`The signed ${label.toLowerCase()} is not the transaction that was built`)
      }
      const finalizedTx = finalizeSweptInputs(
        deps,
        signed,
        offer,
        swept,
        prevouts,
        CLAIM_INPUT.firstLocked,
        { inputIndex: CLAIM_INPUT.lenderNft, outputIndex: CLAIM_OUTPUT.lenderNft },
      )
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) throw new Error(`Finalizing changed the ${label.toLowerCase()}`)
      assertAllInputsFinalized(finalizedTx, `The ${label.toLowerCase()}`)

      return {
        finalizedTx,
        summary: {
          claimedOutpoint: `${txid}:${CLAIM_OUTPUT.claimed}`,
          claimed,
          swept: lockedInputs,
          lenderNftOutpoint: burn ? undefined : `${txid}:${CLAIM_OUTPUT.lenderNft}`,
        },
      }
    },
  }
}

/**
 * Builds the lender's claim of installments of `loan` it opened, blinded and ready to sign, with
 * the lender NFT back to the lender. Throws before building unless every installment asked for is
 * one of the loan's, opens with the lender's key and was not claimed yet: an installment that does
 * not open can be taken only by the final claim. `finalize` finalizes the wallet inputs (the
 * lender NFT among them), then each installment's asset_auth, running it on the transaction.
 */
export async function buildInstallmentClaim(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  loan: Loan,
  params: InstallmentClaimParams,
): Promise<UpdatedPset<ClaimSummary>> {
  if (offer.role !== 'lender') throw new Error('Only the lender claims installments')
  const asked = params.installments.map(outpoint => {
    const { txid, vout } = parseOutpoint(outpoint)
    return `${txid}:${vout}`
  })
  if (asked.length === 0) throw new Error('An installment claim needs an installment')
  if (new Set(asked).size !== asked.length) throw new Error('The installments must be distinct')

  // Without a close, the sweep gives each installment that opens its own opening, in chain order.
  const sweep = wasmStep('Reading the installments', () => loan.state.sweep(undefined, asked))
  try {
    const opening = sweep.outpoints()
    const unopened = asked.filter(outpoint => !opening.includes(outpoint))
    if (unopened.length > 0) {
      throw new Error(
        `${unopened.join(', ')} does not open with this wallet's key: its amount is unknown, ` +
          'and only the final claim can take it',
      )
    }
    const claimed = await lenderNftClaims(deps, offer, loan, params.lenderNftOutpoint)
    for (const outpoint of asked) {
      const claim = claimed.get(outpoint)
      if (claim !== undefined) throw new Error(`${outpoint} was claimed already, by ${claim}`)
    }
    const amounts = openedInstallmentAmounts(loan)
    const swept = opening.map((outpoint): SweptOutput => {
      const amount = amounts.get(outpoint)
      if (amount === undefined) throw new Error(`${outpoint} has no amount`)
      return { outpoint, lock: 'installment', amount }
    })
    return await buildLenderClaim(deps, offer, loan, {
      sweep,
      swept,
      lenderNftOutpoint: params.lenderNftOutpoint,
      feeCoins: params.feeCoins,
      burn: false,
      label: 'Installment claim',
    })
  } finally {
    sweep.free()
  }
}
