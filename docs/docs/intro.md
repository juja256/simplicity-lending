---
description: A private peer-to-peer lending demo on the Liquid Network, where a borrower makes an offer to a chosen lender and the loan's assets and amounts stay confidential on-chain.
---

# Introduction

Simplicity Lending is a peer-to-peer lending demo on the Liquid Network. A borrower locks
collateral and receives a loan in another asset directly from a lender they choose. There is no
lending pool and no intermediary holding the money: every loan is an agreement between two
parties, its terms are fixed when the offer is created, and a Simplicity contract enforces them
on-chain.

The loans are private. The collateral, principal and repayment assets and amounts are
confidential on-chain. The borrower and the lender open and verify the terms in their own
browsers. Transactions, offer states and role-token movements stay publicly observable, so this
is confidentiality of the loan terms, not transaction anonymity.

:::info[Status]

The protocol is a demo running on Liquid testnet. It is being actively tested and improved, and
the assets it uses have no real value. Treat it as software to experiment with rather than a
place to put funds you care about.

:::

## How a loan works

1. **The lender shares a lending key.** The key is derived from the lender's wallet. The lender
   sends it to the borrower directly, or registers it under a display name in the lender
   directory.
2. **The borrower creates an offer to that key.** They lock collateral and state the principal
   they want, the total repayment, and the expiry height. Until the lender accepts the offer, the
   borrower can cancel it and take the collateral back.
3. **The lender accepts the offer.** The lender's browser opens and verifies the terms, then
   supplies the principal. The principal is locked to the borrower's role token, and the borrower
   claims it in a separate transaction.
4. **The borrower repays in full.** The repayment releases the collateral. The lender then claims
   the repayment.
5. **Or the loan expires.** If the loan has not been repaid by the expiry height, the lender can
   liquidate it and claim the collateral.

There is no protocol fee. The interest is the difference between the repayment and the principal,
and the lender checks it before accepting. Partial repayments are not supported.

Collateral never moves to the counterparty or to the protocol until the loan ends. It sits in a
contract output, and a role token in your own wallet is what lets you act on the loan.
[Protocol and privacy](./private-loans/protocol.md) explains the role tokens and every state
transition.

An indexer watches the chain and lists candidate offers for the app. It only reads public data:
it cannot open the terms or move funds, and every change still requires a transaction signed by
you. The app verifies every offer itself before it lets you act on it.

## Liquidation follows the expiry height, not the price

The contract has no price feed. A fall in the collateral's price does not liquidate the loan. The
expiry height does. The offer fixes it as an absolute block height when it is created, so the
time spent waiting for acceptance counts against the term.

Expiry does not withdraw a pending offer: an uncancelled offer can still be accepted after it and
then liquidated. Cancel an offer you no longer want. The
[user guide](./private-loans/guide.md#expiry-does-not-withdraw-a-pending-offer) explains this
limitation.

## The public demo

Earlier versions of this demo also had a public market, where offers and their terms were
visible to everyone. It has been removed. The git tag `public-lending-last` in the repository is
the last version that includes it: `git checkout public-lending-last` brings back its contracts,
CLI, indexer, web app and documentation.

## Documentation map

- [Private loans](./private-loans/guide.md): the user guide for borrowers and lenders, and
  recovery
- [Protocol and privacy](./private-loans/protocol.md): confidential terms, verification, state
  transitions and limitations
- [Simplicity](./simplicity.md): the language the contracts are written in
- [Contracts](./contracts/asset-auth.md): reference for the helper programs a loan uses
- [Developers](./developers/versions.md): versions, build, and how to run the stack
