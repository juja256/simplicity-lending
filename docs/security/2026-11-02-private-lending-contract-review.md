# Private lending contract: focused adversarial review

Date: 2026-11-02. Reviewed working tree based on commit `c87e9c223ea28d44f02c7ea27a37c5bf32ab36b5`.

## Result

One **medium-severity protocol/design risk** was demonstrated at the covenant VM level: an uncancelled pending offer can be accepted after its stated expiry and then liquidated without another borrower signature. This gives a malicious counterparty an option to force a stale collateral-for-principal exchange. The borrower still receives the contractual claim on principal; this is not a demonstrated arbitrary third-party theft of all collateral for free.

No additional concrete fund-theft bypass was found in the reviewed commitment, state-transition, NFT, or recipient checks. That is a bounded review result, not proof of safety or a complete audit.

## M-01 — A pending offer has no enforceable acceptance deadline or minimum funded loan duration

**Severity:** Medium. Potential collateral loss can be substantial, but the attacker must know the confidential terms, supply the promised principal, and win against cancellation or repayment. This may be an accepted economic feature of a standing offer; it must not be represented as automatic on-chain expiration.

**Locations:**

- `crates/contracts/simf/private_lending.simf:281`: `accept_offer()` checks the pending-to-active transition, both collateral commitments, the lender NFT, and the principal output. It does not check any time condition or require fresh borrower authorization.
- `crates/contracts/simf/private_lending.simf:264`: `check_lock_height(LOAN_EXPIRATION_TIME)` applies to liquidation only.
- `crates/contracts/simf/script_auth.simf:7`: the pending lender NFT is unlocked by co-spending an input with the offer's script hash; it does not require the addressed lender's or borrower's signature.
- `crates/contracts/simf/private_lending.simf:318`: cancellation consumes the same pending collateral and lender NFT that acceptance consumes, so the two transactions conflict.
- `crates/contracts/src/programs/private_lending/params.rs:45`: principal remains claimable through the borrower NFT independently of liquidation.
- `web/src/privateLending/offerView.ts:103`: the app's past-expiry predicate is a client-side policy. An adversarial client is not constrained by it.

### Preconditions and attack

1. A borrower creates a valid pending offer with absolute liquidation height `N`, collateral `C`, and principal `P`.
2. The borrower leaves the pending offer unspent through `N`, or makes it with very little time remaining. The addressed lender knows the confidential terms and pinned output secrets. A party to whom those secrets were disclosed can also construct the transaction; an arbitrary public observer normally cannot.
3. Instead of funding a useful-duration loan, the attacker waits until the deadline has passed or is imminent, and constructs acceptance outside the app's UI restriction.
4. Acceptance spends the pending offer and its locked lender NFT, creates the required principal at the borrower's asset-auth script, creates active collateral, and sends the lender NFT to an attacker-controlled output. The attacker supplies the principal and fees. There is no fresh borrower spending signature on these covenant inputs.
5. Once the active output exists and the liquidation locktime is satisfied, the attacker spends it and burns the newly acquired lender NFT. There is no relative delay measured from acceptance, so no guaranteed repayment window remains.

The borrower retains the claim to `P` after liquidation. The attacker's gross economic gain is approximately `market_value(C) − market_value(P) − fees`, if positive. The borrower loses the excess collateral value and the opportunity to retain the collateral. Prices can move substantially while an offer remains pending.

Cancellation protects the borrower **once confirmed**, but merely submitting it does not revoke an offer: cancellation and acceptance double-spend the same UTXOs. If acceptance wins, the borrower can attempt repayment, but after expiry that also races liquidation. A borrowed amount being claimable is not equivalent to a useful loan term.

### Validation

Added `crates/contracts/tests/private_lending_security_audit.rs`, an offline integration test executing the actual compiled covenant with the published deterministic parity fixture:

```sh
PATH=/opt/homebrew/opt/rustup/bin:$PATH \
  cargo test -p lending-contracts --test private_lending_security_audit --offline
```

The test passes:

```text
expired_pending_offer_can_be_accepted_then_liquidated_without_borrower_signature ... ok
1 passed; 0 failed
```

It successfully executes both the offer-acceptance covenant and the pending NFT's ScriptAuth with transaction locktime `N + 100`, then executes the resulting active offer's liquidation covenant with the same locktime. Neither covenant witness contains a borrower signature. The test also checks rejection of seven counterexamples: reduced principal, redirected principal, reduced active collateral, two lender-NFT units, liquidation locktime below `N`, a spendable NFT “burn,” and the wrong liquidation NFT asset.

**Scope of the proof:** `N + 100` is the transaction's `nLockTime`, not a simulated chain tip. These are offline Simplicity VM executions with synthetic UTXOs and commitment fields. They do not construct valid funding signatures, range proofs, surjection proofs, balanced full transactions, a mempool, or a mined chain. The chosen non-final sequences enable locktime. Full transactions using that locktime would require a mined height **strictly greater than `N + 100`** for absolute finality, assuming all other consensus requirements are met. Choosing a chain already beyond that height permits acceptance and subsequent liquidation without another loan-duration delay. The test demonstrates missing covenant restrictions, not an already-broadcast end-to-end exploit.

### Recommended treatment

- Decide explicitly whether pending offers are standing commitments until cancelled. If so, call `N` the **liquidation height**, disclose that it does not revoke pending offers, and make confirmed cancellation the documented way to withdraw them. Expired/hidden Accept controls are not security controls.
- If a borrower must get a useful term, redesign activation to require fresh borrower spending authorization bound to the acceptance transaction and an agreed future maturity, or design and review a funded-duration constraint measured from activation. This changes the protocol and should receive a separate review.
- Alert borrowers about pending offers nearing maturity and support a cancellation workflow. Automated cancellation reduces exposure but does not eliminate mining races.
- Do not treat a check such as `tx.nLockTime <= N` as an upper bound on mining height: a transaction with an old locktime can still be mined later. Any deadline redesign needs an enforceable chain-level mechanism, not a comparison to a caller-chosen transaction field.
- Add a complete local-regtest acceptance-after-expiry/cancel-race test before deciding on a fix or explicitly accepting the risk.

## Other reviewed protections and boundaries

| Area | Observation / evidence | Remaining boundary |
|---|---|---|
| Underpayment or asset substitution | Acceptance pins principal asset/value commitment and recipient script; repayment pins repayment commitment and recipient. The new VM test rejects reduced/redirected principal and reduced active collateral. | The contract pins commitments, not economic prices or issuer trust. Lender must verify their openings and supported assets. |
| State/branch confusion | Each spend checks the current input position and recomputes the expected pending/active storage script hash. Partial repayment always fails. | No proof of all possible transaction compositions; existing hostile debt-slot/partial-repayment integration tests were read but not run because their harness broadcasts transactions. |
| Lender NFT duplication/reissuance | `creation.rs:184–215` requires new issuance of exactly one unit and no reissuance token. The asset ID is derived from that issuance. Outputs must contain the terms' IDs and one unit. Core rejection tests pass. | This issuance-origin check is off-chain validation of creation, not repeated by every covenant spend. Clients must use the full verifier before accepting. Consensus asset conservation and uniqueness of spent outpoints are assumed. |
| Dishonest displayed terms | `verify.rs:100–105` checks reconstructed pending address and lender-NFT lock. `offer.rs` compares rewound secrets and actual commitments; signatures bind terms, lender, and creation input. | Merely decrypting terms is insufficient; omitting the address check would reintroduce a smaller-repayment substitution attack. Current Rust and frontend verification paths were reviewed for this boundary. |
| NFT-directed payouts | Cancellation/repayment require borrower NFT burn; liquidation and repayment claim require lender NFT burn. Wallet signatures on NFT inputs authorize the whole transaction in the normal builders. | Covenants do not hard-code the final wallet receiving released collateral. The NFT is a transferable bearer right. Signing a malicious transaction or surrendering the NFT surrenders that control; the review did not assess every wallet/hardware-signing UI. |
| Claim after liquidation | Principal lives in a separate asset-auth output. Burning the lender NFT does not consume the borrower NFT or principal. | Intended behavior, not a double-claim bug. A borrower must preserve its NFT. |
| Borrower NFT supply | Creation verification checks its output amount but does not enforce unique issuance as it does for the lender NFT. | Not reported as theft: borrower authorization can be shared, but each funded principal is still a single UTXO and repayment must pay the pinned debt. Transfer/reissuance behavior should be documented before secondary-market NFT sales are supported. |
| Replay / copied offer / view-tag collision | Signatures and recovery derive from the first input and NFT IDs; fresh NFT IDs change secrets. Wrong-key/view-tag and changed-first-input tests pass. | Fresh issuance entropy and byte-identical rebroadcast remain essential to privacy. Privacy failures from maliciously reused build secrets were not independently cryptanalyzed. |
| Confidential descriptor access | The agreed design derives lending keys from the master blinding key. | Watch-only descriptor holders can read offers and sign lending-key messages. This was an explicit accepted design decision, not evidence of wallet-spend-key compromise. |

## Checks run

- `cargo test -p private-lending-core --lib --offline`: **52 passed**.
- `cargo test -p lending-contracts --lib --offline`: **16 passed**. These include public-contract arithmetic and shared utilities; they do not by themselves establish private-contract security.
- `cargo test -p lending-contracts --test private_lending_security_audit --offline`: **1 passed**, with the acceptance/liquidation VM proof and seven rejection controls described above.
- The new test file was formatted with Rustfmt. No production contract code was changed, and no live-wallet transaction was built, signed, or broadcast by this review.

## Limits and next work

The scope was the private covenant, related ScriptAuth/AssetAuth contracts, Rust term/creation verification, selected browser verification/transaction-layout boundaries, and existing tests. The report is not a formal proof, full cryptographic audit, dependency audit, consensus audit, or complete application security review. Indexer trust, browser compromise, Jade firmware, denial-of-service limits, and every multi-offer batching permutation remain outside the validated scope.

Before deployment with valuable assets, resolve or explicitly accept M-01, run the complete local-regtest adversarial matrix with valid confidential transactions, and obtain an independent contract review. The positive VM result should be retained as a regression test when activation/expiry semantics are changed.
