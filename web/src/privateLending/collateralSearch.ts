// The lender's search for a loan's collateral (`CollateralFinder`), run in a Web Worker
// (`searchWorker.ts`) so that the page stays responsive, with its result kept per loan state for
// the session: a loan output's value commitment and asset commitment name its state, and the
// search's answer for them never changes.
import type { CollateralFinder, CollateralSearchInput } from './flows/liquidation'
import type { SearchRequest, SearchResponse } from './searchWorker'

const found = new Map<string, Promise<bigint | undefined>>()
let nextId = 0

/** Searches running at once: each takes a worker's CPU for seconds, and holds its own wasm copy. */
const MAX_RUNNING = Math.max(1, Math.min(2, globalThis.navigator?.hardwareConcurrency ?? 2))
let running = 0
const waiting: (() => void)[] = []

/** `run` when fewer than `MAX_RUNNING` searches run; later ones wait their turn. */
async function queued<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_RUNNING) await new Promise<void>(resolve => waiting.push(resolve))
  running += 1
  try {
    return await run()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/** Forgets the searches' answers: the session that asked for them ended. */
export function clearFoundCollaterals(): void {
  found.clear()
}

function searchKey(search: CollateralSearchInput): string {
  return `${search.valueCommitment}:${search.assetCommitment}:${search.max}`
}

/** One search in a fresh worker, terminated once it answers. */
function searchInWorker(search: CollateralSearchInput): Promise<bigint | undefined> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' })
    const id = (nextId += 1)
    worker.onmessage = (event: MessageEvent<SearchResponse>) => {
      if (event.data.id !== id) return
      worker.terminate()
      if ('error' in event.data) reject(new Error(`The collateral search: ${event.data.error}`))
      else resolve(event.data.amount ?? undefined)
    }
    worker.onerror = event => {
      worker.terminate()
      reject(new Error(`The collateral search failed: ${event.message || 'worker error'}`))
    }
    const request: SearchRequest = { id, ...search }
    worker.postMessage(request)
  })
}

/**
 * The collateral `c_k` the loan output of `search` holds, by the wasm's search in a Web Worker,
 * or undefined when it holds no amount up to `search.max`. A search already run, or running, for
 * the same loan state gives its result again; a failed one is not kept.
 */
export const findCollateralInWorker: CollateralFinder = search => {
  const key = searchKey(search)
  const known = found.get(key)
  if (known !== undefined) return known
  const result = queued(() => searchInWorker(search))
  found.set(key, result)
  result.catch(() => found.delete(key))
  return result
}
