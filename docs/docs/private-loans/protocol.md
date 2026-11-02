---
title: Protocol and privacy
description: Private lending state transitions, local verification, role-token authorization, and privacy boundaries.
---

# Protocol and privacy

Private lending uses `crates/contracts/simf/private_lending.simf`, alongside the public lending
contract. The current version supports full repayment only. The UI uses the network's configured
collateral/principal asset pair and displays explicit principal and repayment amounts.
Public-loan account setup and fee-split descriptions must not be assumed to apply to this flow.

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
| Expiry height | Revealed with the program at its first spend. |
| Directory lending key and display name | Public when registered. |

This does not promise transaction anonymity, unlinkability against every observer, or protection
against disclosure by a counterparty. The lending key is derived from the wallet's master blinding
key. A holder of the corresponding confidential watch-only descriptor can therefore derive it,
read private offers, and sign lending-key messages. That does not give them wallet spending keys.
Treat the confidential descriptor as sensitive; lending-key signatures are not proof of exclusive
spending authority or a real-world identity.

## State transitions and role tokens

Creation issues borrower and lender role tokens directly; there is no public borrower-account
prerequisite. These tokens authorize later spends through the associated contracts.

| Transition | Inputs/authorization and result |
| --- | --- |
| Create → pending | Locks collateral, gives the borrower its token, and locks the lender token under ScriptAuth. |
| Pending → active | Acceptance supplies the pinned principal to a borrower-token-controlled output, preserves the pinned collateral, and releases the lender token. |
| Pending → cancelled | Cancellation burns both tokens and releases collateral. It conflicts with acceptance. |
| Claim principal | AssetAuth releases principal using the borrower token, which is returned for later repayment. The loan remains active, or remains liquidated if liquidation already occurred. |
| Active → repaid | Full repayment pays the pinned repayment output, burns the borrower token, and releases collateral. |
| Repaid → claimed | The lender claims the repayment through AssetAuth and burns its token. “Claimed” is derived by the UI from spent repayment outputs. |
| Active → liquidated | After the lock-height condition, liquidation burns the lender token and releases collateral. It does not consume a separate unclaimed principal output. |

The tokens are bearer rights, not decorative collectibles. Transferring or losing one can change
who can exercise a loan's rights. The current app assumes its prescribed token locations and does
not provide a secondary market for them. NFT ownership and correct wallet signing both matter;
do not treat the lending-key directory as a substitute for transaction authorization.

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

A dishonest or unavailable indexer can still hide data, delay discovery, or prevent progress.
Verification protects the transaction path; it does not guarantee availability or fresh UI counts.

## Client state and implementation map

Decrypted display terms are held in the session-scoped query cache and removed when that session
ends. Scan progress is persisted in IndexedDB. Finalized transactions awaiting broadcast are
also persisted for recovery and scoped to the wallet/network; browser storage is sensitive and
is not a substitute for backing up the wallet. Do not clear it during an unresolved broadcast.

| Repository path | Responsibility |
| --- | --- |
| `crates/private-lending-core/` | Terms, key derivation, commitments and creation verification. |
| `crates/private-lending-wasm/` | Browser-facing Rust operations and transaction inspection. |
| `crates/contracts/simf/private_lending.simf` | Private loan state transitions and covenant checks. |
| `crates/indexer/` | Public candidate discovery, state indexing, directory and events. |
| `web/src/privateLending/scan.ts` | Discovery and opening/verification gates. |
| `web/src/privateLending/flows/` | Creation, acceptance, claims, cancellation, repayment and liquidation builders. |
| `web/src/privateLending/hooks/usePrivateOffers.ts` | Wallet-scoped queries, scan serialization and term caching. |
| `web/src/privateLending/offerView.ts` | Display and action eligibility rules; not contract enforcement. |
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
