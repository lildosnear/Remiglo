# Remiglo Dashboard Design

Set by Desmond on 2026-11-06. This is the design the business dashboard
is built to. The goal is serious payment infrastructure, not another
crypto dashboard.

## Direction

- **Stripe is the main design inspiration**: simplicity, restraint,
  numbers first, nothing decorative that does not carry information.
- **Modern Treasury is the functional and operational blueprint**: the
  dashboard is an operations tool for moving money — approvals, batches,
  reconciliation and audit — not just a reporting skin.

Reference products studied while setting this direction:

- **Wise** — multi currency account clarity: balances and account
  details per currency, plain language, nothing hidden.
- **Ramp** — reporting: spending broken down by person, category and
  department, charts that answer a question at a glance.
- **Stripe** — the dashboard itself: top line volume stats, trend
  chart, breakdowns, one clear primary action.
- **A dark mission control style ops console** — transaction event
  feeds and provider health at a glance. Reference only: the chosen
  Remiglo theme is light (see below), the lesson taken is operational
  density, not the dark theme.

## Visual system

- Background: white and very light grey.
- Primary: deep navy `#14243A`.
- Accent: electric blue `#4263EB`.
- Success: `#16A36A`.
- Typography: Inter.
- Cards: subtle borders, minimal shadows.
- Sidebar: dark navy or white with a clean active state. The build
  uses the dark navy sidebar.

## Pages

| Page | What it contains |
| --- | --- |
| Overview | Payment volume, successful payouts, pending payments |
| Payments | All incoming and outgoing transactions |
| Payouts | Individual and bulk contractor payments |
| Recipients | Saved contractor wallets and networks |
| Invoices | Invoice creation and payment tracking |
| Schedules | Recurring invoices and payout batches (added during the build programme) |
| Routing | Supported networks, assets, routing activity and indexed registry events |
| Reconciliation | Matched, unmatched and failed transactions |
| Analytics | Volume, fees, settlement performance |
| Developers | API keys, webhooks, logs and documentation |
| Settings | Business profile, team and permissions |

## Homepage

The first screen of the Overview page must immediately show:

- Total payment volume
- Successful payments
- Pending payments
- Failed payments
- Payment volume chart
- Recent transactions
- Pending approvals
- Quick action: Send payout

## Recommendation on record

Use Stripe as the main design inspiration and Modern Treasury as the
functional blueprint. That combination makes Remiglo look and behave
like serious payment infrastructure rather than another crypto
dashboard.
