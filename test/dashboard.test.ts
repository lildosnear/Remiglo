import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store, hashKey } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import { hashPassword, hashToken, newSessionToken, SESSION_TTL_MS } from "../src/lib/auth.js";
import type { FetchFn } from "../src/services/webhooks.js";
import type { Invoice, Payout } from "../src/lib/core.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "remiglo-vault.near",
  refundTo: "remiglo-refunds.near",
};
const USDC_NEAR = SETTLE.settlementAsset;
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const WEBHOOK_SECRET = "whsec_dashboard_test_secret";

interface Harness {
  app: ReturnType<typeof buildApp>;
  store: Store;
  mock: MockIntents;
}

const apps: Array<ReturnType<typeof buildApp>> = [];

function makeHarness(config: BuildOptions["config"] = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-dash-"));
  const store = new Store(join(dir, "test.db"));
  const mock = new MockIntents();
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  const app = buildApp({
    store, mockIntents: mock, fetchFn,
    config: { webhook: { maxAttempts: 5, baseDelayMs: 1 }, ...config },
  });
  apps.push(app);
  return { app, store, mock };
}

afterEach(async () => {
  while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); }
});


/** Create an owner user + session directly in the store and return the cookie header. */
async function dashAuth(h: Harness): Promise<{ cookie: string }> {
  const cached = (h as any)._dashCookie as string | undefined;
  if (cached) return { cookie: cached };
  const merchant = h.store.listMerchants()[0];
  const { salt, hash } = hashPassword("owner-password-1");
  const user = h.store.createUser({ merchantId: merchant.id, email: "owner@example.com", passwordHash: hash, salt, role: "owner" });
  const token = newSessionToken();
  h.store.createSession(user.id, hashToken(token), new Date(Date.now() + SESSION_TTL_MS).toISOString());
  const cookie = `remiglo_session=${token}`;
  (h as any)._dashCookie = cookie;
  return { cookie };
}

const today = () => new Date().toISOString();
let seq = 0;
const uniq = (p: string) => `${p}_test_${(seq += 1)}_${Math.random().toString(36).slice(2, 8)}`;

function seedInvoice(store: Store, merchantId: string, patch: Partial<Invoice>): Invoice {
  const inv: Invoice = {
    id: uniq("inv"), merchantId, amount: "10000000", currency: "USD",
    originAsset: USDC_NEAR, settlementAsset: USDC_NEAR,
    settlementAddress: SETTLE.settlementAddress, refundTo: SETTLE.refundTo,
    status: "open", createdAt: today(), ...patch,
  };
  return store.createInvoice(inv);
}

function seedPayout(store: Store, merchantId: string, patch: Partial<Payout>): Payout {
  const p: Payout = {
    id: uniq("pay"), merchantId, recipientAddress: "contractor.near",
    destinationAsset: USDC_NEAR, originAsset: USDC_NEAR, refundTo: SETTLE.refundTo,
    amount: "10000000", status: "awaiting_funding", createdAt: today(), ...patch,
  };
  return store.createPayout(p);
}

interface Seeded {
  merchantId: string;
  apiKey: string;
  batchId: string;
}

/**
 * Known state for count assertions:
 * invoices: 1 paid/matched 10.00, 1 open 5.00, 1 failed 2.00, 1 overpaid 12.00 observed
 * payouts: 1 settled 20.00, 1 awaiting_funding 7.00, 1 failed 3.00 (on Base)
 * => volume $42.00, successful 3, pending 2, failed 2
 */
function seedKnown(h: Harness): Seeded {
  const { merchant, apiKey } = h.store.createMerchant({ name: "Remiglo", ...SETTLE });
  const mid = merchant.id;
  h.store.createEndpoint(mid, "https://hooks.example/remiglo", WEBHOOK_SECRET);
  seedInvoice(h.store, mid, { status: "paid", reconFlag: "matched", amountOut: "10000000", observedAmount: "10000000", updatedAt: today() });
  seedInvoice(h.store, mid, { status: "open", amount: "5000000" });
  seedInvoice(h.store, mid, { status: "failed", amount: "2000000" });
  seedInvoice(h.store, mid, { status: "overpaid", reconFlag: "overpaid", amount: "10000000", amountOut: "10000000", observedAmount: "12000000", updatedAt: today() });
  seedPayout(h.store, mid, { status: "settled", amount: "20000000", updatedAt: today() });
  seedPayout(h.store, mid, { status: "awaiting_funding", amount: "7000000" });
  seedPayout(h.store, mid, { status: "failed", amount: "3000000", destinationAsset: USDC_BASE, recipientAddress: "0xabc0000000000000000000000000000000000001" });
  const batch = h.store.createBatch({
    id: uniq("batch"), merchantId: mid, status: "pending_approval",
    totalAmount: "80000000", rowCount: 2,
    rows: [
      { recipientAddress: "ama.near", destinationAsset: USDC_NEAR, amount: "40000000" },
      { recipientAddress: "tunde.near", destinationAsset: USDC_NEAR, amount: "40000000" },
    ],
    createdAt: today(),
  });
  return { merchantId: mid, apiKey, batchId: batch.id };
}

const PAGES: Array<[string, string]> = [
  ["/dashboard", "Overview"],
  ["/dashboard/payments", "Payments"],
  ["/dashboard/payouts", "Payouts"],
  ["/dashboard/recipients", "Recipients"],
  ["/dashboard/invoices", "Invoices"],
  ["/dashboard/routing", "Routing"],
  ["/dashboard/reconciliation", "Reconciliation"],
  ["/dashboard/analytics", "Analytics"],
  ["/dashboard/developers", "Developers"],
  ["/dashboard/settings", "Settings"],
];

describe("dashboard v2 pages", () => {
  it("serves every page with 200 and its title", async () => {
    const h = makeHarness();
    seedKnown(h);
    for (const [url, title] of PAGES) {
      const res = await h.app.inject({ method: "GET", url, headers: await dashAuth(h) });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain(`<title>${title} · Remiglo</title>`);
      expect(res.body, url).toContain("Remiglo");
    }
  });

  it("overview shows the four stats with the seeded numbers, the chart and Send payout", async () => {
    const h = makeHarness();
    seedKnown(h);
    const res = await h.app.inject({ method: "GET", url: "/dashboard" , headers: await dashAuth(h)});
    expect(res.statusCode).toBe(200);
    for (const label of ["Total payment volume", "Successful payments", "Pending payments", "Failed payments"]) {
      expect(res.body).toContain(label);
    }
    expect(res.body).toMatch(/Total payment volume<\/span><span class="stat-value">\$42\.00</);
    expect(res.body).toMatch(/Successful payments<\/span><span class="stat-value">3</);
    expect(res.body).toMatch(/Pending payments<\/span><span class="stat-value">2</);
    expect(res.body).toMatch(/Failed payments<\/span><span class="stat-value">2</);
    expect(res.body).toContain("<svg");
    expect(res.body).toContain("Payment volume, last 14 days");
    expect(res.body).toContain("Recent transactions");
    expect(res.body).toContain("Pending approvals");
    expect(res.body).toContain("Send payout");
    expect(res.body).toContain("Approve");
  });

  it("never renders the API key, its hash, or the webhook secret on any page", async () => {
    const h = makeHarness();
    const seeded = seedKnown(h);
    for (const [url] of PAGES) {
      const res = await h.app.inject({ method: "GET", url, headers: await dashAuth(h) });
      expect(res.body, url).not.toContain(seeded.apiKey);
      expect(res.body, url).not.toContain(hashKey(seeded.apiKey));
      expect(res.body, url).not.toContain(WEBHOOK_SECRET);
      expect(res.body, url).not.toContain("whsec_");
      expect(res.body, url).not.toContain("rgl_live_");
    }
  });

  it("payments page lists both directions and filters by status", async () => {
    const h = makeHarness();
    seedKnown(h);
    const all = await h.app.inject({ method: "GET", url: "/dashboard/payments" , headers: await dashAuth(h)});
    expect(all.body).toContain("Incoming");
    expect(all.body).toContain("Outgoing");
    expect(all.body).toContain("contractor.near");
    const failedOnly = await h.app.inject({ method: "GET", url: "/dashboard/payments?status=failed" , headers: await dashAuth(h)});
    expect(failedOnly.statusCode).toBe(200);
    expect(failedOnly.body).not.toContain("contractor.near"); // the failed payout is the Base one
    expect(failedOnly.body).toContain("0xabc0000000000000000000000000000000000001".slice(0, 26));
  });

  it("recipients page is derived from payment history", async () => {
    const h = makeHarness();
    seedKnown(h);
    const res = await h.app.inject({ method: "GET", url: "/dashboard/recipients" , headers: await dashAuth(h)});
    expect(res.body).toContain("Collected from payment history");
    expect(res.body).toContain("contractor.near");
    expect(res.body).toContain("USDC on NEAR");
    expect(res.body).toContain("USDC on Base");
  });

  it("invoices page links to the hosted payment page", async () => {
    const h = makeHarness();
    seedKnown(h);
    const res = await h.app.inject({ method: "GET", url: "/dashboard/invoices" , headers: await dashAuth(h)});
    expect(res.body).toContain("Open payment page");
    expect(res.body).toMatch(/href="\/pay\/inv_test_/);
  });

  it("routing page shows supported networks and routing activity", async () => {
    const h = makeHarness();
    seedKnown(h);
    const res = await h.app.inject({ method: "GET", url: "/dashboard/routing" , headers: await dashAuth(h)});
    expect(res.body).toContain("Supported networks and assets");
    expect(res.body).toContain("NEAR");
    expect(res.body).toContain("Base");
    expect(res.body).toContain("Routing activity");
  });

  it("reconciliation page shows the summary counts and exceptions", async () => {
    const h = makeHarness();
    seedKnown(h);
    const res = await h.app.inject({ method: "GET", url: "/dashboard/reconciliation" , headers: await dashAuth(h)});
    expect(res.body).toMatch(/Matched and settled<\/span><span class="stat-value">2</);
    expect(res.body).toMatch(/Overpaid<\/span><span class="stat-value">1</);
    expect(res.body).toMatch(/Failed or refunded<\/span><span class="stat-value">2</);
    expect(res.body).toContain("Exceptions");
    expect(res.body).toContain("/v1/reconciliation/export.csv");
  });

  it("analytics page computes fees, success rate and charts from stored data", async () => {
    const h = makeHarness();
    seedKnown(h);
    const res = await h.app.inject({ method: "GET", url: "/dashboard/analytics" , headers: await dashAuth(h)});
    // fees: 30 bps on the two paid-side invoices of 10000000 each = 60000 units = $0.06
    expect(res.body).toMatch(/Estimated fees earned<\/span><span class="stat-value">\$0\.06</);
    // terminal: invoices paid, failed, overpaid (3) + payouts settled, failed (2) = 5; success 3 => 60.0%
    expect(res.body).toMatch(/Settlement success rate<\/span><span class="stat-value">60\.0%</);
    expect(res.body).toContain("Volume by day, last 30 days");
    expect(res.body).toContain("Payments by status");
  });

  it("developers page lists the API surface without any secret", async () => {
    const h = makeHarness();
    seedKnown(h);
    const res = await h.app.inject({ method: "GET", url: "/dashboard/developers" , headers: await dashAuth(h)});
    expect(res.body).toContain("/v1/invoices");
    expect(res.body).toContain("/v1/payout-batches/:id/approve");
    expect(res.body).toContain("shown once");
    expect(res.body).toContain("hooks.example/remiglo");
  });

  it("settings page shows the business profile and the team section", async () => {
    const h = makeHarness();
    seedKnown(h);
    const res = await h.app.inject({ method: "GET", url: "/dashboard/settings" , headers: await dashAuth(h)});
    expect(res.body).toContain("Business profile");
    expect(res.body).toContain("remiglo-vault.near");
    expect(res.body).toContain("Team and permissions");
    expect(res.body).toContain("Add a team member");
    expect(res.body).toContain("owner@example.com");
  });
});

describe("dashboard v2 actions", () => {
  it("refuses a non localhost approve without the admin token, allows it with the token", async () => {
    const h = makeHarness({ adminToken: "adm-secret" });
    const seeded = seedKnown(h);
    const url = `/dashboard/actions/batches/${seeded.batchId}/approve`;
    const denied = await h.app.inject({ method: "POST", url, remoteAddress: "203.0.113.9" });
    expect(denied.statusCode).toBe(403);
    expect(h.store.getBatchById(seeded.batchId)?.status).toBe("pending_approval");
    expect(h.store.listPayouts(seeded.merchantId)).toHaveLength(3); // only the seeded payouts

    const allowed = await h.app.inject({
      method: "POST", url, remoteAddress: "203.0.113.9", headers: { "x-admin-token": "adm-secret" },
    });
    expect(allowed.statusCode).toBe(303);
    expect(h.store.getBatchById(seeded.batchId)?.status).toBe("active");
    const payouts = h.store.listPayouts(seeded.merchantId);
    expect(payouts).toHaveLength(5);
    expect(payouts.filter((p) => p.batchId === seeded.batchId)).toHaveLength(2);
  });

  it("approves a pending batch from localhost without a token and moves it out of pending", async () => {
    const h = makeHarness({ adminToken: "adm-secret" });
    const seeded = seedKnown(h);
    const res = await h.app.inject({ method: "POST", url: `/dashboard/actions/batches/${seeded.batchId}/approve` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("notice=");
    expect(h.store.getBatchById(seeded.batchId)?.status).toBe("active");
    const overview = await h.app.inject({ method: "GET", url: "/dashboard" , headers: await dashAuth(h)});
    expect(overview.body).toContain("No batches are waiting for approval.");
  });

  it("creates a single payout from the form, converting whole units and respecting the pilot cap", async () => {
    const h = makeHarness();
    const seeded = seedKnown(h);
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const ok = await h.app.inject({
      method: "POST", url: `/dashboard/actions/payouts?merchant=${seeded.merchantId}`, headers: form,
      payload: "recipientAddress=bola.near&destinationAsset=" + encodeURIComponent(USDC_NEAR) + "&amount=25.5",
    });
    expect(ok.statusCode).toBe(303);
    const created = h.store.listPayouts(seeded.merchantId).find((p) => p.recipientAddress === "bola.near");
    expect(created).toBeTruthy();
    expect(created!.amount).toBe("25500000");
    expect(created!.status).toBe("awaiting_funding");
    expect(created!.depositAddress).toMatch(/^mock_deposit_/);

    const over = await h.app.inject({
      method: "POST", url: `/dashboard/actions/payouts?merchant=${seeded.merchantId}`, headers: form,
      payload: "recipientAddress=bola.near&destinationAsset=" + encodeURIComponent(USDC_NEAR) + "&amount=150",
    });
    expect(over.statusCode).toBe(303);
    expect(over.headers.location).toContain("error=");
    expect(h.store.listPayouts(seeded.merchantId).filter((p) => p.recipientAddress === "bola.near")).toHaveLength(1);
  });

  it("creates an invoice from the form through the shared creation path", async () => {
    const h = makeHarness();
    const seeded = seedKnown(h);
    const res = await h.app.inject({
      method: "POST", url: `/dashboard/actions/invoices?merchant=${seeded.merchantId}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "amount=12.5&originAsset=" + encodeURIComponent(USDC_NEAR) + "&externalRef=INV-DASH-1",
    });
    expect(res.statusCode).toBe(303);
    const invoices = h.store.listInvoices(seeded.merchantId);
    const created = invoices.find((i) => i.externalRef === "INV-DASH-1");
    expect(created).toBeTruthy();
    expect(created!.amount).toBe("12500000");
    expect(created!.status).toBe("open");
    expect(created!.depositAddress).toMatch(/^mock_deposit_/);
  });

  it("redirects to setup before any merchant or user exists", async () => {
    const h = makeHarness();
    const res = await h.app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/dashboard/setup");
    const setup = await h.app.inject({ method: "GET", url: "/dashboard/setup" });
    expect(setup.statusCode).toBe(200);
    expect(setup.body).toContain("No merchant exists yet");
  });
});
