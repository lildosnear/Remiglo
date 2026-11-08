/**
 * Shared shell for the Remiglo business dashboard (v2).
 * Design per docs/DASHBOARD-DESIGN.md: Stripe simplicity, Modern
 * Treasury operations. Light content on white and very light grey,
 * deep navy sidebar #14243A, accent #4263EB, success #16A36A, Inter.
 * Everything is server rendered; charts are inline SVG; no frontend
 * dependencies and no external font or chart services at runtime.
 */

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export interface NavItem { key: string; label: string; href: string }

export const NAV: NavItem[] = [
  { key: "overview", label: "Overview", href: "/dashboard" },
  { key: "payments", label: "Payments", href: "/dashboard/payments" },
  { key: "payouts", label: "Payouts", href: "/dashboard/payouts" },
  { key: "recipients", label: "Recipients", href: "/dashboard/recipients" },
  { key: "invoices", label: "Invoices", href: "/dashboard/invoices" },
  { key: "schedules", label: "Schedules", href: "/dashboard/schedules" },
  { key: "routing", label: "Routing", href: "/dashboard/routing" },
  { key: "reconciliation", label: "Reconciliation", href: "/dashboard/reconciliation" },
  { key: "analytics", label: "Analytics", href: "/dashboard/analytics" },
  { key: "developers", label: "Developers", href: "/dashboard/developers" },
  { key: "settings", label: "Settings", href: "/dashboard/settings" },
];

const CSS = `
:root {
  --navy: #14243A; --accent: #4263EB; --success: #16A36A;
  --amber: #B7791F; --amber-bg: #FDF3E0; --red: #C93A3A; --red-bg: #FDECEC;
  --green-bg: #E6F5EE; --grey-bg: #EEF1F5;
  --bg: #F7F8FA; --card: #FFFFFF; --border: #E3E8EF;
  --ink: #14243A; --muted: #5D6B7E; --sidebar-ink: #C7D2E0;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--ink); font-size: 14px; }
.layout { display: flex; min-height: 100vh; }
.sidebar { width: 232px; flex: 0 0 232px; background: var(--navy); color: #fff; padding: 20px 0; position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; }
.wordmark { font-size: 20px; font-weight: 700; letter-spacing: .2px; padding: 0 20px; }
.brandlogo { width: 168px; display: block; margin: 2px 20px 6px; }
.wordmark-sub { color: var(--sidebar-ink); font-size: 12px; padding: 2px 20px 18px; }
.sidebar nav { display: flex; flex-direction: column; gap: 2px; padding: 0 10px; }
.sidebar nav a { color: var(--sidebar-ink); text-decoration: none; padding: 8px 10px; border-radius: 6px; font-size: 13.5px; border-left: 3px solid transparent; }
.sidebar nav a:hover { color: #fff; background: rgba(255,255,255,.06); }
.sidebar nav a.active { color: #fff; background: rgba(66,99,235,.28); border-left-color: var(--accent); font-weight: 600; }
.sidebar .foot { margin-top: auto; padding: 14px 20px 0; color: var(--sidebar-ink); font-size: 12px; border-top: 1px solid rgba(255,255,255,.12); }
.foot-user { display: flex; align-items: center; gap: 10px; }
.avatar { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 50%; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; text-transform: uppercase; }
.foot-user .who { min-width: 0; }
.foot-user .who .name { color: #fff; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot-user .who .role { color: var(--sidebar-ink); font-size: 11.5px; }
.main { flex: 1; min-width: 0; padding: 26px 30px 40px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
.page-head h1, .topbar h1 { font-size: 22px; margin: 0; font-weight: 650; }
.page-head .sub, .topbar .sub { color: var(--muted); margin-top: 4px; }
.topbar-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pill { display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--green-bg); color: #0C5C3C; border: 1px solid #BFE6D2; white-space: nowrap; }
.pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--success); }
.pill.setup { background: var(--amber-bg); color: #7E5A10; border-color: #EDD9A8; }
.pill.setup::before { background: var(--amber); }
.btn { display: inline-block; background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 8px 14px; font-size: 13.5px; font-weight: 600; text-decoration: none; cursor: pointer; }
.btn:hover { background: #3453cc; }
.btn.secondary { background: #fff; color: var(--navy); border: 1px solid var(--border); }
.btn.small { padding: 5px 10px; font-size: 12.5px; }
.banner { border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; font-size: 13.5px; }
.banner.ok { background: var(--green-bg); border: 1px solid #BFE6D2; color: #0C5C3C; }
.banner.err { background: var(--red-bg); border: 1px solid #F3C2C2; color: #7E2323; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 18px; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(20,36,58,.04); }
.stat-label { display: block; color: var(--muted); font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.stat-value { display: block; font-size: 24px; font-weight: 700; margin-top: 6px; }
.stat-sub { display: block; color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.delta { display: inline-block; font-weight: 700; font-size: 12px; margin-right: 6px; }
.delta.up { color: var(--success); }
.delta.down { color: var(--red); }
.delta.flat { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; }
.grid-2 { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 14px; align-items: start; }
@media (max-width: 1080px) { .grid-2 { grid-template-columns: 1fr; } }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; box-shadow: 0 1px 2px rgba(20,36,58,.04); margin-bottom: 14px; }
.card h2 { font-size: 15px; margin: 0 0 14px; font-weight: 650; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.card h3 { font-size: 13.5px; margin: 16px 0 8px; font-weight: 650; }
.empty { color: var(--muted); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 7px 8px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; padding-top: 9px; padding-bottom: 9px; }
tbody tr { transition: background .08s ease; }
tbody tr:hover { background: #F2F5FB; }
tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.chip.success { background: var(--green-bg); color: var(--success); }
.chip.pending { background: var(--amber-bg); color: var(--amber); }
.chip.failed { background: var(--red-bg); color: var(--red); }
.chip.neutral { background: var(--grey-bg); color: var(--muted); }
form.inline-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-size: 12.5px; color: var(--muted); font-weight: 600; }
.field input, .field select { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13.5px; background: #fff; min-width: 180px; }
a { color: var(--accent); }
.note { color: var(--muted); font-size: 12.5px; }
.legend { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 8px; }
@media (max-width: 860px) {
  .layout { flex-direction: column; }
  .sidebar { width: 100%; flex: none; height: auto; position: static; }
  .sidebar nav { flex-direction: row; flex-wrap: wrap; }
  .main { padding: 18px 14px 32px; }
}
`;

export interface ShellOptions {
  active: string;
  title: string;
  subtitle?: string;
  merchantName?: string;
  notice?: string;
  error?: string;
  actions?: string;
  content: string;
  /** Pre account mode: no dashboard users exist yet (Slice F). */
  setupMode?: boolean;
  /** Signed in dashboard user, when session auth is active. */
  userLabel?: string;
  userRole?: string;
}

/** Full dashboard page: navy sidebar + light content area with a top bar. */
export function shell(o: ShellOptions): string {
  const nav = NAV.map((n) =>
    `<a href="${n.href}"${n.key === o.active ? ' class="active"' : ""}>${esc(n.label)}</a>`).join("");
  const banners = [
    o.notice ? `<div class="banner ok">${esc(o.notice)}</div>` : "",
    o.error ? `<div class="banner err">${esc(o.error)}</div>` : "",
  ].join("");
  const initial = esc((o.merchantName ?? "R").trim().charAt(0) || "R");
  const who = o.userLabel ?? o.merchantName ?? "";
  const roleLine = o.userRole ? `${o.userRole} · signed in` : "Merchant account";
  const foot = who
    ? `<div class="foot"><div class="foot-user"><div class="avatar">${initial}</div><div class="who"><div class="name">${esc(who)}</div><div class="role">${esc(roleLine)}</div></div></div></div>`
    : "";
  const pill = o.setupMode
    ? `<span class="pill setup">Setup mode</span>`
    : `<span class="pill">Operational</span>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · Remiglo</title><style>${CSS}</style></head>
<body><div class="layout">
  <aside class="sidebar">
    <img class="brandlogo" src="/brand/logo.png" alt="Remiglo">
    <div class="wordmark-sub">Business payments infrastructure</div>
    <nav>${nav}</nav>
    ${foot}
  </aside>
  <main class="main">
    <div class="topbar"><div><h1>${esc(o.title)}</h1>${o.subtitle ? `<div class="sub">${esc(o.subtitle)}</div>` : ""}</div><div class="topbar-right">${pill}${o.actions ?? ""}</div></div>
    ${banners}
    ${o.content}
  </main>
</div></body></html>`;
}

const SUCCESS = new Set(["paid", "overpaid", "settled", "completed", "delivered", "matched"]);
const PENDING = new Set(["open", "deposit_seen", "processing", "awaiting_funding", "funded", "quoted", "pending_approval", "pending", "partially_paid", "active"]);
const FAILED = new Set(["failed", "refunded"]);

export function chip(status: string): string {
  const kind = SUCCESS.has(status) ? "success" : PENDING.has(status) ? "pending" : FAILED.has(status) ? "failed" : "neutral";
  const label = status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return `<span class="chip ${kind}">${esc(label)}</span>`;
}

export interface Delta { pct: number; vsLabel: string }

/**
 * Stat card. The delta is only rendered when the caller computed one
 * from a real previous period; pass undefined to hide it (no prior data).
 */
export function statCard(label: string, value: string, sub?: string, delta?: Delta): string {
  let deltaHtml = "";
  if (delta) {
    const cls = delta.pct > 0 ? "up" : delta.pct < 0 ? "down" : "flat";
    const arrow = delta.pct > 0 ? "▲" : delta.pct < 0 ? "▼" : "■";
    const pct = `${delta.pct > 0 ? "+" : ""}${delta.pct.toFixed(1)}%`;
    deltaHtml = `<span class="delta ${cls}">${arrow} ${pct}</span>`;
  }
  const subHtml = (sub || deltaHtml)
    ? `<span class="stat-sub">${deltaHtml}${sub ? esc(sub) : ""}${delta ? ` <span>vs ${esc(delta.vsLabel)}</span>` : ""}</span>`
    : "";
  return `<div class="stat"><span class="stat-label">${esc(label)}</span><span class="stat-value">${esc(value)}</span>${subHtml}</div>`;
}

export function card(title: string, inner: string): string {
  return `<section class="card"><h2>${esc(title)}</h2>${inner}</section>`;
}

/**
 * Table where cells are already-HTML strings. Callers must esc() any
 * stored or user supplied text before putting it in a cell.
 */
export function htable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return `<p class="empty">None yet.</p>`;
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export interface BarPoint { label: string; units: bigint }

/** Vertical bar chart of daily totals (units are 6 decimal USD units). */
export function barChartSvg(points: BarPoint[], fmt: (units: bigint) => string): string {
  const W = 720, H = 210, base = 178, top = 26;
  const max = points.reduce((a, p) => (p.units > a ? p.units : a), 0n);
  const slot = W / Math.max(points.length, 1);
  const bw = Math.min(34, slot * 0.62);
  const bars = points.map((p, i) => {
    const h = max === 0n ? 2 : Math.max(2, Number((p.units * BigInt(base - top)) / (max === 0n ? 1n : max)));
    const x = i * slot + (slot - bw) / 2;
    const y = base - h;
    const val = p.units > 0n ? `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${y - 5}" text-anchor="middle" font-size="9.5" fill="#5D6B7E">${esc(fmt(p.units))}</text>` : "";
    const lab = i % Math.ceil(points.length / 10) === 0 || points.length <= 14
      ? `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${base + 15}" text-anchor="middle" font-size="9.5" fill="#5D6B7E">${esc(p.label)}</text>` : "";
    return `${val}<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${h}" rx="3" fill="#4263EB"></rect>${lab}`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Payment volume chart"><line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="#E3E8EF"></line>${bars}</svg>`;
}

/** Horizontal bars for grouped totals, with a text legend column. */
export function hBarSvg(rows: Array<{ label: string; units: bigint; display: string }>): string {
  if (rows.length === 0) return `<p class="empty">None yet.</p>`;
  const max = rows.reduce((a, r) => (r.units > a ? r.units : a), 0n);
  const W = 720, rowH = 30;
  const body = rows.map((r, i) => {
    const w = max === 0n ? 0 : Number((r.units * 380n) / max);
    const y = i * rowH;
    return `<text x="0" y="${y + 15}" font-size="12" fill="#14243A">${esc(r.label)}</text>` +
      `<rect x="170" y="${y + 4}" width="${Math.max(w, r.units > 0n ? 3 : 0)}" height="14" rx="3" fill="#4263EB"></rect>` +
      `<text x="${178 + Math.max(w, 0)}" y="${y + 15}" font-size="12" fill="#5D6B7E">${esc(r.display)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${rows.length * rowH}" width="100%" role="img">${body}</svg>`;
}

const DONUT_COLORS = ["#4263EB", "#16A36A", "#E8A33D", "#C93A3A", "#14243A", "#9AA7B4", "#7C5CE0", "#2AA5A0"];

/** Donut chart of counts by status, with legend. */
export function donutSvg(segments: Array<{ label: string; value: number }>): string {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (total === 0) return `<p class="empty">None yet.</p>`;
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  const circles = segments.filter((s) => s.value > 0).map((s, i) => {
    const frac = s.value / total;
    const el = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${DONUT_COLORS[i % DONUT_COLORS.length]}" stroke-width="20" stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset * C).toFixed(2)}" transform="rotate(-90 70 70)"></circle>`;
    offset += frac;
    return el;
  }).join("");
  const legend = segments.map((s, i) =>
    `<div><span class="swatch" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></span>${esc(s.label)} — ${s.value}</div>`).join("");
  return `<div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">
    <svg viewBox="0 0 140 140" width="150" height="150" role="img">${circles}<text x="70" y="76" text-anchor="middle" font-size="20" font-weight="700" fill="#14243A">${total}</text></svg>
    <div class="legend">${legend}</div></div>`;
}
