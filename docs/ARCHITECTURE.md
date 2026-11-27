# Remiglo Architecture

This document describes the system as it stands. It was rewritten on
2026-11-27, after the pivot of 2026-11-25 moved Remiglo onto Nuvion as
its settlement foundation and retired the NEAR Intents rail the product
was first built on. Nothing in the status map is aspirational: if it
says built against a mock, it has not yet run against the live provider,
and it says so.

The detailed design record for the Nuvion integration (flows, status
mapping, the sharp edges and the open questions for Nuvion) is the
Nuvion integration map kept with the project's goal files. The original
architecture, adopted 2026-11-06 for the NEAR build, is preserved in
this repository's history and summarised in the README's project
history section.

## The system today

```
REMIGLO — Business payout operations

1. Developer API + SDK
   Merchants · Recipients · Payouts · Batches · Schedules · Webhooks

2. Operations core
   Store (SQLite) · Ledger · Policies and approvals · One transition path

3. Settlement foundation: Nuvion
   Child entities · Currency accounts · Counterparties · FX quotes · Transfers

4. Monitoring
   Sync loop · Inbound webhook receiver · Polling backstop

5. Business dashboard and accounting reports
```

### 1. Developer API + SDK

The product surface businesses integrate against. A merchant is created
with a name and an optional business profile (legal name, registration
number, country); creation returns an API key once, and only its hash
is stored. The address book holds recipients of three kinds: bank
accounts, mobile money wallets, and stablecoin wallets on the four
networks Nuvion carries. Payouts are created singly, in batches (JSON
rows or a raw CSV upload), from the dashboard, or by recurring
schedules, and every route runs through the same preparation and
validation code. Rows can carry the payer's own reference and a
certified breakdown (gross, retention, deductions), which the server
checks arithmetically before anything is created. The TypeScript SDK
lives in `sdk/` (package name `remiglo-sdk`): typed methods for
merchants, recipients, payouts, batches, schedules, reconciliation and
webhook endpoints, plus a verifyWebhookSignature helper.

**Webhook events.** invoice.paid, invoice.expired, invoice.refunded,
invoice.failed, payout.sent, payout.settled, payout.failed,
batch.completed, schedule.executed. The invoice events belong to the
retired rail (see Retired components). `payout.sent` fires exactly once
per payout, on its first transition into an in flight state.

### 2. Operations core

Everything Remiglo itself enforces lives here, in Remiglo's own code:
spending caps per payout, the batch approval threshold, dashboard roles
(owner, admin, operator, viewer) with operators unable to approve, and
the ledger that records every money event. There is no contract
enforced policy layer in the current product; the receipt for a payment
is the ledger entry plus the provider reference Nuvion returns.

All state lives in one SQLite database (WAL mode) at `REMIGLO_DB`. The
store (`src/lib/store.ts`) owns schema and migrations, which are
additive: a PRAGMA column check, then ALTER TABLE ADD COLUMN.

**One transition path.** Every payout status change, whatever triggered
it, goes through `applyPayoutTransition` in `src/services/poller.ts`:
the status write, the ledger entry, the merchant webhook emission and
batch completion are written in exactly one place, so a settlement
observed by webhook and one observed by polling are indistinguishable
in the record.

### 3. Settlement foundation: Nuvion

Nuvion carries the accounts, the currency conversion and the payout
rails. The client (`src/services/nuvion.ts`) is a typed interface with
a real fetch implementation and a deterministic mock, switched by
`NUVION_MOCK`, shaped deliberately like the older Intents client so the
rest of the system treats rails uniformly.

- **Entities.** Each merchant maps to a child entity on Nuvion.
  Creation is attempted at sign up and never blocks it: a failure
  leaves the merchant unlinked with a ledger entry, and
  `POST /v1/merchants/:id/nuvion/refresh` mirrors the entity status and,
  on approval, opens one account per configured currency
  (`NUVION_CURRENCIES`, default NGN and USD).
- **Recipients.** At creation, and on later edits that touch payment
  fields, a recipient is linked to a Nuvion counterparty and a payment
  detail (bank transfer, mobile money transfer or stablecoin transfer
  by kind); the ids are stored on the record. Link failure never blocks
  the address book.
- **Execution.** A payout bound to a bank, mobile money or network
  carrying wallet recipient executes at creation for a single payout,
  or at approval inside a batch. Execution picks the funding account
  (the payout currency's account when held, otherwise USD or the first
  account with an FX quote locked for the exact amount), then creates
  the transfer with the Remiglo payout id as its `unique_reference` and
  the payment reference as its narration. The payout record exists only
  once the transfer does.
- **Status mapping.** Nuvion's transfer statuses map onto Remiglo's in
  one function: new to sent, pending and processing to processing,
  successful to settled, failed to failed, cancelled to failed, and
  reversed to refunded. A transfer that fails never enters refunded;
  only a completed transfer later reversed does.
- **Amounts.** Remiglo counts in six decimal smallest units; Nuvion
  counts at two decimals. One conversion function owns the boundary,
  and a Nuvion bound amount that is not exact to the cent is refused at
  creation.
- **References.** A Nuvion `unique_reference` is single use per entity,
  forever, and a failed transfer still burns it. Remiglo therefore
  never reuses one: a retry is a fresh payout with a fresh id, and a
  payout that already carries a provider reference is never marked
  failed by a batch attempt failure, because its transfer may still be
  live and settle.

### 4. Monitoring

The sync loop (`POLL_SECONDS`) is how Remiglo knows what happened. It
runs the schedule runner, the legacy Intents pass, and a Nuvion pass.
The Nuvion pass first drains recorded inbound webhook events, then
polls every open Nuvion payout as a backstop.

The inbound receiver (`POST /webhooks/nuvion`) verifies the HMAC
SHA256 signature when `NUVION_WEBHOOK_SECRET` is configured, records
the event into the `nuvion_events` table, and answers. It applies
nothing inside the request. The sync loop treats each event as a
trigger and reads the transfer's current state from the API, because
Nuvion's own documentation advises exactly that, offers no replay, and
blacklists an endpoint that fails delivery three times in a rolling
24 hour window. The polling backstop means a lost or blacklisted
webhook delays a settlement by at most one cycle and never loses it.

### 5. Business dashboard and accounting reports

What the business sees, in the design language of
docs/DASHBOARD-DESIGN.md (light surface, deep navy, one accent, Inter):
Overview, Payments, Payouts, Recipients, Invoices, Schedules, Routing,
Reconciliation, Analytics, Developers, Settings. The Routing page shows
the merchant's Nuvion transfers and its account position (entity status
and one row per currency account). Settings carries the business
profile and the Nuvion link state. Reconciliation exports every payout
with its reference, breakdown, rail, fiat currency and amount, FX quote
id, provider reference and provider fee.

Dashboard accounts are separate from API keys: the first run setup
creates the owner, and every page requires a login from then on.
Passwords are scrypt hashed; session tokens are hashed in httpOnly
cookies.

## A Nuvion payout, end to end

1. An operator creates a payout (or a batch) against a saved recipient.
2. Validation runs: amounts, the pilot cap, the breakdown arithmetic,
   and the Nuvion bound checks (configured, linked, exact to the cent).
3. A batch over the approval threshold waits for an approver; a single
   payout executes at once.
4. Execution links the recipient if needed, locks an FX quote when the
   funding currency differs, and creates the Nuvion transfer.
5. The payout's first status lands through the one transition path, and
   `payout.sent` fires.
6. Settlement arrives by signed webhook or by the polling backstop;
   either way the same transition path writes the outcome, fires
   `payout.settled` or `payout.failed`, and completes the batch when
   its last row lands.
7. The row appears in the reconciliation export with its provider
   reference and fee, ready to match against the business's own books.

## Boundary rules

- **One payout, one rail, one owner.** A Nuvion bound row never touches
  the Intents quote path, and a legacy row never touches Nuvion. Which
  rail a row belongs to is decided once, from its recipient, at
  preparation time.
- **One transition path.** Status changes are written in one function.
  Nothing else in the codebase writes a payout status.
- **Amounts are smallest unit strings.** No floats anywhere near money.
  The only decimal conversion in the system is the fenced Nuvion
  boundary function.
- **Remiglo never holds merchant money.** Balances sit in the
  merchant's own accounts at the licensed partner. Remiglo's records
  are operational records, not custody.
- **Secrets live in environment variables only.** The example env file
  ships blank. API keys and webhook secrets are shown once at creation
  and stored hashed.

## Retired components

These remain in the repository as the record of the original build.
None of them is part of the current product direction, and reviving
any of them is a new decision, not a configuration change.

- **NEAR Intents rail** (`src/services/intents.ts`, the 1Click API):
  invoices, the hosted payment page at `/pay/:invoiceId`, and payouts
  to raw addresses or wallet recipients with no Nuvion network. Still
  functional against its mock and the live API. A merchant with no
  settlement asset configured cannot create invoices and is told so in
  plain words. Fiat invoicing is a later phase: bank inflows cannot yet
  be matched to invoices reliably.
- **Remiglo Registry contract** (`contracts/registry`, live on NEAR
  testnet at remiglo.testnet): merchant authorization, spending
  policies, batch records and audit events from the NEAR build. Batch
  anchoring (`src/services/registry.ts`) still runs when configured
  and is unconfigured by default.
- **Registry indexer** (`src/services/indexer.ts`): RPC polling of the
  contract's audit events into `registry_events`. Off by default.
- **Chain Signatures** (`src/services/chainSignatures.ts`): the NEAR
  controlled cross chain signing module, inert unless explicitly
  enabled with a key file. The original boundary rule stands in the
  code: it refuses any payment carrying an Intents deposit address.

## Status map, 2026-11-27

| Component | Exists today | Honest status |
|---|---|---|
| Developer API + SDK | Yes | Complete for the current scope: merchants with entity linking and business profiles, three recipient kinds, single and batch payouts with approvals and retries, schedules, signed outbound webhooks with retries and replay, reconciliation exports. 178 tests, all passing offline against the mocks. |
| Nuvion settlement | Built, not yet live verified | Client, entity linking, recipient linking, fiat and stablecoin execution, webhook receiver, polling backstop and reconciliation are built and tested against a deterministic mock written from Nuvion's public documentation. Live verification against the Nuvion sandbox is pending business registration, because Nuvion onboards businesses with verification from the first step. Known unproven points the sandbox run must settle: the entity creation body (name only today), counterparty and payment detail body shapes, the webhook envelope and signature header name, and the units of the provider fee field, which is stored verbatim. |
| Operations core | Yes | SQLite store with additive migrations, ledger, caps and approval threshold enforced in code, one transition path for all payout status changes. |
| Monitoring | Yes | Sync loop with schedule runner, Nuvion event drain plus polling backstop, and the legacy Intents pass. |
| Dashboard and reports | Yes | Full console with role based accounts, Nuvion transfers and account position on Routing, business profile and link state in Settings, and the extended reconciliation export. |
| NEAR Intents rail | Retired, in code | Invoices and the hosted payment page remain functional; not the product direction. |
| Registry, indexer, Chain Signatures | Retired, in code | Unconfigured or off by default; kept as the record of the NEAR build. |
