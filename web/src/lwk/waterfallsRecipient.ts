// The waterfalls server's age recipient, which LWK encrypts the wallet descriptor to. The server
// publishes it at `/v1/server_recipient`, so it is fetched rather than configured: a configured
// copy goes stale when the server rotates its key, and every wallet sync then fails with
// `CannotDecrypt`. A pinned key (VITE_WATERFALLS_RECIPIENT) still wins when one is set.
//
// DOM-free and free of `@/constants/env`, so the Node scripts use it too.

/** An age X25519 recipient: `age1` and 58 bech32 characters (32 bytes plus the checksum). */
const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/

const FETCH_TIMEOUT_MS = 10_000

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

function checked(recipient: string, source: string): string {
  if (!AGE_RECIPIENT.test(recipient)) {
    throw new Error(`${source} is not an age recipient: ${JSON.stringify(recipient.slice(0, 80))}`)
  }
  return recipient
}

/**
 * Returns `resolve(waterfallsUrl, pinned?)`. Each server's key is fetched once and kept for the
 * page's lifetime; a failed fetch is dropped, so the next call tries again.
 */
export function createWaterfallsRecipientResolver(fetchFn: Fetch = (...args) => fetch(...args)) {
  const cache = new Map<string, Promise<string>>()

  async function load(url: string): Promise<string> {
    const endpoint = `${url}/v1/server_recipient`
    const response = await fetchFn(endpoint, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`${endpoint} answered HTTP ${response.status}`)
    return checked((await response.text()).trim(), endpoint)
  }

  return function resolve(waterfallsUrl: string, pinned?: string): Promise<string> {
    if (pinned) {
      try {
        return Promise.resolve(checked(pinned, 'VITE_WATERFALLS_RECIPIENT'))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const url = waterfallsUrl.replace(/\/+$/, '')
    let recipient = cache.get(url)
    if (!recipient) {
      recipient = load(url)
      cache.set(url, recipient)
      recipient.catch(() => cache.delete(url))
    }
    return recipient
  }
}

export const resolveWaterfallsRecipient = createWaterfallsRecipientResolver()
