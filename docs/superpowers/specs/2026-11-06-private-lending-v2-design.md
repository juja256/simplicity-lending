# Private lending v2 — design (draft)

Status: collecting items. Not yet a design; nothing here is decided beyond the item list, except
the decisions recorded in items 3, 4, 5 and 7 to 10 and in "Scope of v2".

Builds on [the v1 design](2026-10-28-private-lending-design.md) and
`crates/contracts/simf/private_lending.simf`.

## Items

1. **Fix the expiry-height leak in the contract.**
   After acceptance, every contract parameter except `LOAN_EXPIRATION_TIME` is public, so an
   observer can recover the expiry by trying heights until the program's hash matches the one
   revealed at the spend. This leaks the loan's duration. Idea raised: a secret 32-byte value,
   derived from the offer's shared secret, used inside the liquidation branch.
   - The leak survives pruning: a spend through accept or repay hides the liquidation branch but
     reveals its CMR, which depends on the expiry. The secret must therefore sit in the same
     pruned subtree as the time check and actually enter its CMR. Equivalent: a parameter
     `H(salt ‖ expiry)` with the expiry and the salt in the liquidation witness.

2. **Fix address reuse in the private flows.**
   The web app always receives at the wallet's first address (`wollet.address(0)`,
   `web/src/providers/wallet/WalletProvider.tsx:381`), so NFTs and claims land on one address
   and explorers flag address reuse. Idea raised: a fresh unused address for each private-flow
   receive. The public flows find a user's loans by that address's script, so they keep it.
   - The NFT outputs are explicit (the contract requires it), so they are the strongest link
     between one user's loans. `wollet.address(null)` (the last unused address) keeps the gap
     limit safe.

3. **Add partial repayment, using Bulletproofs++ (BP++) proofs. Both (a) and (b) are in v2,
   decided 2026-11-12.**
   v1 reserves the partial-repayment branch and always fails it: releasing collateral in
   proportion to a hidden amount needs a zero-knowledge proof.
   - Split in two. (a) Installments only reduce the debt; the collateral stays locked until the
     full repayment. This needs no zero-knowledge proof: pin one asset commitment `A` for every
     repayment output, keep the debt as a point `D = d·A + r·G` in storage, compute
     `D' = D − V_p` with the EC jets, and close with a BIP340 signature under `D_final`, which
     proves it is a multiple of `G` (debt zero). Elements' range proofs bound each `p` below
     `2^64`, so the installments add up to the debt exactly. (b) Releasing collateral in
     proportion needs a BP++ circuit (products of hidden values under different asset
     generators) and the verifier taking commitments from the transaction.
   - Lessons from the public contract's partial repayment, which can lock the collateral forever
     (`docs/security/2026-11-07-public-lending-partial-repayment-lock.md`):
     - each party's exit must not depend on an invariant the other party can break: liquidation
       checks the lender NFT, the time and the active state, never the debt or the collateral
       amount; the final repayment stays reachable from every reachable state;
     - store state instead of recomputing it from history with rounding;
     - if (b) is ever built, release `floor((paid + p)·C/R) − floor(paid·C/R)` in 128-bit
       arithmetic, so the releases add up exactly; inside a proof nobody would see the drift;
     - in (a), an overpayment makes the debt impossible to close (harmless to the lender if
       liquidation ignores the debt; the client must prevent it), and `D − V_p` can be the point
       at infinity, which has no BIP340 key, so closing must handle it separately;
     - a liveness test: random installment sequences, after each of which the full repayment
       and the liquidation (after the term) still succeed.

4. **M-01 of the 2026-11-02 review (acceptance after expiry, then immediate liquidation): no
   change, decided 2026-11-07.**
   Not critical for private loans: only the addressed lender knows the terms and can accept, that
   lender is a counterparty the borrower chose and can identify (signed offers, directory), the
   borrower can cancel at any time, and the user guide documents the behaviour. The app already
   hides acceptance after expiry, and that is enough; a lender building its own transaction
   outside the app can still do it. If this is ever revisited: a liquidation lock relative to
   acceptance must check the active input's own `jet::current_sequence()` and `jet::version() ≥
   2`, not `jet::check_lock_distance` / `check_lock_duration`, which take the maximum relative
   lock over all inputs and are met by any old coin added to the transaction.

5. **Offers to several lenders, one collateral lock. Not in v2, decided 2026-11-12;** borrowers
   pick one lender (item 10).
   Idea raised: the pending offer becomes a taproot tree with one acceptance leaf per lender (and
   a cancellation leaf), each pinning that lender's principal, active collateral and active
   program; the first acceptance wins. Each lender derives its secret from the same collateral
   nonce, so no extra keys go on chain. A lender's safety depends only on its own leaf. Pad the
   tree and the view tags to a fixed size to hide the number of lenders. Every addressed lender
   holds the M-01 option; item 4 covers them all. Pending and active as separate programs
   (instead of the `is_active` slot) make the leaves simple.

6. **Private messages between the parties, carried in range proofs.**
   Every output pinned to a counterparty has a range proof that only the two parties can rewind,
   and its message has room to spare: 3136 bytes after Elements' 64 standard bytes, at the range
   proof parameters already used (`private-lending-core/src/blind.rs:29`), at no extra size on
   chain. v1 already uses this room once, for the terms.
   - Channels, by phase:

     | Phase | Output | From → to | Room |
     |---|---|---|---|
     | Creation | pending collateral (blinded to the lender) | borrower → lender | 3136 bytes minus the terms (about 217) |
     | Acceptance | principal, active collateral (blinded to the borrower) | lender → borrower | 3136 bytes each |
     | Full or partial repayment | repayment output (blinded to the lender) | borrower → lender | 3136 bytes per installment |

     Cancellation, liquidation and claims pay only the spender's own wallet, so they have no
     channel. With item 5, each lender's message goes in its own encrypted section.
   - Encoding: a length-prefixed, versioned field after the existing data (for the creation,
     inside the terms encoding, which bumps its version), UTF-8 text first, with a type byte left
     for later kinds (a contact, an invoice reference). The rest stays zero-padded, so outputs
     with and without a message look the same on chain.
   - Authenticity. Range proofs are output witness data; a signature without
     `SIGHASH_RANGEPROOF` does not commit to them, and either party knows the pinned blinders, so
     it could build a different valid proof for the same commitments. A message is therefore
     signed by its sender's lending key: `tagged_hash("simplicity-lending/private/v2/message",
     phase ‖ offer id ‖ message)`. At creation the message joins the bytes the borrower already
     signs. Messages with a missing or bad signature are shown as unverified or dropped.
   - Sender recovery: the creation message is recoverable by the borrower (deterministic
     ephemeral key). The acceptance and repayment outputs use random nonces, so their senders
     cannot reread them on another device unless the nonce is derived; a derived nonce needs the
     same per-build freshness as the creation (v1's fresh NFT entropy), or two builds would reuse
     it. Open question.
   - The indexer never sees messages; the browser reads them in the same rewind that opens the
     terms or the pinned outputs and caches them per lending key, as the terms are now.
   - App: an optional message field with a byte counter in the create, accept and repay forms
     (`CreatePrivateOfferForm`, `AcceptPrivateOfferModal`, `RepayPrivateOfferModal`); the
     received message in the offer row and the loan view (`PrivateOfferRow`, the lender inbox),
     as a timeline of the loan's messages with the sender's directory name and key fingerprint.
     Show it as plain text: no HTML or Markdown rendering, links not clickable, control and
     bidirectional characters removed, and a note that a message is not part of the terms and
     the contract does not enforce it (it may ask the reader to act outside the protocol).

7. **Merge `origin/main` (BlockstreamResearch/simplicity-lending) before the other code items.**
   Upstream has two commits this project lacks: #190 (manual and background sync share one
   in-flight wallet scan) and #196 (the web app builds on upstream LWK, pinned as the `lwk` git
   submodule and compiled by `web/scripts/build-lwk.sh`, instead of the `@lilbonekit/lwk-web`
   fork). The merge touches the files the other code items change: `WalletProvider.tsx` (item 2)
   and the private flows (items 1, 3, 5 and 6). It therefore goes first.
   - A trial merge (`git merge-tree`, 2026-11-12) conflicts in 12 files: `.dockerignore`,
     `README.md`, `web/README.md`, `deployment/Dockerfile.web`, `web/package.json`,
     `web/src/lwk/index.ts`, `WalletProvider.tsx` and its `types.ts`, the asset-auth and
     script-auth `program.ts`, and the two demo files this project deleted and upstream changed
     (`web/src/pages/Demo/CreateOfferDemo.tsx`, `helpers.ts`). `Dockerfile.web` keeps two Rust
     stages: LWK pins Rust 1.91.0 (`lwk/rust-toolchain.toml`), and `private-lending-wasm` builds
     with the workspace's 1.96.
   - Most of the work is outside the conflicts. In the merged tree, 32 files still import the fork:
     the private flows, the Simplicity bindings they use, and the parity and end-to-end scripts.
     All seven flows (`web/src/privateLending/flows/`) build an unblinded PSET with the fork's
     `TxBuilder` calls (`setInputOrder`, `addExternalUtxos`, `addPostIssuanceScriptOutput`,
     `skipBlinding`), which #196 removed from upstream in favour of `web/src/lwk/psetBuilder.ts`,
     and then blind it with the wasm `blindPset` and the pinned blinders. `psetBuilder.ts` either
     blinds locally or leaves blinding to the wallet, so the port needs a third mode that leaves
     blinding to the caller.
   - Done when `pnpm parity` and `pnpm e2e:private` pass on the merged tree and item 2's reference
     `WalletProvider.tsx:381` points at the merged line (`wollet.address(0)` is at line 353 in
     upstream's version).

Items 8 to 10 were discussed on 2026-11-12. They shift the app from a public lending market to
targeted proposals. Lenders are a few large liquidity providers (banks, hedge funds, ETFs);
borrowers are ordinary users. The demo is for institutional lenders, who should come away
believing three things: they set their own terms and approve every loan, their loan book stays
private (competitors and the public see no amounts, rates or borrowers), and the lender side is a
professional tool. Choices marked *(proposed)* were not discussed and need confirming.

8. **Remove public lending from the whole repository, after item 7.**
   The app offers private lending only. The public code stays readable at a tag and upstream.
   - Before removing anything, tag item 7's merge commit `public-lending-last` and push the tag
     to the fork; `git checkout public-lending-last` brings back the public demo. Upstream keeps
     developing public lending, so after the removal its changes are ported by hand: item 7 is
     the last merge from upstream.
   - Removed:
     - web: the Borrow, Supply and Dashboard pages, the hooks only the public flows use
       (`web/src/hooks/`), and the bindings of the public programs (`web/src/simplicity/lending`,
       `asset-auth-vault`, `issuance-factory`); the Dashboard's private loans card moves to the
       new areas of item 10;
     - indexer: public offers and factories (trackers, endpoints, OpenAPI schemas), and a
       migration that drops their tables;
     - contracts: `lending.simf`, `asset_auth_vault.simf` and `issuance_factory.simf`, their
       programs and tests, and the untracked `crates/contracts/tests/lending_security_audit.rs`;
     - the CLI crate, whose commands (account, factory, issuance) are all public;
     - docs site: the public borrower, lender and protocol pages (`docs/docs/borrower`, `lender`,
       `protocol`, `schemas`) and the pages of the removed contracts in `docs/docs/contracts`.
   - Kept: `private_lending`, and `asset_auth` and `script_auth`, which the private flows use; the
     indexer's shared code, private offers and the directory; `docs/docs/private-loans`; the
     security reports on public lending, which items 3 and 4 cite.
   - The removal goes one layer at a time (web, indexer, contracts, CLI, docs). After each layer
     the workspace builds and `pnpm parity` and `pnpm e2e:private` pass. The migration leaves the
     private tables untouched.
   - Item 2 keeps the first address for the public flows; with them gone, every receive can use a
     fresh address.

9. **Lenders publish their terms in the directory.**
   A borrower does not negotiate: it picks a lender and proposes a loan within that lender's
   published terms. The lender still reviews and accepts each proposal by hand; nothing is
   accepted automatically.
   - A lender registers in the directory with its display name and its terms, one set per asset
     pair *(proposed: a list, though the demo needs only USDt against L-BTC)*:
     - principal asset and collateral asset;
     - minimum APR;
     - reference price, in principal per unit of collateral;
     - minimum collateral ratio at the reference price;
     - term range, in days;
     - principal range.
   - The lending key signs the name and the terms together, as it signs the name now; the signed
     message gets a new version. The entry records when its terms were last published. The
     directory lists lenders only *(proposed)*: an entry without terms is not shown to borrowers,
     and borrowers need no entry.
   - There is no price oracle yet. The lender sets the reference price and keeps it current by
     hand; both areas show when it was last published.
   - The borrower's app does not let a proposal go below the lender's terms: a lower APR, less
     collateral, or a term or principal outside the ranges. This is a convenience, not a guarantee.
     A proposal built outside the app can break the terms, and the contract knows nothing of them.
     The lender's console therefore checks each proposal against the lender's current terms and
     flags the ones outside them. *(Proposed:)* the lender can still accept a flagged proposal
     after an explicit warning.
   - The terms are public: anyone can read a lender's rates. The loans stay private, as in v1.
   - Arithmetic *(proposed)*. v1's `interest_rate_bps` is the interest over the whole term, and the
     contract enforces only the repayment amount, so the APR is derived: `APR = (repayment −
     principal) / principal · 365 / days`, with `days = (expiry height − creation height) / 1440`
     (one-minute blocks). The borrower's app rounds the repayment up. The collateral ratio is
     `collateral · reference price / principal`, in the assets' registry precision. One function
     in `private-lending-core`, exposed through the wasm, serves both areas.

10. **A lender console and a borrower app, on one site.**
    The landing page has two entrances, "For lenders" and "For borrowers", and a link in each
    area's header switches to the other. The route decides the area *(proposed: `/lend` and
    `/borrow`)*; nothing remembers a role. Wireframes from the discussion:
    `2026-11-12-v2-wireframes/` (`site-structure.html`, option A chosen; `lender-console.html`;
    `borrower-app.html`).
    - The lender console is a dense desktop layout with a sidebar. Its header shows the lender's
      directory name, key fingerprint and connected signer. Sections:
      - Proposals: a summary strip (proposals waiting, active loans, amount lent, collateral held,
        loans due within seven days and overdue) and a table of pending proposals (received,
        borrower fingerprint, principal, collateral, ratio at the reference price, APR, term, and
        a "within terms" or "outside terms" badge naming the broken term). Review opens the
        proposal with its terms, its message (item 6) and the acceptance, which the lender signs;
        the app keeps hiding acceptance after expiry (item 4).
      - Loan book: active, repaid and overdue loans, each with the action that applies (claim the
        repayment, liquidate after expiry).
      - Terms: item 9's terms, with "Sign and publish".
      - Profile and key: display name, key fingerprint, and the key to share.
    - The borrower app is a step-by-step flow that also works at phone width *(proposed)*:
      1. Choose a lender: the borrower picks an asset pair, then a lender from the directory,
         each shown with its name, key fingerprint, terms and when they were published.
      2. Proposal: the form opens at the lender's minimums (collateral from the reference price
         and ratio, the APR floor), with the principal and term limited to the lender's ranges,
         and an optional private message (item 6). The borrower can offer more collateral or a
         higher APR, never less. A summary says what they repay and by when, what happens if
         they do not, and that they can cancel until the lender accepts. "Lock collateral and
         send" creates the proposal.
      3. My loans: one row per loan with its status and the one action that applies now (cancel
         while pending, receive the principal after acceptance, repay while active), and the
         loan's messages.
    - The borrower app avoids protocol words ("offer", "NFT", "lending key") *(proposed)*, but
      shows lender key fingerprints so that a borrower can check the counterparty.
    - Out of scope for the demo: several staff accounts per lender, exports and reports, a price
      oracle.

## Scope of v2 (decided 2026-11-12)

- In v2: items 1, 2, 3 (a and b), 6, 7, 8, 9 and 10. Item 4 needs no work beyond item 10's
  console, which keeps hiding acceptance after expiry. Item 5 comes after v2.
- No migration: the app knows only the v2 contract, and loans made on testnet with v1 are
  dropped.
- Items 1 and 3(a) both change `private_lending.simf`, so they share one contract revision: the
  program's CMR, the parity script and the end-to-end run change once. Item 3(b) needs a research
  spike first and gets a second revision if it is feasible; with no migration, a second revision
  costs only another parity and end-to-end run.
- Item 6's creation message changes the terms encoding. Item 1's salt changes it too only if the
  salt is carried in the terms instead of derived from the offer's shared secret; if so, the two
  share one version bump.

## Open questions

- What a borrower decides when making a partial repayment, and what they get back. (With 3(a):
  only the amount, and nothing until the full repayment; with 3(b): the amount and the
  collateral released within the proportion.)
- Where the per-lender sections of item 5 live: the collateral range proof with a wrapped viewing
  key in the marker, OP_RETURN (check Elements' relay limits), or the indexer as a mailbox of
  ciphertexts.
- Whether message senders must be able to reread their messages on another device (item 6).
- Whether LWK and Jade sign with `SIGHASH_RANGEPROOF`; if they do, item 6's signatures still
  name the sender but are no longer needed against malleation. Checked 2026-11-12 for LWK at
  `7f8c8213`: its software signer signs only the default sighash unless its policy allows another,
  and nothing in `lwk_signer` handles `SIGHASH_RANGEPROOF`, so item 6's signatures are needed.
  The Jade is unchecked.
