# remiglo-sdk

Typed TypeScript client for the Remiglo payments API. No runtime
dependencies beyond the platform `fetch` (Node 18+; `node:crypto` is
used for webhook signature verification).

## Build

From the repository root (the SDK uses the root TypeScript install):

```bash
npm --prefix sdk run build   # emits sdk/dist
```

## Cold start

```ts
import { Remiglo, RemigloError, verifyWebhookSignature } from "remiglo-sdk";

const remiglo = new Remiglo({
  baseUrl: "http://127.0.0.1:8400",       // your Remiglo server
  apiKey: "rgl_live_...",                  // merchant API key, shown once at merchant creation
});

// Create an invoice and share its hosted payment page.
const invoice = await remiglo.createInvoice(
  { amount: "10000000", externalRef: "order-1" },   // 10.00 USDC in smallest units
  { idempotencyKey: "order-1" }
);
console.log(invoice.paymentUrl);          // /pay/<id> on your server
console.log(invoice.payment?.depositAddress);

// Pay a saved recipient.
const ada = await remiglo.createRecipient({
  label: "Ada the designer", address: "ada.near",
  assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
});
const payout = await remiglo.createPayout({ recipientId: ada.id, amount: "25000000" });

// Or a whole batch from CSV text.
const batch = await remiglo.createBatchFromCsv(
  "recipient_address,destination_asset,amount_units\n" +
  "ada.near,nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1,10000000\n"
);
if (batch.status === "pending_approval") await remiglo.approveBatch(batch.id);

// Verify a webhook in your receiver (Express style handler):
//   const ok = verifyWebhookSignature(secret, rawBody, req.headers["x-remiglo-signature"]);

// Errors are typed:
try { await remiglo.getInvoice("inv_nope"); }
catch (err) { if (err instanceof RemigloError) console.error(err.status, err.message); }
```

Amounts are always smallest unit strings (for example `"10000000"` is
10.00 USDC at 6 decimals). Full method list: invoices
(create/get/list/cancel), payouts (create/get/list), payout batches
(create, create from CSV, get, list, approve), recipients CRUD,
schedules CRUD with pause/resume, reconciliation (daily summary, CSV
export, ledger), webhook endpoints and deliveries.
