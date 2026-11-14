---
description: Holds an output until a transaction also spends one specific other script.
---

# Script auth

Script auth holds an output until the transaction that spends it also spends an output of one chosen script. A key is not enough. The chosen script has to be present as an input.

## Where it is spent

Creating a private offer places the lender NFT under script auth bound to the script of the pending offer. The NFT stays there until the offer is accepted or cancelled, as [Protocol and privacy](../private-loans/protocol.md#state-transitions-and-role-tokens) describes. Both of those transactions spend the pending offer and this output together, which is why the borrower can cancel without a lender, and why the lender NFT cannot be taken without the offer.

## Parameters

This value is fixed when the output is created. Changing it produces a different address.

| Parameter | Type | What it fixes |
| --- | --- | --- |
| `SCRIPT_HASH` | `u256` | Script hash that must appear on one input of the spending transaction. |

## Spending paths

There is one path.

| Path | Witness | What it checks |
| --- | --- | --- |
| Spend | `input_script_index: u32` | The input at that index has script hash `SCRIPT_HASH`. The asset and the amount on this output are left unchecked. |

## Source

- [`crates/contracts/simf/script_auth.simf`](https://github.com/BlockstreamResearch/simplicity-lending/blob/main/crates/contracts/simf/script_auth.simf)
- [`crates/contracts/src/programs/script_auth/params.rs`](https://github.com/BlockstreamResearch/simplicity-lending/blob/main/crates/contracts/src/programs/script_auth/params.rs)
- [`crates/contracts/src/programs/script_auth/witness.rs`](https://github.com/BlockstreamResearch/simplicity-lending/blob/main/crates/contracts/src/programs/script_auth/witness.rs)
