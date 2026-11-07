# Private lending v2 — design (draft)

Status: collecting items. Not yet a design; nothing here is decided beyond the item list.

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
   - Item 4 turns the expiry into a duration; it is as easy to brute-force and needs the same
     secret.

2. **Fix address reuse in the private flows.**
   The web app always receives at the wallet's first address (`wollet.address(0)`,
   `web/src/providers/wallet/WalletProvider.tsx:381`), so NFTs and claims land on one address
   and explorers flag address reuse. Idea raised: a fresh unused address for each private-flow
   receive. The public flows find a user's loans by that address's script, so they keep it.
   - The NFT outputs are explicit (the contract requires it), so they are the strongest link
     between one user's loans. `wollet.address(null)` (the last unused address) keeps the gap
     limit safe.

3. **Add partial repayment, using Bulletproofs++ (BP++) proofs.**
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

4. **Fix M-01 of the 2026-11-02 review (acceptance after expiry, then immediate liquidation).**
   - Guaranteed duration: liquidation needs a relative timelock on the active offer's own input,
     measured from acceptance. Not `jet::check_lock_distance` / `check_lock_duration`: they
     compare against the maximum relative lock over all inputs, which a liquidator meets with an
     old coin of its own. Check `jet::current_sequence()` (disable bit and type bit, low 16 bits
     at least the duration) and `jet::version() ≥ 2`. Blocks give up to about 45 days on Liquid,
     512-second units up to about 388 days. The same bug is in the public `lending.simf`.
   - Acceptance deadline without a contract change: at creation the borrower signs a cancellation
     with a relative lock on the pending input and hands it to a watchtower (or the indexer),
     which broadcasts it when the lock expires. The fee comes from a small coin made by the
     creation transaction; the collateral returns to a fresh address. Only interactive
     acceptance removes the lender's option entirely.

5. **Offers to several lenders, one collateral lock.**
   Idea raised: the pending offer becomes a taproot tree with one acceptance leaf per lender (and
   a cancellation leaf), each pinning that lender's principal, active collateral and active
   program; the first acceptance wins. Each lender derives its secret from the same collateral
   nonce, so no extra keys go on chain. A lender's safety depends only on its own leaf. Pad the
   tree and the view tags to a fixed size to hide the number of lenders. It multiplies M-01 by
   the number of lenders, so it needs item 4 first. Pending and active as separate programs
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

## Open questions

- What a borrower decides when making a partial repayment, and what they get back. (With 3(a):
  only the amount, and nothing until the full repayment; with 3(b): the amount and the
  collateral released within the proportion.)
- Whether pending offers stay standing commitments (cancellation only) or get the watchtower
  deadline of item 4.
- Where the per-lender sections of item 5 live: the collateral range proof with a wrapped viewing
  key in the marker, OP_RETURN (check Elements' relay limits), or the indexer as a mailbox of
  ciphertexts.
- Whether message senders must be able to reread their messages on another device (item 6).
- Whether LWK and Jade sign with `SIGHASH_RANGEPROOF`; if they do, item 6's signatures still
  name the sender but are no longer needed against malleation.
