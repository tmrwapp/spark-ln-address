# General Lightning receiving through Orchestra quotes

## Decision and scope

Flashnet requested that general Lightning receiving use `/v1/orchestration/quote`
to distinguish it from dedicated Cash App onramps. This is a source-flow separation,
not proof that `/onramp` caused the reported Strike rejection. The public onramp
page still mentions both Cash App and Strike as of September 25, 2026.

`username@guap.to` does not identify the payer app. When `USDB_ENABLED=true` and the
recipient prefers USDB, this service now quotes `lightning:BTC` to `spark:USDB`,
exact-in, for the requested whole-satoshi amount. It never guesses the payer app.
SATS receiving and the existing fallback to a direct Spark invoice remain intact.
The callback response remains `{ pr, routes: [] }`.

## Application parity and other repositories

- RN `origin/develop`: `589177f60b6333cadf876accebf61032004d797a`.
  `apps/guap/src/screens/CashBalance/BitcoinWalletsBranch/index.tsx` routes Strike
  to `LightningAddressAddMoney`; `screens/LightningAddress` presents the shared
  Guap Lightning address. `packages/lightning-address` uses `https://guap.to`.
- Swift `origin/main`: `fe4bb2f903b1d918f8099b555e140d86887b01ac`.
  `BitcoinWalletsPicker` passes the same address to the Strike route;
  `BitcoinFundingModel.provision` presents it without calling Orchestra.
- `orchestra-backend` `origin/main`: `914061f60c5a9e50b75ac8bbdf35c3200623bc8c` (verified September 25, 2026).
  Its ordinary quote client already calls `/v1/orchestration/quote`; there is no
  `/onramp` caller to change. Its dedicated Cash App pay-link flow is separate.

One deployment of **spark-ln-address** therefore changes address-based receiving
for both released RN and Swift apps. No client update or Orchestra backend change
is required for this endpoint correction. Dedicated Cash App, New York, cash-out,
and direct in-app Spark invoice flows are not changed.

## Quote and settlement safeguards

1. Request exact-in BTC sats, never fiat, exact-out, or an amountless invoice.
2. Validate returned source amount, mainnet BOLT11 amount, checksum, required
   fields, ECDSA signature, quote expiry and invoice expiry before returning it.
   The persisted expiry is the earlier of the quote and signed invoice expiry.
3. Persist the invoice, quote ID and receive-request ID atomically. The order ID
   is null until funding; no fabricated order ID or client submission call.
4. Authenticate webhooks with existing HMAC handling. Bind a new order by its
   stored quote ID; reject conflicting quote IDs. Serialize state updates.
5. Reconcile by authenticated `/order?quoteId=...` lookup. A null order means
   awaiting payment. Terminal snapshots may follow missed intermediate events;
   stale events never reopen terminal payments.
6. Poll active orders and recent quotes separately from abandoned invoices.
   Recently expired invoices remain prioritized for six hours. Older unpaid
   quotes remain eligible for slower late-settlement checks, without blocking
   current payments. No quote is deleted merely because its invoice expired.
7. Keep failed payments and recovery holds visible to the existing operations
   recovery queue. Polling also detects `pending_review` / `blocked_wallet` holds.
   A recovery event cannot open a new case after terminal settlement.

## Refund contract and limitation

Do not carry over the old assumption that a recipient Spark address is a valid
Lightning refund target. `/onramp` explicitly accepts a Lightning address or
amountless BOLT11 and reports other values as ignored. `/quote` describes a
source-chain refund target, and its public contract does not establish that a
Spark recipient address is a supported override for this Lightning source.

This exact-in, Lightning-source, Spark-destination quote does not require a
refund address. The implementation omits it because LNURL does not provide the
payer's return address. **Omitting it does not guarantee an automatic refund.**
Flashnet documents possible manual recovery without a valid target. Never infer
that the recipient's own `@guap.to` address is the payer's refund address; that
would also enter this same conversion flow again.

Operations cases are review records, not instructions to automatically pay the
full invoice amount. Operators must verify funding, actual loss, and whether
Flashnet already refunded before resolving a case. Automatic payer refunds need
an explicit valid return destination and a separately verified provider contract.

## Deployment and verification

No database migration or new dependency. Existing nullable `quoteId` and `orderId`
columns support quote-first tracking. Retain the existing Flashnet API key and
HMAC webhook configuration; configure recovery webhooks if desired. The polling
worker runs when a real API key is configured, including when new USDB receiving
is disabled so existing quotes continue to reconcile. Production must use the real
API key; the repository's existing no-key mock is for test environments only.

Before production rollout, deploy to a test environment and verify Flashnet's
live `/quote` response matches the documented contract. No real payment or new
provider invoice was created during implementation. Test a payment only through
the team's authorized payment-testing process.

Automated checks (Node 20.20.1): 318 tests across 19 Jest suites; Nest build; one offline signed-invoice
crypto integration test; ESLint for all changed TypeScript files; `git diff --check`. Tests mock provider
calls and persistence. Docker was unavailable, so MySQL integration / concurrency
and live Strike settlement have not been verified.

## References

- https://docs.flashnet.xyz/llms.txt
- https://docs.flashnet.xyz/orchestra/quotes
- https://docs.flashnet.xyz/orchestra/onramp
- https://docs.flashnet.xyz/orchestra/status#refunds
- https://docs.flashnet.xyz/api-reference/orchestration/create-quote
- https://docs.flashnet.xyz/api/webhook-events
- https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
