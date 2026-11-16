# Private lending v2: session handoff (2026-11-16)

Read this file first. It covers v2 phase 4, verified and reviewed, and what comes after. The binding
design is the spec, `docs/superpowers/specs/2026-11-06-private-lending-v2-design.md`; the plan is
`docs/superpowers/plans/2026-11-12-private-lending-v2.md` (phase 4 starts at "Phase 4: The lender
console and the borrower app").

## Where things stand

- **Branches.** v2 integrates on `v2/main` (`8cb057f`, phases 1 to 3 merged). Phase 4 is on
  `v2/phase-4-two-areas`, pushed to the user's fork and not merged into `v2/main` yet.
- **Phase 4 is done: tasks 1 to 12, the phase review and its fix wave.** Tasks 1 to 11 are
  `742bf72..ac1f185`. Task 12 ran on the user's Linux machine on 2026-11-16; the commit
  `docs: v2 phase 4 verified` records every check.
- **The phase review** (one whole-branch review on Opus) found nothing critical and two important
  issues: the console counted a proposal's term from the indexer's unverified creation height, and
  a failed seed `fill()` in the demo could print the words through an error's `cause`. The fix wave
  `7720099..69c3fda` (nine commits) took those and the review's fix-now minors; `ad7da50` fixed the
  wording the scoped re-review left. The re-review found the wave ready to merge.
- **Waiting for the user:** the finishing choice for phase 4 (next steps, 1).
- **Partial repayment:** the user chose item 3(a) only (installments without releasing collateral)
  for phase 5. Phase 7 (item 3(b)) waits until the user brings it back.

## Rules the user set

- Nothing merges into `main` during v2. Phases branch `v2/phase-<n>-<name>` from `v2/main` and
  merge back with `git merge --no-ff` only when the user picks that option.
- Pushing to the user's fork is approved: the remote `origin` on the Mac, `fork` on the Linux
  machine (where `origin` is the upstream BlockstreamResearch repository). Never push to upstream
  or any shared remote.
- The user's manual checks (Jade, fee errors, wallet switch) wait for "Final manual checks" at the
  end of the plan, after phase 6.
- The liquidtestnet faucet may be used to top up the e2e wallets.
- Never print, log or commit the seed phrases in `web/.env.e2e.local`.
- Never modify the `lending-indexer-testnet` database (pre-v2 schema with real rows). Copy it if a
  migration check needs one.

## What phase 4 built

- **Directory v2:** the indexer stores and serves each entry's `signed_challenge` and `signature`
  (migration `20261115120000_directory_signatures.sql`); the wasm exports `verifyDirectoryEntry`;
  the web checks every entry with `checkDirectoryEntry` (`verified` / `unsigned` / `invalid`).
  Borrowers see verified lenders only, and names come from verified entries only.
- **One term rule** in `web/src/privateLending/lenderTerms.ts`: `proposalExpiry(tip, days) = tip +
  days·1440 + 60`, `termBlocksOf(expiry, created)`, `proposalExpiryIsStale`. The pure checks are in
  `proposalCheck.ts` and `offerView.ts` (`canStillAccept`: tip known and below the expiry).
- **Fresh addresses** across flows in a session: `addressCursor.ts` (never index 0, never past
  LWK's last unused + 19).
- **Two areas:** the landing page `/` with two entrances; the lender console
  `/lend/{proposals,loans,terms,profile}` (`web/src/areas/lend/`); the borrower app `/borrow`,
  `/borrow/:lenderKey`, `/borrow/loans` (`web/src/areas/borrow/`). `/app/*` redirects to `/`. The
  old `web/src/pages/Private` page is gone.
- **Tests:** Vitest (`pnpm test`, 100 tests); the e2e stage `short-proposal` (15-block term, runs
  only when named); a Playwright demo on testnet (`pnpm demo:testnet`, `web/scripts/demo/`).
- **From the review's fix wave:** the console takes each proposal's creation height from esplora
  (`useCreationHeights.ts`, `proposalFigures.ts`) and keeps Review disabled until it is known; a
  saved creation that went stale is offered only "Discard"; flows receive past the wallet button's
  address (LWK's last unused + 1); the borrower app no longer asks the indexer for its own entry.
- **Cleanup:** docs redirects for old URLs, the guide describes both areas, nginx lost its
  `/.well-known` block, `getReceiveAddress` became `currentReceiveAddress()`.

## Next steps, in order (each on the user's go-ahead)

1. **Finish phase 4,** as the user chooses: merge `v2/phase-4-two-areas` into `v2/main` locally
   with `git merge --no-ff`, open a PR against `v2/main` on the fork, or keep the branch as it is.
2. **Phase 5** (contract revision, items 1 and 3a) and **phase 6** (private messages): each starts
   by breaking the plan's phase section into tasks with the writing-plans skill, as phase 4 was.
   Phase 5 has a design-note gate in the spec first. Fold the items "Carried from the phase review"
   (below) that name a phase into its tasks.
3. **Final manual checks** by the user after phase 6 is merged into `v2/main`, with the items
   below that name them.

## Environment (the user's Mac)

- Put `/opt/homebrew/opt/rustup/bin` first on PATH (Homebrew's `rustc` shadows rustup;
  `lwk/rust-toolchain.toml` pins 1.91), then `~/.cargo/bin` (sqlx-cli 0.8.6). `~/.simplex/bin`
  holds `simplex`, `elementsd`, `electrs`. pnpm 10.33 is in `~/.local/share/pnpm-global/bin`.
- `docs/` pins pnpm 12.8.1: build it with
  `npm_config_manage_package_manager_versions=false pnpm build`.
- Postgres runs in the docker container `postgres` on `localhost:5432` (`postgres`/`password`).
  Databases: `lending-indexer` (dev; carries a regtest sync height, so do not point the testnet
  indexer at it), `lending-indexer-testnet` (do not touch), and the phase 4 scratch databases
  `lending-indexer-phase4`, `lending-indexer-phase4-demo{,2,3,4}` (free to drop). Leave the
  `simplicity-smoke-*` containers alone.
- The local testnet indexer and the demo's needs are in `web/README.md` ("Local testnet indexer",
  "Scripted testnet demo"). Each demo run needs a fresh indexer database started at the tip, after
  the previous run's last transaction.
- blockstream.info allows 700 esplora requests an hour per IP, and two demo runs stalled on its
  429s. Run the indexer on its default esplora (liquid.network) and set
  `DEMO_ESPLORA_URL=https://liquid.network/liquidtestnet` for the demo and the e2e stages.
- Faucet: `curl -s "https://liquidtestnet.com/faucet?address=<addr>&action=lbtc"` for tL-BTC,
  `action=test` for the TEST asset.
- Old e2e states sit beside `web/.e2e-private/state.json` (`state.p2*.json`, `state.p3.json`,
  `state.phase4-task3.json`); keep them, they are git-ignored.

## Environment (the user's Linux machine)

- The checkout is `/home/juja/juja_backup/projects/my/simplicity-lending`. pnpm is not on PATH:
  put `.superpowers/sdd/2026-11-12-private-lending-v2/bin` first (a shim running
  `corepack pnpm@10.33.0`). rustc is stable 1.95.0 (the Docker wasm stage uses 1.96); LWK's
  1.91.0 is installed.
- Postgres is the docker container `lending-pg` on `localhost:5432` (`postgres`/`password`), with
  `lending-indexer` (dev), `lending-indexer-testnet` (do not touch) and
  `lending-indexer-testnet-v2p1` (phase 1). The `simplicity-lending-*` compose stack is a running
  deployment: leave it alone. The docker CLI's current context, `desktop-linux`, is not running;
  use `docker --context default`.
- liquid.network does not answer from this network, so the indexers, the e2e stages and the demo
  all use blockstream.info and its 700 requests an hour.
- A phase 1 indexer and API from an earlier session still run on port 8000 (database
  `lending-indexer-testnet-v2p1`) and poll blockstream.info; stopping them was not permitted to
  this session. Phase 4's runs used port 8001: `APPLICATION__PORT=8001` for the API,
  `VITE_API_URL=http://localhost:8001` for the e2e, `DEMO_INDEXER_URL=http://127.0.0.1:8001` for
  the demo.
- `crates/contracts/src/artifacts/` is git-ignored output of `simplex build`. After a contract is
  added or removed, run `cd crates/contracts && simplex build`, or every Rust build fails on an
  `include_simf!` of a missing file.
- The user's untracked `crates/contracts/tests/lending_security_audit.rs` imports the deleted
  public contracts, so `--all-targets` builds and `simplex test` fail with it in place; rename it
  aside for those runs and back afterwards.
- `web/.env.local` sets `VITE_DEBUG_MNEMONIC`, which the build refuses: build with
  `VITE_DEBUG_MNEMONIC= pnpm build`.
- `/home` is nearly full; `cargo clean` freed 33 GB on 2026-11-16. Old e2e states beside
  `web/.e2e-private/state.json`: `state.v1.json`, `state.p1-linux.json`,
  `state.p4-linux-run1.json`.

## The local SDD ledger

The running ledger is `.superpowers/sdd/2026-11-12-private-lending-v2/progress.md` (git-ignored,
on the user's Mac only), with task briefs and reports beside it. It is the record of every ruling
and deferred minor; the lists below copy it so this handoff stands alone. After the phase review
comes back clean, that workspace directory is deleted. The review and fix wave of 2026-11-16 ran
on the Linux machine; their rulings are below.

## Rulings made for the user in phase 4

Each: what was decided, and what it costs if wrong.

- R1: the integration branch is `v2/main` and the remote `origin` (the plan still says `v2` and
  `fork`); implementers never push. Cost: none.
- R2: the Private page stood in at `/lend/proposals` and `/borrow` until tasks 6 to 9 replaced it.
  Cost: none (gone now).
- R3: a task that routed an area page could delete the Private page section it replaced. Cost:
  none.
- R4: Profile changes the display name by re-signing it with the lender's verified terms; without
  terms it asks to publish terms first (the signature covers name and terms together). Cost: a
  lender cannot set a name before its terms.
- Task 1: the wasm output is git-ignored, so it is rebuilt locally (`pnpm build:wasm`), not
  committed.
- Task 2: `lookup` covers verified entries only (the plan said all entries); an unverified key
  shows its fingerprint without a name. Cost: a lender listed before phase 4 shows no name until it
  republishes.
- Task 3: `breachLabel` takes an optional `leastCollateral`; `checkAgainstTerms` checks the
  configured pair only; the e2e `create` stage reads its creation height from esplora;
  `tsconfig.test.json` added.
- Task 4: at the gap-limit bound a two-address change request gets the last two distinct indices;
  the cursor takes an optional hand-out callback for the e2e's repeat check.
- Task 5: the landing header moves "About Simplicity" and "Get test funds" into the menu below
  1024 px; the "Testnet demo" chip is gone from the app header (NetworkNote names the network).
  **Both are visible changes the user may want reverted.**
- Task 6: "Waiting for you" excludes expired proposals; Review stays disabled until the lender's
  own entry loads (fails closed); after the review, acceptance needs `canStillAccept` before build
  and again before broadcast, and a saved acceptance past its expiry can only be discarded.
- Task 7: `termsToPublish` publishes the form's pair plus verified other pairs only.
- Task 8: verified lenders without the configured pair are not listed or counted.
- Task 9: a proposal is refused as stale only when a confirmation in the next block would count
  fewer days than chosen (`termBlocksOf(expiry, freshTip + 1) < termDays·1440`), with "Review the
  proposal again: the chain moved on." This corrects my first ruling, which refused on any new
  block. Builder errors naming "NFT" stay (tamper-only paths).
- Task 10: the wallet button reads its address through `currentReceiveAddress()`; the docs
  redirect plugin went in with docs' pinned pnpm.
- Task 11: the demo accepts the short proposal right after checking its badge, before the main
  loan (the plan's order let it expire first).

## Rulings in the phase review and fix wave (2026-11-16)

- F1: the fix wave took the review's fix-now list; the rest is carried or dropped below.
- F2: the console takes a proposal's creation height from esplora; the indexer's height is
  display-only (the Received column and the sort). Cost: one esplora request per pending proposal
  until it confirms.
- F3: flows' receive addresses start at LWK's last unused + 1, leaving the wallet button's address
  to the user. Cost: 19 fresh receive addresses before the gap-limit bound instead of 20.
- F4: a saved creation from before the fix wave, which has no saved term, counts as stale: only
  "Discard". Cost: none in practice; Discard drops the local record only, and a creation that is on
  chain is still found by the scan and can be cancelled.
- F5: the repay-by date counts from the tip query's last update (the lint rule forbids
  `Date.now()` in render). Cost: up to 30 s stale.
- F6: "Liquidate & Claim Collateral" became "Liquidate and claim collateral".

## Carried from the phase review

- Past v2: a valid directory signature proves a put, not the key's latest one, and that also
  changes what the lender's own console checks against (documented in `protocol.md`).
- Phase 5: if the pre-broadcast check throws on a creation's first send (stale, or a tip-fetch
  error), the modal offers "Lock collateral and send" again rather than "Discard", and a tip-fetch
  error could let a second creation be built while the first sits as `built`; acceptance has the
  same shape. A creation that esplora reports unconfirmed, or that esplora fails on, shows a
  skeleton badge with no reason (it fails closed).
- Phase 5 (e2e): the expired `short-proposal` cleanup removes a `broadcast` record without asking
  the chain first; the wallets re-split can spend inputs of another stage's unbroadcast record.
- Final manual checks: rows that wait with no sign on esplora 429s; the accept tick at the bottom
  of a scroll area at 800 px tall; two flows before a scan in the running app; the wallet button's
  address after a scan or broadcast.
- Dropped, with the review's reasons: the Terms form does not refill; the unreachable `map_err` and
  the wasm validate-path test; `field()` duplicated; the bare `catch {}`; the fixture cast;
  `Number(days)`; `runAddresses` on a repeat the bound allows; NetworkNote's labels; GetStarted's
  import; route tests; the lowercase reasons; no flagged reminder on retry; the tip-0 strip count;
  "Repaid" while its note waits; discarding an acceptance of a cancelled proposal; the borrower
  pages' type exports and modal imports; the MyLoans sort test; the `expiry <= tip` backstop; the
  WalletGate h1; the demo's `isVisible()` race (mis-stated).

## Notes for the user

- A 10 % APR proposal of 0.1 TEST over one day shows 365 % in the console: the repayment rounds
  up to one TEST base unit of interest. Correct by the rule; a larger demo principal would avoid
  the odd number.
- Failed demo runs left a few small testnet loans on chain.
- Task 5's two visible changes may be worth a look: "About Simplicity" and "Get test funds" sit
  in the menu below 1024 px, and the app header's chip is gone, which also removed the "Beta" chip
  of mainnet builds.
- The shared transaction stepper still says "Broadcasting Transaction" and "Transaction Complete"
  in title case; it predates phase 4.
