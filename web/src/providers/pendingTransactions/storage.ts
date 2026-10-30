import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

import { normalizeHex } from '@/utils/hex'

import type { PendingTxRecord, PrivateTxRecord } from './types'

const DB_NAME = 'simplicity-lending:pending-transactions'
const DB_VERSION = 1
const STORE_NAME = 'pending-tx'
const WALLET_INDEX = 'by-wallet-script-pubkey'

interface PendingTxDBSchema extends DBSchema {
  [STORE_NAME]: {
    key: string
    value: PendingTxRecord
    indexes: { [WALLET_INDEX]: string }
  }
}

let dbPromise: Promise<IDBPDatabase<PendingTxDBSchema>> | null = null

function getDb(): Promise<IDBPDatabase<PendingTxDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<PendingTxDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'txid' })
        store.createIndex(WALLET_INDEX, 'walletScriptPubkey')
      },
    })
  }
  return dbPromise
}

export async function loadPendingTxsForWallet(
  walletScriptPubkey: string,
): Promise<PendingTxRecord[]> {
  const db = await getDb()
  return db.getAllFromIndex(STORE_NAME, WALLET_INDEX, normalizeHex(walletScriptPubkey))
}

export async function putPendingTx(record: PendingTxRecord): Promise<void> {
  const db = await getDb()
  await db.put(STORE_NAME, {
    ...record,
    walletScriptPubkey: normalizeHex(record.walletScriptPubkey),
  })
}

export async function deletePendingTx(txid: string): Promise<void> {
  const db = await getDb()
  await db.delete(STORE_NAME, txid)
}

// Private lending transactions live in their own database, so the public store above keeps its
// schema version and its readers never meet a private record.
const PRIVATE_DB_NAME = 'simplicity-lending:private-transactions'
const PRIVATE_DB_VERSION = 1
const PRIVATE_STORE_NAME = 'private-tx'

interface PrivateTxDBSchema extends DBSchema {
  [PRIVATE_STORE_NAME]: {
    key: string
    value: PrivateTxRecord
    indexes: { [WALLET_INDEX]: string }
  }
}

let privateDbPromise: Promise<IDBPDatabase<PrivateTxDBSchema>> | null = null

function getPrivateDb(): Promise<IDBPDatabase<PrivateTxDBSchema>> {
  privateDbPromise ??= openDB<PrivateTxDBSchema>(PRIVATE_DB_NAME, PRIVATE_DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore(PRIVATE_STORE_NAME, { keyPath: 'txid' })
      store.createIndex(WALLET_INDEX, 'walletScriptPubkey')
    },
  }).catch(error => {
    // Not cached, so a later call tries again.
    privateDbPromise = null
    throw error
  })
  return privateDbPromise
}

export async function loadPrivateTxsForWallet(
  walletScriptPubkey: string,
): Promise<PrivateTxRecord[]> {
  const db = await getPrivateDb()
  return db.getAllFromIndex(PRIVATE_STORE_NAME, WALLET_INDEX, normalizeHex(walletScriptPubkey))
}

export async function getPrivateTx(txid: string): Promise<PrivateTxRecord | undefined> {
  const db = await getPrivateDb()
  return db.get(PRIVATE_STORE_NAME, txid)
}

/** Resolves once the record is committed; rejects otherwise. */
export async function putPrivateTx(record: PrivateTxRecord): Promise<void> {
  const db = await getPrivateDb()
  await db.put(PRIVATE_STORE_NAME, {
    ...record,
    walletScriptPubkey: normalizeHex(record.walletScriptPubkey),
  })
}

export async function deletePrivateTx(txid: string): Promise<void> {
  const db = await getPrivateDb()
  await db.delete(PRIVATE_STORE_NAME, txid)
}
