# Private lending v2 — design (draft)

Status: collecting items. Not yet a design; nothing here is decided beyond the item list, except
the decisions recorded in items 3, 4, 5 and 7 to 10, in "Scope of v2", in "Phase 5 design note"
and in "Phase 7 design note".

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
   `web/src/providers/wallet/WalletProvider.tsx:397`), so NFTs and claims land on one address
   and explorers flag address reuse. Idea raised: a fresh unused address for each private-flow
   receive. The public flows find a user's loans by that address's script, so they keep it.
   - The NFT outputs are explicit (the contract requires it), so they are the strongest link
     between one user's loans. `wollet.address(null)` (the last unused address) keeps the gap
     limit safe.

3. **Add partial repayment, using Bulletproofs++ (BP++) proofs. (a) is in v2; (b) is postponed
   until the user brings it back, decided 2026-11-14 (it was in v2 from 2026-11-12).**
   The demo repays in installments without releasing collateral: (a) needs no zero-knowledge
   proof and keeps the contract small.
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
   - A feasibility spike for (b) ran on 2026-11-21 (`2026-11-21-phase-7-spike/note.md`): buildable
     with Sigma proofs and consensus range proofs plus a liquidation repair, about 43,000 WU per
     installment. The user resumed (b) the same day; the phase 7 design note (below) builds it.
   - The phase 5 design note (below) builds (a). It closes the loan by equality instead of the
     BIP340 signature under `D_final`, and by revealing the blinder `k` of `D = k·G` when the debt
     is already zero, decided 2026-11-18.
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
     pair. The data holds a list; the demo shows one pair, tL-BTC collateral against TEST
     principal on testnet, set in the web app's build configuration rather than in code
     (decided 2026-11-14):
     - principal asset and collateral asset;
     - minimum APR;
     - maximum principal per unit of collateral, a number the lender sets by hand (decided
       2026-11-14, in place of a reference price and a minimum collateral ratio: with no price
       oracle the price would only be what the lender typed, and the two numbers act as one);
     - term range, in days;
     - principal range.
   - The lending key signs the name and the terms together, as it signs the name now; the signed
     message gets a new version. The entry records when its terms were last published. The
     directory lists lenders only *(proposed)*: an entry without terms is not shown to borrowers,
     and borrowers need no entry.
   - There is no price oracle yet. The lender sets the maximum principal per unit of collateral
     and keeps it current by hand; both areas show when the terms were last published.
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
     (one-minute blocks). The borrower's app rounds the repayment up. The collateral term is
     stored as principal base units per 10^8 collateral base units (per 1 tL-BTC on testnet); the
     least collateral for a principal is rounded up. One function in `private-lending-core`,
     exposed through the wasm, serves both areas.

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
        borrower fingerprint, principal, collateral, principal per unit of collateral, APR, term,
        and a "within terms" or "outside terms" badge naming the broken term). Review opens the
        proposal with its terms, its message (item 6) and the acceptance, which the lender signs;
        the app keeps hiding acceptance after expiry (item 4).
      - Loan book: active, repaid and overdue loans, each with the action that applies (claim the
        repayment, liquidate after expiry).
      - Terms: item 9's terms, with "Sign and publish".
      - Profile and key: display name, key fingerprint, and the key to share.
    - The borrower app is a step-by-step flow that also works at phone width *(proposed)*:
      1. Choose a lender: the borrower picks an asset pair, then a lender from the directory,
         each shown with its name, key fingerprint, terms and when they were published.
      2. Proposal: the form opens at the lender's minimums (the least collateral computed from the
         maximum principal per unit of collateral, rounded up, as decided 2026-11-14; the APR
         floor), with the principal and term limited to the lender's ranges,
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

- In v2: items 1, 2, 3(a), 6, 7, 8, 9 and 10. Item 4 needs no work beyond item 10's console,
  which keeps hiding acceptance after expiry. Item 5 comes after v2. Item 3(b) is postponed until
  the user brings it back (decided 2026-11-14).
- No migration: the app knows only the v2 contract, and loans made on testnet with v1 are
  dropped.
- Items 1 and 3(a) both change `private_lending.simf`, so they share one contract revision: the
  program's CMR, the parity script and the end-to-end run change once. Item 3(b), when it comes
  back, needs a research spike first and gets a second revision if it is feasible; with no
  migration, a second revision costs only another parity and end-to-end run.
- Item 6's creation message changes the terms encoding. Item 1's salt changes it too only if the
  salt is carried in the terms instead of derived from the offer's shared secret; if so, the two
  share one version bump.

## Phase 5 design note: the contract revision (items 1 and 3(a))

Decided with the user on 2026-11-18; this note is the gate of the plan's phase 5. It keeps items 1
and 3(a) as written except in how the loan closes: by equality, or by revealing the debt's blinder
when the debt is already zero (below), not by a BIP340 signature under `D_final`.

### Notation

- `G` is the generator of secp256k1 and `n` its order.
- `A` is the asset commitment of v1's pinned repayment output: the principal asset's generator,
  blinded with the derived `repayment-abf`. In v2 every repayment output, installment or full,
  carries exactly `A`.
- The debt is the point `D = d·A + r·G`, where `d` is the amount still owed in principal base units
  and `r` its blinder. At acceptance, `D₀ = R·A + r₀·G` is the value commitment of v1's pinned
  repayment output: `R` is the full repayment and `r₀` the derived `repayment-vbf`.
- `h(A, D)` is the SHA-256 of the consensus encodings of `A` and `D`, which `jet::asset_amount_hash`
  computes for an output that carries them. `h(A, D₀)` is v1's `REPAYMENT_COMMITMENT`.
- `c` is the collateral amount. `A_c` and `V_c` are the active collateral's asset and value
  commitments, and `a_c` and `r_c` their blinders.
- An installment is a repayment that leaves part of the debt; the full repayment pays what is left
  and closes the loan.

### The program

`private_lending.simf` stays one program with v1's two storage slots: whether the offer is active,
and the debt. The debt slot holds `h(A, D)` for the current debt, the commitment hash of an output
that repays everything still owed. It is `h(A, D₀)` from creation until the first installment, and
every installment rewrites it.

| v1 parameter | v2 |
|---|---|
| `LOAN_EXPIRATION_TIME` | `EXPIRY_HASH`, see "Item 1" |
| `REPAYMENT_COMMITMENT` | unchanged: `h(A, D₀)`, also the starting debt |
| (none) | `REPAYMENT_ASSET`: `A`, in its consensus encoding |
| (none) | `INSTALLMENT_OUTPUT_SCRIPT_HASH`: `asset_auth` of the lender NFT without burn |
| the others | unchanged |

Both new parameters derive from the lender NFT and the pinned repayment output, so the lender's
existing check of the offer's address covers them.

The witness keeps v1's path; the reserved partial-repayment branch becomes the installment branch.
Each branch fixes the first inputs and outputs, and the transaction adds fee inputs, change and the
receiver of what is released:

| Branch | Inputs | Outputs | Witness |
|---|---|---|---|
| Acceptance | 0 pending offer, 1 lender NFT | 0 active offer, 1 principal, 2 lender NFT | none |
| Cancellation | 0 pending offer, 1 lender NFT, 2 borrower NFT | 0 and 1 burn both NFTs | none |
| Installment | 0 borrower NFT, 1 loan | 0 borrower NFT, 1 loan, 2 installment | `D` |
| Full repayment | 0 borrower NFT, 1 loan | 0 borrower NFT burn, 1 repayment | `h` |
| Zero-debt close | 0 borrower NFT, 1 loan | 0 borrower NFT burn, 1 `OP_RETURN` of `k` | `D`, `k` |
| Liquidation | 0 loan, 1 lender NFT | 0 lender NFT burn | `h`, salt, expiry |

Acceptance and cancellation are v1's. The other four branches check:

- **Installment**, run by the loan input at index 1:
  1. Input 1's script hash is the storage address (active, `h(A, D)`). This authenticates the
     witness's `D`.
  2. The borrower NFT passes from input 0 to output 0, explicit and of amount 1, as the lender NFT
     passes at acceptance.
  3. Output 2's script hash is `INSTALLMENT_OUTPUT_SCRIPT_HASH` and its asset commitment is `A`.
     Call its value commitment `V`.
  4. `D' = D − V` is not the point at infinity.
  5. Output 1's script hash is the storage address (active, `h(A, D')`).
  6. Output 1 carries input 1's collateral: its asset commitment is input 1's plus `G`, and its
     value commitment equals input 1's byte for byte.
- **Full repayment**, run at index 1:
  1. Input 1's script hash is the storage address (active, `h`).
  2. The borrower NFT is burned in output 0.
  3. Output 1's script hash is `REPAYMENT_OUTPUT_SCRIPT_HASH` and its commitment hash is `h`.
- **Zero-debt close**, run at index 1:
  1. Input 1's script hash is the storage address (active, `h(A, D)`), with `D` the witness's
     point in its Elements encoding.
  2. The borrower NFT is burned in output 0.
  3. Output 1 is exactly `OP_RETURN <k>`, one 32-byte push of the witness's `k`, with `0 < k < n`
     (`k` is not reduced modulo `n`). Simplicity reads an `OP_RETURN`'s data only as a hash, so the
     witness carries `k`, and the program compares output 1's script hash with that of
     `OP_RETURN <k>`.
  4. `k·G` has the x-coordinate of `D` (`jet::generate`, then `jet::gej_x_equiv`).
- **Liquidation**, run at index 0:
  1. Input 0's script hash is the storage address (active, `h`) for the witness's `h`, which shows
     only that the loan is active.
  2. `SHA-256(salt ‖ expiry) = EXPIRY_HASH`, and `jet::check_lock_height(expiry)`.
  3. The lender NFT is burned in output 0.

v1's full repayment and liquidation also compared the loan input's commitment with
`ACTIVE_COLLATERAL_COMMITMENT`. v2 drops that check, because installments move the collateral's
commitment. Liquidation therefore reads neither the debt nor the collateral, as item 3's lessons
require.

### Item 1: the hidden expiry

`EXPIRY_HASH = SHA-256(salt ‖ expiry)`, with the expiry as a 4-byte big-endian block height and the
salt derived from the offer's shared secret (`derive("expiry-salt")` in `OfferSecrets`). Both
parties derive the salt, so the terms encoding does not change; the terms still carry the expiry,
encrypted to the lender.

A spend through any branch but liquidation prunes the liquidation branch and reveals its CMR. That
CMR commits to `EXPIRY_HASH` but not to the salt or the expiry, which are witness values and do
not enter a CMR. An observer who tries candidate heights against the CMR therefore needs the salt, a
256-bit value derived from the borrower's and the lender's ECDH secret. The liquidation itself
reveals the expiry in its witness and its lock time, when the loan has ended.

### Item 3(a): installments

**The debt adds up exactly.** Elements verifies each installment's range proof against `A`, so the
installment pays the lender some amount `p_i < 2^64` of the principal asset. After `k` installments
the debt is `D_k = (R − Σp_i)·A + (r₀ − Σr_i)·G`, with `r_i` the installments' value blinders. The
full repayment's output must equal `D_k` as a point, and its range proof bounds its amount `d_f`
below `2^64`. Nobody knows the discrete logarithm of `A` to base `G`, so the equality forces
`Σp_i + d_f ≡ R (mod n)`. The sum is non-negative and below `(k + 1)·2^64`, far below `n` for any
feasible `k`, so the lender receives exactly `R` in total.

**The loan closes by equality while debt remains.** With `d ≥ 1`, the full repayment's output is
`D` itself: the borrower builds it with amount `d` and blinder `r`, which they know. Item 3(a)
proposed an output with any blinder and a BIP340 signature under `D − V`. That signature proves the
same fact, because its key `r − r_f` requires knowing `r`, and it would cost an EC subtraction, the
encoding conversions, a signature check and a separate branch for the point at infinity. Under
equality, `D − V` is the point at infinity exactly when the loan closes, so that case needs no
branch. An installment that would reach it is refused (check 4), because the point at infinity has
no encoding to store.

**The zero-debt close.** Equality cannot close a loan whose debt is already zero. An installment of
exactly `d` with a blinder other than `r` leaves `D' = (r − r_p)·G`, and closing it by equality
would need a confidential output of amount zero. Elements rejects a spendable output whose range
proof allows zero, and rust-elements proves a minimum of 1 (`TxOut::RANGEPROOF_MIN_VALUE`). Item
3(a)'s signature under `D − V` fails there too, because any payment `V` carries at least 1.
- The zero-debt close therefore has no repayment output: the borrower burns the borrower NFT and
  reveals the debt's blinder `k = r − r_p` in an `OP_RETURN` at output 1.
- A `k` with `k·G = ±D` exists only when no debt remains: otherwise `k` would reveal the discrete
  logarithm of `A` to base `G`. Comparing x-coordinates accepts `k` and `−k` alike, and the
  x-coordinate is the same in Elements' encoding and on the curve, so the check needs no encoding
  conversion. Of the two, the borrower reveals whichever it likes.
- The revealed `k` lets the lender sweep after a zero-debt close; see "The final claim sweeps with
  the combined opening". A signature under `D` would prove the same fact without revealing `k`,
  and then the lender could never spend an installment it cannot open, at no cost to the borrower.
- Revealing `k` is safe. The close needs the borrower NFT, so nobody else can build another close
  from it, and once the loan is closed `k` opens nothing that holds value.
- The app never builds the zero-debt state, because an amount equal to the remaining debt becomes
  the full repayment. The close exists so that a hand-built installment does not cost the borrower
  the collateral. *(My call:)* the borrower app offers the zero-debt close for a loan whose rebuilt
  debt is zero.

**Overpayment.** The contract cannot see amounts. An installment of `p > d` leaves `d − p` modulo
`n`, near `2^256`: no output can pay it and no key signs for it, so the loan can no longer close,
and the lender liquidates it after the term. The client refuses such an installment.

**The collateral moves at every installment.** An installment spends the loan output and creates
its successor, and the successor's asset commitment must differ from the input's: secp256k1-zkp
refuses a surjection proof when any input's asset commitment equals the output's (a comment in
`surjectionproof_generate` notes this is deployed on Liquid and needs a hard fork to change).
Acceptance moves from the pending to the active commitment for the same reason. Each installment
re-blinds the collateral by a public step, asset blinder `a_c + 1` and value blinder `r_c − c`:

```
A_c' = A_c + G
V_c' = c·A_c' + (r_c − c)·G = c·A_c + r_c·G = V_c
```

Check 6 needs one point addition and one byte comparison, and it proves the same asset and amount
without opening the output. `A_c' − A_c = G` keeps the asset tag. An identical value commitment
under `A_c'` forces the same amount `c`, because a different amount would reveal the discrete
logarithm of `A_c` to base `G`. After `i` installments the collateral's blinders are
`(a_c + i, r_c − i·c)`, which both parties compute from the shared secret, `c` and the number of
installments on chain. The value commitment stays one point for the whole loan and links its states;
the covenant links them already.

The alternative was a separate small output holding the debt, so that the collateral never moves.
It needs an extra output at acceptance and a second set of branches, and it leaves a dust output
after a liquidation. It was not chosen.

**Each party keeps an exit.** The lender's exit, liquidation, checks the lender NFT, the time and
the active state, so no installment or overpayment can block it. The borrower's exit stays
reachable from every state without an overpayment: the full repayment while debt remains, the
zero-debt close when none does.

### Elements commitments in Simplicity

The installment branch computes with points the transaction carries, and Elements encodes them
differently from Simplicity. secp256k1-zkp serializes an asset generator with the prefix
`11 ^ is_square(y)` (`0x0a` or `0x0b`) and a value commitment with `9 ^ is_square(y)` (`0x08` or
`0x09`), so the prefix's low bit says whether `y` is a quadratic residue (secp256k1-zkp-sys 0.10.1,
`generator/main_impl.h`). Simplicity's Elements environment passes that bit on as the `u1` of a
confidential asset or amount, and `jet::decompress` reads a point's `u1` as the parity of `y`.
Decompressing an Elements commitment directly therefore yields the negated point for about half of
all commitments.

- To read a commitment, decompress its x-coordinate and negate the point when the square-ness of
  `y` disagrees with the bit; bit 0 means `y` is a square. Because `p ≡ 3 (mod 4)`, exactly one of
  `y` and `−y` is a square, so the bit fixes the point.
- To write a point as a commitment, as for `D'` and `A_c + G`, set the bit to 1 exactly when `y`
  is not a square.
- An installment tests square-ness for `D`, `V`, `D'` and the two collateral asset commitments.
  Each test is a `jet::fe_square_root`, or one `jet::fe_square` against a root supplied in the
  witness (`s² = y`, or `s² = −y` when `y` is not a square).

### Off chain

**Both parties rebuild the debt from the chain.** Each installment output carries the lender's
blinding key, as the repayment output does now, and an ephemeral key that the borrower derives
instead of drawing it, so that both parties can rewind its range proof and read its amount and
value blinder. *(Builder's call, proposed:)* the key derives from the borrower's lending key, the
loan outpoint the installment spends and the installment's first wallet input, after the
creation's `ephemeral_key`. A borrower who loses `d` and `r` cannot close the loan and loses the
collateral at liquidation, so the borrower must rebuild both from the seed alone. The derived key
also answers item 6's sender-recovery question for repayments.

The lender also tracks the debt as a point, `D_k = D_{k−1} − V_k` from `D₀` and the installments'
value commitments, with the conversions of "Elements commitments in Simplicity". Liquidating needs
`h(A, D)` for the storage it spends, so the lender's exit must not depend on opening every
installment.

Two builds of one installment with the same inputs and different amounts would reuse the range
proof's nonce, which can leak the amounts if both builds become public. The app rebroadcasts a
saved build instead of rebuilding it, as it does for creations and acceptances.

**Client rules.**
- The borrower's amount decides the branch: below the remaining debt, an installment; equal to it,
  the full repayment; zero or above it, refused.
- Before paying, the borrower checks that the loan input carries the expected collateral
  commitments, `A_c + i·G` and `V_c`. Anyone can send an output to a loan's address, and paying
  against such an output buys nothing. The lender checks the same before it liquidates.
- The lender claims an installment by presenting the lender NFT, which returns to the lender in the
  same transaction, one installment at a time or several together. Claiming the full repayment and
  liquidating both burn the lender NFT, after which an unclaimed installment can never be spent,
  so both transactions also sweep every unclaimed installment. The no-burn lock accepts the burn
  output as the NFT's output.

**The final claim sweeps with the combined opening.** A borrower who builds their own transactions
can make installments whose range proofs the lender cannot rewind. The lender cannot spend such an
output alone, because balancing a transaction needs each input's opening. A final claim that left
those installments out would burn the lender NFT and strand them, a loss to the lender that costs
the borrower nothing beyond an honest repayment. The combined opening avoids this.
- All repayment outputs of a loan, the installments and the full repayment, add up to `D₀`, whose
  opening `(R, r₀)` the lender knows. The final repayment and every unclaimed installment
  therefore add up to `(R − Σ claimed p, r₀ − Σ claimed r)`.
- After a zero-debt close the installments alone add up to `D₀ − D`, where `D = k'·G` is the debt
  the close spent and `k'` is the revealed `k` or `−k`, whichever gives `D`. The unclaimed ones
  then add up to `(R − Σ claimed p, r₀ − Σ claimed r − k')`, and the lender's final claim sweeps
  them with that opening.
- They all carry the asset commitment `A`, so a transaction's balance depends only on that sum.
  The final claim gives one of these inputs the combined opening and the others an amount and
  value blinder of zero.
- The final claim always sweeps every unclaimed installment this way, so the lender receives `R`
  in full whatever the borrower's range proofs hold.
- Until the final claim, the console marks an installment it cannot open "amount unknown",
  claimable only at the final claim, and shows the remaining debt as at most `R` minus the amounts
  it opened.
- A liquidation has no combined opening, because the remaining debt's opening is unknown, so it
  sweeps only the installments that open. An installment that does not open stays stranded, a loss
  to the borrower who built it.
- A borrower who makes an installment that their own app cannot rewind can no longer rebuild `d`
  and `r` and cannot close the loan; the app never builds one.
- Whether a Jade signs a claim that sweeps with the combined opening joins the plan's final manual
  checks.

**The indexer.** Today the indexer reads an active offer's spend from output 0: a burned borrower
NFT is a repayment, anything else a liquidation, so it would read an installment as a liquidation.
In v2 a burned borrower NFT is the full repayment, a burned lender NFT a liquidation, and an
unburned borrower NFT an installment. An installment moves the active offer to output 1 and adds
the installment at output 2, a new kind of UTXO that the API serves. The zero-debt close also burns
the borrower NFT but has no repayment output: the indexer tells it from the full repayment by its
output 1, an `OP_RETURN`. The plan's file list for phase 5 omits the indexer, but it is in scope.

**The app.**
- The borrower's repay form takes an amount and shows the amount paid so far and the remaining
  debt. It states that installments are not refunded if the loan is liquidated.
- The lender's loan book shows each loan's repaid amount, remaining debt and claimable
  installments, with a claim action. The console counts the debt from the installments it opens,
  as described under "The final claim sweeps with the combined opening".

### Done when

The plan's done-when, made concrete:

- Item 1: with the expiry fixed, a different salt changes the CMR revealed at acceptance and at the
  full repayment; recomputing that CMR from the public parameters over a range of candidate
  expiries, with no salt or a guessed one, matches none; a liquidation with a wrong salt or expiry
  fails, and so does one before the expiry.
- Item 3(a), in the contract tests:
  - installments succeed with `D`, `V`, `D'` and the collateral commitments of both prefix bits;
  - an installment fails with another asset commitment or script on output 2, another successor
    storage, a successor collateral with any other commitment, a result at the point at infinity,
    or no borrower NFT;
  - a full repayment fails with any other commitment;
  - a liveness property test runs random installment sequences, and after each one the full
    repayment and the liquidation after the term both succeed;
  - a zero-debt state, reached by an installment of the exact remaining debt with another
    blinder, closes with the zero-debt close whether it reveals `k` or `−k`; the zero-debt close
    fails while debt remains, with a `k` of another point, with `k = 0`, and without the
    `OP_RETURN`;
  - the installment branch runs within the transaction's cost budget.
- The client refuses an overpayment (a core or web test).
- A final claim sweeps installments whose range proofs the lender cannot rewind, balanced by the
  combined opening, and the transaction is valid (a contract test on the regtest node, with two
  such installments, after a full repayment and after a zero-debt close).
- The lender computes the storage of a loan whose installments it cannot open, and liquidates it.
- `pnpm parity` and every e2e stage pass, including a new `repay-partial` stage: an installment, its
  claim, and the full repayment whose claim sweeps an unclaimed installment.

### Left to the builder

- The witness encoding of `D` (Elements' encoding, or an affine point checked to be on the curve),
  and how to test square-ness.
- Where the zero-debt close sits in the witness path, for example as a second case inside the
  full-repayment branch.
- The labels and tags of the new derived values, and whether they keep the `v1/` prefix; with no
  migration, a change costs only the known-answer tests.
- Each installment's value blinder, random or derived; the rewind recovers it either way.
- The indexer's schema and API for installments.
- Whether a testnet e2e stage liquidates a loan with installments (using a short term, like
  `short-proposal`) or the contract tests alone cover it.

Phase 5 also rewrites the header comment of `private_lending.simf`, removes the dead features
`lending` and `pre_lock`, and takes the phase 4 review's items that name phase 5 (listed in the
2026-11-16 handoff).

## Phase 7 design note: proportional collateral release (item 3(b))

Decided with the user on 2026-11-21, after the spike (`2026-11-21-phase-7-spike/note.md`, route C
with the liquidation repair). This note is the binding design of phase 7.

The user's decisions:

- route C, with the liquidation repair;
- the lender caps the collateral at `2^44` base units when it accepts;
- one carry token per loan, issued by the creation transaction;
- the zero-debt close is removed;
- the soundness proofs are written first.

Where the spike note and this note differ, this note wins. Section "What this note decides beyond
the spike" lists the differences.

It keeps the phase 5 design note except where it says otherwise. In particular these stay:

- the debt as a point;
- the closing by equality;
- the full repayment;
- the liquidation;
- the encoding conversions of "Elements commitments in Simplicity";
- the final claim with the combined opening.

### Notation

Phase 5's notation holds: `G`, `n`, `A`, `D = d·A + r·G`, `D₀ = R·A + r₀·G`, `h(A, D)`. Points are
group elements of secp256k1. "The point of" a commitment means the curve point read from Elements'
encoding with phase 5's square-ness rule.

- **`C`** is the collateral amount, and **`R`** the full repayment, both in base units.
- **`A_c`** is the active collateral's asset commitment: the collateral asset's generator blinded
  with `a_c`, the derived `active-collateral-abf`.
- **`V_c0 = C·A_c + ρ·G`** is its value commitment at acceptance, with `ρ` the derived
  `active-collateral-vbf`.
- **The step `k`** of a loan is the number of installments it has had, so step 0 is acceptance. At
  step `k` the loan output's asset commitment is `A_c + k·G`, as in phase 5.
- **`d_k`, `r_k`** open the debt `D_k` at step `k`, and `c_k` is the collateral it holds.
- **The release rule.** At every step,

  ```
  c_k = ceil(d_k·C / R)         and   e_k := c_k·R − d_k·C   with   0 ≤ e_k ≤ R − 1.
  ```

  - With `paid_k = R − d_k`, the collateral released so far is
    `C − c_k = floor(paid_k·C / R)`.
  - Installment `k` releases `c_(k−1) − c_k`, which can be 0.
  - The full repayment releases `c_k`.
- **The carry token** is the asset that the creation transaction issues for the loan, `S = 2^50`
  units. **`W1_k`** and **`W2_k`** are the two carry outputs of installment `k`. They hold
  `e_k + 1` and `R − e_k` carry units, and their asset commitments are `A_w1` and `A_w2`.
- **`J`** is a fixed point whose discrete logarithm nobody knows (below).
- **The blinder commitments.** For `j = 1..N` with `N = 1024`, the per-step blinders are `x_j`
  and `y_j` (below), and the blinder commitment is

  ```
  Y_j = x_j·G + y_j·J.
  ```
- **The collateral at step `k ≥ 1`** has:
  - asset blinder `a_c + k`;
  - value blinder `x_k − c_k·k` (mod `n`).

  Its value commitment is therefore `V_k = c_k·(A_c + k·G) + (x_k − c_k·k)·G = c_k·A_c + x_k·G`.
- **Encodings.**
  - "The `x ‖ y` of a point" is its affine coordinates as two 32-byte big-endian words.
  - "`compress(h, a, b)`" is the SHA-256 compression function (`jet::sha_256_block`) with
    chaining value `h` and the 64-byte block `a ‖ b`, with no padding and no length.
  - "`derive(label)`" is `OfferSecrets::derive`, a tagged hash of the shared secret under the tag
    `simplicity-lending/private/v1/<label>`.
  - "`scalar(b)`" is the 32 bytes `b` read big-endian and reduced modulo `n`.

### The statement

An installment at step `i` creates step `i + 1`. The program proves, for the transaction it runs in:

> the successor holds `c' = ceil(d'·C/R)`, where `d'` is the amount of `D' = D − V`, and the
> successor's value commitment is `c'·A_c + x_(i+1)·G`.

It does so with a Sigma proof of knowledge of eleven secrets: `C, ρ, c', x, y, e, w1, R, r₀, w2, τ`.
Each secret has one response, and that response is shared by every equation the secret appears in:

```
E1  V_c0      = C·A_c + ρ·G
E2  V_s       = c'·A_c + x·G
E3  Y         = x·G + y·J
E4  W1 − A_w1 = e·A_w1 + w1·G
E5  D₀        = R·A + r₀·G
E6  W2        = (R − e)·A_w2 + w2·G
E7  0         = c'·D₀ − C·D' − e·A − τ·G
```

**The statement's points come from three places:**

- **Parameters:** `A`, `A_c`, `V_c0` and `D₀`. `J` is a constant.
- **Introspection:**
  - `V_s` is output 1's value commitment.
  - `W1`, `A_w1` and `W2`, `A_w2` are outputs 3 and 4's value and asset commitments.
  - `D' = D − V` is computed from the witness's `D` (authenticated by the storage) and output 2's
    value commitment `V`.
- **The witness:** `Y`, authenticated by the Merkle root (equation M).

**What the honest borrower knows:**

- `x = c'·(i+1) + r_s = x_(i+1)`, with `r_s` the successor's value blinder.
- `y = y_(i+1)`.
- `e = e_(i+1)`.
- `w1` and `w2`, the carries' value blinders.
- `τ = c'·r₀ − C·r'`, with `r'` the blinder of `D'`.

**Equation M (the repair).** For a witness index `i` with `0 ≤ i ≤ 1023`, `Y` is the leaf at
position `i` of the tree whose root is the parameter `BLINDER_ROOT`. So `Y = Y_(i+1)`. Together
with the index check (the input's asset commitment is `A_c + i·G`), M fixes which committed
blinder the successor must use.

**The integer argument (for the proofs).** These bounds hold:

| Value | Bound | Why |
|---|---|---|
| `C` | `[1, 2^44]` | the lender's check at acceptance |
| `R` | `[1, 2^50 − 2]` | the lender's check at acceptance |
| each payment `p` | `[1, 2^64)` | consensus |
| `c'` | `[1, 2^64)` | consensus; output 1 has a spendable script |
| carry amounts | `[1, 2^64)` | consensus; outputs 3 and 4 have a pinned spendable script |
| steps | at most 1024 | the Merkle tree has 1024 leaves |

- The minimum of 1 comes from `CachingRangeProofChecker::VerifyRangeProof` for spendable scripts.
- The maximum comes from `secp256k1_rangeproof_getheader_impl`.

What follows from them:

- The amount of `D'` is `d' = R − Σp` over the integers, with `|d'| < 2^75`.
- E4 and E6 give `e ≡ amount(W1) − 1` and `R − e ≡ amount(W2) (mod n)`, so `0 ≤ e ≤ R − 1` over
  the integers.
- The coefficient of `A` in E7 is `c'R − d'C − e`, at most `2^121` in absolute value, so E7 holds
  over the integers.
- Therefore `c' = ceil(d'C/R)`. An installment with `d' ≤ 0` is impossible, because it would need
  `c' ≤ 0`.

The argument needs the discrete logarithms of `A`, `A_c`, `A_w1`, `A_w2` and `J` to base `G` to be
unknown. Surjection proofs give that for the asset commitments, and the NUMS derivation gives it for
`J`.

**The verification equations.** The prover sends the commitments `T1..T7` and the responses `z_C,
z_ρ, z_c', z_x, z_y, z_e, z_w1, z_R, z_r₀, z_w2, z_τ`, in that order. With the challenge `c`, the
program checks:

```
V1  z_C·A_c  + z_ρ·G  = T1 + c·V_c0
V2  z_c'·A_c + z_x·G  = T2 + c·V_s
V3  z_y·J    + z_x·G  = T3 + c·Y
V4  z_e·A_w1 + z_w1·G = T4 + c·(W1 − A_w1)
V5  z_R·A    + z_r₀·G = T5 + c·D₀
V6  (z_R − z_e)·A_w2 + z_w2·G = T6 + c·W2
V7  z_c'·D₀  − z_τ·G  = T7 + z_C·D' + z_e·A
```

- Each line is one `jet::linear_verify_1`, which checks `a·P + b·G = Q`. The right-hand side is
  built with `jet::scale`, `jet::gej_ge_add` and `jet::gej_normalize`.
- The honest commitments are, with nonces `k_•`:
  - `T1 = k_C·A_c + k_ρ·G`
  - `T2 = k_c'·A_c + k_x·G`
  - `T3 = k_x·G + k_y·J`
  - `T4 = k_e·A_w1 + k_w1·G`
  - `T5 = k_R·A + k_r₀·G`
  - `T6 = (k_R − k_e)·A_w2 + k_w2·G`
  - `T7 = k_c'·D₀ − k_C·D' − k_e·A − k_τ·G`
- The responses are `z_• = k_• + c·secret`.
- The witness carries `T1..T7` and `Y` as affine points. The program checks each one with
  `jet::ge_is_on_curve` before using it.
- The responses need not be below `n`: the jets reduce them.

**The Fiat–Shamir challenge.**

```
h₀  = FS_IV                                   (a parameter, below)
h₁  = compress(h₀,  D'.x,   D'.y)
h₂  = compress(h₁,  V_s.x,  V_s.y)
h₃  = compress(h₂,  W1.x,   W1.y)
h₄  = compress(h₃,  A_w1.x, A_w1.y)
h₅  = compress(h₄,  W2.x,   W2.y)
h₆  = compress(h₅,  A_w2.x, A_w2.y)
h₇  = compress(h₆,  Y.x,    Y.y)                (the statement ends here)
h₈ … h₁₄ = compress(h₇ …, Tj.x, Tj.y)  for j = 1..7, in order
c   = scalar(h₁₄)                               (jet::scalar_normalize)
```

The points are the curve points, not their Elements encodings.

`FS_IV` is per loan:

```
FS_IV = SHA-256( "simplicity-lending/private/v1/release-fs" ‖ A ‖ A_c ‖ V_c0 ‖ D₀ ‖ J )
```

where each point is its `x ‖ y`. It binds the challenge to every constant of the statement. The
lender recomputes it, as it recomputes every parameter.

**The Merkle tree.**

- `LEAF_IV = SHA-256("simplicity-lending/private/v1/release-leaf")`, and
  `NODE_IV = SHA-256("simplicity-lending/private/v1/release-node")`. Both are constants of the
  program.
- Leaf `j`, for `j = 0..1023`, is `compress(LEAF_IV, Y_(j+1).x, Y_(j+1).y)`.
- A node is `compress(NODE_IV, left, right)`.
- The depth is 10, and `BLINDER_ROOT` is the root.
- The witness path lists 10 pairs `(is_right, sibling)` from the leaf up. `is_right` is bit `k` of
  the index at level `k`.
- The program folds the path with `array_fold::<_, 10>`. It rebuilds the index from the bits and
  requires it to equal the witness's `i`.

**`J`.**

- For `t = 0, 1, …`, let `X_t = SHA-256("simplicity-lending/private/v1/release-J" ‖ t)`, with `t`
  as 4 big-endian bytes.
- `J` is the point with x-coordinate `X_t` and even `y`, for the first `t` at which such a point
  exists.
- It is a constant of the program. A known-answer test fixes its value.

**Derivations.**

- **`x_j = scalar(derive("release-x/<j>"))`** and **`y_j = scalar(derive("release-y/<j>"))`**,
  where `<j>` is `j` in decimal ASCII (`release-x/1` … `release-x/1024`). Both parties derive them.
- **The Sigma nonces** `k_C, k_ρ, k_c', k_x, k_y, k_e, k_w1, k_R, k_r₀, k_w2, k_τ` are
  `scalar(tagged_hash("simplicity-lending/private/v1/release-nonce", borrower_sk ‖ h₇ ‖ m))`.
  - `borrower_sk` is the borrower's lending key.
  - `h₇` is the statement's digest.
  - `m` is the nonce's position, 0 to 10, as one byte.
  - They derive from the borrower's key, not from the shared secret, so the lender cannot compute
    them and recover the borrower's openings from the responses.
  - The statement fixes every secret, because the commitments bind under the unknown discrete
    logarithms. So two builds of one statement give the same proof, and two different statements
    give independent nonces.

### The program

`private_lending.simf` stays one program with two storage slots: whether the offer is active, and
`h(A, D)`.

**New parameters.** The lender recomputes all of them from the shared secret and the terms when it
checks the offer's address.

| Parameter | Value | Use |
|---|---|---|
| `REPAYMENT_ASSET_POINT` | `A` as an affine point | E5, E7, `FS_IV` |
| `COLLATERAL_ASSET_POINT` | `A_c` | E1, E2, the index check |
| `COLLATERAL_VALUE_POINT` | `V_c0` | E1 |
| `STARTING_DEBT_POINT` | `D₀` | E5, E7 |
| `FS_IV` | as above | the challenge |
| `BLINDER_ROOT` | the Merkle root of `Y_1..Y_1024` | M |

- **Constants in the program:** `J`, `LEAF_IV` and `NODE_IV`.
- **Kept:** every phase 5 parameter. `REPAYMENT_ASSET` stays in Elements' encoding for the byte
  comparison of output 2's asset commitment.
- **The carry outputs' lock** is `PRINCIPAL_OUTPUT_SCRIPT_HASH`: `asset_auth` of the borrower NFT
  without burn, the lock the principal already uses. So it needs no new parameter.
  - It is a taproot output, so it is spendable and consensus gives its amounts a minimum of 1.
  - The borrower unlocks it with the NFT that every borrower branch already spends.
- **Removed:** the zero-debt close branch and its helpers (`get_key_reveal_script_hash`,
  `close_zero_debt`).

**The witness path:**

```
Left(Left(()))                        acceptance
Left(Right(()))                       cancellation
Right(Left(Left(installment)))        installment with release
Right(Left(Right(debt_hash)))         full repayment
Right(Right((debt_hash, salt, expiry))) liquidation
```

The installment's witness is:

```
installment = ( debt: (bool, u256),           D in Elements' encoding, as in phase 5
                index: u16,                   i, the input's step
                y: Ge,                        Y = Y_(i+1)
                path: [(bool, u256); 10],
                t: (Ge, Ge, Ge, Ge, Ge, Ge, Ge),
                z: 11 scalars in the order above )
```

| Branch | Inputs | Outputs | Witness |
|---|---|---|---|
| Acceptance | 0 pending offer, 1 lender NFT | 0 active offer, 1 principal, 2 lender NFT | none |
| Cancellation | 0 pending offer, 1 lender NFT, 2 borrower NFT | 0 and 1 burn both NFTs | none |
| Installment | 0 borrower NFT, 1 loan | 0 NFT, 1 loan, 2 installment, 3 and 4 carries | above |
| Full repayment | 0 borrower NFT, 1 loan | 0 borrower NFT burn, 1 repayment | `h` |
| Liquidation | 0 loan, 1 lender NFT | 0 lender NFT burn | `h`, salt, expiry |

**The installment checks, in order** (run by the loan input at index 1):

1. `jet::current_index()` is 1. Input 1's script hash is the storage address (active, `h(A, D)`)
   for the witness's `D`.
2. The borrower NFT passes from input 0 to output 0, explicit and of amount 1.
3. Output 2's script hash is `INSTALLMENT_OUTPUT_SCRIPT_HASH`, and its asset commitment is
   `REPAYMENT_ASSET`. Call its value commitment `V`.
4. `D' = D − V` is not the point at infinity.
5. Output 1's script hash is the storage address (active, `h(A, D')`).
6. Output 1's asset commitment is input 1's plus `G`. Unlike phase 5, its value commitment is not
   compared.
7. **The index check.** Input 1's asset commitment is the encoding of `A_c + i·G`
   (`jet::generate(i)`, `gej_ge_add`, `gej_normalize`, then phase 5's encoding).
8. **Equation M.** `Y` is on the curve, and the path takes leaf `compress(LEAF_IV, Y.x, Y.y)` at
   index `i` to `BLINDER_ROOT`.
9. **The carries.** Outputs 3 and 4 have the script hash `PRINCIPAL_OUTPUT_SCRIPT_HASH`.
   Confidential asset and value commitments are required (`unwrap_left`), so an explicit carry
   fails.
10. The program reads `V_s` from output 1, and `W1`, `A_w1`, `W2`, `A_w2` from outputs 3 and 4, as
    curve points. The `T`s are checked to be on the curve.
11. It computes the challenge and checks V1 to V7.

Inputs from index 2 on, and outputs from index 5 on, are not constrained.

**The other branches:**

- **Full repayment:** unchanged from phase 5. The borrower spends the loan with its current
  collateral `c_k` and takes it back in a free output.
- **Liquidation:** unchanged. It reads neither the debt's opening nor the collateral.
- **Acceptance and cancellation:** unchanged programs. Their transactions change (below).

**Cost.** The spike measured the installment at about 3.84 M mWU against a budget of 7.42 M, paid
for by its own witness. The program was about 6.0 kB and the witness 1.2 kB.

- Liquid does not relay annex padding, so a build must pay for its cost with its own bytes.
- The contract test asserts `is_budget_valid` on the stack with no annex.

### Transactions

**Creation** adds a third issuance and one output.

- **Inputs:**
  - 0 issues the borrower NFT and 1 the lender NFT, as today.
  - The next input, 2, which is the first collateral or fee coin, issues the carry token: `S =
    2^50` units, no reissuance token, fresh entropy.
- **Outputs:**
  - 0 borrower NFT, 1 lender NFT locked to the offer, 2 marker, 3 pending collateral, as today.
  - New output 4 is the carry supply: `S` carry units, explicit, locked by `asset_auth` of the
    borrower NFT without burn (`PRINCIPAL_OUTPUT_SCRIPT_HASH`).
  - Then the changes and the fee.
- **Why `S` is safe to show.** The amount is the same for every loan, so it reveals nothing.
- **How `S` was chosen:**
  - Elements limits an explicit output, and the sum of a transaction's explicit outputs over all
    assets, to `MAX_MONEY = 21·10^14` (`bad-txns-txouttotal-toolarge`, seen in the spike). `2^50 ≈
    1.13·10^15` leaves room for the NFTs and the fee.
  - The carries need `R + 1` units, and the first installment burns a leftover of at least 1. So
    `R ≤ S − 2`.

**Installment.**

- **Inputs:**
  - 0 the borrower NFT and 1 the loan.
  - 2 and 3 the carries `W1_k` and `W2_k` of the previous installment. At the first installment
    there is one carry input: creation's output 4.
  - Then the principal coins, then the fee coins.
  - The carry inputs run `asset_auth` with the NFT at input 0 and output 0.
- **Outputs:**
  - 0 the borrower NFT and 1 the successor loan.
  - 2 the installment: under `A`, blinded to the lender with the derived ephemeral key, as in
    phase 5.
  - 3 `W1_(k+1)` holds `e + 1` and 4 `W2_(k+1)` holds `R − e`. Both are confidential and blinded
    to the borrower's lending key, with a random ephemeral key; the borrower rewinds them with
    its lending key.
  - Then the release to the borrower's wallet, if `c_k − c_(k+1) > 0`.
  - At the first installment only, a confidential `OP_RETURN` burns the leftover `S − R − 1`
    carry units.
  - Then the principal change, the policy change and the fee.
- **The successor** is pinned with asset blinder `a_c + k + 1` and value blinder
  `x_(k+1) − c_(k+1)·(k+1)`.
- **The carries balance from the second installment on:** two in, two out, `R + 1` units each
  way.
- **Weight.** The spike measured 42,479 WU without the borrower NFT's input and output, so about
  43,000 WU in all (estimate).

**Full repayment.** The phase 5 layout, plus the carries:

- The app also spends the two carries (with `asset_auth`; phase 5 notes that the no-burn lock
  accepts the NFT's burn output).
- It burns their `R + 1` units in one confidential `OP_RETURN`.
- The collateral `c_k` goes to the borrower.
- The contract does not require the sweep. Without it, the carries stay locked for ever once the
  borrower NFT is burned.

**Cancellation.** The app also spends creation's output 4 with `asset_auth` and burns the `S` carry
units in an explicit `OP_RETURN`.

**Liquidation.** The lender spends the loan with its collateral's opening. At step 0 that is the
active collateral. At step `k ≥ 1`:

- It computes `D_k` as a point, as in phase 5.
- It finds `c_k ∈ [1, C]` with `c_k·A_c = V_k − x_k·G` by a baby-step giant-step search.
- The opening is then asset blinder `a_c + k` and value blinder `x_k − c_k·k`.
- When the lender can read every installment, it computes `c_k = ceil(d_k·C/R)` directly instead.
- The carries stay with the borrower, who keeps its NFT and may sweep them later.

### Off chain

**Checks at acceptance.** Before accepting, the lender checks:

- `1 ≤ C ≤ 2^44` and `1 ≤ R ≤ 2^50 − 2`;
- that the offer's address is the one its own parameters give, including the new ones.

The borrower's app refuses to create an offer outside these bounds.

**Installments:**

- At most `N = 1024` per loan. Step 1024 has no leaf for the next one, so the app offers only the
  full repayment there.
- Phase 5's branch rule stands: below the remaining debt, an installment; equal to it, the full
  repayment; zero or above it, refused.
- The contract now also refuses an overpayment.

**Never rebuild an index.**

- Two builds at the same step share `x_(k+1)`, so their successors differ by `(c' − c'')·A_c`.
  Anyone holding both can search for the difference of the amounts.
- The app saves a build before its first broadcast and rebroadcasts it. It never builds a second
  one for the same loan state, as phase 5 already does for its range-proof nonces.

**Rebuilding from the seed and the chain.** The borrower rebuilds:

- the lending key, the offer's secrets, `x_j` and `y_j`, and the tree;
- `d_k` and `r_k` from its own installments, as in phase 5;
- `c_k = ceil(d_k·C/R)` and `e_k`, in 128-bit integers;
- the carries, by rewinding outputs 3 and 4 of the last installment with its lending key, or
  creation's output 4 at step 0.

**The lender rebuilds:**

- the step count and `D_k` from the chain;
- `c_k` from the installments it can read, or by the search when one is unreadable.
- The search runs in a Web Worker. The spike measured 38 s worst-case in wasm at `C ≤ 2^44` on an
  Apple M4 Pro. Its result is cached per loan state.

**What the apps show:**

- **The borrower's repay form** shows, for an amount `p`, the release
  `c_k − ceil((d_k − p)·C/R)`. Its loan view shows the collateral released (`C − c_k`) and the
  collateral left (`c_k`).
- **The lender's loan book** shows the same two figures, marked "computing" while a search runs.

**Integer arithmetic.** Every collateral figure is computed in `u128` as `ceil(a·b / c) = (a·b + c −
1) / c`. The releases of a loan add up to `C` exactly.

### The indexer

**Reading an installment.** The indexer still knows an installment by its unburned borrower NFT,
with the loan at output 1 and the installment at output 2.

- It records outputs 3 and 4 as a new UTXO type, `carry`, of that offer.
- It records creation's output 4 as the offer's first `carry`.
- It marks a carry spent when an installment, the full repayment or the cancellation spends it.

**What it cannot see.** The release output is not constrained and its amount is hidden, so the
indexer does not identify it. The API serves no collateral amounts.

**The zero-debt close is gone.** A burned borrower NFT with an `OP_RETURN` at output 1 is no
longer a spend kind. The tracker's zero-debt case and its test go.

**Creation transactions** now have the carry output at index 4. The program id changes with the
source, so offers of the phase 5 program are not read.

### Done when

**The soundness proofs** (task 1) state and prove:

- special soundness and honest-verifier zero-knowledge of E1–E7 and M with shared responses;
- the integer argument;
- the challenge as a random oracle over chained compressions;
- binding of the index and the leaf;
- hiding of `V_k` given `Y_k`;
- that the lender's search recovers the opening.

The contract is written to the statements that were proved.

**Contract (regtest):**

- **Installments with release succeed:**
  - at the first and at later steps;
  - with `e = 0` and with `e = R − 1`;
  - with a release of 0;
  - with every point's two prefix bits, as in phase 5.
- **The program refuses an installment** with:
  - `c' ± 1`;
  - carries split `(e, R − e + 1)`, or summing to anything but `R + 1`;
  - a carry on another script, or explicit;
  - a successor with a random blinder against the honest `Y`;
  - a self-made `Y` with the honest path;
  - the index, leaf and blinder of `i + 1` at step `i`;
  - the leaf of `i + 1` with index `i`;
  - an altered response;
  - a proof from another installment;
  - a successor asset other than input + `G`;
  - phase 5's installment failures;
  - an overpayment;
  - a payment of exactly the debt.
- **The liveness test** runs random installment sequences with releases. After each one:
  - the full repayment succeeds;
  - the liquidation after the term succeeds, by a lender who reads no installment and opens the
    collateral by the search. The test uses `C ≤ 2^32` to keep it fast.
- **Exact sums:** the releases of each sequence plus the full repayment's collateral add up to `C`,
  and each release is `floor(paid_k·C/R) − floor(paid_(k−1)·C/R)` in `u128`.
- **Weight and budget:** the installment runs within its budget with no annex, and its transaction
  is below 100,000 WU. The test prints its weight.
- **Creation, cancellation and full repayment:** the creation issues the carry supply, the
  cancellation burns it, and the full repayment sweeps the carries.
- **Phase 5's final claim** with the combined opening still passes after releases. Its zero-debt
  case is removed with the branch.

**Core:**

- known-answer tests for `J`, `LEAF_IV`, `NODE_IV`, `FS_IV`, `x_j`, `y_j`, `BLINDER_ROOT` and the
  nonces of a fixed offer;
- the prover against a Rust verifier of V1–V7 and M;
- property tests of the release arithmetic;
- the search at `2^36`, and an ignored test at `2^44`.

**wasm:** bindings for building an installment's witness, the release preview and the search, with
wasm tests.

**Parity:** `pnpm parity` covers the new derivations, the witness encoding and the release
arithmetic.

**Indexer:** the `carry` type, carry spends, and the creation layout.

**e2e:**

- the `repay-partial` stage releases collateral, and the borrower's wallet receives it;
- the full repayment after releases;
- every stage from empty state.

**Demo:** the demo shows a release in the borrower's and the lender's views.

### What this note decides beyond the spike

- **The carry token:** one per loan, from the creation transaction. Its supply `S = 2^50` sits in an
  explicit output 4 under the borrower NFT's `asset_auth`. The first installment burns the
  leftover, the full repayment sweeps the carries, and the cancellation burns the supply.
- **The carry lock** is `PRINCIPAL_OUTPUT_SCRIPT_HASH`, not a new `CARRY_SCRIPT_HASH`, and the
  carries are blinded to the borrower's lending key.
- **The bounds** `C ≤ 2^44` and `R ≤ 2^50 − 2`, both checked by the lender.
- **The derivations:** the labels of `x_j` and `y_j`; nonces from the borrower's lending key over
  `h₇`; `J` by try-and-increment; and the IVs and `FS_IV` with their tags.
- **On-curve checks** of the witness's `T`s and `Y`. The spike did not check them. An off-curve
  point would break the group-law argument the proofs rely on.
- **The layouts:** the installment's input and output indices with the borrower NFT, and the
  zero-debt close removed, which reshapes the witness path.

### Left to the builder

- The parameters' names, and whether points travel as affine words or in Elements' encoding with
  a decode.
- The `T`s affine or compressed. Either way they must be checked on the curve.
- The order of the free outputs after index 4.
- Whether the app sweeps the carries after a liquidation.
- The search's implementation (baby-step giant-step or kangaroo, batching, the worker) and its
  cache.
- Whether a testnet e2e stage liquidates a loan with releases, or the regtest tests alone cover it.
- The UI's wording.

## Open questions

- What a borrower decides when making a partial repayment, and what they get back. (With 3(a):
  only the amount, and nothing until the full repayment, as the phase 5 design note builds it;
  with 3(b): the amount and the collateral released within the proportion.)
- Where the per-lender sections of item 5 live: the collateral range proof with a wrapped viewing
  key in the marker, OP_RETURN (check Elements' relay limits), or the indexer as a mailbox of
  ciphertexts.
- Whether message senders must be able to reread their messages on another device (item 6).
  Decided 2026-11-21: no new derivation. The creation's and each installment's messages reread
  from the seed (their nonces derive since phase 5); the acceptance's and the full repayment's
  only from the browser that sent them, which keeps them per lending key.
- Whether LWK and Jade sign with `SIGHASH_RANGEPROOF`; if they do, item 6's signatures still
  name the sender but are no longer needed against malleation. Checked 2026-11-12 for LWK at
  `7f8c8213`: its software signer signs only the default sighash unless its policy allows another,
  and nothing in `lwk_signer` handles `SIGHASH_RANGEPROOF`, so item 6's signatures are needed.
  The Jade is unchecked, and need not be (2026-11-21): the messages are signed by the lending
  key, which the browser derives from the descriptor for Jade wallets too.
