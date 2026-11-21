# Private lending v2: session handoff (2026-11-21)

Read this file first. It covers v2 phase 5, verified, reviewed and merged, and what comes after.
It replaces `2026-11-16-private-lending-v2.md` for everything but the environment notes, which
that file still holds (both machines) and this one only extends. The binding design is the spec,
`docs/superpowers/specs/2026-11-06-private-lending-v2-design.md`; the plan is
`docs/superpowers/plans/2026-11-12-private-lending-v2.md` (phase 6 starts at "Phase 6: Private
messages").

## Where things stand

- **Branches.** `v2/main` has phases 1 to 5 merged: phase 5 came in with `git merge --no-ff
  v2/phase-5-contract` on 2026-11-21, pushed to the user's fork. Phase 6 branches from there as
  `v2/phase-6-messages`.
- **Phase 5 is done: tasks 1 to 12, the phase review and its fix wave.** Tasks 1 to 12 ran on
  the user's Linux machine (`d79f78d..8a185f2`); `docs: v2 phase 5 verified` records task 12's
  checks. Phase 5's task ledger stayed on that machine: its rulings are in the plan's "Decided at
  phase start" list and in the task commits, not in the Mac's `.superpowers/sdd` ledger.
- **The phase review** (2026-11-21, on the Mac) ran as two Opus reviewers, as the diff was about
  830 KB: one on the contract, the core and the wasm, one on the web, the e2e, the indexer and the
  docs, each reading the other side's mirror of the contract. The contract half found nothing to
  fix (four minors). The web half found three important issues, below, and eight minors.
- **The fix wave** `3b11015..45cb93b` (four commits) took the three important issues; a scoped
  Opus re-review found all three addressed and nothing new above minor.
- **Partial repayment:** item 3(a) is in. Phase 7 (item 3(b)) waits until the user brings it back.

## Rules the user set

Unchanged from the 2026-11-16 handoff: nothing merges into `main` during v2; phases branch from
and merge into `v2/main` with `--no-ff` on the user's go-ahead; push only to the user's fork
(`origin` on the Mac, `fork` on Linux); manual checks wait for "Final manual checks"; the
liquidtestnet faucet may top up the e2e wallets; never print, log or commit the seed phrases in
`web/.env.e2e.local`; never modify the `lending-indexer-testnet` database.

## What phase 5 built

- **Item 1, the hidden expiry:** `EXPIRY_HASH = SHA-256(salt ‖ expiry_be32)` replaces the plain
  expiry; the salt is `OfferSecrets::derive("expiry-salt")`; liquidation reveals `(h, salt,
  expiry)` and checks the lock height.
- **Item 3(a), installments without collateral release:** the debt is a point stored as `h(A,
  D)`; an installment moves the loan to `D − V` and pays an output the lender NFT unlocks without
  burning; the full repayment pays what is left; a loan that owes nothing closes by revealing the
  debt's blinder `k` (`OP_RETURN` and witness). The lender claims installments one by one, and the
  final claim or a liquidation sweeps the unclaimed ones with the combined opening.
- **Core and wasm:** `debt.rs` (the debt as a point, both prefix bits), the installment key from
  the borrower's key, the loan outpoint, input 2 and output 0's script; `loanState` rebuilds the
  loan for either party from the chain alone; `planInstallment`, `sweep`, `zeroDebtKey`.
- **Indexer:** the UTXO type `installment` (migration `20261118120000`), and an active offer's
  spend read as installment, full repayment, zero-debt close or liquidation.
- **Web:** flows `installment.ts`, `zeroDebtClose.ts`, `claimInstallments.ts`, the reworked
  repayment, final claim and liquidation; `loan.ts` (`loadLoan`, `principalClaimedBefore`),
  `repayPlan.ts`; the repay form ("Paid so far", "Still owed", the term rule), My loans, the loan
  book (Repaid, Remaining, Claimable); the e2e stage `repay-partial`; the demo pays an installment.

## The phase review's fixes (2026-11-21)

- **R5-1** (`3b11015`): `intro.md` and `protocol.md` said the app repays in full only and that
  partial repayments are not supported; they describe installments now, and `asset-auth.md`
  counts the installment as a third output it guards.
- **R5-2** (`b41ed3d`, `9bba12b`): a broadcast installment the network dropped is marked failed
  when its tracking times out, and the form then offers Repay again; after a reload the receive
  cursor can hand out the same address, so the same first coin would derive the same key and
  reuse the range proof's nonce. Every installment of the loan saved in the browser now keeps its
  first wallet input out of the next one, failed ones too, not only discarded ones
  (`installmentTraceInputs`).
- **R5-3** (`b41ed3d`): nothing checked output 2's range proof before signing, so an installment
  the borrower could not open would confirm and leave a loan that can never close. The builder
  now reads the blinded transaction back with the borrower's lending key (`loanState` with it
  appended) and requires the amount, the successor outpoint, what is left and the debt hash.
  `Loan` carries the hex it read; `InstallmentParams` takes `lendingKey`.

## Verification of the fix wave

- On the Mac, with the wasm rebuilt: `pnpm test` (155), `pnpm lint`, `tsc` on the three
  tsconfigs, `VITE_DEBUG_MNEMONIC= pnpm build`, `pnpm parity`, `pnpm check:config` (48) and the
  docs build pass.
- E2E on testnet, from an empty state, with a fresh local indexer database
  (`lending-indexer-phase5-fix`, port 8001, liquid.network esplora, from block 2714807), on
  `45cb93b`: `wallets`, `create` 9975de3b, `accept` af5511ea, `claim-principal` ea459ec9,
  `repay-partial` (installment 1 of 366 in 1b326dd4, the lender's claim of it ac5e5182,
  installment 2 of 244 in cce6a600), `repay` 9950e073 (the rest, 490) and `claim-repayment`
  bb10fbca (installment 2 and the repayment swept, 734) all passed. Each installment went through
  the builder's new read-back, and both parties read it back from the chain (366 paid, 734 owed;
  244 paid, 490 owed). The lender claimed 1 100 TEST units, R, over its two claims. The faucet
  sent the borrower 100 000 tL-sats (0ef77ef1) and the lender 5 000 TEST units (f9c7e31c) first.
  The other stages (`cancel`, `liquidate`, `scan`, `directory`, the dry and hostile ones) were
  not rerun: the fix wave touched only the installment's build and its coin choice.
- **Not run:** `docker compose build`, neither in task 12 (the Linux machine had 3.6 GB free) nor
  on the Mac (11 GiB free on `/`, and Docker's disk grows on the host). Phase 5 added the `k256`
  dependency to the wasm crate. Run it before v2 goes to `main`.

## Rulings made for the user in the review

Each: what was decided, and what it costs if wrong.

- R1: the review ran as two reviewers split at the contract boundary, each reading the other
  side's mirror. Cost: a cross-cutting issue seen by neither half; the contract mirror was
  checked by the web half and the wasm callers by both.
- R2: the review's minors are carried into phase 6's task 1, as phase 4's were into phase 5,
  rather than fixed before the merge. Cost: the two below that the user may want sooner wait for
  phase 6.
- R3: the trace covers every saved installment of the loan, whatever its state. Cost: a coin is
  left out of the next installment after a build that never reached the network; the form says
  why and offers the full repayment.

## Carried into phase 6, task 1

From the review, each to fix or drop with a reason:

- **Sticky failed loan read** (`useLoan.ts`, `staleTime: Infinity`, `retry: 1`): a transient
  esplora error hides Claim and the figures in the loan book until the loan output changes or the
  page remounts. Esplora 429s are a known problem, so this one is likely to show.
- **No witness vectors for the installment and the zero-debt close** in the parity fixture
  (`witness.test.ts` checks path strings only). The zero-debt close has never run from the web
  against the program; it fails closed at finalize, so the risk is a borrower who cannot close,
  not lost funds. Add the vectors from the regtest tests and run them through
  `checkWitnessVectors`.
- The read-back is the borrower's only and does not check output 2's `ecdhPubkey` against the
  plan's ephemeral key: a proof that rewinds for the borrower with a wrong nonce field would pass,
  and the lender could not open the amount.
- The borrower's term-ended note uses `tip > expiry` (`isPastExpiry`) while the form refuses an
  installment at `tip ≥ expiry` (`installmentTermOpen`): use one boundary.
- `LiquidatePrivateOfferModal` reads the loan before checking the expiry, so a read failure can
  hide the readable "not yet" message; check `tip < expiry` first.
- `buildPrivateInstallment` has no term check of its own (the form and `beforeBroadcast` have).
- `PrincipalNotClaimedError` and the wasm `loan-mismatch:` messages reach the borrower's modals
  with codes and "borrower NFT" wording; map them to plain sentences.
- Discarded and failed installment records are never cleaned up; they could go once the indexer
  shows the loan moved past their loan outpoint.
- `loanState` does not anchor the acceptance to the creation's output 3 itself (the web's
  `loadLoan` does); hardening for other callers.
- The trace is per-tab state loaded once from IndexedDB, and a failed load becomes an empty list:
  another tab's save or a build before the load lands is not seen.

Still carried from phase 4's review: the final manual checks below, and past v2, a directory
signature proves a put, not the key's latest.

## Declined by the reviewers, with rulings

- The deploy order of the indexer and the web app (an old app meeting the new `installment`
  type): no migration path is promised in v2 (plan, global constraints). Dropped.
- A loan whose borrower NFT went through a hand-built installment before the principal claim:
  `principalClaimedBefore` then refuses forever, safe in direction, and the app never builds it.
  Dropped.
- A Jade signing the combined-opening sweep: final manual check 4.
- The pre-existing audit finding `expired_pending_offer_can_be_accepted_then_liquidated…`
  predates phase 5 (M-01, kept as is for private loans). Dropped.

## Next steps, in order (each on the user's go-ahead)

1. **Phase 6** (private messages, spec item 6): branch `v2/phase-6-messages` from `v2/main`.
   Two questions open it, before the plan's section is broken into tasks with the writing-plans
   skill: how a Jade handles the sighash the message signatures rely on, and the "proposed,
   confirm at phase start" rule that senders do not reread their acceptance or repayment
   messages on another device. Phase 5 made the installment's key deterministic, so an
   installment's message could be reread by its sender; the acceptance's still could not.
   Task 1 takes the items carried above.
2. **Final manual checks** by the user after phase 6 is merged into `v2/main`, and
   `docker compose build`.

## Environment (the user's Mac), additions to the 2026-11-16 handoff

- The private lending wasm under `web/src/wasm/private-lending/` is git-ignored output: after
  checking out a branch with wasm changes, run `pnpm build:wasm` before the web tests, or they
  fail at opening an offer.
- The indexer binary is `target/debug/simplicity-lending-indexer`; run it from `crates/indexer`
  so it finds `configuration/`. Something already listens on port 8000; the fix wave's indexer
  API used 8001 (`APPLICATION__PORT=8001`, and `VITE_API_URL=http://localhost:8001
  VITE_ESPLORA_BASE_URL=https://liquid.network/liquidtestnet` for the e2e).
- Databases added: `lending-indexer-phase5-fix` (free to drop).
- The e2e state from before phase 5 is `web/.e2e-private/state.pre-p5-mac.json`; keep it.
