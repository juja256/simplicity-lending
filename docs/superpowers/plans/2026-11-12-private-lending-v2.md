# Private lending v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the app into a private-lending-only demo for institutional lenders (published lender
terms, a lender console and a borrower app) on upstream LWK, then add v2's contract and privacy
changes: fresh addresses, the hidden expiry, partial repayment and private messages.

**Architecture:** Six phases, run in order, each on its own branch and closed by one review
(phase 7, item 3(b), is postponed; see its section). Phase 1 is broken into tasks here. Phases 2
to 7 give their scope, files, done-when checks and
decision gates, and each is broken into tasks (with this skill) when the phase before it is
merged: phase 1 moves every private flow onto `psetBuilder.ts`, so file-level tasks written now
would describe code that is about to change.

**Tech Stack:** Rust 2024 workspace (Simplicity contracts, `private-lending-core`,
`private-lending-wasm` through wasm-pack 0.15, the indexer with SQL migrations); React,
TypeScript and Vite with pnpm 10.33; upstream LWK (`lwk_wasm`, the `lwk` submodule at
`7f8c8213`); Liquid testnet.

**Spec:** `docs/superpowers/specs/2026-11-06-private-lending-v2-design.md` (items 1 to 10 and
"Scope of v2").

## Global Constraints

- v2 covers items 1, 2, 3(a), 6, 7, 8, 9 and 10. Item 5 comes after v2, and item 3(b) waits
  until the user brings it back (2026-11-14). Item 4 needs no
  work beyond keeping acceptance hidden after expiry.
- No migration: the app knows only the v2 contract, and v1 testnet loans are dropped.
- One branch per phase, `v2/phase-<n>-<name>`, from the `v2` branch; one commit per task; pushes
  go to the `fork` remote only; the user decides when a phase merges into `v2`. Nothing merges
  into `main` during v2.
- The checks that need the user (the running app, a Jade, two wallets) are deferred to the end of
  v2 and run together; see "Final manual checks" at the end.
- Implementers run on Opus. One whole-phase review at the end of each phase; a task marked
  **Review now** also gets its own review, for the reason it gives.
- The `lwk` submodule stays at one pinned commit for the whole phase (its `PsetBuilder` is
  experimental). LWK builds with Rust 1.91.0 (`lwk/rust-toolchain.toml`), the workspace with 1.96.
- Every private flow keeps both `assertSpendLayout` checks (before and after blinding), and
  blinding stays in `wasm.blindPset`, which sets the pinned outputs' blinders.
- Only the lending key's x-only key leaves the browser; the key is never persisted, logged or sent.
- Code comments and docs keep the repo's style: plain sentences, lines wrapped at 100 columns.

## Review Focus

1. A Jade signing a PSET from `buildPset` in `'none'` mode: the e2e run uses seed wallets only,
   so a blinder index or missing key-origin data that Jade rejects would first show in the demo.
   Task 1.5 step 5 signs a creation and a cancellation with a Jade on testnet.
2. Switching wallets while a scan is in flight, now that upstream's shared in-flight scan (#190)
   meets the session-scoped lending key: the new session must get a new key and none of the old
   session's offers. Task 1.5 step 6 checks it by hand.
3. An old `web/.e2e-private/state.json`: the e2e run rebroadcasts the saved hex of a built stage
   and never rebuilds it, so a stale state would pass without running the ported builders. Task
   1.5 step 1 moves it aside.
4. No fee estimate from esplora: `PrivateFlowDeps.feeRate` was `null` for "LWK's default" and
   becomes a number; it must fall back to 100 sat/kvb (`FALLBACK_FEE_RATE_SAT_PER_KVB`), not to
   zero or `NaN`. Task 1.2 step 3 sets the fallback; task 1.3's check builds at that rate.
5. Wallet coins that cannot pay the fee: `buildPset` throws `Insufficient L-BTC: missing N sats`
   where `TxBuilder` threw its own error; the modals must still show a readable message. Task 1.5
   step 4 tries a creation from a wallet without spare L-BTC.

---

## Phase 1: Merge upstream `main` (spec item 7)

Branch `v2/phase-1-upstream-merge`. The merge takes upstream at `4ab8765` (the `origin/main` of
2026-11-12), the commit this phase's conflict table, LWK pin and API gaps were taken from; later
upstream commits are a separate decision. Upstream brings #190 (manual and background sync share one
in-flight scan) and #196 (the app builds on upstream LWK instead of the `@lilbonekit/lwk-web`
fork, and the public flows build PSETs with `web/src/lwk/psetBuilder.ts`). The private flows use
fork-only `TxBuilder` calls that upstream LWK lacks: `setInputOrder`, `addPostIssuanceRecipient`,
`addPostIssuanceScriptOutput`, `issueAssetToRecipients` with `IssuanceRecipient`,
`setInputSequence`, `skipBlinding`, and `SimplicityProgram.finalizeTransactionWithSpendInfo`.
The phase ports them; the merge commit itself does not type-check in `web/` until task 1.4.

### Task 1.1: Merge `origin/main` and resolve the conflicts

**Files:**
- Modify (conflicts): `.dockerignore`, `README.md`, `web/README.md`, `deployment/Dockerfile.web`,
  `web/package.json`, `web/src/lwk/index.ts`, `web/src/providers/wallet/WalletProvider.tsx`,
  `web/src/providers/wallet/types.ts`, `web/src/simplicity/asset-auth/program.ts`,
  `web/src/simplicity/script-auth/program.ts`
- Delete (modify/delete conflicts): `web/src/pages/Demo/CreateOfferDemo.tsx`,
  `web/src/pages/Demo/helpers.ts`
- Regenerate: `web/pnpm-lock.yaml`. From upstream: `.gitmodules`, `lwk`.

**Interfaces:**
- Produces: `lwk_wasm` as the only LWK package; `WalletContext.getChangeAddress(): Promise<Address>`
  (upstream) next to `privateCapable`, `getLendingKey()`, `getWalletTxOuts()` and `signerType`
  (ours); `createEsploraClient(network): Promise<EsploraClient>` stays async (ours).

- [ ] **Step 1: Branch and merge without committing**

```bash
git switch -c v2/phase-1-upstream-merge main
git fetch origin
git merge --no-ff --no-commit 4ab8765
```

Expected: content conflicts in the ten files above and modify/delete conflicts in the two Demo
files, nothing else.

- [ ] **Step 2: Resolve each conflict by this table**

| File | Resolution |
|---|---|
| `.dockerignore` | Both sides' lines. |
| `README.md` | Upstream's setup (`git submodule update --init lwk`, `git config submodule.recurse true`, `web/scripts/build-lwk.sh`, then `pnpm`) and every section of ours. |
| `web/README.md` | Upstream's LWK and "Update LWK" sections, and every section of ours; "Build the wasm module" says to build LWK first. |
| `deployment/Dockerfile.web` | Two Rust stages: upstream's `lwk` stage (`rust:1.91-bookworm`, `build-lwk.sh`) and our `wasm` stage (`rust:1.96-bookworm`, `private-lending-wasm`). The builder copies `/app/lwk/lwk_wasm/pkg` and `web/.pnpmfile.cjs` before `pnpm install --frozen-lockfile`, and our wasm output after `COPY web ./`. Keep our ARG/ENV changes (no default for `VITE_WATERFALLS_RECIPIENT`, no `VITE_DEBUG_MNEMONIC`) and `COPY deployment/configs/nginx`. |
| `web/package.json` | Upstream's `"lwk_wasm": "file:../lwk/lwk_wasm/pkg"` and `lwk:build` script, no `@lilbonekit/lwk-web`; our scripts (`build:demo`, `build:wasm`, `preview:demo`, `parity`, `e2e:private`). Keep our removal of `@tanstack/react-query-devtools` and `vite-plugin-checker` unless the merged `web/vite.config.ts` or `web/plugins/` import them (`grep -rn "vite-plugin-checker\|react-query-devtools" web/vite.config.ts web/plugins web/src`). |
| `web/src/lwk/index.ts` | Upstream's imports from `lwk_wasm`; our async `createEsploraClient` with `resolveWaterfallsRecipient`. |
| `web/src/providers/wallet/types.ts` | Upstream's `getChangeAddress` and the removal of `fundWithWalletCoins`; our private fields and `isPrivateCapable`; types from `lwk_wasm`. |
| `web/src/providers/wallet/WalletProvider.tsx` | Upstream's shared in-flight scan (#190) and `getChangeAddress`; our lending-key lifecycle, `getWalletTxOuts`, `privateCapable`, and the awaited `createEsploraClient`. |
| `web/src/simplicity/{asset-auth,script-auth}/program.ts` | Our split into `arguments.ts` and `witness.ts` with the re-exports; upstream's `SimplicityProgram.loadWithDebugSymbols(source, args, true)`; imports from `lwk_wasm`. |
| `web/src/pages/Demo/*` | Stay deleted: `git rm web/src/pages/Demo/CreateOfferDemo.tsx web/src/pages/Demo/helpers.ts`. |

- [ ] **Step 3: Build LWK**

```bash
git submodule update --init lwk && git config submodule.recurse true
web/scripts/build-lwk.sh
```

Expected: `lwk/lwk_wasm/pkg/package.json` exists.

- [ ] **Step 4: Install and build the private wasm**

```bash
cd web && pnpm install && pnpm build:wasm
grep -c "@lilbonekit/lwk-web" pnpm-lock.yaml
```

Expected: install succeeds; the count is `0`.

- [ ] **Step 5: Rust is untouched**

Run: `cargo test --workspace`
Expected: PASS.

- [ ] **Step 6: Type errors are confined to the code tasks 1.2 to 1.4 port**

Run: `cd web && pnpm exec tsc -b --pretty false 2>&1 | grep -oE "^(src|scripts)/[^(]+" | sort -u`
Expected: every file listed is in `git grep -l "@lilbonekit/lwk-web" -- web` or imports one of
them; none is under `web/src/hooks/`, `web/src/lib/` or `web/src/lwk/psetBuilder.ts`.

- [ ] **Step 7: Commit the merge**

Run `git status --short` first: nothing untracked or generated (the wasm output, `node_modules`)
may be staged. Stage the resolved files and the lockfile by name.

```bash
git add .dockerignore README.md web/README.md deployment/Dockerfile.web web/package.json \
  web/pnpm-lock.yaml web/src/lwk/index.ts web/src/providers/wallet/WalletProvider.tsx \
  web/src/providers/wallet/types.ts web/src/simplicity/asset-auth/program.ts \
  web/src/simplicity/script-auth/program.ts
git commit -m "Merge upstream 4ab8765: upstream LWK (#196) and the shared wallet scan (#190)

The private flows still import the LWK fork; the next commits port them, and web/ type-checks
again after them."
```

### Task 1.2: Port the shared private layer and the Node scripts to `lwk_wasm`

**Files:**
- Modify: `web/src/privateLending/deps.ts`, `web/src/privateLending/hooks/usePrivateFlowDeps.ts`,
  `web/src/privateLending/finalize.ts`, `web/src/privateLending/{secrets,verify,wallet}.ts`,
  `web/src/privateLending/hooks/usePrivateTransaction.ts`, `web/src/lwk/updatedPset.ts`,
  `web/src/simplicity/private-lending/{program,scripts,witness}.ts`,
  `web/src/simplicity/asset-auth/{arguments,witness}.ts`,
  `web/src/simplicity/script-auth/{arguments,witness}.ts`
- Modify: `web/scripts/check-private-lending-parity.ts`, `web/scripts/check-wallet-sync.ts`,
  `web/scripts/e2e-private-lending.ts`, `web/scripts/e2e/{wallet,chain}.ts`
- Test: `pnpm parity`

**Interfaces:**
- Produces: `PrivateFlowDeps.lwk: typeof import('lwk_wasm')` and `PrivateFlowDeps.feeRate: number`
  (sat/kvb, never `null`).

- [ ] **Step 1: Run the parity check to see it fail**

Run: `cd web && pnpm parity`
Expected: FAIL, cannot find module `@lilbonekit/lwk-web`.

- [ ] **Step 2: Switch the imports to `lwk_wasm`**

In the Node scripts, the LWK wasm binary is now `node_modules/lwk_wasm/lwk_wasm_bg.wasm`.
The private programs load with `SimplicityProgram.loadWithDebugSymbols(source, args, true)`,
through one `loadProgram` helper in `scripts.ts`, as upstream's public programs do. Upstream's
`SimplicityProgram.load` compiles without debug symbols, so its CMRs are not the Rust fixtures'
and the parity check fails.

- [ ] **Step 3: Make the fee rate a number**

In `usePrivateFlowDeps.ts`, a missing estimate becomes `FALLBACK_FEE_RATE_SAT_PER_KVB` from
`@/api/esplora/fee` (100, LWK's `DEFAULT_FEE_RATE`); `web/scripts/e2e/wallet.ts` passes `100`
instead of `null`.

- [ ] **Step 4: Replace `finalizeTransactionWithSpendInfo`**

Each of the three calls in `finalize.ts` becomes
`program.finalizeTransaction(tx, spendInfo.controlBlock(program.cmr), prevouts, inputIndex, witness, deps.network, logLevel)`,
as upstream's hooks do; `StateTaprootSpendInfo.controlBlock` exists upstream. Update the file's
header comment to name `finalizeTransaction`.

- [ ] **Step 5: Run the parity check**

Run: `cd web && pnpm parity`
Expected: PASS (the browser path derives the Rust fixtures' offer addresses with `lwk_wasm`).

- [ ] **Step 6: Only the flows still import the fork**

Run: `git grep -n "@lilbonekit/lwk-web\|finalizeTransactionWithSpendInfo" -- web`
Expected: matches only in `web/src/privateLending/flows/`.

- [ ] **Step 7: Commit**

```bash
git commit -am "web: private layer and scripts on upstream LWK"
```

### Task 1.3: A `'none'` blinding mode in `buildPset`

**Files:**
- Modify: `web/src/lwk/psetBuilder.ts`
- Test: `web/scripts/check-private-lending-parity.ts` (a new offline check)

**Interfaces:**
- Consumes: `PrivateFlowDeps` from task 1.2 (for `lwk`, `wasm`, `network`).
- Produces: `export type PsetBlinding = 'local' | 'wallet' | 'none'`, and exported
  `PsetInputSpec`, `PsetIssuanceSpec`, `PsetOutputSpec`, `BuildPsetParams`, `BuiltPset` (today
  module-private). `'none'` assembles the PSET without `blindLast`: outputs with a
  `blindingPubkey` keep it and get a blinder index, the first `walletCoin` input or else `0`, and
  the caller blinds. The fee trial still blinds a copy, as for the other modes.

- [ ] **Step 1: Write the failing check `checkPsetBuilderNoneBlinding`**

Build with `blinding: 'none'`, one explicit L-BTC input (`walletCoin: true`, 100 000 sats,
`maxWeightToSatisfy` 300), one output of 10 000 L-BTC sats to a confidential testnet address, the
same address as `changeAddress`, at 100 sat/kvb (a literal: the Node script does not import
`@/api/esplora/fee`, which pulls in the app's HTTP layer). The parity fixtures hold no address, so
the check derives one from them:

```ts
const lender = wasm.LendingKey.fromMasterBlindingKey(fixture.lender_master_blinding_key)
const address = lwk.Address.parse(
  wasm.confidentialAddress(
    fixture.lender_nft_script_pubkey,
    wasm.liftLendingKey(lender.xOnlyPublicKey()),
    'liquidtestnet',
  ),
  network,
)
```

Then, through `inspectPset(wasm, pset.toString())`, assert:

```ts
assert(outputs.length === 3)
for (const o of outputs.slice(0, 2)) {
  assert(o.blindingKey !== null && o.blinderIndex === 0)
  assert(o.assetCommitment === null && o.amountCommitment === null)
}
assert(outputs[2].script === '' && outputs[2].amount === fee && fee > 0n)
assert(outputs[1].amount === 100_000n - 10_000n - fee)
```

and that `wasm.blindPset(pset.toString(), [wasm.InputSecret.explicit(0, policyAsset, 100_000n)], [])`
returns a PSET whose outputs 0 and 1 have both commitments.

That single input is both input 0 and the first `walletCoin`, so it cannot tell the two blinder
rules apart. Two more builds, with the same output, do:
- inputs `[plain, walletCoin, walletCoin]` (a plain input has `walletCoin: false`): outputs 0 and
  1 have blinder index 1;
- one plain input, no `walletCoin`: outputs 0 and 1 have blinder index 0, and the build does not
  throw.

Call the check from the script's main.

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && pnpm parity`
Expected: FAIL at `pset builder 'none': the first walletCoin input blinds`, with blinder indices
`0,0`. tsx does not type-check, and before the change `'none'` already gets blinder index 0 and
no `blindLast`, so the single-input assertions pass; only `tsc` rejects `'none'`.

- [ ] **Step 3: Implement `'none'` in `assemble` and export the types**

- [ ] **Step 4: Run it to see it pass**

Run: `cd web && pnpm parity`
Expected: PASS, the new check included.

- [ ] **Step 5: Commit**

```bash
git commit -am "web: psetBuilder leaves blinding to the caller in 'none' mode"
```

### Task 1.4: Port the seven private flows to `buildPset` (**Review now**: covenant spends; a wrong input order, sequence or issuance makes the spend invalid or misroutes funds)

**Files:**
- Modify: `web/src/privateLending/flows/shared.ts` and the seven flows in
  `web/src/privateLending/flows/`: `creation.ts`, `acceptance.ts`, `cancellation.ts`,
  `claimPrincipal.ts`, `claimRepayment.ts`, `repayment.ts`, `liquidation.ts`
- Test: `pnpm build`, `pnpm lint`, then task 1.5's e2e run

**Interfaces:**
- Consumes: `buildPset`, `PsetInputSpec`, `PsetOutputSpec` and `'none'` (task 1.3);
  `PrivateFlowDeps.feeRate: number` (task 1.2).
- Produces, in `flows/shared.ts`:
  - `walletCoinInput(deps: PrivateFlowDeps, coin: WalletTxOut, prevout: TxOut): PsetInputSpec`,
    a wallet coin with `coin.unblinded()` as `secrets`, `deps.wollet.maxWeightToSatisfy()` and
    `walletCoin: true`;
  - `buildUnblindedPset(deps: PrivateFlowDeps, spec: { inputs: PsetInputSpec[]; outputs: PsetOutputSpec[]; changeAddress: Address; lockTime?: number }): Pset`,
    which calls `buildPset` with `network: deps.network`, `feeRateSatPerKvb: deps.feeRate`,
    `blinding: 'none'` and `fallbackLocktime: lockTime`, then `pset.addDetails(deps.wollet)`.

Each flow's step "4. The unblinded PSET" becomes one `buildUnblindedPset` call, by this mapping.
The `SpendLayout` of each flow does not change: its `inputs` give the input order and its
`outputs` the leading outputs, asset change included; `buildPset` appends the L-BTC change and
the fee after them, where `assertSpendLayout` expects them.

| Fork `TxBuilder` | `buildPset` |
|---|---|
| `setWalletUtxos(o)` and `setInputOrder(o)` | `inputs` in `layout.inputs` order; wallet coins through `walletCoinInput` |
| `addExternalUtxos([new ExternalUtxo(vout, tx, secrets, weight, _)])` | an input `{ outpoint, prevout: <tx's output vout>, asset, amount, secrets, maxWeightToSatisfy: weight }` |
| `addPostIssuanceRecipient(address, amount, asset)` | an output `{ script: address.scriptPubkey(), amount, asset, blindingPubkey: address.blindingPubkey() }` |
| `addPostIssuanceScriptOutput(script, amount, asset)` | an explicit output `{ script, amount, asset }` |
| `issueAssetToRecipients([IssuanceRecipient.fromAddress(NFT_AMOUNT, to)], NO_REISSUANCE_TOKEN, null, contract, input)` (creation) | `issuance: { assetAmount: NFT_AMOUNT, tokenAmount: 0n, contractHash: <contract's hash> }` on that input, and the NFT's output to `to` at its layout position |
| `setFallbackLocktimeHeight(h)` and `setInputSequence(offer, LOCK_TIME_ENABLING_SEQUENCE)` (liquidation) | `lockTime: h`, and `sequence: LOCK_TIME_ENABLING_SEQUENCE` on the offer input |
| `feeRate(r)`, `skipBlinding()`, `finish(wollet)` | `buildUnblindedPset` |

- [ ] **Step 1: Add `walletCoinInput` and `buildUnblindedPset` to `flows/shared.ts`**

The comment in `assertSpendLayout` that names `skipBlinding` now names `'none'`.

- [ ] **Step 2: Port `creation.ts`, the only flow with issuances**

Run: `cd web && pnpm exec tsc -b --pretty false 2>&1 | grep creation.ts`
Expected: no output.

- [ ] **Step 3: Port the other six flows**

- [ ] **Step 4: Build and lint**

Run: `cd web && pnpm build && pnpm lint`
Expected: both PASS.

- [ ] **Step 5: Nothing uses the fork any more**

Run: `git grep -nE "@lilbonekit/lwk-web|TxBuilder\(|skipBlinding|IssuanceRecipient" -- web/src web/scripts`
Expected: one line, `let builder = new lwk.TxBuilder(wallet.network)` in
`web/scripts/e2e-private-lending.ts`. It is the e2e `wallets` stage's L-BTC split, on upstream
`lwk_wasm`'s `TxBuilder`, and it stays.

- [ ] **Step 6: Commit**

```bash
git commit -am "web: private flows build with psetBuilder on upstream LWK"
```

### Task 1.5: Verify end to end and record the results

**Files:**
- Modify: `docs/superpowers/specs/2026-11-06-private-lending-v2-design.md` (item 2's line
  reference), `web/README.md` (setup order) if task 1.1 left it stale

- [ ] **Step 1: Start the e2e run from an empty state**

Run: `mv web/.e2e-private/state.json web/.e2e-private/state.v1.json 2>/dev/null; cd web && pnpm e2e:private wallets`
Expected: both wallets' addresses and balances; fund any shortfall it names.

- [ ] **Step 2: Run every e2e stage**

Run: `cd web && pnpm e2e:private` (with the local testnet indexer up, for `scan`; see
`web/README.md`)
Expected: every stage `confirmed`, `scan` passes.

- [ ] **Step 3: Build the images**

Run: `docker compose build`, with the environment `deployment/README.md` describes
Expected: the web and backend images build.

Steps 4 to 6 are the user's: they need the running app, a Jade and two wallets. The user deferred
them to the end of v2 (2026-11-13); they are listed again under "Final manual checks", adapted to
the app as it will be then. The controller does not mark them done itself.

- [ ] **Step 4 (user): Fee errors stay readable**

In `pnpm dev`, create an offer from a seed wallet holding collateral but too little L-BTC for
the fee. Expected: the modal shows a message naming the missing L-BTC, not a stack trace.

- [ ] **Step 5 (user): A Jade signs the `'none'` PSETs**

With a Jade on testnet in `pnpm dev`, create an offer and cancel it. Expected: the Jade shows
the outputs and signs both; both transactions confirm. Record the result in the commit message.

- [ ] **Step 6 (user): A wallet switch during a scan**

The first scan runs inside the connect, before the wallet is ready, and Disconnect is only in the
ready wallet's menu, so the scan to interrupt is a later one:
1. Connect seed wallet A and wait until it is ready.
2. Throttle the network in devtools, then start a scan: leave the tab and come back to it after
   15 s (the minimum gap between two scans).
3. While that scan runs, disconnect A and connect seed wallet B.

Expected: B's lending-key fingerprint, B's offers only, no error toast from A's scan.

Optionally, with a Jade, check a connect that ends while it opens the wallet. From a fresh page
load (the waterfalls recipient is fetched once per page), throttle the network so that
`/v1/server_recipient` is slow, unplug the Jade during "Connecting…" after the PIN, replug it, and
connect again. Expected: the connect works, and a reload does not resume the unplugged session.

- [ ] **Step 7: Update item 2's reference and commit**

Item 2 of the spec cites `WalletProvider.tsx:381`; point it at the merged line of
`wollet.address(0)`.

```bash
git commit -am "docs: v2 phase 1 verified on testnet"
```

The phase review follows (whole branch, Opus).

---

## Phase 2: Private lending only (spec items 8 and 2)

Branch `v2/phase-2-private-only`, from `v2/main` after phase 1 is merged into it. The tag
`public-lending-last` is on that merge commit (`a55aa8e`, made 2026-11-13; push it to `fork` once
the user confirms); `git checkout public-lending-last` brings back the public demo. From here on,
upstream changes are ported by hand.

Tasks 1 to 5 delete one layer each, in an order where nothing deleted is still imported: the web
first, then the CLI and `crates/session` (they use the indexer and the public contracts), the
indexer (it uses the public contracts), the contracts, the docs. Task 6 is item 2, task 7 the
phase's checks. Every task leaves `cargo build --workspace --all-targets` (with
`SQLX_OFFLINE=true`), `pnpm build` and `pnpm parity` passing.

Decided while breaking the phase down (2026-11-13):
- The `/app` index redirects to `/app/private`, and `PrivateLoansCard` moves onto that page;
  phase 4 replaces both. The nav keeps "Private loans" only.
- The landing page loses its public-market sections (`ForBorrowers`, `ForLenders`, `RateIndex`
  and the live previews they embed); its other links point at `/app/private`. Phase 4 rewrites it.
- The indexer's assets API (`/.well-known/{proof_file}`) and asset registration go: they serve
  ELIP-0100 proofs for factory assets and public offer NFTs only. Its event stream keeps
  `block_indexed`, which the private views refetch on.
- `crates/session` goes with `crates/cli`: its tests drive the public flows only. Neither crate is
  referenced by `deployment/`, `docker-compose.yml` or `gitlab/`.
- Item 2 changes where funds are received, not who the wallet is: the session's `scriptPubkey`
  (address 0's script) keys the saved private transactions (`PrivateTxRecord.walletScriptPubkey`),
  so it stays, computed by one helper, and nothing pays to it.

### Phase 2 review focus

1. Saved private transactions after item 2: a wallet's unsent or processing private transactions
   must still show for it, so its identity script must not change. Task 6 asserts it in the e2e.
2. An existing indexer database: the migration must keep every private row and the sync height.
   Task 7 step 3 runs it on a copy of the testnet database.
3. An existing indexer config that still has `asset_registry` (the deployed one) must load. Task 3
   step 1 tests it.
4. Old links to `/app/borrow`, `/app/supply` or `/app`: they land on the private page, not the
   error screen. Task 1 adds the redirects; the phase review reads the router.
5. A fresh address taken before the wallet applied the previous broadcast repeats that address.
   Task 6's e2e check builds three creations from one wallet and requires three receivers.

### Task 1: The web app keeps the private pages only

**Files:**
- Delete: `web/src/pages/{Borrow,Supply,Dashboard}`,
  `web/src/simplicity/{lending,asset-auth-vault,issuance-factory}`, the landing's `ForBorrowers`, `ForLenders`, `RateIndex`, `LiveCreateOfferPreview`,
  `LiveOffersPreview` and `mock/`
- Move: `web/src/pages/Dashboard/components/PrivateLoansCard.tsx` to
  `web/src/pages/Private/components/PrivateLoansCard.tsx`
- Modify: `web/src/App.tsx`, `web/src/constants/routes.ts`, `web/src/components/AppLayout.tsx`,
  `web/src/pages/Private/index.tsx`, `web/src/pages/Landing/index.tsx` and the landing components
  that link to `RoutePath.Borrow`, the public parts of `web/src/api/indexer/` (`events`,
  `invalidateEventQueries`, `methods`, `schemas`, `queryKeys`, `hooks`), `web/src/providers/pendingTransactions/*`

- [ ] **Step 1: Routes.** `RoutePath` keeps `Landing`, `Dashboard` (`/app`) and `Private`. Under
  `/app`, the index route and a `*` route render `<Navigate to={RoutePath.Private} replace />`.
  The nav lists "Private loans" only; `AppLayout` drops `useOfferModal` and the public offer modal.
- [ ] **Step 2: Pages.** Delete the three public pages and the three public Simplicity modules.
  Render `PrivateLoansCard` at the top of the Private page, without its link to that same page.
  Remove the landing's public-market sections; every remaining landing link to the app points at
  `RoutePath.Private`.
- [ ] **Step 3: Indexer client.** Remove the public endpoints (`/offers`, `/borrowers/*`,
  `/lenders/*`, factories), their schemas and query keys. `IndexerEvent` keeps `block_indexed`
  only, and `invalidateEventQueries` keeps that case. The pending-transactions provider drops
  the public `PendingTxRecord` side (its kinds, records, store and reconciliation queries) and
  keeps the private side unchanged.
- [ ] **Step 4: Delete what is no longer imported.** Repeat
  `cd web && npx -y knip --include files` and delete the files it lists until it lists none (the
  public hooks in `web/src/hooks/`, their components and modals, `lwk/assetContract.ts`). Do not
  delete files under `src/wasm/` or `scripts/`.
- [ ] **Step 5: Check.**
  Run: `cd web && pnpm build && pnpm lint && pnpm parity && pnpm e2e:private wallets`,
  `TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx scripts/check-wallet-sync.ts` and `git grep -nE "simplicity/(lending|asset-auth-vault|issuance-factory)|pages/(Borrow|Supply|Dashboard)|RoutePath\.(Borrow|Supply)" web/src`
  Expected: all pass (`wallets` only reads balances, and loads every module the e2e imports);
  the grep finds nothing.
- [ ] **Step 6: Commit** `web: keep the private lending pages only`

### Task 2: Remove the CLI and the session crate

**Files:** Delete `crates/cli`, `crates/session`; `Cargo.lock` follows.

- [ ] **Step 1:** `git rm -r crates/cli crates/session`. The workspace's `members = ["crates/*"]`
  needs no edit; workspace dependencies only they used may stay.
- [ ] **Step 2: Check.** Run: `SQLX_OFFLINE=true cargo build --workspace --all-targets`
  Expected: builds; `Cargo.lock` no longer lists `lending-cli` or `lending-session`.
- [ ] **Step 3: Commit** `cli: remove the CLI and the session crate with the public flows`

### Task 3: The indexer tracks private offers only

**Files:**
- Create: `crates/indexer/migrations/20261113120000_drop_public_lending.sql`
- Delete: the trackers `factories`, `factory_auths`, `factory_creation`, `offer_participants`,
  `offers` and `offers_creation` in `src/indexer/trackers/`; `src/indexer/asset_registration.rs`;
  the models `factories`, `factory_auths`, `factory_utxo`, `offer_participants`, `offer_utxo`
  and `offer` in `src/models/`; `src/api/{borrowers,lenders,factories,offers,assets}`, the public queries in `src/api/query/`
  and `src/api/db/`, `tests/api_integration.rs`, `tests/asset_metadata_api.rs`
- Modify: `src/indexer/trackers/{mod,registry}.rs`, `src/indexer/{mod,worker}.rs`,
  `src/api/{mod,server}.rs`, `src/api/openapi/*`, `src/events/types.rs`, `src/configuration.rs`,
  `configuration/base.yaml`, `deployment/configs/backend/base.yaml.template`, `tests/common/mod.rs`,
  the repo's `.sqlx/`
- Test: `tests/private_offers_indexing.rs`, `src/configuration.rs`

All paths are under `crates/indexer/` unless they start with `deployment/` or `.sqlx`.

- [ ] **Step 1: Write the failing tests.**
  - `public_lending_tables_are_dropped` (`#[sqlx::test]` in `tests/private_offers_indexing.rs`):
    `information_schema.tables` has none of `factories`, `factory_utxos`, `factory_auths`,
    `offers`, `offer_utxos`, `offer_participants`, and has `sync_state`, `private_offers`,
    `private_offer_utxos`, `directory_entries` and `directory_challenges`.
  - `settings_load_with_a_stale_asset_registry_section` (unit test in `configuration.rs`): the
    settings deserialize from `configuration/base.yaml` plus an `asset_registry:` block as the
    deployed template had it.
- [ ] **Step 2: Run them to see the table test fail.** Run: `cargo test -p lending-indexer public_lending_tables_are_dropped`
  Expected: FAIL, the public tables exist. (The config test passes before and after: it guards
  the removal of `AssetRegistrySettings`.)
- [ ] **Step 3: The migration.** One `DROP TABLE` of the six public tables, then
  `DROP TYPE participant_type, utxo_type, offer_status, factory_status`.
- [ ] **Step 4: Delete the public code.** `TrackerRegistry` keeps `PrivateOffersTracker` only;
  `IndexerEvent` keeps `BlockIndexed`; the router keeps health, events, private offers and the
  directory; the OpenAPI doc lists only those; `Settings` loses `asset_registry`, and both config
  files lose the section. The API modules `borrowers` and `lenders` read only the `offers` table
  (checked 2026-11-13), so they go whole.
- [ ] **Step 5: Regenerate the offline query data.** With `DATABASE_URL` set as in
  `crates/indexer/README.md`: `cargo sqlx migrate run --source crates/indexer/migrations` then
  `cargo sqlx prepare --workspace -- --all-targets`.
- [ ] **Step 6: Check.** Run: `cargo test -p lending-indexer && cargo sqlx prepare --workspace --check -- --all-targets && cargo clippy --workspace --all-targets --all-features -- -D warnings`
  Expected: all pass, the two new tests included.
- [ ] **Step 7: Commit** `indexer: track private offers only, and drop the public tables`

### Task 4: Remove the public contracts

**Files:**
- Delete: `crates/contracts/simf/{lending,asset_auth_vault,issuance_factory}.simf`,
  `crates/contracts/src/programs/{lending,asset_auth_vault,issuance_factory}`,
  `crates/contracts/tests/{lending,asset_auth_vault,issuance_factory}` and their `.rs` entries
- Modify: `crates/contracts/src/programs/mod.rs`, `crates/contracts/tests/private_lending/setup.rs`

- [ ] **Step 1:** If an untracked `crates/contracts/tests/lending_security_audit.rs` exists, stop
  and ask the user before deleting it (absent from the main checkout on 2026-11-13).
- [ ] **Step 2:** Delete the files above. `private_lending/setup.rs` imports
  `lending::OfferParameters`: define a struct with the same four fields (`collateral_amount`,
  `principal_amount`, `loan_expiration_time`, `principal_interest_rate`) in `setup.rs` instead.
- [ ] **Step 3:** Regenerate `src/artifacts` (gitignored) with `simplex build` as
  `crates/contracts/README.md` describes, so no stale public artifact remains, and rebuild the
  wasm (`cd web && pnpm build:wasm`).
- [ ] **Step 4: Check.** Run: `cargo test -p lending-contracts && SQLX_OFFLINE=true cargo build --workspace --all-targets && cd web && pnpm parity`
  Expected: all pass; the private lending tests and `private_lending_security_audit.rs` run.
- [ ] **Step 5: Commit** `contracts: remove the public lending, vault and factory contracts`

### Task 5: The docs describe private lending only

**Files:**
- Delete: `docs/docs/{borrower,lender,protocol,schemas}`,
  `docs/docs/contracts/{lending,asset-auth-vault,issuance-factory}.md`
- Modify: `docs/sidebars.ts`, `docs/docs/intro.md`, `docs/docs/developers/*`, `README.md`,
  `crates/indexer/README.md`, `deployment/README.md`, `web/README.md` where they describe the
  public flows, the CLI or the removed endpoints

- [ ] **Step 1:** Delete the pages; the sidebar lists intro, Simplicity, Private loans, the
  remaining contracts (`asset-auth`, `script-auth`) and Developers. `intro.md` presents the
  private lending demo and says the public demo is at the tag `public-lending-last`.
- [ ] **Step 2:** Update the READMEs and developer pages: no CLI, no public flows or endpoints.
  Leave `docs/security/`, `docs/superpowers/` and `deployment/demo-release.md` (history) as they are.
- [ ] **Step 3: Check.** Run: `cd docs && pnpm build`, then
  `git grep -nE "lending\.simf|issuance_factory|asset_auth_vault|crates/cli|lending-cli" -- . ':!docs/security' ':!docs/superpowers' ':!deployment/demo-release.md'`
  Expected: the build passes with no broken links; the grep finds nothing.
- [ ] **Step 4: Commit** `docs: describe private lending only`

### Task 6: Fresh receive addresses (spec item 2) (**Review now**: a receiver outside the wallet loses the NFT or the funds sent to it)

**Files:**
- Modify: `web/src/privateLending/wallet.ts`, `web/src/components/modals/private/*.tsx`,
  `web/src/providers/wallet/WalletProvider.tsx`, `web/scripts/e2e-private-lending.ts`,
  `web/scripts/e2e/state.ts`
- Create: `web/src/providers/wallet/identity.ts`

**Interfaces:**
- Produces: `walletReceiver(deps: Pick<PrivateFlowDeps, 'wollet'>): Address` (was async, with a
  `getReceiveAddress` argument), returning `deps.wollet.address(null).address()`, the last unused
  external address; `walletIdentityScript(wollet: Wollet): string`, the hex script of address 0,
  the wallet's identity and never a receiver.

- [ ] **Step 1: Write the failing e2e checks.** In `e2e-private-lending.ts`, the three creation
  stages (`create`, `cancel-create`, `liquidate-create`) take `borrowerNftReceiver` from
  `walletReceiver({ wollet: borrower.wollet })`, save it in the state (`nftReceivers`), and throw
  `NFT receiver reused: <address>` if an earlier stage saved the same one; the acceptance, claim,
  repayment and liquidation stages take their receivers from `walletReceiver` too. The `wallets`
  stage saves each wallet's `walletIdentityScript`, and every later stage throws
  `wallet identity changed` if it differs.
- [ ] **Step 2: Run to see it fail.** Run: `mv web/.e2e-private/state.json web/.e2e-private/state.p2.json 2>/dev/null; cd web && pnpm e2e:private wallets create cancel-create`
  Expected: `create` fails with `getReceiveAddress is not a function` (`tsx` runs without a type
  check, and the helper still takes it).
- [ ] **Step 3: Implement.** `walletReceiver` as in Interfaces; the seven private modals call it
  with the flow's deps. In `WalletProvider`, the session's `scriptPubkey` comes from
  `walletIdentityScript`; `receiveAddress`, `getReceiveAddress` and `verifyReceiveAddress`'s
  fallback use `wollet.address(null)`.
- [ ] **Step 4: Check.** Run: `cd web && pnpm build && pnpm lint && pnpm parity && pnpm e2e:private wallets create cancel-create liquidate-create`
  and `git grep -n "address(0)" web/src`
  Expected: all pass; the grep finds only `identity.ts`.
- [ ] **Step 5: Commit** `web: private flows receive at fresh addresses`

### Task 7: Verify the phase

- [ ] **Step 1: Rust.** Run: `cargo test --workspace` (with the database `crates/indexer/README.md`
  describes) and `cargo clippy --workspace --all-targets --all-features -- -D warnings`.
  Expected: pass.
- [ ] **Step 2: Every e2e stage from an empty state.** Run:
  `mv web/.e2e-private/state.json web/.e2e-private/state.p2.json 2>/dev/null; cd web && pnpm e2e:private`
  with a local testnet indexer on a fresh database (task 3's migrations), as `web/README.md`
  describes. Expected: every stage `confirmed`, `scan` passes.
- [ ] **Step 3: The migration on the testnet database.** Copy it
  (`createdb -T lending-indexer-testnet-v2p1 lending-indexer-v2p2-check`), record
  `SELECT count(*)` of `private_offers`, `private_offer_utxos`, `directory_entries`,
  `directory_challenges` and the `sync_state` row, run
  `sqlx migrate run --source crates/indexer/migrations` against the copy, and record them again.
  Expected: identical; then drop the copy.
- [ ] **Step 4: Images and docs.** Run: `docker compose build` (environment per
  `deployment/README.md`) and `cd docs && pnpm build`. Expected: both build.
- [ ] **Step 5: Commit** the recorded counts in the commit message:
  `docs: v2 phase 2 verified` (with any doc fix the checks needed; skip the commit if there is
  none and put the counts in the phase review instead).

The phase review follows (whole branch, Opus).

## Phase 3: Lender terms in the directory (spec item 9)

Branch `v2/phase-3-lender-terms`, from `v2/main` after phase 2 is merged into it.

Decided at phase start (2026-11-14, with the user):
- No reference price and no collateral ratio: one term, the maximum principal per unit of
  collateral, stored as `max_principal_per_collateral`, principal base units per 10^8 collateral
  base units (`COLLATERAL_SCALE`). The lender sets it by hand; there is no oracle.
- One asset pair in the demo (tL-BTC collateral, TEST principal on testnet), read from the web
  app's build configuration instead of code. The encoding holds a list of 1 to 8 pairs, so more
  pairs need no new version; the indexer stores whatever pair a lender publishes.
- The APR check compares repayments, not rounded APRs: a proposal is below the minimum APR when
  its repayment is below `min_repayment`, rounded up. Terms are in blocks underneath: a day is
  1440 blocks, a year 525,600.

Tasks 1 to 3 are Rust and wasm, 4 the indexer, 5 and 6 the web, 7 the phase's checks. The
`private_lending` contract and the offer terms (`terms.rs`) do not change.

### Phase 3 review focus

1. A proposal exactly at a minimum (the least collateral, the least repayment, the shortest or
   longest term): it is within the terms, not flagged. Task 1's tests pin each boundary.
2. Amounts near `u64::MAX` in a proposal built outside the app: the arithmetic returns `None`
   or a breach, never wraps or panics. Task 1 tests it; task 3 checks the wasm returns an error.
3. A lender who registered before this phase (an entry without terms): hidden from the list,
   still readable by its key, and able to publish terms with a fresh put. Task 4 tests it.
4. A name or terms changed after signing (one byte of either): the put is refused. Task 2's
   known-answer test and task 4's tamper test pin it.
5. A build with the pair settings missing or malformed: the app falls back to the network's
   defaults, or fails at startup with a message naming the setting, never runs with `NaN`
   decimals. Task 5 checks it.

### Task 1: `lender_terms` in the core

**Files:**
- Create: `crates/private-lending-core/src/lender_terms.rs`
- Modify: `crates/private-lending-core/src/lib.rs` (module and re-exports)
- Create: `web/scripts/fixtures/lender-terms-parity.json` (written by the test below)

**Interfaces (produces):**
- Constants `LENDER_TERMS_VERSION: u8 = 1`, `MAX_PAIRS: usize = 8`, `BLOCKS_PER_DAY: u32 = 1440`,
  `BLOCKS_PER_YEAR: u64 = 525_600`, `COLLATERAL_SCALE: u64 = 100_000_000`.
- `struct PairTerms { principal_asset: AssetId, collateral_asset: AssetId, min_apr_bps: u32,
  max_principal_per_collateral: u64, min_term_days: u32, max_term_days: u32, min_principal: u64,
  max_principal: u64 }` and `struct LenderTerms { pairs: Vec<PairTerms> }`.
- `LenderTerms::encode(&self) -> Vec<u8>` and `LenderTerms::decode(&[u8]) -> Result<LenderTerms,
  LenderTermsError>`: big-endian, version (1) ‖ pair count (1) ‖ per pair, in the struct's field
  order, 32 + 32 + 4 + 8 + 4 + 4 + 8 + 8 = 100 bytes; asset ids in their internal byte order, as
  in `terms.rs`. `decode` rejects an unknown version, a wrong length, 0 or more than 8 pairs, two
  pairs with the same asset pair, and any pair `validate` rejects.
- `PairTerms::validate(&self) -> Result<(), LenderTermsError>`: the assets differ;
  `max_principal_per_collateral ≥ 1`; `1 ≤ min_principal ≤ max_principal`;
  `1 ≤ min_term_days ≤ max_term_days ≤ 3650`.
- `min_repayment(principal: u64, min_apr_bps: u32, term_blocks: u32) -> Option<u64>`:
  `principal + ceil(principal · min_apr_bps · term_blocks / (10_000 · BLOCKS_PER_YEAR))`, in
  `u128`, `None` above `u64::MAX`.
- `min_collateral(principal: u64, max_principal_per_collateral: u64) -> Option<u64>`:
  `ceil(principal · COLLATERAL_SCALE / max_principal_per_collateral)`, `None` for a zero divisor
  or above `u64::MAX`.
- `apr_bps(principal: u64, repayment: u64, term_blocks: u32) -> Option<u64>`:
  `floor((repayment − principal) · 10_000 · BLOCKS_PER_YEAR / (principal · term_blocks))`,
  `None` if principal or term is 0 or the repayment is below the principal. For display only.
- `principal_per_collateral(principal: u64, collateral: u64) -> Option<u64>`:
  `floor(principal · COLLATERAL_SCALE / collateral)`, `None` for zero collateral or overflow. For
  display only.
- `struct Proposal { principal_asset: AssetId, collateral_asset: AssetId, principal_amount: u64,
  collateral_amount: u64, repayment_amount: u64, term_blocks: u32 }`; `term_blocks` is the expiry
  height minus the creation height (the tip for an unconfirmed creation), computed by the caller.
- `enum TermBreach { UnsupportedPair, PrincipalBelowRange, PrincipalAboveRange, TermBelowRange,
  TermAboveRange, AprBelowMinimum, CollateralBelowMinimum }`.
- `LenderTerms::check_proposal(&self, proposal: &Proposal) -> Vec<TermBreach>`: `[UnsupportedPair]`
  when no pair matches the assets; otherwise every breach of the matching pair, in the enum's
  order. A term is in range when `min_term_days · 1440 ≤ term_blocks ≤ max_term_days · 1440`. If
  `min_repayment` or `min_collateral` is `None`, the proposal breaks that term.

- [ ] **Step 1: Write the failing tests** in `lender_terms.rs`:
  `encode_decode_round_trip` (one and eight pairs); `decode_rejects_bad_input` (version 2, a
  truncated pair, a trailing byte, 0 and 9 pairs, a duplicate pair, each `validate` failure);
  `encoding_known_answer` (the hex of one fixed pair, frozen); `min_repayment_rounds_up` (principal
  1, 1 bps, 1 block gives 2; an exact case gives no extra unit); `min_collateral_rounds_up`;
  `arithmetic_at_the_edges` (principal 0, term 0, repayment below principal, `u64::MAX` principal
  in each function gives `None`, no panic); `check_proposal_names_every_breach` (one proposal
  breaking all six pair terms returns all six in order; a different asset pair returns
  `[UnsupportedPair]`); `check_proposal_accepts_the_boundaries` (principal at min and max, term
  at exactly `min_term_days · 1440` and `max_term_days · 1440` blocks, repayment at exactly
  `min_repayment`, collateral at exactly `min_collateral`: no breach; one unit less of
  repayment or collateral: that breach only); `parity_vectors` (writes
  `web/scripts/fixtures/lender-terms-parity.json` when `WRITE_LENDER_TERMS_FIXTURE=1`, else
  compares with it): about ten vectors of inputs with the outputs of `min_repayment`,
  `min_collateral`, `apr_bps`, `principal_per_collateral` and `check_proposal`, amounts as
  decimal strings, breaches as their names.
- [ ] **Step 2: Run them to see them fail.** Run: `cargo test -p private-lending-core lender_terms`
  Expected: compile errors, the module does not exist.
- [ ] **Step 3: Implement** the interfaces above, then write the fixture with
  `WRITE_LENDER_TERMS_FIXTURE=1 cargo test -p private-lending-core parity_vectors`.
- [ ] **Step 4: Check.** Run: `cargo test -p private-lending-core && cargo clippy -p private-lending-core --all-targets -- -D warnings`
  Expected: pass.
- [ ] **Step 5: Commit** `core: lender terms, their encoding and the proposal check`

### Task 2: The directory signs the name and the terms (version 2)

**Files:** Modify `crates/private-lending-core/src/directory.rs`.

**Interfaces:**
- Consumes: `LenderTerms::encode` (task 1).
- Produces: `DIRECTORY_TAG = "simplicity-lending/directory/v2"`; `directory_message(action,
  pubkey, challenge, display_name: &str, terms: Option<&LenderTerms>) -> [u8; 32]` over `action ‖
  pubkey ‖ challenge ‖ name length (u16 BE) ‖ name (UTF-8) ‖ encoded terms (empty when None)`;
  `sign_directory_action` and `verify_directory_action` take the same extra `terms` argument. A
  put signs `Some(terms)`; a delete signs an empty name and `None`. Version 1 is no longer
  accepted.

- [ ] **Step 1: Write the failing tests:** the existing signature test with terms (a changed
  terms byte, a changed name, the v1 message for the same inputs: each fails to verify); a new
  frozen `directory_message_known_answer` for a put with one fixed pair and for a delete.
- [ ] **Step 2: Run to see them fail.** Run: `cargo test -p private-lending-core directory`
  Expected: compile errors on the new argument.
- [ ] **Step 3: Implement.** Update the callers in `crates/private-lending-wasm/src/directory.rs`
  and `crates/indexer/src/api/directory/handlers.rs` to pass `None` for now, so the workspace
  builds; tasks 3 and 4 wire the terms.
- [ ] **Step 4: Check.** Run: `cargo test -p private-lending-core && SQLX_OFFLINE=true cargo build --workspace --all-targets`
  Expected: pass.
- [ ] **Step 5: Commit** `core: the directory signs the name and the terms together (v2)`

### Task 3: Wasm bindings and the parity check

**Files:** Modify `crates/private-lending-wasm/src/directory.rs`, create
`crates/private-lending-wasm/src/lender_terms.rs`, modify `crates/private-lending-wasm/src/lib.rs`,
`web/scripts/check-private-lending-parity.ts`; rebuild `web/src/wasm/private-lending/`.

**Interfaces (produces, for tasks 6 and 7):** following the crate's JSON convention
(`serde_json`, amounts as decimal strings, asset ids as display hex):
- `encodeLenderTerms(termsJson: string): string` (hex) and `decodeLenderTerms(hex: string):
  string` (JSON); a bad input is a `bad-input:` error naming the field.
- `checkProposal(termsJson: string, proposalJson: string): string[]`, the breach names.
- `minRepayment(principal: bigint, minAprBps: number, termBlocks: number): bigint`,
  `minCollateral(principal: bigint, maxPrincipalPerCollateral: bigint): bigint`, `aprBps(principal:
  bigint, repayment: bigint, termBlocks: number): bigint`,
  `principalPerCollateral(principal: bigint, collateral: bigint): bigint`; a `None` from the core
  is a `bad-input:` error.
- `signDirectoryAction(key, action, challengeHex, displayName, termsJson: string | undefined)`:
  terms required for put, refused for delete.

- [ ] **Step 1: Write the failing tests:** wasm unit tests for the round trip, a `u64::MAX`
  principal giving `bad-input:`, and a put signature verifying against the core with the same
  terms; in the parity script, a section that runs every vector of
  `web/scripts/fixtures/lender-terms-parity.json` through the wasm and compares.
- [ ] **Step 2: Run to see them fail.** Run: `cargo test -p private-lending-wasm` and
  `cd web && pnpm parity` Expected: the new tests and the parity section fail.
- [ ] **Step 3: Implement**, then `cd web && pnpm build:wasm`.
- [ ] **Step 4: Check.** Run: `cargo test -p private-lending-wasm && cd web && pnpm parity && pnpm build`
  Expected: pass, the parity output names the lender-terms vectors.
- [ ] **Step 5: Commit** `wasm: lender terms, the proposal check and the v2 directory signature`

### Task 4: The indexer stores and serves the terms

**Files:**
- Create: `crates/indexer/migrations/20261114120000_directory_terms.sql`
- Modify: `crates/indexer/src/api/directory/{db,dto,handlers}.rs`,
  `crates/indexer/src/api/openapi/*`, `crates/indexer/tests/directory_api.rs`, the root `.sqlx/`
- Modify (carried from phase 2): `crates/indexer/src/configuration.rs`,
  `crates/indexer/configuration/base.yaml`, `deployment/configs/backend/base.yaml.template` (drop
  `protocol_fee_keeper_asset_id`), `crates/indexer/src/esplora_client.rs` (drop `network()`),
  `crates/indexer/src/indexer/cache.rs` (drop the `active_utxo` helper in its tests)

**Interfaces:**
- Migration: `ALTER TABLE directory_entries ADD COLUMN terms BYTEA, ADD COLUMN
  terms_published_at timestamptz;` (null for entries from before this phase).
- `PutDirectoryEntry` gains `terms: LenderTermsDto` (required); `DirectoryEntry` gains `terms:
  Option<LenderTermsDto>` and `terms_published_at: Option<i64>`. `LenderTermsDto { pairs:
  Vec<PairTermsDto> }`, with the fields of `PairTerms`, amounts as decimal strings, asset ids as
  display hex. The server converts the DTO to `LenderTerms`, validates it (`validate` and the
  `decode` rules), verifies the v2 signature over the name and the terms, and stores the encoded
  bytes with `terms_published_at = now()`.
- The list returns only entries with terms; `GET /private/directory/{pubkey}` returns an entry
  with or without terms.

- [ ] **Step 1: Write the failing tests** in `tests/directory_api.rs`: a put with terms then a
  list returns them and the publication time; a put without terms is `422`; invalid terms (min
  above max) are `422`; a signature over different terms is `401`; a replayed challenge and an
  expired one are refused; an entry inserted without terms (as from before this phase) is
  missing from the list, present by key, and a new put with terms lists it.
- [ ] **Step 2: Run to see them fail.** Run: `cargo test -p lending-indexer --test directory_api`
  Expected: FAIL.
- [ ] **Step 3: Implement**, migrate the dev database, and regenerate `.sqlx` with
  `cargo sqlx prepare --workspace -- --all-targets`. Do the three carried removals.
- [ ] **Step 4: Check.** Run: `cargo test -p lending-indexer && cargo sqlx prepare --workspace --check -- --all-targets && cargo clippy --workspace --all-targets --all-features -- -D warnings`
  Expected: pass.
- [ ] **Step 5: Commit** `indexer: the directory stores and serves lender terms`

### Task 5: The asset pair from the build configuration

**Files:** Modify `web/src/constants/network-config.ts`, `web/src/vite-env.d.ts`,
`web/.env.example`, `web/.env.liquidtestnet`, `web/README.md`; create a check in
`web/scripts/check-network-config.ts`.

**Interfaces:**
- Settings `VITE_COLLATERAL_ASSET_ID`, `VITE_COLLATERAL_ASSET_DECIMALS`,
  `VITE_COLLATERAL_ASSET_SYMBOL`, and the same three for `PRINCIPAL`. Each unset setting takes
  the network's current default, so today's builds do not change. A malformed one (an id not 64
  hex characters, decimals not an integer from 0 to 18, an empty symbol) throws at startup with
  the setting's name. The icon follows the symbol when one is known, else a generic asset icon.
- `resolveNetworkConfig(network, env): NetworkConfig`, a pure function the module calls with
  `import.meta.env`, so the check script can call it with plain objects. `protocolFeeAsset` goes
  if nothing uses it after phase 2; otherwise it keeps following the principal asset.

- [ ] **Step 1: Write the failing check** `check-network-config.ts`: defaults with an empty env
  equal today's testnet values; each override applies; each malformed setting throws naming it.
- [ ] **Step 2: Run to see it fail.** Run: `cd web && pnpm tsx --tsconfig tsconfig.app.json scripts/check-network-config.ts`
  Expected: FAIL, `resolveNetworkConfig` does not exist.
- [ ] **Step 3: Implement**; add a `check:config` script to `web/package.json`; document the
  settings in `web/README.md` and `web/.env.example`.
- [ ] **Step 4: Check.** Run: `cd web && pnpm check:config && pnpm build && pnpm lint && pnpm parity`
  Expected: pass.
- [ ] **Step 5: Commit** `web: the asset pair comes from the build configuration`

### Task 6: Publishing and reading terms in the web app, and the e2e `directory` stage

**Files:** Modify `web/src/privateLending/directory.ts`,
`web/src/privateLending/hooks/useDirectory.ts`, `web/src/api/indexer/private.ts`,
`web/src/pages/Private/components/{DirectorySection,BorrowSection}.tsx`,
`web/scripts/e2e-private-lending.ts`, `web/scripts/e2e/env.ts`, `web/README.md`; create
`web/src/privateLending/lenderTerms.ts`.

**Interfaces:**
- `registerInDirectory(deps, key, displayName, terms: LenderTermsInput, apiBaseUrl)`;
  `LenderTermsInput` is the JSON shape of task 3.
- `lenderTerms.ts`: `maxPrincipalPerCollateralFromDisplay(display: string, principalDecimals,
  collateralDecimals): bigint` and its inverse for display, converting "principal per 1 whole
  collateral coin" to base units per 10^8 collateral base units (exact, `bigint`, rejecting more
  decimals than the asset has); checked in the parity script.
- `useDirectory` returns each entry's terms and `terms_published_at`.

- [ ] **Step 1: Write the failing e2e stage** `directory` (no chain spend, `STAGE_NEEDS` empty):
  the lender publishes terms for the configured pair (minimum APR, maximum principal per
  collateral, term range and principal range that the e2e's own `create` proposal satisfies);
  the borrower lists the directory, finds the lender's entry and terms, and `checkProposal` on
  the e2e's proposal returns no breach; the same proposal with collateral one unit below
  `minCollateral` returns `["CollateralBelowMinimum"]`. Add the conversion checks to the parity
  script.
- [ ] **Step 2: Run to see it fail.** Run: `cd web && pnpm e2e:private directory` (a local
  indexer on the task 4 schema, as `web/README.md` describes) Expected: FAIL.
- [ ] **Step 3: Implement.** The Private page's directory section gets a minimal terms form for
  the configured pair (phase 4 replaces it), and the borrower's lender list shows each lender's
  terms and when they were published.
- [ ] **Step 4: Check.** Run: `cd web && pnpm build && pnpm lint && pnpm parity && pnpm e2e:private directory`
  Expected: pass.
- [ ] **Step 5: Commit** `web: lenders publish terms, borrowers read them`

### Task 7: Verify the phase

- [ ] **Step 1:** `cargo test --workspace` without the contracts' regtest tests, then
  `cd crates/contracts && simplex test`, and `cargo clippy --workspace --all-targets --all-features -- -D warnings`.
- [ ] **Step 2:** Every e2e stage from an empty state with a local indexer on a fresh database,
  `directory` included (fund the wallets from the testnet faucet if `wallets` reports a
  shortfall).
- [ ] **Step 3:** The migration on a copy of the dev database with a pre-phase-3 entry: the
  entry survives with null terms.
- [ ] **Step 4:** `docker compose build` and the docs build. Commit `docs: v2 phase 3 verified`
  with the results.

The phase review follows (whole branch, Opus).

---

## Phase 4: The lender console and the borrower app (spec item 10; the demo)

Branch `v2/phase-4-two-areas`, from `v2/main` after phase 3 is merged into it.

The wireframes from the discussion are in `docs/superpowers/specs/2026-11-12-v2-wireframes/`
(`site-structure.html`, option A; `lender-console.html`; `borrower-app.html`). They show layout
only: their numbers are made up, and their reference price and collateral ratio were replaced in
phase 3 by one term, the maximum principal per unit of collateral.

Decided at phase start (2026-11-14):
- **Routes.** `/` the landing page with its two entrances; `/lend` redirects to
  `/lend/proposals`, then `/lend/loans`, `/lend/terms`, `/lend/profile`; `/borrow` (choose a
  lender), `/borrow/:lenderKey` (the proposal), `/borrow/loans`. `/app` and `/app/*` redirect to
  `/`. Nothing remembers a role: the route decides the area. `web/src/pages/Private` is deleted
  in task 9; its modals and rows are reused where they fit.
- **The term rule** (carried from phase 3). A proposal's term counts whole days from the block
  its creation confirmed in: `termBlocks = floor((expiry − createdAtHeight) / 1440) · 1440`. The
  borrower's form sets `expiry = tip + days · 1440 + TERM_MARGIN_BLOCKS` (60), so a proposal
  that confirms within an hour of being built counts exactly the days the borrower chose. One
  function in `web/src/privateLending/lenderTerms.ts` serves the form, the console and the e2e.
  A proposal that confirms later than that counts a day less and may be flagged; the lender can
  still accept it.
- **The lender's own terms** are read by key (`fetchDirectoryEntry`) and verified like any entry
  (task 2), then pre-fill the terms form; nothing is kept in local storage.
- **Tests.** The web gets Vitest (`pnpm test`) for the pure rules of this phase; checks that need
  the chain stay in `pnpm e2e:private`, and the UI is checked by a Playwright demo on testnet
  (task 11), which needs `@playwright/test` and its Chromium (`pnpm exec playwright install
  chromium`).
- **Messages (phase 6).** The proposal form, the accept review, the repay modal and the loan views
  are built as stacks of labeled sections, so phase 6 adds a message section without changing
  the layout. No placeholder appears in this phase.

### Design direction (from the `frontend-design` skill)

The site keeps its brand: Inter, the tokens in `web/src/styles/tokens.css` (accent `#2706cf`),
HeroUI v3 components. The two areas differ in density, not in brand.

- **Lender console: a ledger.** A fixed 224 px sidebar on `--background` (#f5f5f5) with the four
  sections and the area switch at its foot; the work area on `--surface` (#ffffff). Tables are
  the main form: 13 px rows, `tabular-nums`, amounts right-aligned with their unit, keys as
  `KeyFingerprint`. The summary strip is one row of figures divided by `--separator` rules, not
  a row of cards. The memorable element is the terms column: each breach named in plain words
  ("APR below 6 %", "collateral below 0.0790 tL-BTC"), the within-terms badge in `--success`
  soft, the outside-terms badge in `--warning` soft. Desktop first; under 1024 px the sidebar
  becomes a top bar.
- **Borrower app: one column, one decision at a time.** Max width 560 px, centered, 16 px
  gutters, no table: lenders and loans are lists of rows that wrap. The steps are a real
  sequence, so the header shows "Choose a lender, Propose, My loans" as steps. The memorable
  element is the proposal's summary sentence, set at `text-h3` and updated as the borrower types:
  "You repay 5,086.30 TEST by 10 February 2027. If you don't, E2E Lender keeps your 0.085 tL-BTC."
- **Both.** No all-caps labels and no middle-dot meta strings (the current page's 11 px
  uppercase headings are not carried over); labels are sentence case. Monospace only for keys.
  Motion only where an action changes something (a row's status after a broadcast). Visible
  focus, `prefers-reduced-motion` respected.
- **Words.** The borrower app says "proposal", "lender", "collateral", "receive", "repay" and
  "cancel", never "offer", "NFT" or "lending key"; it shows key fingerprints as "Lender key".
  The console may use the protocol's words. An action keeps its name from button to toast: "Sign
  and publish" gives "Terms published".

### Phase 4 review focus

1. A directory entry the indexer altered (a changed rate, a swapped name, or a signature from
   another key): no borrower sees it as a lender, and the lender's own form is not pre-filled
   from it. Task 1 and task 2 test it.
2. A proposal confirmed hours after it was built, or built outside the app with an odd expiry:
   the console counts its term by the term rule and names the broken term; the lender can still
   accept after the warning. Task 3's tests pin the rule; task 6 shows the badge.
3. Two flows in one session before a scan (a creation, then a cancellation; an acceptance, then
   a claim): the second gets new receive and change addresses, never index 0, never past the gap
   limit. Task 4 tests it.
4. A borrower typing less than the lender's minimums (APR, collateral, a term or principal out
   of range, more decimals than the asset has): the form says which term and does not submit.
   Task 3 tests the limits; task 8 wires them and task 11 drives them.
5. The borrower app at 375 px: no horizontal scroll on any of its three pages, the summary and
   the action buttons reachable. Task 11 measures it.

### Task 1: The indexer serves each entry's signature, and the wasm verifies it

**Files:**
- Create: `crates/indexer/migrations/20261115120000_directory_signatures.sql`
- Modify: `crates/indexer/src/api/directory/{db,dto,handlers}.rs`, `crates/indexer/tests/directory_api.rs`,
  `.sqlx/` (regenerated with `cargo sqlx prepare --workspace`)
- Modify: `crates/private-lending-wasm/src/directory.rs` (and its wasm build in `web/src/wasm/private-lending/`)

**Interfaces (produces):**
- Columns `signed_challenge BYTEA` and `signature BYTEA`, both null for entries written before
  this task; a put stores the challenge it consumed and the signature it checked.
- The entry DTO gains `signed_challenge: Option<String>` and `signature: Option<String>` (hex),
  in the list and in `GET /directory/{pubkey}`, and in the OpenAPI schema.
- Wasm `verifyDirectoryEntry(pubkeyHex: string, challengeHex: string, displayName: string,
  termsJson: string, signatureHex: string): boolean`: the core's `verify_directory_action` for
  the put action, after `decode`/`validate` of the terms (invalid terms give `false`, never a
  throw); malformed hex gives an error naming the field.

- [ ] **Step 1: Write the failing tests.** In `directory_api.rs`:
  `put_stores_challenge_and_signature` (the served pair equals the put's, and verifies with
  `verify_directory_action`) and `entry_before_signatures_serves_nulls` (an entry inserted
  without them serves `null`). In the wasm's tests: `verify_entry_accepts_signed_put` and
  `verify_entry_rejects_changed_terms_name_or_key` (one byte of the rate, the name, another key).
- [ ] **Step 2: Run them to see them fail.** `cargo test -p lending-indexer --test directory_api`
  and `cargo test -p private-lending-wasm`. Expected: FAIL.
- [ ] **Step 3: Implement**, then `pnpm build:wasm` in `web`.
- [ ] **Step 4: Check.** The two test commands, `cargo clippy --workspace --all-targets --all-features -- -D warnings`.
  Expected: pass.
- [ ] **Step 5: Commit** `indexer, wasm: directory entries carry a verifiable signature`

### Task 2: The web reads verified entries only

**Files:** Modify `web/src/api/indexer/private.ts` (schema), `web/src/privateLending/directory.ts`,
`web/src/privateLending/hooks/useDirectory.ts`, `web/src/pages/Private/components/{DirectorySection,BorrowSection,PairTermsSummary}.tsx`,
`web/scripts/e2e-private-lending.ts` (`directory` stage), `web/scripts/check-private-lending-parity.ts`.

**Interfaces (produces):**
- `directory.ts`: `type EntryCheck = { status: 'verified'; terms: LenderTermsInput } | { status:
  'unsigned' | 'invalid' }` and `checkDirectoryEntry(wasm, entry: DirectoryEntry): EntryCheck`.
- `useDirectory()` returns `lenders: VerifiedLender[]` (`entry` plus its verified `terms`; only
  entries whose check is `verified`), `hiddenCount: number`, `lookup(pubkey)` over all entries
  (for names only), and `own: { entry: DirectoryEntry | null; check: EntryCheck | null }` from
  `fetchDirectoryEntry` by the session's key (a 404 is `entry: null`), replacing `ownEntry`.
- Messages: the APR error of the terms form reads "Enter the minimum APR as a percent, such as
  6 or 6.25"; an entry whose terms could not be read or verified says "These terms could not be
  verified" instead of "No terms published."

- [ ] **Step 1: Write the failing checks.** The `directory` stage reads the lender's entry back
  through `checkDirectoryEntry` (`verified`), then the same entry with one changed rate,
  another name, and its signature cleared (`invalid`, `invalid`, `unsigned`). The parity script
  runs `verifyDirectoryEntry` on a fixture entry signed by the core.
- [ ] **Step 2: Run to see them fail.** `cd web && pnpm parity && pnpm e2e:private directory`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** The Private page's directory and borrow sections use `lenders` and
  `own` (this page goes in task 9; it must keep working until then).
- [ ] **Step 4: Check.** `pnpm build && pnpm lint && pnpm parity && pnpm e2e:private directory`.
  Expected: pass.
- [ ] **Step 5: Commit** `web: borrowers and the lender's own form see verified terms only`

### Task 3: Vitest, the term rule and the proposal checks

**Files:**
- Modify: `web/package.json` (`vitest` dev dependency, script `"test": "vitest run"`),
  `web/vite.config.ts` (test block, `environment: 'node'`)
- Create: `web/src/test/wasm.ts` (loads the private-lending wasm in Node with `initSync`, as the
  parity script does)
- Modify: `web/src/privateLending/lenderTerms.ts`
- Create: `web/src/privateLending/proposalCheck.ts`, `web/src/privateLending/lenderTerms.test.ts`,
  `web/src/privateLending/proposalCheck.test.ts`
- Modify: `web/scripts/e2e-private-lending.ts` (the `create` stage's expiry and `createProposal`)

**Interfaces (produces):**
- `lenderTerms.ts`: `TERM_MARGIN_BLOCKS = 60`; `proposalExpiry(tipHeight: number, days: number):
  number`; `termBlocksOf(expiry: number, createdAtHeight: number): number` (the rule above; 0
  when the expiry is not after the creation block).
- `proposalCheck.ts`:
  - `proposalOfOffer(terms: PrivateOfferTerms, createdAtHeight: number): ProposalInput`.
  - `type TermsVerdict = { kind: 'within' } | { kind: 'outside'; breaches: TermBreachName[];
    labels: string[] } | { kind: 'unknown'; reason: 'no-terms' | 'unverified' }` and
    `checkAgainstTerms(wasm, own: EntryCheck | null, proposal: ProposalInput, pairInfo:
    TermsPair): TermsVerdict`.
  - `breachLabel(breach: TermBreachName, pair: PairTermsInput, pairInfo: TermsPair): string`,
    plain words with the lender's figure: "APR below 6 %", "collateral below 0.0790 tL-BTC",
    "term shorter than 30 days", "term longer than 180 days", "principal below 1,000 TEST",
    "principal above 50,000 TEST", "pair you do not lend".
  - `proposalLimits(wasm, pair: PairTermsInput, principal: bigint, days: number): { minCollateral:
    bigint; minRepayment: bigint }`; `repaymentAt(wasm, principal: bigint, aprBps: number, days:
    number): bigint` (`minRepayment` at the borrower's APR, rounded up); and
    `proposalFormErrors(wasm, pair, pairInfo, form: ProposalForm): Partial<Record<keyof
    ProposalForm, string>>` for `ProposalForm { principal: string; days: string; collateral:
    string; aprPercent: string }` (display strings; the APR takes at most two decimals, a basis
    point): a principal or term outside the ranges, collateral below `minCollateral`, an APR
    below the minimum, more decimals than the asset has. Each message names the lender's figure.

- [ ] **Step 1: Write the failing tests.** `lenderTerms.test.ts`: `termBlocksOf` at a creation
  one block and 60 blocks after the build tip (whole days), 61 blocks after (a day less), and an
  expiry at or before the creation block (0). `proposalCheck.test.ts`: a proposal exactly at
  every minimum is `within`; one unit of collateral below gives `["CollateralBelowMinimum"]` with
  the label naming the least collateral; no own entry gives `unknown`/`no-terms`, an `invalid`
  check `unknown`/`unverified`; `proposalFormErrors` refuses an APR a basis point low (a
  repayment one unit below `minRepayment`), a collateral one unit low, 0 and `maxTermDays + 1`
  days, and `1.000000001` for an 8-decimal asset; `repaymentAt` at the minimum APR equals
  `minRepayment`, and a proposal built from the form's minimums is `within`.
- [ ] **Step 2: Run to see them fail.** `cd web && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, and build the e2e `create` offer with `proposalExpiry(tip, 1)` and
  its proposal with `termBlocksOf` from the candidate's `created_at_height` (the `directory`
  stage keeps `1 · 1440`, its stated term).
- [ ] **Step 4: Check.** `pnpm test && pnpm build && pnpm lint`. Expected: pass.
- [ ] **Step 5: Commit** `web: one term rule and the proposal checks, under Vitest`

### Task 4: Fresh addresses across flows in one session, and the e2e's identity checks (**Review now**: a receiver outside the gap limit is not found by a restored wallet, and index 0 is the wallet's identity)

**Files:**
- Create: `web/src/privateLending/addressCursor.ts`, `web/src/privateLending/addressCursor.test.ts`
- Modify: `web/src/privateLending/{receiver,deps}.ts`, `web/src/privateLending/flows/{acceptance,repayment,creation,cancellation,claimPrincipal,claimRepayment,liquidation}.ts`,
  `web/src/privateLending/hooks/usePrivateFlowDeps.ts`, `web/scripts/e2e-private-lending.ts`

**Interfaces (produces):**
- `GAP_LIMIT = 20` (LWK's). `class AddressCursor { nextReceive(wollet): Address;
  nextChange(wollet, count: number): Address[] }`: each returns indices from `max(LWK's last
  unused, highest handed out + 1)`, never index 0 for receive, and at most `last unused +
  GAP_LIMIT − 1`; at that bound it hands out the bound again (privacy, not funds, is lost).
- `PrivateFlowDeps.addresses: AddressCursor`, one per wallet session (made where the session's
  deps are, dropped with the session). `walletReceiver(deps)` uses it; every flow's change comes
  from `nextChange` (acceptance and repayment take two).
- e2e: `creationNftReceiver` refuses a receiver equal to the identity script;
  `checkWalletIdentities` fails when the state file has no `wallets` record.

- [ ] **Step 1: Write the failing tests** in `addressCursor.test.ts` over a fake wollet with a
  settable last-unused index: two `nextReceive` calls give two indices; after LWK's last unused
  moves past them the next one follows it; a fresh wallet (last unused 0) gets 1, not 0;
  `nextChange(w, 2)` gives two consecutive change indices and the next call continues after
  them; at the bound the same address repeats.
- [ ] **Step 2: Run to see them fail.** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, and the two e2e checks.
- [ ] **Step 4: Check.** `pnpm test && pnpm build && pnpm lint && pnpm parity`, then the e2e
  `create`, `cancel`, `accept` and `claim-principal` stages from an empty state: the run logs each
  receiver and change index, and no index repeats within the run.
- [ ] **Step 5: Commit** `web: each flow in a session gets new addresses`

### Task 5: The site's shell: landing entrances, two areas, routes

**Files:**
- Modify: `web/src/App.tsx`, `web/src/constants/routes.ts`, `web/src/pages/Landing/components/{Hero,LandingHeader,GetStarted}.tsx`
- Create: `web/src/areas/lend/LenderLayout.tsx`, `web/src/areas/borrow/BorrowerLayout.tsx`,
  `web/src/areas/WalletGate.tsx`
- Delete: `web/src/components/AppLayout.tsx` once nothing uses it (the Private page moves under
  `/lend/proposals` as a stand-in until task 6 replaces it)

**Interfaces (produces):**
- `RoutePath`: `Landing '/'`, `Lend '/lend'`, `LendProposals`, `LendLoans`, `LendTerms`,
  `LendProfile`, `Borrow '/borrow'`, `BorrowLender '/borrow/:lenderKey'`, `BorrowLoans`, and
  `borrowLenderPath(pubkey: string): string`.
- `isAppPath(pathname)` covers `/lend` and `/borrow`, so the providers mount there.
- `WalletGate({ children })`: the wallet's states as the Private page shows them now
  (connect, reconnecting, a wallet that cannot do private loans), the children once ready.
- `LenderLayout`: the sidebar of the design direction with its header (directory name from
  `useDirectory().own`, key fingerprint, the wallet button naming the connected signer) and
  the "Borrower side" link;
  `BorrowerLayout`: the stepped header and the "Lender console" link.

- [ ] **Step 1: Implement.** The landing hero gets the two entrances ("For lenders": publish
  your terms, review proposals, run your book, "Open lender console"; "For borrowers": pick a
  lender and borrow against your collateral, "Borrow"); `/app` and `/app/*` redirect to `/`.
- [ ] **Step 2: Check.** `pnpm build && pnpm lint && pnpm test`, and in `pnpm dev` each route
  renders its layout (record it in the report; screenshots are task 11's).
- [ ] **Step 3: Commit** `web: the landing page opens two areas, lend and borrow`

### Task 6: The console's proposals and loan book

**Files:**
- Create: `web/src/areas/lend/ProposalsPage.tsx`, `web/src/areas/lend/LoanBookPage.tsx`,
  `web/src/areas/lend/SummaryStrip.tsx`, `web/src/areas/lend/TermsBadge.tsx`,
  `web/src/areas/lend/bookSummary.ts`, `web/src/areas/lend/bookSummary.test.ts`
- Modify: `web/src/components/modals/private/AcceptPrivateOfferModal.tsx`, the offer view
  (`web/src/privateLending/offerView.ts`) for the lender's actions

**Interfaces:**
- Consumes: `checkAgainstTerms`, `proposalOfOffer`, `breachLabel` (task 3); `useDirectory().own`
  (task 2); the lender's `usePrivateOffers().lending`, `lenderView` moved from `LendSection` to
  `offerView.ts`.
- Produces: `bookSummary(items: OpenedOfferItem[], tipHeight: number): { waiting: number; active:
  number; lent: bigint; collateralHeld: bigint; dueWithin7Days: number; overdue: number }` (lent
  and held sum the active loans; due within seven days is active with `0 < expiry − tip ≤ 7 ·
  1440`; overdue is active past expiry). `AcceptPrivateOfferModal` gains `verdict:
  TermsVerdict`: for `outside` or `unknown` it lists the reasons and the sign button stays
  disabled until the lender ticks "Accept outside my terms".

- [ ] **Step 1: Write the failing test** `bookSummary.test.ts`: the counts and sums over a mix of
  pending, active (due in 3 days, due in 8 days, overdue), repaid and claimed items, and with
  the tip unknown (0: nothing due, nothing overdue).
- [ ] **Step 2: Run to see it fail.** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Proposals: the strip and the table of pending proposals (received
  as the block's age, borrower fingerprint, principal, collateral, principal per collateral, APR
  from `aprBps` over the term rule, term in days, the badge, "Review"). Review opens the accept
  modal; a proposal past its expiry shows "Its term has passed" and no Review (item 4). Loan
  book: active, repaid and overdue loans with "Claim" and "Liquidate" as `lenderView` decides,
  the unsent and processing states as the action row shows them now.
- [ ] **Step 4: Check.** `pnpm test && pnpm build && pnpm lint`. Expected: pass.
- [ ] **Step 5: Commit** `web: the lender console's proposals and loan book`

### Task 7: The console's terms and profile

**Files:** Create `web/src/areas/lend/TermsPage.tsx`, `web/src/areas/lend/ProfilePage.tsx`;
reuse `PairTermsSummary`; move the form logic out of `DirectorySection.tsx`.

**Interfaces:** Consumes `useDirectory()` (`own`, `register`, `remove`) and
`lenderTermsFromForm`/`pairTermsToForm`. Terms: the configured pair's form, pre-filled from
`own` only when its check is `verified`; "Sign and publish" gives the toast "Terms published";
"Last published" from `terms_published_at`; an unverified own entry says so and asks for a
fresh publish. Profile: the display name (published with the terms, the same signature), the
key fingerprint, "Copy key", and "Remove from directory" behind a confirmation.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Check.** `pnpm build && pnpm lint && pnpm test && pnpm e2e:private directory`.
- [ ] **Step 3: Commit** `web: the lender console's terms and profile`

### Task 8: The borrower's lender list and proposal form

**Files:** Create `web/src/areas/borrow/ChooseLenderPage.tsx`, `web/src/areas/borrow/ProposalPage.tsx`,
`web/src/areas/borrow/ProposalSummary.tsx`; modify
`web/src/components/modals/private/CreatePrivateOfferModal.tsx` (its words); retire
`CreatePrivateOfferForm.tsx` once nothing uses it.

**Interfaces:** Consumes `useDirectory().lenders`, `proposalLimits`, `proposalFormErrors`,
`repaymentAt`, `proposalExpiry` (task 3), the creation flow through `CreatePrivateOfferModal`.
- Choose a lender: the pair as a heading ("Borrow TEST against tL-BTC", from the build
  configuration), each verified lender with its name, "Lender key" fingerprint, terms
  (`PairTermsSummary`) and "Terms published 3 hours ago", and "Borrow from <name>"; the hidden
  count as "N lenders hidden: their terms could not be verified" when it is not 0.
- Proposal (`/borrow/:lenderKey`; an unknown or unverified key goes back to `/borrow` with a
  note): fields principal, term in days, collateral and APR, opening at the minimum principal,
  the minimum term, `minCollateral` and the minimum APR; when principal or days change,
  collateral rises to the new minimum but never drops below what was typed; the repayment is
  `repaymentAt`, shown and not typed; the errors of `proposalFormErrors` under each field; the
  summary sentence of the design direction,
  then "You can cancel and take your collateral back until <name> accepts." and "Only you and
  <name> can read this proposal."; "Lock collateral and send".

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Check.** `pnpm build && pnpm lint && pnpm test`.
- [ ] **Step 3: Commit** `web: borrowers choose a lender and propose within its terms`

### Task 9: The borrower's loans, and the Private page goes

**Files:** Create `web/src/areas/borrow/MyLoansPage.tsx`; modify the borrower modals
(`CancelPrivateOfferModal`, `ClaimPrincipalModal`, `RepayPrivateOfferModal`) for the words;
delete `web/src/pages/Private/` and whatever only it used.

**Interfaces:** Consumes `usePrivateOffers().borrowing` and the borrower's view from
`BorrowSection` (moved to `offerView.ts`). One row per loan: lender name and key, principal and
collateral, a status in the borrower's words ("waiting for <name>", "accepted", "active, due in
12 days", "repaid", "cancelled", "collateral taken"), and the one action that applies now
("Cancel", "Receive 20,000 TEST", "Repay 3,021.40 TEST"), with "Broadcast again" for an unsent
transaction.

- [ ] **Step 1: Implement**, and check that `grep -rn "pages/Private" web/src` finds nothing.
- [ ] **Step 2: Check.** `pnpm build && pnpm lint && pnpm test`.
- [ ] **Step 3: Commit** `web: the borrower's loans; the Private page is gone`

### Task 10: Cleanup carried from phase 2

**Files:** as listed below.

- [ ] **Step 1:** The orphaned IndexedDB `simplicity-lending:pending-transactions` is deleted
  once at startup (`deleteDB`, errors ignored); `utils/zod.ts`'s dead exports, the `z-toast`
  utility, `verifyReceiveAddress` and `getReceiveAddress` go (`pnpm build` proves no caller);
  the wallet button reads the address when it renders, not once at connect; the nginx
  `/.well-known/liquid-asset-proof-` block goes; the docs site redirects `/docs/borrower/*`,
  `/docs/lender/*` and `/docs/protocol/*` to the private-loans guide; the prose in
  `docs/docs/{developers,contracts}` and `simplicity.md` is wrapped at 100 columns; the links to
  `/app/private` in `docs/docs/private-loans/guide.md`, `web/README.md`, `deployment/README.md` and
  `deployment/local-compose-check.md` point at `/lend` and `/borrow`, and the guide describes the
  two areas.
- [ ] **Step 2: Check.** `pnpm build && pnpm lint && pnpm test`, the docs build, `docker compose build web`.
- [ ] **Step 3: Commit** `web, docs, deployment: phase 2's leftovers`

### Task 11: The scripted testnet demo

**Files:**
- Modify: `web/package.json` (`@playwright/test` dev dependency, script `"demo:testnet": "playwright test -c scripts/demo"`)
- Create: `web/scripts/demo/playwright.config.ts`, `web/scripts/demo/demo.spec.ts`,
  `web/scripts/demo/wallet.ts` (connects a seed wallet through the connect modal)
- Modify: `web/scripts/e2e-private-lending.ts` (stage `short-proposal`), `web/README.md`

**Interfaces:** The demo starts `pnpm dev --mode demo` against the local indexer of
`web/README.md`, with the e2e's two seed phrases from `.env.e2e.local`, one browser context per
wallet, and runs in order (one test, `test.step` per line below; timeouts sized for testnet
blocks). The e2e stage `short-proposal` creates a proposal to the lender with a 15-block term
(outside any terms of at least one day) and stops.

- [ ] **Step 1: Write the demo.**
  1. The lender publishes terms on `/lend/terms` (the e2e terms) and sees "Terms published".
  2. The borrower opens `/borrow`, picks the lender, types an APR one basis point below the
     minimum and a collateral one base unit below it: both fields show their error and "Lock
     collateral and send" stays disabled; with the minimums it sends, and My loans shows
     "waiting for E2E Lender".
  3. `pnpm e2e:private short-proposal` runs; the lender's proposals show it with the badge
     "term shorter than 1 day".
  4. The lender reviews the borrower's proposal (within terms) and accepts; the borrower
     receives the principal and repays; the lender claims.
  5. The lender accepts the short proposal after ticking "Accept outside my terms", waits for
     its expiry and liquidates; the loan book shows it as liquidated.
  6. At a 375 × 812 viewport, each borrower page has `scrollWidth ≤ clientWidth`; a screenshot
     of each page of both areas is saved under `web/.demo-output/` (git-ignored).
- [ ] **Step 2: Run it.** `pnpm exec playwright install chromium && pnpm demo:testnet` (fund the
  wallets from the faucet if `pnpm e2e:private wallets` reports a shortfall). Expected: pass.
  Fix what it finds in the task that owns the code, one commit each.
- [ ] **Step 3: Commit** `web: a scripted testnet demo of both areas`

### Task 12: Verify the phase

- [ ] **Step 1:** `cargo test --workspace` without the regtest tests, `cd crates/contracts &&
  simplex test`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`.
- [ ] **Step 2:** `cd web && pnpm test && pnpm build && pnpm lint && pnpm parity &&
  pnpm check:config`; every e2e stage from an empty state with a fresh local indexer database.
- [ ] **Step 3:** `pnpm demo:testnet` once more on the final tree; look at the screenshots.
- [ ] **Step 4:** The migration on a copy of the dev database with a phase 3 entry: it survives
  with null signature fields and is hidden from borrowers. `docker compose build` and the docs
  build. Commit `docs: v2 phase 4 verified` with the results.

The phase review follows (whole branch, Opus).

---

## Phase 5: The contract revision (spec items 1 and 3a)

Branch `v2/phase-5-contract`, from `v2/main` after phase 4 was merged into it.

The design is the spec's "Phase 5 design note" (`86e31b7`, revised in `9307a02`): the branch
checks, the formulas, the client rules and the done-when tests are there and are not repeated
here. Every implementer reads it before their task. The note replaced this section's gate: the
loan closes by equality, or by revealing the debt's blinder `k` when the debt is already zero, not
by a BIP340 signature under `D_final`.

Decided at phase start (2026-11-18), including the note's "Left to the builder":
- **The witness path** keeps v1's shape and carries each branch's data, with a debt point as a
  commitment in Elements' encoding, `(bool, u256)` (the low bit of the prefix, and `x`; a `bool`
  because simplex 0.0.5's generated `u1` conversion panics on 0, task 4):
  `Either<Either<(), ()>, Either<Either<(bool, u256), Either<u256, ((bool, u256), u256)>>, (u256, u256, u32)>>`.
  Acceptance `Left(Left(()))`; cancellation `Left(Right(()))`; installment `Right(Left(Left(D)))`;
  full repayment `Right(Left(Right(Left(h))))`; zero-debt close `Right(Left(Right(Right((D, k)))))`;
  liquidation `Right(Right((h, salt, expiry)))`.
- **Parameters.** `EXPIRY_HASH: u256` replaces `LOAN_EXPIRATION_TIME`; new `REPAYMENT_ASSET:
  (bool, u256)` (`A` in the same encoding) and `INSTALLMENT_OUTPUT_SCRIPT_HASH: u256`;
  `ACTIVE_COLLATERAL_COMMITMENT` stays for acceptance only.
- **Square-ness** is tested with `jet::fe_square_root`, with no root hints in the witness. If the
  installment branch goes over the cost budget, task 4 switches to hints (`s² = ±y`) and says so
  in its report.
- **Derived values.** The salt is `OfferSecrets::derive("expiry-salt")`, and `EXPIRY_HASH =
  SHA-256(salt ‖ expiry_be32)`. The installment's ephemeral key is
  `tagged_hash("simplicity-lending/private/v1/installment-ephemeral", borrower_sk ‖ loan txid ‖
  loan vout_le32 ‖ first wallet input txid ‖ vout_le32 ‖ SHA-256(output 0's script))`, in
  `ephemeral_key`'s byte order. *(My call:)* the note proposed the first three parts; output 0's
  script, the borrower NFT's fresh receive address, makes every build differ, so a rebuilt
  installment never reuses a range proof nonce, and the chain still shows it. Tags keep the `v1/`
  prefix. Each installment's value blinder is random; the rewind recovers it.
- **Layouts** (change and fee follow every list):
  - installment: inputs 0 borrower NFT, 1 loan, 2… principal coins, then fee coins (input 2 is the
    "first wallet input"); outputs 0 borrower NFT (explicit, to a fresh receive address),
    1 successor loan, 2 installment, 3 principal change if any;
  - zero-debt close: inputs 0 borrower NFT, 1 loan, then fee coins; outputs 0 borrower NFT burn,
    1 `OP_RETURN` with one 32-byte push of `k` (also in the witness), 2 the collateral to the
    borrower;
  - claims: inputs 0 lender NFT, 1… the locked outputs (installments, and the full repayment at
    the final claim), then fee coins; outputs 0 the lender NFT (back to the lender, or burned at
    the final claim), 1 what was claimed, to the lender;
  - liquidation: v1's inputs 0 loan, 1 lender NFT and outputs 0 lender NFT burn, 1 collateral,
    then the installments that open as inputs 2… and their sum as output 2.
- **The indexer** records an installment as a new UTXO type `installment` in a candidate's
  `utxos`, with no new endpoint. It reads an active offer's spend this way. Output 0 burns the
  borrower NFT: the zero-debt close if output 1 is an `OP_RETURN` (`repaid`, no repayment UTXO),
  else the full repayment (`repaid`, repayment UTXO at 1). Output 0 holds the borrower NFT
  unburned: an installment (active offer at 1, installment at 2). Anything else: a liquidation, as
  in v1.
- **Client rules beyond the note** *(my call)*. Past the loan's expiry the repay form offers only
  the full repayment: "The term has ended: the lender can take the collateral at any time. Repay
  in full to get it back." An unsent saved installment of a loan blocks any new build for that
  loan until it is broadcast again or discarded.
- **E2E.** A new stage `repay-partial` (and `repay-partial-dry`) runs on the `accept` loan after
  `claim-principal` and before `repay`: installment 1, the lender's claim of it, installment 2 left
  unclaimed. `repay` then pays the rest, and `claim-repayment` sweeps installment 2 with the
  repayment. A liquidation with installments is covered by the contract tests only.
- **Names.** The flow is `flows/installment.ts` (this section first said `partialRepayment.ts`):
  the note calls every payment that leaves debt an installment.
- **The indexer is in scope** (task 7), though this section's first file list left it out.
- **Carried from phase 2:** `crates/contracts/Cargo.toml` loses the dead features `lending` and
  `pre_lock` (task 2); the header comment of `private_lending.simf` is rewritten with the revision
  (task 4).
- **Carried from phase 4's review:** task 1.

### Phase 5 review focus

1. Installments before the principal is claimed: the borrower NFT then sits at an installment's
   output 0, and the principal stays locked to it. The full repayment and the zero-debt close burn
   the NFT, so they must refuse until the principal is claimed. Task 8 tests it.
2. A loan outpoint from the indexer that is not the loan: an output someone sent to the loan's
   address, or one whose history does not lead back to the acceptance. The app must refuse to pay
   or liquidate against it. Tasks 6 and 8 test it.
3. A borrower on a new device, with no saved records: the app must rebuild the remaining debt and
   its blinder from the seed and the chain alone, or the loan can never close. Task 6 tests it.
4. An installment after the term: the lender can liquidate at any moment and keep it. The repay
   form refuses it (above). Task 10 tests it.
5. A retried installment: while a saved installment of a loan is unsent, the app offers only to
   broadcast it again or to discard it, never a second build. Task 10 tests it.

### Task 1: Carried from phase 4's review

**Files:** Modify `web/src/privateLending/hooks/usePrivateTransaction.ts`,
`web/src/components/modals/private/PrivateTxShell.tsx`, `web/src/areas/lend/useCreationHeights.ts`,
`web/src/areas/lend/TermsBadge.tsx`, `web/src/areas/lend/ProposalsPage.tsx`,
`web/scripts/e2e-private-lending.ts`. Create `web/src/privateLending/sendSaved.ts`,
`web/src/privateLending/sendSaved.test.ts`.

**Interfaces (produces):**
- `sendSaved(txid: string, beforeBroadcast: (() => Promise<void>) | undefined, broadcast: () =>
  Promise<void>): Promise<void>`, used by both `run` and `retryBroadcast`. A failing
  `beforeBroadcast` (a stale term, a tip-fetch error) throws `PrivateBroadcastError` with the
  saved txid and the check's message, so the shell shows the saved transaction ("Broadcast
  again", or only "Discard" when blocked), never the build button again.
- `useCreationHeights` returns `ReadonlyMap<string, CreationHeight>`, with `type CreationHeight =
  { kind: 'confirmed'; height: number } | { kind: 'unconfirmed' } | { kind: 'failed' }`.
  `TermsBadge` takes `pending?: 'unconfirmed' | 'failed'` and shows "Not confirmed yet" or "Could
  not read the chain" (default tone); the skeleton stays only while the first answer loads.
  Review stays disabled in all three cases.

- [ ] **Step 1: Write the failing tests** in `sendSaved.test.ts`: a throwing `beforeBroadcast`
  gives a `PrivateBroadcastError` whose `txid` is the saved one and whose message is the check's,
  and `broadcast` is never called; a passing one calls `broadcast` once.
- [ ] **Step 2: Run them to see them fail.** `cd web && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, and in the e2e script:
  - `dropExpiredShortProposal` asks the chain about a `broadcast` record first. A transaction the
    chain knows (in the mempool or a block) keeps its record for the stage to resume; only an
    unknown one is removed.
  - `walletsStage` refuses to split while another stage's record is `built` or `broadcast`. It
    prints "resume or drop <stage> before splitting" and exits 1.
- [ ] **Step 4: Check.** `pnpm test && VITE_DEBUG_MNEMONIC= pnpm build && pnpm lint`. Expected:
  pass.
- [ ] **Step 5: Commit** `web: a failed check before broadcast keeps the saved transaction`

### Task 2: The hidden expiry (item 1) (**Review now**: a wrong salt or hash makes every loan impossible to liquidate)

**Files:**
- Modify: `crates/contracts/simf/private_lending.simf` (liquidation only),
  `crates/contracts/Cargo.toml` (the dead features go),
  `crates/contracts/src/programs/private_lending/{params,witness,core,verify}.rs`
- Modify: `crates/private-lending-core/src/{secrets,lib}.rs`
- Modify: `crates/private-lending-wasm/src/{open,build}.rs`
- Modify: `web/src/simplicity/private-lending/{scripts,witness}.ts`,
  `web/src/privateLending/{finalize,flows/*}.ts` (the witness they pass),
  `web/scripts/check-private-lending-parity.ts`,
  `web/scripts/fixtures/private-lending-parity.json` (regenerated)
- Create: `crates/contracts/tests/private_lending/hidden_expiry.rs`; modify its `mod.rs`,
  `setup.rs`, `parity_fixture.rs`, `offer_liquidation_success_flows.rs`, `failure_flows.rs`

**Interfaces (produces):**
- Core: `OfferSecrets::expiry_salt(&self) -> [u8; 32]` and `pub fn expiry_hash(salt: &[u8; 32],
  expiry: u32) -> [u8; 32]`, exported.
- `PrivateLendingParameters { …, loan_expiration_time: u32, expiry_salt: [u8; 32], … }`;
  `from_terms(terms: &OfferTerms, pinned: OfferPinned, secrets: &OfferSecrets, network)`;
  `build_arguments` sets `expiry_hash` in place of `loan_expiration_time`.
- `PrivateLendingWitnessBranch::Liquidation { salt: [u8; 32], expiry: u32 }`; task 4 adds the
  debt hash. `attach_liquidation` fills it from the parameters.
- Wasm: `ContractArguments.expiryHash` (getter, hex) next to `loanExpirationTime`;
  `OpenedOffer.expirySalt(): string` (hex).
- Web: `PrivateOfferArguments.expiryHash: string`. `buildPrivateLendingWitness(witness:
  PrivateLendingWitness)` takes a union keyed by `branch`; here `Liquidation` carries `salt: string`
  and `expiry: number`, and the other branches carry nothing yet. `finalizePrivateOfferInput`
  takes that union in place of the branch name.

- [ ] **Step 1: Write the failing tests** in `hidden_expiry.rs` (regtest, `#[simplex::test]`):
  - `salt_changes_the_revealed_cmr`: two offers with the same terms and expiry but different
    salts reveal different CMRs at acceptance and at the full repayment.
  - `candidate_expiries_do_not_match`: from an acceptance's public arguments, the program compiled
    with `EXPIRY_HASH` from no salt (`SHA-256(expiry_be32)`), from a zero salt and from another
    offer's salt matches the revealed CMR for no expiry within ±1 000 blocks of the true one. As
    a control, the true salt at the true expiry matches.
  - `liquidation_fails_with_a_wrong_salt`, `liquidation_fails_with_a_wrong_expiry`,
    `liquidation_fails_before_the_expiry`.

  In the core: `expiry_salt_known_answer` (frozen hex for the bytes 0x80..=0x9f, as the existing
  known-answer test) and `expiry_hash_is_sha256_of_salt_and_big_endian_height`.
- [ ] **Step 2: Run them to see them fail.** Rename
  `crates/contracts/tests/lending_security_audit.rs` aside, then `cd crates/contracts &&
  simplex build && simplex test`, and
  `cargo test -p private-lending-core`. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate the fixture with `WRITE_PARITY_FIXTURE=1 simplex test
  write_private_lending_parity_fixture`, then `cd web && pnpm build:wasm`. The liquidation flow
  passes `opened.expirySalt()` and `loanExpirationTime()`.
- [ ] **Step 4: Check.** `simplex test`; `cargo test --workspace` without the regtest tests;
  `cargo clippy --workspace --all-targets --all-features -- -D warnings`; `cd web && pnpm parity &&
  pnpm test && VITE_DEBUG_MNEMONIC= pnpm build && pnpm lint`. Rename the audit file back.
  Expected: pass.
- [ ] **Step 5: Commit** `contracts, core, web: the expiry hides behind a salted hash (item 1)`

### Task 3: The debt as a point, in the core (**Review now**: this arithmetic mirrors the program's; a conversion error sends a loan to an address nobody can spend)

**Files:** Create `crates/private-lending-core/src/debt.rs`; modify
`crates/private-lending-core/src/{keys,offer,lib}.rs` and `crates/private-lending-core/Cargo.toml`
(`k256 = { version = "0.13", default-features = false, features = ["arithmetic"] }`, for
`FieldElement::sqrt` as the square-ness test).

**Interfaces (produces):**
- `pub struct DebtOpening { pub amount: u64, pub blinder: ValueBlindingFactor }` with
  `DebtOpening::of(pinned: &PinnedOutput) -> Self`, `after(self, payment: DebtOpening) ->
  Option<DebtOpening>` (`None` when the payment is larger; the blinders subtract modulo `n`) and
  `commitment(&self, repayment: &PinnedOutput) -> confidential::Value`, the point under `A`
  (`repayment`'s asset id and asset blinder), with amount 0 allowed.
- `pub enum DebtError { NotConfidential, NotOnCurve, Infinity, NotThisDebt }`.
- `pub fn debt_after(debt: &confidential::Value, payment: &confidential::Value) ->
  Result<confidential::Value, DebtError>`: `D − V` through the note's conversions, `Infinity` when
  they are equal.
- `pub fn debt_hash(asset: &confidential::Asset, debt: &confidential::Value) -> [u8; 32]`:
  `h(A, D)`.
- `pub fn asset_plus_generator(asset: &confidential::Asset) -> Result<confidential::Asset,
  DebtError>`: `A_c + G`.
- `OfferPinned::collateral_after(&self, installments: u32) -> PinnedOutput`: asset blinder
  `a_c + i`, value blinder `r_c − i·c`; `i = 0` is `active_collateral`.
- `pub fn zero_debt_key(opening: &DebtOpening) -> Option<[u8; 32]>` (`Some` only at amount 0) and
  `pub fn zero_debt_blinder(k: &[u8; 32], debt: &confidential::Value) ->
  Result<ValueBlindingFactor, DebtError>` (`k` or `−k`, whichever gives `debt` exactly).
- `pub fn sweep_opening(start: DebtOpening, claimed: &[DebtOpening], zero_debt:
  Option<ValueBlindingFactor>) -> Option<DebtOpening>`: the note's combined opening, `(R, r₀)`
  minus the claimed openings, minus `(0, k')` after a zero-debt close.
- `pub fn installment_ephemeral_key(borrower: &LendingKey, loan: OutPoint, first_wallet_input:
  OutPoint, nft_receiver: &Script) -> SecretKey`, as decided above.
- `pub fn open_installment(txout: &TxOut, shared_secret: SecretKey, repayment: &PinnedOutput) ->
  Result<DebtOpening, InstallmentError>`. It rewinds the range proof and checks that the asset id
  and asset blinder are `A`'s and that the opening gives the output's commitments. The shared
  secret comes from `OfferSecrets::for_borrower` (derived key, lender key) or
  `OfferSecrets::for_lender` (lender key, the output's nonce).

- [ ] **Step 1: Write the failing tests** in `debt.rs` and `keys.rs`, with a seeded RNG:
  - `conversion_round_trips_both_prefix_bits`: value commitments with prefixes `0x08` and
    `0x09`, and generators with `0x0a` and `0x0b`.
  - `debt_after_matches_the_openings`: `D(d, r) − V(p, r_p)` equals `D(d − p, r − r_p)` over 200
    cases covering both bits of each operand.
  - `debt_after_refuses_infinity`.
  - `start_debt_hash_is_the_repayment_commitment`: `debt_hash(A, D₀)` equals
    `pinned.repayment.commitment_hash()`.
  - `collateral_after_keeps_the_value_commitment`: for `i` in 0..=5 the value commitment is
    unchanged, and step `i + 1`'s asset commitment is `asset_plus_generator` of step `i`'s.
  - `zero_debt_blinder_takes_either_sign` and `zero_debt_blinder_refuses_another_point`.
  - `sweep_opening_balances`: the swept commitments add up to the sweep opening's commitment,
    with and without a zero-debt close.
  - `open_installment_for_both_parties`: an installment blinded with the derived key opens for the
    borrower and the lender, and one blinded to another key opens for neither.
  - `opening_after_refuses_overpayment`.
  - `installment_ephemeral_key_known_answer`.
- [ ] **Step 2: Run them to see them fail.** `cargo test -p private-lending-core`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Check.** `cargo test -p private-lending-core -p private-lending-wasm`, clippy as in
  task 2, and `cd web && pnpm build:wasm` (k256 builds for wasm32). Expected: pass.
- [ ] **Step 5: Commit** `core: the debt as a point, and the installment's derived values`

### Task 4: Installments, the full repayment of the rest and the zero-debt close (**Review now**: a wrong check locks the collateral or pays the lender short)

**Files:**
- Modify: `crates/contracts/simf/private_lending.simf` (the branches of the note, and the header
  comment rewritten for the revision),
  `crates/contracts/src/programs/private_lending/{params,witness,core}.rs`
- Create, in `crates/contracts/tests/private_lending/`: `offer_installment_flows.rs`,
  `zero_debt_close_flows.rs`, `liveness.rs`; modify `mod.rs`, `setup.rs`,
  `offer_full_repayment_success_flows.rs`,
  `offer_liquidation_success_flows.rs`, `failure_flows.rs`, `parity_fixture.rs`
- Modify: `crates/private-lending-wasm/src/open.rs` (`ContractArguments`),
  `web/src/simplicity/private-lending/{scripts,witness}.ts`,
  `web/src/privateLending/flows/{repayment,liquidation}.ts`, the parity script and fixture
- Modify: `docs/docs/private-loans/protocol.md`, `docs/docs/simplicity.md` (the contract's branches)

**Interfaces:**
- Consumes: task 3's `DebtOpening`, `debt_after`, `debt_hash`, `collateral_after`,
  `zero_debt_key`.
- Produces:
  - `PrivateLendingParameters::get_installment_output_asset_auth(&self) -> AssetAuth` (lender
    NFT, 1, no burn); `build_arguments` adds `repayment_asset` and
    `installment_output_script_hash`.
  - `PrivateLendingWitnessBranch`: `Installment { debt: confidential::Value }`,
    `FullRepayment { debt_hash: [u8; 32] }`, `ZeroDebtClose { debt: confidential::Value }`,
    `Liquidation { debt_hash: [u8; 32], salt: [u8; 32], expiry: u32 }`. `PartialRepayment` goes.
  - `PrivateLendingOffer::new_active_at(parameters, debt: confidential::Value, installments: u32)
    -> Self`; `new_active` is `new_active_at(D₀, 0)` and `new_with_storage` goes. Getters
    `get_debt()` and `get_installments()`; `get_collateral()` gives `collateral_after(i)` when
    active.
  - `attach_installment(&self, ctx, borrower_nft_utxo: UTXO, loan_utxo: UTXO,
    borrower_nft_receiver: Script, payment: PinnedOutput, lender_blinding_key: PublicKey,
    ephemeral_sk: SecretKey) -> PrivateLendingOffer`: outputs 0 to 2, returning the successor.
    `payment` carries `A`'s asset id and asset blinder.
  - `attach_full_repayment(&self, ctx, borrower_nft_utxo, loan_utxo, opening: DebtOpening,
    lender_blinding_key)`; it panics unless the opening's commitment is the offer's debt.
  - `attach_zero_debt_close(&self, ctx, borrower_nft_utxo, loan_utxo, opening: DebtOpening)`; it
    panics unless the amount is 0 and the commitment is the offer's debt.
  - `attach_liquidation` takes the debt hash from the offer's state.
  - Wasm `ContractArguments.repaymentAssetPrefixBit: number` (0 or 1) and `repaymentAssetX:
    string`. Web: `PrivateOfferArguments` gains both; the witness union gains
    `FullRepayment { debtHash }` and `Liquidation { debtHash, … }`. The flows pass the starting
    debt hash, `repaymentCommitment`, until tasks 8 and 9.

- [ ] **Step 1: Write the failing tests** (regtest). Each failure case builds the transaction and
  shows that finalizing refuses it, as in `failure_flows.rs`.
  - `offer_installment_flows.rs`:
    - `installments_cover_both_prefix_bits`. Search each installment's blinder off chain so that
      `D`, `V`, `D'`, `A_c` and `A_c + G` each occur with both prefix bits. Each installment
      confirms, and its output 1 sits at the storage of `debt_after` and holds
      `collateral_after(i)`.
    - `installment_fails_with_another_asset_on_output_2`.
    - `installment_fails_with_another_script_on_output_2`.
    - `installment_fails_with_another_successor_storage`.
    - `installment_fails_with_another_successor_collateral`: the asset commitment plus `2G`, or
      the same asset with another value commitment.
    - `installment_fails_at_the_point_at_infinity`.
    - `installment_fails_without_the_borrower_nft`.
    - `full_repayment_after_installments_pays_the_rest`: the lender's openings add up to `R`.
    - `full_repayment_fails_with_another_commitment`: the remaining amount with another blinder,
      and one unit more.
    - `installment_runs_within_the_cost_budget`: it confirms, and the test prints its weight and
      cost.
  - `zero_debt_close_flows.rs`:
    - `zero_debt_state_closes_revealing_k` and `zero_debt_state_closes_revealing_minus_k`: the
      state comes from an installment of the exact rest with another blinder.
    - `zero_debt_close_fails_while_debt_remains`.
    - `zero_debt_close_fails_with_k_of_another_point`.
    - `zero_debt_close_fails_with_k_zero`.
    - `zero_debt_close_fails_without_the_op_return`.
  - `liveness.rs`, `liveness_after_random_installments`:
    - The seed is printed, and `LIVENESS_SEED` replays a run.
    - It runs three loans whose term has already passed (mine past it first), each with up to
      five installments of random amounts below the remaining debt.
    - After every installment, a full repayment and a liquidation of the current state both
      finalize, so the program runs on each.
    - Each loan's last state broadcasts its full repayment.
- [ ] **Step 2: Run them to see them fail.** As in task 2. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate the parity fixture and rebuild the wasm, as in task 2.
- [ ] **Step 4: Check.** As in task 2. Expected: pass. The e2e runs from task 8 on: its stages
  need loans made with the new program.
- [ ] **Step 5: Commit** `contracts: installments, the full repayment of the rest and the zero-debt close (item 3a)`

### Task 5: The lender's claims and sweeps, in the contract tests

**Files:** Create `crates/contracts/tests/private_lending/claim_flows.rs`; modify `mod.rs` and
`setup.rs` (a `claim_locked_outputs(keeper, nft: &AssetAuth, locked: &[(UTXO, TxOutSecrets)],
burn: bool) -> anyhow::Result<Transaction>` helper, the lender NFT at input 0).

**Interfaces:** Consumes `sweep_opening`, `open_installment`, `zero_debt_blinder`, `debt_after`
(task 3) and the attaches of task 4.

- [ ] **Step 1: Write the failing tests:**
  - `lender_claims_one_installment_and_keeps_the_nft`.
  - `final_claim_sweeps_unopenable_installments_after_full_repayment`: two installments are
    blinded with random nonces that the lender's key does not open. The final claim gives the
    sweep opening to one input and zero to the others. It confirms, and the lender holds `R` in
    total.
  - `final_claim_sweeps_after_a_zero_debt_close`: the lender reads `k` from output 1 of the close.
  - `lender_liquidates_a_loan_it_cannot_open`: the lender computes the storage with `debt_after`
    from `D₀` and the value commitments alone, liquidates after the term, and sweeps the
    installments that open.
- [ ] **Step 2: Run them to see them fail.** `simplex test`. Expected: FAIL.
- [ ] **Step 3: Implement the helper.** If blinding refuses input secrets that do not open their
  inputs' commitments (rust-elements' `blind_last` or the core's `blind_pset`), stop and report:
  the combined opening then needs another way to balance, and that is the user's call.
- [ ] **Step 4: Check.** `simplex test`. Expected: pass.
- [ ] **Step 5: Commit** `contracts: the lender's final claim sweeps with the combined opening`

### Task 6: The wasm: the loan's state, installment plans and sweeps

**Files:** Create `crates/private-lending-wasm/src/loan.rs`; modify
`crates/private-lending-wasm/src/{lib,open}.rs` (the `OpenedOffer` remembers which party opened
it), `web/src/simplicity/private-lending/scripts.ts`,
`crates/contracts/tests/private_lending/parity_fixture.rs` (the fixture gains an acceptance and an
installment from regtest, with their expected values),
`web/scripts/fixtures/private-lending-parity.json`, `web/scripts/check-private-lending-parity.ts`.

**Interfaces (produces; JS names):**
- `scripts.ts`: `PrivateOfferScripts.installmentOutputScriptHash`, `activeOfferAt(debtHash:
  string): Script` and `activeSpendInfoAt(debtHash: string): StateTaprootSpendInfo`.
- `OpenedOffer.loanState(key: LendingKey, acceptanceTxHex: string, installmentTxHexes: string[]):
  LoanState`. It checks four things, failing with `loan-mismatch: …` that names the installment:
  - the acceptance's output 0 is the active collateral;
  - each installment's input 1 is the previous loan outpoint;
  - each installment's output 1 carries `collateral_after(j)` exactly;
  - each installment's output 2 carries `A`.

  The debt follows by `debt_after`, and each installment is opened for the party that opened the
  offer.
- `LoanState`:
  - getters `installmentCount: number`, `loanOutpoint: string`, `debtCommitment: string` (33-byte
    hex), `debtHash: string`, `paid: bigint` (the sum the party opened), `remaining: bigint |
    undefined` (known when every installment opened);
  - `debtHashAt(j: number): string`, the storage of loan output `j` (0 is the acceptance's);
  - `installment(j): InstallmentInfo`, with `outpoint: string` and `amount: bigint | undefined`;
  - `loanInputSecret(inputIndex: number): InputSecret` and `collateral(): PinnedOutputInfo`.
- Borrower only (otherwise `bad-input`):
  - `planInstallment(amount: bigint, firstWalletInput: string, nftReceiverScript: string):
    InstallmentPlan`, which refuses 0 and anything at or above the remaining debt;
  - `repaymentBlinding(outputIndex: number): PinnedBlinding`, which refuses a remaining debt of 0;
  - `zeroDebtKey(): string`, only when the remaining debt is 0.
- `InstallmentPlan`: `debtWitness: string`, `successorDebtHash: string`,
  `installmentBlinding(outputIndex): PinnedBlinding` (the derived key, the lender's blinding key),
  `successorBlinding(outputIndex): PinnedBlinding`, `installment: PinnedOutputInfo`.
- Lender only: `LoanState.sweep(closeTxHex: string | undefined, unspent: string[]): Sweep`.
  - `closeTxHex` is the full repayment or the zero-debt close; `undefined` (for a liquidation)
    sweeps only the installments that open.
  - `Sweep` has `outpoints(): string[]`, `amount: bigint` and `inputSecret(position: number,
    inputIndex: number): InputSecret`.

- [ ] **Step 1: Write the failing tests** (native, in `loan.rs`):
  - `borrower_rebuilds_its_plan_from_the_chain`: a plan's transaction, read back as the borrower,
    gives the same remaining amount and blinder.
  - `loan_state_refuses_a_foreign_loan_output`: an output at the loan's address with other
    commitments.
  - `loan_state_refuses_a_broken_chain`.
  - `lender_without_openings_still_knows_the_storage`: `remaining` is `undefined`, and `debtHash`
    is right.
  - `plan_refuses_zero_and_overpayment`.
  - `sweep_balances`.

  In the parity script: `scripts.activeOfferAt(state.debtHashAt(1))` equals the contract's script
  for the fixture's installment; `installmentOutputScriptHash` equals the contract's; `loanState`
  of the fixture agrees for both parties.
- [ ] **Step 2: Run them to see them fail.** `cargo test -p private-lending-wasm`. Expected: FAIL.
- [ ] **Step 3: Implement**; regenerate the fixture; `pnpm build:wasm`.
- [ ] **Step 4: Check.** `cargo test -p private-lending-wasm`, clippy, `pnpm parity`. Expected:
  pass.
- [ ] **Step 5: Commit** `wasm: the loan's state, installment plans and the lender's sweep`

### Task 7: The indexer reads installments and the zero-debt close

**Files:** Create `crates/indexer/migrations/20261118120000_private_installments.sql` (`ALTER TYPE
private_utxo_type ADD VALUE 'installment'`); modify `crates/indexer/src/models/private_offer.rs`,
`crates/indexer/src/indexer/trackers/private_offers/core.rs`,
`crates/indexer/tests/private_offers_indexing.rs`, `.sqlx/` (`cargo sqlx prepare --workspace`),
the OpenAPI schema, `web/src/api/indexer/private.ts`.

**Interfaces (produces):** `PrivateUtxoType::Installment` (`installment` in the API);
`ActiveSpend { Installment, FullRepayment, ZeroDebtClose, Liquidation }`, read as decided above.

- [ ] **Step 1: Write the failing tests.** In `core.rs`, one `classify_active_spend` test per case.
  In `private_offers_indexing.rs`:
  - `installment_keeps_the_offer_active`: the active offer moves to vout 1, and an installment is
    recorded at vout 2;
  - `zero_debt_close_is_repaid_without_a_repayment_utxo`;
  - `claimed_installment_is_spent`.
- [ ] **Step 2: Run them to see them fail.** `cargo test -p lending-indexer`, with `DATABASE_URL`
  on a scratch database (never `lending-indexer-testnet`). Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Check.** `cargo test -p lending-indexer`, clippy, `cargo sqlx prepare --workspace
  --check`, `cd web && pnpm build`. Expected: pass.
- [ ] **Step 5: Commit** `indexer: installments and the zero-debt close`

### Task 8: The borrower's flows: installment, the full repayment of the rest, the zero-debt close

**Files:** Create `web/src/privateLending/loan.ts`, `web/src/privateLending/loan.test.ts`,
`web/src/privateLending/flows/installment.ts`, `web/src/privateLending/flows/zeroDebtClose.ts`;
modify `web/src/privateLending/flows/repayment.ts`, `web/src/privateLending/finalize.ts`,
`web/src/simplicity/private-lending/{witness,layout}.ts`,
`web/scripts/e2e-private-lending.ts` (stages `repay-partial-dry` and `repay-partial`, the
borrower's part; `repay` on the loan's state).

**Interfaces:**
- Consumes: task 6's `loanState`, `planInstallment`, `repaymentBlinding`, `zeroDebtKey`,
  `loanInputSecret`, `activeOfferAt` and `activeSpendInfoAt`.
- Produces:
  - `loan.ts`:
    - `interface Loan { state: LoanState; acceptanceTxid: string; installmentTxids: string[] }`.
    - `loadLoan(deps, offer: VerifiedOffer, key: LendingKey, loanOutpoint: string):
      Promise<Loan>` walks back from `loanOutpoint` with `deps.fetchTx`: each transaction's input
      1 is the previous loan output, until the acceptance. It requires each loan output's script
      to be `offer.scripts.activeOfferAt(state.debtHashAt(j))`.
    - `principalClaimedBefore(deps, offer, nftOutpoint: string): Promise<boolean>` walks the
      borrower NFT back through installments' output 0. A principal claim's output 0 gives
      `true`; the creation's output 0, or any output but 0, gives `false`.
  - `finalizePrivateOfferInput` takes the spend info of the loan output it spends
    (`activeSpendInfoAt` of its debt hash) in place of the `active` flag.
  - `layout.ts`: `INSTALLMENT_INPUT`, `INSTALLMENT_OUTPUT`, `ZERO_DEBT_CLOSE_INPUT`,
    `ZERO_DEBT_CLOSE_OUTPUT`, as decided above.
  - `witness.ts`: the union with all six branches, and weights for `Installment` and
    `ZeroDebtClose` from the regtest witnesses of task 4 plus 10 %; task 11 replaces them with
    testnet measurements.
  - Flows:
    - `buildPrivateInstallment(deps, offer, loan, params: { amount: bigint;
      borrowerNftOutpoint: string; principalCoins; feeCoins }):
      Promise<UpdatedPset<InstallmentSummary>>`;
    - `buildPrivateRepayment(deps, offer, loan, params)` repays `loan.state.remaining` at
      `loan.state.loanOutpoint`;
    - `buildZeroDebtClose(deps, offer, loan, params: { borrowerNftOutpoint; feeCoins;
      collateralReceiver })`.

    All three refuse before building unless `principalClaimedBefore` holds (the error
    `PrincipalNotClaimedError`, generalized). Each keeps both `assertSpendLayout` checks.

- [ ] **Step 1: Write the failing tests** in `loan.test.ts`, with a fake `fetchTx` and the wasm
  loaded in Node (`web/src/test/wasm.ts`):
  - `principalClaimedBefore` holds through two installments;
  - it fails when the walk reaches the creation, and for an outpoint other than output 0;
  - `loadLoan` refuses a loan outpoint whose script is not the active offer at its debt;
  - `loadLoan` on the parity fixture's installment gives the fixture's debt hash.
- [ ] **Step 2: Run them to see them fail.** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, and the e2e stages:
  - `repay-partial-dry` builds an installment of a third of the remaining debt without sending
    it;
  - `repay-partial` pays it and then a second installment, saving both;
  - `repay` pays the rest.
- [ ] **Step 4: Check.** `pnpm test && VITE_DEBUG_MNEMONIC= pnpm build && pnpm lint && pnpm parity`;
  the e2e stages `create`, `accept`, `claim-principal`, `repay-partial` and `repay` from an empty
  state on testnet. Expected: pass, and `repay` pays `R` minus the two installments.
- [ ] **Step 5: Commit** `web: the borrower pays in installments and closes the loan`

### Task 9: The lender's flows: claims, the final sweep, liquidation

**Files:** Create `web/src/privateLending/flows/claimInstallments.ts`; modify
`web/src/privateLending/flows/{claimRepayment,liquidation}.ts`,
`web/src/simplicity/private-lending/layout.ts`, `web/scripts/e2e-private-lending.ts`.

**Interfaces:**
- Consumes: `loadLoan` (task 8); `LoanState.installment`, `sweep` (task 6).
- Produces:
  - `buildInstallmentClaim(deps, offer, loan, params: { installments: string[];
    lenderNftOutpoint: string; feeCoins }): Promise<UpdatedPset<ClaimSummary>>`: installments
    the lender opened, with the NFT back to the lender.
  - `buildFinalClaim(deps, offer, loan, params: { closeTxid: string; unspentInstallments:
    string[]; lenderNftOutpoint: string; feeCoins })`: the sweep after a full repayment or a
    zero-debt close. It replaces `buildRepaymentClaim`.
  - `buildPrivateLiquidation(deps, offer, loan, params)` takes the liquidation witness from
    `loan.state.debtHash`, the salt and the expiry, and sweeps the installments that open from
    `params.unspentInstallments`.
  - `layout.ts`: `CLAIM_INPUT = { lenderNft: 0, firstLocked: 1 }`, `CLAIM_OUTPUT = { lenderNft: 0,
    claimed: 1 }`, `LIQUIDATION_INPUT.firstInstallment = 2`, `LIQUIDATION_OUTPUT.installments = 2`.

- [ ] **Step 1: Write the failing checks** in the e2e:
  - `repay-partial` runs the lender's claim of installment 1 between the two installments;
  - `claim-repayment` uses `buildFinalClaim` and must sweep installment 2 with the repayment,
    the lender's total being `R`;
  - `liquidate-dry` builds with the new witness.
- [ ] **Step 2: Run to see them fail.** The stages, as in task 8. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Check.** `pnpm test && VITE_DEBUG_MNEMONIC= pnpm build && pnpm lint`; every e2e
  stage from an empty state. Expected: pass.
- [ ] **Step 5: Commit** `web: the lender claims installments and sweeps at the end`

### Task 10: The repay form, the borrower's loans and the lender's book

**Files:** Create `web/src/privateLending/repayPlan.ts`, `web/src/privateLending/repayPlan.test.ts`,
`web/src/privateLending/hooks/useLoan.ts`,
`web/src/components/modals/private/{ClaimInstallmentsModal,CloseZeroDebtModal}.tsx`; modify
`RepayPrivateOfferModal.tsx`, `ClaimRepaymentModal.tsx`, `LiquidatePrivateOfferModal.tsx`,
`web/src/privateLending/offerView.ts` and its test, `web/src/areas/borrow/MyLoansPage.tsx`,
`web/src/areas/lend/{LoanBookPage,bookSummary}.ts(x)` and `bookSummary.test.ts`,
`docs/docs/private-loans/guide.md`.

**Interfaces:**
- `repayPlan(input: { remaining: bigint; amountText: string; decimals: number; tipHeight:
  number; expiry: number }): RepayPlan`, with `RepayPlan = { kind: 'installment'; amount: bigint }
  | { kind: 'full'; amount: bigint } | { kind: 'refused'; message: string }`. Below the remaining
  debt is an installment; equal to it is the full repayment. Messages:
  - zero: "Enter an amount above zero";
  - above: "That is more than you owe: at most <remaining>";
  - too many decimals: "<asset> has <n> decimals";
  - an installment at or past the expiry: the message decided above.
- `useLoan(item)`: the `Loan` of an active offer for either party, by `loadLoan`, keyed by its loan
  outpoint.
- `borrowerView`:
  - the status "active, <paid> of <R> repaid, due in <n> days";
  - the action `repay`, the amount form, defaulting to the remaining debt;
  - `closeZeroDebt`, "Close the loan", when the remaining debt is 0;
  - a saved unsent installment offers only "Broadcast again" and "Discard".
- `lenderView`: "Claim" for opened unclaimed installments; "Claim repayment" after a close (the
  sweep); "Liquidate".
- The loan book gains "Repaid" (the opened sum), "Remaining" ("at most …" when an installment does
  not open) and "Claimable" (opened and unclaimed; "amount unknown" for the rest).
  `bookSummary` gains `repaid` and `claimable`.
- The repay modal shows the amount paid so far and the remaining debt, and states that
  installments are not refunded if the loan is liquidated.

- [ ] **Step 1: Write the failing tests:**
  - `repayPlan.test.ts`:
    - the remaining amount gives `full`, and one unit less gives `installment`;
    - 0, one unit more, and one decimal too many are refused;
    - past the expiry, an installment is refused and the full repayment is not.
  - `offerView.test.ts`:
    - a zero remaining debt gives `closeZeroDebt`;
    - an unsent installment gives only open and discard;
    - the lender's claimable installments give "Claim".
  - `bookSummary.test.ts`: the new sums.
- [ ] **Step 2: Run them to see them fail.** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, and the guide's repayment section in the borrower's words.
- [ ] **Step 4: Check.** `pnpm test && VITE_DEBUG_MNEMONIC= pnpm build && pnpm lint`, the docs
  build. Expected: pass.
- [ ] **Step 5: Commit** `web: installments in the repay form, My loans and the loan book`

### Task 11: Testnet weights and the demo

**Files:** Modify `web/src/simplicity/private-lending/witness.ts` (the weights),
`web/scripts/demo/demo.spec.ts`.

- [ ] **Step 1:** Replace the `Installment`, `FullRepayment`, `ZeroDebtClose` and `Liquidation`
  weights with the serialized script witness of a testnet transaction from the e2e run, plus
  10 %, citing each transaction as the existing entries do. A testnet zero-debt close needs a
  hand-built state; if none exists, keep task 8's regtest figure and say so in the comment.
- [ ] **Step 2:** The demo's borrower repays half the debt as an installment, the lender claims it,
  and the borrower repays the rest. The lender's final claim finds nothing left to sweep, and the
  loan book shows the loan repaid.
- [ ] **Step 3: Check.** `pnpm demo:testnet` (fresh indexer database at the tip; fund the wallets
  if `pnpm e2e:private wallets` reports a shortfall). Expected: pass.
- [ ] **Step 4: Commit** `web: testnet weights of the new branches, and installments in the demo`

### Task 12: Verify the phase

- [ ] **Step 1:** `cargo test --workspace` without the regtest tests; `cd crates/contracts &&
  simplex build && simplex test` (the audit file renamed aside); `cargo clippy --workspace
  --all-targets --all-features -- -D warnings`.
- [ ] **Step 2:** `cd web && pnpm test && VITE_DEBUG_MNEMONIC= pnpm build && pnpm lint && pnpm
  parity && pnpm check:config`; every e2e stage from an empty state with a fresh local indexer
  database (port 8001).
- [ ] **Step 3:** `pnpm demo:testnet` on the final tree; look at the screenshots of the repay form
  and the loan book.
- [ ] **Step 4:** The migration on a copy of the dev database (never `lending-indexer-testnet`);
  `docker --context default compose build`; the docs build. Commit `docs: v2 phase 5 verified`
  with the results.

The phase review follows (whole branch, Opus).

## Phase 6: Private messages (spec item 6)

Branch `v2/phase-6-messages`, from `v2/main` after phase 5 was merged into it (`0f8dd34`).

Decided at phase start (2026-11-21):
- **The Jade is not involved.** Messages are signed by the sender's lending key, which the browser
  derives from the wallet descriptor's master blinding key for seed and Jade wallets alike. LWK's
  software signer at `7f8c8213` cannot sign with `SIGHASH_RANGEPROOF`, so the signatures are
  needed; a Jade that could would not remove them.
- **Sender recovery** (the user, 2026-11-21: keep as proposed). The creation's and each
  installment's range proofs open from the sender's seed (their nonces derive), so those messages
  reread on any device. The acceptance's and the full repayment's nonces stay random: their
  senders reread them only from this browser, where the app keeps every message it sends,
  per lending key, in IndexedDB. A message sent from another browser shows as "Sent from another
  browser".
- **Channels** *(my call where the spec leaves a choice)*: creation, inside the terms (pending
  collateral, output 3, borrower → lender); acceptance, the principal output only (output 1,
  lender → borrower); installment, the installment output (output 2, borrower → lender); full
  repayment, the repayment output (output 1, borrower → lender). The zero-debt close, claims,
  cancellation and liquidation have none.
- **Encoding.** The message field: version `1` (1) ‖ kind (1; `1` = UTF-8 text, the only kind) ‖
  length (2, big-endian) ‖ the text's bytes. A missing message is the single byte `0` in the
  terms, and no extra data at all (zeros) in the other range proofs. The text is non-empty valid
  UTF-8; the reader refuses anything else as unreadable.
- **Terms version 2.** `version 2 ‖ length ‖ the v1 fields ‖ borrower key ‖ message field ‖
  signature`, the message field inside the signed prefix, so the terms' signature covers it. The
  tag stays `simplicity-lending/private/v1/offer`. Only version 2 decodes (no migration).
- **Signed messages** (acceptance, installment, full repayment): the range proof's extra data is
  `message field ‖ BIP340 signature (64)` by the sender's lending key over
  `tagged_hash("simplicity-lending/private/v2/message", phase ‖ offer id ‖ message field)`, the
  offer id the creation txid in internal byte order. *(My call:)* the phase is `0x01`
  (acceptance), `0x02 ‖ j_be32` (the `j`-th installment, from 1) or `0x03` (full repayment), so
  the other party, who knows the blinders and can remake a proof, cannot move a signed message to
  another installment unnoticed. A bad or missing signature shows the message as unverified.
- **Limits**, from the 3136 bytes of extra data: 3068 text bytes for a signed message (3136 − 4 −
  64), 2915 at creation (3136 − 221: the terms' 153 signed bytes, the field's 4 and the 64 of the
  signature).
- **Display.** Plain text, `white-space: pre-wrap`; C0 and C1 controls except the newline, and
  the bidirectional controls U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069, are removed;
  no link is made clickable. Every message shows "A message is not part of the terms, and the
  contract does not enforce it." with the sender's directory name (verified entries only) and key
  fingerprint.
- **Carried from phase 5's review:** tasks 1 and 2.

### Phase 6 review focus

1. A message crafted outside the app: over-long length field, invalid UTF-8, an unknown version
   or kind, bidirectional overrides. Expected: it reads as unreadable or is shown cleaned, never
   breaks the row or the timeline. Tasks 3 and 5 test it.
2. A signed message moved by the counterparty to another installment, another phase or another
   offer. Expected: shown as unverified. Task 3 tests it.
3. Outputs with and without a message, and with the longest one: the same range-proof size, so
   the chain does not tell them apart. Task 3 tests it.
4. A text at the limit and one byte over, counted in UTF-8 bytes (an emoji is 4): the form refuses
   the over-long one before building, with the byte counter; the limit one builds and reads back.
   Tasks 5 and 6 test it.
5. A sender on another browser: the acceptance or full repayment they sent shows as "Sent from
   another browser", not as missing or as an error. Task 7 tests it.

### Task 1: Carried from phase 5's review, in the web app

**Files:** Modify `web/src/privateLending/hooks/useLoan.ts`, `web/src/privateLending/offerView.ts`,
`web/src/areas/borrow/MyLoansPage.tsx`, `web/src/components/modals/private/{LiquidatePrivateOfferModal,RepayPrivateOfferModal,CloseZeroDebtModal}.tsx`,
`web/src/privateLending/flows/installment.ts`, `web/src/privateLending/loan.ts`,
`web/src/providers/pendingTransactions/PendingTransactionsProvider.tsx`,
`web/src/privateLending/repayPlan.ts`; tests in `offerView.test.ts`, `repayPlan.test.ts`,
`loan.test.ts`. Create `web/src/privateLending/borrowerErrors.ts` and its test.

**Interfaces (produces):**
- `borrowerErrorText(error: unknown): string` maps `PrincipalNotClaimedError` and wasm
  `loan-mismatch:` messages to plain sentences without "NFT", "offer" or codes; other errors pass
  through as their message.
- `isPastExpiry` keeps its name; the borrower's term-ended note and the form share
  `!installmentTermOpen(tip, expiry)` (`tip ≥ expiry`).
- `buildPrivateInstallment` throws `InstallmentAfterTermError` when `params.tipHeight ≥ expiry`;
  `InstallmentParams` gains `tipHeight: number`.
- `staleInstallmentRecords(records, loanOutpointSpent: (outpoint: string) => boolean):
  PrivateTxRecord[]` in `repayPlan.ts`: the discarded or failed installments whose loan output
  is spent on chain, which the provider then removes.

- [ ] **Step 1: Write the failing tests**:
  - `borrowerErrors.test.ts`: a `PrincipalNotClaimedError` reads "Receive the loan first: …";
    `loan-mismatch: …` reads "This payment does not belong to your loan. Refresh the page and try
    again."; neither contains `NFT`, `offer` or a `code:` prefix.
  - `offerView.test.ts`: at `tip = expiry` the borrower's note says the term has ended
    (it said nothing before).
  - `loan.test.ts`: `buildPrivateInstallment` at `tipHeight = expiry` throws
    `InstallmentAfterTermError` before any fetch (the fake chain records no `fetchTx`).
  - `repayPlan.test.ts`: `staleInstallmentRecords` keeps a failed record whose loan output is
    unspent and returns one whose loan output is spent.
- [ ] **Step 2: Run them to see them fail.** `cd web && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, and also:
  - `useLoan`: while the query is in error, retry every 30 s (`refetchInterval` only in error;
    `staleTime: Infinity` otherwise), so a transient esplora error does not hide Claim for good.
  - `LiquidatePrivateOfferModal`: check `tip < expiry` and show the "not yet" message before
    `loadLoan`.
  - The repay and close modals show `borrowerErrorText(error)`.
  - `RepayPrivateOfferModal` reads the saved records again from IndexedDB at build time for the
    trace (`loadPrivateTxsForWallet`), and refuses an installment ("Saved payments could
    not be read; reload the page") if that read fails, instead of trusting the tab's list.
  - The provider drops `staleInstallmentRecords` once a day on the existing sweep, asking esplora
    for the loan outpoint's spend.
- [ ] **Step 4: Check.** `pnpm test && pnpm lint && VITE_DEBUG_MNEMONIC= pnpm build`. Expected:
  pass.
- [ ] **Step 5: Commit** `web: phase 5's review minors`

### Task 2: Carried from phase 5's review: witness vectors, the wasm's own anchoring, the read-back's nonce

**Files:** Modify `crates/contracts/tests/private_lending/parity_fixture.rs`,
`web/scripts/fixtures/private-lending-parity.json` (regenerated),
`web/scripts/check-private-lending-parity.ts`, `web/src/simplicity/private-lending/witness.test.ts`,
`crates/private-lending-wasm/src/{loan,open}.rs`, `web/src/privateLending/flows/installment.ts`,
`web/src/privateLending/loan.test.ts`.

**Interfaces (produces):**
- The fixture's `witness_vectors` gains `installment` (with `debt` as `(bool, u256)` hex) and
  `zero_debt_close` (`debt`, `k`), built as `full_repayment` is.
- `OpenedOffer` (wasm) keeps the creation txid; `loanState` refuses with `loan-mismatch` an
  acceptance whose input 0 is not `<creation txid>:3`.
- `InstallmentPlan.ephemeralPublicKey: string` (33-byte hex); the builder requires output 2's
  `ecdhPubkey` in the blinded PSET to equal it, before the read-back.

- [ ] **Step 1: Write the failing tests:** `checkWitnessVectors` checks `installment` and
  `zero_debt_close` byte for byte against `buildPrivateLendingWitness`; in `loan.rs`,
  `loan_state_refuses_an_acceptance_of_another_creation`; in `loan.test.ts`, a blinded PSET whose
  output 2 nonce is replaced is refused with "does not read back as built".
- [ ] **Step 2: Run them to see them fail.** `cargo test -p private-lending-wasm`; `cd web &&
  pnpm parity && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate the fixture: rename
  `crates/contracts/tests/lending_security_audit.rs` aside, `cd crates/contracts && simplex build
  && WRITE_PARITY_FIXTURE=1 simplex test write_private_lending_parity_fixture`, rename it back;
  then `cd web && pnpm build:wasm`.
- [ ] **Step 4: Check.** `simplex test parity_fixture_verifies_against_the_contract`;
  `cargo test -p private-lending-wasm -p private-lending-core`; `cd web && pnpm parity && pnpm
  test`. Expected: pass.
- [ ] **Step 5: Commit** `contracts, wasm, web: the installment and zero-debt close vectors, and two
  read-back checks`

### Task 3: Messages in the core (**Review now**: a signature that does not bind the phase lets the counterparty move a message; a size that differs shows on chain who wrote one)

**Files:** Create `crates/private-lending-core/src/message.rs`; modify
`crates/private-lending-core/src/{terms,offer,creation,blind,lib}.rs`, and every
`NewOffer::build` caller: `crates/contracts/tests/private_lending/{setup,offer_creation_flows}.rs`,
`crates/indexer/tests/common/mod.rs`, `crates/private-lending-wasm/src/build.rs`.

**Interfaces (produces):**
- `pub const MESSAGE_ROOM: usize = 3136; pub const MAX_SIGNED_MESSAGE_BYTES: usize = 3068; pub
  const MAX_CREATION_MESSAGE_BYTES: usize = 2915;`
- `pub struct Message` (kind and text); `Message::text(text: &str) -> Result<Message,
  MessageError>` (refuses empty); `Message::as_text(&self) -> &str`.
- `pub enum MessagePhase { Acceptance, Installment(u32), FullRepayment }`.
- `pub struct SignedMessage { pub message: Message, pub signature: schnorr::Signature }`;
  `SignedMessage::sign(message: Message, sender: &LendingKey, phase: MessagePhase, offer_id:
  &Txid) -> Result<SignedMessage, MessageError>` (`TooLong` past 3068 bytes); `verify(&self,
  sender: &XOnlyPublicKey, phase: MessagePhase, offer_id: &Txid) -> Result<(), MessageError>`;
  `encode(&self) -> Vec<u8>`; `SignedMessage::decode(extra_data: &[u8]) ->
  Result<Option<SignedMessage>, MessageError>` (`None` when the first byte is 0).
- `pub enum MessageError { Empty, TooLong { length: usize, max: usize }, UnknownVersion(u8),
  UnknownKind(u8), BadLength, NotUtf8, BadSignature, Malformed }`, with `Display`.
- `SignedTerms { terms, borrower, message: Option<Message>, signature }`; `TERMS_VERSION = 2`;
  `SignedTerms::sign(terms, message: Option<Message>, borrower, lender, first_input)`.
- `NewOffer::build(…, terms: OfferTerms, message: Option<Message>) -> Result<NewOffer,
  OfferError>`; `OfferError::MessageTooLong`. Callers that have no message pass `None`.

- [ ] **Step 1: Write the failing tests** in `message.rs` and `terms.rs`:
  - `message_field_round_trip_with_zero_padding` (text with a newline, an emoji and Cyrillic).
  - `signed_message_known_answer`: a frozen digest for a fixed key, offer id (bytes 0x00..=0x1f),
    `Installment(2)` and text `"hello"`, so a change of tag, phase bytes or order fails.
  - `signature_binds_phase_offer_and_installment`: the same signed message fails `verify` under
    `Acceptance` vs `FullRepayment`, `Installment(1)` vs `Installment(2)`, and another offer id.
  - `decode_refuses_crafted_fields`: an unknown version, an unknown kind, a length past the
    buffer, invalid UTF-8 and an empty text each give their `MessageError`.
  - `longest_messages_fit`: 3068 text bytes signed and 2915 at creation encode within 3136
    bytes; one byte more is `TooLong`.
  - `terms_v2_round_trip_with_and_without_a_message` and `terms_signature_covers_the_message`
    (changing one text byte gives `BadSignature`); `version_1_terms_are_refused`. Update
    `encoding_follows_the_v1_layout` into `encoding_follows_the_v2_layout` and the frozen
    `signing_digest_known_answer`.
  - In `blind.rs`: `range_proof_size_does_not_show_a_message`: the range proofs of the same
    pinned output with no extra data, a short signed message and the longest one serialize to the
    same length, and each rewinds to its message.
- [ ] **Step 2: Run them to see them fail.** `cargo test -p private-lending-core`. Expected: FAIL.
- [ ] **Step 3: Implement** in `message.rs`, the terms and `NewOffer::build`; pass `None` at every
  other caller.
- [ ] **Step 4: Check.** `cargo test -p private-lending-core -p private-lending-wasm -p
  lending-indexer` (the indexer's sqlx tests on a scratch database); `cd crates/contracts &&
  simplex build && simplex test` (audit file aside); `cargo clippy --workspace --all-targets
  --all-features -- -D warnings`. Expected: pass.
- [ ] **Step 5: Commit** `core: private messages, and the terms carry the creation's (version 2)`

### Task 4: Messages in the wasm, the fixture and the parity check

**Files:** Modify `crates/private-lending-wasm/src/{build,blind,open,loan,lib}.rs`, its README;
`crates/contracts/tests/private_lending/{setup,parity_fixture}.rs` (the fixture's offer carries a
creation message, its acceptance and installment carry signed ones);
`web/scripts/fixtures/private-lending-parity.json` (regenerated);
`web/scripts/check-private-lending-parity.ts`.

**Interfaces (produces):**
- `enum MessagePhase { Acceptance, Installment, FullRepayment }` (wasm enum).
- `signMessage(sender: LendingKey, creationTxid: string, phase: MessagePhase, installment:
  number, text: string): SignedMessage` (`installment` is ignored but for `Installment`, and must
  be at least 1 there); `bad-input` for an empty or over-long text, with the byte count and the
  limit in the message.
- `NewOffer.build(…, terms, message?: string)`.
- `OpenedOffer.message(): string | undefined`: the creation's text, covered by the terms'
  signature already checked when opening.
- `OpenedOffer.pinnedBlinding(role, outputIndex, message?: SignedMessage)`: a message only with
  `Principal`, and it must be signed for `Acceptance` of this offer, else `bad-input`.
- `LoanState.planInstallment(amount, firstWalletInput, receiverScript, message?: SignedMessage)`:
  the message must be signed for `Installment(installmentCount + 1)` of this offer.
  `LoanState.repaymentBlinding(outputIndex, message?: SignedMessage)`: signed for
  `FullRepayment`.
- `class ReadMessage { text: string; verified: boolean }`.
- `InstallmentInfo.message: ReadMessage | undefined`, read in the same rewind that opens the
  amount, for both parties, verified against the borrower's key.
- `OpenedOffer.readMessage(key: LendingKey, creationTxid: string, txHex: string, outputIndex:
  number, phase: MessagePhase): ReadMessage | undefined`: rewinds the output with `key` and its
  nonce, and verifies against the counterparty's key (the lender's for `Acceptance`, the
  borrower's otherwise). `undefined` when it does not rewind or carries no message; an unreadable
  field throws `bad-input`.

- [ ] **Step 1: Write the failing tests** in `loan.rs` and `open.rs`:
  `acceptance_message_reads_for_the_borrower_only`, `installment_message_reads_for_both_parties`,
  `repayment_message_reads_for_the_lender`, `a_message_for_another_installment_is_refused_at_plan`,
  `a_moved_message_reads_as_unverified` (an installment whose extra data carries the signed message
  of installment 1, built by hand with the core). In the parity script: the borrower and the
  lender read the fixture's creation, acceptance and installment messages as the Rust test wrote
  them, verified.
- [ ] **Step 2: Run them to see them fail.** `cargo test -p private-lending-wasm`; `cd web &&
  pnpm parity`. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate the fixture as in task 2, then `pnpm build:wasm`.
- [ ] **Step 4: Check.** `cargo test -p private-lending-wasm`; `simplex test` (audit file aside);
  `cd web && pnpm parity && pnpm test`. Expected: pass.
- [ ] **Step 5: Commit** `wasm: sign, carry and read private messages`

### Task 5: The web's message rules and the sent-message store

**Files:** Create `web/src/privateLending/messages.ts`, `messages.test.ts`,
`web/src/privateLending/sentMessages.ts`, `sentMessages.test.ts`.

**Interfaces (produces):**
- `MESSAGE_LIMITS = { creation: 2915, signed: 3068 } as const`; `type MessageChannel = keyof
  typeof MESSAGE_LIMITS`.
- `messageBytes(text: string): number` (UTF-8 length); `messageError(text: string, channel:
  MessageChannel): string | null` ("The message is N bytes; at most M fit." or null; an empty or
  blank text is no message, not an error).
- `displayMessage(text: string): string` removes the characters listed under "Display" and keeps
  newlines.
- `MESSAGE_NOTE = 'A message is not part of the terms, and the contract does not enforce it.'`
- `interface SentMessage { offerTxid: string; txid: string; phase: 'acceptance' | 'installment' |
  'repayment'; installment?: number; text: string; savedAt: number }`;
  `kvSentMessages(kv: ScanKv, scope: ScanScope, fingerprint: string): { save(message:
  SentMessage): void; forOffer(offerTxid: string): SentMessage[] }`, stored under the key
  `JSON.stringify(['sent', network, fingerprint])` in the scan database, zod-checked; a value
  that does not decode reads as none.

- [ ] **Step 1: Write the failing tests:** `messageBytes('€')` is 3 and an emoji is 4; at the
  limits, 2915 bytes pass for `creation` and 2916 fail, 3068 and 3069 for `signed`;
  `displayMessage` removes U+202E, U+2066, U+200F, NUL, ESC and U+0085 but keeps `\n` and
  Cyrillic; `kvSentMessages` round-trips two messages of one offer and none of another, keeps
  fingerprints apart, and reads a corrupt value as none (the `scanStore.test.ts` pattern).
- [ ] **Step 2: Run them to see them fail.** `cd web && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** In a test, check `MESSAGE_LIMITS` against `wasm.signMessage`'s
  refusal at limit + 1.
- [ ] **Step 4: Check.** `pnpm test && pnpm lint`. Expected: pass.
- [ ] **Step 5: Commit** `web: the message rules and the store of sent messages`

### Task 6: Sending messages: the proposal, the acceptance, the installment and the full repayment

**Files:** Modify `web/src/privateLending/flows/{creation,acceptance,installment,repayment}.ts`,
`web/src/areas/borrow/ProposalPage.tsx`, `web/src/areas/borrow/proposalForm.ts`,
`web/src/components/modals/private/{CreatePrivateOfferModal,AcceptPrivateOfferModal,RepayPrivateOfferModal}.tsx`;
create `web/src/components/MessageField.tsx`. Tests in `proposalForm.test.ts`, `loan.test.ts`.

**Interfaces:**
- Consumes: tasks 4 and 5.
- Produces: the four flows' params gain `message?: string`. The creation passes it to
  `NewOffer.build`; the acceptance, the installment and the full repayment sign it with
  `signMessage` and the sender's key, so the acceptance and the full repayment params gain
  `lendingKey: LendingKey` as the installment's has. `MessageField({ channel, value, onChange
  })`: a textarea labelled
  "Private message (optional)", the counter "N / M bytes", and the error from `messageError`.
- The modals save `SentMessage` with the transaction's txid when they save the transaction
  record (before the first broadcast).

- [ ] **Step 1: Write the failing tests:** `proposalForm` refuses a 2916-byte message with the
  counter's error; in `loan.test.ts`, `buildPrivateInstallment` with a message signs it for
  installment `installmentCount + 1` (spy on `wasm.signMessage`) and with an over-long one throws
  before any fetch.
- [ ] **Step 2: Run them to see them fail.** `cd web && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** The acceptance signs for `Acceptance` with the lender's key and
  passes it to `pinnedBlinding(Principal, …)`; the full repayment signs for `FullRepayment`. The
  read-back of task 2 also requires the installment's message to read back verified.
- [ ] **Step 4: Check.** `pnpm test && pnpm lint && VITE_DEBUG_MNEMONIC= pnpm build && pnpm
  parity`. Expected: pass.
- [ ] **Step 5: Commit** `web: the forms send private messages`

### Task 7: Reading messages: the proposal review and the loan's timeline

**Files:** Create `web/src/privateLending/loanMessages.ts`, `loanMessages.test.ts`,
`web/src/privateLending/hooks/useLoanMessages.ts`, `web/src/components/MessageTimeline.tsx`,
`web/src/components/modals/private/LoanMessagesModal.tsx`; modify
`web/src/components/modals/private/AcceptPrivateOfferModal.tsx`,
`web/src/areas/lend/LoanBookPage.tsx`, `web/src/areas/borrow/MyLoansPage.tsx`.

**Interfaces:**
- `interface LoanMessage { phase: 'creation' | 'acceptance' | 'installment' | 'repayment';
  installment?: number; from: 'borrower' | 'lender'; txid: string; state: 'verified' |
  'unverified' | 'unreadable' | 'elsewhere'; text?: string }` (`elsewhere`: sent by this wallet
  from another browser).
- `collectLoanMessages(input: { role: 'lender' | 'borrower'; offerTxid: string; creation?:
  string; acceptance?: { txid: string; read?: ReadMessage | 'unreadable' }; installments: { txid:
  string; j: number; read?: ReadMessage | 'unreadable' }[]; repayment?: { txid: string; read?:
  ReadMessage | 'unreadable' }; sent: SentMessage[] }): LoanMessage[]`, in chain order; for a
  phase this wallet sent and cannot read from the chain, the text comes from `sent`, else
  `elsewhere`.
- `useLoanMessages(item: OpenedOfferItem): { messages: LoanMessage[]; isLoading: boolean }`,
  reading the acceptance from `useLoan`'s hex, the installments from `LoanState.installment(j)
  .message`, and the full repayment's transaction (from the candidate's repayment UTXO) with
  `readMessage`.
- `MessageTimeline({ messages, names })`: one entry per message with the sender's name and
  `KeyFingerprint`, the phase ("Proposal", "Acceptance", "Installment 2", "Full repayment"), the
  text through `displayMessage` in a `whitespace-pre-wrap` block, an "Unverified" badge, and
  `MESSAGE_NOTE` once.

- [ ] **Step 1: Write the failing tests** in `loanMessages.test.ts`: the lender's view orders
  creation, acceptance (from `sent`), installment 1 (verified), full repayment; the borrower's
  view reads the lender's acceptance from the chain and, with no `sent`, shows its own full
  repayment as `elsewhere`; an unverified installment keeps its text with the
  state `unverified`; a crafted unreadable field is `unreadable` without text.
- [ ] **Step 2: Run them to see them fail.** `cd web && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** The proposal review shows the creation message above the terms with
  the note. The loan book and My loans rows get a "Messages (n)" link (shown when n > 0) that
  opens `LoanMessagesModal`. Directory names come from verified entries only (`lookup`).
- [ ] **Step 4: Check.** `pnpm test && pnpm lint && VITE_DEBUG_MNEMONIC= pnpm build`. Expected:
  pass.
- [ ] **Step 5: Commit** `web: the proposal review and the loans show their messages`

### Task 8: The e2e stages, the demo and the docs

**Files:** Modify `web/scripts/e2e-private-lending.ts`, `web/scripts/demo/demo.spec.ts`,
`web/README.md`, `docs/docs/private-loans/{guide,protocol}.md`,
`crates/private-lending-wasm/README.md`.

- [ ] **Step 1: E2E.** `create` sends a creation message with Cyrillic and an emoji, and the
  lender's `openCreationAsLender` reads it back; `accept` sends one the borrower reads from the
  chain (`readMessage`); `repay-partial` sends one per installment, which both parties read
  verified from `loanState`; `repay` sends one the lender reads from the repayment transaction.
  `create-dry` builds once with a 2915-byte message and once with none and checks the two output
  3 range proofs have the same length.
- [ ] **Step 2: Demo.** The borrower's proposal carries a message; the lender sees it in the
  review and answers in the acceptance; the borrower's My loans timeline shows both. Screenshots
  `lend-review-message`, `borrow-messages`.
- [ ] **Step 3: Docs.** The guide: the message fields, who can read what, "Sent from another
  browser", the note. `protocol.md`: the channels, the encoding, the signature and phase bytes,
  terms version 2, the limits. The READMEs: the new stages' checks and the wasm API.
- [ ] **Step 4: Check.** The e2e stages above on testnet from an empty state with a fresh indexer
  database; `pnpm demo:testnet`; the docs build. Expected: pass.
- [ ] **Step 5: Commit** `web, docs: messages in the e2e, the demo and the guide`

### Task 9: Verify the phase

- [ ] **Step 1:** `cargo test --workspace` without the regtest tests; `cd crates/contracts &&
  simplex build && simplex test` (the audit file renamed aside); `cargo clippy --workspace
  --all-targets --all-features -- -D warnings`; `cargo fmt --check`; `cargo sqlx prepare
  --workspace --check -- --all-targets`.
- [ ] **Step 2:** `cd web && pnpm test && VITE_DEBUG_MNEMONIC= pnpm build && pnpm lint && pnpm
  parity && pnpm check:config`; every e2e stage from an empty state with a fresh local indexer
  database.
- [ ] **Step 3:** `pnpm demo:testnet` on the final tree; look at the screenshots of the review and
  the timeline, at 375 px and 1280 px.
- [ ] **Step 4:** `docker compose build` (still open from phase 5) where the disk allows; the docs
  build. Commit `docs: v2 phase 6 verified` with the results.

The phase review follows (whole branch, Opus).

## Phase 7: Proportional collateral release (spec item 3b) — postponed

**Postponed on 2026-11-14:** the demo repays in installments without releasing collateral
(phase 5's item 3(a)). This phase starts only when the user brings it back; v2's final checks run
after phase 6. The notes below stay for that day.

Branch `v2/phase-7-proportional-release`.

- **Gate first: a throwaway research spike.** Can a BP++ verifier check the release
  `floor((paid + p)·C/R) − floor(paid·C/R)` in Simplicity, within the transaction's cost budget,
  with the commitments taken from the transaction? The spike ends with a note in the spec giving
  the circuit, the cost and the jets it needs. If it is not feasible, stop and bring the note to
  the user before writing any task.
- If feasible: a second contract revision (no migration), the prover in `private-lending-core`,
  the wasm bindings, the flow and the UI that shows the released collateral.
- **Done when:** the releases add up exactly (128-bit arithmetic), phase 5's liveness test is
  extended to releases, and `pnpm parity` and the e2e stages pass.

---

## Final manual checks (deferred from task 1.5)

Run by the user once phase 6 is merged into `v2/main`, in `pnpm dev` on testnet, before `v2` is
proposed for `main`. Each check names the screen of the app as phase 4 leaves it.

1. **Fee errors stay readable** (task 1.5 step 4). From a seed wallet holding collateral but too
   little L-BTC for the fee, submit a proposal in the borrower app. Expected: the modal names the
   missing L-BTC, not a stack trace.
2. **A Jade signs the `'none'` PSETs** (task 1.5 step 5). With a Jade, submit a proposal and
   cancel it; then, as the lender with a Jade, accept one and make a partial repayment as the
   borrower. Expected: the Jade shows the outputs and signs each; every transaction confirms.
3. **A wallet switch during a scan** (task 1.5 step 6). Connect seed wallet A and wait until it
   is ready; throttle the network, leave the tab and come back after 15 s to start a scan; while
   it runs, disconnect A and connect seed wallet B. Expected: B's lending-key fingerprint, B's
   loans and proposals only, no error toast from A's scan. Optionally, with a Jade, unplug it
   during "Connecting…" after the PIN with `/v1/server_recipient` throttled, replug and connect
   again: the connect works, and a reload does not resume the unplugged session.
4. **A Jade signs the final claim that sweeps** (phase 5). As the borrower, pay an installment
   and then the rest; as the lender with a Jade, leave the installment unclaimed and claim the
   repayment in the console. Expected: the Jade shows the outputs and signs; the claim confirms
   with the installment swept into it, and the loan book shows the loan repaid with nothing left
   to claim.

Record the results in the commit that ticks them off.
