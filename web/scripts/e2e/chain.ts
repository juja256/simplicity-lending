// Esplora access for the e2e run.
import { Transaction } from '@lilbonekit/lwk-web'

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

export interface Chain {
  fetchTx(txid: string): Promise<Transaction>
  broadcast(hex: string): Promise<string>
  tipHeight(): Promise<number>
  waitForConfirmation(txid: string): Promise<void>
}

export function createChain(esploraApi: string): Chain {
  const chain: Chain = {
    async fetchTx(txid) {
      return Transaction.fromString(
        (await (await get(esploraApi, `/tx/${txid}/hex`)).text()).trim(),
      )
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
  }
  return chain
}
