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

2. **Fix address reuse in the private flows.**
   The web app always receives at the wallet's first address (`wollet.address(0)`,
   `web/src/providers/wallet/WalletProvider.tsx:381`), so NFTs and claims land on one address
   and explorers flag address reuse. Idea raised: a fresh unused address for each private-flow
   receive. The public flows find a user's loans by that address's script, so they keep it.

3. **Add partial repayment, using Bulletproofs++ (BP++) proofs.**
   v1 reserves the partial-repayment branch and always fails it: releasing collateral in
   proportion to a hidden amount needs a zero-knowledge proof.

## Open questions

- What a borrower decides when making a partial repayment, and what they get back.
