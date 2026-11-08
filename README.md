# Remiglo

A payment API for businesses to accept stablecoins, pay contractors, distribute funds and reconcile transactions across multiple chains, built on NEAR Intents.

Remiglo is built as six layers (full map in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

1. **Developer API + SDK** — invoices, batch payouts, recipients, schedules, webhooks, reconciliation, plus a TypeScript SDK in `sdk/`.
2. **NEAR Smart Contracts** — the Remiglo Registry: merchant authorization, spending policies, batch records, audit events. Live on NEAR testnet (see below).
3. **NEAR Intents** — cross chain routing and settlement through the 1Click API.
4. **Chain Signatures** — NEAR controlled cross chain signing for the treasury case only, behind a hard boundary rule (it can never sign for an Intents managed payment).
5. **Payment monitoring and indexing** — a poller for Intents statuses, and an RPC indexer for registry events.
6. **Business dashboard** — a full operations console with accounts, roles and permissions.

## Non custodial by design

The business funds each payout from its own wallet to a per payment deposit address given by NEAR Intents 1Click. This service never pools business funds.

## 1. Install

Requires Node 24 (the store uses the built in `node:sqlite` module; there are no native dependencies to build).

```bash
npm install
cp .env.example .env   # every value starts blank, fill in only what you need
```

## 2. Run in mock mode (offline, no funds, no keys)

Mock mode swaps the live 1Click client for a deterministic fake: fake deposit addresses, and a status progression of deposit seen, processing, success, one step per poll.

```bash
INTENTS_MOCK=1 PORT=8400 npm run dev
```

In another terminal:

```bash
curl http://127.0.0.1:8400/health

# Create a merchant (the API key is returned once; only its hash is stored)
curl -X POST http://127.0.0.1:8400/v1/merchants -H 'content-type: application/json' -d '{
  "name": "Demo Business",
  "settlementAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "settlementAddress": "demo.near",
  "refundTo": "demo.near"
}'
# -> { "merchant": {...}, "apiKey": "rgl_live_..." }
export KEY=rgl_live_...
```

## 3. Dashboard setup

Open `http://127.0.0.1:8400/dashboard`. With no dashboard accounts yet, it redirects to a first run setup page: pick the merchant and create the **owner** account. From that moment every dashboard page requires a login (the API keeps using API keys, unchanged). Roles: owner and admin can approve batches and manage settings; admin and owner manage the team, and only the owner changes roles or deactivates members; operators create but cannot approve; viewers are read only.

## 4. Create an invoice and open its payment page

```bash
curl -X POST http://127.0.0.1:8400/v1/invoices -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -H 'idempotency-key: order-1' \
  -d '{"amount": "10000000", "externalRef": "ORDER-1"}'
# -> includes "paymentUrl": "/pay/inv_..."

# Advance settlement one step per call in mock mode
curl -X POST http://127.0.0.1:8400/v1/internal/sync
```

Open the payment URL in a browser: it shows the deposit address, a QR code, the amount in plain words and a live status that polls until the invoice is paid.

## 5. Send a payout

```bash
curl -X POST http://127.0.0.1:8400/v1/payouts -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"recipientAddress": "ada.near", "destinationAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "amount": "25000000"}'
```

## 6. Upload a CSV batch

A batch is created from JSON rows, or from a raw CSV body (no multipart needed):

```bash
curl -X POST http://127.0.0.1:8400/v1/payout-batches -H "authorization: Bearer $KEY" \
  -H 'content-type: text/csv' --data-binary @batch.csv
```

with `batch.csv` shaped like:

```csv
recipient_address,destination_asset,amount_units,reference
ada.near,nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1,10000000,payroll-oct
```

Every row is validated before anything is created: one bad row returns per row errors with line numbers and creates nothing. Batches over the approval threshold (default 500 USDC) wait in `pending_approval` until `POST /v1/payout-batches/:id/approve`. Rows can also reference a saved recipient with `recipient_id,amount_units` headers, and recipients are managed at `/v1/recipients` (the dashboard Recipients page is the same address book).

## 7. Create a recurring schedule

```bash
curl -X POST http://127.0.0.1:8400/v1/schedules -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"kind": "invoice", "cadence": "monthly", "dayOfMonth": 1,
       "payload": {"amount": "50000000", "externalRef": "RETAINER"}}'
```

Cadences: weekly (every 7 days), biweekly (every 14 days), monthly (same day of month, clamped to the 28th). The poller ticks due schedules, creates the invoice or batch through the same code paths as the API, records the run, and fires a `schedule.executed` webhook. A double tick never double creates: the idempotency key is derived from the schedule id and the occurrence time. Pause and resume with `POST /v1/schedules/:id/pause` and `/resume`, or from the dashboard Schedules page.

## 8. Use the SDK

```bash
cd sdk && npm run build
```

```ts
import { Remiglo, verifyWebhookSignature } from "remiglo-sdk";

const remiglo = new Remiglo({ baseUrl: "http://127.0.0.1:8400", apiKey: process.env.REMIGLO_API_KEY! });
const invoice = await remiglo.createInvoice({ amount: "10000000", externalRef: "ORDER-1" }, { idempotencyKey: "order-1" });
console.log(invoice.paymentUrl);

// In your webhook handler:
const ok = verifyWebhookSignature(secret, rawBody, req.headers["x-remiglo-signature"]);
```

See [sdk/README.md](sdk/README.md) for the full method list.

## 9. Run the tests

The whole suite runs offline in mock mode (90+ tests), plus the Rust contract tests.

```bash
npm run typecheck
npm test
cd contracts/registry && cargo test   # 8 Rust unit tests
```

## 10. Run in live mode

Live mode talks to the real NEAR Intents 1Click API on mainnet. There is no Intents testnet.

```bash
# In .env set ONECLICK_API_KEY (partner key from partners.near-intents.org, needed for the fee split)
# and ADMIN_TOKEN (protects merchant creation). Leave INTENTS_MOCK unset.
PORT=8400 npm run dev
```

Safety rails in live mode: `PILOT_MAX_PAYOUT_UNITS` caps every payout (default 100000000, which is 100 USDC), batches over `APPROVAL_THRESHOLD_UNITS` (default 500 USDC) wait for an explicit approve call, and a live quote creates a real deposit address. Keep pilot amounts small.

## The registry contract (testnet proof)

- Contract: **remiglo.testnet** on NEAR testnet — [account on NearBlocks](https://testnet.nearblocks.io/address/remiglo.testnet)
- Account created through the testnet registrar: [91yctYgjBfDrUMnnNQALKCXxzAXBiHqedxJ7o3sV4qES](https://testnet.nearblocks.io/txns/91yctYgjBfDrUMnnNQALKCXxzAXBiHqedxJ7o3sV4qES)
- Deploy transaction: [EtFtcY6KDVNJXpTiqo96h1P6nDBMRc3UETCguR6dKobB](https://testnet.nearblocks.io/txns/EtFtcY6KDVNJXpTiqo96h1P6nDBMRc3UETCguR6dKobB)
- Demo merchant registration (remiglo.testnet as its own first merchant): [AdUkb1ecJTbJxzrhaGsvve82maAxgWNoFefBZn3s87oY](https://testnet.nearblocks.io/txns/AdUkb1ecJTbJxzrhaGsvve82maAxgWNoFefBZn3s87oY)
- Demo batch record (`batch_demo_001`, 6 rows, 540 USDC): [AwffpTYN8yg1WntoF5nkJzkaC4BYkQb82grRd649bHN4](https://testnet.nearblocks.io/txns/AwffpTYN8yg1WntoF5nkJzkaC4BYkQb82grRd649bHN4)

Build and redeploy:

```bash
./scripts/build-contract.sh   # RUSTFLAGS="--cfg near" cargo build, wasm target
npx tsx scripts/deploy-registry-toplevel.ts
```

When `REGISTRY_CONTRACT_ID`, `REGISTRY_KEY_FILE` and `REGISTRY_MERCHANT_ACCOUNT` are set, the API anchors every live batch into the contract asynchronously and stores `anchorStatus` and `anchorTxHash` on the batch row. `scripts/anchor-batch.ts <batch.json>` anchors one batch in the foreground. The indexer (`INDEXER_SECONDS`, off by default) stores the contract's audit events into `registry_events`; check `GET /v1/internal/indexer/status`.

Chain Signatures stays inert unless `CHAIN_SIG_ENABLED=1` with `CHAIN_SIG_KEY_FILE` set; see the boundary rule in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## API surface

- Merchants: `POST /v1/merchants` (admin token when `ADMIN_TOKEN` is set; API key returned once).
- Invoices: `POST|GET /v1/invoices`, `GET /v1/invoices/:id`, `POST /v1/invoices/:id/cancel`. Send an `Idempotency-Key` header to make creation safe to retry.
- Payouts: `POST|GET /v1/payouts`, `GET /v1/payouts/:id`.
- Batches: `POST|GET /v1/payout-batches` (JSON rows or raw `text/csv`), `GET /v1/payout-batches/:id`, `POST /v1/payout-batches/:id/approve`.
- Recipients: `POST|GET /v1/recipients`, `GET|PATCH|DELETE /v1/recipients/:id`.
- Schedules: `POST|GET /v1/schedules`, `GET /v1/schedules/:id` (includes runs), `PATCH`, `POST /:id/pause`, `POST /:id/resume`, `DELETE`.
- Webhooks: `POST|GET /v1/webhook-endpoints` (secret returned once), `GET /v1/webhook-deliveries`, `POST /v1/webhook-deliveries/:id/replay`. Deliveries are HMAC SHA256 signed in the `x-remiglo-signature` header, retried up to 5 times with doubling backoff.
- Reconciliation: `GET /v1/ledger`, `GET /v1/reconciliation/daily`, `GET /v1/reconciliation/export.csv`.
- Internal: `POST /v1/internal/sync` (one poller cycle), `GET /v1/internal/indexer/status`. Localhost or admin token only.
- Pages: `GET /dashboard` (login required after setup), `GET /pay/:invoiceId` (public payment page), `GET /health`.

Events: invoice.paid, invoice.expired, invoice.refunded, invoice.failed, payout.sent, payout.settled, payout.failed, batch.completed, schedule.executed. `payout.sent` fires exactly once per payout, on the first transition out of the awaiting states into funded or processing.

## Data

SQLite at `REMIGLO_DB`, default `./data/remiglo.db`. Tables include merchants, api_keys (hashes only), invoices, payouts, payout_batches (with anchor columns), recipients, schedules and schedule_runs, ledger_entries, webhook_endpoints, webhook_deliveries, dash_users and dash_sessions (password and token hashes only), registry_events and indexer_state. Amounts are always smallest unit strings, never floats. Keys for NEAR accounts live only in `keys/` (gitignored) and in environment variables; the example env file ships blank.
