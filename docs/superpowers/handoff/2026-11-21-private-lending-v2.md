# Private lending v2: session handoff (2026-11-21)

Read this file first. It covers v2 phases 5 and 6: both built, verified and reviewed; phase 5 is
merged into `v2/main`, phase 6 waits for the user's go-ahead to merge. Every v2 phase is then
done (phase 7 is postponed), and what remains is the user's final manual checks. This file
replaces `2026-11-16-private-lending-v2.md` for everything but the environment notes, which that
file still holds (both machines) and this one only extends. The binding design is the spec,
`docs/superpowers/specs/2026-11-06-private-lending-v2-design.md`; the plan is
`docs/superpowers/plans/2026-11-12-private-lending-v2.md`.

## Where things stand

- **Branches.** `v2/main` has phases 1 to 5 merged (phase 5 with `0f8dd34`). Phase 6 is on
  `v2/phase-6-messages`, pushed to the user's fork, ending with the review's fix wave
  (`ae7d73b..26a8677`) and this handoff.
- **Phase 6 is done: tasks 1 to 9, the whole-branch review and its fix wave**, run on the Mac
  subagent-driven (one implementer and one reviewer per task; the ledger is the Mac's
  `.superpowers/sdd/2026-11-12-private-lending-v2/progress.md`, from "## Phase 6"). `docs: v2
  phase 6 verified` (`fb9bee2`) records task 9's checks; after the fix wave the web checks (214
  tests, lint, build, parity, tsc on three configs), clippy and fmt were run again on the final
  head and pass. The e2e and the demo were not run again after the fix wave (it touched only the
  sent-message store, UI wording, the read-back's check order and the nonce check's source).
- **Phase 5's open item is closed:** `docker compose build` (root: api, indexer, migrate; and the
  deployment web image, which builds the wasm with `k256`) passed on the Mac on 2026-11-21, and
  again in phase 6's task 9.
- **Partial repayment:** item 3(a) is in. Phase 7 (item 3(b)) waits until the user brings it back.

## Phase 6: private messages (spec item 6)

**What it built.** Messages between borrower and lender ride in range proofs: the creation's
inside the borrower-signed terms (terms version 2), the acceptance's in the principal output, each
installment's in its installment output and the full repayment's in the repayment output. Signed
messages are BIP340 signatures by the sender's lending key over
`tagged_hash("simplicity-lending/private/v2/message", phase ‖ offer id ‖ field)`, the phase binding
the installment's number. Limits: 2915 bytes at creation, 3068 signed. The web adds a message
field with a UTF-8 byte counter to the proposal, acceptance and repay forms, an IndexedDB store of
sent messages (its own database, `simplicity-lending:sent-messages`, written before the first
broadcast within 3 s, never holding up a payment), the borrower's message in the proposal review,
and a "Messages (n)" timeline per loan in the loan book and My loans. Tasks 1 and 2 took phase 5's
review minors (borrower error wording, one term boundary, the installment's term guard, a
stale-trace cleanup that waits for a finalized spend, the loan read retrying, the liquidation's
expiry check first; witness vectors for the installment and the zero-debt close; the wasm anchoring
the acceptance to the creation; the installment's nonce checked before signing).

**Verification (task 9, `fb9bee2`).** Rust 263 tests and 61 regtest tests, clippy, fmt, the sqlx
prepare check; web 201 tests (214 after the fix wave), parity 304 checks, check:config 48; all 20
e2e stages from an empty state on testnet (blocks 2715260 to 2715273), every message read back by
the party that should read it, the creation's range proof 4174 bytes with a 2915-byte message and
without; the demo; both compose builds; the docs build.

**The whole-branch review** (Opus) found nothing critical or important. Its fix wave took the two
doc items it asked for before merge (the creation message's exception in the guide and
`protocol.md`; phase 6's items 5 to 7 in the plan's "Final manual checks") and, since phase 6 is
v2's last phase, the cheap minors: the sent-message store moved off the scan key-value store
(which a second tab could overwrite) into its own awaited database; the proposal message capped in
height, and a placeholder for a message with no visible text; the repay note worded per kind; a
lone surrogate refused; the read-back checking the amount before the message; the hand-written
transaction parser replaced by the wasm's `inspectPset`; the read error kept on screen across
retries; three doc comments. Its re-review found one new important issue, an unbounded
sent-message write that could hold up a payment, fixed in `26a8677` (a 3 s bound, and the
database's blocked, blocking and terminated cases).

**Rulings made for the user in phase 6.** Each: what was decided, and what it costs if wrong.

- The Jade is not involved: messages are signed by the lending key, which the browser derives
  from the descriptor for Jade wallets too. Cost: none.
- The acceptance's message rides on the principal output only (the spec's table also named the
  active collateral). Cost: the borrower reads it only while the principal's transaction can be
  fetched, which is always.
- The signed phase binds the installment's number, so the lender, who can remake a proof, cannot
  move a borrower's message to another installment. Cost: none.
- Sent messages are kept in IndexedDB, plaintext on the device after a disconnect, like the saved
  transactions (the spec said "as the terms are now", memory only, which would lose them on
  reload). A message the wallet sent from another browser does not show, and the timeline says so.
  Cost: plaintext at rest in the browser profile.
- A malformed creation message (only a borrower building outside the app can make one) fails the
  whole proposal, which the lender then does not see; the borrower can cancel. Cost: such a
  proposal is invisible rather than shown with an unreadable note.
- The message display also removes DEL, tab and CR (only the newline is kept). Cost: tabs show as
  nothing.
- A refused or unreadable installment message never touches the debt: the wasm reads it after
  computing the debt, and the web shows it as unreadable. `readMessage` refuses installments
  (they are read through the loan's state, where the number is known).
- The proposal message sits at the top of the review's notice, below the amounts, and is hidden
  while a saved acceptance is shown. Cost: the lender's rebroadcast view omits it.
- The fix wave took the "can wait" minors (above) rather than carrying them nowhere, and its
  residual important issue was fixed in one more small round rather than left for the user.

**Left for later** (each judged "can wait" by the review; none blocks v2):

- Tests not written: the provider's daily stale-trace gate and `loanSpendDepths` (every fallback
  keeps the trace, the safe direction); `readMessage`'s unreadable path; the debt compared in the
  unreadable-installment test; the builders' lender-key check; a hook test of the lender reading
  the full repayment's message (manual check 6); a `MessageTimeline` component test.
- Stale-trace removals run one after another, and one failure leaves the rest for the next day.
- Each loan row repeats the offer's verification for the repayment message, and mounts its closed
  timeline's hooks.
- `useReadError` keeps a shown error across a change of query key, and while a query is disabled
  (cosmetic).
- `MessageError::Malformed` cannot occur in `SignedMessage::decode` (documented).
- The phase 6 task text in the plan still names the sent store's first API (`kvSentMessages`); the
  code moved to its own database in the fix wave.

The sections from "What phase 5 built" to "Declined by the reviewers" below are phase 5's, kept
as history.

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

1. **Merge phase 6** into `v2/main` (`git merge --no-ff v2/phase-6-messages`) and push.
2. **Final manual checks** by the user, the plan's "Final manual checks" items 1 to 7, in `pnpm
   dev` on testnet; then `v2` may be proposed for `main`.

## Environment (the user's Mac), additions to the 2026-11-16 handoff

- The private lending wasm under `web/src/wasm/private-lending/` is git-ignored output: after
  checking out a branch with wasm changes, run `pnpm build:wasm` before the web tests, or they
  fail at opening an offer.
- The indexer binary is `target/debug/simplicity-lending-indexer`; run it from `crates/indexer`
  so it finds `configuration/`. Something already listens on port 8000; the fix wave's indexer
  API used 8001 (`APPLICATION__PORT=8001`, and `VITE_API_URL=http://localhost:8001
  VITE_ESPLORA_BASE_URL=https://liquid.network/liquidtestnet` for the e2e).
- Databases added: `lending-indexer-phase5-fix`, `lending-indexer-p6t8`,
  `lending-indexer-p6t8-demo{,2,3}`, `lending-indexer-p6t9` and `lending-indexer-p6t9-demo` (all
  free to drop).
- Old e2e states beside `web/.e2e-private/state.json`: `state.pre-p5-mac.json`,
  `state.p5fix-mac.json`, `state.p6t8.json`; keep them. Demo outputs of phase 6's task 8 are in
  `web/.e2e-private/demo-output.p6t8-run{1,2}` (run 2 is the stalled one).
