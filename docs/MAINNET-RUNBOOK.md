# Remiglo Mainnet Runbook

The ordered go live sequence for Remiglo on NEAR mainnet. Everything up
to section 3 is preparation; real funds are only at risk from section 7
on, and there only in tiny amounts until the caps are deliberately
raised.

Roles: **Desmond** does the steps only the account owner can do
(creating the account, holding its seed phrase, paying the first
invoice). The **operator** (whoever runs the server and the deploy)
does the rest.

Standing rules, learned the expensive way on other projects:

- The registry contract belongs on the standalone `remiglo.near`
  account. Never deploy Remiglo under another project's account or
  name (the 2026-11-06 testnet correction).
- No real key ever goes into a repo file, a chat, or a screenshot.
  Key material lives in `keys/` (gitignored) or in the server
  environment only.
- The production server NEVER points `ONECLICK_BASE_URL` at a testnet
  sandbox. A sandbox hands out testnet deposit addresses; a customer
  sending real money to one loses it.

## 1. Create remiglo.near (Desmond)

1. In the funded mainnet wallet, create the account `remiglo.near`
   (about 0.1 NEAR in the normal wallet flow).
2. Save the seed phrase OFFLINE: on paper or in a password manager
   vault. Never in a chat, a repo, an email, or a photo. Whoever holds
   the seed phrase holds the contract, the registry and the fee
   income.
3. Fund the account with about **5 NEAR** total. The math: the
   compiled registry wasm is 262,890 bytes (about 257 KB) and NEAR
   storage costs about 1 NEAR per 100 KB, so the deployed code alone
   locks roughly **2.6 NEAR** of storage balance. The rest covers the
   account's own state, contract state growth, and gas headroom.
   Storage balance is locked, not spent, but treat it as committed.

Done when: `remiglo.near` resolves on
https://nearblocks.io/address/remiglo.near with a balance near 5 NEAR.

## 2. Place the key file (Desmond, then operator)

1. Export the full access key for `remiglo.near` from the wallet as a
   JSON key file, the standard NEAR format with `account_id`,
   `public_key`, and `private_key` fields. This is the format both
   near-cli-rs and this repo's own signer (`loadKeyFile` in
   `src/services/nearTx.ts`) read.
2. Save it as `keys/remiglo.near.json` in the repo working copy on the
   machine that will run the deploy and, later, the server. Set
   permissions: `chmod 600 keys/remiglo.near.json`.
3. Confirm it can never be committed: `keys/` is in `.gitignore`, and
   `git status` must not list it. Never copy it into `src/`, `docs/`,
   or any tracked folder.

This one key signs registry anchors from the server later, so protect
it like the seed phrase. If it ever leaks: rotate the account's keys
in the wallet, export a fresh file, and replace this one. The contract
itself has no admin removal method (see section 8), so key rotation at
the account level is the remedy.

## 3. Deploy the registry contract (operator)

Prerequisite: near-cli-rs installed (`near` on PATH).

1. Review exactly what will run:

   ```
   scripts/deploy-mainnet.sh --dry-run
   ```

2. Run it for real and type the account id at the confirmation prompt:

   ```
   scripts/deploy-mainnet.sh
   ```

   The script rebuilds the wasm with `scripts/build-contract.sh`,
   deploys it to `remiglo.near`, calls `new` with owner
   `remiglo.near`, registers `remiglo.near` as the first merchant with
   itself as admin, and sets the opening policy: per payout cap
   100 USDC, daily budget 1000 USDC, approval threshold 500 USDC (the
   same values proven on testnet). If it stops midway, rerun with
   `START_AT=<next step>`; the init and register steps are one time
   only by contract design.

3. Verify on the mainnet explorer,
   https://nearblocks.io/address/remiglo.near :
   - the account shows deployed contract code;
   - the script's view calls report owner `remiglo.near`, the policy
     above, `check_spend` clean at 50 USDC and
     `["over_cap", "approval_required"]` at 600 USDC;
   - the deploy, init, register, and policy transactions are all
     successful. Keep their hashes with the launch records.

## 4. Apply for the 1Click partner key (operator)

1. Apply at https://partners.near-intents.org for the Remiglo partner
   API key, naming **`remiglo.near`** as the app fee recipient.
2. Why it matters: the server sends `appFees` (50 bps to
   `APP_FEE_RECIPIENT`) on every quote, but 1Click only honours the
   split for partner keys, split 50/50 with 1Click. Without the key,
   quotes still work, users pay the standard rate plus 25 bps, and
   Remiglo earns nothing.
3. When the key arrives, put it in the server environment as
   `ONECLICK_API_KEY` (section 5). Nowhere else. Approval timing is on
   NEAR Intents' side; the rest of this runbook does not wait for it,
   but no fee income exists until it lands.

## 5. Configure the production server (operator)

1. On the production host, copy `.env.mainnet.example` to
   `.env.mainnet` OUTSIDE any git working tree (or scrub it from the
   deploy), and fill in the real values: a generated `ADMIN_TOKEN`,
   the partner key, and the absolute `REMIGLO_DB` path.
2. The server does not load env files itself. Wire the file into the
   process: a systemd unit with `EnvironmentFile=/path/.env.mainnet`
   is the clean route. Minimum shape:

   ```
   [Service]
   WorkingDirectory=/opt/remiglo
   EnvironmentFile=/opt/remiglo/.env.mainnet
   ExecStart=/usr/bin/node dist/server.js   # after npm run build; there is no npm start script
   Restart=always
   ```

   Run it with **Node 24** (the store uses the built in `node:sqlite`).
3. Sanity checks after first start:
   - `GET /health` answers `{ ok: true }` through the reverse proxy.
   - Logs show the poller running (default every 15s).
   - Create the dashboard owner at `/dashboard/setup` immediately,
     before the URL is shared anywhere. Until an owner exists the
     dashboard is in setup mode.
4. SQLite backup routine (the DB holds merchants, invoices, payouts,
   webhook state, and dashboard users; it is the business record):
   - The store runs SQLite in WAL mode, so back up with the online
     backup command, never a bare copy of the live file:
     `sqlite3 "$REMIGLO_DB" ".backup /backups/remiglo-$(date +%F).db"`
   - Nightly cron, keep at least 14 daily snapshots, and copy them off
     the host (object storage or a second machine). A backup that only
     exists on the same disk is not a backup.
   - Take an extra snapshot before every deploy, config change, or cap
     raise.
   - Test a restore once before launch: point a scratch instance at a
     snapshot with `REMIGLO_DB` and confirm the dashboard loads.

## 6. Hosting and domain (operator)

- The server is a long running process with a background poller and a
  local SQLite file: it needs an **always on VPS** (2 vCPU / 4 GB is
  plenty to start), never a serverless or free tier host that sleeps
  or wipes its disk.
- The app binds **127.0.0.1 only** (`src/server.ts` hardcodes it, and
  there is no HOST setting). Terminate HTTPS on the same host with
  Caddy or nginx and reverse proxy `remiglo.com` to
  `127.0.0.1:8400`. Caddy gets a Let's Encrypt certificate
  automatically; that is the simpler path.
- DNS: point `remiglo.com` (and `www`) at the VPS. Register the domain
  first if that lockdown step is still open.
- Firewall: open 22 (SSH, key only), 80, and 443. Nothing else. The
  app port stays reachable only from localhost.
- Hosted payment pages and webhook deliveries use the public domain
  through the proxy; invoice payment links are relative (`/pay/<id>`),
  so there is no base URL setting to change when the domain moves.

## 7. First live money (Desmond + operator together)

Prerequisite: 1Click mainnet quotes are healthy. Confirm with a dry
quote before touching money (the quote watch exists because quotes
were down from 2026-11-08; do not start this section on a degraded
endpoint).

Checklist, in order, all amounts tiny:

1. Create the first mainnet merchant in the dashboard (settlement
   asset NEAR USDC, settlement and refund addresses = Desmond's own
   mainnet wallet for this test).
2. Create a **1 USDC invoice**. Pay it himself from his own wallet to
   the deposit address on the payment page.
3. Watch it travel: invoice status open, deposit seen, processing,
   paid. Confirm the settlement tx on nearblocks.io and the
   `invoice.paid` webhook delivery (dashboard Developers page).
4. Create a **1 USDC payout** back to his own address on the
   destination chain. Fund its deposit address from his wallet.
5. Confirm the payout settles: status settled, destination tx visible
   on that chain's explorer, `payout.settled` webhook delivered, and
   the batch anchor transaction present on nearblocks.io with the
   batch showing anchor status anchored.
6. Reconciliation page shows both movements with matching amounts.
7. Only after all of the above: raise the caps **in steps**, and
   always in both places together, the server env
   (`PILOT_MAX_PAYOUT_UNITS`, `APPROVAL_THRESHOLD_UNITS`) and the on
   chain policy (`set_policy` as the merchant admin). Suggested
   ladder: 100, then 500, then 2000 USDC per payout, with the daily
   budget at 10x the cap, holding each step for real usage before the
   next. Keep the approval threshold at 500 USDC until there is a
   second human who can approve.

## 8. Pause, rollback, and incident notes

Controls that actually exist today, fastest first:

- **Stop the server** (`systemctl stop remiglo`). No new invoices,
  quotes, or payouts can be created. Money already deposited with
  1Click still settles or refunds under Intents' own flow; Remiglo
  never holds funds, so stopping loses no one's money.
- **Freeze payouts at the API**: set `PILOT_MAX_PAYOUT_UNITS=1` and
  restart. Every payout row then fails validation ("exceeds the pilot
  cap"). Setting `APPROVAL_THRESHOLD_UNITS=1` additionally forces
  every batch into pending approval. Invoices are unaffected.
- **Freeze anchoring on chain**: as owner, call `set_policy` for the
  merchant with `per_payout_cap` and `daily_budget` both `"0"`.
  `anchor_payment` then rejects every spend (`over_cap`) and
  `check_spend` reports it; batches record anchor failures in the
  ledger where they are visible. Restore by setting the real policy
  back. The signed form is the step 5 command in
  `scripts/deploy-mainnet.sh` with the values changed.
- **Stop the fee**: unset `APP_FEE_RECIPIENT` and restart. Quotes then
  go out with no `appFees` at all (the client only adds them when both
  fee fields are set).
- **Bad contract deploy**: redeploy the previous wasm with step 2 of
  the deploy script. Deploying replaces code and **keeps state**; do
  NOT call `new` again (it panics "already initialized" by design).
  Keep the wasm of every deployed version with the launch records so
  a rollback target always exists.
- **Key compromise**: the contract has `add_merchant_admin` but no
  removal method, and merchant registration is permanent. A leaked
  server key is fixed by rotating the `remiglo.near` account keys in
  the wallet and replacing `keys/remiglo.near.json` (section 2). A
  leaked seed phrase is worse: migrate to a fresh account and a fresh
  contract, and treat the old registry as read only history.
- **Database loss**: restore the newest `.backup` snapshot (section
  5), restart, and let the poller resync invoice and payout states
  from 1Click. On chain anchors and Intents settlements are unaffected
  by a server restore.

## Launch day order, on one line

Account funded (1) → key file placed (2) → deploy reviewed and run
(3) → partner key applied for (4) → server configured and backed up
(5) → domain live over HTTPS (6) → tiny money proven end to end (7) →
caps raised in steps (7). Pause and rollback levers are in section 8.
