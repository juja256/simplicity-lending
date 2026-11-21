---
title: Private-loan user guide
description: Use the Liquid testnet demo to propose, accept, repay, cancel, and liquidate confidential loans.
---

# Private-loan user guide

Private loans let a borrower propose a loan to a chosen lender without publishing the loan's assets
and amounts in plaintext on-chain. Both parties verify the terms in their own browsers. This guide
describes the current Liquid testnet demo. Use test wallets and test assets.

## Two areas

The app has one area for each role. The landing page at `/` opens both: **Open lender console**
under **For lenders**, and **Borrow** under **For borrowers**. Each area links to the other, so one
wallet can use both. The route decides the area; the app does not remember a role.

- **The lender console** (`/lend`) is where a lender publishes terms and runs a book. Its sidebar
  has four sections: **Proposals** (`/lend/proposals`, the proposals addressed to you), **Loan
  book** (`/lend/loans`), **Terms** (`/lend/terms`) and **Profile** (`/lend/profile`). On a narrow
  screen the sidebar becomes a bar above the work area.
- **The borrower app** (`/borrow`) takes a borrower through three steps: **Choose a lender**
  (`/borrow`), **Propose** (`/borrow/<lender key>`) and **My loans** (`/borrow/loans`).

Both areas can be opened before connecting a wallet. The old `/app` routes open the landing page.

## Connect a wallet

Use a Jade wallet configured for Liquid testnet, or choose test-seed login when demo mode is
enabled. Test-seed login is an explicit wallet choice; the release does not embed a seed. Other
wallet connectors can connect but do not support private loans.

For Jade, use a browser with WebSerial support, connect with a data-capable USB cable, select the
device, and unlock it. The deployed app needs HTTPS; localhost can be used for local testing.
Approve the required blinding-key export on the device. Review the amount, asset, and any warnings
on the device for every signing operation.

## Lending keys and the directory

Each wallet has a lending key, derived in the browser. The console's **Profile** shows it as **Your
lending key** with its fingerprint, and **Copy key** copies the whole key. Proposals reach a lender
through this key.

A lender is listed for borrowers by publishing terms on the console's **Terms** page. The terms are
for the pair the app is built for (tL-BTC collateral and TEST principal on testnet): the least APR,
the most principal per 1 unit of collateral, the shortest and longest term in days, and the smallest
and largest principal. A display name is published with them. The name and terms are public, and the
app signs them together with the lending key. **Sign and publish** shows **Terms published** once
the directory has them. **Profile** changes the name (**Publish name**, which signs the current
terms again, unchanged) or removes the entry (**Remove from directory**). Proposals and loans
already made are not affected by a removal.

The borrower app lists only lenders whose signed terms verify, each with when the terms were
published, and shows each lender's fingerprint as **Lender key**. A lender whose entry does not
verify is hidden and only counted. Anyone can choose a directory name, so a familiar name alone does
not authenticate its owner: compare the fingerprint through a trusted channel. The lending key is
not a payment address or a recovery phrase. Never share a seed to exchange lending keys.

For testing both roles, use separate browser profiles with distinct wallets. A proposal to one
lender's key will not appear as a proposal to another lender, even if both wallets have balances.
The borrower app does not list your own key.

## Borrow

1. Fund the borrower with confirmed testnet L-BTC for collateral and fees. Proposing currently needs
   at least **three confirmed collateral-asset coins (UTXOs)**, as well as enough total value. A
   single large coin is not sufficient for the two role-token issuances and collateral.
2. Under **Choose a lender**, compare the lenders' terms and their **Lender key** fingerprints, then
   select **Borrow from** the lender you want.
3. On **Propose**, enter the principal, the term in days, the collateral, and the APR, each within
   the lender's terms. A field outside them says which term it breaks, and the proposal cannot be
   sent until every field is within them. **Repayment** shows what you repay and the interest in it,
   and the summary sentence below says what you repay by which date and what the lender keeps if you
   do not.
4. Select **Lock collateral and send**, check the proposal, and approve signing. Wait for
   confirmation and indexer discovery. The proposal then appears under **My loans**, waiting for the
   lender.
5. Once the lender accepts, select **Receive** on the loan; the button names the amount. Acceptance
   locks the principal for you; it does not immediately turn it into an ordinary wallet balance.
6. Obtain enough of the repayment asset and testnet L-BTC for fees, then select **Repay** while
   sufficient time remains. You can repay in installments or all at once; see [Repay](#repay).

Receive the principal before repaying. The app requires evidence of that claim because repaying in
full burns the role token needed to unlock an unclaimed principal, and the app pays no installment
before the claim either.

To withdraw a proposal the lender has not accepted, select **Cancel** on it under **My loans** and
wait for confirmation. Cancellation returns the collateral, consumes both role tokens, and costs a
transaction fee.

### Repay

**Repay** opens a form with what you have paid so far and what you still owe. The amount starts at
what you still owe, in the repayment asset.

- **Less than you owe** pays an installment. The rest stays owed and the loan stays open. My loans
  then shows how much of the repayment you have paid, such as "Active, 300 of 1,100 TEST repaid,
  due in 12 days".
- **All you owe** repays the loan in full. Your collateral comes back to you, and the borrower role
  token is burned.
- **Nothing, or more than you owe**, is refused, as is an amount with more decimals than the asset
  has.

Each installment is a transaction of its own with its own fee, and the lender claims it
separately. Only you and the lender can read its amount: on chain it is hidden like the loan's
other amounts. The app reads what you have paid from the chain and your wallet alone, so a new
browser or device shows the same figures.

Installments are not refunded if the loan is liquidated. Once the term ends, the lender can take
the collateral and keep every installment you paid. So from the loan's expiry block on, the form
takes only the full repayment: "The term has ended: the lender can take the collateral at any time.
Repay in full to get it back."

If your installments have paid the whole debt, the loan shows **Close the loan** instead of
**Repay**. Closing pays nothing and gives your collateral back. The app never makes such an
installment itself, since an installment of all you owe is the full repayment.

### How the term is counted

A proposal's term counts whole days, of 1440 blocks each, from the block its creation confirmed in.
The app sets the expiry 60 blocks (about an hour) past the days you chose, so a proposal that
confirms within an hour of being signed counts exactly those days. One that confirms later counts a
day less, and the lender console may flag it as outside the lender's terms. The term does not
restart when the lender accepts.

## Lend

1. Publish your terms on the console's **Terms** page, as described above.
2. Fund your wallet with the principal asset and testnet L-BTC for fees.
3. Under **Proposals**, each proposal addressed to you shows its borrower, principal, collateral,
   APR and term, and how it compares with your terms: a **Within your terms** badge, or one badge
   for each term it breaks, naming your figure (such as "APR below 6 %" or "Term shorter than 30
   days"). When it cannot be checked, the badge says why: **No terms published**, **Your terms do
   not verify**, or **Not checked** when your terms or the app's loan rules could not be loaded.
   The term, the APR and the badge wait until the proposal's creation is confirmed. The app
   verifies a proposal before enabling an action.
4. Select **Review**, check the amounts, the borrower, and the expiry block, then select **Accept
   and lend** and approve signing. You can accept a proposal outside your terms after the warning.
   Wait for confirmation and indexing. Acceptance is not offered once a proposal's expiry has
   passed.
5. The loan then appears in **Loan book**, with what the borrower has repaid, what remains and what
   you can claim. When the borrower pays an installment, select **Claim** to receive it; the lender
   role token comes back to you. Once the borrower repays the rest, or closes a loan its
   installments paid, select **Claim repayment**: it receives the repayment and every installment
   you have not claimed, and consumes the lender role token. A repaid loan is not fully claimed
   until this separate transaction completes.
6. If the loan remains unpaid past its expiry height, **Liquidate** becomes available. Liquidation
   consumes the lender role token and releases the collateral to you, with the installments you
   have not claimed.

An installment the borrower built outside this app may not open with your key. **Claimable** then
marks it "amount unknown", and **Remaining** shows the debt as "at most" the repayment less what
you can read. **Claim repayment** still takes it, and you receive the repayment in full; a
liquidation leaves it unclaimed.

The summary at the top of **Proposals** counts the proposals waiting for you, the active loans, the
principal lent out, the collateral held, and the loans due within 7 days or overdue. These are this
wallet's figures, not a market-wide total. Proposals that cannot be opened or verified, are no
longer listed, or use unsupported assets are excluded. Loading and failed scans are shown
explicitly; an error is not a zero balance or proof that there are no loans.

Liquidation depends on block height, not a price feed. The UI considers expiry passed when the
observed tip is strictly greater than the expiry height. Tip and indexer updates can lag. A borrower
can still claim previously unclaimed principal after liquidation if its principal output remains
unspent and the borrower retains the required role token.

## Expiry does not withdraw a pending offer

The current contract does not enforce an acceptance deadline or a minimum term after funding.
Although the app hides acceptance after expiry, a client outside this UI can accept an uncancelled
pending proposal after expiry and then liquidate it without another borrower signature. It must
still supply the promised principal, which remains claimable by the borrower.

Cancel unwanted pending proposals and confirm the cancellation. Submitting a cancellation alone does
not revoke the proposal: acceptance and cancellation can race to spend the same outputs. This known
contract limitation remains unresolved in the demo. See the [protocol
notes](./protocol.md#expiry-and-review-status) for the review scope.

## Broadcast recovery

If signing succeeds but broadcast fails, the app saves the finalized transaction in this browser and
shows a saved-but-not-broadcast warning. **Broadcast again** resends the same transaction with the
same transaction ID; it does not create or sign another loan. A saved proposal that would now count
fewer days than you chose, or a saved acceptance whose proposal's term has passed, is not sent
again: the app offers only **Discard** for it. The same holds for a saved installment once the
loan's term has ended. While a saved installment waits, the app offers no other payment on that
loan. After you discard one, or once the app stops tracking one that never confirmed, the app pays
the next installment of that loan from other coins: if the earlier one did reach the network, a
new one from the same coins could reveal both amounts. This record lives in the browser profile
too.

Preserve the browser profile and its site data while a transaction needs recovery. A different
profile does not have that local retry record. Check the transaction ID in the explorer if the
network response was ambiguous: failure to receive a response does not prove rejection.

**Discard** removes the local record; it does not revoke a signed transaction, cancel a proposal, or
reverse a broadcast. Discard only when that transaction can no longer be mined, for example because
its inputs have already been spent. After a successful broadcast, allow confirmation and indexing to
finish before attempting another action.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Balances appear but proposals do not | Confirm the network and wallet fingerprint, the lender's key, creation confirmation, and indexer progress. Separate profiles must use the intended distinct wallets. |
| A lender is missing from Choose a lender | The lender has not published terms for this pair, or its entry did not verify. The note under the list counts hidden lenders. |
| Loading fails or requests are rate-limited | Let the upstream limit recover, then retry the scan. Repeated refreshes can add requests. Check the local indexer/API if running locally. Do not propose again just because a proposal is missing from the list. |
| Lock collateral and send is disabled | Bring every field within the lender's terms, wait for funding confirmation, and check the number of separate confirmed coins and the fee reserve. Refresh wallet balances after new funding. |
| A transaction remains processing | Check its transaction ID and allow the indexer to catch up. Keep the saved record until the outcome is known. |
| A proposal fails verification | Do not accept or sign it. A directory match or displayed amount does not override verification failure. |
| Jade is absent from the device chooser | Check the USB data cable, power, browser support, and whether another app holds the device connection. |

The demo has completed several seed-wallet lifecycle and recovery scenarios, plus Jade creation and
lender acceptance. Exact Jade metadata/warning observations and other manual assertions remain
incomplete; this guide does not imply full release or security sign-off.
