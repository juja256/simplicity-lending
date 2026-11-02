# Private lending: testnet run and Jade check (Task 11)

This checklist drives the private lending UI on Liquid testnet with two seed wallets (a borrower
and a lender) and then with a Jade as the borrower. Work through it top to bottom, tick each box,
and fill in the results table at the end. Plan on about two hours; most of it is waiting for
blocks (one a minute).

**It covers what no dev run has exercised yet:**

| What | Steps |
|---|---|
| Cancel and Repay through the UI | R6, R9 |
| Save before broadcast, the broadcast itself, Broadcast Again and Discard, against testnet | R8, R10 (J8 for a non-creation action) |
| Confirmation tracking (Processing, then done) | every transaction step, check T4 |
| Liquidation offered only after the expiry | R12, R13 |
| Claim Principal on a liquidated offer | R14 |
| Jade: the collateral amount on the device, the NFT contract domain, signing pinned outputs that keep `blinder_index = Some(i)`, registry contracts (`withAssetContracts`) | J4–J6, J9 |

**Rules for this run**

- Testnet only. Never paste a seed phrase into this file, a screenshot, a log or a chat.
- Chrome (or Chromium) only: Jade connects over WebSerial.
- A Jade step that fails is marked **Fail** and gets a finding (see "If something fails"). It is
  never a pass.
- A failed build spends nothing. Rebuilding is never the fix for a failed broadcast: use
  Broadcast Again.

## Conventions

- **Paths.** Commands run from the repository root unless a step says `web/`.
- **Windows.** "Borrower window" and "Lender window" are two Chrome profiles (S8), each with one
  tab on `http://localhost:5173`. Always use `localhost`, never `127.0.0.1`: they are different
  origins with separate storage.
- **The Private page** (`/app/private`, footer link **Private**) has four sections, top to
  bottom: **Private Loans** (your lending key), **Lender Directory**, **Borrow: Your Offers**
  (with the **New private offer** form) and **Lend: Offers to You**. The headers render in
  capitals.
- **Txids** show truncated as `6816e8...6b682d` (first 6, last 6). The explorer is
  `https://blockstream.info/liquidtestnet/tx/<txid>`.
- **Amounts.** Set **Balance unit** to **tLsats** in both windows (wallet button, top right, then
  **Balance unit**), so collateral is typed and shown in sats. TEST has 3 decimals: `1` is
  1.000 TEST (1 000 units).
- **Balances** are on `/app/borrow` (footer link **Borrow**) under **User Balances**:
  **Available Amount** is confirmed, a badge shows pending amounts. Navigate there in the same
  tab, never in a new one: the seed session lives in the tab's session storage.

### The offers of this run

The collaterals differ so that the rows are easy to tell apart.

| Offer | Collateral | Principal | Repayment | Expiry | Path |
|---|---|---|---|---|---|
| A | 20 000 tLsats | 1 TEST | 1.1 TEST | 1 440 blocks | create, accept, claim principal, repay, claim repayment |
| B | 21 000 tLsats | 1 TEST | 1.1 TEST | 1 440 blocks | pasted lender key, broadcast forced to fail, Broadcast Again, cancel |
| C | 22 000 tLsats | 1 TEST | 1.1 TEST | 1 440 blocks | broadcast forced to fail, Discard (never on chain) |
| D | 23 000 tLsats | 1 TEST | 1.1 TEST | **10 blocks** | accept, no Liquidate before expiry, liquidate, borrower claims principal |
| J | 24 000 tLsats | 1 TEST | 1.1 TEST | 1 440 blocks | Jade borrower, seed lender accepts; then claim principal, repay, claim repayment |

### Transaction checks (T1–T4)

Every step that broadcasts names these checks; the step lists what is specific to it.

- **T1, txid.** The modal's **Transaction ID** link opens the explorer and shows the transaction.
  Copy the full txid from the explorer URL into the results table.
- **T2, rows.** Each side's row shows the status chip, the note and the one button the step
  lists (or none).
- **T3, balance.** **User Balances** on `/app/borrow` changes as the step says. A fee is at most a
  few hundred tLsats.
- **T4, tracking.** In the open modal: the title is **Transaction Pending…** with Status
  **Pending…**; after one block **Transaction Complete**, Status **Confirmed**,
  **1 Confirmation**; after two blocks Status **Finalized**, **2 Confirmations**, and a
  **Transaction Confirmed** toast with **View**. After **Done**, the row shows the chip
  **Processing...**, the note "Your transaction waits for its confirmation." and no button,
  until the transaction has 2 confirmations; then it shows the new status. (The bell's
  **Notifications** list only public transactions; private ones never appear there.)

## Part S: setup

- [ ] **S1. Postgres is up.**
  ```bash
  ss -ltn | grep ':5432 '
  ```
  If nothing is listed, start Postgres. With the Docker setup from
  `crates/indexer/scripts/init_db.sh` the container is named `postgres`: `docker start postgres`.

  **Expected:** a `LISTEN` line on port 5432.

  **Check:** if the database `lending-indexer-testnet` is gone (the indexer logs a connection or
  "database does not exist" error in S2), recreate it with the "Once" commands under "Local
  testnet indexer" in `web/README.md`. The indexer then re-indexes from block 2 682 200, which
  takes over an hour.

- [ ] **S2. The indexer and its API run.** It does not survive a reboot.
  ```bash
  pgrep -af simplicity-lending-indexer
  curl -s 'http://127.0.0.1:8000/private/candidates?limit=1' | grep -oE '"(total|last_indexed_height)":[0-9]+'
  ```
  If `pgrep` lists fewer than two processes, or `curl` prints nothing, restart both. If `/tmp`
  was cleared (`/tmp/lending-indexer-testnet/simplicity-lending-indexer` is missing), rebuild
  first, from the repository root:
  ```bash
  SQLX_OFFLINE=true cargo build -p lending-indexer
  mkdir -p /tmp/lending-indexer-testnet
  cp target/debug/simplicity-lending-indexer /tmp/lending-indexer-testnet/
  ```
  Then start both processes from `crates/indexer` (stop a leftover one first with
  `pkill -f simplicity-lending-indexer`):
  ```bash
  cd crates/indexer
  RUN_MODE=indexer DATABASE__DATABASE_NAME=lending-indexer-testnet INDEXER__LAST_INDEXED_HEIGHT=2682200 ESPLORA__BASE_URL=https://blockstream.info/liquidtestnet/api setsid nohup /tmp/lending-indexer-testnet/simplicity-lending-indexer > /tmp/lending-indexer-testnet/indexer.log 2>&1 < /dev/null &
  RUN_MODE=api DATABASE__DATABASE_NAME=lending-indexer-testnet setsid nohup /tmp/lending-indexer-testnet/simplicity-lending-indexer > /tmp/lending-indexer-testnet/api.log 2>&1 < /dev/null &
  ```
  The stored sync height wins over `INDEXER__LAST_INDEXED_HEIGHT`.

  **Expected:** `pgrep` lists the binary twice; `curl` prints `"total":3` (the three e2e offers;
  more once this run creates some) and a `last_indexed_height`.

  **Check:** `ss -ltn | grep ':8000 '` shows the API listening.

- [ ] **S3. The indexer has caught up with the chain.**
  ```bash
  curl -s https://blockstream.info/liquidtestnet/api/blocks/tip/height; echo
  curl -s 'http://127.0.0.1:8000/private/candidates?limit=1' | grep -oE '"last_indexed_height":[0-9]+'
  ```
  After a suspend or reboot it can be hundreds of blocks behind; it catches up at 30 to 45 blocks
  a minute (`tail -f /tmp/lending-indexer-testnet/indexer.log` shows
  "Successfully indexed block #…").

  **Expected:** `last_indexed_height` within 2 blocks of the tip.

  **Check:** wait until it is, before S9. The UI only lists offers the indexer has reached.

- [ ] **S4. Build the wasm package**, from `web/` (run `npx pnpm@10.33.0 install` first if
  `web/node_modules` is missing):
  ```bash
  cd web
  npx pnpm@10.33.0 build:wasm
  ```
  **Expected:** wasm-pack finishes without errors and refreshes
  `web/src/wasm/private-lending/private_lending_wasm_bg.wasm`.

  **Check (optional):** `npx pnpm@10.33.0 parity` prints `private lending parity: ok`.

- [ ] **S5. Write `web/.env.local`:** the testnet values of `.env.liquidtestnet`, the Ruling 17
  proxy (the local indexer sends no CORS headers, so the dev server proxies `/api` to it and drops
  the prefix), and `VITE_DEMO_MODE=true`, which adds the **Seed phrase** option to Connect Wallet.

  **`VITE_DEBUG_MNEMONIC` must not be set.** With it set, the **Jade** button connects that seed
  instead of the device (`WalletProvider` falls back to it), so Jade could not be tested, and every
  window would get the same seed. The file currently holds the borrower seed there; the command
  below overwrites the file without it. The seed stays in `web/.env.e2e.local`, so keep no backup
  copy of the old file. From `web/`:
  ```bash
  { grep -Ev '^\s*(#|$)|^VITE_API_URL=' .env.liquidtestnet
    printf '%s\n' 'VITE_API_URL=/api' 'API_PROXY_TARGET=http://127.0.0.1:8000' 'API_PROXY_STRIP_PREFIX=true' 'VITE_DEMO_MODE=true'
  } > .env.local
  grep -c VITE_DEBUG_MNEMONIC .env.local
  cat .env.local
  ```
  **Expected:** `grep -c` prints `0`, and the file reads:
  ```
  VITE_NETWORK=liquidtestnet
  VITE_ESPLORA_BASE_URL=https://blockstream.info/liquidtestnet
  VITE_WATERFALLS_URL=https://waterfalls-elements-testnet.esplora.staging.blockstream.io:17771
  VITE_GA_MEASUREMENT_ID=G-CPMC9XLYJ
  VITE_API_URL=/api
  API_PROXY_TARGET=http://127.0.0.1:8000
  API_PROXY_STRIP_PREFIX=true
  VITE_DEMO_MODE=true
  ```
  **Check:** `git status --short web/` does not list `.env.local` (it is git-ignored by `*.local`).

- [ ] **S6. Check the seed wallets' funds**, from `web/`:
  ```bash
  npx pnpm@10.33.0 e2e:private wallets
  ```
  It syncs both seed wallets (from `web/.env.e2e.local`) and prints, for each, its address,
  confirmed tL-BTC (sats) and TEST (units), and its lending-key fingerprint. It never prints the
  seeds. It broadcasts only a coin split, and only for a wallet that has no `wallets-split-*`
  record in `web/.e2e-private/state.json` and fewer than 6 (borrower) or 3 (lender) confirmed
  tL-BTC coins. Both split records are saved there as confirmed, so today it only prints
  `wallets-split-borrower: 5bf705… already confirmed` and the same for the lender, then
  `wallets: ok`.

  Minimum funds for this run:

  | Wallet | tL-BTC, confirmed | TEST, confirmed | Coins | Last known (2026-10-30) |
  |---|---|---|---|---|
  | Borrower seed | 140 000 tLsats | 0.100 TEST | at least **5** confirmed tL-BTC coins at the start | 399 311 tLsats in 5 coins, 4.900 TEST |
  | Lender seed | 12 000 tLsats | 3.000 TEST | 1 | 199 356 tLsats in 3 coins, 4.100 TEST |
  | Jade | 50 000 tLsats | 0.100 TEST (only for J9) | 3 confirmed tL-BTC coins | not funded yet (J2) |

  Why the coin counts: a creation spends 3 tL-BTC coins (the two smallest issue the NFTs, the
  largest pay the collateral) and returns one change coin. Offers A, B, C and D need 3 confirmed
  coins each time, and the borrower gets coins back only from Repay and Cancel. The lender
  accepts A, D and J (1.000 TEST each) and pays about six fees.

  **Top-ups.** Each faucet request adds one coin of 100 000 tLsats (`action=lbtc`) or one TEST
  coin (`action=test`). It is a plain GET, at most 3 requests a minute; open it in the browser or
  use `curl -s`:
  ```
  https://liquidtestnet.com/faucet?address=<address>&action=lbtc
  https://liquidtestnet.com/faucet?address=<address>&action=test
  ```
  The borrower has exactly the 5 coins it needs, so one `action=lbtc` request to the borrower's
  address gives slack.

  **Expected:** both wallets print, and the borrower and the lender meet the minimums above.

  **Check:** write the two fingerprints down (S9 and S10 compare them with the UI). Wait for a
  top-up's first confirmation before S9.

- [ ] **S7. Start the dev server**, from `web/`, and leave it running:
  ```bash
  npx pnpm@10.33.0 dev
  ```
  In a second terminal:
  ```bash
  curl -s 'http://localhost:5173/api/private/candidates?limit=1' | grep -oE '"last_indexed_height":[0-9]+'
  curl -sN --max-time 90 http://localhost:5173/api/events | head -n 2
  ```
  **Expected:** Vite prints `Local: http://localhost:5173/`. The first `curl` prints the same
  height as S3 (the proxy works). The second prints `event: block_indexed` and
  `data: {"type":"block_indexed","height":…}` within about a minute (the event stream that
  refreshes the offer lists works through the proxy).

  **Check:** the footer of any `/app` page shows `Network: liquidtestnet` and `API URL: /api`.

- [ ] **S8. Two Chrome profiles.** Chrome, profile icon (top right), **Add**, continue without an
  account, name it **Borrower**. Repeat for **Lender**. In each, open
  `http://localhost:5173/app/private`, open DevTools (F12), and in the Console settings turn on
  **Preserve log**.

  **Expected:** both show "Connect your wallet to use private loans." and **Connect Wallet**.

  **Check:** the two windows are separate profiles (a different avatar each), not two tabs of
  one profile.

- [ ] **S9. Connect the borrower seed** in the Borrower window.
  1. Open `web/.env.e2e.local` in an editor and copy the value of
     `PRIVATE_E2E_BORROWER_MNEMONIC`: the 12 words only, **without the surrounding double
     quotes**.
  2. **Connect Wallet**, then **Seed phrase** (tagged **Demo only**). The dialog **Connect with
     Seed Phrase** warns "Demo only. Never enter a real wallet's recovery phrase here…".
  3. Paste into the first word field: the phrase fills all 12. Click **Connect**.
  4. Copy something else, to clear the phrase from the clipboard.
  5. Wallet button, **Balance unit**, **tLsats**.

  **Expected:** the wallet button shows a truncated address. The page shows **Private Loans**
  with **Your lending key** (a fingerprint in four groups of four), **Lender Directory**,
  **Borrow: Your Offers** and **Lend: Offers to You**. The footer has a **Private** link.

  **Check:** the fingerprint equals the borrower's `lending key` from S6.

- [ ] **S10. Connect the lender seed** in the Lender window: the same as S9 with
  `PRIVATE_E2E_LENDER_MNEMONIC`.

  **Expected:** as S9.

  **Check:** the fingerprint equals the lender's `lending key` from S6, and differs from the
  borrower's.

- [ ] **S11. Baseline: the three e2e offers.** Wait for both lists to finish "Scanning for your
  offers…" / "Scanning for offers addressed to you…".

  **Expected:** in the Borrower window, **Borrow: Your Offers** lists:
  - `6816e8...6b682d` **Claimed**, no button;
  - `79475a...f1849c` **Cancelled**, no button;
  - `3c15d4...9b1807` **Liquidated**, button **Claim Principal**, note "The loan was liquidated;
    the principal is yours." (the e2e run never claimed it; R14b may).

  In the Lender window, **Lend: Offers to You** lists the same three with the same statuses and no
  buttons. None shows an **Invalid: …** chip; each shows Collateral 20 000, Principal 1,
  Repayment 1.1, Interest 0.1 and an Expiry.

  **Check:** both headers show "Scanned up to block #N", and N grows by about one a minute
  without a reload. If it stays put, the event stream does not reach the page: record it as a
  finding and reload to refresh the lists during the run.

## Part R: the seed wallet run

- [ ] **R1. The borrower registers in the directory.** Borrower window, **Lender Directory**,
  **Your entry** says "You are not listed. Register a name so that borrowers can find your key."
  Type `Manual Borrower` in **Display name** and click **Register**.

  **Expected:** the button shows **Signing…** briefly (a signature by the lending key in the
  browser; nothing is broadcast). **Your entry** then shows **Listed as** with the name and
  fingerprint, and the buttons **Rename** and **Remove**. **Listed keys (1)** lists it with the
  chip **You**. The **Private Loans** card shows the name next to the fingerprint.

  **Check:** `curl -s http://127.0.0.1:8000/private/directory` lists `"display_name":"Manual Borrower"`.

- [ ] **R2. The lender registers.** Lender window: the same with `Manual Lender`.

  **Expected:** as R1. **Listed keys (2)** in the Lender window.

  **Check:** reload the Borrower window if needed: its **Listed keys (2)** shows **Manual
  Lender** with the fingerprint from S10, and the Lender window shows **Manual Borrower** with
  the fingerprint from S9.

- [ ] **R3. The borrower creates offer A**, with the lender picked from the directory. Borrower
  window, **New private offer**:
  1. **Lender from the directory**, **Choose a listed lender**, pick **Manual Lender**. The
     **Lender** box shows its fingerprint and "Compare this fingerprint with the lender before
     you create the offer: only this key can read it and accept it."
  2. **Collateral** `20000`, **Expiry** `1440` (its description reads `Block #… (>1d)`),
     **Principal** `1`, **Repayment** `1.1`. **Interest (repayment − principal)** shows 0.1 TEST.
  3. **Review Offer**. The modal **Create Private Offer** (chip **New**) lists Lender,
     Collateral, Principal, Repayment, Interest and Expiry Block, with the notice "Only this
     lending key can read the offer and accept it…".
  4. **Sign & Create Offer**.

  **Expected:** the stepper runs **Constructing Transaction**, **Signing Transaction**,
  **Finalizing Transaction**, **Broadcasting Transaction**, then the summary (Collateral, Borrow,
  Repayment) with the **Transaction ID**. After **Done**, the form is empty again and a row
  **Your new offer** shows **Processing...** with "It waits for its confirmation.", then "It is
  confirmed; it shows here once the indexer lists it.". Within a block or two that row is
  replaced by offer A's row: Lender **Manual Lender** and fingerprint, chip **Open Offer**, button
  **Cancel**, note "Waiting for the lender to accept it.", terms 20 000 / 1 / 1.1 / 0.1.

  **Check:** T1; T2 as above; T3 borrower tL-BTC −20 000 − fee; T4.

- [ ] **R4. The lender sees offer A, verified, and accepts it.** Lender window, **Lend: Offers to
  You**.

  **Expected:** without a reload, within a block of R3's confirmation, a new row: Borrower
  **Manual Borrower** and the borrower's fingerprint, chip **Open Offer** (no **Invalid** chip),
  the same terms as R3, button **Accept**.

  Click **Accept**. The modal **Accept Private Offer** (chip **Open Offer**) lists Offer,
  Borrower, Collateral, Principal, Repayment, Interest, Expiry Block and Status. Click **Accept &
  Supply**.

  **Check:** the offer txid in the modal equals R3's txid. T1; T2: the lender's row shows
  **Processing...** until 2 confirmations, then **Active** with the note "Liquidation opens after
  block #N." and **no button**; the borrower's row shows **Active**, button **Claim Principal**,
  note "The lender accepted: claim your principal."; T3 lender TEST −1.000 and tL-BTC −fee,
  borrower unchanged (the principal waits locked to the borrower NFT); T4.

- [ ] **R5. The borrower claims the principal.** Borrower window, offer A, **Claim Principal**.
  The modal **Claim Principal** (chip **Claim**), button **Claim Principal**.

  **Expected:** summary Principal 1 TEST, then the Transaction ID.

  **Check:** T1; T2: the borrower's row shows **Processing...**, then **Active**, button
  **Repay**, note "Repay by block #N."; if it says "The indexer lists no claim of your principal,
  so it cannot be repaid yet.", wait a block (Repay needs the indexer to list the principal as
  spent by the claim); T3 borrower TEST +1.000, tL-BTC −fee; T4.

- [ ] **R6. The borrower repays.** Borrower window, offer A, **Repay**. The modal **Repay Private
  Loan** (chip **Repay**), button **Repay & Unlock Collateral**.

  **Expected:** no notice "Insufficient confirmed TEST balance: …" (if it shows, wait for R5's
  coins to confirm). Summary Principal 1, Interest 0.1, Total Repaid 1.1, Collateral Returned
  20 000.

  **Check:** T1, and on the explorer output 0 is an `OP_RETURN` burning the borrower NFT; T2: the
  borrower's row shows **Processing...**, then **Repaid** and no button; the lender's row shows
  **Repaid**, button **Claim Repayment**, note "The borrower repaid the loan."; T3 borrower TEST
  −1.100, tL-BTC +20 000 − fee; T4.

- [ ] **R7. The lender claims the repayment.** Lender window, offer A, **Claim Repayment**. The
  modal **Claim Repayment** (chip **Claim**), button **Claim Repayment**.

  **Expected:** summary Principal 1, Interest 0.1, Total 1.1.

  **Check:** T1; T2: the lender's row shows **Processing...**, then **Claimed** and no button;
  the borrower's row shows **Claimed**; T3 lender TEST +1.100, tL-BTC −fee; T4.

- [ ] **R8. Offer B: a pasted key, a failed broadcast, then Broadcast Again.** This checks that a
  signed transaction is saved before its broadcast, survives a reload, and is resent unchanged.
  1. **Pasted key, negative cases.** Borrower window, **Or paste a lending key**:
     - type `abc`: "A lending key is 64 hexadecimal characters.";
     - paste 64 `f` characters: "This is not a valid lending key.";
     - in the Borrower window click the copy button next to **Your lending key** and paste it:
       "This is your own lending key. Paste the lender's key."
  2. **Pasted key.** In the Lender window, click the copy button next to **Your lending key**.
     Paste it into the Borrower window's **Or paste a lending key**. The **Lender** box shows
     **Manual Lender** and the lender's fingerprint.
  3. **Collateral** `21000`, **Expiry** `1440`, **Principal** `1`, **Repayment** `1.1`. **Review
     Offer**.
  4. **Block the broadcast.** Borrower window, DevTools: Command Menu (Ctrl+Shift+P), type
     `block`, open **Network request blocking** (called **Request conditions** in recent Chrome).
     Enable blocking and add the pattern `blockstream.info/liquidtestnet/api/tx`. Keep DevTools
     open: blocking applies only while it is. A creation reads nothing under that URL before its
     broadcast (the wallet syncs through waterfalls, the offer data comes from the indexer), so
     only the broadcast and transaction-status polling fail.
  5. **Sign & Create Offer.**

     **Expected:** the stepper reaches **Broadcasting Transaction**, then the modal returns to the
     offer details with a notice: "The transaction was signed and saved in this browser, but it
     was not broadcast: …", "Broadcasting again sends the same transaction. Discard it only if it
     can no longer be mined, for example because its coins were spent since.", a **Discard It**
     button, and the footer button **Broadcast Again**.
  6. **The saved record.** DevTools, **Network**: the `POST` to `…/liquidtestnet/api/tx` is
     blocked. DevTools, **Application**, **IndexedDB**, `simplicity-lending:private-transactions`,
     `private-tx` (refresh the view): one record with `kind: "private_create_offer"`,
     `broadcastStatus: "built"` and a `txHex`. Write its `txid` in the results table as B.
  7. **Close the modal** (the X).

     **Expected:** under the form, a row **Your new offer** with the chip **Not broadcast**, a
     **Broadcast Again** button, "Offer" and B's truncated txid, and "It was signed but not
     broadcast.". The form shows "An offer you signed was not broadcast. Open it below with
     Broadcast Again, and broadcast it or discard it, before you create another: a new offer
     could spend the same coins." **Review Offer** stays disabled, even with every field filled.
  8. **Reload** the Borrower window (F5).

     **Expected:** "Reconnecting your wallet…", then the **Not broadcast** row and the form's
     notice are still there.
  9. **Retry while still blocked.** Click the row's **Broadcast Again**. The modal **Create
     Private Offer** shows a single row **Offer Transaction** with B's txid and a copy button,
     the notice, and **Broadcast Again**. Click it.

     **Expected:** **Processing Transaction…** with only the **Broadcasting Transaction** step,
     then back to the notice. Copy the txid from **Offer Transaction**: it is B.
  10. **Unblock and retry.** Turn request blocking off. Click **Broadcast Again**.

      **Expected:** **Transaction Pending…** with the **Transaction ID**.

  **Check:** the txid is B at every point: the IndexedDB record (step 6), the row (7), **Offer
  Transaction** (9), the **Transaction ID** and the explorer (10). IndexedDB then holds one
  `private_create_offer` record for B, now `broadcastStatus: "broadcast"`, and no second one: the
  retry did not rebuild. T1; T2: B appears in the list as in R3 (chip **Open Offer**, button
  **Cancel**, collateral 21 000); T3 borrower tL-BTC −21 000 − fee, once; T4.

- [ ] **R9. The borrower cancels offer B.**
  1. Lender window: B appears with chip **Open Offer**, collateral 21 000 and button **Accept**.
     **Do not accept it.**
  2. Borrower window: offer B, **Cancel**. The modal **Cancel Private Offer** (chip **Cancel**),
     button **Cancel Offer**.

  **Expected:** summary Collateral Returned 21 000, then the Transaction ID.

  **Check:** T1, and on the explorer outputs 0 and 1 are `OP_RETURN` burns of the two NFTs; T2:
  the borrower's row shows **Processing...**, then **Cancelled** and no button; the lender's row
  shows **Cancelled** and no **Accept**; T3 borrower tL-BTC +21 000 − fee; T4.

- [x] **R10. Offer C: Discard.** Borrower window.
  1. Lender **Manual Lender** from the directory, **Collateral** `22000`, **Expiry** `1440`,
     **Principal** `1`, **Repayment** `1.1`, **Review Offer**.
  2. Turn request blocking on again (the R8 pattern), then **Sign & Create Offer**.
  3. When the notice "…but it was not broadcast…" shows, note the new record's txid in IndexedDB
     (C), then click **Discard It**.
  4. Turn request blocking off.

  **Expected:** the modal closes. No **Your new offer** row, no notice above **Review Offer**, and
  **Review Offer** works again once the form is filled.

  **Check:** IndexedDB has no record for C; the explorer says C is not found; the tL-BTC balance
  shows no pending change; over the next blocks C never appears in either window. Request
  blocking is off.

- [ ] **R11. Offer D, with a 10-block expiry.** Borrower window: lender **Manual Lender** from the
  directory, **Collateral** `23000`, **Expiry** `10`, **Principal** `1`, **Repayment** `1.1`.
  Write down the block in the expiry description (`Block #N (~10m)`) as N. **Review Offer**,
  **Sign & Create Offer**.

  **Expected:** as R3, with collateral 23 000 and expiry #N.

  **Check:** T1; T2 as in R3; T3 borrower tL-BTC −23 000 − fee; T4. Move on to R12 as soon as D
  shows in the Lender window.

- [ ] **R12. The lender accepts offer D; Liquidate is not offered before the expiry.** Lender
  window: offer D, **Accept**, **Accept & Supply**. In the Borrower window, do **not** claim D's
  principal.

  If the lender's row says "Its term has passed." instead of offering **Accept**, the offer
  expired first: cancel it from the Borrower window (as R9) and repeat R11 with Expiry `15`.

  **Expected:** as R4.

  **Check:** T1; T3 lender TEST −1.000; T4. T2, after the acceptance has 2 confirmations and
  while the tip is at most N: the lender's row shows **Active**, the note "Liquidation opens after
  block #N." and **no Liquidate button**; its Expiry counts down (`#N (~3m)`). The borrower's row
  shows **Active** and **Claim Principal**.

- [ ] **R13. The lender liquidates offer D after the expiry.** Wait. The Expiry shows
  **Expired** at block N; **Liquidate** appears one block later, once the tip is past N. Lender
  window: offer D, **Liquidate** (note "The loan has expired unpaid."). The modal **Liquidate
  Private Offer** (chip **Liquidate**) shows Collateral 23 000 and Expiration Block #N, no notice,
  and the button **Liquidate & Claim Collateral**, enabled. Click it.

  **Expected:** the Transaction ID, then tracking.

  **Check:** T1, and the explorer shows it in a block above N; T2: the lender's row shows
  **Processing...**, then **Liquidated** and no button; the borrower's row shows **Liquidated**,
  button **Claim Principal**, note "The loan was liquidated; the principal is yours."; T3 lender
  tL-BTC +23 000 − fee; T4.

- [ ] **R14. The borrower claims offer D's principal after the liquidation.** Borrower window,
  offer D, **Claim Principal**, **Claim Principal**.

  **Expected:** as R5.

  **Check:** T1; T2: the borrower's row shows **Processing...**, then **Liquidated** and no
  button; T3 borrower TEST +1.000, tL-BTC −fee; T4.

  **R14b (optional):** the same for the e2e offer `3c15d4...9b1807` (S11). Borrower TEST +1.000.

- [ ] **R15. Wrap-up of the seed run.**

  **Expected:** request blocking is off in both windows. No row shows **Processing...** or **Not
  broadcast**. The Borrower window lists A **Claimed**, B **Cancelled**, D **Liquidated** and the
  three e2e offers; the Lender window lists the same.

  **Check:** run `npx pnpm@10.33.0 e2e:private wallets` again (from `web/`) and write both
  wallets' confirmed balances in the results table. About 10 minutes after a transaction is
  finalized, its IndexedDB record is removed; that is the expected cleanup.

## Part J: the Jade run

Jade is the borrower and the seed lender accepts. J1–J7 are the required part; J8–J10 run if time
allows. Photograph the Jade screens of every signing.

- [ ] **J1. Connect Jade.** In the Borrower window: wallet button, **Disconnect**. Plug in a Jade
  set up for testnet. **Connect Wallet**, **Jade** (tagged **Testnet**), pick the Jade in
  Chrome's serial-port dialog. The wallet button shows **Enter PIN on device** and the dialog
  **Unlock your Jade**; enter the PIN on the Jade. If the Jade asks to export its master blinding
  key, approve: the app derives the lending key from it. Set **Balance unit** to **tLsats**.

  **Expected:** the wallet button shows a truncated address; the Private page loads with **Your
  lending key**. It does not say "Private loans need Jade or the seed wallet…".

  **Check:** Jade's fingerprint differs from both seed fingerprints. If it equals the borrower's,
  `VITE_DEBUG_MNEMONIC` is set (S5) and the seed connected instead of the Jade. Write the Jade's
  firmware version in the notes.

- [ ] **J2. Fund the Jade.** Wallet button, then the copy button next to the address (**Copy
  address**). Request the faucet (S6) for that address three times with `action=lbtc` (wait a
  minute if it refuses) and once with `action=test`. Wait for one confirmation.

  **Expected:** the faucet reports each payment; write its txid in the results table if it shows
  one.

  **Check:** **User Balances** on `/app/borrow`: tL-BTC at least 300 000 tLsats, TEST above 0.100.
  The **New private offer** form later shows no "A private offer needs at least 3 confirmed tL-BTC
  coins…" notice.

- [ ] **J3. (Optional) Register the Jade** as `Manual Jade`, as R1.

  **Expected:** as R1, and the Jade shows nothing: the directory signature uses the lending key in
  the browser.

  **Check:** the Lender window lists **Manual Jade** with Jade's fingerprint after a reload.

- [ ] **J4. Create offer J to the seed lender.** **New private offer**: lender **Manual Lender**
  from the directory, **Collateral** `24000`, **Expiry** `1440`, **Principal** `1`,
  **Repayment** `1.1`. **Review Offer**, **Sign & Create Offer**.

  **Expected:** **Constructing Transaction** completes, then **Sign on Jade** ("Confirm the
  transaction on your device"), and the Jade shows the transaction.

  **Check:** no error before the Jade step. An error at **Constructing Transaction** such as
  "output 3 has no blinder index" means the app's own layout check failed before signing: a
  finding.

- [ ] **J5. Review the creation on the Jade before confirming.** Record each screen.
  1. **The collateral output** (output 3, the offer, sent to a covenant address, not your
     wallet). It must show the real amount, 24 000 sats (0.00024 in L-BTC units). Blank,
     "confidential", zero or any other amount is a **Fail**.
  2. **The NFT contract domain.** The creation issues two NFTs (inputs 0 and 1) under the
     contract domain `simplicity-lending.private`, tickers `SLPB` (borrower NFT) and `SLPL`
     (lender NFT), names `simplicity-lending/private/v1 borrower-nft` and `…/v1 lender-nft`.
     Write down exactly what the Jade shows: the domain, ticker or name, a raw asset id, or an
     "unknown asset" warning. Any of these passes this item; the record is the result.
  3. **The other outputs:** 1 unit of a new asset (the lender NFT) to a covenant address, a
     zero-value `OP_RETURN` marker, the change (maybe not shown), the fee.
  4. Confirm on the Jade.

  **Expected:** the screens above, then the Jade asks for the final confirmation.

  **Check:** the collateral amount is exact; the domain display and every warning are written
  down.

- [ ] **J6. Signing succeeds with the pinned output.**

  **Expected:** the stepper moves on to **Finalizing Transaction** and **Broadcasting
  Transaction**, then **Transaction Pending…** with the Transaction ID; the rest is as R3.

  **Check:** this is the check that Jade signs a pinned output keeping `blinder_index = Some(i)`.
  The app's layout check refuses any blinded output without a blinder index, before and after
  blinding, so output 3 reached the Jade with its blinder index set; the step passes when the Jade
  returns a signature without an error and the transaction confirms. Also: T1; T2 (offer J's row
  as in R3, collateral 24 000); T3 Jade tL-BTC −24 000 − fee; T4. In the Console, note whether
  "Signing without asset metadata (registry unavailable)" appears: then `withAssetContracts` was
  skipped.

- [ ] **J7. The seed lender accepts offer J.** Lender window: J appears with the Jade's
  fingerprint (and **Manual Jade** if J3 ran), chip **Open Offer**, collateral 24 000, **Accept**.
  **Accept**, **Accept & Supply**.

  **Expected:** as R4.

  **Check:** T1; T2: the lender's row shows **Active** and no button; the Jade's row shows
  **Active** and **Claim Principal**; T3 lender TEST −1.000; T4.

- [ ] **J8. (If time) The Jade claims the principal, with a failed broadcast first.** This is the
  only way to test **Broadcast Again** on an offer row (not a creation): the Jade's confirmation
  screen gives time to block the broadcast after the build has read its transactions.
  1. Jade's window: offer J, **Claim Principal**, **Claim Principal**.
  2. While the Jade shows the transaction, turn request blocking on (the R8 pattern). Write down
     how the Jade shows the TEST amount: ticker `TEST` (the registry contract reached the Jade)
     or a raw asset id. Confirm on the Jade.

     **Expected:** the notice "…signed and saved in this browser, but it was not broadcast…" and
     **Broadcast Again**.
  3. Close the modal. The row shows "Your transaction was signed but not broadcast." and a
     **Broadcast Again** button. Note the record's txid in IndexedDB.
  4. Turn request blocking off, click the row's **Broadcast Again**, then **Broadcast Again** in
     the modal.

  **Expected:** **Transaction Pending…** with the Transaction ID, and no new Jade prompt.

  **Check:** the txid equals the IndexedDB record's; T1; T2: the row shows **Processing...**, then
  **Active**, **Repay**; T3 Jade TEST +1.000; T4.

- [ ] **J9. (If time) The Jade repays: a second pinned output.** Jade's window: offer J,
  **Repay**, **Repay & Unlock Collateral**. On the Jade, record:
  - output 1, the repayment to a covenant address, pinned to the lender's blinding key: it must
    show the real amount, 1.100 TEST (and whether as `TEST` or a raw asset id);
  - output 0, an `OP_RETURN` burning the borrower NFT;
  - output 2, 24 000 sats back to your wallet (maybe shown as change).

  Confirm on the Jade.

  **Expected:** signing succeeds, then as R6.

  **Check:** the repayment amount on the Jade is exact (else **Fail**); the same blinder-index
  reasoning as J6; T1; T2 as R6; T3 Jade TEST −1.100, tL-BTC +24 000 − fee; T4.

- [ ] **J10. (If time) The seed lender claims J's repayment**, as R7.

  **Expected:** as R7.

  **Check:** T1–T4 as R7.

## Results

### Run started 2026-11-02 (Europe/Kyiv)

Task 11 is **in progress**. The user reports completing the borrow–accept–repay flow.
Detailed browser assertions and Jade signing have not yet been verified for this run.
Record those results as the user completes them.

Local preflight:

- S1–S2: PostgreSQL listens on localhost:5432; `/ready` returns `{"status":"ok"}`,
  confirming that the API can query the database. The indexer log shows new blocks committed.
- S3: the indexer and public Liquid testnet tip both reported **2687409**.
- S5: `.env.local` already selects `liquidtestnet`, `/api`, the local API proxy with
  prefix stripping, and demo mode. `VITE_DEBUG_MNEMONIC` is absent.
- S6: the wallet check passed. Borrower: **199934 tLsats**, **5.000 TEST**,
  fingerprint **7522 bd0a ebc5 4541**. Lender: **99960 tLsats**, **5.000 TEST**,
  fingerprint **c1d6 8df3 5fda 0d5a**. Both saved wallet-split transactions are confirmed;
  the check did not broadcast another split. A later read-only sync confirmed **7** borrower
  and **4** lender tL-BTC coins, meeting the checklist's coin-count requirements.
- S7: the frontend proxy returns private candidates, and `/api/events` delivered
  `block_indexed` for **2687410**. Browser footer/rendering checks remain pending.
- S4: WASM rebuilt successfully with Rustup and Homebrew LLVM selected on PATH;
  `npm run parity` passed against the rebuilt artifact.

**Baseline differs from the earlier handoff:** this checkout's saved e2e state contains only
the two wallet-split records, and the API reports **one private candidate**, not the three
historic e2e offers in S11. The wallets' split txids also differ from the earlier handoff.
Do not mark S11's historic-offer assertions as passed. Record what these wallets actually
show before creating A, and distinguish this setup difference from a UI failure. An earlier
completed UI flow can cover A after its identity and relevant UI assertions are confirmed;
the B–D checks remain required.

**User update, 2026-11-02:** "I also have completed borrow - accept repay flow."
The local indexer lists one repaid offer with the following confirmed lifecycle. This is
indexer evidence, not yet confirmation that this is the user's reported offer or that every
T1–T4 UI assertion passed. In particular, directory selection, displayed amounts, balances,
and confirmation transitions still need the user's confirmation.

| Indexed action | txid | Block |
|---|---|---|
| Create | `555957d6b94261a69bfdd5903ee79a6d87dd86f93f781a7f535cecaab1301d45` | 2686275 |
| Accept | `182a1051f463f3b281954ae8f3b06c1dcee26efb7198a5777487c4c4363f0b35` | 2686278 |
| Claim principal | `7cc5fa59ff16d2665d06e2980dd2aa0fb0e0347e81598c98968cce7b9d85ffe1` | 2686279 |
| Repay | `31dd771ee5686f2da9e15e1ffeb38d60e92789eaedaf4568959f4b32f85d9966` | 2686765 |
| Claim repayment | `706054fc07c5eae71eeab03155986f7c3054a1a3af776b33fa1bc882549b18ee` | 2686785 |

The API status remains `repaid` after the repayment output is spent; the UI derives
`Claimed` from that spent output. The tracked repayment output is spent in the last
transaction above.

**Baseline resolved, 2026-11-02:** the user opened two separate Chrome profiles, connected
the configured seed wallets, saw balances, and confirmed both fingerprints match. Neither
profile lists offers. A fresh in-memory scan from height zero with each wallet also returned
zero matching offers at height **2687422**. Directly opening the indexed creation above with
each wallet returned `not-mine` as borrower and `view-tag-mismatch` as lender. Thus this
indexed offer is not addressed to either current test wallet; empty lists are the correct
baseline for these keys. No browser storage was cleared and no transaction was broadcast.
The user's earlier successful borrow–accept–repay report remains separate until its wallet
and offer identity are established. It must not be attributed to these test wallets.

On this Mac, the installed Rustup and Homebrew LLVM tools must precede Homebrew Rust and
Apple clang when rebuilding WASM:

```bash
cd web
PATH=/opt/homebrew/opt/rustup/bin:/opt/homebrew/opt/llvm/bin:$PATH npm run build:wasm
```

Fill in one row per step. For a step without a transaction, write `—` as the txid. The controller
of a later session copies the outcome into the handoff (the Task 11 brief names
`docs/superpowers/handoff/2026-10-29-private-lending.md`).

| Step | txid | Pass / Fail | Notes |
|---|---|---|---|
| S1 Postgres up | — | Pass | 2026-11-02: port 5432 listening; API database query succeeds. |
| S2 Indexer and API run | — | Pass | API ready; indexer commits new blocks. |
| S3 Indexer caught up | — | Pass | Indexer and testnet tip both 2687409 at preflight. |
| S4 Wasm built | — | Pass | Rebuilt with Rustup/Homebrew LLVM; parity passed afterward. |
| S5 `.env.local` written | — | Pass | Existing settings verified; testnet/demo/proxy enabled, debug mnemonic absent. |
| S6 Funds checked (balances, fingerprints) | — | Pass | Balances/fingerprints verified; 7 borrower and 4 lender confirmed tL-BTC coins. |
| S7 Dev server, proxy, event stream | — | Pass | HTTP proxy and block event verified; agent observed both pages rendered with liquidtestnet and /api, and scan heights advancing. |
| S8 Two profiles | — | Pass (user reported) | User opened two separate profiles. |
| S9 Borrower seed connected | — | Pass (user reported) | Balance visible; fingerprint matches. |
| S10 Lender seed connected | — | Pass (user reported) | Balance visible; fingerprint matches. |
| S11 Baseline e2e offers | — | Adapted baseline verified | Empty UI lists agree with fresh scans; historical offers belong to other keys. Original three-offer assertions do not apply to this setup. |
| R1 Borrower registered | — | Final state verified | Agent observed Manual Borrower with fingerprint 7522 bd0a ebc5 4541 in its own entry and the other wallet's directory. Registration animation was not observed. |
| R2 Lender registered | — | Final state verified | Agent observed Manual Lender with fingerprint c1d6 8df3 5fda 0d5a in its own entry and the other wallet's directory. Registration animation was not observed. |
| R3 Create A | `8685405903fcf79b11e44b6b2b5d4ee6903e73000397e771be9cb0c4df880f06` | Partial: chain/indexer verified | User supplied txid; confirmed in block 2687426 and indexed as pending. API and frontend proxy both list it. Brief initial 404 resolved when the indexer processed that block. UI terms, borrower/lender rows, balance change and two-confirmation transition still await user observation. |
| R4 Accept A | `2089b30656a013c71e1441c3716b1a86b33b34b5a971c6744b3c7bdd541dae40` | Partial: indexer verified | Spent A's pending output in block 2687428; created active offer and principal outputs. UI assertions and balance changes await user confirmation. |
| R5 Claim principal A | `976ad8d2dbb4b168f0b79627d4a292722d1cf25e292b90fd4361dd617368beed` | Partial: chain/indexer verified | User supplied txid; spends A's principal output, confirmed in block 2687432 (one confirmation when checked). Offer remains active. UI transition to Repay and balance change await user confirmation. |
| R6 Repay A | `b0d61c41ac6b9f735df02abc3442fdc95ce7c412e0e67cfdc63bef4c028be759` | Partial: chain/indexer verified | User supplied txid; confirmed in block 2687434 (one confirmation when checked), spends A's active offer output and creates repayment output 1, still unspent. API status repaid. Output 0 later verified as OP_RETURN 6275726e burning one unit of asset 25be3e6de31003b682a26c1ecc8e941a70c5a6b8ace4593684ba1933aa4c7e6c; fee 203 sats. UI assertions and balance changes await verification. |
| R7 Claim repayment A | `b6db38e5111a8a473428cd82fc63078f0a228d37d1a423e13b2b5b567e0bda5d` | Chain/indexer and final UI state passed; balance check pending | Confirmed in block 2687436, with 3 confirmations at tip 2687438. Indexer records A's repayment output spent by this txid. User reports "both claimed"; agent subsequently observed Claimed, correct 20000 / 1 / 1.1 terms, and no remaining action buttons in both wallets. Final balance increase has not been separately reported. |
| R8 Create B: blocked, reload, Broadcast Again | `3495225e6ab171a0d5765647bfb4ccd519007438871b992c598fb3e6b4dba9ce` (retry-test attempt) | Retry persistence passed; chain and both-wallet UI verified; exact creation balance delta not captured | All invalid-key cases and valid pasted-key resolution passed. First attempt 7b09fd…a32a7f broadcast because the rule edit was not committed and was subsequently cancelled (R9). Corrected rule independently verified; user signed the repeat. DevTools recorded the blocked request from client.ts:119; modal showed saved-not-broadcast warning. Application → IndexedDB showed exactly one private_create_offer record for 349522…dba9ce, broadcastStatus built, and stored txHex. Closing modal showed Not broadcast and disabled Review Offer with all fields filled. Reload restored the same row and disabled-creation notice; reopening showed the same Offer Transaction ID. User performed one blocked retry and reported the same warning. Refreshed IndexedDB still showed the same creation record with broadcastStatus built, errorMessage Failed to broadcast transaction., unchanged createdAt 1793610029516 and updatedAt 1793610315751; total entries remained 2 (one creation plus the prior cancellation). Request blocking was then disabled (verified unchecked). User reported successful retry; Esplora verified the identical txid confirmed in block 2687518 with fee 167 sats. Refreshed IndexedDB contained one entry for B with broadcastStatus broadcast, confirmationStatus confirmed, confirmations 1, and no errorMessage; the older cancellation record had been removed by normal reconciliation. At tip 2687519 the borrower showed Open Offer/Cancel and lender Open Offer/Accept with collateral 21,000 and expiry 2688945. No duplicate creation was observed. The exact creation balance delta and transient success modal were not captured. Before cancellation, borrower dashboard showed 177,905 tLsats and 4.9 TEST. User then signed its cancellation; see R9. |
| R9 Cancel B | `c835af20b479ded7f988b0b71f0925071364a7a18cc75d504426bd6442b56a7c` (repeat B); first attempt `fc829c5a33cf74a71e1e6b4bdeffa2ae79a29f6fae93c9fad8aaede0c03aa764` | NFT burns, both-wallet final UI, and balance delta passed; transient signing summary not captured | First attempt cancellation confirmed in block 2687504. Repeat B: user signed with blocking off. c835af…b56a7c spends B outputs 3, 1, 0, 4; outputs 0 and 1 burn one lender and borrower NFT respectively via OP_RETURN 6275726e. Fee 749 sats; confirmed in block 2687522 and indexed cancelled. Borrower showed Processing while unconfirmed; at scanned block 2687522 both wallets showed Cancelled with no action. Borrower dashboard went from 177,905 tLsats to 41,000 confirmed +157,156 pending, then 198,156 confirmed, exactly +21,000 −749. TEST stayed 4.9. |
| R10 Create C: Discard (C never broadcast) | `9f4fb3ba9011b960ed81a1968582d3a60b824fb3edbbed594d849a0aa0c73cc5` | Discard passed after construction mitigation | User reported stuck Constructing Transaction. Agent observed the same stage and an uncaught LWK WASM recursive-use/unsafe-aliasing error. Refreshed IndexedDB contained only B and its cancellation, no C record. Reload recovered the page. syncBalances now shares concurrent scans per wallet; manual sync propagates failures to the transaction flow. TypeScript, full lint, and 3 offline wallet-sync regression checks passed. Exact cause of the observed WASM failure remains a hypothesis. After the guard and reload, user retried and reported the expected warning; agent independently observed saved-but-not-broadcast and the new creation record with broadcastStatus built and Failed to broadcast transaction. errorMessage. C review restored with 22,000 / 1 / 1.1 / expiry 2688970; exact broadcast rule and global blocking verified enabled with DevTools open. Baseline 198,156 tLsats and 4.9 TEST. At tip 2687536, GET /tx/C and local candidate both returned 404. Agent clicked Discard It while blocking remained enabled: modal closed, no pending row/notice, and filled form Review Offer enabled. Blocking then disabled (Value 0); refreshed IndexedDB had 0 entries. Dashboard still showed 198,156 confirmed tLsats and 4.9 TEST with no pending amount. Neither wallet listed C; lender scanned through 2687537. Both APIs still returned 404 at tip 2687537 (several blocks after C was built). |
| R11 Create D | `ebed043d45cad83d2cab46a46a04231250879983d57a68ef6915b5f7373fcd49` | Chain, terms, and collateral balance delta passed | Manual Lender, collateral 23,000 / principal 1 / repayment 1.1 / duration 10 blocks. Review fixes expiry at 2687548. Blocking off. Before D borrower 198,156 tLsats / 4.9 TEST; lender 99,656 tLsats / 5.1 TEST. Confirmed in block 2687539, fee 172 sats; indexer pending. Borrower Processing observed; lender Open Offer/Accept with correct 23,000 / 1 / 1.1 terms and expiry 2687548. Borrower dashboard confirmed 174,984 tLsats (198,156 −23,000 −172), TEST unchanged 4.9. |
| R12 Accept D, no Liquidate before expiry | `c207dc3a055235582f057263ded6a809bb58d6bbccee9f1714abd62ab0b127b7` | Chain, balance delta, and pre-expiry gating passed | Confirmed at 2687540, fee 342 sats. Indexer active with principal output unspent. Lender balances 99,314 tLsats and 4.1 TEST (−342 sats and −1 TEST). At 2687541 (2 confirmations), lender Active, no Liquidate button, note Liquidation opens after block #2687548.; borrower Active with Claim Principal. Principal deliberately left unclaimed. |
| R13 Liquidate D | `e679f75e2dd7e2a48000e110b2e86e02186770be2cb58a5a55a2d4a17c75d296` | Chain, balance delta, both-wallet liquidation UI passed; exact expiry-label timing not captured | At indexer height 2687548, lender remained Active with no Liquidate, note opens after block 2687548, but expiry label still ~1m because the independent tip query polls every 30 seconds. Next observation at indexer height 2687549 showed Expired; exact Expired label while chain tip equaled N was not captured. With public tip 2687549, Liquidate appeared after the next UI tip refresh. Modal showed 23,000 collateral, expiry 2687548 (Expired), and enabled Liquidate & Claim Collateral. Pre-liquidation lender balance 99,314 tLsats / 4.1 TEST. User submitted; confirmed in block 2687551 (>2687548), locktime 2687548, fee 167. Indexer liquidated; principal still unspent. Lender dashboard 122,147 tLsats (+23,000 −167), TEST 4.1 unchanged. Lender Processing observed at first confirmation, then Liquidated with no action at scanned block 2687553; borrower Liquidated with Claim Principal and The loan was liquidated; the principal is yours. note. |
| R14 Claim principal D (R14b: e2e offer) | `087429bb534156ac1b6c5f6089b73ac76a1be29abb773eab424a3ed597ee6a31` | Confirmed; both-wallet final UI and balance delta passed | Post-liquidation Claim Principal review opened for D; claims remaining 1 TEST. Pre-claim borrower 174,984 tLsats / 4.9 TEST. User submitted; explorer fee 142 sats. Borrower dashboard initially showed 21,000 confirmed +153,842 pending tLsats and 4.9 confirmed +1 pending TEST, matching expected −142 sats / +1 TEST. Borrower Processing observed. Claim confirmed at 2687553 with 2 confirmations at tip 2687554. Borrower final 174,842 tLsats / 5.9 TEST; both wallets Liquidated with no actions. |
| R15 Final balances | — | Browser wrap-up passed for current-wallet offers | At scanned block 2687554, borrower A Claimed, both B attempts Cancelled, D Liquidated; no Processing or Not broadcast, no remaining actions. Lender same terminal states observed at 2687553. C absent. Final borrower 174,842 tLsats / 5.9 TEST; lender 122,147 tLsats / 4.1 TEST, all confirmed. Borrower request blocking explicitly off before DevTools closed; lender DevTools closed throughout. Historical e2e offers do not apply to current keys (S11). |
| J1 Jade connected (firmware version) | — | Connected; distinct identity verified | User reports Jade firmware 1.0.41. After D completed, borrower seed disconnected and Jade TESTNET selected. Chrome serial chooser showed an empty compatible-devices table; user asked to connect/power on Jade, select port, unlock and approve blinding-key export if prompted. User then connected/unlocked Jade. Agent verified connected address ending e3m839 and fingerprint e147 ede3 c72c bbc2, distinct from both seed keys; existing directory entry is test. Device PIN/export screens were user-operated, not directly observed. |
| J2 Jade funded | `25bb314221df2d3ee722b8d2d014c587c8ac685a3a90e7eed150bd3108c1debc` | Funding confirmed; creation coin requirement satisfied | Initial Jade balance 299,657 tLsats / 4.9 TEST, but UI reported only 2 confirmed tL-BTC coins. One faucet request to the copied Jade receive address succeeded for 100,000 sats; no additional TEST needed. Confirmed in block 2687559; dashboard 399,657 confirmed tLsats / 4.9 TEST. Coin warning cleared after leaving/reopening Private page. |
| J3 Jade registered (optional) | — | Skipped; existing entry retained | Jade identity was already registered as test; left the existing entry unchanged. |
| J4 Create J: built, sent to Jade | — | Build and device signing completed; transient stepper not captured | Manual Lender selected, 24,000 tLsats / 1 TEST / 1.1 TEST / expiry 2689002. User subsequently reported 24000 on Jade and everything seems fine. Agent observed Transaction Pending success dialog. Device labels/warnings were not recalled; see J5. |
| J5 Jade screens: collateral amount, NFT domain | — | Collateral amount passed by user report; metadata/warnings unverified | User reported 24000 on Jade. When asked for exact NFT/domain/asset labels and warnings, user replied i do not remember. Do not infer the metadata-display checklist passed. |
| J6 Create J: signed and broadcast | `9503204c8730cc100538669d1c5669e4c03edbe6692d23f9a9fb94f694e58e95` | Signing, chain, balance delta, both-wallet offer verified | Agent observed Transaction Pending dialog with 24,000 / 1 / 1.1 summary. Confirmed in block 2687565, fee 136 sats, indexer pending. Jade 375,521 tLsats (399,657 −24,000 −136) and unchanged 4.9 TEST. Borrower and lender Open Offer with correct terms; lender sees Jade fingerprint e147 ede3 c72c bbc2. No registry-console observation captured. |
| J7 Accept J | `762b21d1db49849e451f50ba026fb6afd08295fba8007e9c8ed133fcbb92d54d` | Confirmation, both-wallet UI, and balance delta passed | Confirmed in block 2687568, fee 301 sats. At scanned block 2687569 (2 confirmations), lender Active with no action and liquidation opens after 2689002; Jade Active with Claim Principal. Lender 121,846 tLsats / 3.1 TEST (−301 sats / −1 TEST). User chose to stop after required acceptance checks, leaving principal unclaimed and loan active. |
| J8 Claim principal J, Broadcast Again | — | Skipped at user request | User explicitly chose to stop after required acceptance checks. |
| J9 Repay J | — | Skipped at user request | User explicitly chose to stop after required acceptance checks. |
| J10 Claim repayment J | — | Skipped at user request | User explicitly chose to stop after required acceptance checks. |

## If something fails

1. **Stop at that step.** Do not rebuild to get past it: a rebuilt creation is a different offer.
   A transaction that was saved but not sent is retried only with **Broadcast Again**, and
   discarded only if its coins were spent since.
2. **Capture**, into `web/.e2e-private/manual-run/` (git-ignored), named after the step:
   - **the console:** DevTools Console (with **Preserve log**), right-click, **Save as…**;
   - **a screenshot** of the modal with its error text and the stepper step that failed;
   - **the transaction:** the UI never shows a PSET. If the failure came after **Finalizing
     Transaction**, the finalized transaction is saved: copy `txid` and `txHex` from IndexedDB
     (`simplicity-lending:private-transactions`, `private-tx`). A failure before signing leaves
     no hex: the console error and the step name are the evidence;
   - **the failing request**, if any: DevTools **Network**, right-click it, **Copy as cURL**;
   - **for Jade:** photos of the device screens and the firmware version;
   - **the indexer and dev server:** `tail -n 50 /tmp/lending-indexer-testnet/indexer.log
     /tmp/lending-indexer-testnet/api.log`, and the dev server's terminal output.

   Search every saved log for a seed phrase before you share it.
3. **Write it down:** mark the step **Fail** in the results table, and add an entry under
   "Findings" below: the step, what you did, what you expected, what happened, and the files.
4. **A Jade failure is a finding for a follow-up task, never a silent pass.** That includes a
   wrong or missing amount on the device, a signing error, and a step that only passed after a
   workaround this checklist does not describe.

**Known issues** (from the handoff; record them if seen, but they are not new findings):

- The explorer link of a txid that was never broadcast gives a 404.
- A saved local record overrides what the indexer shows: a dropped broadcast can show
  **Processing...** for up to 24 hours, and a `built` record hides the offer's action until it is
  sent or discarded.
- A finalized creation the indexer has not listed yet disappears from the pending row until the
  scan finds it.
- **Accept** checks the TEST balance but not the tL-BTC fee reserve.
- A directory name can render without its fingerprint while the wasm module loads.
- HeroUI logs "PressResponder" warnings in the console.

## Findings

(One entry per failure or surprise: step, what you did, expected, actual, files captured.)

- R8 test setup error (2026-11-02): entering the request pattern and pressing Tab did
  not commit the edited rule. The checkbox label still showed the original `*://*`.
  The user signed, and offer `7b09fd…a32a7f` broadcast rather than exercising retry.
  Corrected by entering the exact HTTPS URL and pressing Enter; the rule's label then
  updated. A harmless GET fetch from the app produced an explicit DevTools-blocked
  warning and incremented the affected count. Top-level navigation to the endpoint had
  not been a valid blocking probe. This is a test setup failure, not evidence of an app
  retry defect. Cancel the broadcast offer; repeat the retry test with the verified rule.
- During the first B creation/confirmation, Chrome logged repeated React errors:
  `Encountered two children with the same key, 1`. They ceased after navigation/reload.
  Source is not identified. A read-only review found no duplicate keys in the private
  create confirmation stepper or summary; capture a component stack if it recurs.

- Scenario C construction stall (2026-11-02): console reported `Uncaught Error: recursive use of an object detected which would lead to unsafe aliasing in rust` from `lwk_wasm.js:11836` while the stepper stayed at Constructing Transaction. Manual `sync()` could overlap a background full scan despite the background-only boolean guard. Added shared in-flight scans in `web/src/lib/wallet-core/wallet/sync.ts`, and made manual sync reject on failure so transaction construction stops. Three deferred-scan regression checks in `web/scripts/check-wallet-sync.ts` pass (overlap, rejection/retry, separate wallets), as do `tsc -b` and full lint. The next browser attempt reached the expected saved-but-not-broadcast warning with a new built record (see R10). One successful retry supports the mitigation but does not prove the root cause. Discard checks remain pending. A shareable library report is saved at `docs/bug-reports/2026-11-02-lwk-web-concurrent-scan-hang.md`.

- Jade funding UI observation (2026-11-02): after faucet confirmation and balance sync, the New private offer form still reported 2 confirmed coins and disabled Review Offer. The dashboard showed the new 399,657-sat balance. Leaving/reopening Private refreshed the UTXO query and cleared the warning. `usePolicyAssetUtxos` is stale immediately but has no explicit invalidation tied to successful wallet scans; no fix applied yet.

- Separate user-requested smart-contract review completed: `docs/security/2026-11-02-private-lending-contract-review.md`. M-01 reports acceptance of stale pending offers followed by immediate liquidation; demonstrated at covenant VM level with synthetic transactions, not full consensus-valid on-chain execution. Production contracts were not changed.

### Run stopping point (2026-11-02)

The user explicitly stopped after the required Jade acceptance checks; J8–J10 were not run. Jade offer `950320…e58e95` remains active, expires at height 2689002, and its 1 TEST principal remains unclaimed. Request blocking is off and DevTools is closed. Full Task 11 sign-off remains open: exact Jade NFT/domain/warning observations were not recalled, registry-console behavior was not captured, and earlier per-step/transient UI or balance assertions marked partial in the results table remain unverified. No merge or deployment was performed.
