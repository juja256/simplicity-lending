# Uncaught WASM aliasing error and apparently unresolved scan during overlapping wallet refreshes

## Summary

During Liquid testnet testing, our application remained at **Constructing Transaction** and Chrome reported:

```text
Uncaught Error: recursive use of an object detected which would lead to unsafe aliasing in rust
```

The construction flow awaits `EsploraClient.fullScanToIndex(wollet, 0)` before building or signing. We found that our manual refresh could overlap a background refresh using the same `Wollet` and `EsploraClient` instances. Sharing one in-flight scan per wallet prevented that overlap, and the next browser attempt completed construction, signing, and finalization and reached the deliberately blocked broadcast.

**Attribution is not yet proven:** the application allowed concurrent calls. We did not instrument the failing run to prove their exact timing, identify which WASM object was borrowed, or produce an isolated library reproduction. We are reporting the uncaught error and apparent lack of promise settlement for investigation, and asking for the supported concurrency contract.

## Environment

- Package: `@lilbonekit/lwk-web` **`0.17.2-22d0c8f.1`**, verified in the installed package manifest.
- Browser: Google Chrome, incognito window, on macOS. Exact browser and OS versions were not captured.
- App: React 19.2.7, Vite 7.3.5 (installed versions), local development server.
- Network: Liquid testnet; software seed signer. This failure was not a Jade-device interaction.
- Scan configuration: `new EsploraClient(network, waterfallsUrl, true, 8, false)`; Waterfalls server recipient configured before scanning.
- Wallet: `WolletBuilder`, `utxoOnly(false)`, synchronous storage adapters backed by an IndexedDB cache, `withExperimentalStore`, `withTxsStore`, `withMergeThreshold(1)`.
- Date observed: 2026-11-02.

## Observed application sequence

1. Connect a funded testnet wallet and let its initial scan complete.
2. Complete an offer creation/cancellation flow, then prepare another offer.
3. Background balance refreshes run every 60 seconds and on window focus/visibility, with a 15-second minimum gap. Their boolean guard suppresses other background refreshes.
4. Click **Sign & Create Offer**. Construction first calls an explicit wallet refresh. Before our fix, this manual path set the guard but did not wait for an already-running scan.
5. The progress dialog stays on **Constructing Transaction**, with Close disabled. The console shows the uncaught WASM error below. The application does not reach its normal rejected-transaction error display.
6. Inspect the saved-transaction store: no new transaction from this attempt was saved. Earlier records remain intact.
7. Reloading recovers the page and wallet connection.

During this test, DevTools blocked the exact broadcast endpoint `https://blockstream.info/liquidtestnet/api/tx`. This was intentional for a later save/discard test. It was not a broad network block, and the stalled attempt had not reached broadcasting. After the application guard was added, the same blocking setup produced the expected saved-but-not-broadcast warning.

## Relevant application code before the fix

Both manual and background refreshes could enter this function concurrently:

```ts
async function syncBalances(wollet, esploraClient) {
  const update = await esploraClient.fullScanToIndex(wollet, 0)
  if (update) wollet.applyUpdate(update)
  return readWalletBalances(wollet) // balance() and utxos()
}
```

The manual refresh is awaited by transaction construction. The background path catches rejected promises, and the transaction flow also has a catch handler. Neither produced a recoverable transaction error in the observed stall. We have not established whether the unresolved operation was the scan itself or another continuation.

## Captured stack

```text
Uncaught Error: recursive use of an object detected which would lead to unsafe aliasing in rust
    at imports.wbg.__wbg_wbindgenthrow_451ec1a8469d7eb6 (lwk_wasm.js?v=8cff94a2:11836:15)
    at lwk_wasm_bg.wasm:0xa1f8b8
    at lwk_wasm_bg.wasm:0xa1f8d5
    at lwk_wasm_bg.wasm:0x5c6d79
    at lwk_wasm_bg.wasm:0x836e44
    at lwk_wasm_bg.wasm:0xa04772
    at lwk_wasm_bg.wasm:0xa04764
    at lwk_wasm_bg.wasm:0xa08fe5
    at __wbg_adapter_9 (lwk_wasm.js?v=8cff94a2:421:10)
    at real (lwk_wasm.js?v=8cff94a2:211:20)
```

The WASM frames displayed as `$func9844`, `$func9846`, `$func1388`, `$func3529`, `$func8978`, `$func8977`, and `$closure4571_externref_shim` in DevTools. The Vite query suffix is specific to this local run.

## Expected behavior / questions

- If concurrent scans are supported, they should settle without violating the WASM borrowing rules.
- If they are unsupported, please document which operations must be serialized and whether exclusivity applies to the `EsploraClient`, the `Wollet`, or both.
- Can reads such as `utxos()`/`balance()`, or mutations such as `applyTransaction()`, run while a scan is awaiting network responses?
- Can an unsupported overlapping call reject its returned promise with an actionable error, rather than leave the application waiting after an uncaught asynchronous exception?
- Is this known in this package build, and is there an upstream fix or recommended version?

An investigation could start by deliberately issuing two `fullScanToIndex` calls with the same initialized client and wallet before either settles. **We have not run or verified this as a standalone reproducer.** Testing with separate clients and separate wallets would help identify the object whose exclusivity matters.

## Application mitigation and verification

We added a `WeakMap<Wollet, Promise<WalletBalances>>` so overlapping callers share the entire scan/apply-update/balance-read operation. The entry is removed on success or rejection. We also changed the manual refresh to propagate errors so transaction construction stops on a failed prerequisite refresh.

Offline regression checks passed for concurrent same-wallet calls sharing one scan/update, failure followed by retry, and independent wallet operations. TypeScript and ESLint passed. These are application tests using deferred fake scans, not reproductions of the WASM failure.

**Browser retest:** after reloading with the guard, one attempt successfully completed construction, signing, and finalization. The user reported the expected saved-but-not-broadcast warning; we independently observed that warning and a new saved creation record. This supports the mitigation but does not prove the precise root cause or eliminate other concurrency hazards.

No seeds, descriptors, private keys, signed transaction hex, or wallet identifiers are included in this report.
