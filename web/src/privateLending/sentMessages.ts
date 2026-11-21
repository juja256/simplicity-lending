// The messages this wallet sent, in an IndexedDB database of their own: one record per transaction,
// keyed by its txid, with the network and the lending-key fingerprint of the wallet that sent it.
//
// Unlike the scan states, this store holds plaintext: the text of every acceptance, installment and
// full repayment this browser sends, or a record that it sent none. Their range proofs' nonces are
// random for the acceptance and the full repayment, so the sender cannot reread them from the
// chain; the record is how the timeline shows them. The trade-off is decided: like the saved
// transactions, they stay on the device after a disconnect. A sent message records its
// transaction's txid, for the timeline to match against the loan's transactions, so that a
// discarded draft's text never shows as sent.
//
// Every save is awaited before the transaction's first broadcast (`recordingSent`), and every read
// goes to IndexedDB, with nothing held in memory: the browser's tabs see each other's records, and
// no tab writes over another's. Earlier builds kept the records in the scan database's key-value
// store, under ['sent', network, fingerprint]; those are ignored, with no migration (v2 is a demo).
//
// A stored record that does not decode is skipped; the others still read.
import { type DBSchema, type IDBPDatabase, openDB } from 'idb'
import { z as zod } from 'zod'

import type { AsyncUpdatedPset, UpdatedPset } from '@/lwk/updatedPset'

/** A message this wallet sent, or the record that a transaction it sent carried none. */
export interface SentMessage {
  /** The offer's creation txid. */
  offerTxid: string
  /** The transaction that carried the message. */
  txid: string
  phase: 'acceptance' | 'installment' | 'repayment'
  /** The installment's index, from 1; only for `installment`. */
  installment?: number
  /** The text as sent; absent when the transaction carried no message. */
  text?: string
  /** When it was saved, in milliseconds since the epoch. */
  savedAt: number
}

/** The sent messages of one wallet on one network. */
export interface SentMessages {
  /**
   * Records `message` in IndexedDB, replacing an earlier record of the same transaction; resolves
   * once it is committed. Rejects for a message the store could not read back (a txid that is not
   * 64 lowercase hex characters, an empty text, an installment without its index), so one bad
   * record never makes the others unreadable, and when IndexedDB is unavailable or the write fails.
   */
  save(message: SentMessage): Promise<void>
  /**
   * The records of the offer whose creation txid is `offerTxid`, read from IndexedDB now, in the
   * order they were saved. Rejects when IndexedDB is unavailable.
   */
  forOffer(offerTxid: string): Promise<SentMessage[]>
}

export const SENT_MESSAGES_DB_NAME = 'simplicity-lending:sent-messages'
export const SENT_MESSAGES_STORE_NAME = 'sent'
const DB_VERSION = 1
const OFFER_INDEX = 'by-wallet-offer'

/** A record as stored: a sent message, and the wallet that sent it. */
type StoredMessage = SentMessage & { network: string; fingerprint: string }

interface SentMessagesDBSchema extends DBSchema {
  [SENT_MESSAGES_STORE_NAME]: {
    key: string
    value: StoredMessage
    indexes: { [OFFER_INDEX]: [string, string, string] }
  }
}

const txidSchema = zod.string().regex(/^[0-9a-f]{64}$/)

const common = {
  network: zod.string().min(1),
  fingerprint: zod.string().min(1),
  offerTxid: txidSchema,
  txid: txidSchema,
  text: zod.string().min(1).optional(),
  savedAt: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}

const storedSchema = zod.discriminatedUnion('phase', [
  zod.object({ ...common, phase: zod.literal('acceptance') }).strict(),
  zod
    .object({
      ...common,
      phase: zod.literal('installment'),
      installment: zod.number().int().min(1),
    })
    .strict(),
  zod.object({ ...common, phase: zod.literal('repayment') }).strict(),
])

/** Copies only the fields of `SentMessage`, so nothing else a caller attached is ever stored. */
function toSentMessage(message: SentMessage): SentMessage {
  return {
    offerTxid: message.offerTxid,
    txid: message.txid,
    phase: message.phase,
    ...(message.phase === 'installment' ? { installment: message.installment } : {}),
    ...(message.text === undefined ? {} : { text: message.text }),
    savedAt: message.savedAt,
  }
}

/** How long `recordingSent` waits for a record to be committed before the payment goes on. */
export const SAVE_TIMEOUT_MS = 3_000

let dbPromise: Promise<IDBPDatabase<SentMessagesDBSchema>> | null = null

/**
 * The database, opened once per page; rejects where IndexedDB is unavailable, and when another
 * connection blocks the open. A connection that blocks another's upgrade or deletion, or that the
 * browser terminates, is closed and dropped, so the next call opens a new one.
 */
function getDb(): Promise<IDBPDatabase<SentMessagesDBSchema>> {
  if (dbPromise !== null) return dbPromise
  let opened: IDBPDatabase<SentMessagesDBSchema> | undefined
  const drop = () => {
    opened?.close()
    if (dbPromise === promise) dbPromise = null
  }
  const promise = new Promise<IDBPDatabase<SentMessagesDBSchema>>((resolve, reject) => {
    let refused = false
    openDB<SentMessagesDBSchema>(SENT_MESSAGES_DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(SENT_MESSAGES_STORE_NAME, { keyPath: 'txid' })
        store.createIndex(OFFER_INDEX, ['network', 'fingerprint', 'offerTxid'])
      },
      blocked() {
        refused = true
        reject(new Error('Another connection blocks the database of sent messages'))
      },
      blocking: drop,
      terminated: drop,
    }).then(db => {
      // opened after all, once the open was given up on: not kept
      if (refused) return db.close()
      opened = db
      resolve(db)
    }, reject)
  }).catch((error: unknown) => {
    // Not cached, so a later call tries again.
    if (dbPromise === promise) dbPromise = null
    throw error
  })
  dbPromise = promise
  return promise
}

/** The sent messages of the wallet with lending-key fingerprint `fingerprint` on `network`. */
export function sentMessagesOf(network: string, fingerprint: string): SentMessages {
  return {
    async save(message) {
      const stored = storedSchema.parse({ ...toSentMessage(message), network, fingerprint })
      const db = await getDb()
      await db.put(SENT_MESSAGES_STORE_NAME, stored)
    },
    async forOffer(offerTxid) {
      const db = await getDb()
      const records = await db.getAllFromIndex(SENT_MESSAGES_STORE_NAME, OFFER_INDEX, [
        network,
        fingerprint,
        offerTxid,
      ])
      return records
        .flatMap(record => {
          const parsed = storedSchema.safeParse(record)
          return parsed.success ? [toSentMessage(parsed.data)] : []
        })
        .sort((a, b) => a.savedAt - b.savedAt)
    },
  }
}

/**
 * `built`, whose `finalize` also records `sent` in `store` under the finalized transaction's txid,
 * and resolves once the record is committed: the caller goes on to save the transaction itself,
 * then broadcasts it. When the record cannot be saved (IndexedDB unavailable, or the write failed)
 * or is not committed within `SAVE_TIMEOUT_MS`, the console says so with the phase and the txid
 * only, never the text, and the transaction goes on all the same: a record never holds up a
 * payment. A save given up on may still commit; its late failure is ignored.
 */
export function recordingSent<TSummary>(
  built: UpdatedPset<TSummary>,
  store: SentMessages,
  sent: Omit<SentMessage, 'txid' | 'savedAt'>,
): AsyncUpdatedPset<TSummary> {
  return {
    pset: built.pset,
    finalize: async signedPset => {
      const finalized = built.finalize(signedPset)
      const txid = finalized.finalizedTx.txid().toString()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const saving = store.save({ ...sent, txid, savedAt: Date.now() })
        // the save may settle after the timeout: its rejection is then nobody's to handle
        saving.catch(() => {})
        await Promise.race([
          saving,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Not committed within ${SAVE_TIMEOUT_MS} ms`)),
              SAVE_TIMEOUT_MS,
            )
          }),
        ])
      } catch (error) {
        console.error(`The ${sent.phase} ${txid} was sent without a record of its message`, error)
      } finally {
        clearTimeout(timer)
      }
      return finalized
    },
  }
}
