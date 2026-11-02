// The indexer side of the `scan` stage: an in-memory scan store, as the app keeps one in
// `PersistentKv`, and a local proxy in front of the indexer API that records every request and
// can play a hostile indexer.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ScanStore } from '@/privateLending/scan'
import { kvScanStore } from '@/privateLending/scanStore'

/**
 * A scan store in memory, through the app's encoding and keys (`kvScanStore` over a `Map` in place
 * of `PersistentKv`). Every read decodes a fresh copy, so a caller cannot change what it saved.
 */
export function memoryScanStore(): ScanStore {
  const saved = new Map<string, Uint8Array>()
  return kvScanStore(
    { get: key => saved.get(key), put: (key, value) => saved.set(key, value.slice()) },
    { network: 'liquidtestnet', apiBaseUrl: 'e2e' },
  )
}

export interface IndexerProxy {
  /** The base URL to give the API client in place of the indexer's. */
  url: string
  /** The path and query of every request, oldest first. */
  requests: URL[]
  /**
   * While set, `GET /private/candidates/{candidate}/tx` answers with the creation transaction of
   * `servedTx`: a hostile indexer that pairs one offer's candidate with another offer's
   * transaction.
   */
  substitute: { candidate: string; servedTx: string } | null
  close(): Promise<void>
}

/** Starts a proxy on a free local port that forwards GET requests to `apiUrl`. */
export async function startIndexerProxy(apiUrl: string): Promise<IndexerProxy> {
  const server = http.createServer((request, response) => {
    void forward(request, response)
  })
  const proxy: IndexerProxy = {
    url: '',
    requests: [],
    substitute: null,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections()
        server.close(error => (error ? reject(error) : resolve()))
      }),
  }

  async function forward(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://proxy')
      proxy.requests.push(url)
      if (request.method !== 'GET') {
        response.writeHead(405).end()
        return
      }
      const substitute = proxy.substitute
      const path =
        substitute !== null && url.pathname === `/private/candidates/${substitute.candidate}/tx`
          ? `/private/candidates/${substitute.servedTx}/tx`
          : url.pathname
      const upstream = await fetch(`${apiUrl}${path}${url.search}`)
      const body = Buffer.from(await upstream.arrayBuffer())
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      })
      response.end(body)
    } catch (error) {
      response.writeHead(502).end(error instanceof Error ? error.message : String(error))
    }
  }

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  proxy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return proxy
}
