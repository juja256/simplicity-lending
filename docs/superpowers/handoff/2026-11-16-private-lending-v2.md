# Private lending v2: session handoff (2026-11-16)

Read this file first. It covers v2 phase 4 up to its last task and what comes after. The binding
design is the spec, `docs/superpowers/specs/2026-11-06-private-lending-v2-design.md`; the plan is
`docs/superpowers/plans/2026-11-12-private-lending-v2.md` (phase 4 starts at "Phase 4: The lender
console and the borrower app").

## Where things stand

- **Branches.** v2 integrates on `v2/main` (`8cb057f`, phases 1 to 3 merged). Phase 4 is on
  `v2/phase-4-two-areas`, 20 commits ahead of `v2/main`, pushed to `origin` (the user's fork).
  Nothing is merged into `v2/main` yet for phase 4.
- **Phase 4 tasks 1 to 11 are done,** each with an implementer and a task review, all reviews
  clean after their fix rounds. Commits `742bf72..ac1f185`.
- **Paused by the user** after task 11 ("stop after task11 and wait for my instructions"). Do not
  start task 12 or the phase review until the user says so.
- **Partial repayment:** the user chose item 3(a) only (installments without releasing collateral)
  for phase 5. Phase 7 (item 3(b)) waits until the user brings it back.

## Rules the user set

- Nothing merges into `main` during v2. Phases branch `v2/phase-<n>-<name>` from `v2/main` and
  merge back with `git merge --no-ff` only when the user picks that option.
- Pushing to `origin` (the user's fork) is approved. Never push to `upstream` or any shared remote.
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
- **Tests:** Vitest (`pnpm test`, 84 tests); the e2e stage `short-proposal` (15-block term, runs
  only when named); a Playwright demo on testnet (`pnpm demo:testnet`, `web/scripts/demo/`).
- **Cleanup:** docs redirects for old URLs, the guide describes both areas, nginx lost its
  `/.well-known` block, `getReceiveAddress` became `currentReceiveAddress()`.

The demo passed once (run 5, 19.6 min) before the last fix `ac1f185`, which changed only how the
demo types the seed (a throwaway connect through it passed). It was not re-run in full since.

## Next steps, in order (each on the user's go-ahead)

1. **Task 12, verify the phase** (plan, "Task 12: Verify the phase"):
   - `cargo test --workspace` (without the regtest tests), `cd crates/contracts && simplex test`,
     `cargo clippy --workspace --all-targets --all-features -- -D warnings`;
   - `cd web && pnpm build:wasm && pnpm test && pnpm build && pnpm lint && pnpm parity &&
     pnpm check:config`;
   - every e2e stage **from an empty state**: move `web/.e2e-private/state.json` aside first (the
     `scan` stage expects exactly the three offers between the two keys, and demo runs add more),
     on a fresh local indexer database started at the tip;
   - `pnpm demo:testnet` on the final tree, then look at the screenshots in `web/.demo-output/`;
   - the migration on a **copy** of a database holding a phase 3 entry: the entry survives with null
     signature fields and is hidden from borrowers;
   - `docker compose build` and the docs build;
   - commit `docs: v2 phase 4 verified` with the results.
2. **The phase review:** one whole-branch review on the most capable model, over
   `v2/main..v2/phase-4-two-areas`, pointed at the rulings and deferred minors below; then one fix
   wave and one scoped re-review.
3. **Report to the user** the list of rulings made on their behalf (below), then offer the
   finishing menu: merge into `v2/main` locally (`--no-ff`), push and open a PR against `v2/main`,
   or keep the branch.
4. **Phase 5** (contract revision, items 1 and 3a) and **phase 6** (private messages): each starts
   by breaking the plan's phase section into tasks with the writing-plans skill, as phase 4 was.
   Phase 5 has a design-note gate in the spec first.
5. **Final manual checks** by the user after phase 6 is merged into `v2/main`.

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

## The local SDD ledger

The running ledger is `.superpowers/sdd/2026-11-12-private-lending-v2/progress.md` (git-ignored,
on the user's Mac only), with task briefs and reports beside it. It is the record of every ruling
and deferred minor; the lists below copy it so this handoff stands alone. After the phase review
comes back clean, that workspace directory is deleted.

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

## Deferred minors for the phase review

- **Directory and terms:** a valid signature does not prove an entry is the key's latest put
  (freshness rests on the indexer; known limit); `PairTermsSummary` says "No terms published." for
  an invalid entry with null terms; "These terms could not be verified" lacks its period; the
  hidden-count note reads oddly with an empty list and counts the wallet's own entry; the Terms
  form fills once and does not refill; Terms shows the published time twice; the identity error
  renders twice on Profile; the pre-fill choice in `TermsPage` is untested (extract a pure
  function); dto.rs doc omits action and pubkey from the signed fields; an unreachable `map_err`
  in wasm `directory.rs`; a wasm test that does not isolate the validate path.
- **Proposal checks:** `field()` duplicated between `proposalCheck.ts` and `lenderTerms.ts`; bare
  `catch {}` around `wasm.minCollateral`; the e2e `checkCreatedTerm` does not go through
  `proposalOfOffer`/`checkAgainstTerms`; a fixture cast in `proposalCheck.test.ts`; no chained test
  of a late confirmation flagged as short; `Number(days)` relies on the form rejecting "3e1".
- **Addresses:** `addressCursor.ts:48` doc says "below" where the code includes the bound; e2e
  `runAddresses` throws on a repeat the bound allows; no test of the cursor moving after it sat at
  the bound; the wallet button's address can equal a flow's receiver (privacy only).
- **Shell and routes:** unknown `/lend/*` and `/borrow/x/y` paths hit the 404 boundary; layouts
  have no h1; NetworkNote duplicates WalletButton's network labels; GetStarted imports from
  Hero.tsx; no route tests.
- **Console:** "Broadcast again" wording differs between row and modal, and the modal still
  offers it after the term passed (the hook refuses); reasons list starts lowercase; an unsent
  acceptance shows no flagged reminder; a saved acceptance for a cancelled proposal cannot be
  discarded; the table caption counts expired proposals the strip excludes; a wasm load failure
  leaves badge skeletons forever; with tip 0 the strip counts every pending while rows wait; lender
  modals in title case ("Claim Repayment"); at 800 px tall the accept tick sits at the bottom of a
  scroll area; a row says "Repaid" while its note still waits for confirmation; rows wait forever
  with no sign on esplora 429s.
- **Borrower:** repay-by date uses a `now` fixed at mount; ChooseLenderPage exports types to
  ProposalPage; "only it can accept" is stiff; Claim/Repay modals import from `areas/borrow`;
  Cancel modal chip says "Not accepted yet" also when expired; "Unlisted lender" should be
  "Unknown lender"; the `expiry <= tip` backstop is gone (unreachable); MyLoans sort untested;
  `offerView.ts:2` is 104 columns; amounts wrap inside "tL-BTC" (keep amount and unit together).
- **Cleanup:** still dead: Jade `getVerifiedReceiveAddress`, unused z-index utilities; deleted
  contract doc pages have no redirects; `docs/developers/build.md` wraps a code span across lines.
- **Demo and e2e:** the `wallets` funding check does not cover the demo's own needs (README
  overstates it); an expired unfinished `short-proposal` record is resumed (20-min timeout instead
  of a clear failure); the wallets re-split can spend inputs of another stage's unbroadcast record;
  `demo.spec.ts:554` `isVisible()` races the own-entry load on a rerun; README.md:117-119 ragged
  wrap and "30 to 60 minutes" is stale (19.6 min); `wallet.ts:33` `await words.all()` unguarded; if
  `fill(mnemonic)` itself fails, its error `cause` can print the words to the terminal (never to
  disk; throw without the cause).

## Notes for the user

- A 10 % APR proposal of 0.1 TEST over one day shows 365 % in the console: the repayment rounds
  up to one TEST base unit of interest. Correct by the rule; a larger demo principal would avoid
  the odd number.
- Failed demo runs left a few small testnet loans on chain.
- Checks first seen only in the demo, to repeat in the final manual checks: two flows before a
  scan in the running app (address cursor), the wallet button's address after a scan or broadcast.
