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
  shows the wallet's balance and has four sections: **Proposals** (`/lend/proposals`, the
  proposals addressed to you), **Loan book** (`/lend/loans`), **Terms** (`/lend/terms`) and
  **Profile** (`/lend/profile`). On a narrow screen the sidebar becomes a bar above the work area.
- **The borrower app** (`/borrow`) takes a borrower through three steps: **Choose a lender**
  (`/borrow`), **Propose** (`/borrow/<lender key>`) and **My loans** (`/borrow/loans`). Its header
  shows the wallet's balance.

Each balance counts the wallet's confirmed coins of the pair's two assets (tL-BTC and TEST on
testnet), which the app spends, with any unconfirmed amount beside it as **pending**. It
refreshes every minute and when the tab regains focus.

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
   do not. You may add a private message to the lender; see [Private messages](#private-messages).
   No lender accepts a collateral above 2^44 base units (175,921.86044416 tL-BTC) or a repayment
   above 2^50 − 2 base units, so the form refuses them: "The collateral is more than a lender can
   accept: ask for less."
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

**Repay** opens a form with what you have paid so far and what you still owe, and with **Collateral
released so far** and **Collateral left**. The amount starts at what you still owe, in the
repayment asset.

- **Less than you owe** pays an installment. The rest stays owed and the loan stays open. The
  installment releases the part of your collateral it pays for: the form shows **Collateral
  released** and **Collateral left after it** for the amount you type. My loans then shows how much
  of the repayment you have paid, such as "Active, 300 of 1,100 TEST repaid, due in 12 days", with
  the collateral **Released** and **Left**.
- **All you owe** repays the loan in full. The collateral the loan still holds comes back to you
  (**Collateral back to you**), and the borrower role token is burned.
- **Nothing, or more than you owe**, is refused, as is an amount with more decimals than the asset
  has.

The form has a **Private message (optional)** field for a message to the lender with the payment.

Each installment is a transaction of its own with its own fee, and the lender claims it
separately. Only you and the lender can read its amount: on chain it is hidden like the loan's
other amounts. The app reads what you have paid from the chain and your wallet alone, so a new
browser or device shows the same figures.

#### Collateral released by installments

The loan keeps collateral in proportion to what it still owes, rounded up: a loan of collateral `C`
and repayment `R` that still owes `d` holds `⌈d·C/R⌉`, and the rest has come back to you. With
20,000 tL-sats of collateral against a repayment of 1,100 TEST units, an installment of 366 units
releases 6,654 tL-sats, a second of 244 releases 4,436 more, and the full repayment of the last 490
gives back the 8,910 left. The releases always add up to the whole collateral. A small installment
can release nothing when the collateral it pays for rounds to zero; it is still paid, and a later
payment releases what they add up to.

The release goes to a new address of your wallet, in the installment's own transaction, hidden like
the loan's other amounts. The contract checks it: the installment proves on chain that the loan
keeps exactly the collateral its debt calls for, so you cannot take more and the lender cannot keep
more. The proof makes an installment larger than a plain payment, about 50,000 weight units, and its
fee grows with it.

Each loan has its own **carry token**, which its creation issues and its installments pass on: they
carry hidden figures the proof needs from one installment to the next. The app finds them and spends
them for you, with your role token; you never handle them. The full repayment burns them, and so
does a cancellation. A loan takes at most 1,024 installments; after that the form offers only the
full repayment.

Installments are not refunded if the loan is liquidated. Once the term ends, the lender can take
the collateral and keep every installment you paid. So from the loan's expiry block on, the form
takes only the full repayment: "The term has ended: the lender can take the collateral at any time.
Repay in full to get it back."

An installment never pays the whole debt: what you still owe always goes through the full
repayment, which gives back the collateral left.

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
   passed. The review shows the borrower's message, if any, under **Message from the borrower**,
   and you may answer with a private message of your own.
5. The loan then appears in **Loan book**. **Lent** shows the principal with the repayment under
   it, **Repaid** what the borrower has repaid with what it still owes under it, and **Claimable**
   what you can claim; **Status** shows when the loan is due. When the borrower pays an
   installment, select **Claim** to receive it; the lender role token comes back to you. Under
   **Collateral**, the loan book shows the collateral the installments gave back to the borrower
   ("released") and the collateral the loan still holds ("left"). Once the borrower repays the rest,
   select **Claim repayment**: it receives the repayment and every installment you have not
   claimed, and consumes the lender role token. A repaid loan is not fully claimed until this
   separate transaction completes.
6. If the loan remains unpaid past its expiry height, **Liquidate** becomes available. Liquidation
   consumes the lender role token and gives you the collateral the loan still holds, with the
   installments you have not claimed.

The console accepts no proposal whose collateral is above 2^44 base units or whose repayment is
above 2^50 − 2: beyond them the contract's check of each release would not hold. Such a proposal
says that its collateral or its repayment is outside what a lender can accept, and offers no
action.

An installment the borrower built outside this app may not open with your key. **Claimable** then
marks it "amount unknown", and **Repaid** shows what is owed as "at most" the repayment less what
you can read. **Claim repayment** still takes it, and you receive the repayment in full; a
liquidation leaves it unclaimed. Without its amount, the console cannot compute the collateral the
loan holds, so it searches for it, from the chain and the offer's secrets alone, in the background:
**Collateral** says "computing…" for about a second, and the liquidation uses what it finds.

The summary at the top of **Proposals** counts the proposals waiting for you, the active loans, the
principal lent out, the collateral held, and the loans due within 7 days or overdue. These are this
wallet's figures, not a market-wide total. Proposals that cannot be opened or verified, are no
longer listed, or use unsupported assets are excluded. Loading and failed scans are shown
explicitly; an error is not a zero balance or proof that there are no loans.

Liquidation depends on block height, not a price feed. The UI considers expiry passed when the
observed tip is strictly greater than the expiry height. Tip and indexer updates can lag. A borrower
can still claim previously unclaimed principal after liquidation if its principal output remains
unspent and the borrower retains the required role token.

## Private messages

A borrower and a lender can send each other a private message with a loan's transactions. The
proposal form, the review's **Accept and lend** and the **Repay** form each have a **Private
message (optional)** field. An empty field sends no message. The field counts the text in UTF-8
bytes against its limit: a Latin letter is 1 byte, a Cyrillic letter 2 and an emoji 4. A text over
the limit is refused before anything is built, and the field says how many bytes it has and how
many fit.

| Message | From | Who reads it | At most |
| --- | --- | --- | --- |
| With the proposal | The borrower | The lender, and the borrower on any device | 2915 bytes |
| With the acceptance | The lender | The borrower; the lender only in the browser that sent it | 3068 bytes |
| With an installment | The borrower | The lender, and the borrower on any device | 3068 bytes |
| With the full repayment | The borrower | The lender; the borrower only in the browser that sent it | 3068 bytes |

A cancellation, a claim and a liquidation carry no message.

Only the two parties can read a loan's messages; on chain they are hidden like its amounts, and a
transaction with a message looks the same as one without. The proposal's and the installments'
messages read again from the sender's wallet on any device. The acceptance's and the full
repayment's do not: their sender reads them again only in the browser that sent them, which keeps
a record of every acceptance, installment and full repayment it sends, with its message. That
record stays in the browser profile after you disconnect, like the saved transactions. A message
you sent from another browser does not show, and the timeline says so: "Messages you sent from
another browser do not show here." The text of a transaction that was discarded and never
broadcast never shows as sent.

The lender reads the borrower's message in the proposal's review. Afterwards, a loan with messages
has a **Messages (n)** link, under **My loans** and in the **Loan book**, which opens its timeline:
each message in chain order with its step (**Proposal**, **Acceptance**, **Installment n** or
**Full repayment**), its sender's key fingerprint, the sender's directory name when its entry
verifies, and "(you)" on your own.

Every message shows the note "A message is not part of the terms, and the contract does not enforce
it." A promise made in a message binds nobody; only the terms do. Messages show as plain text: no
link in one is clickable, and control characters and bidirectional-text controls are removed. The
browser signs the acceptance's, the installments' and the full repayment's messages with your
lending key for that step of that loan; a Jade neither shows nor signs them. A message whose
signature does not verify for its step shows **Unverified**: the other party can read the output
that carries it, and may have moved it there from another step. A message that cannot be decoded
shows "This message could not be read." The proposal's message is the exception: it is part of the
terms the borrower signs, so a proposal whose message cannot be decoded does not open at all, and
the lender never sees it. Anyone who holds your wallet's confidential descriptor can derive your
lending key and read your messages too.

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
new one from the same coins could reveal both amounts. It also pays exactly the earlier one's
amount, as two installments of the same step with different amounts would reveal how much
collateral each released; for another amount, repay in full. This record lives in the browser
profile too.

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
