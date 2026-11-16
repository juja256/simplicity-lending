import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from 'idb'

import { normalizeHex } from '@/utils/hex'

import type { PrivateTxRecord } from './types'

const WALLET_INDEX = 'by-wallet-script-pubkey'

// Private lending transactions live in a database of their own. The public pages' database is
// no longer opened, and startup deletes it.
const ORPHANED_PUBLIC_DB_NAME = 'simplicity-lending:pending-transactions'
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

/**
 * Deletes the public pages' database, which nothing opens any more. Called once at startup; a
 * failure leaves it for the next start, so errors are ignored, including a browser without
 * IndexedDB, which throws before the promise exists.
 */
export function deleteOrphanedPublicDb(): void {
  try {
    deleteDB(ORPHANED_PUBLIC_DB_NAME).catch(() => {})
  } catch {
    // Ignored, as above.
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
