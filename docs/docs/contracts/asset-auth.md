---
description: Locks an output so it can be spent only by presenting a chosen asset of a chosen amount.
---

# Asset auth

Asset auth locks an output so that spending it requires some other input and output to carry a chosen asset, for a chosen amount. Optionally that output must be an `OP_RETURN`, which burns the asset.

## Where it is spent

A private loan uses it for two outputs, and the [private lending contract](../private-loans/protocol.md#state-transitions-and-role-tokens) pins both scripts as parameters:

- **The principal.** Accepting the offer pays it to an output locked to the borrower NFT, for an amount of one, with the burn flag off. Claiming the principal spends it: the borrower NFT is presented and handed back, and the principal is released.
- **The repayment.** Repaying the loan pays it to an output locked to the lender NFT, for an amount of one, with the burn flag on. Claiming the repayment spends it and burns the lender NFT.

The principal and the repayment are confidential. Asset auth does not read the output it guards, only the role token on the named input and output, so it works with a confidential principal or repayment. The program itself is not specific to this use. Any asset and amount can be set when the output is created.

## Parameters

These values are fixed when the output is created. Changing any of them produces a different address.

| Parameter | Type | What it fixes |
| --- | --- | --- |
| `ASSET_ID` | `u256` | Asset that the spending transaction must present. |
| `ASSET_AMOUNT` | `u64` | Amount of that asset on the named input and the named output. |
| `WITH_ASSET_BURN` | `bool` | When set, the named output must be an `OP_RETURN`. |

## Spending paths

There is one path.

| Path | Witness | What it checks |
| --- | --- | --- |
| Spend | `input_asset_index: u32`, `output_asset_index: u32` | The input and the output at those indexes both carry `ASSET_ID` for `ASSET_AMOUNT`, both explicit. When `WITH_ASSET_BURN` is set, that output is an `OP_RETURN`. |

## Source

- [`crates/contracts/simf/asset_auth.simf`](https://github.com/BlockstreamResearch/simplicity-lending/blob/main/crates/contracts/simf/asset_auth.simf)
- [`crates/contracts/src/programs/asset_auth/params.rs`](https://github.com/BlockstreamResearch/simplicity-lending/blob/main/crates/contracts/src/programs/asset_auth/params.rs)
- [`crates/contracts/src/programs/asset_auth/witness.rs`](https://github.com/BlockstreamResearch/simplicity-lending/blob/main/crates/contracts/src/programs/asset_auth/witness.rs)
