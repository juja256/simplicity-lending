import { QueryClient, QueryObserver, type QueryObserverResult } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'

import { keptReadError } from './useReadError'

/**
 * `observer`, subscribed for the whole test, and `until`, which resolves with its first result
 * from now on that passes `done` (or the current one, if it does).
 */
function watch<T>(observer: QueryObserver<T, Error>) {
  let waiting: ((result: QueryObserverResult<T, Error>) => boolean) | undefined
  const unsubscribe = observer.subscribe(result => {
    if (waiting?.(result)) waiting = undefined
  })
  const until = (done: (result: QueryObserverResult<T, Error>) => boolean) =>
    new Promise<QueryObserverResult<T, Error>>(resolve => {
      const current = observer.getCurrentResult()
      if (done(current)) return resolve(current)
      waiting = result => {
        if (!done(result)) return false
        resolve(result)
        return true
      }
    })
  return { until, unsubscribe }
}

describe('keptReadError', () => {
  let client: QueryClient
  afterEach(() => client.clear())

  // React Query v5 puts an errored query without data back to `pending` while it fetches again,
  // its `error` and `failureReason` both null until that attempt fails: a notice that read them
  // would flip to "Reading…" every 30 seconds.
  it('keeps the error through a refetch, and drops it once the read succeeds', async () => {
    client = new QueryClient()
    let fail = true
    let finish: (value: string) => void = () => {}
    const observer = new QueryObserver<string, Error>(client, {
      queryKey: ['read'],
      retry: false,
      queryFn: () =>
        fail
          ? Promise.reject(new Error('esplora is down'))
          : new Promise(resolve => (finish = resolve)),
    })

    const { until, unsubscribe } = watch(observer)
    const errored = await until(result => result.status === 'error')
    let kept = keptReadError(undefined, errored)
    expect(kept?.message).toBe('esplora is down')

    fail = false
    void observer.refetch()
    const refetching = await until(result => result.fetchStatus === 'fetching')
    expect(refetching.status).toBe('pending')
    expect(refetching.error ?? refetching.failureReason).toBeNull()
    kept = keptReadError(kept, refetching)
    expect(kept?.message).toBe('esplora is down')

    finish('the loan')
    const read = await until(result => result.status === 'success')
    expect(keptReadError(kept, read)).toBeUndefined()
    unsubscribe()
  })

  it('takes a newer error, and the failure of an attempt before its retry', () => {
    const first = new Error('first')
    const second = new Error('second')
    const result = (error: Error | null, failureReason: Error | null) => ({
      data: undefined,
      error,
      failureReason,
    })
    expect(keptReadError(undefined, result(null, null))).toBeUndefined()
    expect(keptReadError(undefined, result(null, first))).toBe(first)
    expect(keptReadError(first, result(second, second))).toBe(second)
    expect(keptReadError(first, { data: 'read', error: null, failureReason: null })).toBeUndefined()
  })
})
