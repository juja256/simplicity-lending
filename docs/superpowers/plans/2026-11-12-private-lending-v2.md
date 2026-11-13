# Private lending v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the app into a private-lending-only demo for institutional lenders (published lender
terms, a lender console and a borrower app) on upstream LWK, then add v2's contract and privacy
changes: fresh addresses, the hidden expiry, partial repayment and private messages.

**Architecture:** Seven phases, run in order, each on its own branch and closed by one review.
Phase 1 is broken into tasks here. Phases 2 to 7 give their scope, files, done-when checks and
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

- v2 covers items 1, 2, 3 (a and b), 6, 7, 8, 9 and 10. Item 5 comes after v2. Item 4 needs no
  work beyond keeping acceptance hidden after expiry.
- No migration: the app knows only the v2 contract, and v1 testnet loans are dropped.
- One branch per phase, `v2/phase-<n>-<name>`, from `main`; one commit per task; pushes go to the
  `fork` remote only; the user decides when a phase merges into `main`.
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

Steps 4 to 6 are the user's: they need the running app, a Jade and two wallets. The controller
stops here and asks the user to run them, and does not mark them done itself.

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

Branch `v2/phase-2-private-only`, after phase 1 is merged into `main`.

- **Tag first.** `git tag -a public-lending-last <phase 1 merge commit on main>`, then push the
  tag to `fork` once the user confirms. `git checkout public-lending-last` brings back the public
  demo. From here on, upstream changes are ported by hand.
- **One task per layer**, each leaving the workspace building and `pnpm parity` passing:
  1. Web: delete `web/src/pages/{Borrow,Supply,Dashboard}`, their routes in `web/src/App.tsx`,
     and `web/src/simplicity/{lending,asset-auth-vault,issuance-factory}`. Then repeatedly delete
     the modules no longer imported (`npx -y knip --include files`) until none are left: the
     public hooks in `web/src/hooks/` and their components. Keep `PrivateLoansCard`'s content for
     phase 4.
  2. Indexer: delete the public trackers (`offers`, `offers_creation`, `factories`,
     `factory_creation`), API modules and OpenAPI schemas, and add a migration that drops
     `factories`, `factory_utxos`, `factory_auths`, `offers`, `offer_utxos` and
     `offer_participants`. `sync_state`, `private_offers`, `private_offer_utxos`,
     `directory_entries` and `directory_challenges` stay; check that the API modules `borrowers`
     and `lenders` serve only public data before deleting them.
  3. Contracts: delete `lending.simf`, `asset_auth_vault.simf`, `issuance_factory.simf`, their
     programs in `crates/contracts/src/programs/` and artifacts, and their tests. The untracked
     `crates/contracts/tests/lending_security_audit.rs` is the user's: ask before deleting it.
  4. CLI: remove `crates/cli` from the workspace and from `deployment/`, `docker-compose.yml` and
     `gitlab/`.
  5. Docs site: delete `docs/docs/{borrower,lender,protocol,schemas}` and the removed contracts'
     pages in `docs/docs/contracts`; update `docs/sidebars.ts` and `docs/docs/intro.md`.
  6. Item 2: every private-flow receive (NFT receivers, principal, repayment claims, collateral
     returns) uses a fresh address (`wollet.address(null)`), and `getReceiveAddress` too.
- **Done when:** `cargo test --workspace`, `pnpm build`, `pnpm lint`, `pnpm parity`, the
  docs build and every e2e stage pass; the migration, run on a copy of the testnet database,
  leaves the private tables' row counts unchanged;
  `git grep -nE "lending\.simf|issuance_factory|asset_auth_vault|wollet\.address\(0\)"` finds
  nothing outside `docs/security/` and `docs/superpowers/`; two e2e creations from one wallet
  receive their NFTs at different addresses.

## Phase 3: Lender terms in the directory (spec item 9)

Branch `v2/phase-3-lender-terms`.

- **Decide at phase start** (bring to the user if unsure): the reference price as an integer,
  proposed as principal base units per 10^8 collateral base units, using the assets' registry
  precision; and whether a lender may publish several asset pairs in the demo UI (the data allows
  a list either way).
- `private-lending-core`: a new module `lender_terms.rs` with `LenderTerms` (principal and
  collateral asset, minimum APR in bps, reference price, minimum collateral ratio in bps, term
  range in days, principal range), its versioned encoding, and the arithmetic of item 9: APR from
  principal, repayment and `days = (expiry height − creation height) / 1440`; the collateral
  ratio at the reference price; the minimum collateral and minimum repayment for given terms,
  both rounded up; and `check_proposal`, which returns each term a proposal breaks.
  `directory.rs` signs the name and the terms together under a new message version.
- `private-lending-wasm`: bindings for all of the above.
- Indexer: a migration adding the terms and their publication time to `directory_entries`; the
  put endpoint verifies the new signature and requires terms; the list returns them.
- Web: `privateLending/directory.ts` and `hooks/useDirectory.ts` publish and read terms.
- **Done when:** core unit tests cover the arithmetic at its edges (zero-day term, principal 0,
  the rounding direction, an overflow at `u64::MAX`), `check_proposal` names every broken term,
  and a replayed or stale-challenge put is refused; `pnpm parity` checks that TS (through the
  wasm) and Rust agree on the APR and ratio of the parity fixtures; a new e2e stage `directory`
  publishes the lender's terms and reads them back as the borrower.

## Phase 4: The lender console and the borrower app (spec item 10; the demo)

Branch `v2/phase-4-two-areas`.

- Load the `frontend-design` skill at phase start. The wireframes from the discussion are in
  `docs/superpowers/specs/2026-11-12-v2-wireframes/` (`site-structure.html`,
  `lender-console.html`, `borrower-app.html`; layout only, the numbers are made up).
- Routes: `/` the landing page with its two entrances; `/lend/proposals`, `/lend/loans`,
  `/lend/terms`, `/lend/profile`; `/borrow` (choose a lender), `/borrow/:lenderKey` (the
  proposal), `/borrow/loans`. `web/src/pages/Private` goes once both areas replace it; its
  modals and offer rows are reused where they fit.
- The console's proposal table shows phase 3's `check_proposal` result as the "within terms" or
  "outside terms" badge; the accept modal warns before accepting a flagged proposal and still
  hides acceptance after expiry (item 4).
- The proposal form starts at the lender's minimums and refuses lower values; its summary states
  the repayment, the due date, what happens on default and that the borrower can cancel until
  acceptance. Leave room in the proposal form, the accept review, the repay modal and the loan
  views for phase 6's messages.
- **Done when:** `pnpm build` and `pnpm lint` pass; a scripted testnet demo runs: the lender
  publishes terms, the borrower's form refuses a lower APR and less collateral, an e2e-built
  proposal outside the terms shows the badge naming the broken terms, the lender accepts, the
  borrower receives the principal and repays, the lender claims, and an overdue loan is
  liquidated; the borrower app has no horizontal scroll at 375 px.

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

## Phase 7: Proportional collateral release (spec item 3b)

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
