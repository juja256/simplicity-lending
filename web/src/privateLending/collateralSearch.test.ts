import { afterEach, describe, expect, it, vi } from 'vitest'

import { findCollateralInWorker } from './collateralSearch'
import type { SearchRequest, SearchResponse } from './searchWorker'

/** A stand-in of the search worker: it answers `answer` to every request, after a tick. */
function stubWorker(answer: (request: SearchRequest) => SearchResponse) {
  const spawned: string[] = []
  class StubWorker {
    onmessage: ((event: { data: SearchResponse }) => void) | null = null
    onerror: ((event: { message: string }) => void) | null = null
    terminated = false
    constructor(url: URL) {
      spawned.push(url.pathname.split('/').at(-1) ?? '')
    }
    postMessage(request: SearchRequest) {
      setTimeout(() => this.onmessage?.({ data: answer(request) }))
    }
    terminate() {
      this.terminated = true
    }
  }
  vi.stubGlobal('Worker', StubWorker)
  return spawned
}

const search = (valueCommitment: string) => ({
  valueCommitment,
  assetCommitment: '0a'.repeat(33),
  blinder: '11'.repeat(32),
  max: 1n << 44n,
})

describe('findCollateralInWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs the search in the search worker, once per loan state', async () => {
    const spawned = stubWorker(request => ({ id: request.id, amount: request.max - 1n }))
    await expect(findCollateralInWorker(search('08'.repeat(33)))).resolves.toBe((1n << 44n) - 1n)
    await expect(findCollateralInWorker(search('08'.repeat(33)))).resolves.toBe((1n << 44n) - 1n)
    expect(spawned).toEqual(['searchWorker.ts'])
    await findCollateralInWorker(search('09'.repeat(33)))
    expect(spawned).toHaveLength(2)
  })

  it('gives undefined when nothing is found, and does not keep a failed search', async () => {
    stubWorker(request => ({ id: request.id, amount: null }))
    await expect(findCollateralInWorker(search('a8'.repeat(33)))).resolves.toBeUndefined()
    const spawned = stubWorker(request => ({ id: request.id, error: 'bad-input: no' }))
    await expect(findCollateralInWorker(search('a9'.repeat(33)))).rejects.toThrow('bad-input: no')
    stubWorker(request => ({ id: request.id, amount: 5n }))
    await expect(findCollateralInWorker(search('a9'.repeat(33)))).resolves.toBe(5n)
    expect(spawned).toHaveLength(1)
  })
})
