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

Branch `v2/phase-5-contract`.

- **Gate at phase start:** a design note (in the spec) for the contract change: item 1's
  parameter `H(salt ‖ expiry)` with the salt derived from the offer's shared secret and the
  expiry and salt in the liquidation witness, placed in the pruned subtree of the time check;
  item 3(a)'s debt point `D = d·A + r·G` in storage, the installment branch `D' = D − V_p`, the
  pinned asset commitment `A` for every repayment output, the close by a BIP340 signature under
  `D_final`, the point-at-infinity case, and liquidation that ignores the debt (item 3's lessons).
  A derived salt leaves the terms encoding as it is.
- Files: `crates/contracts/simf/private_lending.simf` and its program in
  `crates/contracts/src/programs/private_lending/`; `private-lending-core` (offer parameters,
  pinned outputs, secrets); the wasm; the web Simplicity bindings, the flows (a new
  `flows/partialRepayment.ts`) and the repay UI; the parity fixtures and the e2e stages.
- **Carried from phase 2:** the header comment of `private_lending.simf` still points at the
  deleted `lending.simf`; rewrite it with the revision (editing the source changes the program
  id, so phase 2 left it). Remove the dead features `lending` and `pre_lock` from
  `crates/contracts/Cargo.toml`.
- **Done when:** contract tests show, for item 1, that with the expiry fixed a different salt
  changes the CMR revealed at acceptance and repayment (the salt enters the pruned subtree), that
  recomputing that CMR from the public parameters over a range of candidate expiries, with no
  salt or a guessed one, matches none of them, and that a liquidation witness with a wrong salt or
  expiry fails; for item 3(a), a liveness property test runs random installment sequences,
  and after each one the full repayment and the liquidation after the term still succeed; an
  overpayment is refused in the client; `pnpm parity` and every e2e stage pass, including a new
  `repay-partial` stage.

## Phase 6: Private messages (spec item 6)

Branch `v2/phase-6-messages`.

- Known fact: LWK's software signer at `7f8c8213` signs only the default sighash unless its
  policy allows another, and nothing in `lwk_signer` handles `SIGHASH_RANGEPROOF`; so item 6's
  message signatures are needed. Check the Jade's behaviour at phase start.
- *(Proposed, confirm at phase start:)* senders do not reread their acceptance or repayment
  messages on another device in v2; the browser caches them per lending key, and the creation
  message stays rereadable through the deterministic ephemeral key.
- Core: the message field (length-prefixed, versioned, a type byte, UTF-8 text first) in the
  terms encoding at creation, under a new terms version, and in the range proofs of the
  acceptance and repayment outputs (`blind.rs`'s `extra_data`); signatures over
  `tagged_hash("simplicity-lending/private/v2/message", phase ‖ offer id ‖ message)`.
- Web: the fields in phase 4's forms with a byte counter; the received messages as a timeline in
  the console's loan view and the borrower's My loans, shown as plain text with control and
  bidirectional characters removed and the note that a message is not part of the terms.
- **Done when:** core tests cover the encoding round trip, the longest message that fits, a bad
  or missing signature (shown as unverified) and outputs of equal size with and without a
  message; `pnpm parity` and the e2e stages pass with messages at creation, acceptance and
  repayment.

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

Record the results in the commit that ticks them off.
