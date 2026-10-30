# Private lending, part C2: session handoff (2026-10-30)

Read this file first.

- **Background:** the earlier handoff (`docs/superpowers/handoff/2026-10-29-private-lending.md`) covers parts A, B and C1 and the user's decisions, and the spec is the binding design.
- **Plan in progress:** `docs/superpowers/plans/2026-10-29-private-lending-frontend.md` (part C2, 11 tasks).

## Where things stand

The branch `private-lending-frontend` holds Tasks 1–6 of the plan. It is not merged and not pushed. `main` holds parts A, B and C1.

**Done, with every flow proven on Liquid testnet:**
- **Wasm helpers** (`crates/private-lending-wasm`):
  - `confidentialAddress`, `contractHashFromJson`, `freshIssuerPubkey`;
  - `inspectPset`, which reads a PSET through rust-elements: per-input issuance, sequence and lock time; per-output commitments, keys and blind proofs.
- **Flow plumbing** (`web/src/privateLending/`):
  - `deps.ts` (`PrivateFlowDeps`);
  - `verify.ts`: `openAndVerifyOffer` is the only producer of a `VerifiedOffer`, which is a branded type;
  - `secrets.ts`, `inspectPset.ts`, `finalize.ts`;
  - `flows/shared.ts`, home of the single PSET layout checker, `assertSpendLayout`.
- **Builders** (`web/src/privateLending/flows/`): `creation`, `acceptance`, `claimPrincipal`, `repayment`, `claimRepayment`, `cancellation` and `liquidation`.
  - They are DOM-free, so the browser and Node run the same code.
  - Each asserts the layout through `inspectPset` before and after blinding.
  - Each checks the txid after signing and after finalizing.
  - Creation ends with the borrower's self-check, in which every error is fatal.
- **Witnesses, weights and layout constants** live in `web/src/simplicity/private-lending/{witness.ts,layout.ts}`, `web/src/lwk/weights.ts` and `web/src/simplicity/asset-auth/witness.ts`. The weights below are measured on testnet, with 10 % added:

  | Branch or input | Measured | Constant |
  |---|---|---|
  | OfferAcceptance | 2998 | 3298 |
  | FullRepayment | 3028 | 3331 |
  | OfferCancellation | 2881 | 3170 |
  | Liquidation | 2853 | 3139 |
  | script_auth | 338 | 400 |
  | asset_auth, no burn | 713 | 800 |
  | asset_auth, burn | 812 | 894 |
  | p2wpkh NFT input | 107 | 150 |
- **Headless e2e** (`npx pnpm@10.33.0 e2e:private [stage...]` from `web/`):
  - Two seed wallets live in `web/.env.e2e.local`, which is git-ignored and holds the seed phrases. Never print or commit them.
  - State is kept in `web/.e2e-private/state.json` (git-ignored).
  - A transaction is saved as `built` before broadcast. A re-run rebroadcasts the saved hex and never rebuilds.
  - Funding is checked per stage through `STAGE_NEEDS` in `web/scripts/e2e/env.ts`.
  - Dry stages (`*-dry`) build and check without broadcasting.

**Testnet transactions** (Liquid testnet, all confirmed):

| Stage | txid |
|---|---|
| split, borrower | `5bf70538add52d14a409d158c3a272fc3a15281a38462c7ce4bfffe8edbeadee` |
| split, lender | `1a8e628fa0ddefdb472fef26f79d48d335f08d44565743e16814c43228fa814a` |
| create | `6816e8b1ff48930adabc284cfba57717bb7fda0d72499b8aeff4425cab6b682d` |
| top-up, lender → borrower | `09dead5d68da62f93e8c0947fcb3f2fbf615d963abb138d12c4fe6f87024ecdb` |
| accept | `baf52dd7855225cf8a51ddb2d52d55f399c23e6b3fb8427b7916bb6a3b6b55b2` |
| claim principal | `315a62e59d82544c0741ee16dd415ffdbaae3e648be2590f938e29e5d9a09c9c` |
| repay | `1d30ea1cb2650d55b67c54fa1de8d880677cee183ba8d4a82a35dfc9853011aa` |
| claim repayment | `9fdf6079a69a8198049d9516f2f7f6f23e3a2d82f0f13c5028a913adce057c7f` |
| cancel: creation | `79475afcae94666bc1ebcdd3748a461836bc278016eb312c06fe6a1ee9f1849c` |
| cancel | `da907491ea0914b1f2c36bacd9971397fa686be592a2a7ec47fceb58d5111d79` |
| liquidate: creation | `3c15d48283c94dc384e18a78daa7ebd885cd0b4aea7d6ae2f058d31df39b1807` |
| liquidate: accept | `0f2512d69c6b2782af1425394e2be067b3bf4e539964ab9f73a39f7f1a51742c` |
| liquidate | `56af64c2ec20be313674c70ea312f50654b6ca65c8ab449d853fd5c89fb270e6` |

Notes on the liquidation:
- It was refused twice before expiry with `expiry-not-reached`, before anything was built.
- It was mined one block after the expiry height. Its lock time is the expiry, and the offer input's sequence is `0xfffffffe`.

## What comes next, in order

1. **Tasks 7–10 of the plan** (the UI half):
   - **Task 7:** the indexer client for the private endpoints, scanning (lender inbox and borrower recovery), and directory writes.
     - It runs against a local testnet indexer: a database `lending-indexer-testnet` (install sqlx-cli 0.8 to create and migrate it), with `DATABASE__DATABASE_NAME=…` and `INDEXER__LAST_INDEXED_HEIGHT=<before 2683000>`. See the plan's Global Constraints.
     - The e2e offers above are the scan's ground truth.
   - **Task 8:** wallet plumbing (`getLendingKey`, `privateCapable`, `getWalletTxOuts`) and the hooks. `finalize` is async (`AsyncUpdatedPset`), so the hooks must await it.
   - **Tasks 9 and 10:** the Private page, `/app/private`, with Directory, Lend and Borrow sections. Its modals call the builders above.
2. **Task 11, run by the user:** the testnet run through the UI with the seed wallet, plus the Jade check.
   - Check that Jade signs pinned outputs with `blinder_index = Some(i)`.
   - Check how Jade shows the NFT contract domain `simplicity-lending.private`.
3. **The final whole-branch review** of `private-lending-frontend`, then merge.

**Before any new e2e creation:** the borrower has only 2 tL-BTC coins left, and a creation needs at least 3 distinct coins. So split the borrower's coins first, or fund it from the faucet. `create-dry` fails until then.

## How work is run (user's instructions)

- Plans are executed subagent-driven, with one commit per task. Pushes go to `fork`, never `origin`, and the user decides about merging.
- **Since 2026-10-30:**
  - implementers run on Opus;
  - no review after each task, only one review at the end of the phase;
  - a per-task review only when the controller flags a task as important.

  This is saved in Claude's project memory.
- The SDD ledger for this plan is `.superpowers/sdd/2026-10-29-private-lending-frontend/progress.md` (git-ignored). Tasks 1–6 are marked complete there. Its `global-constraints.md` holds the rulings in the form given to implementers. Keep both until the phase ends.

## Rulings made during part C2

Rulings 4 and 5 replace the plan's fixed e2e funding numbers. Rulings 8–10 change builder interfaces that Tasks 8–10 must follow.

1. **Branch.** Work on a branch in the main checkout, not a worktree.
2. **Testnet broadcasts.** Subagents may broadcast from the two e2e wallets on testnet; never mainnet.
3. **Contract hash test.** The `contractHashFromJson` test pins an independent known answer: `aab713dd…424ca4`, computed in Python.
4. **Need-based funding.** The minimums come from shared constants: `COLLATERAL` 20 000, `PRINCIPAL` 1 000, `REPAYMENT` 1 100, `FEE_BUDGET` 2 000. Records are saved as `built` before broadcast.
5. **Per-stage needs.** `STAGE_NEEDS` lists each stage's needs. The startup check covers only stages that aren't confirmed yet, and each stage checks its own need before building.
6. **PSET inspection in wasm.** The hand-written TS parser was removed. Negative asserts check explicit nulls, and the offer output must carry both blind proofs.
7. **Async finalize.** `AsyncUpdatedPset` is accepted, and the `terms-mismatch` code is documented.
8. **NFT inputs** are outpoint strings spent as `ExternalUtxo`, because LWK lists no explicit NFT outputs among wallet coins. Builders fetch and verify the NFT at that outpoint.
9. **Fee coins.** Builders take explicit `feeCoins`, and all input outpoints must be distinct.
10. **Explicit change.** Builders emit non-L-BTC change themselves, because LWK places it before the post-issuance outputs.
11. **Module split.** Witness builders and weights moved to `witness.ts` and `weights.ts`, so Node can import them without Vite.
12. **One layout checker** for all flows. Claims are tied to their offer, and the e2e asserts the measured weights.
13. **Task 6's final check** is a no-argument run over the existing state, not a clean-state rerun, which would need new funds.

Other changes not foreseen by the plan:
- `inspectPset` gained `lockTime` and per-input `sequence`.
- An `ExpiryNotReachedError` was added.
- The liquidation pays the collateral to an explicit `collateralReceiver` output.
- In Task 3, `OpenedOffer.firstInput()` was fixed: it had a stray `[elements]` prefix.

## Open items for the final review

Smaller deferred findings, recorded in the ledger:
- `Secp256k1::new()` is called on each `freshIssuerPubkey` call.
- `toOfferError` has no unit test.
- The broadcast "already known" regex is broad.
- The inflation-keys assert accepts `null` or `0`.
- The acceptance change goes to the same address as the lender NFT (a privacy issue).
- An acceptance with no fresh blinded output would fail inside `blindPset`.
- There are no failing-case layout tests.
- The commitments of spent outputs aren't checked before signing; a mismatch only invalidates the transaction.
- Fresh outputs are checked for a blinding key, but not that it is the receiver's key.

Part C2 has had no whole-branch review yet.
