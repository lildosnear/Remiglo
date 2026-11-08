# Remiglo Architecture

Adopted by Desmond on 2026-11-06. This is the stack Remiglo is actually
being built on, layer by layer, with an honest status for each layer
today. Nothing in the status map is aspirational: if it says not built,
it does not exist yet.

## The six layers

```
REMIGLO — Business Payments Infrastructure

1. Developer API + SDK
   Invoices · Batch payouts · Webhooks · Scheduling

2. NEAR Smart Contracts
   Authorization · Spending policies · Batch records · Audit events

3. NEAR Intents
   Cross-chain routing and settlement

4. Chain Signatures
   Cross-chain signing where needed

5. Payment monitoring and indexing
   QueryAPI · NEAR RPC · 1Click status tracking · Database

6. Business dashboard and accounting reports
```

### 1. Developer API + SDK
The product surface businesses integrate against. Merchants create
invoices, run batch payouts, receive signed webhooks for every status
change, and set up recurring schedules for payroll, retainers and
contributor payouts. A hosted payment page hangs off this layer so a
merchant can share a link instead of integrating. The TypeScript SDK
lives in `sdk/` (package name `remiglo-sdk`): typed methods for
invoices, payouts, batches (including a CSV string helper), recipients,
schedules, reconciliation and webhook endpoints, plus a
verifyWebhookSignature helper.

**Webhook events.** invoice.paid, invoice.expired, invoice.refunded,
invoice.failed, payout.sent, payout.settled, payout.failed,
batch.completed, schedule.executed. `payout.sent` fires exactly once
per payout, on the first transition out of the awaiting states
(awaiting_funding, quoted) into funded or processing; later moves
(for example funded to processing) do not fire it again.

### 2. NEAR Smart Contracts
The trust layer for anything that must be enforced rather than
promised: authorization of who may act for a business, spending
policies (caps, thresholds, approvals), on chain batch records, and
audit events that a third party can verify without trusting Remiglo's
database. Built: the Remiglo Registry contract
(`contracts/registry`, near-sdk 5.29.1) holds owner and merchant
authorization, per merchant spending policies with a check_spend
enforcement helper, batch records anchored by payload hash, payout
anchors counted against the daily budget, and NEP-297 style
EVENT_JSON audit logs. It is live on NEAR testnet at
**remiglo.testnet** (top level account, created through the testnet registrar). An earlier first deployment sat on a subaccount of another project; Desmond corrected that the same day, the contract was redeployed to remiglo.testnet, and the subaccount was deleted.
The API anchors every live batch into it, fire and forget, and stores
the anchor transaction hash on the batch row.

### 3. NEAR Intents
All cross chain routing and settlement. Remiglo speaks to Intents
through the 1Click API: one quote, one deposit address per payment,
solvers compete to fulfil, settlement lands in the asset and on the
chain the recipient chose. Remiglo does not run its own bridges, pools
or routing.

### 4. Chain Signatures
NEAR controlled accounts that can sign transactions on foreign chains
through the NEAR MPC network. This is a scalpel, not a second engine:
it exists for the specific moments where Remiglo itself must produce a
signature on another chain and no Intents flow covers that act.

### 5. Payment monitoring and indexing
How Remiglo knows what happened. The poller tracks every open invoice
and payout against the 1Click status endpoint and writes each
transition to the ledger in the database. For the contract layer, an
RPC polling indexer (`src/services/indexer.ts`) walks blocks from a
stored cursor, reads the registry contract's EVENT_JSON audit logs
through NEAR RPC (with an archival endpoint fallback) and stores them
in the registry_events table exactly once, so audit history can be
rebuilt from chain data rather than trusted from the database. A
QueryAPI indexer function is a drop in replacement for the same table
when a queryapi account is provisioned; no QueryAPI integration exists
yet and none is faked.

### 6. Business dashboard and accounting reports
What the business sees: invoices, payout batches, settlement status,
the reconciliation ledger, and accounting exports (CSV) that map
every chain settlement back to the invoice or payout that caused it.
The dashboard is a full operations console in the design language
adopted on 2026-11-06 (see docs/DASHBOARD-DESIGN.md), with its own
accounts and role based permissions: the first run setup creates the
owner account, and from then on every dashboard page requires a
login. The API keeps using API keys, unchanged.

## Boundary rule: Chain Signatures versus Intents

> **Chain Signatures is only used where Remiglo needs NEAR controlled
> cross chain signing. Intents handles its own routing and settlement
> flow. Both are never responsible for the same transaction.**

One transaction, one owner. If Intents accepted a quote and issued a
deposit address, Intents owns that payment until it succeeds, refunds
or fails. Remiglo's job in that flow is to watch, record and report,
never to intervene with its own signatures.

**Legitimate use of Chain Signatures.** A business treasury holds funds
in a NEAR controlled account and must sign a payout deposit on a
foreign chain, in a case the Intents deposit flow does not cover (for
example an asset or a destination chain with no 1Click route). The
treasury's NEAR controlled account signs that one deposit through
Chain Signatures. No Intents quote exists for that payment, so nothing
is double owned.

**Forbidden use.** An invoice's payment is already executing inside
Intents: the customer deposited, solvers are settling. Remiglo must
not use Chain Signatures to re sign, re route, top up or "help" that
settlement from the side. If the Intents flow fails, it fails honestly
as REFUNDED or FAILED in the ledger, and any retry is a brand new
payment with its own quote and deposit address.

## Status map, 2026-11-06 (updated after the full build programme)

| Layer | Exists today | Honest status |
|---|---|---|
| 1. Developer API + SDK | Yes | REST API complete for the discussed scope: merchants, API keys, invoices, hosted payment page, single and batch payouts (JSON or CSV upload) with approval thresholds, a recipients address book, recurring schedules, signed webhooks with retries and replay, reconciliation endpoints. TypeScript SDK built in `sdk/` with typed methods and webhook signature verification, tested against the live app in mock mode. |
| 2. NEAR Smart Contracts | Yes | Remiglo Registry contract built, unit tested (Rust, 8 tests) and deployed to NEAR testnet at remiglo.testnet: merchant authorization, spending policies with check_spend, batch records, payout anchors, EVENT_JSON audit events. The API anchors batches into it asynchronously (anchor status and tx hash on the batch row) when configured; unconfigured by default. |
| 3. NEAR Intents | Yes | Integrated through the 1Click API: token list, quotes, deposit addresses, status tracking. A partner API key is still needed for the app fee split. |
| 4. Chain Signatures | Yes, treasury case only | Module built (`src/services/chainSignatures.ts`) with the boundary enforced in code: it refuses any payment carrying an Intents deposit address. Mock implementation for tests; the live MPC client (v1.signer / v1.signer-prod.testnet) is gated behind CHAIN_SIG_ENABLED plus a configured key file and is inert otherwise. |
| 5. Monitoring and indexing | Yes | 1Click status tracking by the poller plus the SQLite ledger. Registry indexing by the RPC polling indexer into registry_events with a restart safe cursor; status at GET /v1/internal/indexer/status; events surface on the dashboard Routing page. QueryAPI remains a documented drop in replacement, not built. |
| 6. Dashboard and reports | Yes | Full business dashboard in the adopted design language (light, navy #14243A, accent #4263EB): Overview, Payments, Payouts, Recipients, Invoices, Schedules, Routing, Reconciliation, Analytics, Developers, Settings. Dashboard accounts with roles (owner, admin, operator, viewer), session login, first run setup, editable business settings and team management. Accounting CSV export. |

## Cross cutting rules

- Amounts are smallest unit strings everywhere. No floats anywhere near
  money. Fee math is integer basis point math.
- v1 is non custodial pass through: businesses fund payouts from their
  own wallets to per payment deposit addresses. Remiglo never pools
  business funds.
- NEAR Intents has no testnet. Development runs in mock mode, proofs
  run as dry quotes, and live amounts stay small and capped in code.
- Secrets live in environment variables only. The example env file
  ships blank, and API keys and webhook secrets are shown once at
  creation and stored hashed or server side only, never on customer
  facing pages.
