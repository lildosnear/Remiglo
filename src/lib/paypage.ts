import type { Invoice } from "./core.js";
import { formatAmount, type AssetInfo } from "./assets.js";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export const PAY_TERMINAL = ["paid", "partially_paid", "overpaid", "expired", "refunded", "failed", "cancelled"];

interface StateView {
  bannerClass: string;
  title: string;
  message: string;
  showInstructions: boolean;
}

function stateView(inv: Invoice, origin: AssetInfo, settle: AssetInfo): StateView {
  const expected = inv.amountOut;
  const arrived = inv.observedAmount;
  const diff = expected && arrived ? BigInt(arrived) - BigInt(expected) : undefined;
  switch (inv.status) {
    case "open":
      return { bannerClass: "waiting", title: "Waiting for your payment", message: `Send the exact amount below to the deposit address on ${origin.chainName}. This page updates on its own.`, showInstructions: true };
    case "deposit_seen":
      return { bannerClass: "progress", title: "Deposit seen", message: "We have seen your deposit on chain. Settlement is starting.", showInstructions: false };
    case "processing":
      return { bannerClass: "progress", title: "Payment on its way", message: "Your payment is being settled across chains. This can take a few minutes.", showInstructions: false };
    case "paid": {
      const settled = arrived ?? expected;
      return {
        bannerClass: "success", title: "Payment received",
        message: settled ? `Settled ${formatAmount(settled, settle)} in ${settle.symbol} on ${settle.chainName}. Thank you.` : "Your payment has settled. Thank you.",
        showInstructions: false,
      };
    }
    case "partially_paid": {
      const remains = diff !== undefined && diff < 0n ? (diff * -1n).toString() : undefined;
      return {
        bannerClass: "warn", title: "Part payment received",
        message: `${arrived ? `We received ${formatAmount(arrived, settle)}. ` : ""}${remains ? `${formatAmount(remains, settle)} is still outstanding on this invoice. Contact the business to arrange the balance.` : "Contact the business to arrange the balance."}`,
        showInstructions: false,
      };
    }
    case "overpaid": {
      const excess = diff !== undefined && diff > 0n ? diff.toString() : undefined;
      return {
        bannerClass: "warn", title: "Invoice overpaid",
        message: `${arrived ? `We received ${formatAmount(arrived, settle)}, more than this invoice asked for. ` : ""}${excess ? `The excess is ${formatAmount(excess, settle)}. ` : ""}The business will arrange any refund of the excess with you.`,
        showInstructions: false,
      };
    }
    case "expired":
      return { bannerClass: "bad", title: "This invoice has expired", message: "Do not send funds to the old deposit address. Ask the business for a fresh invoice.", showInstructions: false };
    case "refunded":
      return { bannerClass: "warn", title: "Payment refunded", message: "This payment was returned to the sender. Contact the business if you need a new invoice.", showInstructions: false };
    case "failed":
      return { bannerClass: "bad", title: "Payment failed", message: "This payment did not settle. Contact the business before trying again.", showInstructions: false };
    case "cancelled":
      return { bannerClass: "bad", title: "This invoice was cancelled", message: "The business cancelled this invoice. Do not send funds to its deposit address.", showInstructions: false };
    default:
      return { bannerClass: "waiting", title: `Status: ${inv.status}`, message: "This page updates on its own.", showInstructions: inv.status === "open" };
  }
}

const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; color: #17202a; background: #f4f7f9; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 1.2rem 1rem 2.5rem; }
  header.brand { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.6rem 0 1rem; border-bottom: 3px solid #4263EB; margin-bottom: 1rem; }
  header.brand .logo { font-size: 1.35rem; font-weight: 750; letter-spacing: 0.01em; color: #14243A; }
  header.brand .tag { color: #5a6a7a; font-size: 0.85rem; }
  .card { background: #fff; border: 1px solid #dde4ea; border-radius: 12px; padding: 1.2rem; }
  .merchant { color: #5a6a7a; font-size: 0.9rem; margin: 0 0 0.3rem; }
  .amount { font-size: 2rem; font-weight: 750; margin: 0.1rem 0; }
  .chain { color: #33475c; margin: 0.2rem 0 1rem; }
  .banner { border-radius: 10px; padding: 0.85rem 1rem; margin: 1rem 0; border: 1px solid #dde4ea; background: #f0f4f7; }
  .banner h2 { font-size: 1.05rem; margin: 0 0 0.3rem; }
  .banner p { margin: 0; color: #33475c; }
  .banner.success { background: #eafaf0; border-color: #9fd8b4; }
  .banner.progress { background: #eef4fb; border-color: #a9c6e8; }
  .banner.warn { background: #fff7e6; border-color: #e8c877; }
  .banner.bad { background: #fdeeee; border-color: #eda9a9; }
  .label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #5a6a7a; margin: 1.1rem 0 0.35rem; }
  .addr { font-family: ui-monospace, Menlo, monospace; font-size: 0.82rem; word-break: break-all; background: #f7fafc; border: 1px solid #e2e8ee; border-radius: 8px; padding: 0.7rem; }
  button.copy { margin-top: 0.55rem; width: 100%; padding: 0.7rem; font-size: 0.95rem; border-radius: 8px; border: 1px solid #17202a; background: #17202a; color: #fff; cursor: pointer; }
  .qr { text-align: center; margin: 1rem 0 0.2rem; }
  .qr svg { width: 220px; height: 220px; max-width: 70vw; }
  .meta { color: #5a6a7a; font-size: 0.88rem; }
  .meta div { margin: 0.25rem 0; }
  footer { text-align: center; color: #8494a5; font-size: 0.8rem; margin-top: 1.4rem; }
`;

/**
 * Public hosted payment page. Only customer safe fields are used here:
 * the merchant business name, amounts, the deposit address and status.
 * Never pass API keys, webhook secrets or refund addresses into this file.
 */
export function renderPayPage(inv: Invoice, merchantName: string, origin: AssetInfo, settle: AssetInfo, qrSvg: string): string {
  const view = stateView(inv, origin, settle);
  const terminal = PAY_TERMINAL.includes(inv.status);
  const instructions = view.showInstructions && inv.depositAddress ? `
    <div class="label">Send exactly</div>
    <p class="amount">${esc(formatAmount(inv.amount, origin))}</p>
    <p class="chain">Send ${esc(origin.symbol)} on ${esc(origin.chainName)} to this deposit address:</p>
    <div class="addr" id="deposit-address">${esc(inv.depositAddress)}</div>
    <button class="copy" id="copy-btn" type="button">Copy deposit address</button>
    ${qrSvg ? `<div class="qr">${qrSvg}</div><p class="meta" style="text-align:center">Scan with your wallet</p>` : ""}
  ` : "";
  const expiry = inv.expiresAt ? `
    <div>Expires: ${esc(new Date(inv.expiresAt).toUTCString())}${terminal ? "" : ` · <span id="countdown"></span>`}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay ${esc(merchantName)} · Remiglo</title><style>${STYLE}</style></head>
<body><div class="wrap">
  <header class="brand"><span class="logo">Remiglo</span><span class="tag">Business payments</span></header>
  <div class="card">
    <p class="merchant">Invoice from ${esc(merchantName)}</p>
    ${inv.externalRef ? `<p class="meta">Reference: ${esc(inv.externalRef)}</p>` : ""}
    <div class="banner ${esc(view.bannerClass)}" id="status-banner" data-status="${esc(inv.status)}">
      <h2>${esc(view.title)}</h2><p>${esc(view.message)}</p>
    </div>
    ${instructions}
    <div class="label">Invoice details</div>
    <div class="meta">
      <div>Amount due: ${esc(formatAmount(inv.amount, origin))} (${esc(origin.symbol)} on ${esc(origin.chainName)})</div>
      <div>Settles as: ${esc(settle.symbol)} on ${esc(settle.chainName)}</div>
      ${expiry}
    </div>
  </div>
  <footer>Powered by Remiglo · Payments settle through NEAR Intents</footer>
</div>
<script>
(function () {
  var status = ${JSON.stringify(inv.status)};
  var terminal = ${JSON.stringify(PAY_TERMINAL)};
  ${inv.expiresAt && !terminal ? `
  var deadline = new Date(${JSON.stringify(inv.expiresAt)}).getTime();
  var cd = document.getElementById("countdown");
  function tick() {
    var left = deadline - Date.now();
    if (left <= 0) { if (cd) cd.textContent = "expired"; location.reload(); return; }
    var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    if (cd) cd.textContent = m + "m " + String(s).padStart(2, "0") + "s left";
  }
  tick(); setInterval(tick, 1000);` : ""}
  var copyBtn = document.getElementById("copy-btn");
  if (copyBtn) copyBtn.addEventListener("click", function () {
    var text = document.getElementById("deposit-address").textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { copyBtn.textContent = "Copied"; });
    else { copyBtn.textContent = text; }
  });
  if (terminal.indexOf(status) === -1) {
    setInterval(function () {
      fetch("/pay/${esc(inv.id)}/status").then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.status && j.status !== status) location.reload();
      }).catch(function () {});
    }, 10000);
  }
})();
</script>
</body></html>`;
}

export function renderPayNotFound(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice not found · Remiglo</title><style>${STYLE}</style></head>
<body><div class="wrap">
  <header class="brand"><span class="logo">Remiglo</span><span class="tag">Business payments</span></header>
  <div class="card">
    <div class="banner bad"><h2>Invoice not found</h2>
    <p>This payment link does not match any invoice. Check the link with the business that sent it.</p></div>
  </div>
  <footer>Powered by Remiglo</footer>
</div></body></html>`;
}
