---
title: Private-loan user guide
description: Use the Liquid testnet demo to create, accept, repay, cancel, and liquidate confidential lending offers.
---

# Private-loan user guide

Private loans let a borrower make an offer to a chosen lender without publishing the loan's
assets and amounts in plaintext on-chain. Both parties verify the terms in their own browsers.
This guide describes the current Liquid testnet demo. Use test wallets and test assets.

## Connect and find your loans

Open **Private loans** in the app's main navigation or **Open private loans** on the dashboard.
The route is `/app/private`. Navigation is available before connecting a wallet.

Use a Jade wallet configured for Liquid testnet, or choose test-seed login when demo mode is
enabled. Test-seed login is an explicit wallet choice; the release does not embed a seed. Other
connectors may work for public loans without supporting private loans.

For Jade, use a browser with WebSerial support, connect with a data-capable USB cable, select the
device, and unlock it. The deployed app needs HTTPS; localhost can be used for local testing.
Approve the required blinding-key export on the device. Review the amount, asset, and any
warnings on the device for every signing operation.

The dashboard's **Private loans** card shows:

| Count | Meaning |
| --- | --- |
| Open offers | Verified offers for this wallet whose indexed state is pending, including pending offers past their expiry height. |
| Active loans | Verified offers whose indexed state is active. |
| Total offers | All verified offers for this wallet, including completed history. |

These are wallet-specific counts, not a market-wide private-loan total. Offers that cannot be
opened or verified, are no longer listed, or use unsupported assets are excluded. Loading and
failed scans are shown explicitly; an error is not a zero balance or proof that there are no loans.

## Exchange lending keys

The private page shows **Your lending key** and its fingerprint. The lender can copy the key
and share it directly, or register a display name in the lender directory. Registration is
optional: the borrower can paste a key instead.

Compare the fingerprint through a trusted channel before using a key. Anyone can choose a
directory name, so a familiar name alone does not authenticate its owner. The lending key is
not a payment address or a recovery phrase. Never share a seed to exchange lending keys.

For testing both roles, use separate browser profiles with distinct wallets. An offer to one
lender's key will not appear as an offer to another lender, even if both wallets have balances.

## Borrow

1. Fund the borrower with confirmed testnet L-BTC for collateral and fees. Creation currently
   needs at least **three confirmed collateral-asset coins (UTXOs)**, as well as enough total
   value. A single large coin is not sufficient for the two role-token issuances and collateral.
2. Under **Borrow: your offers**, choose a lender or paste its key. Check the fingerprint.
3. Enter collateral, expiry in blocks, principal, and total repayment. On Liquid testnet the
   configured pair is testnet L-BTC and TEST. The repayment includes principal and interest;
   interest is the displayed difference between repayment and principal.
4. Select **Review Offer**. Check units, amounts, counterparty, and the absolute expiry block.
   The relative block count is converted into an absolute height; the term does not restart
   when the lender accepts.
5. Select **Sign & Create Offer** and approve signing. Wait for confirmation and indexer discovery.
6. After acceptance, use **Claim Principal**. Acceptance locks the principal for you; it does
   not immediately turn it into an ordinary wallet balance.
7. Obtain enough of the repayment asset and testnet L-BTC for fees, then repay in full while
   sufficient time remains. Repayment returns the collateral and burns the borrower role token.

Claim principal before repayment. The app requires evidence of the claim because repayment
burns the role token needed to unlock an unclaimed principal. Partial repayments are unsupported.

To withdraw an unaccepted offer, use **Cancel Offer** and wait for confirmation. Cancellation
returns collateral, consumes both role tokens, and costs a transaction fee.

## Lend

1. Share your lending key and verify the borrower's fingerprint when reviewing an offer.
2. Fund your wallet with the principal asset and testnet L-BTC for fees.
3. Find the offer under **Lend: offers to you**. Review the collateral, principal, total repayment,
   counterparty, and remaining time. The app verifies the offer before enabling an action.
4. Select **Accept & Supply** and approve signing. Wait for confirmation and indexing.
5. If the borrower repays, use **Claim Repayment** to receive the repayment and consume the
   lender role token. A repaid loan is not fully claimed until this separate transaction completes.
6. If the loan remains unpaid past its expiry height, **Liquidate & Claim Collateral** becomes
   available. Liquidation consumes the lender role token and releases the collateral.

Liquidation depends on block height, not a price feed. The UI considers expiry passed when the
observed tip is strictly greater than the expiry height. Tip and indexer updates can lag.
A borrower can still claim previously unclaimed principal after liquidation if its principal
output remains unspent and the borrower retains the required role token.

## Expiry does not withdraw a pending offer

The current contract does not enforce an acceptance deadline or a minimum term after funding.
Although the app hides acceptance after expiry, a client outside this UI can accept an uncancelled
pending offer after expiry and then liquidate it without another borrower signature. It must
still supply the promised principal, which remains claimable by the borrower.

Cancel unwanted pending offers and confirm the cancellation. Submitting a cancellation alone
does not revoke the offer: acceptance and cancellation can race to spend the same outputs.
This known contract limitation remains unresolved in the demo. See the
[protocol notes](./protocol.md#expiry-and-review-status) for the review scope.

## Broadcast recovery

If signing succeeds but broadcast fails, the app saves the finalized transaction in this browser
and shows a saved-but-not-broadcast warning. **Broadcast Again** resends the same transaction
with the same transaction ID; it does not create or sign another loan.

Preserve the browser profile and its site data while a transaction needs recovery. A different
profile does not have that local retry record. Check the transaction ID in the explorer if the
network response was ambiguous: failure to receive a response does not prove rejection.

**Discard It** removes the local record; it does not revoke a signed transaction, cancel an offer,
or reverse a broadcast. Discard only when that transaction can no longer be mined, for example
because its inputs have already been spent. After a successful broadcast, allow confirmation and
indexing to finish before attempting another action.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Balances appear but offers do not | Confirm the network and wallet fingerprint, the recipient lending key, creation confirmation, and indexer progress. Separate profiles must use the intended distinct wallets. |
| Loading fails or requests are rate-limited | Let the upstream limit recover, then retry the scan. Repeated refreshes can add requests. Check the local indexer/API if running locally. Do not recreate an offer just because it is missing from the list. |
| Review is disabled despite sufficient balance | Wait for funding confirmation; check the number of separate confirmed coins, the fee reserve, and form validation. Refresh wallet balances after new funding. |
| A transaction remains processing | Check its transaction ID and allow the indexer to catch up. Keep the saved record until the outcome is known. |
| An offer fails verification | Do not accept or sign it. A directory match or displayed amount does not override verification failure. |
| Jade is absent from the device chooser | Check the USB data cable, power, browser support, and whether another app holds the device connection. |

The demo has completed several seed-wallet lifecycle and recovery scenarios, plus Jade creation
and lender acceptance. Exact Jade metadata/warning observations and other manual assertions
remain incomplete; this guide does not imply full release or security sign-off.
