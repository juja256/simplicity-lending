// The messages this wallet sent, over the scan database's key-value store (the app's
// `PersistentKv`; a `Map` in Node), kept per network and lending-key fingerprint.
//
// Unlike the scan states beside it, this store holds plaintext: the text of every acceptance,
// installment and full repayment this browser sends, or a record that it sent none. Their range
// proofs' nonces are random for the acceptance and the full repayment, so the sender cannot reread
// them from the chain; the record is how the timeline shows them. The trade-off is decided: like
// the saved transactions, they stay on the device after a disconnect. A sent message records its
// transaction's txid, for the timeline to match against the loan's transactions, so that a
// discarded draft's text never shows as sent.
//
// A stored value that does not decode reads as no messages, and the next save starts over.
import { z as zod } from 'zod'

import type { UpdatedPset } from '@/lwk/updatedPset'

import type { ScanKv, ScanScope } from './scanStore'

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
   * Records `message`, replacing an earlier record of the same transaction. Throws for a message
   * the store could not read back (a txid that is not 64 lowercase hex characters, an empty text,
   * an installment without its index), so one bad record never makes the others unreadable.
   */
  save(message: SentMessage): void
  /** The records of the offer whose creation txid is `offerTxid`, in the order they were saved. */
  forOffer(offerTxid: string): SentMessage[]
}

const STORE_VERSION = 1

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const txidSchema = zod.string().regex(/^[0-9a-f]{64}$/)

const common = {
  offerTxid: txidSchema,
  txid: txidSchema,
  text: zod.string().min(1).optional(),
  savedAt: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}

const messageSchema = zod.discriminatedUnion('phase', [
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

const storedSchema = zod
  .object({ version: zod.literal(STORE_VERSION), messages: zod.array(messageSchema) })
  .strict()

/** The key of a wallet's sent messages: `sent`, the network and the lending-key fingerprint. */
export function sentMessagesKey(scope: ScanScope, fingerprint: string): string {
  return JSON.stringify(['sent', scope.network, fingerprint])
}

/** Copies only the fields of `SentMessage`, so nothing else a caller attached is ever stored. */
function toStored(message: SentMessage): SentMessage {
  return {
    offerTxid: message.offerTxid,
    txid: message.txid,
    phase: message.phase,
    ...(message.phase === 'installment' ? { installment: message.installment } : {}),
    ...(message.text === undefined ? {} : { text: message.text }),
    savedAt: message.savedAt,
  }
}

function decode(bytes: Uint8Array): SentMessage[] | undefined {
  try {
    const parsed = storedSchema.safeParse(JSON.parse(decoder.decode(bytes)))
    return parsed.success ? parsed.data.messages : undefined
  } catch {
    return undefined
  }
}

/** The sent messages of the wallet with `fingerprint` on `scope`'s network, kept in `kv`. */
export function kvSentMessages(kv: ScanKv, scope: ScanScope, fingerprint: string): SentMessages {
  const key = sentMessagesKey(scope, fingerprint)
  const read = (): SentMessage[] => {
    const bytes = kv.get(key)
    return (bytes === undefined ? undefined : decode(bytes)) ?? []
  }
  return {
    save(message) {
      const stored = messageSchema.parse(toStored(message))
      const messages = read().filter(saved => saved.txid !== stored.txid)
      messages.push(stored)
      const value = { version: STORE_VERSION, messages }
      kv.put(key, encoder.encode(JSON.stringify(value)))
    },
    forOffer(offerTxid) {
      return read().filter(message => message.offerTxid === offerTxid)
    },
  }
}

/**
 * `built`, whose `finalize` also records `sent` in `store` under the finalized transaction's txid,
 * as the caller goes on to save the transaction itself, before its first broadcast. Without a
 * store, or when the record cannot be saved, the console says so (never with the text) and the
 * transaction goes on all the same: a record never holds up a payment.
 */
export function recordingSent<TSummary>(
  built: UpdatedPset<TSummary>,
  store: SentMessages | undefined,
  sent: Omit<SentMessage, 'txid' | 'savedAt'>,
): UpdatedPset<TSummary> {
  return {
    pset: built.pset,
    finalize: signedPset => {
      const finalized = built.finalize(signedPset)
      const txid = finalized.finalizedTx.txid().toString()
      try {
        if (store === undefined) throw new Error('The store of sent messages did not open')
        store.save({ ...sent, txid, savedAt: Date.now() })
      } catch (error) {
        console.error(`The ${sent.phase} ${txid} was sent without a record of its message`, error)
      }
      return finalized
    },
  }
}
