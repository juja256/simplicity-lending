---
description: How Simplicity contracts run on Liquid, and what you need to know to read the rest of this documentation.
---

# Simplicity

The lending contracts are written in
[SimplicityHL](https://docs.simplicity-lang.org/simplicityhl-reference/), a language with Rust-like
syntax, and compile to [Simplicity](https://docs.simplicity-lang.org/), which is what a Liquid node
actually executes. Simplicity is a smart contract language for Bitcoin-like blockchains. A program
is a check over a transaction: it either authorizes the spend or the transaction is invalid, and the
resources that check will use are known before the transaction is funded.

Simplicity has been live on Liquid mainnet since July 2025. The lending protocol documented here is
a demo on Liquid testnet, which the [introduction](./intro.md) covers.

The [language documentation](https://docs.simplicity-lang.org/) is where syntax, jets, and program
structure are explained. This page only covers the parts you need in order to follow the rest of
this site.

## A contract runs when an output is spent

On Liquid, a Simplicity contract is the spending condition of a single output. It does not keep
running in the background. It executes at the moment a transaction tries to spend that output, it
sees that transaction as a whole, and it either accepts the spend or the transaction is rejected.

The wallet is what builds the transaction. The contract only checks it, and that check is what
decides how a loan ends. Repayment and liquidation are two different transactions a wallet can
propose, and once the expiry height is reached both of them satisfy the contract. The position goes
to whichever transaction confirms first.

## Terms are part of the address

A SimplicityHL program takes two kinds of input, and the difference between them is why an offer's
terms cannot change after it is published.

**Parameters**, written `param::`, are fixed when the contract is created and become part of the
resulting address. For a private lending offer they include the commitments of the collateral, the
principal and the repayment, the repayment's asset commitment, the salted hash of the expiry, the
asset IDs of the two role tokens, and the scripts the principal, the repayment and the installments
must be paid to. Changing any of them produces a different address, so creating an offer with
different terms means creating a different contract. The commitments pin the confidential outputs
without revealing their assets and amounts. [Protocol and privacy](./private-loans/protocol.md)
describes them.

**Witness data**, written `witness::`, is provided at the moment the output is spent. In the private
lending contract it chooses which action the transaction is attempting: accepting the offer,
cancelling it, paying an installment, repaying the rest in full, closing a loan that owes nothing,
or liquidating it. It also carries what the action needs and the contract checks: the debt the
loan's storage holds, the key that closes a debt of zero, and for a liquidation the expiry and its
salt.

An active loan's output also holds the debt in its storage, which is part of its address too. An
installment moves the loan to the address of the debt it leaves.

## What a contract can see

A contract does not look up an account balance or a price. It inspects the transaction in front of
it: the asset and the amount on each input and output, or their commitments when they are
confidential, the script guarding an output, and the block height the transaction is valid at.
Everything this documentation describes a contract as "checking" is one of those inspections.
Requiring the borrower NFT on a given input means comparing that input's asset and amount with the
values stored in the contract. Pinning a confidential output means comparing the hash of its asset
and amount commitments with the hash stored as a parameter. An expiry means checking the height in
the witness against the salted hash stored as a parameter, then comparing the transaction's block
height with it. An installment computes with the commitments as curve points: it subtracts the
installment's commitment from the debt, and adds the generator to the collateral's asset
commitment, which re-blinds the collateral without changing its asset or amount.

## Several contracts in one transaction

The protocol is three contracts rather than one, and each is the spending condition of its own
output. A lending transaction spends several of those outputs at once, and each contract checks only
the input it guards.

The private lending contract is the offer, described under [Private
loans](./private-loans/protocol.md). [Script auth](./contracts/script-auth.md) holds the lender's
role token until the offer is accepted or cancelled. [Asset auth](./contracts/asset-auth.md) holds
the principal and the repayment until the holder of the right role token claims them. The
[Contracts](./contracts/asset-auth.md) section describes the two helpers.

:::warning[Keep role tokens explicit]

Liquid can hide the asset and the amount of an output. The contracts read the role tokens' asset and
amount in the open, and a confidential value fails the check. A role token presented from a
confidential output cannot authorize a spend.

:::

The contracts in this repository are built and tested with
[Simplex](https://docs.simplicity-lang.org/documentation/simplex/), the Rust framework for
SimplicityHL. It turns the contract source into the Rust code that assembles witnesses and
transactions, and it runs the contract tests against a local Liquid node. Setting that up is covered
under [Developers](./developers/build.md).
