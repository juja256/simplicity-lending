// `.e2e-private/state.json`: one record per stage, so a re-run skips what is already on chain, the
// borrower NFT receiver of each creation, and each wallet's identity script.
import fs from 'node:fs'
import path from 'node:path'

import { webRoot } from './env'

export interface StageRecord {
  stage: string
  txid: string
  hex: string
  status: 'built' | 'broadcast' | 'confirmed'
}

interface State {
  records: Record<string, StageRecord>
  /** The borrower NFT receiver of each creation, by its record. */
  nftReceivers: Record<string, string>
  /** Each wallet's identity script (`walletIdentityScript`), saved by the `wallets` stage. */
  walletIdentities: Record<string, string>
}

const stateFile = path.join(webRoot, '.e2e-private/state.json')

function readAll(): State {
  const state: State = { records: {}, nftReceivers: {}, walletIdentities: {} }
  if (!fs.existsSync(stateFile)) return state
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as Partial<State>
  // A file from before the receivers and identities holds the records only.
  if (parsed.records === undefined) {
    return { ...state, records: parsed as unknown as Record<string, StageRecord> }
  }
  return { ...state, ...parsed }
}

function writeAll(state: State): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

export function getRecord(stage: string): StageRecord | undefined {
  return readAll().records[stage]
}

export function saveRecord(record: StageRecord): void {
  const state = readAll()
  state.records[record.stage] = record
  writeAll(state)
}

export function getNftReceivers(): Record<string, string> {
  return readAll().nftReceivers
}

export function saveNftReceiver(creation: string, address: string): void {
  const state = readAll()
  state.nftReceivers[creation] = address
  writeAll(state)
}

export function getWalletIdentity(wallet: string): string | undefined {
  return readAll().walletIdentities[wallet]
}

export function saveWalletIdentity(wallet: string, script: string): void {
  const state = readAll()
  state.walletIdentities[wallet] = script
  writeAll(state)
}
