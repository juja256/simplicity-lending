import type { Pset } from 'lwk_wasm'
import { describe, expect, it, vi } from 'vitest'

import type { UpdatedPset } from '@/lwk/updatedPset'

import type { ScanKv, ScanScope } from './scanStore'
import { kvSentMessages, recordingSent, type SentMessage, sentMessagesKey } from './sentMessages'

const OFFER = 'aa'.repeat(32)
const OTHER_OFFER = 'bb'.repeat(32)
const SCOPE: ScanScope = { network: 'testnet', apiBaseUrl: 'https://indexer.example/api/' }

function mapKv(): ScanKv & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>()
  return { map, get: key => map.get(key), put: (key, value) => void map.set(key, value) }
}

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

describe('kvSentMessages', () => {
  it('round-trips the messages of one offer, and none of another', () => {
    const kv = mapKv()
    const store = kvSentMessages(kv, SCOPE, 'f1')
    store.save(acceptance)
    store.save(installment)
    store.save({ ...installment, offerTxid: OTHER_OFFER, txid: '03'.repeat(32) })

    const reread = kvSentMessages(kv, SCOPE, 'f1')
    expect(reread.forOffer(OFFER)).toEqual([acceptance, installment])
    expect(reread.forOffer(OTHER_OFFER)).toHaveLength(1)
    expect(reread.forOffer('cc'.repeat(32))).toEqual([])
  })

  it('keeps fingerprints and networks apart, under the documented key', () => {
    const kv = mapKv()
    kvSentMessages(kv, SCOPE, 'f1').save(acceptance)
    expect(kvSentMessages(kv, SCOPE, 'f2').forOffer(OFFER)).toEqual([])
    expect(kvSentMessages(kv, { ...SCOPE, network: 'liquid' }, 'f1').forOffer(OFFER)).toEqual([])
    // the indexer does not matter: a sent message is the wallet's, whatever indexer read it
    expect(
      kvSentMessages(kv, { ...SCOPE, apiBaseUrl: 'https://other.example' }, 'f1').forOffer(OFFER),
    ).toEqual([acceptance])
    expect([...kv.map.keys()]).toEqual([JSON.stringify(['sent', 'testnet', 'f1'])])
    expect(sentMessagesKey(SCOPE, 'f1')).toBe(JSON.stringify(['sent', 'testnet', 'f1']))
  })

  it('replaces the record of a transaction saved again', () => {
    const kv = mapKv()
    const store = kvSentMessages(kv, SCOPE, 'f1')
    store.save(acceptance)
    store.save(installment)
    const resent = { ...acceptance, text: 'the second text', savedAt: acceptance.savedAt + 1 }
    store.save(resent)
    expect(store.forOffer(OFFER)).toEqual([installment, resent])
  })

  it('stores only the fields of a sent message', () => {
    const kv = mapKv()
    const store = kvSentMessages(kv, SCOPE, 'f1')
    store.save({ ...installment, secret: 'never stored' } as SentMessage)
    const stored = new TextDecoder().decode(kv.map.get(sentMessagesKey(SCOPE, 'f1')))
    expect(stored).not.toContain('never stored')
    expect(store.forOffer(OFFER)).toEqual([installment])
  })

  it('refuses to save a record it could not read back, keeping the others', () => {
    const kv = mapKv()
    const store = kvSentMessages(kv, SCOPE, 'f1')
    store.save(acceptance)
    const bad = [
      { ...installment, installment: undefined },
      { ...installment, installment: 0 },
      { ...installment, txid: 'AA'.repeat(32) },
      { ...acceptance, txid: '04'.repeat(32), text: '' },
    ]
    for (const message of bad) expect(() => store.save(message)).toThrow()
    expect(store.forOffer(OFFER)).toEqual([acceptance])
  })

  it('reads a value that does not decode as none, and a save starts over', () => {
    const key = sentMessagesKey(SCOPE, 'f1')
    const valid = (messages: unknown[]) =>
      new TextEncoder().encode(JSON.stringify({ version: 1, messages }))
    const corrupt = [
      new Uint8Array([0xff, 0xfe]),
      new TextEncoder().encode('not json'),
      new TextEncoder().encode(JSON.stringify({ version: 2, messages: [] })),
      new TextEncoder().encode(JSON.stringify({ version: 1, messages: [], extra: 1 })),
      valid([{ ...acceptance, extra: 1 }]),
      valid([{ ...acceptance, txid: 'not a txid' }]),
      valid([{ ...acceptance, phase: 'claim' }]),
      valid([{ ...acceptance, text: '' }]),
      valid([{ ...acceptance, installment: 1 }]),
      valid([{ ...installment, installment: undefined }]),
      valid([{ ...installment, installment: 0 }]),
    ]
    for (const bytes of corrupt) {
      const kv = mapKv()
      kv.put(key, bytes)
      const store = kvSentMessages(kv, SCOPE, 'f1')
      expect(store.forOffer(OFFER)).toEqual([])
      store.save(installment)
      expect(store.forOffer(OFFER)).toEqual([installment])
    }
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

  it('records the message under the finalized txid, once finalize ran', () => {
    const store = kvSentMessages(mapKv(), SCOPE, 'f1')
    const inner = built()
    const recording = recordingSent(inner, store, sent)
    expect(recording.pset).toBe(inner.pset)
    expect(store.forOffer(OFFER)).toEqual([])
    const before = Date.now()
    expect(recording.finalize({} as Pset).summary).toBe('summary')
    expect(inner.finalized).toBe(1)
    const [record] = store.forOffer(OFFER)
    expect(record).toEqual({ ...sent, txid: TXID, savedAt: record.savedAt })
    expect(record.savedAt).toBeGreaterThanOrEqual(before)
  })

  it('records a transaction without a message as such', () => {
    const store = kvSentMessages(mapKv(), SCOPE, 'f1')
    recordingSent(built(), store, { offerTxid: OFFER, phase: 'repayment' }).finalize({} as Pset)
    expect(store.forOffer(OFFER)).toEqual([
      { offerTxid: OFFER, txid: TXID, phase: 'repayment', savedAt: expect.any(Number) },
    ])
  })

  it('never holds up the transaction: without a store, or when the save throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const throwing = {
        save: () => {
          throw new Error('quota')
        },
        forOffer: () => [],
      }
      for (const store of [undefined, throwing]) {
        expect(recordingSent(built(), store, sent).finalize({} as Pset).summary).toBe('summary')
      }
      expect(error).toHaveBeenCalledTimes(2)
      // the console never shows the text
      expect(JSON.stringify(error.mock.calls.map(([text]) => text))).not.toContain(sent.text)
    } finally {
      error.mockRestore()
    }
  })
})
