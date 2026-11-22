// The lender's search for a loan's collateral, in a Web Worker: at `C = 2^44` the wasm's
// `findCollateral` takes about a second and 37–45 MiB (phase 7 task 4 measured 45 MiB of wasm
// linear memory, the 32 MiB table included), which would block the page. The worker loads
// its own copy of the private lending wasm and answers one search per message
// (`findCollateralInWorker` in `collateralSearch.ts` posts them). The step's blinder `x_k` is a
// secret of the offer: it reaches the worker by `postMessage`, never leaves the device, and is not
// logged.
import init, { findCollateral } from '@/wasm/private-lending/private_lending_wasm'

/** A search, as `findCollateralInWorker` posts it. */
export interface SearchRequest {
  id: number
  valueCommitment: string
  assetCommitment: string
  blinder: string
  max: bigint
}

/** The worker's answer: the amount found (null for none), or the wasm's error. */
export type SearchResponse = { id: number; amount: bigint | null } | { id: number; error: string }

// The worker's global scope: typed against the DOM's window, whose `postMessage` takes an origin.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null
  postMessage: (message: SearchResponse) => void
}

const ready = init()

scope.onmessage = event => {
  const { id, valueCommitment, assetCommitment, blinder, max } = event.data
  ready
    .then(() => {
      const amount = findCollateral(valueCommitment, assetCommitment, blinder, max)
      scope.postMessage({ id, amount: amount ?? null })
    })
    .catch((error: unknown) => {
      const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
      scope.postMessage({ id, error: text || 'the search failed' })
    })
}
