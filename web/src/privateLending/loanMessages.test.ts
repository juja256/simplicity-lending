import fs from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { lwk, sources } from '@/test/lwk'
import { wasm } from '@/test/wasm'
import type { ReadMessage } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'
import { loadLoan } from './loan'
import {
  collectLoanMessages,
  copyMessage,
  loanChainMessages,
  type LoanMessagesInput,
} from './loanMessages'
import type { SentMessage } from './sentMessages'
import { openAndVerifyOffer } from './verify'

const OFFER = 'aa'.repeat(32)
const ACCEPTANCE = '01'.repeat(32)
const INSTALLMENT_1 = '02'.repeat(32)
const INSTALLMENT_2 = '03'.repeat(32)
const REPAYMENT = '04'.repeat(32)
const DISCARDED = '05'.repeat(32)

function sent(record: Omit<SentMessage, 'offerTxid' | 'savedAt'>): SentMessage {
  return { offerTxid: OFFER, savedAt: 1_700_000_000_000, ...record }
}

function input(overrides: Partial<LoanMessagesInput>): LoanMessagesInput {
  return { role: 'lender', offerTxid: OFFER, installments: [], sent: [], ...overrides }
}

describe('collectLoanMessages', () => {
  it("orders the lender's view in chain order, its own acceptance from the record", () => {
    const messages = collectLoanMessages(
      input({
        role: 'lender',
        creation: 'Hello, lender',
        // the lender cannot rewind its own acceptance: nothing read from the chain
        acceptance: { txid: ACCEPTANCE },
        installments: [{ txid: INSTALLMENT_1, j: 1, read: { text: 'First', verified: true } }],
        repayment: { txid: REPAYMENT, read: { text: 'All paid', verified: true } },
        sent: [sent({ txid: ACCEPTANCE, phase: 'acceptance', text: 'Welcome' })],
      }),
    )
    expect(messages).toEqual([
      {
        phase: 'creation',
        from: 'borrower',
        txid: OFFER,
        state: 'verified',
        text: 'Hello, lender',
      },
      { phase: 'acceptance', from: 'lender', txid: ACCEPTANCE, state: 'sent', text: 'Welcome' },
      {
        phase: 'installment',
        installment: 1,
        from: 'borrower',
        txid: INSTALLMENT_1,
        state: 'verified',
        text: 'First',
      },
      {
        phase: 'repayment',
        from: 'borrower',
        txid: REPAYMENT,
        state: 'verified',
        text: 'All paid',
      },
    ])
  })

  it("reads the lender's acceptance from the chain for the borrower", () => {
    const messages = collectLoanMessages(
      input({
        role: 'borrower',
        acceptance: { txid: ACCEPTANCE, read: { text: 'Welcome', verified: true } },
        // the borrower cannot rewind its own full repayment, and this browser has no record of it
        repayment: { txid: REPAYMENT },
      }),
    )
    expect(messages).toEqual([
      { phase: 'acceptance', from: 'lender', txid: ACCEPTANCE, state: 'verified', text: 'Welcome' },
    ])
  })

  it("takes the borrower's own full repayment from its record, matched by txid", () => {
    const messages = collectLoanMessages(
      input({
        role: 'borrower',
        repayment: { txid: REPAYMENT },
        sent: [sent({ txid: REPAYMENT, phase: 'repayment', text: 'Thanks' })],
      }),
    )
    expect(messages).toEqual([
      { phase: 'repayment', from: 'borrower', txid: REPAYMENT, state: 'sent', text: 'Thanks' },
    ])
  })

  it('never shows the record of another transaction, such as a discarded draft', () => {
    expect(
      collectLoanMessages(
        input({
          role: 'borrower',
          repayment: { txid: REPAYMENT },
          sent: [sent({ txid: DISCARDED, phase: 'repayment', text: 'Never sent' })],
        }),
      ),
    ).toEqual([])
    expect(
      collectLoanMessages(
        input({
          role: 'lender',
          acceptance: { txid: ACCEPTANCE },
          sent: [sent({ txid: DISCARDED, phase: 'acceptance', text: 'Never sent' })],
        }),
      ),
    ).toEqual([])
  })

  it('gives no entry for a record without text, nor for a sender on another browser', () => {
    const messages = collectLoanMessages(
      input({
        role: 'lender',
        acceptance: { txid: ACCEPTANCE },
        sent: [sent({ txid: ACCEPTANCE, phase: 'acceptance' })],
      }),
    )
    expect(messages).toEqual([])
    // the lender's acceptance sent from another browser: no record, no read, no entry
    expect(
      collectLoanMessages(input({ role: 'lender', acceptance: { txid: ACCEPTANCE } })),
    ).toEqual([])
  })

  it('keeps the text of an unverified installment, and orders installments by index', () => {
    const messages = collectLoanMessages(
      input({
        role: 'lender',
        installments: [
          { txid: INSTALLMENT_2, j: 2, read: { text: 'Moved here', verified: false } },
          { txid: INSTALLMENT_1, j: 1 },
        ],
      }),
    )
    expect(messages).toEqual([
      {
        phase: 'installment',
        installment: 2,
        from: 'borrower',
        txid: INSTALLMENT_2,
        state: 'unverified',
        text: 'Moved here',
      },
    ])
  })

  it('shows a crafted unreadable field as unreadable, without text', () => {
    const messages = collectLoanMessages(
      input({
        role: 'borrower',
        acceptance: { txid: ACCEPTANCE, read: 'unreadable' },
        installments: [{ txid: INSTALLMENT_1, j: 1, read: 'unreadable' }],
      }),
    )
    expect(messages).toEqual([
      { phase: 'acceptance', from: 'lender', txid: ACCEPTANCE, state: 'unreadable' },
      {
        phase: 'installment',
        installment: 1,
        from: 'borrower',
        txid: INSTALLMENT_1,
        state: 'unreadable',
      },
    ])
  })

  it("prefers the chain's read to the record of the same transaction", () => {
    const messages = collectLoanMessages(
      input({
        role: 'borrower',
        installments: [{ txid: INSTALLMENT_1, j: 1, read: { text: 'On chain', verified: true } }],
        sent: [sent({ txid: INSTALLMENT_1, phase: 'installment', installment: 1, text: 'Saved' })],
      }),
    )
    expect(messages).toEqual([
      {
        phase: 'installment',
        installment: 1,
        from: 'borrower',
        txid: INSTALLMENT_1,
        state: 'verified',
        text: 'On chain',
      },
    ])
  })
})

describe('copyMessage', () => {
  it('copies the fields of a read message and frees it', () => {
    const free = vi.fn()
    const read = { text: 'Hi', verified: false, free } as unknown as ReadMessage
    expect(copyMessage(() => read)).toEqual({ text: 'Hi', verified: false })
    expect(free).toHaveBeenCalledOnce()
  })

  it('gives undefined for no message', () => {
    expect(copyMessage(() => undefined)).toBeUndefined()
  })

  it('reads a field the wasm refuses as unreadable, never throwing', () => {
    expect(
      copyMessage(() => {
        throw 'bad-input: the message field does not decode'
      }),
    ).toBe('unreadable')
  })
})

// The parity fixture's loan on regtest: its acceptance carries the lender's message, and its one
// installment the borrower's, each signed for its step.
describe('loanChainMessages', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL('../../scripts/fixtures/private-lending-parity.json', import.meta.url),
      'utf-8',
    ),
  ) as {
    borrower_master_blinding_key: string
    lender_master_blinding_key: string
    creation_tx: string
    loan: { acceptance_tx: string; installment_txs: string[]; loan_outpoint: string }
    messages: { acceptance: string; installment: string }
  }
  const txs = new Map(
    [fixture.creation_tx, fixture.loan.acceptance_tx, ...fixture.loan.installment_txs].map(hex => [
      lwk.Transaction.fromString(hex).txid().toString(),
      hex,
    ]),
  )
  const deps = {
    lwk,
    wasm,
    network: lwk.Network.regtestDefault(),
    sources,
    fetchTx: async (txid: string) => lwk.Transaction.fromString(txs.get(txid)!),
  } as unknown as PrivateFlowDeps
  const [acceptanceTxid, installmentTxid] = [...txs.keys()].slice(1)

  async function read(role: 'borrower' | 'lender') {
    const key = wasm.LendingKey.fromMasterBlindingKey(fixture[`${role}_master_blinding_key`])
    const offer = await openAndVerifyOffer(deps, role, key, fixture.creation_tx)
    const loan = await loadLoan(deps, offer, key, fixture.loan.loan_outpoint)
    try {
      return loanChainMessages(wasm, offer, key, role, loan)
    } finally {
      loan.state.free()
      offer.opened.free()
    }
  }

  it("reads the lender's acceptance and the installment as the borrower", async () => {
    expect(await read('borrower')).toEqual({
      acceptance: {
        txid: acceptanceTxid,
        read: { text: fixture.messages.acceptance, verified: true },
      },
      installments: [
        {
          txid: installmentTxid,
          j: 1,
          read: { text: fixture.messages.installment, verified: true },
        },
      ],
    })
  })

  it('reads the installment as the lender, and not its own acceptance', async () => {
    expect(await read('lender')).toEqual({
      acceptance: { txid: acceptanceTxid },
      installments: [
        {
          txid: installmentTxid,
          j: 1,
          read: { text: fixture.messages.installment, verified: true },
        },
      ],
    })
  })
})
