/**
 * Remiglo business dashboard v2: ten server rendered pages over the
 * store. Design per docs/DASHBOARD-DESIGN.md (shell in dashui.ts).
 * The dashboard is an operator console: it reads the store directly,
 * same trust model as the v1 read only page. It never renders API
 * keys, key hashes, or webhook secrets.
 */
import { feeEstimate, INVOICE_TERMINAL, PAYOUT_TERMINAL, type DashRole, type Invoice, type Merchant, type Payout } from "./core.js";
import type { Store } from "./store.js";
import { builtinAsset, formatAmount, formatUnits, guessAsset, BUILTIN_ASSETS, type AssetInfo } from "./assets.js";
import { barChartSvg, card, chip, donutSvg, esc, hBarSvg, htable, shell, statCard, type ShellOptions } from "./dashui.js";
import { can, type DashAction } from "./auth.js";

export interface DashData {
  store: Store;
  merchant: Merchant;
  /** Application fee setting in bps (config level, not per merchant). */
  feeBps: number;
  pilotMaxPayoutUnits: string;
  /** Signed in dashboard role. Undefined means pre account operator mode (no users exist yet). */
  role?: DashRole;
  userEmail?: string;
}

/** Role check for renderers: pre account mode (no users) keeps full operator access. */
export function dashCan(d: DashData, action: DashAction): boolean {
  if (!d.role) return true;
  return can(d.role, action);
}

/** shell() prefilled with the signed in user context. */
function page(d: DashData, o: ShellOptions): string {
  return shell({
    ...o,
    setupMode: !d.role,
    userLabel: d.userEmail,
    userRole: d.role ? d.role[0].toUpperCase() + d.role.slice(1) : undefined,
  });
}

const READ_ONLY_NOTE = `<p class="note">Your role is read only: you can view this page but not make changes.</p>`;

/** Same merchant pick as the v1 console: explicit id, else "demo", else first. */
export function pickMerchant(store: Store, id?: string): Merchant | undefined {
  const merchants = store.listMerchants();
  return (id && merchants.find((m) => m.id === id))
    || merchants.find((m) => m.name.toLowerCase() === "demo")
    || merchants[0];
}

export function renderNoMerchant(active: string, title: string): string {
  return shell({
    active, title,
    content: card("No merchant yet", `<p class="empty">No merchant exists yet. Create one with <span class="mono">POST /v1/merchants</span> and this dashboard will light up.</p>`),
  });
}

// ---- formatting helpers (sync: built in map, then a conservative guess) ----
const info = (assetId: string): AssetInfo => builtinAsset(assetId) ?? guessAsset(assetId);

/** Normalize a smallest unit amount to 6 decimal USD units, integer math. */
function toUsdUnits(units: string, decimals: number): bigint {
  const v = BigInt(units);
  if (decimals === 6) return v;
  if (decimals > 6) return v / 10n ** BigInt(decimals - 6);
  return v * 10n ** BigInt(6 - decimals);
}

export const fmtUsd = (units: bigint): string => `$${formatUnits(units.toString(), 6)}`;

const fmtDate = (iso: string): string => esc(iso.replace("T", " ").slice(0, 16));
const short = (v: string, n = 18): string => (v.length > n ? `${v.slice(0, n)}…` : v);

const PAID_INV = ["paid", "overpaid", "partially_paid"];
const PENDING_INV = ["open", "deposit_seen", "processing"];
const PENDING_PAY = ["awaiting_funding", "funded", "processing", "quoted"];

/** USD value that actually arrived for a paid invoice (observed first). */
function invoiceUsd(inv: Invoice): bigint {
  const raw = inv.observedAmount ?? inv.amountOut ?? inv.amount;
  return toUsdUnits(raw, info(inv.settlementAsset).decimals);
}

function payoutUsd(p: Payout): bigint {
  return toUsdUnits(p.amount, info(p.originAsset).decimals);
}

interface Totals {
  volume: bigint;
  successful: number;
  pending: number;
  failed: number;
}

function totals(invoices: Invoice[], payouts: Payout[]): Totals {
  let volume = 0n;
  let successful = 0, pending = 0, failed = 0;
  for (const inv of invoices) {
    if (PAID_INV.includes(inv.status)) { volume += invoiceUsd(inv); successful += 1; }
    else if (PENDING_INV.includes(inv.status)) pending += 1;
    else if (inv.status === "failed") failed += 1;
  }
  for (const p of payouts) {
    if (p.status === "settled") { volume += payoutUsd(p); successful += 1; }
    else if (PENDING_PAY.includes(p.status)) pending += 1;
    else if (p.status === "failed") failed += 1;
  }
  return { volume, successful, pending, failed };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Daily settled volume (paid invoices + settled payouts) for the last N days, oldest first. */
function dailyVolume(invoices: Invoice[], payouts: Payout[], days: number): Array<{ label: string; units: bigint }> {
  const byDay = new Map<string, bigint>();
  const add = (iso: string, units: bigint) => {
    const key = iso.slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0n) + units);
  };
  for (const inv of invoices) if (PAID_INV.includes(inv.status)) add(inv.updatedAt ?? inv.createdAt, invoiceUsd(inv));
  for (const p of payouts) if (p.status === "settled") add(p.updatedAt ?? p.createdAt, payoutUsd(p));
  const out: Array<{ label: string; units: bigint }> = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(now - i * 86400000).toISOString().slice(0, 10);
    out.push({ label: dayLabel(key), units: byDay.get(key) ?? 0n });
  }
  return out;
}

interface Txn {
  at: string; direction: string; kind: string; ref: string; amount: string; status: string; id: string;
}

function unifiedTxns(invoices: Invoice[], payouts: Payout[]): Txn[] {
  const rows: Txn[] = [];
  for (const inv of invoices) rows.push({
    at: inv.updatedAt ?? inv.createdAt, direction: "Incoming", kind: "Invoice",
    ref: inv.externalRef ?? inv.id, amount: formatAmount(inv.amount, info(inv.originAsset ?? inv.settlementAsset)),
    status: inv.status, id: inv.id,
  });
  for (const p of payouts) rows.push({
    at: p.updatedAt ?? p.createdAt, direction: "Outgoing", kind: "Payout",
    ref: p.recipientAddress, amount: formatAmount(p.amount, info(p.originAsset)),
    status: p.status, id: p.id,
  });
  return rows.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
}

const txnRow = (t: Txn): string[] => [
  fmtDate(t.at), esc(t.direction), esc(t.kind), `<span class="mono">${esc(short(t.ref, 26))}</span>`, esc(t.amount), chip(t.status),
];

const banners = (q: { notice?: string; error?: string }) => ({ notice: q.notice, error: q.error });

/** Status mix segments for the donut chart, shared by Overview and Analytics. */
export function statusSegments(invoices: Invoice[], payouts: Payout[]): Array<{ label: string; value: number }> {
  const byStatus = new Map<string, number>();
  for (const i of invoices) byStatus.set(i.status, (byStatus.get(i.status) ?? 0) + 1);
  for (const p of payouts) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
  return [...byStatus.entries()].sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label: label.replace(/_/g, " "), value }));
}

const DAY_MS = 86400000;

/** Totals restricted to payments whose last activity falls in [fromMs, toMs). */
function periodTotals(invoices: Invoice[], payouts: Payout[], fromMs: number, toMs: number): Totals {
  const inWindow = (iso: string) => { const t = Date.parse(iso); return t >= fromMs && t < toMs; };
  return totals(
    invoices.filter((i) => inWindow(i.updatedAt ?? i.createdAt)),
    payouts.filter((p) => inWindow(p.updatedAt ?? p.createdAt)),
  );
}

/** Percent change current vs previous; undefined hides the delta. */
function deltaOf(cur: number, prev: number): { pct: number; vsLabel: string } | undefined {
  if (prev === 0) return undefined;
  return { pct: ((cur - prev) / prev) * 100, vsLabel: "prior 14 days" };
}

// ---------------------------------------------------------------- Overview
export function renderOverview(d: DashData, q: { notice?: string; error?: string } = {}): string {
  const { store, merchant } = d;
  const invoices = store.listInvoices(merchant.id);
  const payouts = store.listPayouts(merchant.id);
  const batches = store.listBatches(merchant.id);
  const t = totals(invoices, payouts);
  const chart = barChartSvg(dailyVolume(invoices, payouts, 14), (u) => formatUnits(u.toString(), 6));
  // Deltas versus the previous equal period (the 14 days before the
  // chart window). Hidden entirely when the prior period has no data.
  const nowMs = Date.now();
  const cur = periodTotals(invoices, payouts, nowMs - 14 * DAY_MS, nowMs + 1);
  const prev = periodTotals(invoices, payouts, nowMs - 28 * DAY_MS, nowMs - 14 * DAY_MS);
  const prevEmpty = prev.volume === 0n && prev.successful === 0 && prev.pending === 0 && prev.failed === 0;
  const dVol = prevEmpty ? undefined : deltaOf(Number(cur.volume), Number(prev.volume));
  const dOk = prevEmpty ? undefined : deltaOf(cur.successful, prev.successful);
  const dPend = prevEmpty ? undefined : deltaOf(cur.pending, prev.pending);
  const dFail = prevEmpty ? undefined : deltaOf(cur.failed, prev.failed);
  const recent = unifiedTxns(invoices, payouts).slice(0, 10);
  const pendingBatches = batches.filter((b) => b.status === "pending_approval");
  const canApprove = dashCan(d, "approve");
  const approvals = pendingBatches.length === 0
    ? `<p class="empty">No batches are waiting for approval.</p>`
    : htable(["Batch", "Rows", "Total", "Created", ""], pendingBatches.map((b) => {
      const firstAsset = String((b.rows[0] as any)?.destinationAsset ?? merchant.settlementAsset);
      return [
        `<span class="mono">${esc(b.id)}</span>`, String(b.rowCount),
        esc(formatAmount(b.totalAmount, info(firstAsset))), fmtDate(b.createdAt),
        canApprove
          ? `<form method="post" action="/dashboard/actions/batches/${esc(b.id)}/approve" style="margin:0"><button class="btn small" type="submit">Approve</button></form>`
          : `<span class="note">Approval needs an admin or owner role</span>`,
      ];
    }));
  const content = `
  <div class="stats">
    ${statCard("Total payment volume", fmtUsd(t.volume), "Paid invoices received plus settled payouts", dVol)}
    ${statCard("Successful payments", String(t.successful), "Paid invoices and settled payouts", dOk)}
    ${statCard("Pending payments", String(t.pending), "Invoices and payouts still in flight", dPend)}
    ${statCard("Failed payments", String(t.failed), "Invoices and payouts that failed", dFail)}
  </div>
  <div class="grid-2">
    <div>${card("Payment volume, last 14 days", chart)}</div>
    <div>${card("Payments by status", donutSvg(statusSegments(invoices, payouts)))}</div>
  </div>
  <div class="grid">
    <div>${card("Recent transactions", htable(["When", "Direction", "Type", "Reference", "Amount", "Status"], recent.map(txnRow)))}</div>
    <div>${card("Pending approvals", approvals)}</div>
  </div>`;
  return page(d, {
    active: "overview", title: "Overview", subtitle: merchant.name, merchantName: merchant.name,
    actions: dashCan(d, "create") ? `<a class="btn" href="/dashboard/payouts#send">Send payout</a>` : "",
    content, ...banners(q),
  });
}

// ---------------------------------------------------------------- Payments
export function renderPayments(d: DashData, q: { status?: string } = {}): string {
  const { store, merchant } = d;
  const all = unifiedTxns(store.listInvoices(merchant.id), store.listPayouts(merchant.id));
  const statuses = [...new Set(all.map((t) => t.status))].sort();
  const filtered = q.status ? all.filter((t) => t.status === q.status) : all;
  const options = [`<option value="">All statuses</option>`,
    ...statuses.map((s) => `<option value="${esc(s)}"${s === q.status ? " selected" : ""}>${esc(s.replace(/_/g, " "))}</option>`)].join("");
  const filter = `<form method="get" action="/dashboard/payments" class="inline-form" style="margin-bottom:12px">
    <div class="field"><label for="status">Status</label><select id="status" name="status">${options}</select></div>
    <button class="btn secondary" type="submit">Filter</button></form>`;
  return page(d, {
    active: "payments", title: "Payments", subtitle: `${merchant.name} · every incoming and outgoing transaction`,
    merchantName: merchant.name,
    content: card("All transactions", filter + htable(["When", "Direction", "Type", "Counterparty or reference", "Amount", "Status"], filtered.map(txnRow))),
  });
}

// ---------------------------------------------------------------- Payouts
function assetOptions(selected?: string): string {
  return Object.entries(BUILTIN_ASSETS).map(([assetId, a]) =>
    `<option value="${esc(assetId)}"${assetId === selected ? " selected" : ""}>${esc(a.symbol)} on ${esc(builtinAsset(assetId)!.chainName)}</option>`).join("");
}

export function renderPayouts(d: DashData, q: { notice?: string; error?: string } = {}): string {
  const { store, merchant } = d;
  const batches = store.listBatches(merchant.id).slice().reverse();
  const payouts = store.listPayouts(merchant.id).slice().reverse();
  const cap = formatUnits(d.pilotMaxPayoutUnits, 6);
  const form = `<form method="post" action="/dashboard/actions/payouts?merchant=${esc(merchant.id)}" class="inline-form">
    <div class="field"><label for="recipientAddress">Destination address</label><input id="recipientAddress" name="recipientAddress" required placeholder="contractor.near or 0x…"></div>
    <div class="field"><label for="destinationAsset">Destination asset</label><select id="destinationAsset" name="destinationAsset">${assetOptions()}</select></div>
    <div class="field"><label for="amount">Amount</label><input id="amount" name="amount" required inputmode="decimal" placeholder="25.00"></div>
    <button class="btn" type="submit">Send payout</button></form>
    <p class="note">Creates one payout through the same path as the API: quoted by NEAR Intents, created in the awaiting funding state. Pilot cap: ${esc(cap)} per payout.</p>`;
  const csvForm = `<form method="post" action="/dashboard/actions/batches/csv?merchant=${esc(merchant.id)}">
    <div class="field" style="margin-bottom:10px"><label for="csvFile">Choose a CSV file</label><input id="csvFile" type="file" accept=".csv,text/csv" style="border:none;padding:0"></div>
    <div class="field" style="margin-bottom:10px"><label for="csv">CSV contents</label>
    <textarea id="csv" name="csv" rows="6" required style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;width:100%" placeholder="recipient_address,destination_asset,amount_units,reference"></textarea></div>
    <button class="btn" type="submit">Upload batch</button></form>
    <p class="note">Header: <span class="mono">recipient_address,destination_asset,amount_units</span> or <span class="mono">recipient_id,amount_units</span>, with an optional trailing <span class="mono">reference</span> column. Amounts are smallest units. Up to 100 rows; every row is validated first and nothing is created if any row is invalid. Batches over the approval threshold wait for approval, exactly like API batches.</p>
    <script>document.getElementById("csvFile").addEventListener("change",function(){var f=this.files&&this.files[0];if(!f)return;var r=new FileReader();r.onload=function(){document.getElementById("csv").value=String(r.result||"");};r.readAsText(f);});</script>`;
  const canCreate = dashCan(d, "create");
  const content = `
  ${canCreate ? `<div id="send">${card("Send payout", form)}</div>\n  ${card("Upload a CSV batch", csvForm)}` : card("Send payout", READ_ONLY_NOTE)}
  ${card("Payout batches", htable(["Batch", "Status", "Rows", "Total", "Created"], batches.map((b) => {
    const firstAsset = String((b.rows[0] as any)?.destinationAsset ?? merchant.settlementAsset);
    return [`<span class="mono">${esc(b.id)}</span>`, chip(b.status), String(b.rowCount), esc(formatAmount(b.totalAmount, info(firstAsset))), fmtDate(b.createdAt)];
  })))}
  ${card("Payouts", htable(["Payout", "Recipient", "Amount", "Status", "Batch", "Created"], payouts.map((p) => [
    `<span class="mono">${esc(short(p.id))}</span>`, `<span class="mono">${esc(short(p.recipientAddress, 30))}</span>`,
    esc(formatAmount(p.amount, info(p.originAsset))), chip(p.status),
    p.batchId ? `<span class="mono">${esc(short(p.batchId))}</span>` : "—", fmtDate(p.createdAt),
  ])))}`;
  return page(d, {
    active: "payouts", title: "Payouts", subtitle: `${merchant.name} · individual and bulk contractor payments`,
    merchantName: merchant.name, content, ...banners(q),
  });
}

// ---------------------------------------------------------------- Recipients
export function renderRecipients(d: DashData, q: { notice?: string; error?: string } = {}): string {
  const { store, merchant } = d;
  const payouts = store.listPayouts(merchant.id);
  const history = new Map<string, { count: number; total: bigint; last: string }>();
  for (const p of payouts) {
    const key = `${p.recipientAddress}|${p.destinationAsset}`;
    const cur = history.get(key) ?? { count: 0, total: 0n, last: p.createdAt };
    cur.count += 1;
    cur.total += BigInt(p.amount);
    if (p.createdAt > cur.last) cur.last = p.createdAt;
    history.set(key, cur);
  }
  const book = store.listRecipients(merchant.id);
  const bookKeys = new Set(book.map((r) => `${r.address}|${r.assetId}`));
  const canCreate = dashCan(d, "create");
  const bookRows = book.map((r) => {
    const ai = info(r.assetId);
    const h = history.get(`${r.address}|${r.assetId}`);
    const editForm = canCreate ? `<form method="post" action="/dashboard/actions/recipients/${esc(r.id)}/update?merchant=${esc(merchant.id)}" class="inline-form" style="gap:6px">
      <div class="field"><label>Label</label><input name="label" value="${esc(r.label)}" style="min-width:120px"></div>
      <div class="field"><label>Notes</label><input name="notes" value="${esc(r.notes ?? "")}" style="min-width:140px"></div>
      <button class="btn secondary small" type="submit">Save</button></form>` : "";
    const delForm = canCreate ? `<form method="post" action="/dashboard/actions/recipients/${esc(r.id)}/delete?merchant=${esc(merchant.id)}" style="margin:0"><button class="btn secondary small" type="submit">Delete</button></form>` : "—";
    return [
      `<strong>${esc(r.label || "—")}</strong><br>${editForm}`,
      `<span class="mono">${esc(short(r.address, 34))}</span>`,
      esc(`${ai.symbol} on ${ai.chainName}`),
      h ? String(h.count) : "0",
      h ? esc(formatUnits(h.total.toString(), ai.decimals)) : "—",
      esc(r.notes ?? "—"),
      delForm,
    ];
  });
  const addForm = `<form method="post" action="/dashboard/actions/recipients?merchant=${esc(merchant.id)}" class="inline-form">
    <div class="field"><label for="label">Label</label><input id="label" name="label" required placeholder="Contractor name"></div>
    <div class="field"><label for="address">Wallet address</label><input id="address" name="address" required placeholder="contractor.near or 0x…"></div>
    <div class="field"><label for="assetId">Asset and network</label><select id="assetId" name="assetId">${assetOptions()}</select></div>
    <div class="field"><label for="notes">Notes (optional)</label><input id="notes" name="notes" placeholder="Role, project…"></div>
    <button class="btn" type="submit">Add recipient</button></form>
    <p class="note">Saved recipients can be referenced by id from the API when creating payouts and batches, so wallet addresses live in one place.</p>`;
  const histRows = [...history.entries()]
    .filter(([key]) => !bookKeys.has(key))
    .sort((a, b) => b[1].last.localeCompare(a[1].last))
    .map(([key, h]) => {
      const [address, asset] = key.split("|");
      const ai = info(asset);
      return [
        `<span class="mono">${esc(short(address, 34))}</span>`, esc(`${ai.symbol} on ${ai.chainName}`),
        String(h.count), esc(formatUnits(h.total.toString(), ai.decimals)), fmtDate(h.last),
      ];
    });
  const content = `
  ${card("Address book", htable(["Recipient", "Address", "Asset and network", "Payments", "Total sent", "Notes", ""], bookRows))}
  ${canCreate ? card("Add recipient", addForm) : card("Add recipient", READ_ONLY_NOTE)}
  ${card("Recipients from payment history",
    `<p class="note">Collected from payment history: addresses this business has paid that are not in the address book yet.</p>` +
    htable(["Address", "Asset and network", "Payments", "Total sent", "Last used"], histRows))}`;
  return page(d, {
    active: "recipients", title: "Recipients", subtitle: `${merchant.name} · saved contractor wallets and networks`,
    merchantName: merchant.name, content, ...banners(q),
  });
}

// ---------------------------------------------------------------- Invoices
export function renderInvoices(d: DashData, q: { notice?: string; error?: string } = {}): string {
  const { store, merchant } = d;
  const invoices = store.listInvoices(merchant.id).slice().reverse();
  const form = `<form method="post" action="/dashboard/actions/invoices?merchant=${esc(merchant.id)}" class="inline-form">
    <div class="field"><label for="amount">Amount</label><input id="amount" name="amount" required inputmode="decimal" placeholder="100.00"></div>
    <div class="field"><label for="originAsset">Customer pays in</label><select id="originAsset" name="originAsset">${assetOptions(merchant.settlementAsset)}</select></div>
    <div class="field"><label for="externalRef">Reference (optional)</label><input id="externalRef" name="externalRef" placeholder="INV-001"></div>
    <button class="btn" type="submit">Create invoice</button></form>
    <p class="note">Settlement goes to this business profile address. Share the payment page link with the customer.</p>`;
  const content = `
  ${dashCan(d, "create") ? card("Create invoice", form) : card("Create invoice", READ_ONLY_NOTE)}
  ${card("Invoices", htable(["Invoice", "Reference", "Amount", "Status", "Expires", "Payment page", "Created"], invoices.map((i) => [
    `<span class="mono">${esc(short(i.id))}</span>`, esc(i.externalRef ?? "—"),
    esc(formatAmount(i.amount, info(i.originAsset ?? i.settlementAsset))), chip(i.status),
    i.expiresAt ? fmtDate(i.expiresAt) : "—",
    `<a href="/pay/${esc(i.id)}">Open payment page</a>`, fmtDate(i.createdAt),
  ])))}`;
  return page(d, {
    active: "invoices", title: "Invoices", subtitle: `${merchant.name} · invoice creation and payment tracking`,
    merchantName: merchant.name, content, ...banners(q),
  });
}

// ---------------------------------------------------------------- Schedules
export function renderSchedules(d: DashData, q: { notice?: string; error?: string } = {}): string {
  const { store, merchant } = d;
  const schedules = store.listSchedules(merchant.id).slice().reverse();
  const runs = store.listRuns(merchant.id);
  const runsBySchedule = new Map<string, number>();
  for (const r of runs) runsBySchedule.set(r.scheduleId, (runsBySchedule.get(r.scheduleId) ?? 0) + 1);
  const cadenceOptions = ["weekly", "biweekly", "monthly"]
    .map((c) => `<option value="${c}">${c[0].toUpperCase() + c.slice(1)}</option>`).join("");
  const form = `<form method="post" action="/dashboard/actions/schedules?merchant=${esc(merchant.id)}">
    <div class="inline-form" style="margin-bottom:10px">
      <div class="field"><label for="kind">Creates</label><select id="kind" name="kind"><option value="invoice">Invoice</option><option value="payout_batch">Payout batch</option></select></div>
      <div class="field"><label for="cadence">Cadence</label><select id="cadence" name="cadence">${cadenceOptions}</select></div>
      <div class="field"><label for="dayOfMonth">Day of month (monthly only)</label><input id="dayOfMonth" name="dayOfMonth" inputmode="numeric" placeholder="1 to 28"></div>
    </div>
    <div class="inline-form" style="margin-bottom:10px">
      <div class="field"><label for="amount">Invoice amount</label><input id="amount" name="amount" inputmode="decimal" placeholder="100.00"></div>
      <div class="field"><label for="originAsset">Invoice asset</label><select id="originAsset" name="originAsset">${assetOptions(merchant.settlementAsset)}</select></div>
      <div class="field"><label for="externalRef">Invoice reference (optional)</label><input id="externalRef" name="externalRef" placeholder="RETAINER"></div>
    </div>
    <div class="field" style="margin-bottom:10px"><label for="rowsJson">Batch rows as JSON (for payout batch schedules)</label>
      <textarea id="rowsJson" name="rowsJson" rows="4" style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;width:100%" placeholder='[{"recipientAddress":"ada.near","destinationAsset":"...","amount":"10000000"}]'></textarea></div>
    <button class="btn" type="submit">Create schedule</button></form>
    <p class="note">Weekly runs every 7 days, biweekly every 14, monthly on the chosen day of month (clamped to 28). The first run lands one cadence from now. Each run is recorded and fires a schedule.executed webhook.</p>`;
  const canCreate = dashCan(d, "create");
  const rows = schedules.map((s) => {
    const toggle = !canCreate ? "—" : s.active
      ? `<form method="post" action="/dashboard/actions/schedules/${esc(s.id)}/pause?merchant=${esc(merchant.id)}" style="margin:0"><button class="btn secondary small" type="submit">Pause</button></form>`
      : `<form method="post" action="/dashboard/actions/schedules/${esc(s.id)}/resume?merchant=${esc(merchant.id)}" style="margin:0"><button class="btn small" type="submit">Resume</button></form>`;
    const summary = s.kind === "invoice"
      ? `Invoice of ${esc(formatAmount(String((s.payload as any).amount ?? "0"), info(String((s.payload as any).originAsset ?? merchant.settlementAsset))))}`
      : `Batch of ${Array.isArray((s.payload as any).rows) ? (s.payload as any).rows.length : 0} rows`;
    return [
      `<span class="mono">${esc(short(s.id))}</span>`, esc(s.kind === "invoice" ? "Invoice" : "Payout batch"),
      esc(s.cadence === "monthly" ? `Monthly on day ${s.dayOfMonth ?? "—"}` : s.cadence[0].toUpperCase() + s.cadence.slice(1)),
      esc(summary), s.active ? chip("active") : `<span class="chip neutral">Paused</span>`,
      fmtDate(s.nextRunAt), s.lastRunAt ? fmtDate(s.lastRunAt) : "—",
      String(runsBySchedule.get(s.id) ?? 0), toggle,
    ];
  });
  const content = `
  ${canCreate ? card("Create schedule", form) : card("Create schedule", READ_ONLY_NOTE)}
  ${card("Schedules", htable(["Schedule", "Creates", "Cadence", "Summary", "State", "Next run", "Last run", "Runs", ""], rows))}`;
  return page(d, {
    active: "schedules", title: "Schedules", subtitle: `${merchant.name} · recurring invoices and payout batches`,
    merchantName: merchant.name, content, ...banners(q),
  });
}

// ---------------------------------------------------------------- Routing
export interface RoutingToken { assetId: string; symbol: string; blockchain: string; decimals: number }

export function renderRouting(d: DashData, tokens: RoutingToken[]): string {
  const { store, merchant } = d;
  const byChain = new Map<string, RoutingToken[]>();
  for (const t of tokens) {
    const list = byChain.get(t.blockchain) ?? [];
    list.push(t);
    byChain.set(t.blockchain, list);
  }
  const supported = [...byChain.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([chain, list]) => {
    const chainName = builtinAsset(list[0].assetId)?.chainName ?? chain;
    return card(`${esc(chainName)}`, htable(["Asset", "Decimals", "Asset ID"], list.map((t) => [
      esc(t.symbol), String(t.decimals), `<span class="mono">${esc(short(t.assetId, 44))}</span>`,
    ])));
  }).join("");
  const payouts = store.listPayouts(merchant.id);
  const byDest = new Map<string, { count: number; usd: bigint }>();
  for (const p of payouts) {
    const chainName = info(p.destinationAsset).chainName;
    const cur = byDest.get(chainName) ?? { count: 0, usd: 0n };
    cur.count += 1;
    cur.usd += payoutUsd(p);
    byDest.set(chainName, cur);
  }
  const activity = [...byDest.entries()].sort((a, b) => Number(b[1].usd - a[1].usd)).map(([label, v]) => ({
    label: `${label} (${v.count})`, units: v.usd, display: fmtUsd(v.usd),
  }));
  const registryEvents = store.listRegistryEvents(undefined, 10);
  const registryCard = card("Registry activity", registryEvents.length === 0
    ? `<p class="empty">No registry events indexed yet. When the registry contract is configured, its on chain audit events (merchant registered, policy updated, batch recorded, payout anchored) appear here, indexed from NEAR RPC.</p>`
    : htable(["When", "Event", "Merchant", "Block", "Transaction"], registryEvents.map((e) => [
        fmtDate(e.indexedAt), chip(e.event), esc(String(e.data.merchant ?? "—")),
        String(e.blockHeight), `<span class="mono">${esc(short(e.txHash, 18))}</span>`,
      ])));
  const content = `
  ${card("Routing activity", `<p class="note">Payouts by destination network, all time.</p>` + hBarSvg(activity))}
  ${registryCard}
  <h2 style="font-size:15px;margin:18px 0 10px">Supported networks and assets</h2>
  ${supported || card("Supported networks and assets", `<p class="empty">No token list available right now.</p>`)}`;
  return page(d, {
    active: "routing", title: "Routing", subtitle: `${merchant.name} · supported networks, assets and routing activity`,
    merchantName: merchant.name, content,
  });
}

// ---------------------------------------------------------------- Reconciliation
export function renderReconciliation(d: DashData): string {
  const { store, merchant } = d;
  const invoices = store.listInvoices(merchant.id);
  const payouts = store.listPayouts(merchant.id);
  const matched = invoices.filter((i) => i.reconFlag === "matched").length;
  const settled = payouts.filter((p) => p.status === "settled").length;
  const partial = invoices.filter((i) => i.status === "partially_paid" || i.reconFlag === "partially_paid").length;
  const over = invoices.filter((i) => i.status === "overpaid" || i.reconFlag === "overpaid").length;
  const failedRefunded = invoices.filter((i) => ["failed", "refunded"].includes(i.status)).length
    + payouts.filter((p) => ["failed", "refunded"].includes(p.status)).length;
  const exceptions: string[][] = [];
  for (const i of invoices) {
    const clean = i.status === "paid" && (i.reconFlag === "matched" || !i.reconFlag);
    if (INVOICE_TERMINAL.includes(i.status) && !clean) {
      exceptions.push(["Invoice", `<span class="mono">${esc(short(i.id))}</span>`, chip(i.status),
        esc(i.reconFlag ?? i.status), esc(formatAmount(i.amount, info(i.originAsset ?? i.settlementAsset))), fmtDate(i.updatedAt ?? i.createdAt)]);
    }
  }
  for (const p of payouts) {
    if (PAYOUT_TERMINAL.includes(p.status) && p.status !== "settled") {
      exceptions.push(["Payout", `<span class="mono">${esc(short(p.id))}</span>`, chip(p.status),
        esc(p.status), esc(formatAmount(p.amount, info(p.originAsset))), fmtDate(p.updatedAt ?? p.createdAt)]);
    }
  }
  const content = `
  <div class="stats">
    ${statCard("Matched and settled", String(matched + settled), `${matched} invoices matched · ${settled} payouts settled`)}
    ${statCard("Partially paid", String(partial), "Invoices settled below the expected amount")}
    ${statCard("Overpaid", String(over), "Invoices settled above the expected amount")}
    ${statCard("Failed or refunded", String(failedRefunded), "Across invoices and payouts")}
  </div>
  ${card("Exceptions", `<p class="note">Finished payments that did not settle cleanly. In flight payments are on the Payments page, not here.</p>` +
    htable(["Type", "ID", "Status", "Reason", "Amount", "Updated"], exceptions))}
  ${card("Export", `<p>Full per invoice reconciliation with gross, fee estimate and net is available from the API export endpoint. It needs your merchant API key, so call it from your backend or with curl:</p>
    <p><a href="/v1/reconciliation/export.csv">GET /v1/reconciliation/export.csv</a></p>`)}`;
  return page(d, {
    active: "reconciliation", title: "Reconciliation", subtitle: `${merchant.name} · matched, unmatched and failed transactions`,
    merchantName: merchant.name, content,
  });
}

// ---------------------------------------------------------------- Analytics
export function renderAnalytics(d: DashData): string {
  const { store, merchant } = d;
  const invoices = store.listInvoices(merchant.id);
  const payouts = store.listPayouts(merchant.id);
  const chart = barChartSvg(dailyVolume(invoices, payouts, 30), (u) => formatUnits(u.toString(), 6));

  const byChain = new Map<string, bigint>();
  for (const p of payouts) {
    if (p.status !== "settled") continue;
    const chainName = info(p.destinationAsset).chainName;
    byChain.set(chainName, (byChain.get(chainName) ?? 0n) + payoutUsd(p));
  }
  const chainRows = [...byChain.entries()].sort((a, b) => Number(b[1] - a[1]))
    .map(([label, units]) => ({ label, units, display: fmtUsd(units) }));

  const byStatus = new Map<string, number>();
  for (const i of invoices) byStatus.set(i.status, (byStatus.get(i.status) ?? 0) + 1);
  for (const p of payouts) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
  const statusSegs = [...byStatus.entries()].sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label: label.replace(/_/g, " "), value }));

  let fees = 0n;
  for (const inv of invoices) {
    if (!PAID_INV.includes(inv.status)) continue;
    fees += toUsdUnits(feeEstimate(inv.amount, d.feeBps), info(inv.originAsset ?? inv.settlementAsset).decimals);
  }

  const terminalInvoices = invoices.filter((i) => INVOICE_TERMINAL.includes(i.status));
  const terminalPayouts = payouts.filter((p) => PAYOUT_TERMINAL.includes(p.status));
  const terminalCount = terminalInvoices.length + terminalPayouts.length;
  const successCount = terminalInvoices.filter((i) => PAID_INV.includes(i.status)).length
    + terminalPayouts.filter((p) => p.status === "settled").length;
  const share = terminalCount === 0 ? "—" : `${((successCount / terminalCount) * 100).toFixed(1)}%`;

  const ledger = store.listLedger(merchant.id).filter((e) => e.entityType === "invoice" || e.entityType === "payout");
  const entities = new Set(ledger.map((e) => `${e.entityType}:${e.entityId}`));
  const avgTransitions = entities.size === 0 ? "—" : (ledger.length / entities.size).toFixed(1);

  const content = `
  ${card("Volume by day, last 30 days", chart)}
  <div class="grid">
    <div>${card("Volume by destination chain", `<p class="note">Settled payouts only.</p>` + hBarSvg(chainRows))}</div>
    <div>${card("Payments by status", donutSvg(statusSegs))}</div>
  </div>
  <div class="stats">
    ${statCard("Estimated fees earned", fmtUsd(fees), `Estimate at ${d.feeBps} bps on paid invoices, same integer math as the CSV export`)}
    ${statCard("Settlement success rate", share, `${successCount} of ${terminalCount} finished payments reached settlement`)}
    ${statCard("Average transitions", avgTransitions, "Ledger recorded status transitions per payment")}
  </div>`;
  return page(d, {
    active: "analytics", title: "Analytics", subtitle: `${merchant.name} · volume, fees and settlement performance`,
    merchantName: merchant.name, content,
  });
}

// ---------------------------------------------------------------- Developers
const API_SURFACE: Array<[string, string, string]> = [
  ["POST", "/v1/merchants", "Create a merchant and mint its API key (admin token when set)"],
  ["GET", "/v1/merchants/me", "The merchant behind the presented API key"],
  ["GET", "/v1/tokens", "Assets and networks available through NEAR Intents"],
  ["POST", "/v1/invoices", "Create an invoice and its hosted payment page"],
  ["GET", "/v1/invoices", "List invoices"],
  ["GET", "/v1/invoices/:id", "One invoice"],
  ["POST", "/v1/invoices/:id/cancel", "Cancel an open invoice"],
  ["POST", "/v1/payouts", "Create a single payout"],
  ["GET", "/v1/payouts", "List payouts"],
  ["GET", "/v1/payouts/:id", "One payout"],
  ["POST", "/v1/payout-batches", "Create a payout batch (large batches wait for approval)"],
  ["GET", "/v1/payout-batches", "List payout batches"],
  ["GET", "/v1/payout-batches/:id", "One batch with its payouts and totals"],
  ["POST", "/v1/payout-batches/:id/approve", "Approve a batch held for approval"],
  ["POST", "/v1/schedules", "Create a recurring schedule"],
  ["GET", "/v1/schedules", "List schedules"],
  ["GET", "/v1/schedules/:id", "One schedule with its runs"],
  ["PATCH", "/v1/schedules/:id", "Update a schedule"],
  ["POST", "/v1/schedules/:id/pause", "Pause a schedule"],
  ["POST", "/v1/schedules/:id/resume", "Resume a schedule"],
  ["DELETE", "/v1/schedules/:id", "Delete a schedule"],
  ["POST", "/v1/recipients", "Save a recipient to the address book"],
  ["GET", "/v1/recipients", "List saved recipients"],
  ["GET", "/v1/recipients/:id", "One recipient"],
  ["PATCH", "/v1/recipients/:id", "Update a recipient"],
  ["DELETE", "/v1/recipients/:id", "Delete a recipient"],
  ["GET", "/v1/ledger", "Ledger entries, optionally by entity"],
  ["GET", "/v1/reconciliation/daily", "Daily reconciliation summary"],
  ["GET", "/v1/reconciliation/export.csv", "Reconciliation CSV export"],
  ["POST", "/v1/webhook-endpoints", "Register a webhook endpoint"],
  ["GET", "/v1/webhook-endpoints", "List webhook endpoints"],
  ["GET", "/v1/webhook-deliveries", "List webhook deliveries"],
  ["POST", "/v1/webhook-deliveries/:id/replay", "Replay a webhook delivery"],
  ["POST", "/v1/internal/sync", "Run one poller sync cycle (localhost or admin token)"],
  ["GET", "/pay/:invoiceId", "Hosted payment page (public, the invoice id is the capability)"],
  ["GET", "/pay/:invoiceId/status", "Public payment status for the payment page"],
  ["GET", "/health", "Service health"],
];

export function renderDevelopers(d: DashData): string {
  const { store, merchant } = d;
  // Secrets are stripped here on purpose: only public endpoint fields render.
  const endpoints = store.listEndpoints(merchant.id).map((e) => ({ id: e.id, url: e.url, createdAt: e.createdAt }));
  const deliveries = store.listDeliveries(merchant.id, 15);
  const eventsByEndpoint = new Map<string, Set<string>>();
  for (const dlv of store.listDeliveries(merchant.id, 500)) {
    const set = eventsByEndpoint.get(dlv.endpointId) ?? new Set<string>();
    set.add(dlv.event);
    eventsByEndpoint.set(dlv.endpointId, set);
  }
  const endpointRows = endpoints.map((e) => {
    const events = [...(eventsByEndpoint.get(e.id) ?? new Set<string>())].sort();
    return [`<span class="mono">${esc(short(e.url, 40))}</span>`, "All events",
      events.length ? esc(events.join(", ")) : "No deliveries yet", fmtDate(e.createdAt)];
  });
  const content = `
  ${card("API keys", `<p>API keys are shown once, at creation, and only their hash is stored, so an existing key cannot be recovered or displayed here. To get a key, create a merchant with <span class="mono">POST /v1/merchants</span> and store the key that comes back.</p>
    <p class="note">Send the key in the <span class="mono">Authorization: Bearer …</span> header. Every /v1 route is scoped to the merchant behind the key.</p>`)}
  ${card("API surface", htable(["Method", "Path", "Purpose"], API_SURFACE.map(([m, p, purpose]) => [
    esc(m), `<span class="mono">${esc(p)}</span>`, esc(purpose),
  ])))}
  ${card("Webhook endpoints", endpoints.length === 0
    ? `<p class="empty">No webhook endpoints registered for this business yet. Register one with <span class="mono">POST /v1/webhook-endpoints</span>.</p>`
    : htable(["Endpoint", "Subscribed to", "Events delivered", "Registered"], endpointRows))}
  ${card("Recent webhook deliveries", htable(["When", "Event", "Status", "Attempts", "Last response"], deliveries.map((dlv) => [
    fmtDate(dlv.createdAt), esc(dlv.event), chip(dlv.status), String(dlv.attempts),
    dlv.lastStatusCode ? String(dlv.lastStatusCode) : esc(dlv.lastError ?? "—"),
  ])))}
  ${card("Webhook notes", `<p>Deliveries are signed with HMAC SHA256 in the <span class="mono">x-remiglo-signature</span> header, using the endpoint secret shown once at registration. Events: invoice.paid, invoice.expired, invoice.refunded, invoice.failed, payout.sent, payout.settled, payout.failed, batch.completed, schedule.executed. Failed deliveries retry up to 5 times with doubling backoff, and every attempt is logged above.</p>`)}
  ${card("Chain Signatures (treasury only)", `<p>A Chain Signatures module (<span class="mono">src/services/chainSignatures.ts</span>) exists for one case only: a business treasury held in a NEAR controlled account signing a payout deposit on a foreign chain that NEAR Intents does not cover. It refuses, in code, to sign for any payment that carries an Intents deposit address. Intents keeps its own routing and settlement; the two are never responsible for the same transaction.</p>`)}`;
  return page(d, {
    active: "developers", title: "Developers", subtitle: `${merchant.name} · API keys, webhooks, logs and documentation`,
    merchantName: merchant.name, content,
  });
}

// ---------------------------------------------------------------- Settings
export function renderSettings(d: DashData, q: { notice?: string; error?: string } = {}): string {
  const { store, merchant } = d;
  const settle = info(merchant.settlementAsset);
  const canSettings = dashCan(d, "settings");
  const canTeam = dashCan(d, "team");
  const canTeamManage = dashCan(d, "teamManage");
  const profileRows: string[][] = [
    ["Business name", esc(merchant.name)],
    ["Merchant ID", `<span class="mono">${esc(merchant.id)}</span>`],
    ["Settlement asset", esc(`${settle.symbol} on ${settle.chainName}`)],
    ["Settlement asset ID", `<span class="mono">${esc(merchant.settlementAsset)}</span>`],
    ["Settlement address", `<span class="mono">${esc(merchant.settlementAddress)}</span>`],
    ["Refund address", `<span class="mono">${esc(merchant.refundTo)}</span>`],
    ["Platform fee", `${d.feeBps} bps (application setting, applied to quotes)`],
    ["Registered", fmtDate(merchant.createdAt)],
  ];
  const profileForm = canSettings ? `<h3>Edit profile</h3>
    <form method="post" action="/dashboard/actions/settings?merchant=${esc(merchant.id)}" class="inline-form">
      <div class="field"><label for="name">Business name</label><input id="name" name="name" value="${esc(merchant.name)}" required></div>
      <div class="field"><label for="settlementAsset">Settlement asset</label><select id="settlementAsset" name="settlementAsset">${assetOptions(merchant.settlementAsset)}</select></div>
      <div class="field"><label for="settlementAddress">Settlement address</label><input id="settlementAddress" name="settlementAddress" value="${esc(merchant.settlementAddress)}" required></div>
      <div class="field"><label for="refundTo">Refund address</label><input id="refundTo" name="refundTo" value="${esc(merchant.refundTo)}" required></div>
      <button class="btn" type="submit">Save profile</button></form>`
    : READ_ONLY_NOTE;
  const users = store.listUsers(merchant.id);
  const roleOptions = (current: string) => ["owner", "admin", "operator", "viewer"]
    .map((r) => `<option value="${r}"${r === current ? " selected" : ""}>${r}</option>`).join("");
  const teamRows = users.map((u) => {
    const roleCell = canTeamManage && u.active
      ? `<form method="post" action="/dashboard/actions/team/${esc(u.id)}/role?merchant=${esc(merchant.id)}" class="inline-form" style="gap:6px">
           <select name="role" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px">${roleOptions(u.role)}</select>
           <button class="btn secondary small" type="submit">Change role</button></form>`
      : esc(u.role);
    const stateCell = !u.active
      ? `<span class="chip neutral">Deactivated</span>`
      : canTeamManage
        ? `<form method="post" action="/dashboard/actions/team/${esc(u.id)}/deactivate?merchant=${esc(merchant.id)}" style="margin:0"><button class="btn secondary small" type="submit">Deactivate</button></form>`
        : chip("active");
    return [esc(u.email), roleCell, stateCell, fmtDate(u.createdAt)];
  });
  const inviteForm = canTeam ? `<h3>Add a team member</h3>
    <form method="post" action="/dashboard/actions/team?merchant=${esc(merchant.id)}" class="inline-form">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required placeholder="teammate@example.com"></div>
      <div class="field"><label for="role">Role</label><select id="role" name="role">${roleOptions("operator")}</select></div>
      <button class="btn" type="submit">Create member</button></form>
    <p class="note">The new member gets a temporary password, shown once on this page after creation. Remiglo does not send email, so hand the password to them yourself and have them treat it as temporary. Roles: viewer reads only; operator creates payments but cannot approve batches; admin also approves and edits settings; the owner alone changes roles and deactivates members.</p>`
    : READ_ONLY_NOTE;
  const content = `
  ${card("Business profile", htable(["Field", "Value"], profileRows) + profileForm)}
  ${card("Team and permissions", htable(["Member", "Role", "State", "Added"], teamRows) + inviteForm)}`;
  return page(d, {
    active: "settings", title: "Settings", subtitle: `${merchant.name} · business profile, team and permissions`,
    merchantName: merchant.name, content, ...banners(q),
  });
}

// ---------------------------------------------------------------- Setup and login
const authPage = (title: string, inner: string, error?: string): string => shell({
  active: "settings", title, setupMode: true,
  content: `<div style="max-width:560px;margin:24px auto">${error ? `<div class="banner err">${esc(error)}</div>` : ""}${card(title, inner)}</div>`,
});

export function renderSetup(merchants: Merchant[], error?: string): string {
  if (merchants.length === 0) {
    return authPage("Set up the dashboard", `<p>No merchant exists yet, so there is nothing to attach the owner account to. Create a merchant first with <span class="mono">POST /v1/merchants</span> (see the README), then come back to this page.</p>`, error);
  }
  const options = merchants.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
  return authPage("Set up the dashboard", `
    <p>Create the owner account for this Remiglo instance. Until this step is done the dashboard stays in setup mode; afterwards every dashboard page requires a login, and the old localhost operator access no longer applies.</p>
    <form method="post" action="/dashboard/setup">
      <div class="field" style="margin-bottom:10px"><label for="merchantId">Business</label><select id="merchantId" name="merchantId">${options}</select></div>
      <div class="field" style="margin-bottom:10px"><label for="email">Owner email</label><input id="email" name="email" type="email" required placeholder="owner@example.com"></div>
      <div class="field" style="margin-bottom:14px"><label for="password">Password (at least 8 characters)</label><input id="password" name="password" type="password" required minlength="8"></div>
      <button class="btn" type="submit">Create owner account</button></form>`, error);
}

export function renderLogin(error?: string): string {
  return authPage("Sign in", `
    <form method="post" action="/dashboard/login">
      <div class="field" style="margin-bottom:10px"><label for="email">Email</label><input id="email" name="email" type="email" required></div>
      <div class="field" style="margin-bottom:14px"><label for="password">Password</label><input id="password" name="password" type="password" required></div>
      <button class="btn" type="submit">Sign in</button></form>`, error);
}
