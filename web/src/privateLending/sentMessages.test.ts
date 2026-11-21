import 'fake-indexeddb/auto'

import type { Pset } from 'lwk_wasm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UpdatedPset } from '@/lwk/updatedPset'

import * as sentMessagesModule from './sentMessages'
import { recordingSent, type SentMessage, type SentMessages, sentMessagesOf } from './sentMessages'

const OFFER = 'aa'.repeat(32)
const OTHER_OFFER = 'bb'.repeat(32)

const acceptance: SentMessage = {
  offerTxid: OFFER,
  txid: '01'.repeat(32),
  phase: 'acceptance',
  text: 'Привіт 😀\nline two',
  savedAt: 1_700_000_000_000,
}
const installment: SentMessage = {
  offerTxid: OFFER,
  txid: '02'.repeat(32),
  phase: 'installment',
  installment: 1,
  savedAt: 1_700_000_100_000,
}

// Every test writes under a fingerprint of its own, so the shared fake database needs no reset.
let fingerprints = 0
const freshFingerprint = () => `f${++fingerprints}`

/**
 * The module as another tab of the browser loads it: a fresh instance, with its own connection to
 * the same IndexedDB.
 */
async function anotherTab(): Promise<typeof sentMessagesModule> {
  vi.resetModules()
  return import('./sentMessages')
}

/** The raw records in the database, to see exactly what was stored. */
async function rawRecords(): Promise<unknown[]> {
  const { openDB } = await import('idb')
  const db = await openDB(sentMessagesModule.SENT_MESSAGES_DB_NAME)
  try {
    return await db.getAll(sentMessagesModule.SENT_MESSAGES_STORE_NAME)
  } finally {
    db.close()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sentMessagesOf', () => {
  it('round-trips the messages of one offer, and none of another', async () => {
    const fingerprint = freshFingerprint()
    const store = sentMessagesOf('testnet', fingerprint)
    await store.save(installment)
    await store.save(acceptance)
    await store.save({ ...installment, offerTxid: OTHER_OFFER, txid: '03'.repeat(32) })

    const reread = sentMessagesOf('testnet', fingerprint)
    // in the order they were saved: by `savedAt`
    expect(await reread.forOffer(OFFER)).toEqual([acceptance, installment])
    expect(await reread.forOffer(OTHER_OFFER)).toHaveLength(1)
    expect(await reread.forOffer('cc'.repeat(32))).toEqual([])
  })

  it('keeps fingerprints and networks apart', async () => {
    const fingerprint = freshFingerprint()
    await sentMessagesOf('testnet', fingerprint).save(acceptance)
    expect(await sentMessagesOf('testnet', freshFingerprint()).forOffer(OFFER)).toEqual([])
    expect(await sentMessagesOf('liquid', fingerprint).forOffer(OFFER)).toEqual([])
    expect(await sentMessagesOf('testnet', fingerprint).forOffer(OFFER)).toEqual([acceptance])
  })

  // The bug this store fixes: each tab held the list in memory and wrote it back whole, so a tab's
  // save erased the records another tab had saved since it loaded.
  it("shares the records between tabs: neither tab's save erases the other's", async () => {
    const fingerprint = freshFingerprint()
    const tabA = sentMessagesOf('testnet', fingerprint)
    const tabB = (await anotherTab()).sentMessagesOf('testnet', fingerprint)
    expect(await tabA.forOffer(OFFER)).toEqual([])
    expect(await tabB.forOffer(OFFER)).toEqual([])
    await tabA.save(acceptance)
    await tabB.save(installment)
    expect(await tabA.forOffer(OFFER)).toEqual([acceptance, installment])
    expect(await tabB.forOffer(OFFER)).toEqual([acceptance, installment])
  })

  it('replaces the record of a transaction saved again', async () => {
    const store = sentMessagesOf('testnet', freshFingerprint())
    await store.save(acceptance)
    await store.save(installment)
    const resent = { ...acceptance, text: 'the second text', savedAt: installment.savedAt + 1 }
    await store.save(resent)
    expect(await store.forOffer(OFFER)).toEqual([installment, resent])
  })

  it('stores only the fields of a sent message, with its network and fingerprint', async () => {
    const fingerprint = freshFingerprint()
    const txid = '0a'.repeat(32)
    const store = sentMessagesOf('testnet', fingerprint)
    await store.save({ ...installment, txid, secret: 'never stored' } as SentMessage)
    const stored = (await rawRecords()).find(record => (record as SentMessage).txid === txid)
    expect(stored).toEqual({ ...installment, txid, network: 'testnet', fingerprint })
    expect(await store.forOffer(OFFER)).toEqual([{ ...installment, txid }])
  })

  it('refuses to save a record it could not read back, keeping the others', async () => {
    const store = sentMessagesOf('testnet', freshFingerprint())
    await store.save(acceptance)
    const bad = [
      { ...installment, installment: undefined },
      { ...installment, installment: 0 },
      { ...installment, txid: 'AA'.repeat(32) },
      { ...acceptance, txid: '04'.repeat(32), text: '' },
    ]
    for (const message of bad) await expect(store.save(message)).rejects.toThrow()
    expect(await store.forOffer(OFFER)).toEqual([acceptance])
  })

  it('skips a stored record that does not decode, and reads the others', async () => {
    const fingerprint = freshFingerprint()
    const store = sentMessagesOf('testnet', fingerprint)
    await store.save(acceptance)
    const scope = { network: 'testnet', fingerprint }
    const corrupt = [
      { ...installment, ...scope, extra: 1 },
      { ...installment, ...scope, txid: '05'.repeat(32), phase: 'claim' },
      { ...installment, ...scope, txid: '06'.repeat(32), text: '' },
      { ...acceptance, ...scope, txid: '07'.repeat(32), installment: 1 },
      { ...installment, ...scope, txid: '08'.repeat(32), installment: 0 },
      { ...installment, ...scope, txid: '09'.repeat(32), savedAt: -1 },
    ]
    const { openDB } = await import('idb')
    const db = await openDB(sentMessagesModule.SENT_MESSAGES_DB_NAME)
    try {
      for (const record of corrupt) {
        await db.put(sentMessagesModule.SENT_MESSAGES_STORE_NAME, record)
      }
    } finally {
      db.close()
    }
    expect(await store.forOffer(OFFER)).toEqual([acceptance])
  })

  // An open connection that ignored `versionchange` would block another tab's upgrade or
  // deletion of the database for as long as it stays open.
  it('closes its connection for another that deletes the database, then opens a new one', async () => {
    const store = (await anotherTab()).sentMessagesOf('testnet', freshFingerprint())
    await store.save(acceptance)
    const { deleteDB } = await import('idb')
    const blocked = vi.fn()
    await deleteDB(sentMessagesModule.SENT_MESSAGES_DB_NAME, { blocked })
    expect(blocked).not.toHaveBeenCalled()
    expect(await store.forOffer(OFFER)).toEqual([])
    await store.save(installment)
    expect(await store.forOffer(OFFER)).toEqual([installment])
  })

  it('rejects a save and a read where IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const store = (await anotherTab()).sentMessagesOf('testnet', freshFingerprint())
    await expect(store.save(acceptance)).rejects.toThrow()
    await expect(store.forOffer(OFFER)).rejects.toThrow()
  })
})

describe('recordingSent', () => {
  const TXID = '05'.repeat(32)
  /** A built transaction whose `finalize` gives the transaction `TXID`, and counts its calls. */
  function built(): UpdatedPset<string> & { finalized: number } {
    const finalizedTx = { txid: () => ({ toString: () => TXID }) }
    const result = {
      pset: {} as Pset,
      finalized: 0,
      finalize: () => {
        result.finalized++
        return { finalizedTx, summary: 'summary' }
      },
    }
    return result as unknown as UpdatedPset<string> & { finalized: number }
  }
  const sent = {
    offerTxid: OFFER,
    phase: 'installment',
    installment: 2,
    text: 'a private text',
  } as const

  it('records the message under the finalized txid before finalize resolves', async () => {
    const fingerprint = freshFingerprint()
    const store = sentMessagesOf('testnet', fingerprint)
    const inner = built()
    const recording = recordingSent(inner, store, sent)
    expect(recording.pset).toBe(inner.pset)
    expect(await store.forOffer(OFFER)).toEqual([])
    const before = Date.now()
    expect((await recording.finalize({} as Pset)).summary).toBe('summary')
    expect(inner.finalized).toBe(1)
    // read through another tab: the record is in IndexedDB once finalize resolved
    const reread = (await anotherTab()).sentMessagesOf('testnet', fingerprint)
    const [record] = await reread.forOffer(OFFER)
    expect(record).toEqual({ ...sent, txid: TXID, savedAt: record.savedAt })
    expect(record.savedAt).toBeGreaterThanOrEqual(before)
  })

  it('awaits the save: finalize does not resolve before it', async () => {
    let finishSave = () => {}
    const store: SentMessages = {
      save: () => new Promise<void>(resolve => (finishSave = resolve)),
      forOffer: () => Promise.resolve([]),
    }
    let resolved = false
    const finalizing = recordingSent(built(), store, sent)
      .finalize({} as Pset)
      .then(result => {
        resolved = true
        return result
      })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(resolved).toBe(false)
    finishSave()
    expect((await finalizing).summary).toBe('summary')
  })

  // A save that never settles (a blocked open, a stalled write) must not hold up the payment.
  it('gives up waiting for a save after 3 seconds, and logs only the phase and the txid', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const stalled: SentMessages = {
        save: () => new Promise<void>(() => {}),
        forOffer: () => Promise.resolve([]),
      }
      let resolved = false
      const finalizing = recordingSent(built(), stalled, sent)
        .finalize({} as Pset)
        .then(result => {
          resolved = true
          return result
        })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect((await finalizing).summary).toBe('summary')
      expect(error).toHaveBeenCalledTimes(1)
      expect(error.mock.calls[0][0]).toBe(
        `The installment ${TXID} was sent without a record of its message`,
      )
      expect(JSON.stringify(error.mock.calls)).not.toContain(sent.text)
    } finally {
      vi.useRealTimers()
      error.mockRestore()
    }
  })

  it('swallows the rejection of a save it gave up on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    vi.useFakeTimers()
    try {
      let fail: (reason: Error) => void = () => {}
      const late: SentMessages = {
        save: () => new Promise<void>((_, reject) => (fail = reject)),
        forOffer: () => Promise.resolve([]),
      }
      const finalizing = recordingSent(built(), late, sent).finalize({} as Pset)
      await vi.advanceTimersByTimeAsync(3_000)
      await finalizing
      fail(new Error('the write failed late'))
      vi.useRealTimers()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(unhandled).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      process.off('unhandledRejection', unhandled)
      error.mockRestore()
    }
  })

  it('records a transaction without a message as such', async () => {
    const store = sentMessagesOf('testnet', freshFingerprint())
    await recordingSent(built(), store, { offerTxid: OFFER, phase: 'repayment' }).finalize(
      {} as Pset,
    )
    expect(await store.forOffer(OFFER)).toEqual([
      { offerTxid: OFFER, txid: TXID, phase: 'repayment', savedAt: expect.any(Number) },
    ])
  })

  it('never holds up the transaction: when the save rejects, or IndexedDB is unavailable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const rejecting: SentMessages = {
        save: () => Promise.reject(new Error('quota')),
        forOffer: () => Promise.resolve([]),
      }
      vi.stubGlobal('indexedDB', undefined)
      const unavailable = (await anotherTab()).sentMessagesOf('testnet', freshFingerprint())
      for (const store of [rejecting, unavailable]) {
        expect((await recordingSent(built(), store, sent).finalize({} as Pset)).summary).toBe(
          'summary',
        )
      }
      expect(error).toHaveBeenCalledTimes(2)
      // the console names the phase and the txid, never the text
      for (const [text] of error.mock.calls) {
        expect(text).toBe(`The installment ${TXID} was sent without a record of its message`)
      }
      expect(JSON.stringify(error.mock.calls.map(([text]) => text))).not.toContain(sent.text)
    } finally {
      error.mockRestore()
    }
  })

  it("passes on the inner finalize's error, and records nothing", async () => {
    const store = sentMessagesOf('testnet', freshFingerprint())
    const failing = {
      ...built(),
      finalize: () => {
        throw new Error('Finalizing changed the installment')
      },
    }
    await expect(recordingSent(failing, store, sent).finalize({} as Pset)).rejects.toThrow(
      'Finalizing changed the installment',
    )
    expect(await store.forOffer(OFFER)).toEqual([])
  })
})
