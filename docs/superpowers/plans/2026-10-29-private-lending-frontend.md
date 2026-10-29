# Private lending, part C2: transaction flows and the Private section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Borrowers and lenders run private loans from the web app with Jade or the seed wallet. That covers registering in the directory, creating offers, the lender's inbox, and accepting, cancelling, repaying, liquidating and claiming.

Every transaction is built by plain TypeScript functions. A headless script proves those functions on Liquid testnet with two seed wallets (Tasks 1–6). The UI wires them to the wallet and the indexer (Tasks 7–10). The user then runs the UI on testnet with the seed wallet and Jade (Task 11).

**Architecture:**
- **Flow builders.** Each flow is a pure builder in `web/src/privateLending/flows/`. It takes its dependencies as arguments: LWK, the wasm module, the wallet's `Wollet` and coins, a transaction fetcher and the covenant sources. It returns the existing `UpdatedPset` shape, `{ pset, finalize }`.
- **The same code in the browser and in Node.** The React hooks (Task 8) and the Node e2e script `web/scripts/e2e-private-lending.ts` run the same code.
- **Build order.** Builders use LWK's `TxBuilder` with `skipBlinding()`, then the wasm module's `blindPset`. They sign through the wallet connector: in the e2e script, LWK's `Signer` for the seed; in the app, Jade or the seed (Task 11 checks Jade).
- **Finalization.** Simplicity inputs are finalized with LWK's `SimplicityProgram.finalizeTransactionWithSpendInfo`, as the public flows do.
- **One gate for valid offers.** `openAndVerifyOffer` is the only producer of a verified offer. It opens the offer in wasm, then checks its addresses with LWK.
- **The UI.**
  - It adds an indexer client for the private endpoints from part B.
  - It adds scanning: the lender's inbox and the borrower's recovery, cached per lending key.
  - It adds wallet plumbing: the lending key from the session descriptor, and a flag that is true only for Jade and the seed wallet.
  - It adds one page, `/app/private`, with Directory, Borrow and Lend sections.

**Tech Stack:** TypeScript 5.9, React 19, React Query 5, HeroUI 3, zod 3, `@lilbonekit/lwk-web` 0.17.2, the `private-lending-wasm` package (part C1), tsx; Rust for three small wasm additions.

**Spec:** `docs/superpowers/specs/2026-10-28-private-lending-design.md`, sections "Building transactions in the browser", "Lender verification", "The contract", "Keys and secrets", "Indexer" and "Front end". The handoff's part C2 list (`docs/superpowers/handoff/2026-10-29-private-lending.md`) is binding. The wasm API reference is `crates/private-lending-wasm/README.md`, and the indexer API is the Private lending section of `crates/indexer/README.md`.

**Decisions with the user (2026-10-29):**
- Browser flows are proven on Liquid testnet with seed wallets, because no waterfalls server exists for regtest.
- A Jade is available for the hardware check in Task 11.
- Two testnet wallets were generated into `web/.env.e2e.local` (git-ignored; `PRIVATE_E2E_BORROWER_MNEMONIC`, `PRIVATE_E2E_LENDER_MNEMONIC`), and the user has funded them.
- All of part C2 is one plan; no further split.

## Global Constraints

- **Branch and commits.** Work on the branch `private-lending-frontend`, created from `main`. Each task ends with exactly one commit (message given in its last step), ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- **Builders are DOM-free.**
  - No React, no `import.meta.env` and no `virtual:simplicity-sources` in `web/src/privateLending/flows/**`, `verify.ts` or `deps.ts`.
  - Everything environment-specific comes in through `PrivateFlowDeps` (Task 2).
  - Only the hooks in Task 8 bind the app's providers.
- **Creation layout** (spec, part A):
  - Inputs 0 and 1 are borrower coins issuing the borrower NFT and the lender NFT, one unit each, with no reissuance token.
  - Outputs: 0 is the borrower NFT to the borrower, 1 is the lender NFT at the lender-NFT lock, 2 is `OP_RETURN` marker, and 3 is the pending offer. Change and fee follow.
  - Input 0's outpoint is the offer's first input.
- **Contract branch layouts.** They come from `crates/contracts/src/programs/private_lending/core.rs`; follow them exactly.
  - **Accept:**
    - Inputs: 0 pending offer, 1 locked lender NFT.
    - Outputs: 0 active offer, 1 principal at asset_auth(borrower NFT, 1, no burn), 2 lender NFT to the lender.
  - **Cancel:**
    - Inputs: 0 pending offer, 1 locked lender NFT, 2 borrower NFT.
    - Outputs: 0 burns the lender NFT and 1 burns the borrower NFT. The collateral goes to the borrower.
  - **Full repay:**
    - Inputs: 0 borrower NFT, 1 active offer.
    - Outputs: 0 burns the borrower NFT and 1 is the repayment at asset_auth(lender NFT, 1, burn). The collateral goes to the borrower.
  - **Liquidate:**
    - Inputs: 0 active offer, 1 lender NFT.
    - Output 0 burns the lender NFT. The collateral goes to the lender.
  - **Claims:**
    - The borrower spends the principal output with its borrower NFT (asset_auth, no burn).
    - The lender spends the repayment output, burning its lender NFT (asset_auth, burn).
    - Read the asset_auth witness and input/output index rules from `crates/contracts/simf/asset_auth.simf` and the public claim hooks (`web/src/hooks/useClaimPrincipal.ts`, `useLenderVaultClaim.ts`).
- **Blinding keys.**
  - Output 3 of creation carries `NewOffer.collateralBlindingKey()`.
  - Outputs created at acceptance (active offer, principal) carry `OpenedOffer.borrowerBlindingKey()`.
  - The repayment output carries `OpenedOffer.lenderBlindingKey()`.
  - Pinned outputs are added to the PSET through `confidentialAddress(script, key, network)` (Task 1) and `addPostIssuanceRecipient`, so LWK keeps their blinding key.
- **Blinding order.**
  1. `TxBuilder…skipBlinding().finish(wollet)`.
  2. `blindPset(pset.toString(), inputSecrets, pinnedBlindings)` with fresh handles on every call.
  3. `new Pset(b64)`, then sign, then finalize the wallet inputs, then the Simplicity inputs.
- **Input secrets.** Every confidential input needs an `InputSecret`:
  - wallet coins: from `WalletTxOut.unblinded()`;
  - covenant inputs: from `OpenedOffer.inputSecret(role, index)`.
  - Issuance inputs stay unblinded.
- **Fresh NFT entropy.** Every creation build draws a fresh issuer key (`freshIssuerPubkey()`, Task 1) for both NFT `Contract`s. It computes the NFT ids with `issuedAssetId(outpoint, contractHashFromJson(contract.toString()))` before building outputs. After `finish`, it asserts that the PSET's issuance asset ids equal them. Never reuse `web/src/lwk/assetContract.ts` for private NFTs.
- **Verification gate.** `openAndVerifyOffer` (Task 2) is the only way to get a `VerifiedOffer`.
  - Every builder that spends an offer takes a `VerifiedOffer`.
  - The borrower's self-check runs `openAndVerifyOffer('borrower', …)` on the finalized creation transaction before it is returned for broadcast. It treats every error code as fatal.
- **Retry.** A creation is broadcast from its finalized hex. A retry rebroadcasts the same hex; it never rebuilds.
- **Interest.** Interest shown or logged is `repaymentAmount − principalAmount`, never `interestRateBps` (Ruling P8).
- **Network.** testnet: tL-BTC (`144c…9a49`) is the collateral and fee asset, and TEST (`38fc…50a5`, 3 decimals) is the principal (`web/src/constants/network-config.ts`).
- **The e2e script** reads `web/.env.e2e.local`. It uses esplora at `https://blockstream.info/liquidtestnet/api` and waterfalls from `web/.env.liquidtestnet`. Its default amounts:
  - collateral: 20 000 tL-sats;
  - principal: 1 000 TEST units;
  - repayment: 1 100 TEST units;
  - expiry: tip + 1 440 blocks, or tip + 3 for the liquidation offer.

  It waits for one confirmation between phases, polling esplora every 10 s for up to 10 min. Every broadcast txid is printed.
- **Before finishing any task**, run from `web/` with `npx pnpm@10.33.0`, for example `npx pnpm@10.33.0 lint`:
  - `build:wasm` (when Rust changed), then `lint`, `build` and `parity`;
  - `npx prettier --check` on changed web files.

  If Rust changed, also run:
  - `cargo fmt --all`;
  - `cargo test -p private-lending-wasm`;
  - `SQLX_OFFLINE=true cargo clippy --workspace --all-targets --all-features -- -D warnings`.
- **E2e evidence.** Each flow task's e2e stage must succeed on testnet. Txids and the stage output go in the task report. If the wallets are not funded yet, the task is BLOCKED; report it.
- **UI scope.**
  - The Private section and its nav link appear only when `signerType` is `'jade'` or `'seed'`.
  - Public pages and flows stay unchanged.
  - The section is one route, `/app/private` (`RoutePath.Private`), with Directory, Borrow and Lend sections.
- **The lending key.** It is derived in the browser from the session descriptor: `wasm.LendingKey.fromDescriptor(descriptor.toString())`. It is held in memory for the session, and never persisted or sent anywhere. Only the x-only key leaves the browser, and only for directory writes and for creating offers.
- **Showing keys and names.**
  - Every lending key that is chosen or shown is shown with `keyFingerprint` in 4×4 groups, for example `1aa0 5299 d34b b9f5`.
  - Directory display names render inside `<bdi>`, always next to the fingerprint.
- **Scanning.** It follows the indexer README's sync recipe.
  - The first page's `last_indexed_height` becomes `to_height` for the remaining pages, and the next sync starts at that height + 1.
  - The lender checks `viewTagMatches` first, and fetches `/tx` only on a match.
  - The borrower checks `isOwnCandidate`. Nonces come from the indexer, never from raw transaction bytes.
  - Matches go through `openAndVerifyOffer`.
  - The cache (`PersistentKv`, keyed by lending-key fingerprint) stores only the synced height and the creation txid with its verification result: `verified`, or `invalid` plus the code. Never terms or secrets.
  - Offers that are not addressed to the key are not stored. Invalid ones are listed as invalid, with no actions.
- **Refreshing.** Views refetch on the SSE `block_indexed` event, through the existing `providers/indexerEvents`.
- **Directory writes.** Get a challenge (`POST /private/directory/challenges`), then `signDirectoryAction`, then `PUT` or `DELETE`. A 401 is shown to the user with its message.
- **Amounts.** They are formatted with `NETWORK_CONFIG` decimals, and interest is always repayment − principal.
- **Local testnet indexer** for e2e and manual runs:
  1. A separate database, `lending-indexer-testnet`, created and migrated with `sqlx` (install `sqlx-cli` 0.8 with `--no-default-features --features rustls,postgres --locked` if it is missing).
  2. Two processes from `crates/indexer`, both with `DATABASE__DATABASE_NAME=lending-indexer-testnet`: `RUN_MODE=indexer` with `INDEXER__LAST_INDEXED_HEIGHT=<a height before the first e2e creation>`, and `RUN_MODE=api`.
  3. `configuration/base.yaml` already points at testnet esplora. Build with `SQLX_OFFLINE=true`.

  Never point the indexer tests at this database.

## Review Focus

- **Fresh NFTs.** A rebuilt creation must get new NFT ids, so the ephemeral key, blinders and marker pad are never reused. Test: the e2e creation stage builds twice from the same coins, without broadcasting the first, and asserts different NFT ids and different output 3 nonces (Task 3).
- **A misbehaving LWK.** If LWK drops a pinned output's blinding key or blinder index, or reorders outputs, the builder must throw before signing. A broadcast offer the lender cannot open would strand the collateral. Test: each builder asserts output scripts, order and blinding keys after `finish` and after `blindPset`. The creation self-check covers the rest (Tasks 3–6).
- **A lender acting on an unverified offer.** Acceptance must not be buildable from a transaction that only opened. Test: the type system, since `buildAcceptance` takes `VerifiedOffer`, plus the e2e lender stage running `openAndVerifyOffer('lender', …)` on the fetched creation (Task 4).
- **Expiry and liquidation.** Liquidating before expiry must fail before broadcast, with the lock time and sequence set as the contract requires. Test: the e2e liquidation stage first tries at tip < expiry and expects a pre-broadcast error, then succeeds after expiry (Task 6).
- **A failed broadcast or partial run.** A failed broadcast must be retryable with the same hex, and a re-run must not create duplicate offers. Test: the e2e script saves each finalized hex to `web/.e2e-private/` (git-ignored) before broadcasting, and resumes from saved state (Task 3).
- **The indexer as an adversary.** It may hide candidates, but it must never make an invalid offer look acceptable. Test: the e2e `scan` stage feeds the scanner a candidate whose `/tx` response is another offer's creation. The scanner must report it invalid or not addressed, never verified (Task 7).

---

### Task 1: wasm helpers for LWK transactions

**Files:**
- Modify: `crates/private-lending-wasm/src/{build.rs,keys.rs,lib.rs}`, `crates/private-lending-wasm/Cargo.toml` (`elements` feature `json-contract`), `crates/private-lending-wasm/README.md`

**Interfaces:**
- `#[wasm_bindgen(js_name = confidentialAddress)] pub fn confidential_address(script_pubkey_hex: &str, blinding_key_hex: &str, network: &str) -> Result<String, String>`.
  - `network` is `"liquid"`, `"liquidtestnet"` or `"regtest"`. They map to `AddressParams::LIQUID`, `LIQUID_TESTNET` and `ELEMENTS`.
  - It returns `Address::from_script(script, Some(blinding_key), params)?.to_string()`, and fails with `bad-input` for a script with no address form.
- `#[wasm_bindgen(js_name = contractHashFromJson)] pub fn contract_hash_from_json(json: &str) -> Result<String, String>`: `ContractHash::from_json_contract(json)` in `Display` format, the format `issuedAssetId` takes.
- `#[wasm_bindgen(js_name = freshIssuerPubkey)] pub fn fresh_issuer_pubkey() -> String`: a random secp256k1 public key (33-byte hex) from `rand::thread_rng()`. Its only purpose is fresh issuance entropy, so the secret is discarded.

- [ ] **Step 1: Write the failing tests.**
  - `confidential_address_round_trips`: parse the result with `elements::Address::from_str`. It has the given script and blinding key, and `params` for each network.
  - `contract_hash_matches_elements`: compare with `ContractHash::from_json_contract` for an ELIP-100 contract string. Use the JSON shape of LWK's `Contract.toString()`; copy an example from `web/src/lwk/assetContract.ts`, or build one with `Contract` in a scratch Node run.
  - `fresh_issuer_pubkeys_differ`: two calls give different keys.
  - `bad_inputs_are_rejected`: each case is `bad-input`: a malformed script hex, an unknown network, and malformed JSON.
- [ ] **Step 2: Run** `cargo test -p private-lending-wasm`. Expected: FAIL.
- [ ] **Step 3: Implement**, then document the three exports in the README.
- [ ] **Step 4: Run** `cargo test -p private-lending-wasm`, then `npx pnpm@10.33.0 build:wasm`, then `parity`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "private-lending-wasm: confidential addresses, contract hashes, issuer keys"`

### Task 2: Flow dependencies, the verification gate and the e2e harness

**Files:**
- Create:
  - `web/src/privateLending/deps.ts`
  - `web/src/privateLending/verify.ts`
  - `web/src/privateLending/secrets.ts`
  - `web/scripts/e2e-private-lending.ts`
  - `web/scripts/e2e/{env.ts,wallet.ts,chain.ts,state.ts}`
- Modify:
  - `web/package.json`: script `"e2e:private": "tsx --tsconfig tsconfig.app.json scripts/e2e-private-lending.ts"`.
  - `web/.gitignore`: `.e2e-private/`.

**Interfaces:**
- `deps.ts`:

```ts
export interface PrivateFlowDeps {
  lwk: typeof import('@lilbonekit/lwk-web')
  wasm: typeof import('@/wasm/private-lending/private_lending_wasm')
  network: Network            // LWK
  networkName: 'liquid' | 'liquidtestnet' | 'regtest'
  sources: PrivateLendingSources   // from C1 scripts.ts
  wollet: Wollet
  walletUtxos: () => WalletTxOut[] // the wallet's spendable coins
  fetchTx: (txid: string) => Promise<Transaction>
  feeRate: number | null
  assets: { collateral: string; principal: string; policy: string }
}
```

- `verify.ts`:
  - `export interface VerifiedOffer { readonly role: 'lender' | 'borrower'; readonly creationTx: Transaction; readonly opened: OpenedOffer; readonly scripts: PrivateOfferScripts }`.
  - `export async function openAndVerifyOffer(deps: PrivateFlowDeps, role: 'lender' | 'borrower', key: LendingKey, creationTxHex: string): Promise<VerifiedOffer>`. It opens the offer as that role, runs `privateOfferScripts(deps.sources, toPrivateOfferArguments(opened.contractArguments()), deps.network)`, and then requires `verifyOfferAddresses`.
  - It throws `PrivateOfferError` with `code: string` (the wasm code, or `address-mismatch`) and `addressedToKey: boolean`: false for the not-addressed codes, true otherwise.
  - The constructor is not exported, so the gate is the only producer of a `VerifiedOffer`.
- `secrets.ts`: `export function walletInputSecret(deps, utxo: WalletTxOut, inputIndex: number): InputSecret`, which maps `utxo.unblinded()` to `wasm.InputSecret.new` or `.explicit`.
- The e2e harness:
  - `env.ts` loads `.env.e2e.local` and `.env.liquidtestnet` without dotenv: a small parser. There are no new dependencies.
  - `wallet.ts`: `seedWallet(mnemonic) -> { signer, wollet, lendingKey, sync(), utxos(), address() }`. `sync` uses LWK's `EsploraClient` against waterfalls, as `web/src/lwk/index.ts` does. The lending key comes from `wasm.LendingKey.fromDescriptor(signer.wpkhSlip77Descriptor().toString())`.
  - `chain.ts`: `fetchTx`, `broadcast(hex)`, `tipHeight()`, `waitForConfirmation(txid)` against esplora.
  - `state.ts`: `web/.e2e-private/state.json`, one record per stage, holding `{stage, txid, hex, status}`. A stage whose record is `broadcast` or `confirmed` is skipped on re-run.
  - `e2e-private-lending.ts` runs named stages: `npx pnpm@10.33.0 e2e:private [stage...]`.
    - This task adds stage `wallets`. It syncs both wallets and prints their balances in tL-BTC and TEST, and their lending key fingerprints.
    - It fails with a clear message, naming the addresses to fund, below these minimums. Three offers are created; two are accepted.
      - Borrower: 100 000 tL-sats and 200 TEST units, for the interest.
      - Lender: 2 500 TEST units and 20 000 tL-sats.
    - A creation spends at least three distinct coins: the first input, the lender NFT coin, and the collateral.
      - So `wallets` also splits a wallet that has fewer than 6 confirmed tL-BTC coins. It sends 6 outputs of 15 000 tL-sats to its own address, and waits for the confirmation.
      - It records the split in the state, like any other stage.

- [ ] **Step 1:** Write `wallets` and the gate's error mapping.
- [ ] **Step 2: Run** `npx pnpm@10.33.0 e2e:private wallets`. Expected: the balances and fingerprints of both wallets. If they are unfunded, it prints the addresses and exits 1; then report BLOCKED with that output.
- [ ] **Step 3:** `lint`, `build` and `prettier --check` pass.
- [ ] **Step 4: Commit.** `git commit -m "web: private flow dependencies, verification gate, testnet e2e harness"`

### Task 3: Creation

**Files:**
- Create: `web/src/privateLending/flows/creation.ts`
- Modify: `web/scripts/e2e-private-lending.ts` (stage `create`)

**Interfaces:**
- `export interface CreationParams { borrower: LendingKey; lender: string /* x-only hex */; firstInput: WalletTxOut; lenderNftCoin: WalletTxOut; collateralCoins: WalletTxOut[]; collateralAmount: bigint; principalAmount: bigint; repaymentAmount: bigint; loanExpirationTime: number; borrowerNftReceiver: Address }`
  - `interestRateBps` is computed for display only, as `(repayment − principal) * 10000 / principal`.
- `export async function buildPrivateCreation(deps: PrivateFlowDeps, params: CreationParams): Promise<UpdatedPset<CreationSummary>>`. The order of operations:
  1. Draw fresh NFT contracts and ids.
  2. `NewOffer.build`.
  3. Compute the scripts with `privateOfferScripts`.
  4. Build the PSET with `TxBuilder`, `skipBlinding()`, the inputs ordered `[firstInput, lenderNftCoin, ...collateral]`, two `issueAssetToRecipients` calls at inputs 0 and 1, `addPostIssuanceScriptOutput(Script.newOpReturn(marker), 0, policy)`, and `addPostIssuanceRecipient(confidentialAddress(pendingOffer, collateralBlindingKey), collateral, collateralAsset)`.
  5. Assert the layout.
  6. `blindPset` with the wallet input secrets and `newOffer.collateralBlinding(3)`.
  7. Assert the layout again.
  8. Return the `{ pset, finalize }` pair. `finalize` runs `wollet.finalize`, then `extractTx`, then the borrower self-check via `openAndVerifyOffer('borrower', …)`, and returns the finalized transaction.
- `CreationSummary` holds `{ creationTxHex, offerOutpoint, borrowerNft, lenderNft, interest }`.

- [ ] **Step 1: E2e stage `create`.**
  - The borrower builds a creation to the lender's lending key from the borrower wallet's coins.
  - It builds twice without broadcasting, and asserts that the two builds have different NFT ids and different output 3 nonces (Review Focus).
  - It signs with the seed signer, saves the hex to the state, broadcasts and waits for a confirmation.
  - The lender fetches the transaction by txid and runs `openAndVerifyOffer('lender', …)`.
  - It prints the terms the lender sees, with the interest from the amounts.
- [ ] **Step 2: Run** `npx pnpm@10.33.0 e2e:private create`. Expected: FAIL before the builder exists.
- [ ] **Step 3: Implement** `creation.ts`. If LWK misses a blinding key or blinder index on output 3, or orders outputs differently, fix the builder until the asserts pass. Record what LWK actually does in the report; the UI tasks and the Jade check depend on it.
- [ ] **Step 4: Run** the stage. Expected: a confirmed creation txid on testnet, which the lender verifies. Run it again; it skips via the state.
- [ ] **Step 5: Commit.** `git commit -m "web: private offer creation flow, proven on testnet"`

### Task 4: Acceptance and principal claim

**Files:**
- Create: `web/src/privateLending/flows/acceptance.ts`, `web/src/privateLending/flows/claimPrincipal.ts`, `web/src/privateLending/finalize.ts`
- Modify: `web/src/simplicity/private-lending/program.ts` (`PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY`), `web/scripts/e2e-private-lending.ts` (stages `accept`, `claim-principal`)

**Interfaces:**
- `finalize.ts`: `export function finalizePrivateOfferInput(deps, tx: Transaction, offer: VerifiedOffer, active: boolean, prevouts: TxOut[], inputIndex: number, branch: PrivateLendingBranch): Transaction`, plus `finalizeScriptAuthInput(...)` and `finalizeAssetAuthInput(...)` with the same shape. They wrap `finalizeTransactionWithSpendInfo`.
- `program.ts`: `export const PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY: Record<PrivateLendingBranch, number>`.
  - Start each branch at 4 000.
  - After the e2e stages succeed, replace each value with the measured witness weight of the broadcast transaction plus 10 %, as the public `LENDING_MAX_WEIGHT_TO_SATISFY` comment describes.
- `export async function buildPrivateAcceptance(deps, offer: VerifiedOffer /* role 'lender' */, params: { principalCoins: WalletTxOut[]; lenderNftReceiver: Address }): Promise<UpdatedPset<AcceptanceSummary>>`
  - The pending offer and the locked lender NFT are `ExternalUtxo`s, with secrets from `offer.opened.inputSecret(PendingCollateral, 0)` and an explicit NFT.
  - Outputs: 0 is `activeCollateral` at `confidentialAddress(activeOffer, borrowerBlindingKey)`, 1 is `principal` at the principal asset_auth with `borrowerBlindingKey`, and 2 is the lender NFT.
  - Blinding uses `pinnedBlinding(ActiveCollateral, 0)` and `pinnedBlinding(Principal, 1)`.
  - Finalize with the `OfferAcceptance` branch on input 0 and script_auth on input 1.
- `export async function buildPrincipalClaim(deps, offer: VerifiedOffer /* role 'borrower' */, params: { principalOutpoint: string; borrowerNftCoin: WalletTxOut; receiver: Address })`. It spends the principal output: the secrets come from `offer.opened.inputSecret(Principal, i)`, and the asset_auth input is finalized.

- [ ] **Step 1: E2e stages.**
  - `accept`: the lender accepts the confirmed offer from `create`.
  - `claim-principal`: the borrower claims the principal into its wallet.
  - Each stage asserts the expected outputs, by `PinnedOutputInfo.matches` and by script, before broadcasting.
- [ ] **Step 2: Run** them. Expected: FAIL before implementing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both stages. Expected: both confirm on testnet, and the borrower's TEST balance rises by the principal. Measure the witness weights, then set `PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferAcceptance`.
- [ ] **Step 5: Commit.** `git commit -m "web: private acceptance and principal claim flows, proven on testnet"`

### Task 5: Full repayment and repayment claim

**Files:**
- Create: `web/src/privateLending/flows/repayment.ts`, `web/src/privateLending/flows/claimRepayment.ts`
- Modify: `web/src/simplicity/private-lending/program.ts` (the measured `FullRepayment` weight), `web/scripts/e2e-private-lending.ts` (stages `repay`, `claim-repayment`)

**Interfaces:**
- `export async function buildPrivateRepayment(deps, offer: VerifiedOffer /* 'borrower' */, params: { activeOfferOutpoint: string; borrowerNftCoin: WalletTxOut; principalCoins: WalletTxOut[]; collateralReceiver: Address })`
  - Inputs: 0 is the borrower NFT and 1 is the active offer.
  - Outputs: 0 burns the borrower NFT, 1 is the `repayment` at the repayment asset_auth with `lenderBlindingKey` and `pinnedBlinding(Repayment, 1)`, and the collateral goes to the borrower.
  - Finalize with the `FullRepayment` branch.
- `export async function buildRepaymentClaim(deps, offer: VerifiedOffer /* 'lender' */, params: { repaymentOutpoint: string; lenderNftCoin: WalletTxOut; receiver: Address })`. It spends the repayment output, burning the lender NFT.

- [ ] **Step 1: E2e stages.** `repay` runs on the offer from the earlier stages, then `claim-repayment`.
- [ ] **Step 2: Run** them. Expected: FAIL before implementing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both. Expected: both confirm. The lender's TEST balance rises by the repayment, and the borrower's collateral is back in its wallet. Set the `FullRepayment` weight.
- [ ] **Step 5: Commit.** `git commit -m "web: private repayment and repayment claim flows, proven on testnet"`

### Task 6: Cancellation and liquidation

**Files:**
- Create: `web/src/privateLending/flows/cancellation.ts`, `web/src/privateLending/flows/liquidation.ts`
- Modify: `web/src/simplicity/private-lending/program.ts` (the `OfferCancellation` and `Liquidation` weights), `web/scripts/e2e-private-lending.ts` (stages `cancel`, `liquidate`)

**Interfaces:**
- `export async function buildPrivateCancellation(deps, offer: VerifiedOffer /* 'borrower' */, params: { borrowerNftCoin: WalletTxOut; collateralReceiver: Address })`
  - Inputs: 0 is the pending offer, 1 the locked lender NFT, and 2 the borrower NFT.
  - Outputs: 0 and 1 burn the two NFTs, and the collateral goes to the borrower.
  - Finalize with the `OfferCancellation` branch and script_auth.
- `export async function buildPrivateLiquidation(deps, offer: VerifiedOffer /* 'lender' */, params: { activeOfferOutpoint: string; lenderNftCoin: WalletTxOut; collateralReceiver: Address; tipHeight: number })`
  - It throws `expiry-not-reached` before building when `tipHeight < loanExpirationTime`.
  - The lock time and input sequence follow what the contract checks; read `private_lending.simf` and the public `useLiquidateOffer.ts`.

- [ ] **Step 1: E2e stages.**
  - `cancel` creates its own offer, then cancels it after confirmation.
  - `liquidate` creates an offer that expires at tip + 3 and has the lender accept it.
    1. It first tries to liquidate before expiry, and expects `expiry-not-reached`.
    2. Then it waits for the expiry height and liquidates.
- [ ] **Step 2: Run** them. Expected: FAIL before implementing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both. Expected: the early liquidation is refused before broadcast; the cancellation and the liquidation confirm. Set the last two weights.
- [ ] **Step 5: Run** `npx pnpm@10.33.0 e2e:private` with all stages from a clean `.e2e-private/` state. Expected: every stage confirms. Record all txids in the report, and document the e2e script in `web/README.md`.
- [ ] **Step 6: Commit.** `git commit -m "web: private cancellation and liquidation flows, full testnet e2e"`

### Task 7: Indexer client, scanning and directory

**Files:**
- Create:
  - `web/src/api/indexer/private.ts`, with zod schemas and methods.
  - `web/src/privateLending/scan.ts`
  - `web/src/privateLending/directory.ts`
- Modify:
  - `web/scripts/e2e-private-lending.ts`: stage `scan`.
  - `web/README.md`: the local testnet indexer.

**Interfaces:**
- `private.ts` covers every private endpoint in the indexer README, with the shapes exactly as documented there:
  - `fetchPrivateCandidates({ fromHeight, toHeight?, limit?, offset? }, baseUrl)`
  - `fetchPrivateCandidate(txid, baseUrl)`
  - `fetchPrivateCreationTx(txid, baseUrl) -> string /* hex */`
  - `fetchDirectory({ limit?, offset? }, baseUrl)`
  - `fetchDirectoryEntry(pubkey, baseUrl)`
  - `requestDirectoryChallenge(baseUrl)`
  - `putDirectoryEntry(pubkey, body, baseUrl)`
  - `deleteDirectoryEntry(pubkey, body, baseUrl)`

  `baseUrl` is a parameter, so Node can call the same code. The app passes `env.VITE_API_URL`. The module uses the existing `requestJson` for GET; for writes it adds `postJson`, `putJson` and `deleteJson` to `api/client.ts`, following `requestJson`.
- `scan.ts`:
  - `export interface ScanStore { get(fingerprint: string): Promise<ScanState | undefined>; set(fingerprint: string, state: ScanState): Promise<void> }`, implemented with `PersistentKv` in the app and in memory in Node.
  - `export interface ScanState { syncedHeight: number | null; offers: Record<string /* creation txid */, { role: 'lender' | 'borrower'; result: 'verified' } | { role: 'lender' | 'borrower'; result: 'invalid'; code: string }> }`
  - `export async function syncOffers(deps: PrivateFlowDeps, key: LendingKey, apiBaseUrl: string, store: ScanStore): Promise<ScanState>`. It scans as both lender and borrower in one pass, following Global Constraints. When an offer opened as one role, the scan does not open it again as the other.
  - `export async function loadVerifiedOffer(deps, key, txid, role, apiBaseUrl): Promise<VerifiedOffer>`, which goes through `fetchPrivateCreationTx` and then `openAndVerifyOffer`.
- `directory.ts`: `registerInDirectory(deps, key, displayName, apiBaseUrl)` and `removeFromDirectory(deps, key, apiBaseUrl)`. Each requests a challenge, then signs, then writes.

- [ ] **Step 1: Start the local testnet indexer and API** as in Global Constraints. Start from a height before the Task 3 creation, then wait until `GET /private/candidates` lists the e2e offers.
- [ ] **Step 2: E2e stage `scan`.**
  - The lender's `syncOffers` reports every e2e offer addressed to it as `verified`, with no not-addressed entries.
  - The borrower's `syncOffers` recovers every e2e offer it created.
  - Re-syncing from the stored state fetches only new heights.
  - **Hostile case:** an in-memory API wrapper serves offer A's candidate with offer B's creation transaction. The result for A is `invalid` or absent, never `verified`.
  - **Directory:** the lender registers "E2E Lender", `fetchDirectoryEntry` shows it, and then the lender removes it.
- [ ] **Step 3: Run** the stage. Expected: FAIL before implementing.
- [ ] **Step 4: Implement**, then run the stage again. Expected: PASS. Run `lint`, `build` and `prettier --check`.
- [ ] **Step 5: Commit.** `git commit -m "web: private candidates client, scanning and directory"`

### Task 8: Wallet plumbing and hooks

**Files:**
- Create: `web/src/privateLending/hooks/{usePrivateFlowDeps.ts,usePrivateOffers.ts,usePrivateTransaction.ts,useDirectory.ts}`
- Modify: `web/src/providers/wallet/{types.ts,WalletProvider.tsx}`, `web/src/constants/routes.ts` (`Private: '/app/private'`)

**Interfaces:**
- `WalletContextValue` gains:
  - `privateCapable: boolean`, which is `signerType === 'jade' || signerType === 'seed'`;
  - `getLendingKey(): Promise<LendingKey>`, derived once per session from `session.descriptor`, and freed on disconnect;
  - `getWalletTxOuts(): Promise<WalletTxOut[]>`, which is `(await getWollet()).utxos()`, the coins with full secrets.
- `usePrivateFlowDeps(): () => Promise<PrivateFlowDeps>` assembles the deps from `useLwk`, `getPrivateLendingWasm`, `useWallet`, `fetchTransaction`, the fee rate (`fetchFeeRateSatPerKvb`, converted as the public modals do), `NETWORK_CONFIG` and the bound sources.
- `usePrivateOffers()` is a React Query hook around `syncOffers`, with the `PersistentKv` store. It refetches on `block_indexed` and returns `{ lending: ..., borrowing: ... }`, each a list of `{ txid, result, code?, candidate }`. The verified offer for an action is loaded on demand with `loadVerifiedOffer`.
- `usePrivateTransaction()` is like `useStandardTransactionFlow`: it runs build, then sign, then finalize, then broadcast. In addition:
  - It saves the finalized hex in `PendingTransactionsProvider` storage before broadcasting.
  - It exposes `retryBroadcast(txid)`, which rebroadcasts the saved hex.
- `useDirectory()` provides the directory list with a lookup by pubkey, and `register` and `remove` mutations.

- [ ] **Step 1: Implement** the hooks and the wallet additions.
- [ ] **Step 2: Run** `lint`, `build` and `parity`, plus `e2e:private wallets scan`, as a regression check of the shared code. Expected: all pass.
- [ ] **Step 3: Commit.** `git commit -m "web: private lending wallet plumbing and hooks"`

### Task 9: Private page, directory and lending side

**Files:**
- Create:
  - `web/src/pages/Private/index.tsx`
  - `web/src/pages/Private/components/{KeyFingerprint.tsx,DirectorySection.tsx,LendSection.tsx,PrivateOfferRow.tsx}`
  - `web/src/components/modals/private/{AcceptPrivateOfferModal.tsx,ClaimRepaymentModal.tsx,LiquidatePrivateOfferModal.tsx}`
- Modify: `web/src/App.tsx` (the route), `web/src/components/AppLayout.tsx` (a nav link shown when `privateCapable`)

**Interfaces and behavior:**
- **The page.** When the wallet is not ready, show the connect prompt, as `pages/Borrow` does. When it isn't `privateCapable`, explain that private loans need Jade or the seed wallet.
- **`KeyFingerprint`** renders `keyFingerprint` in 4×4 groups, and the optional directory name in `<bdi>`.
- **`DirectorySection`** shows your own entry with an edit and remove flow, a register form that enforces the indexer's name rules client-side, and the directory list.
- **`LendSection`** is the inbox of offers addressed to you.
  - It shows the borrower (fingerprint plus directory name), collateral, principal, repayment, interest (repayment − principal), expiry height and status.
  - Actions by status: **Accept** while pending and verified; **Claim repayment** when repaid and the repayment UTXO is unspent; **Liquidate** when active and the tip is past expiry.
  - Invalid offers show their code and have no actions.
- **The modals.** Each loads the `VerifiedOffer` on demand, builds through the Task 4–6 builders via `usePrivateTransaction`, and shows a `TransactionModal` summary as the public modals do.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `lint`, `build` and `prettier --check`. Then `npx pnpm@10.33.0 dev` against the local testnet indexer with `.env.liquidtestnet` and the lender's seed (`VITE_DEBUG_MNEMONIC` from `.env.e2e.local`, in a git-ignored `web/.env.local`). Check that the page loads and the inbox lists the e2e offers. Record a screenshot or the console output in the report if available; otherwise state what was checked.
- [ ] **Step 3: Commit.** `git commit -m "web: private page with directory and lending side"`

### Task 10: Borrowing side

**Files:**
- Create:
  - `web/src/pages/Private/components/{BorrowSection.tsx,CreatePrivateOfferForm.tsx}`
  - `web/src/components/modals/private/{CancelPrivateOfferModal.tsx,RepayPrivateOfferModal.tsx,ClaimPrincipalModal.tsx}`

**Interfaces and behavior:**
- **`CreatePrivateOfferForm`.**
  - The lender is chosen from the directory, or pasted as a 64-hex key. A pasted key is validated (`keyFingerprint` must not throw), and its fingerprint is shown before submit.
  - Fields: collateral (tL-BTC/L-BTC), principal and repayment (the configured principal asset), and expiry in blocks from the tip. The form shows the derived interest.
  - Coin selection: the first input, the lender NFT coin and the collateral coins come from `getWalletTxOuts`, confirmed coins only. A clear error appears when fewer than three distinct coins exist.
  - On submit it builds via `buildPrivateCreation` and broadcasts via `usePrivateTransaction`. The saved hex allows `retryBroadcast`.
- **`BorrowSection`** lists your own offers, recovered by `syncOffers`.
  - Actions by status: **Cancel** while pending; **Claim principal** while active with an unspent principal UTXO; **Repay** while active.
  - Each shows the lender's fingerprint and directory name.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `lint`, `build` and `prettier --check`. Then `pnpm dev` with the borrower's seed: the page loads and lists the e2e offers it created.
- [ ] **Step 3: Commit.** `git commit -m "web: private page borrowing side"`

### Task 11: Manual testnet run and Jade check (by the user)

**Files:**
- Create: `docs/superpowers/manual/2026-10-29-private-lending-testnet.md`
- Modify: `docs/superpowers/handoff/2026-10-29-private-lending.md`, with the outcome.

- [ ] **Step 1: Write the checklist.** The implementer writes it.
  - **Setup.** Start the local testnet indexer and API. Write `web/.env.local` with `.env.liquidtestnet` plus `VITE_DEBUG_MNEMONIC`. Run `pnpm build:wasm` and `pnpm dev`.
  - **Seed wallet.** Every phase, end to end, with two browsers or profiles, one per seed wallet: register, create, inbox, accept, claim principal, repay, claim repayment, cancel, and liquidate after a short expiry.
  - **Jade.**
    1. Connect Jade as the borrower and create an offer.
    2. Confirm on the device that the collateral output shows the real amount.
    3. Check that signing succeeds with pinned outputs that keep `blinder_index = Some(i)`.
    4. Then accept with the seed lender.
  - **Expected result** for each step, and where to look: txid, explorer, inbox state.
- [ ] **Step 2: The user runs the checklist.** The controller stops and asks the user to run it, then records the results, including any failing step, in the handoff. Jade failures become findings for a follow-up, not silent passes.
- [ ] **Step 3: Commit.** `git commit -m "docs: private lending testnet run and Jade check"`
