// Esplora access for the e2e run.
import { Transaction } from '@lilbonekit/lwk-web'

import { getRecord, saveRecord } from './state'

const POLL_MS = 10_000
const TIMEOUT_MS = 10 * 60_000

// Retries network errors (not HTTP errors): public esplora drops connections now and then.
async function get(base: string, route: string): Promise<Response> {
  let response: Response | undefined
  for (let attempt = 0; response === undefined; attempt += 1) {
    try {
      response = await fetch(`${base}${route}`)
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
  }
  if (!response.ok) throw new Error(`GET ${route}: ${response.status} ${await response.text()}`)
  return response
}

/** What esplora reports of a transaction's timelock and confirmation. */
export interface TxTimelock {
  lockTime: number
  /** Each input's nSequence. */
  sequences: number[]
  /** The confirming block's height, or null while unconfirmed. */
  blockHeight: number | null
}

export interface Chain {
  fetchTx(txid: string): Promise<Transaction>
  /** Each input's script witness, as esplora reports it: one hex string per stack item. */
  fetchWitnesses(txid: string): Promise<string[][]>
  fetchTimelock(txid: string): Promise<TxTimelock>
  broadcast(hex: string): Promise<string>
  tipHeight(): Promise<number>
  waitForConfirmation(txid: string): Promise<void>
  /** Polls until the tip reaches `height`; returns the tip. */
  waitForTip(height: number): Promise<number>
}

export function createChain(esploraApi: string): Chain {
  const chain: Chain = {
    async fetchTx(txid) {
      return Transaction.fromString(
        (await (await get(esploraApi, `/tx/${txid}/hex`)).text()).trim(),
      )
    },
    async fetchWitnesses(txid) {
      const tx = (await (await get(esploraApi, `/tx/${txid}`)).json()) as {
        vin: { witness?: string[] }[]
      }
      return tx.vin.map(input => input.witness ?? [])
    },
    async fetchTimelock(txid) {
      const tx = (await (await get(esploraApi, `/tx/${txid}`)).json()) as {
        locktime: number
        vin: { sequence: number }[]
        status: { confirmed: boolean; block_height?: number }
      }
      return {
        lockTime: tx.locktime,
        sequences: tx.vin.map(input => input.sequence),
        blockHeight:
          tx.status.confirmed && tx.status.block_height !== undefined
            ? tx.status.block_height
            : null,
      }
    },
    async broadcast(hex) {
      const response = await fetch(`${esploraApi}/tx`, { method: 'POST', body: hex })
      const text = (await response.text()).trim()
      if (!response.ok) throw new Error(`broadcast failed: ${response.status} ${text}`)
      return text
    },
    async tipHeight() {
      return Number((await (await get(esploraApi, '/blocks/tip/height')).text()).trim())
    },
    async waitForConfirmation(txid) {
      const deadline = Date.now() + TIMEOUT_MS
      for (;;) {
        const status = (await (await get(esploraApi, `/tx/${txid}/status`)).json()) as {
          confirmed: boolean
        }
        if (status.confirmed) return
        if (Date.now() > deadline) throw new Error(`${txid} not confirmed within 10 minutes`)
        await new Promise(resolve => setTimeout(resolve, POLL_MS))
      }
    },
    async waitForTip(height) {
      const deadline = Date.now() + TIMEOUT_MS
      for (;;) {
        const tip = await chain.tipHeight()
        if (tip >= height) return tip
        if (Date.now() > deadline) throw new Error(`the tip did not reach ${height} in 10 minutes`)
        await new Promise(resolve => setTimeout(resolve, POLL_MS))
      }
    },
  }
  return chain
}

const ALREADY_KNOWN = /already|txn-same-nonwitness-data-in-mempool/i

/**
 * Runs one transaction stage so that a crash never makes a re-run build a different transaction.
 * A `built`/`broadcast` record rebroadcasts its saved hex ("already known" counts as success) and
 * waits for confirmation; only a stage without a record calls `build`. `afterBroadcast` runs after
 * each (re)broadcast, before the wait.
 */
export async function submitStage(
  chain: Chain,
  stage: string,
  build: () => string,
  log: (line: string) => void,
  afterBroadcast?: (txid: string) => Promise<void>,
): Promise<string> {
  let record = getRecord(stage)
  if (record?.status === 'confirmed') {
    log(`${stage}: ${record.txid} already confirmed`)
    return record.txid
  }
  if (!record) {
    const hex = build()
    const txid = Transaction.fromString(hex).txid().toString()
    record = { stage, txid, hex, status: 'built' }
    saveRecord(record)
  }
  if (record.status === 'built') {
    try {
      await chain.broadcast(record.hex)
    } catch (error) {
      if (!ALREADY_KNOWN.test(error instanceof Error ? error.message : String(error))) throw error
    }
    record = { ...record, status: 'broadcast' }
    saveRecord(record)
    log(`${stage}: broadcast ${record.txid}`)
  } else {
    log(`${stage}: ${record.txid} already broadcast, rebroadcasting`)
    try {
      await chain.broadcast(record.hex)
    } catch (error) {
      if (!ALREADY_KNOWN.test(error instanceof Error ? error.message : String(error))) throw error
    }
  }
  if (afterBroadcast) await afterBroadcast(record.txid)
  await chain.waitForConfirmation(record.txid)
  saveRecord({ ...record, status: 'confirmed' })
  log(`${stage}: confirmed`)
  return record.txid
}
