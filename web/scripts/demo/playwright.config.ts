// The scripted testnet demo of both areas (`pnpm demo:testnet`, see `web/README.md`). One test,
// one worker, no retries: it broadcasts real Liquid testnet transactions, so it runs once, in
// order, and waits for blocks.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from '@playwright/test'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** The dev server's port, apart from `pnpm dev`'s default so that both can run. */
const PORT = 5199

/** The local testnet indexer that the dev server proxies under `/api`. */
const INDEXER_URL = process.env.DEMO_INDEXER_URL ?? 'http://127.0.0.1:8000'

/**
 * Esplora for the app and the e2e stages, instead of `.env.demo`'s: blockstream.info serves 700
 * requests an hour to an IP, which two wallets polling and an indexer can spend.
 */
const ESPLORA_URL = process.env.DEMO_ESPLORA_URL

export default defineConfig({
  testDir: '.',
  testMatch: 'demo.spec.ts',
  // The scripts import the app's modules by its `@/` alias.
  tsconfig: path.join(webRoot, 'tsconfig.node.json'),
  outputDir: path.join(webRoot, 'test-results'),
  // Liquid makes a block a minute; the whole run waits for about 40 of them.
  timeout: 120 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  // The list of steps only: a trace or a report could keep the seed phrases typed into the app.
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
  },
  webServer: {
    command: `pnpm dev --mode demo --port ${PORT} --strictPort`,
    cwd: webRoot,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      API_PROXY_TARGET: INDEXER_URL,
      // The local indexer serves at `/`, not under `/api`.
      API_PROXY_STRIP_PREFIX: 'true',
      // No analytics from a scripted run, whatever `.env.local` sets.
      VITE_GA_MEASUREMENT_ID: '',
      ...(ESPLORA_URL && { VITE_ESPLORA_BASE_URL: ESPLORA_URL }),
    },
  },
})
