// Offline regression checks for single-flight wallet scans. Run with:
//   TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx scripts/check-wallet-sync.ts
import assert from 'node:assert/strict'

import type { EsploraClient, Wollet } from '@lilbonekit/lwk-web'

import { syncBalances } from '../src/lib/wallet-core/wallet/sync'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fakeWallet() {
  const appliedUpdates: unknown[] = []
  const wollet = {
    balance: () => new Map([['asset-id', 7n]]),
    utxos: () => [],
    applyUpdate: (update: unknown) => appliedUpdates.push(update),
  } as unknown as Wollet
  return { wollet, appliedUpdates }
}

function fakeEsplora(fullScanToIndex: (wollet: Wollet, index: number) => Promise<unknown>) {
  return { fullScanToIndex } as unknown as EsploraClient
}

type SyncBalances = typeof import('../src/lib/wallet-core/wallet/sync').syncBalances
const runSyncBalances: SyncBalances = syncBalances

async function concurrentCallsShareOneScan(): Promise<void> {
  const { wollet, appliedUpdates } = fakeWallet()
  const scan = deferred<unknown>()
  const update = { marker: 'one-update' }
  let scanCalls = 0
  let scannedWallet: Wollet | null = null
  const esplora = fakeEsplora((target, index) => {
    scanCalls++
    scannedWallet = target
    assert.equal(index, 0)
    return scan.promise
  })

  const first = runSyncBalances(wollet, esplora)
  const second = runSyncBalances(wollet, esplora)
  await Promise.resolve()
  assert.equal(scanCalls, 1, 'concurrent syncs for one wallet must share the scan')
  scan.resolve(update)

  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.strictEqual(scannedWallet, wollet)
  assert.deepEqual(firstResult, secondResult)
  assert.deepEqual(firstResult.total, { 'asset-id': '7' })
  assert.equal(appliedUpdates.length, 1, 'the shared update must only be applied once')
  assert.strictEqual(appliedUpdates[0], update)
}

async function rejectedScanCanRetry(): Promise<void> {
  const { wollet, appliedUpdates } = fakeWallet()
  const firstScan = deferred<unknown>()
  let scanCalls = 0
  const esplora = fakeEsplora(() => {
    scanCalls++
    return scanCalls === 1 ? firstScan.promise : Promise.resolve({ marker: 'retry' })
  })

  const first = runSyncBalances(wollet, esplora)
  const joined = runSyncBalances(wollet, esplora)
  await Promise.resolve()
  assert.equal(scanCalls, 1, 'the joined call must not start another scan')
  const failure = new Error('scan failed')
  firstScan.reject(failure)

  const [firstResult, joinedResult] = await Promise.allSettled([first, joined])
  assert.equal(firstResult.status, 'rejected')
  assert.equal(joinedResult.status, 'rejected')
  if (firstResult.status === 'rejected') assert.strictEqual(firstResult.reason, failure)
  if (joinedResult.status === 'rejected') assert.strictEqual(joinedResult.reason, failure)

  const retried = await runSyncBalances(wollet, esplora)
  assert.equal(scanCalls, 2, 'a settled failed scan must be removed so a retry can start')
  assert.deepEqual(retried.total, { 'asset-id': '7' })
  assert.equal(appliedUpdates.length, 1)
}

async function walletsDoNotBlockEachOther(): Promise<void> {
  const firstWallet = fakeWallet()
  const secondWallet = fakeWallet()
  const firstScan = deferred<unknown>()
  const secondScan = deferred<unknown>()
  const calls = new Map<Wollet, number>()
  const esplora = fakeEsplora(wallet => {
    calls.set(wallet, (calls.get(wallet) ?? 0) + 1)
    return wallet === firstWallet.wollet ? firstScan.promise : secondScan.promise
  })

  const first = runSyncBalances(firstWallet.wollet, esplora)
  const second = runSyncBalances(secondWallet.wollet, esplora)
  await Promise.resolve()
  assert.equal(calls.get(firstWallet.wollet), 1)
  assert.equal(calls.get(secondWallet.wollet), 1)

  const firstUpdate = { marker: 'first-wallet' }
  const secondUpdate = { marker: 'second-wallet' }
  firstScan.resolve(firstUpdate)
  secondScan.resolve(secondUpdate)
  await Promise.all([first, second])
  assert.deepEqual(firstWallet.appliedUpdates, [firstUpdate])
  assert.deepEqual(secondWallet.appliedUpdates, [secondUpdate])
}

async function main(): Promise<void> {
  await concurrentCallsShareOneScan()
  process.stdout.write('ok   concurrent calls share one scan and update\n')
  await rejectedScanCanRetry()
  process.stdout.write('ok   a rejected scan clears the shared flight for retry\n')
  await walletsDoNotBlockEachOther()
  process.stdout.write('ok   scans for separate wallets proceed independently\n')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
