// The lender's final claim of a loan, after its full repayment or its zero-debt close: the claim
// of `claimInstallments.ts` that sweeps every installment the lender has not claimed, then the
// full repayment's output 1 if the close is one, and burns the lender NFT (OP_RETURN, explicit):
//   inputs   0 the lender NFT, explicit; 1… the unclaimed installments in chain order, each at
//            asset_auth(lender NFT, 1, no burn), then the repayment at asset_auth(lender NFT, 1,
//            burn); then the lender's fee coins;
//   outputs  0 burns the lender NFT; 1 the sweep's total to the lender, blinded to its wallet;
//            then the policy-asset change and the fee.
// A borrower who builds its own installments can make some whose range proofs the lender cannot
// rewind, and a claim that left them out would strand them once the NFT burns. So the claim spends
// them all with the combined opening: every repayment output of the loan adds up to the starting
// debt `D₀`, whose opening `(R, r₀)` the lender knows, so the unclaimed ones and the repayment add
// up to `R` and `r₀` less the claimed installments (and less the debt's blinder `k'` after a
// zero-debt close, which reveals it). The first swept input takes that opening and the others an
// amount and value blinder of zero, all under `A`'s asset and asset blinder (`LoanState.sweep`):
// only their sum enters the balance. The lender receives `R` in total over the loan.
// Which installments are unclaimed comes from the caller (the indexer), and an unspent one it left
// out would count as claimed: the claim would balance without it, burn the NFT and strand it. So
// the builder walks the lender NFT back through the lender's claims (`lenderNftClaims`) and
// requires the list to be exactly the installments no claim took.
import type { WalletTxOut } from 'lwk_wasm'

import type { UpdatedPset } from '@/lwk/updatedPset'
import { REPAYMENT_INPUT, REPAYMENT_OUTPUT } from '@/simplicity/private-lending/layout'

import type { PrivateFlowDeps } from '../deps'
import type { Loan } from '../loan'
import type { VerifiedOffer } from '../verify'
import {
  assertUnspentInstallments,
  buildLenderClaim,
  type ClaimSummary,
  lenderNftClaims,
  type SweptOutput,
} from './claimInstallments'
import { parseOutpoint, wasmStep } from './shared'

/**
 * The final claim refused before building: nothing is left to sweep, because the loan closed with
 * no debt and the lender claimed every installment already. The lender NFT unlocks nothing more.
 * The message is `"nothing-to-claim: …"`.
 */
export class NothingToClaimError extends Error {
  readonly code = 'nothing-to-claim'

  constructor(readonly closeTxid: string) {
    super(
      `nothing-to-claim: the loan closed with no debt in ${closeTxid}, and every installment was ` +
        'claimed already, so nothing is left to claim',
    )
    this.name = 'NothingToClaimError'
  }
}

export interface FinalClaimParams {
  /**
   * The close: the full repayment or the zero-debt close of `loan`, which spends its loan output
   * at input 1 (`closedLoanOutpoint` gives that output, from which the caller loads `loan`).
   */
  closeTxid: string
  /**
   * The installments of `loan` still unspent, `"<installment txid>:2"`: exactly those no claim of
   * the lender NFT took, which the builder checks on chain.
   */
  unspentInstallments: string[]
  /**
   * The lender NFT, an explicit output at a wallet address: the acceptance's output 2, or output 0
   * of the lender's last installment claim.
   */
  lenderNftOutpoint: string
  /** The lender's policy-asset coins, which pay the fee. */
  feeCoins: WalletTxOut[]
}

/** The loan output that the close `closeTxid` spends at input 1, `"<txid>:<vout>"`. */
export async function closedLoanOutpoint(
  deps: Pick<PrivateFlowDeps, 'fetchTx'>,
  closeTxid: string,
): Promise<string> {
  const { txid } = parseOutpoint(`${closeTxid}:0`)
  const close = await deps.fetchTx(txid)
  if (close.txid().toString() !== txid) throw new Error(`Fetched another transaction than ${txid}`)
  const loan = close.inputs[REPAYMENT_INPUT.offer]?.outpoint()
  if (loan === undefined) throw new Error(`The close ${txid} has no input ${REPAYMENT_INPUT.offer}`)
  return `${loan.txid().toString()}:${loan.vout()}`
}

/**
 * Builds the lender's final claim of `loan` after `params.closeTxid`, blinded and ready to sign:
 * it sweeps every unclaimed installment and the full repayment, and burns the lender NFT. Throws
 * `NothingToClaimError` before building when nothing is left to sweep, and refuses a close that is
 * not `loan`'s, or a list of unspent installments that disagrees with the lender NFT's claims.
 * `finalize` finalizes the wallet inputs (the lender NFT among them), then each swept output's
 * asset_auth, running it on the transaction.
 */
export async function buildFinalClaim(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  loan: Loan,
  params: FinalClaimParams,
): Promise<UpdatedPset<ClaimSummary>> {
  if (offer.role !== 'lender') throw new Error('Only the lender makes the final claim')
  const closeTxid = parseOutpoint(`${params.closeTxid}:0`).txid
  const close = await deps.fetchTx(closeTxid)
  if (close.txid().toString() !== closeTxid) {
    throw new Error(`Fetched another transaction than ${closeTxid}`)
  }

  // The close must spend the loan output, and repay the debt or reveal its key (`loan-mismatch`).
  const sweep = wasmStep('Reading the close', () =>
    loan.state.sweep(close.toString(), params.unspentInstallments),
  )
  try {
    const claimed = await lenderNftClaims(deps, offer, loan, params.lenderNftOutpoint)
    assertUnspentInstallments(loan, claimed, params.unspentInstallments)
    const outpoints = sweep.outpoints()
    if (outpoints.length === 0) throw new NothingToClaimError(closeTxid)
    // The sweep's order: the installments, then the full repayment, which is output 1 of the close.
    const repayment = `${closeTxid}:${REPAYMENT_OUTPUT.repayment}`
    const swept = outpoints.map(
      (outpoint, position): SweptOutput => ({
        outpoint,
        lock: outpoint === repayment ? 'repayment' : 'installment',
        amount: position === 0 ? sweep.amount : 0n,
      }),
    )
    if (swept.slice(0, -1).some(output => output.lock === 'repayment')) {
      throw new Error('The sweep has the repayment before an installment')
    }
    return await buildLenderClaim(deps, offer, loan, {
      sweep,
      swept,
      lenderNftOutpoint: params.lenderNftOutpoint,
      feeCoins: params.feeCoins,
      burn: true,
      label: 'Final claim',
    })
  } finally {
    sweep.free()
  }
}
