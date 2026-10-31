# Private lending, part C2: session handoff (updated 2026-10-31)

Read this file first.

- **Background:** the earlier handoff (`docs/superpowers/handoff/2026-10-29-private-lending.md`) covers parts A, B and C1 and the user's decisions, and the spec is the binding design.
- **Plan in progress:** `docs/superpowers/plans/2026-10-29-private-lending-frontend.md` (part C2, 11 tasks).

## Where things stand

The branch `private-lending-frontend` holds Tasks 1–10 of the plan; Tasks 1–4 and 7–10 had per-task reviews, while 5 and 6 did not, by the user's instruction at the time. It is pushed to `fork` and not merged. `main` holds parts A, B and C1. Only Task 11 (the user's testnet and Jade run) and the final whole-branch review remain.

**Tasks 1–6, with every flow proven on Liquid testnet:**
- **Wasm helpers** (`crates/private-lending-wasm`):
  - `confidentialAddress`, `contractHashFromJson`, `freshIssuerPubkey`;
  - `inspectPset`, which reads a PSET through rust-elements: per-input issuance, sequence and lock time; per-output commitments, keys and blind proofs.
- **Flow plumbing** (`web/src/privateLending/`):
  - `deps.ts` (`PrivateFlowDeps`);
  - `verify.ts`: `openAndVerifyOffer` is the only producer of a `VerifiedOffer`, which is a branded type;
  - `secrets.ts`, `inspectPset.ts`, `finalize.ts`;
  - `flows/shared.ts`, home of the single PSET layout checker, `assertSpendLayout`.
- **Builders** (`web/src/privateLending/flows/`): `creation`, `acceptance`, `claimPrincipal`, `repayment`, `claimRepayment`, `cancellation` and `liquidation`.
  - They are DOM-free, so the browser and Node run the same code.
  - Each asserts the layout through `inspectPset` before and after blinding.
  - Each checks the txid after signing and after finalizing.
  - Creation ends with the borrower's self-check, in which every error is fatal.
- **Witnesses, weights and layout constants** live in `web/src/simplicity/private-lending/{witness.ts,layout.ts}`, `web/src/lwk/weights.ts` and `web/src/simplicity/asset-auth/witness.ts`. The weights below are measured on testnet, with 10 % added:

  | Branch or input | Measured | Constant |
  |---|---|---|
  | OfferAcceptance | 2998 | 3298 |
  | FullRepayment | 3028 | 3331 |
  | OfferCancellation | 2881 | 3170 |
  | Liquidation | 2853 | 3139 |
  | script_auth | 338 | 400 |
  | asset_auth, no burn | 713 | 800 |
  | asset_auth, burn | 812 | 894 |
  | p2wpkh NFT input | 107 | 150 |
- **Headless e2e** (`npx pnpm@10.33.0 e2e:private [stage...]` from `web/`):
  - Two seed wallets live in `web/.env.e2e.local`, which is git-ignored and holds the seed phrases. Never print or commit them.
  - State is kept in `web/.e2e-private/state.json` (git-ignored).
  - A transaction is saved as `built` before broadcast. A re-run rebroadcasts the saved hex and never rebuilds.
  - Funding is checked per stage through `STAGE_NEEDS` in `web/scripts/e2e/env.ts`.
  - Dry stages (`*-dry`) build and check without broadcasting.

**Task 7, the indexer client, scanning and directory** (`0e26155`, fix `2891715`; reviewed):
- `web/src/api/indexer/private.ts` covers every private endpoint with zod schemas. `api/client.ts` gained `postJson`, `putJson` and `deleteJson`; `indexerErrorMessage` extracts the indexer's message, so a 401 shows its reason.
- `web/src/privateLending/scan.ts`:
  - `syncOffers` follows the README's sync recipe, scanning as lender and borrower in one pass.
  - The served creation hex must hash to the candidate's txid before it reaches `openAndVerifyOffer`. A hostile pairing gives `creation-tx-mismatch`, never `verified`.
  - The cheap checks treat only `bad-input:` errors as "no match". Any other wasm error fails the sync, which then saves nothing.
  - Cached `creation-tx-mismatch` and `unknown` results are re-checked by txid on every sync. A 404 keeps the entry.
  - `loadVerifiedOffer` goes through `fetchPrivateCreationTx` and the gate.
- `web/src/privateLending/directory.ts`: `registerInDirectory` and `removeFromDirectory` (challenge, then sign, then write).
- **E2e stage `scan`** (no funds needed):
  - both wallets find the 3 e2e offers verified;
  - the re-sync starts at `syncedHeight + 1`;
  - a stranger key finds nothing;
  - the hostile indexer's mismatch heals on an honest sync;
  - a local fault leaves the state unchanged;
  - a directory register, a 401 with a bad signature, then removal.

**Task 8, wallet plumbing and hooks** (`97deb23`, fixes `5ab5ad3` and `69fa74a`; reviewed). No hook has run in a browser yet: Task 9's dev run is their first runtime test.
- **Wallet** (`providers/wallet`): `privateCapable`, `getLendingKey()` and `getWalletTxOuts()`.
  - The key lifecycle lives in the DOM-free `web/src/privateLending/lendingKeyHolder.ts`: one derivation per session, freed at session end.
  - The private query caches (offers, display terms, key identity) are removed only at session end.
  - The `parity` script checks these rules offline.
- **Hooks** in `web/src/privateLending/hooks/`:
  - **`usePrivateFlowDeps()`** returns `() => Promise<PrivateFlowDeps>`.
  - **`useLendingKeyIdentity()`** gives `{ pubkey, fingerprint }`.
  - **`usePrivateOffers()`** gives `{ lending, borrowing, syncedHeight }`.
    - Items are `{ txid, role, result, code?, candidate, terms }`.
    - `terms` are display-only values opened in memory and never persisted.
    - It refetches on `block_indexed`, and runs at most one sync per scan state.
  - **`useLoadVerifiedOffer()`** loads the `VerifiedOffer` fresh at action time; a listed `verified` is never trusted for an action.
  - **`usePrivateTransaction()`** gives `{ run, retryBroadcast }` and `PrivateBroadcastError`.
    - `run` awaits finalize, saves the finalized hex, and only then broadcasts.
    - `retryBroadcast(txid)` resends the saved hex.
  - **`useDirectory()`** gives `entries`, `lookup`, `own`, `ownEntry`, `register` and `remove`.
    - The own entry comes from the loaded list, so the key is never sent on a read.
    - Directory queries sit off the per-block root.
- **Stores:**
  - The scan state is in the IndexedDB database `simplicity-lending:private-scan`, keyed by network, API base and fingerprint, and validated on decode.
  - Private transactions are in a separate database, `simplicity-lending:private-transactions`, exposed additively on `PendingTransactionsProvider` and opened only for private-capable wallets.
  - Public and private tracking share one sweep rule, `sweepAction`.
- **For the modal authors:**
  - The full signatures, a typical modal call and the notes for Tasks 9–10 are in the Task 8 report: `.superpowers/sdd/2026-10-29-private-lending-frontend/task-8-report.md`, "Hooks" and "Concerns and deviations", point 8.
  - NFT outpoints are not derived by the hooks:
    - the borrower NFT is at `<creation>:0`, or at `<principal-claim>:0` after a principal claim;
    - the lender NFT is at `<acceptance>:2`.
  - Await `syncWallet()` before reading coins.

**Task 9, the Private page with the directory and lending side** (`e7539a0`; reviewed, approved):
- The route is `/app/private`. Its nav link appears only for Jade and the seed wallet.
- `DirectorySection` registers, renames and removes the own entry. Names render inside `<bdi>`, next to the key fingerprint.
- `LendSection` is the inbox: Accept, Claim repayment and Liquidate. Invalid offers show their code and have no actions.
- The modals are in `web/src/components/modals/private/`.
- **Headless dev run** with the lender seed against the local indexer:
  - The inbox listed the three e2e offers with the right amounts and interest.
  - Directory register, rename and remove worked.
  - Disconnect, reconnect and reload recovered.
  - The `block_indexed` refetch fired.
  - The modals were opened and stopped before signing. Nothing was broadcast.
- **Accepted extras (Ruling 18):**
  - Accept is hidden past expiry;
  - a copy-full-key button;
  - an unsupported-asset gate;
  - row-level Broadcast Again, Processing and Discard.

**Task 10, the borrowing side** (`4d955a8`, fix `d5db409`; reviewed):
- **`BorrowSection`** shows your own offers. Its actions:
  - **Cancel** while pending.
  - **Claim principal,** also on a liquidated offer whose principal is still unspent, as the public flow does.
  - **Repay,** only after the principal is claimed. Repaying burns the borrower NFT, the only key to the principal.
- **Repay needs positive evidence (Ruling 21):**
  - The UI offers it only when the indexer lists the principal as spent by a transaction other than the creation.
  - The repayment builder then proves on chain that the claim transaction spends `<acceptance>:1`, and that the NFT input is `<claim>:0`.
  - `e2e:private repay-hostile-dry` is the regression check: it fails on the original bug.
- **`CreatePrivateOfferForm`:**
  - The lender is chosen from the directory or pasted. A pasted key is checked to be a valid point.
  - Your own key is refused.
  - Review stays disabled until your identity loads, and while an unsent creation exists. Pending creations show above the scan list.
- **Shared code.** One row component (`PrivateOfferActionRow`) and one keyed-modal hook (`useKeyedModal`) serve both Lend and Borrow.
- **Dev run** with the borrower seed, through the Ruling 17 proxy, in a normal browser profile:
  - A creation was built, signed through the app's own `signPset`, finalized, and passed the borrower's self-check.
  - All broadcasts were blocked. Nothing reached testnet.
- **Not run yet, even with the run stopped before signing:** Cancel and Repay, because no pending or active e2e offer is left. Nor have the UI's save, broadcast and retry steps been run against testnet. Task 11 must cover both.

**Local dev against the local indexer (Ruling 17).** The indexer has no CORS layer. So `web/.env.local` sets `VITE_API_URL=/api`, `API_PROXY_TARGET=http://127.0.0.1:8000` and `API_PROXY_STRIP_PREFIX=true`, and `pnpm dev` proxies `/api`. The flag is off by default; see `web/README.md`. `web/.env.local` (git-ignored) currently holds the borrower seed as `VITE_DEBUG_MNEMONIC`.

**Local testnet indexer** (started in Task 7; it does not survive a reboot):
- The database is `lending-indexer-testnet` (sqlx-cli 0.8.6 is installed). The binary is copied to `/tmp/lending-indexer-testnet/simplicity-lending-indexer`, with logs `indexer.log` and `api.log` beside it.
- The API runs on `http://127.0.0.1:8000`.
- The start height is 2682200. `create` is in block 2682289, not "before 2683000" as noted earlier.
- `configuration/base.yaml`'s esplora (`liquid.network`) times out from this machine, so the indexer runs with `ESPLORA__BASE_URL=https://blockstream.info/liquidtestnet/api`.
- To restart, run both commands from `crates/indexer`. Rebuild the binary with `SQLX_OFFLINE=true cargo build -p lending-indexer` if `/tmp` was cleared. The stored sync height wins over the start height.
  ```
  RUN_MODE=indexer DATABASE__DATABASE_NAME=lending-indexer-testnet INDEXER__LAST_INDEXED_HEIGHT=2682200 ESPLORA__BASE_URL=https://blockstream.info/liquidtestnet/api setsid nohup /tmp/lending-indexer-testnet/simplicity-lending-indexer > /tmp/lending-indexer-testnet/indexer.log 2>&1 < /dev/null &
  RUN_MODE=api DATABASE__DATABASE_NAME=lending-indexer-testnet setsid nohup /tmp/lending-indexer-testnet/simplicity-lending-indexer > /tmp/lending-indexer-testnet/api.log 2>&1 < /dev/null &
  ```

**Testnet transactions** (Liquid testnet, all confirmed):

| Stage | txid |
|---|---|
| split, borrower | `5bf70538add52d14a409d158c3a272fc3a15281a38462c7ce4bfffe8edbeadee` |
| split, lender | `1a8e628fa0ddefdb472fef26f79d48d335f08d44565743e16814c43228fa814a` |
| create | `6816e8b1ff48930adabc284cfba57717bb7fda0d72499b8aeff4425cab6b682d` |
| top-up, lender → borrower | `09dead5d68da62f93e8c0947fcb3f2fbf615d963abb138d12c4fe6f87024ecdb` |
| accept | `baf52dd7855225cf8a51ddb2d52d55f399c23e6b3fb8427b7916bb6a3b6b55b2` |
| claim principal | `315a62e59d82544c0741ee16dd415ffdbaae3e648be2590f938e29e5d9a09c9c` |
| repay | `1d30ea1cb2650d55b67c54fa1de8d880677cee183ba8d4a82a35dfc9853011aa` |
| claim repayment | `9fdf6079a69a8198049d9516f2f7f6f23e3a2d82f0f13c5028a913adce057c7f` |
| cancel: creation | `79475afcae94666bc1ebcdd3748a461836bc278016eb312c06fe6a1ee9f1849c` |
| cancel | `da907491ea0914b1f2c36bacd9971397fa686be592a2a7ec47fceb58d5111d79` |
| liquidate: creation | `3c15d48283c94dc384e18a78daa7ebd885cd0b4aea7d6ae2f058d31df39b1807` |
| liquidate: accept | `0f2512d69c6b2782af1425394e2be067b3bf4e539964ab9f73a39f7f1a51742c` |
| liquidate | `56af64c2ec20be313674c70ea312f50654b6ca65c8ab449d853fd5c89fb270e6` |

Notes on the liquidation:
- It was refused twice before expiry with `expiry-not-reached`, before anything was built.
- It was mined one block after the expiry height. Its lock time is the expiry, and the offer input's sequence is `0xfffffffe`.

## What comes next, in order

1. **Task 11: the testnet run through the UI, and the Jade check.**
   - **Step 1, the checklist.** A subagent writes it, at `docs/superpowers/manual/2026-10-29-private-lending-testnet.md`.
   - **Step 2, the run.** The user runs the checklist.
   - Make sure the local indexer is running first (see above).
   - **It must cover what no dev run has exercised yet:**
     - Cancel and Repay in the UI;
     - the UI's save before broadcast, the broadcast itself, and Broadcast Again and Discard against testnet;
     - the confirmation tracking.
   - **Jade:**
     - Check that Jade signs pinned outputs with `blinder_index = Some(i)`.
     - Check how Jade shows the NFT contract domain `simplicity-lending.private`.
     - The app's `signPset` adds registry asset contracts (`withAssetContracts`) before signing. It has worked for the seed wallet since Task 10's dev run, but not yet with Jade.
   - From the Task 7 review: `verified` does not mean on chain. An indexer can serve a well-formed offer that was never broadcast. Acting on it fails only at broadcast, and no funds are at risk.
2. **The final whole-branch review** of `private-lending-frontend`, then merge.

**Funding** (topped up from the faucet on 2026-10-30, 100 000 tL-sats per request):
- The borrower has 399 311 tL-sats in 5 coins and 4 900 TEST.
- The lender has 199 356 tL-sats in 3 coins and 4 100 TEST.
- A creation needs at least 3 distinct coins.
- The faucet is a plain GET with no captcha, limited to 3 requests a minute: `https://liquidtestnet.com/faucet?address=<addr>&action=lbtc` (or `action=test` for TEST).

## How work is run (user's instructions)

- Plans are executed subagent-driven, with one commit per task. Pushes go to `fork`, never `origin`, and the user decides about merging.
- **Since 2026-10-30:**
  - implementers run on Opus;
  - no review after each task, only one review at the end of the phase;
  - a per-task review only when the controller flags a task as important. The user reaffirmed this, and Tasks 7 and 8 were flagged and reviewed: Task 7 for the untrusted-indexer boundary, Task 8 for the lending key and the shared providers.

  This is saved in Claude's project memory.
- **For Tasks 9 and 10,** the user asked for a review after each task, and a push to `fork` after each reviewed task.
- **Model availability.** `claude-sonnet-5-5` fails through this machine's LiteLLM proxy ("no healthy deployments"), so every subagent, reviewers included, runs on Opus.
- **Budget.** The session that ran Tasks 7–10 went through the Blockstream router (`claude-bs`) and hit the team budget during Task 10's fix round. That round was then finished in a claude.ai session, starting from the partial working tree.
- The SDD ledger for this plan is `.superpowers/sdd/2026-10-29-private-lending-frontend/progress.md` (git-ignored). Tasks 1–10 are marked complete there. Its `global-constraints.md` holds the rulings in the form given to implementers, and the task reports (`task-N-report.md`) sit beside it. Keep all of them until the phase ends.

## Rulings made during part C2

Rulings 4 and 5 replace the plan's fixed e2e funding numbers. Rulings 8–10 change builder interfaces that Tasks 8–10 must follow.

1. **Branch.** Work on a branch in the main checkout, not a worktree.
2. **Testnet broadcasts.** Subagents may broadcast from the two e2e wallets on testnet; never mainnet.
3. **Contract hash test.** The `contractHashFromJson` test pins an independent known answer: `aab713dd…424ca4`, computed in Python.
4. **Need-based funding.** The minimums come from shared constants: `COLLATERAL` 20 000, `PRINCIPAL` 1 000, `REPAYMENT` 1 100, `FEE_BUDGET` 2 000. Records are saved as `built` before broadcast.
5. **Per-stage needs.** `STAGE_NEEDS` lists each stage's needs. The startup check covers only stages that aren't confirmed yet, and each stage checks its own need before building.
6. **PSET inspection in wasm.** The hand-written TS parser was removed. Negative asserts check explicit nulls, and the offer output must carry both blind proofs.
7. **Async finalize.** `AsyncUpdatedPset` is accepted, and the `terms-mismatch` code is documented.
8. **NFT inputs** are outpoint strings spent as `ExternalUtxo`, because LWK lists no explicit NFT outputs among wallet coins. Builders fetch and verify the NFT at that outpoint.
9. **Fee coins.** Builders take explicit `feeCoins`, and all input outpoints must be distinct.
10. **Explicit change.** Builders emit non-L-BTC change themselves, because LWK places it before the post-issuance outputs.
11. **Module split.** Witness builders and weights moved to `witness.ts` and `weights.ts`, so Node can import them without Vite.
12. **One layout checker** for all flows. Claims are tied to their offer, and the e2e asserts the measured weights.
13. **Task 6's final check** is a no-argument run over the existing state, not a clean-state rerun, which would need new funds.
14. **Indeterminate scan results are not final.** `creation-tx-mismatch` and `unknown` are re-checked by txid on each sync, so a transient fault can't hide an offer for good.
15. **Task 8, fix round 1, took three review minors along with the two Important fixes:**
    - directory queries moved off the per-block root;
    - the private transaction store is opened only for private-capable wallets;
    - the private caches are cleared at session end.
16. **Task 8, fix round 2, took one more minor.** At most one `syncOffers` runs per scan state, and terms are opened only while the session's key promise is unchanged.
17. **Local dev proxy.** The local indexer has no CORS layer. Instead of adding one, which would be a server change, `pnpm dev` gets an opt-in `/api` proxy prefix strip, `API_PROXY_STRIP_PREFIX`, off by default.
18. **Task 9's extras are accepted:**
    - Accept is hidden past expiry;
    - a copy-full-key button;
    - an unsupported-asset gate;
    - row-level Broadcast Again, Processing and Discard;
    - helper files.
19. **Task 10 first took three Task 9 review minors,** so its new modals wouldn't copy Task 9's patterns:
    - shared helpers moved out of `pages/`;
    - shared receiver and expiry helpers;
    - Accept re-fetches the candidate and requires an unspent pending offer.
20. **Task 10's fix round took two minors:**
    - Review waits for the own identity, so you can't pick yourself as the lender;
    - pending creations are shown, and Review is disabled while an unsent creation exists.
21. **Repay needs on-chain claim evidence.** Indexer data alone is not enough, so an indexer that omits the principal can never unlock a repayment that would strand it.

Other changes not foreseen by the plan:
- `inspectPset` gained `lockTime` and per-input `sequence`.
- An `ExpiryNotReachedError` was added.
- The liquidation pays the collateral to an explicit `collateralReceiver` output.
- In Task 3, `OpenedOffer.firstInput()` was fixed: it had a stray `[elements]` prefix.

## Open items for the final review

Smaller deferred findings, recorded in the ledger:
- `Secp256k1::new()` is called on each `freshIssuerPubkey` call.
- `toOfferError` has no unit test.
- The broadcast "already known" regex is broad.
- The inflation-keys assert accepts `null` or `0`.
- The acceptance change goes to the same address as the lender NFT (a privacy issue).
- An acceptance with no fresh blinded output would fail inside `blindPset`.
- There are no failing-case layout tests.
- The commitments of spent outputs aren't checked before signing; a mismatch only invalidates the transaction.
- Fresh outputs are checked for a blinding key, but not that it is the receiver's key.

From Tasks 7 and 8:
- The indexer's `last_indexed_height` is trusted without bound, so one huge value stops scanning.
- On a 404 the re-check keeps an entry. Junk from a hostile indexer is then re-fetched on every sync, without bound.
- There is no e2e for multi-page paging, a view-tag false positive, a re-sync that brings a new candidate, or the re-check of an `unknown` result.
- `client.ts` inlines `ErrorHandler.processWithoutFeedback` (which is `console.error`), because the handler crashes under Node.
- `postJson` and `putJson` are near-copies.
- The e2e script grew by about 370 lines of scan helpers.
- `web/README.md` hard-codes block 2 682 289.
- `updatePrivateTx` accepts any partial record, so a caller could rewrite `txHex`.
- A retry after the 24-hour sweep leaves the record `failed` forever.
- Directory `lookup` normalizes its argument but not the map keys, and its doc claims name order.
- `fetchCandidate` makes one indexer request per offer on every block.
- An own directory entry beyond 5 000 entries shows as `null`. After `register`, a new entry is appended to the end of the list until the refetch.
- After a silent `cancelRefetch`, the orphaned offers fetch re-fetches every candidate. Reading `context.signal` only after the sync would stop it.
- A refetch that joins a running sync can lag one block.
- `syncOnce` works per tab, so two tabs can sync one scan state at once.
- The `getLendingKey` doc says "the same promise per session", which doesn't hold after a failed derivation.
- **Pre-existing, not changed by this branch:** the session descriptor (which holds the SLIP-77 master blinding key, the source of the lending key) and, for seed sessions, the mnemonic are kept in `sessionStorage`.

From Tasks 9 and 10:
- **Stale local records.** A local transaction record overrides the candidate's current state. A rejected liquidation's `built` record hides a now-valid Claim until it is discarded. A dropped broadcast shows Processing for up to 24 hours.
- **Fee reserve.** Accept checks the principal, but not the tL-BTC fee reserve.
- **Fingerprints.** A directory name can render without a fingerprint, for an invalid key or while the wasm module loads.
- **Pending creations.** A finalized creation the indexer hasn't listed yet disappears from the pending list until the scan finds it. "You have no private offers yet." shows under a pending "Your new offer" row.
- **Coin weight.** `CREATION_EXTRA_WEIGHT_UNITS` = 6000 comes from one sample. If it is short, LWK fails before signing.
- **Explorer links.** The link for an unsent txid gives a 404.
- **e2e fetches.** The e2e `fetchTx` doesn't check the served txid; the app's does.
- **Console noise.** One unexplained wasm "memory access out of bounds" occurred on a cold start of the public `/app/supply`, and didn't recur. HeroUI logs "PressResponder" warnings from the public `UiModal`, plus one per private modal.

Part C2 has had per-task reviews for Tasks 1–4 and 7–10, but no whole-branch review yet.
