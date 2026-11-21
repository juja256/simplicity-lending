---
title: Protocol and privacy
description: Private lending state transitions, local verification, role-token authorization, and privacy boundaries.
---

# Protocol and privacy

Private lending uses `crates/contracts/simf/private_lending.simf`, with the helper programs
[asset auth](../contracts/asset-auth.md) and [script auth](../contracts/script-auth.md). The
contract takes installments of any amount, the full repayment of what is left, and a close for a
loan that owes nothing; it charges no protocol fee. The app pays installments and the full
repayment of what is left, and closes a loan that owes nothing; it never pays an installment of the
whole debt itself. The UI uses the network's configured collateral/principal asset pair and
displays explicit principal and repayment amounts.

For the browser workflow, see the [user guide](./guide.md).

## Confidentiality boundaries

The borrower addresses an offer to an x-only lending public key. The parties derive the secrets
needed to open the confidential offer and verify its commitments locally. The indexer supplies
public candidates and transaction data, rather than plaintext loan terms.

| Information | Visibility |
| --- | --- |
| Collateral, principal, repayment assets and amounts | Confidential on-chain; available to parties with the required offer-opening secrets. |
| Creation transaction and private-offer marker | Publicly observable. |
| State transitions, spends, and role-token movements | Publicly observable. |
| Expiry height | Hidden until a liquidation: the contract holds only its salted hash, and the liquidation reveals the height in its witness and lock time. |
| Installment amounts and the debt left | Confidential on-chain; the borrower and the lender open them. Each installment is a public transaction of the loan. |
| Private messages | Confidential on-chain, in range proofs that only the two parties rewind; an output's range proof has the same length with a message of any length or none. |
| Directory lending key and display name | Public when registered. |
| Directory terms (minimum APR, maximum principal per collateral unit, term and principal ranges) and their publication time | Public when published. |

This does not promise transaction anonymity, unlinkability against every observer, or protection
against disclosure by a counterparty. The lending key is derived from the wallet's master blinding
key. A holder of the corresponding confidential watch-only descriptor can therefore derive it,
read private offers, and sign lending-key messages. That does not give them wallet spending keys.
Treat the confidential descriptor as sensitive; lending-key signatures are not proof of exclusive
spending authority or a real-world identity.

## State transitions and role tokens

Creation issues borrower and lender role tokens directly; no account setup comes first. These
tokens authorize later spends through the associated contracts.

| Transition | Inputs/authorization and result |
| --- | --- |
| Create → pending | Locks collateral, gives the borrower its token, and locks the lender token under ScriptAuth. |
| Pending → active | Acceptance supplies the pinned principal to a borrower-token-controlled output, preserves the pinned collateral, and releases the lender token. |
| Pending → cancelled | Cancellation burns both tokens and releases collateral. It conflicts with acceptance. |
| Claim principal | AssetAuth releases principal using the borrower token, which is returned for later repayment. The loan remains active, or remains liquidated if liquidation already occurred. |
| Active → active | An installment pays part of the debt to an output that the lender token unlocks without burning it. The loan moves to an output whose storage holds the debt left, with the collateral re-blinded. The borrower token stays with the borrower, and no collateral is released. |
| Active → repaid | Full repayment pays an output equal to the debt left, burns the borrower token, and releases collateral. The installments and the full repayment add up to the repayment of the terms. |
| Active → closed | A loan that owes nothing, after an installment of the exact amount left under another blinder, closes by burning the borrower token and revealing the debt's blinder in an `OP_RETURN`. It releases collateral. |
| Claim installment | The lender claims an installment through AssetAuth with its token, which returns to it. |
| Repaid → claimed | The lender claims the repayment through AssetAuth and burns its token. “Claimed” is derived by the UI from spent repayment outputs. |
| Active → liquidated | After the lock-height condition, liquidation burns the lender token and releases collateral. It reads neither the debt nor the collateral, so no installment can block it, and installments paid before it are not refunded. It does not consume a separate unclaimed principal output. |

The tokens are bearer rights, not decorative collectibles. Transferring or losing one can change
who can exercise a loan's rights. The current app assumes its prescribed token locations and does
not provide a secondary market for them. NFT ownership and correct wallet signing both matter;
do not treat the lending-key directory as a substitute for transaction authorization.

## Private messages

A loan's parties can send each other a short text message with four of its transactions. A message
is not part of the terms, and the contract does not enforce it: no covenant reads it.

### Channels

Each message travels in the extra data of a confidential output's range proof, which only the
parties rewind.

| Step | Output | From → to | Text, at most |
| --- | --- | --- | --- |
| Creation | Output 3, the pending collateral, inside the signed terms | Borrower → lender | 2915 bytes |
| Acceptance | Output 1, the principal | Lender → borrower | 3068 bytes |
| Installment `j` | Output 2, the installment | Borrower → lender | 3068 bytes |
| Full repayment | Output 1, the repayment | Borrower → lender | 3068 bytes |

The zero-debt close, the claims, the cancellation and the liquidation carry none. The creation's
and each installment's range proofs are rewound with nonces that derive from the borrower's seed,
so their messages read again on any device. The acceptance's and the full repayment's nonces are
random: the receiver reads them, but their sender cannot rewind them, and the app keeps a record of
what it sent instead (see [Client state](#client-state-and-implementation-map)).

### Encoding

The message field is version `1` (1 byte) ‖ kind (1 byte; `1` is UTF-8 text, the only kind) ‖
length (2 bytes, big-endian) ‖ the text's bytes. The text is non-empty, valid UTF-8. A reader
refuses an unknown version or kind, a length past the end of the data, an empty text or invalid
UTF-8: the message is unreadable, and the rest of the loan still reads.

A range proof carries 3136 bytes of extra data. In the terms, a missing message is the single byte
`0`. In the other range proofs it is no extra data at all, which rewinds as zeros. A range proof's
length does not depend on its extra data, so it does not show whether the output carries a message,
or how long one is.

### Terms version 2

The terms that output 3 carries are version 2: version `2` (1) ‖ length (2) ‖ the version 1 fields
(principal asset, principal amount, repayment amount, interest, expiration height, borrower NFT and
lender NFT) ‖ borrower x-only key (32) ‖ message field ‖ signature (64). The fixed fields before the
message field are 153 bytes. The message field is inside the signed prefix, so the terms' BIP340
signature, under the tag `simplicity-lending/private/v1/offer`, covers it. Only version 2 decodes;
the app reads no earlier offer.

### Signed messages

The acceptance's, an installment's and the full repayment's extra data is the message field ‖ a
BIP340 signature (64 bytes) by the sender's lending key over

```text
tagged_hash("simplicity-lending/private/v2/message", phase ‖ offer id ‖ message field)
```

The offer id is the creation txid in internal byte order. The phase is `0x01` for the acceptance,
`0x02 ‖ j` (big-endian, 4 bytes) for the `j`-th installment, counted from 1, and `0x03` for the full
repayment. The other party knows the output's blinders and can make a new range proof for any
output, so it could copy a message to another output of the loan. The phase and the offer id in the
signature make such a moved message fail to verify, and the app shows it as unverified. A message
with no signature, or a bad one, also shows as unverified. The lending key signs in the browser; a
hardware wallet is not involved.

### Limits

The limits come from the 3136 bytes of extra data. A signed message has 3136 − 4 − 64 = 3068 bytes
of text: the field's header and the signature take the rest. The creation's has 3136 − 221 = 2915:
the terms' 153 signed bytes, the field's 4 and the signature's 64. The limits count UTF-8 bytes, not
characters: a Cyrillic letter is 2 bytes and an emoji 4.

### Display

A message is shown as plain text, with `white-space: pre-wrap`, and no link in it is made
clickable. Before it is shown, the C0 and C1 control characters except the newline, and the
bidirectional controls U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069, are removed. Every
message shows "A message is not part of the terms, and the contract does not enforce it." with its
sender's key fingerprint, and its directory name when the entry verifies.

## Verification before action

The browser treats indexer state as discovery data, not authority to spend. The implementation
has several checks between discovery and signing:

1. Scan public candidates with the lending key and fetch likely matching creation transactions.
2. Verify the fetched transaction ID, open the terms, and check signatures, commitments, creation
   layout and role tokens through the Rust/WASM verifier.
3. Reconstruct the expected pending-offer and lender-token-lock scripts and compare them with
   the transaction. Decrypting plausible terms alone is insufficient.
4. Before an action, load a fresh verified offer. Builders validate the supplied outpoints and
   expected transaction layout, including checks before and after blinding.
5. Inspect the result and check transaction identity across signing/finalization, save finalized
   bytes before broadcast, and reuse those bytes for retries.

For repayment, the client requires positive evidence that principal was claimed and checks the
claim transaction. An indexer omitting the principal output must not enable repayment that burns
the only token capable of claiming it.

The lender's console counts a proposal's term from the block its creation confirmed in, which it
reads from esplora, not from the indexer's creation height. A later height from the indexer would
count a shorter term and a higher APR, and could show a proposal outside the lender's terms as
within them. Until esplora reports the creation confirmed, the proposal's term, APR and check
against the terms are not shown, and it cannot be reviewed.

A dishonest or unavailable indexer can still hide data, delay discovery, or prevent progress.
Verification protects the transaction path; it does not guarantee availability or fresh UI counts.

## Directory signatures

A lender publishes its display name and terms by signing them together with its lending key: the
signature covers the action, the key, a single-use challenge from the indexer, the name and the
terms. The indexer serves each entry with the challenge and the signature of its last put, and the
browser checks every entry against its key. An entry is verified when the signature verifies for
the served key, name and terms. It is unsigned when the indexer serves no challenge or signature,
as for an entry written before the indexer kept them, and invalid when the signature does not
verify or the terms cannot be read. The publication time is not signed.

Only verified entries are used. Borrowers see verified lenders only, and names shown next to a key
come from verified entries only; an unsigned or invalid entry is hidden from borrowers and only
counted. The lender's console checks proposals against its own entry's terms only when that entry
verifies, and pre-fills its terms form only from such an entry.

A valid signature proves that the key signed this name and these terms once. It does not prove
that the entry is the key's latest put: nothing a reader can check orders two puts, so an indexer
can serve an older put of the same key unnoticed. Borrowers then see the lender's older terms and
name, and the lender's own console checks proposals against those older terms. Freshness rests on
the indexer.

## Client state and implementation map

Decrypted display terms are held in the session-scoped query cache and removed when that session
ends. Scan progress is persisted in IndexedDB. Finalized transactions awaiting broadcast are
also persisted for recovery and scoped to the wallet/network; browser storage is sensitive and
is not a substitute for backing up the wallet. Do not clear it during an unresolved broadcast.

The app records every acceptance, installment and full repayment it sends, with the message's
plaintext or the fact that it carried none, in IndexedDB, per network and lending key. The sender
of an acceptance or a full repayment rereads its message only from this record. The plaintext stays
on the device after a disconnect, like the saved transactions. The timeline matches a record to the
loan's transactions by txid, so a discarded transaction's message never shows as sent, and a message
sent from another browser does not show.

| Repository path | Responsibility |
| --- | --- |
| `crates/private-lending-core/` | Terms, key derivation, commitments, creation verification and the message format (`message.rs`). |
| `crates/private-lending-wasm/` | Browser-facing Rust operations and transaction inspection. |
| `crates/contracts/simf/private_lending.simf` | Private loan state transitions and covenant checks. |
| `crates/indexer/` | Public candidate discovery, state indexing, directory and events. |
| `web/src/privateLending/scan.ts` | Discovery and opening/verification gates. |
| `web/src/privateLending/flows/` | Creation, acceptance, claims, cancellation, repayment and liquidation builders. |
| `web/src/privateLending/hooks/usePrivateOffers.ts` | Wallet-scoped queries, scan serialization and term caching. |
| `web/src/privateLending/offerView.ts` | Display and action eligibility rules; not contract enforcement. |
| `web/src/privateLending/messages.ts`, `loanMessages.ts`, `sentMessages.ts` | Message limits and display, a loan's message timeline, and the record of sent messages. |
| `web/src/providers/pendingTransactions/` | Saved transactions and broadcast/confirmation state. |

## Expiry and review status

The offer contains an absolute expiry height. Waiting for acceptance consumes the time remaining;
there is no new duration measured from funding. The current acceptance covenant has no enforceable
upper bound on acceptance height and requires no fresh borrower signature. A knowledgeable party
can fund an uncancelled pending offer after expiry and then liquidate without a guaranteed funded
term. The borrower retains the contractual principal claim but can lose excess collateral value.

This is finding **M-01** in the focused review dated **2026-11-02**. An offline test executes the
compiled acceptance, ScriptAuth and liquidation covenants with synthetic transaction data, plus
seven rejecting controls. It demonstrates the missing covenant restriction, not a fully balanced,
consensus-valid on-chain exploit. UI expiry checks do not fix it. Cancellation is effective when
confirmed; acceptance can race it, and repayment can race liquidation after expiry.

The review found no additional concrete fund-theft bypass in its bounded scope. It is not a full
audit, cryptographic proof, or mainnet readiness assessment. The current release preparation is
for a Liquid testnet demo. Browser rechecking was deferred after reported rate limiting, and the
manual checklist still has uncaptured Jade metadata/warning observations and partial assertions.

Repository evidence and follow-up documents:

- `docs/security/2026-11-02-private-lending-contract-review.md`: M-01, proof scope, and proposed treatments.
- `crates/contracts/tests/private_lending_security_audit.rs`: offline covenant regression/proof test.
- `docs/superpowers/manual/2026-10-29-private-lending-testnet.md`: manual scenarios and recorded results.
- `docs/bug-reports/2026-11-02-lwk-web-concurrent-scan-hang.md`: wallet-scan issue and mitigation limits.
- `deployment/demo-release.md`: build configuration, completed checks and remaining release decisions.
- `docs/superpowers/specs/2026-10-28-private-lending-design.md`: original design; implementation and review findings qualify its guarantees.
