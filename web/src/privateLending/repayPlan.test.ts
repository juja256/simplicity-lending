import { describe, expect, it } from 'vitest'

import { FINALIZED_THRESHOLD, type PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { lwk } from '@/test/lwk'

import {
  checkSameLoan,
  INSTALLMENT_AFTER_TERM_NOTE,
  INSTALLMENT_LIMIT_NOTE,
  INSTALLMENT_UNSENT_AFTER_TERM_NOTE,
  installmentRebuildRefusal,
  installmentTraceInputs,
  installmentTraces,
  keepsDiscardTrace,
  LOAN_CHANGED_NOTE,
  repayBroadcast,
  repayPlan,
  staleInstallmentRecords,
} from './repayPlan'

const EXPIRY = 3_000_000
/** 1,100 TEST owed, in base units of an asset with 2 decimals. */
const OWED = 110_000n

/** The plan of `amountText` on a loan that owes `OWED`, at `tipHeight`, after `installmentCount`. */
function planOf(amountText: string, tipHeight = EXPIRY - 1440, installmentCount = 3) {
  return repayPlan({
    remaining: OWED,
    amountText,
    decimals: 2,
    symbol: 'TEST',
    tipHeight,
    expiry: EXPIRY,
    installmentCount,
  })
}

describe('repayPlan', () => {
  it('repays in full at the remaining debt, and pays an installment one unit below it', () => {
    expect(planOf('1100')).toEqual({ kind: 'full', amount: OWED })
    expect(planOf('1100.00')).toEqual({ kind: 'full', amount: OWED })
    expect(planOf('1099.99')).toEqual({ kind: 'installment', amount: OWED - 1n })
    expect(planOf(' 0.01 ')).toEqual({ kind: 'installment', amount: 1n })
  })

  it('refuses nothing, more than is owed, and more decimals than the asset has', () => {
    for (const text of ['0', '0.00', '', '  ']) {
      expect(planOf(text)).toEqual({ kind: 'refused', message: 'Enter an amount above zero' })
    }
    expect(planOf('1100.01')).toEqual({
      kind: 'refused',
      message: 'That is more than you owe: at most 1,100 TEST',
    })
    expect(planOf('99999999999999999999999')).toMatchObject({ kind: 'refused' })
    expect(planOf('1099.999')).toEqual({ kind: 'refused', message: 'TEST has 2 decimals' })
    expect(planOf('12,5')).toMatchObject({ kind: 'refused' })
  })

  it('refuses an installment at and past the expiry, and still repays in full', () => {
    expect(planOf('500', EXPIRY - 1)).toEqual({ kind: 'installment', amount: 50_000n })
    for (const tip of [EXPIRY, EXPIRY + 1, EXPIRY + 1440]) {
      expect(planOf('500', tip)).toEqual({ kind: 'refused', message: INSTALLMENT_AFTER_TERM_NOTE })
      expect(planOf('1100', tip)).toEqual({ kind: 'full', amount: OWED })
    }
    expect(INSTALLMENT_AFTER_TERM_NOTE).toBe(
      'The term has ended: the lender can take the collateral at any time. Repay in full to get ' +
        'it back.',
    )
  })

  // Step 1024 has no leaf for the next installment: the contract refuses one there.
  it('offers only the full repayment once the loan has had 1,024 installments', () => {
    expect(planOf('1099.99', EXPIRY - 1440, 1023)).toEqual({
      kind: 'installment',
      amount: OWED - 1n,
    })
    for (const count of [1024, 1025]) {
      expect(planOf('1099.99', EXPIRY - 1440, count)).toEqual({
        kind: 'refused',
        message: INSTALLMENT_LIMIT_NOTE,
      })
      expect(planOf('1100', EXPIRY - 1440, count)).toEqual({ kind: 'full', amount: OWED })
    }
    expect(INSTALLMENT_LIMIT_NOTE).toContain('1,024 installments')
  })

  it('refuses an installment while the tip is unknown, and still repays in full', () => {
    expect(planOf('500', 0)).toMatchObject({ kind: 'refused' })
    expect(planOf('1100', 0)).toEqual({ kind: 'full', amount: OWED })
  })
})

// Review focus 4, for a saved installment: the form's plan for its amount turns `refused` at the
// expiry, so the saved record's kind must keep its check and block it.
// The form shows what the loan owes and the collateral it releases for the loan output it read;
// a build on a newer one would pay on figures the borrower did not see.
describe('the loan a payment builds on', () => {
  it("is the form's loan output, or the payment is refused", () => {
    expect(() => checkSameLoan(`${'aa'.repeat(32)}:1`, `${'aa'.repeat(32)}:1`)).not.toThrow()
    expect(() => checkSameLoan(`${'aa'.repeat(32)}:1`, `${'bb'.repeat(32)}:1`)).toThrow(
      LOAN_CHANGED_NOTE,
    )
    expect(() => checkSameLoan(undefined, `${'bb'.repeat(32)}:1`)).toThrow(LOAN_CHANGED_NOTE)
  })
})

describe('the broadcast of the repay form', () => {
  const installment = { kind: 'private_installment' } as const
  const repayment = { kind: 'private_repay_offer' } as const

  it('checks a saved installment, and blocks it from the expiry block on', () => {
    for (const tip of [EXPIRY, EXPIRY + 1]) {
      expect(repayBroadcast(installment, planOf('500', tip), tip, EXPIRY)).toEqual({
        installment: true,
        blockedNote: INSTALLMENT_UNSENT_AFTER_TERM_NOTE,
      })
    }
    expect(repayBroadcast(installment, planOf('1100'), EXPIRY - 1, EXPIRY)).toEqual({
      installment: true,
      blockedNote: null,
    })
    // while the tip is unknown, the check before broadcast decides
    expect(repayBroadcast(installment, undefined, 0, EXPIRY)).toEqual({
      installment: true,
      blockedNote: null,
    })
  })

  it('never blocks a saved full repayment, and follows the plan with nothing saved', () => {
    expect(repayBroadcast(repayment, planOf('500', EXPIRY - 1), EXPIRY + 1, EXPIRY)).toEqual({
      installment: false,
      blockedNote: null,
    })
    expect(repayBroadcast(undefined, planOf('500', EXPIRY - 1), EXPIRY - 1, EXPIRY)).toEqual({
      installment: true,
      blockedNote: null,
    })
    expect(repayBroadcast(undefined, planOf('1100'), EXPIRY + 1, EXPIRY)).toEqual({
      installment: false,
      blockedNote: null,
    })
  })
})

const LOAN = `${'aa'.repeat(32)}:1`
const OTHER_LOAN = `${'bb'.repeat(32)}:1`

const reversed = (hex: string) => (hex.match(/../g) ?? []).reverse().join('')

/** A transaction spending `inputs` in order, with one explicit output: enough to read inputs. */
function txSpending(inputs: string[]): string {
  const ins = inputs.map(outpoint => {
    const [txid, vout] = outpoint.split(':')
    const voutLe = reversed(Number(vout).toString(16).padStart(8, '0'))
    return reversed(txid) + voutLe + '00' + 'ffffffff'
  })
  const asset = '5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225'
  const output = '01' + reversed(asset) + '01' + '00000000000003e8' + '00' + '00'
  const count = (n: number) => n.toString(16).padStart(2, '0')
  return '02000000' + '00' + count(ins.length) + ins.join('') + '01' + output + '00000000'
}

function record(kind: PrivateTxRecord['kind'], inputs: string[]): PrivateTxRecord {
  const txHex = txSpending(inputs)
  return {
    txid: lwk.Transaction.fromString(txHex).txid().toString(),
    kind,
    walletScriptPubkey: '0014' + '00'.repeat(20),
    offerTxid: 'ab'.repeat(32),
    txHex,
    broadcastStatus: 'built',
    confirmationStatus: 'processing',
    confirmations: null,
    createdAt: 1,
    updatedAt: 1,
    discardedAt: 2,
  }
}

describe('an earlier installment of the loan', () => {
  const nft = `${'01'.repeat(32)}:0`
  const firstCoin = `${'02'.repeat(32)}:3`
  const secondCoin = `${'03'.repeat(32)}:0`

  it('leaves a trace on discard, as no other kind does', () => {
    expect(keepsDiscardTrace({ kind: 'private_installment' })).toBe(true)
    for (const kind of [
      'private_repay_offer',
      'private_accept_offer',
      'private_create_offer',
    ] as const) {
      expect(keepsDiscardTrace({ kind })).toBe(false)
    }
  })

  // A rebuild from the same loan output, first wallet input and receiver script derives the same
  // installment key: if the discarded one reached the network, two range proofs with one nonce
  // would be public. So the next installment of the loan never starts from that input.
  it('gives its first wallet input (input 2) for the next build of the loan it spent', () => {
    const discarded = [
      record('private_installment', [nft, LOAN, firstCoin, secondCoin]),
      record('private_installment', [nft, OTHER_LOAN, secondCoin]),
      // a full repayment of the loan has the same inputs, but derives no installment key
      record('private_repay_offer', [nft, LOAN, secondCoin]),
    ]
    expect(installmentTraceInputs(lwk, discarded, LOAN)).toEqual(new Set([firstCoin]))
    expect(installmentTraceInputs(lwk, discarded, OTHER_LOAN)).toEqual(new Set([secondCoin]))
    expect(installmentTraceInputs(lwk, discarded, `${'cc'.repeat(32)}:1`)).toEqual(new Set())
  })

  // A broadcast installment the network dropped is marked failed when its tracking times out,
  // not discarded, and the form then offers Repay again: its first input is a trace all the same.
  it('counts a failed installment that was never discarded as a trace too', () => {
    const failed: PrivateTxRecord = {
      ...record('private_installment', [nft, LOAN, firstCoin]),
      broadcastStatus: 'broadcast',
      confirmationStatus: 'failed',
      discardedAt: undefined,
    }
    expect(installmentTraceInputs(lwk, [failed], LOAN)).toEqual(new Set([firstCoin]))
  })
})

describe('the traces a finalized spend of their loan output makes stale', () => {
  const nft = `${'01'.repeat(32)}:0`
  const coinOf = (n: number) => `${n.toString(16).padStart(2, '0').repeat(32)}:0`
  const failed = (loan: string, n: number): PrivateTxRecord => ({
    ...record('private_installment', [nft, loan, coinOf(n)]),
    broadcastStatus: 'broadcast',
    confirmationStatus: 'failed',
    discardedAt: undefined,
  })
  const loans = {
    unspent: `${'a1'.repeat(32)}:1`,
    mempool: `${'a2'.repeat(32)}:1`,
    short: `${'a3'.repeat(32)}:1`,
    finalized: `${'a4'.repeat(32)}:1`,
    deeper: `${'a5'.repeat(32)}:1`,
  }
  const depths = new Map<string, number | null>([
    [loans.unspent, null],
    [loans.mempool, 0],
    [loans.short, FINALIZED_THRESHOLD - 1],
    [loans.finalized, FINALIZED_THRESHOLD],
    [loans.deeper, FINALIZED_THRESHOLD + 100],
  ])
  const depthOf = (outpoint: string) => depths.get(outpoint) ?? null

  // A spend in the mempool, or one block short of the finalized depth, can still drop: the loan
  // output could then be spent by a rebuilt installment, whose first input the trace keeps out.
  it('keeps a failed installment until the spend of its loan output is finalized', () => {
    const records = [
      failed(loans.unspent, 1),
      failed(loans.mempool, 2),
      failed(loans.short, 3),
      failed(loans.finalized, 4),
    ]
    expect(staleInstallmentRecords(lwk, records, depthOf)).toEqual([records[3]])
  })

  it('returns a discarded installment, and no installment still tracked or other kind', () => {
    const discarded = record('private_installment', [nft, loans.deeper, coinOf(5)])
    const tracked: PrivateTxRecord = {
      ...record('private_installment', [nft, loans.deeper, coinOf(6)]),
      discardedAt: undefined,
    }
    const repayment: PrivateTxRecord = {
      ...record('private_repay_offer', [nft, loans.deeper, coinOf(7)]),
      confirmationStatus: 'failed',
    }
    expect(staleInstallmentRecords(lwk, [discarded, tracked, repayment], depthOf)).toEqual([
      discarded,
    ])
  })
})

describe('a rebuild of a loan state', () => {
  const nft = `${'01'.repeat(32)}:0`
  const firstCoin = `${'02'.repeat(32)}:3`
  const secondCoin = `${'03'.repeat(32)}:0`
  const earlier = (amount: bigint | undefined, firstWalletInput = firstCoin) => ({
    txid: 'ee'.repeat(32),
    firstWalletInput,
    amount,
  })

  it('gives each installment of the loan output once, and nothing else', () => {
    const first = record('private_installment', [nft, LOAN, firstCoin])
    const other = record('private_installment', [nft, OTHER_LOAN, secondCoin])
    const repayment = record('private_repay_offer', [nft, LOAN, secondCoin])
    expect(installmentTraces(lwk, [first, other, repayment, first], LOAN)).toEqual([first])
    expect(installmentTraces(lwk, [first, other], OTHER_LOAN)).toEqual([other])
  })

  // The design note's rule (proofs, L1): two builds at one step share the successor's blinder.
  it('builds the first of a loan state freely', () => {
    expect(installmentRebuildRefusal([], 500n, firstCoin)).toBeUndefined()
  })

  it('rebuilds only with the same amount, from a first wallet input no build used', () => {
    expect(installmentRebuildRefusal([earlier(500n)], 500n, secondCoin)).toBeUndefined()
    expect(
      installmentRebuildRefusal(
        [earlier(500n), earlier(500n, secondCoin)],
        500n,
        `${'04'.repeat(32)}:1`,
      ),
    ).toBeUndefined()
    // another amount, one unit off either way
    for (const amount of [499n, 501n]) {
      expect(installmentRebuildRefusal([earlier(500n)], amount, secondCoin)).toMatch(
        /paid 500 base units: a new one must pay exactly that/,
      )
    }
    // the same amount from a first wallet input an earlier build used, the latest or another
    expect(installmentRebuildRefusal([earlier(500n)], 500n, firstCoin)).toMatch(
      `started from the coin ${firstCoin}`,
    )
    expect(
      installmentRebuildRefusal([earlier(500n, secondCoin), earlier(500n)], 500n, firstCoin),
    ).toMatch(`started from the coin ${firstCoin}`)
  })

  it('refuses any rebuild after a build whose amount does not read back', () => {
    expect(installmentRebuildRefusal([earlier(undefined)], 500n, secondCoin)).toMatch(
      /does not read back with your key/,
    )
    expect(
      installmentRebuildRefusal([earlier(500n), earlier(undefined)], 500n, secondCoin),
    ).toMatch(/does not read back/)
  })
})
