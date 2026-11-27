<p align="center"><img src="assets/remiglo-logo.png" alt="Remiglo" width="620"></p>

# Remiglo

A payout operations platform for businesses that pay contractors, teams and suppliers in batches. Remiglo runs the operations layer: recipients, batch payouts, approvals, spending policies, recurring schedules, webhooks and reconciliation. Settlement runs on [Nuvion](https://nuvion.co), which carries the accounts, currency conversion and the payout rails underneath.

One batch can pay a bank account in naira, a mobile money wallet in Ghana, and a stablecoin wallet on Base, under a single approval, with every row settling through the same lifecycle and landing in the same reconciliation file.

## How it works

- **Each business is its own entity.** A Remiglo merchant maps to a child entity on Nuvion, with its own verification, its own accounts and its own balances. Remiglo never holds merchant money at any point; the accounts are the merchant's own accounts at a licensed partner, and Remiglo is the operations layer on top.
- **Recipients are people, not addresses.** The address book holds three kinds of recipient: a bank account (bank name, account number, account name, country, currency), a mobile money wallet (provider, phone number, country, currency), and a stablecoin wallet (address and network). Stablecoin payouts reach Ethereum, Base, Polygon and Solana, in USDC, USDT and RLUSD (RLUSD on Ethereum only). A wallet on any other network is refused when the recipient is created, not at payout time.
- **Batches are approved before they move.** Rows are created by API, by CSV upload, from the dashboard, or by a recurring schedule. Batches over the approval threshold wait for a named approver. Spending policies cap single payouts and daily totals.
- **Execution is Nuvion transfers.** At execution, each row locks an FX quote if the funding account's currency differs from the payout currency, then creates a transfer carrying the Remiglo payout id as its single use reference and the payment reference as its narration. A failed row can be retried; a retry is a fresh payout with a fresh reference, linked to the failed one.
- **Settlement is watched two ways.** Nuvion's signed webhooks land on an inbound receiver, and a sync loop also polls every open transfer, so a lost webhook delays a settlement by one cycle at most and never loses it. Merchants receive one event language either way: `payout.sent`, `payout.settled`, `payout.failed`, `batch.completed`.
- **Amounts are exact.** Remiglo counts in six decimal smallest units; Nuvion counts at two decimals. Every Nuvion bound amount is validated to the cent at creation, and one conversion function owns the boundary.

## Status

The Nuvion build is complete and covered by the test suite (178 tests, mock clients for both rails). It is written against Nuvion's public documentation and a deterministic mock of their API. Live verification against the Nuvion sandbox is the remaining step before production use; it waits on business registration, because Nuvion onboards businesses with verification from the first step.

Remiglo began as a NEAR Intents product at NEAR Hackathon 2026. That rail is retired as the product direction; its code, the registry contract and the testnet proofs remain in this repository as the record of that build (see Project history below).

## 1. Install

Requires Node 24 (the store uses the built in `node:sqlite` module; there are no native dependencies to build).

```bash
npm install
cp .env.example .env   # every value starts blank, fill in only what you need
```

## 2. Run in mock mode (offline, no funds, no keys)

Mock mode swaps both live clients for deterministic fakes. The Nuvion mock approves entities on first poll, opens accounts, and progresses transfers from pending to successful one step per sync. The Intents mock covers the legacy invoice flow.

```bash
INTENTS_MOCK=1 NUVION_MOCK=1 PORT=8400 npm run dev
```

In another terminal:

```bash
curl http://127.0.0.1:8400/health

# Create a merchant (the API key is returned once; only its hash is stored).
# A name is all sign up needs: creation also creates the merchant's Nuvion
# child entity, and the refresh call below opens its currency accounts.
# Optional business profile fields (legalName, registrationNumber, country)
# are stored on the merchant record. The settlement fields of the retired
# NEAR rail (settlementAsset, settlementAddress, refundTo) remain accepted
# for merchants that still use the legacy invoice flow; a settlement asset,
# when given, must be a known asset.
curl -X POST http://127.0.0.1:8400/v1/merchants -H 'content-type: application/json' -d '{
  "name": "Demo Business"
}'
# -> { "merchant": {...}, "apiKey": "rgl_live_..." }
export KEY=rgl_live_...
export MERCHANT_ID=mch_...   # the merchant id from the response
```

Link the merchant to its Nuvion entity and open its currency accounts (in mock mode the entity approves on this first refresh; accounts open for the currencies in `NUVION_CURRENCIES`, default NGN and USD):

```bash
curl -X POST http://127.0.0.1:8400/v1/merchants/$MERCHANT_ID/nuvion/refresh \
  -H "authorization: Bearer $KEY"
```

## 3. Dashboard setup

Open `http://127.0.0.1:8400/dashboard`. With no dashboard accounts yet, it redirects to a first run setup page: pick the merchant and create the **owner** account. From that moment every dashboard page requires a login (the API keeps using API keys, unchanged). Roles: owner and admin can approve batches and manage settings; admin and owner manage the team, and only the owner changes roles or deactivates members; operators create but cannot approve; viewers are read only. Settings shows each merchant's Nuvion link state, entity status and currency accounts, and the Routing page shows its Nuvion transfers.

## 4. Pay a person: recipient, payout, settlement

Add a bank recipient:

```bash
curl -X POST http://127.0.0.1:8400/v1/recipients -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
  "kind": "bank", "label": "Yusuf Bello", "bankName": "GTBank",
  "accountNumber": "0123456789", "accountName": "Yusuf Bello",
  "country": "NG", "currency": "NGN"
}'
# -> { "id": "rcp_...", "kind": "bank", ... }
export RECIPIENT_ID=rcp_...
```

Because the merchant is linked, the recipient's Nuvion counterparty and bank payment detail are created at the same moment and their ids stored on the record.

Send the payout. Amounts are smallest unit strings at six decimals, so NGN 50 is `50000000` (the default pilot cap is 100 per payout in the same units; raise `PILOT_MAX_PAYOUT_UNITS` when you mean larger amounts). A payout to a bank or mobile money recipient executes through Nuvion at creation:

```bash
curl -X POST http://127.0.0.1:8400/v1/payouts -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d "{\"recipientId\": \"$RECIPIENT_ID\", \"amount\": \"50000000\", \"reference\": \"SALARY-NOV\"}"
# -> the payout carries "providerRef" (the Nuvion transfer id) and a live status
```

Advance settlement one sync cycle per call in mock mode (in live mode the poller and Nuvion's webhooks do this on their own):

```bash
curl -X POST http://127.0.0.1:8400/v1/internal/sync
```

Then read the reconciliation export. Every payout row carries its reference and breakdown, plus the rail, the fiat currency and amount, the FX quote id when conversion happened, the provider reference and the provider fee:

```bash
curl http://127.0.0.1:8400/v1/reconciliation/payouts.csv -H "authorization: Bearer $KEY"
```

## 5. Upload a CSV batch

A batch is created from JSON rows, or from a raw CSV body (no multipart needed):

```bash
curl -X POST http://127.0.0.1:8400/v1/payout-batches -H "authorization: Bearer $KEY" \
  -H 'content-type: text/csv' --data-binary @batch.csv
```

Every row is validated before anything is created: one bad row returns per row errors with line numbers and creates nothing. Batches over the approval threshold (default 500 USDC in smallest units) wait in `pending_approval` until `POST /v1/payout-batches/:id/approve`, and rows execute through Nuvion at approval. Rows can reference a saved recipient with `recipient_id,amount_units` headers, which is how bank, mobile money and wallet recipients are paid in one batch; recipients are managed at `/v1/recipients` and on the dashboard Recipients page.

A payout row can carry the payer's own reference and a certified breakdown, in JSON (`reference`, `grossAmount`, `retentionAmount`, `deductionsAmount`) or as trailing CSV columns (`reference,gross_amount_units,retention_amount_units,deductions_amount_units`, in that order). The amount on the row is the net that moves; when a gross amount is given, the server checks that net equals gross minus retention minus deductions and rejects the row when it does not. The reference and all four figures are stored on the payout, shown on the batch page, included in payout webhooks, and exported per payout at `GET /v1/reconciliation/payouts.csv`, so a payment can be matched back to its approved invoice, retention and deductions without a spreadsheet.

## 6. Create a recurring schedule

```bash
curl -X POST http://127.0.0.1:8400/v1/schedules -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"kind": "batch", "cadence": "monthly", "dayOfMonth": 1,
       "payload": {"rows": [{"recipientId": "rcp_...", "amount": "50000000"}]}}'
```

Cadences: weekly (every 7 days), biweekly (every 14 days), monthly (same day of month, clamped to the 28th). The sync loop ticks due schedules, creates the invoice or batch through the same code paths as the API, records the run, and fires a `schedule.executed` webhook. A double tick never double creates: the idempotency key is derived from the schedule id and the occurrence time. Pause and resume with `POST /v1/schedules/:id/pause` and `/resume`, or from the dashboard Schedules page.

## 7. Invoices

Invoices and the hosted payment page at `/pay/:invoiceId` belong to the retired NEAR Intents rail and remain available for that flow. They need a settlement asset on the merchant: a merchant created with a name alone has none, and invoice creation for it answers a clear 400 rather than quoting against nothing. Fiat invoicing is a later phase: bank inflows cannot yet be matched to invoices reliably, so the current product is payouts first. Nothing in the payout, batch or reconciliation flows depends on invoices.

## 8. Use the SDK

```bash
cd sdk && npm run build
```

```ts
import { Remiglo, verifyWebhookSignature } from "remiglo-sdk";

const remiglo = new Remiglo({ baseUrl: "http://127.0.0.1:8400", apiKey: process.env.REMIGLO_API_KEY! });
const payout = await remiglo.createPayout({ recipientId: "rcp_...", amount: "50000000", reference: "SALARY-NOV" });
console.log(payout.providerRef, payout.status);

// In your webhook handler:
const ok = verifyWebhookSignature(secret, rawBody, req.headers["x-remiglo-signature"]);
```

See [sdk/README.md](sdk/README.md) for the full method list.

## 9. Run the tests

The whole suite runs offline in mock mode (178 tests), plus the Rust contract tests for the historical registry.

```bash
npm run typecheck
npm test
cd contracts/registry && cargo test   # 8 Rust unit tests
```

## 10. Run against Nuvion

Sandbox access is self serve: create an account at `app.nuvion.dev`, then create a key in the sandbox dashboard settings. Set in `.env`:

```bash
NUVION_API_KEY=<your sandbox key>
NUVION_BASE_URL=https://api.nuvion.dev   # production is https://api.nuvion.co, keys issued after onboarding
NUVION_WEBHOOK_SECRET=<the secret you register for the inbound receiver>
ADMIN_TOKEN=<protects merchant creation>
PORT=8400 npm run dev
```

Leave `NUVION_MOCK` unset. Register the inbound webhook URL (`POST /webhooks/nuvion` on your public address) with Nuvion per entity so outflow events arrive; the sync loop polls open transfers as a backstop either way.

Safety rails: `PILOT_MAX_PAYOUT_UNITS` caps every payout (default 100000000), batches over `APPROVAL_THRESHOLD_UNITS` (default 500000000) wait for an explicit approve call, and a Nuvion transfer moves real money in production. Keep pilot amounts small.

## API surface

- Merchants: `POST /v1/merchants` (admin token when `ADMIN_TOKEN` is set; API key returned once; only `name` is required, with optional business profile and legacy settlement fields), `GET /v1/merchants/me`, `POST /v1/merchants/:id/nuvion/refresh` (mirrors the entity status; opens currency accounts on approval).
- Recipients: `POST|GET /v1/recipients`, `GET|PATCH|DELETE /v1/recipients/:id`. Kinds: `bank`, `momo`, `wallet`.
- Payouts: `POST|GET /v1/payouts`, `GET /v1/payouts/:id`, `POST /v1/payouts/:id/retry` (a failed payout only; the retry is a fresh payout with a fresh reference, linked to the failed one).
- Batches: `POST|GET /v1/payout-batches` (JSON rows or raw `text/csv`), `GET /v1/payout-batches/:id`, `POST /v1/payout-batches/:id/approve`.
- Invoices (legacy rail): `POST|GET /v1/invoices`, `GET /v1/invoices/:id`, `POST /v1/invoices/:id/cancel`, public page `GET /pay/:invoiceId`.
- Schedules: `POST|GET /v1/schedules`, `GET /v1/schedules/:id` (includes runs), `PATCH`, `POST /:id/pause`, `POST /:id/resume`, `DELETE`.
- Webhooks out: `POST|GET /v1/webhook-endpoints` (secret returned once), `GET /v1/webhook-deliveries`, `POST /v1/webhook-deliveries/:id/replay`. Deliveries are HMAC SHA256 signed in the `x-remiglo-signature` header, retried up to 5 times with doubling backoff.
- Webhooks in: `POST /webhooks/nuvion` (Nuvion outflow events; HMAC SHA256 verified when `NUVION_WEBHOOK_SECRET` is set; events are recorded and applied by the sync loop, never inside the request).
- Reconciliation: `GET /v1/ledger`, `GET /v1/reconciliation/daily`, `GET /v1/reconciliation/export.csv` (per invoice), `GET /v1/reconciliation/payouts.csv` (per payout, with reference, gross, retention, deductions, net, rail, fiat currency and amount, FX quote id, provider reference and provider fee).
- Internal: `POST /v1/internal/sync` (one sync cycle), `GET /v1/internal/indexer/status`. Localhost or admin token only.
- Pages: `GET /dashboard` (login required after setup), `GET /health`.

Events: invoice.paid, invoice.expired, invoice.refunded, invoice.failed, payout.sent, payout.settled, payout.failed, batch.completed, schedule.executed. `payout.sent` fires exactly once per payout, on its first transition into an in flight state.

## Data

SQLite at `REMIGLO_DB`, default `./data/remiglo.db`. Tables include merchants (with their Nuvion entity link and currency accounts), api_keys (hashes only), recipients (with kind, rail details and Nuvion counterparty link), payouts (with reference, breakdown, provider reference, fiat amount, FX quote id and provider fee), payout_batches, invoices, schedules and schedule_runs, ledger_entries, webhook_endpoints, webhook_deliveries, nuvion_events (recorded inbound events), dash_users and dash_sessions (password and token hashes only), registry_events and indexer_state. Amounts are always smallest unit strings, never floats. Real keys live only in environment variables; the example env file ships blank.

## Project history

Remiglo was first built at NEAR Hackathon 2026 (1 to 14 November 2026) as a stablecoin payout product on NEAR Intents, and pivoted to Nuvion on 25 November 2026. The NEAR build's proofs stand:

- Registry contract: **remiglo.testnet** on NEAR testnet — [account on NearBlocks](https://testnet.nearblocks.io/address/remiglo.testnet)
- Account created through the testnet registrar: [91yctYgjBfDrUMnnNQALKCXxzAXBiHqedxJ7o3sV4qES](https://testnet.nearblocks.io/txns/91yctYgjBfDrUMnnNQALKCXxzAXBiHqedxJ7o3sV4qES)
- Deploy transaction: [EtFtcY6KDVNJXpTiqo96h1P6nDBMRc3UETCguR6dKobB](https://testnet.nearblocks.io/txns/EtFtcY6KDVNJXpTiqo96h1P6nDBMRc3UETCguR6dKobB)
- Demo merchant registration (remiglo.testnet as its own first merchant): [AdUkb1ecJTbJxzrhaGsvve82maAxgWNoFefBZn3s87oY](https://testnet.nearblocks.io/txns/AdUkb1ecJTbJxzrhaGsvve82maAxgWNoFefBZn3s87oY)
- Demo batch record (`batch_demo_001`, 6 rows, 540 USDC): [AwffpTYN8yg1WntoF5nkJzkaC4BYkQb82grRd649bHN4](https://testnet.nearblocks.io/txns/AwffpTYN8yg1WntoF5nkJzkaC4BYkQb82grRd649bHN4)

On 12 November 2026 the full NEAR money flow ran on testnet against the real Intents verifier, through Tidepool, a community built testnet copy of the 1Click API (not official; test tokens only, but the verifier underneath is real Intents code). An invoice for 2 USDC settled as exactly 1.995824 USDT with the balance verified on chain; a two row batch of 1.0 and 1.4 USDC settled in full and completed; five signed webhooks were delivered; the batch was anchored into the registry: [9wfUv8KtcnC43MiwMZj8PU1umLZ7Rh8aWhTBAzicGsZo](https://testnet.nearblocks.io/txns/9wfUv8KtcnC43MiwMZj8PU1umLZ7Rh8aWhTBAzicGsZo).

The registry contract source is in `contracts/registry` and still builds (`./scripts/build-contract.sh`). When `REGISTRY_CONTRACT_ID`, `REGISTRY_KEY_FILE` and `REGISTRY_MERCHANT_ACCOUNT` are set, the API can still anchor batches into it; the indexer (`INDEXER_SECONDS`, off by default) stores its audit events into `registry_events`. Chain Signatures stays inert unless `CHAIN_SIG_ENABLED=1` with `CHAIN_SIG_KEY_FILE` set. The current architecture is described in `docs/ARCHITECTURE.md`; the Nuvion integration map is its detailed design record.
