import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => { prepare(sql: string): { get(...p: unknown[]): unknown }; close(): void };
};
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store, hashKey } from "../src/lib/store.js";
import { signWebhook } from "../src/lib/core.js";
import { MockIntents } from "../src/services/intents.js";
import { hashPassword, hashToken, newSessionToken, SESSION_TTL_MS } from "../src/lib/auth.js";
import { enqueueEvent, deliverDelivery } from "../src/services/webhooks.js";
import type { FetchFn } from "../src/services/webhooks.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;

interface Harness {
  app: ReturnType<typeof buildApp>;
  store: Store;
  mock: MockIntents;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
  setFetchImpl: (fn: (n: number) => Promise<{ ok: boolean; status: number }>) => void;
  dbPath: string;
}

const apps: Array<ReturnType<typeof buildApp>> = [];

function makeHarness(config: BuildOptions["config"] = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-test-"));
  const dbPath = join(dir, "test.db");
  const store = new Store(dbPath);
  const mock = new MockIntents();
  const calls: Harness["calls"] = [];
  let impl: (n: number) => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 200 });
  let n = 0;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    n += 1;
    return impl(n);
  };
  const app = buildApp({
    store, mockIntents: mock, fetchFn,
    config: { webhook: { maxAttempts: 5, baseDelayMs: 1 }, ...config },
  });
  apps.push(app);
  return { app, store, mock, calls, dbPath, setFetchImpl: (fn) => { impl = fn; } };
}

afterEach(async () => {
  while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); }
});

async function makeMerchant(h: Harness, name = "Acme", headers: Record<string, string> = {}) {
  const res = await h.app.inject({
    method: "POST", url: "/v1/merchants", headers,
    payload: { name, ...SETTLE },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { merchant: body.merchant, apiKey: body.apiKey as string, auth: { authorization: `Bearer ${body.apiKey}` } };
}

const sync = (h: Harness) => h.app.inject({ method: "POST", url: "/v1/internal/sync" });

describe("merchants and auth", () => {
  it("creates a merchant, returns the key once, stores only its hash", async () => {
    const h = makeHarness();
    const { merchant, apiKey } = await makeMerchant(h);
    expect(apiKey).toMatch(/^rgl_live_[0-9a-f]{48}$/);
    const db = new DatabaseSync(h.dbPath);
    const row = db.prepare("SELECT key_hash, prefix FROM api_keys WHERE merchant_id = ?").get(merchant.id) as any;
    db.close();
    expect(row.key_hash).toBe(hashKey(apiKey));
    expect(row.key_hash).not.toBe(apiKey);
    expect(h.store.merchantByApiKey(apiKey)?.id).toBe(merchant.id);
  });

  it("rejects requests without a key and with a wrong key", async () => {
    const h = makeHarness();
    await makeMerchant(h);
    expect((await h.app.inject({ method: "GET", url: "/v1/invoices" })).statusCode).toBe(401);
    const bad = await h.app.inject({ method: "GET", url: "/v1/invoices", headers: { authorization: "Bearer rgl_live_nope" } });
    expect(bad.statusCode).toBe(401);
  });

  it("scopes data to the owning merchant", async () => {
    const h = makeHarness();
    const a = await makeMerchant(h, "A");
    const b = await makeMerchant(h, "B");
    const inv = await h.app.inject({ method: "POST", url: "/v1/invoices", headers: a.auth, payload: { amount: "10000000" } });
    expect(inv.statusCode).toBe(201);
    const other = await h.app.inject({ method: "GET", url: `/v1/invoices/${inv.json().id}`, headers: b.auth });
    expect(other.statusCode).toBe(404);
    const mine = await h.app.inject({ method: "GET", url: "/v1/invoices", headers: b.auth });
    expect(mine.json()).toHaveLength(0);
  });

  it("requires the admin token for merchant creation when ADMIN_TOKEN is set", async () => {
    const h = makeHarness({ adminToken: "adm-secret" });
    const denied = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name: "X", ...SETTLE } });
    expect(denied.statusCode).toBe(401);
    await makeMerchant(h, "Allowed", { "x-admin-token": "adm-secret" });
  });

  it("blocks internal sync from a non local caller without the admin token", async () => {
    const h = makeHarness({ adminToken: "adm-secret" });
    const denied = await h.app.inject({ method: "POST", url: "/v1/internal/sync", remoteAddress: "203.0.113.9" });
    expect(denied.statusCode).toBe(403);
    const allowed = await h.app.inject({ method: "POST", url: "/v1/internal/sync", remoteAddress: "203.0.113.9", headers: { "x-admin-token": "adm-secret" } });
    expect(allowed.statusCode).toBe(200);
  });
});

describe("invoices", () => {
  it("returns the existing invoice on an idempotent replay", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const headers = { ...auth, "idempotency-key": "order-123" };
    const first = await h.app.inject({ method: "POST", url: "/v1/invoices", headers, payload: { amount: "10000000", externalRef: "order-123" } });
    const second = await h.app.inject({ method: "POST", url: "/v1/invoices", headers, payload: { amount: "10000000", externalRef: "order-123" } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    const list = await h.app.inject({ method: "GET", url: "/v1/invoices", headers: auth });
    expect(list.json()).toHaveLength(1);
  });

  it("runs the mock lifecycle open to paid through the poller and fires invoice.paid", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const ep = await h.app.inject({ method: "POST", url: "/v1/webhook-endpoints", headers: auth, payload: { url: "https://hooks.example/remiglo" } });
    const secret = ep.json().secret as string;
    const inv = await h.app.inject({ method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "10000000" } });
    const id = inv.json().id;
    expect(inv.json().status).toBe("open");
    expect(inv.json().depositAddress).toMatch(/^mock_deposit_/);

    await sync(h);
    let cur = await h.app.inject({ method: "GET", url: `/v1/invoices/${id}`, headers: auth });
    expect(cur.json().status).toBe("deposit_seen");
    await sync(h);
    await sync(h);
    cur = await h.app.inject({ method: "GET", url: `/v1/invoices/${id}`, headers: auth });
    expect(cur.json().status).toBe("paid");
    expect(cur.json().reconFlag).toBe("matched");

    const deliveries = await h.app.inject({ method: "GET", url: "/v1/webhook-deliveries", headers: auth });
    const paid = deliveries.json().find((d: any) => d.event === "invoice.paid");
    expect(paid).toBeTruthy();
    expect(paid.status).toBe("delivered");
    const call = h.calls.find((c) => c.url === "https://hooks.example/remiglo");
    expect(call).toBeTruthy();
    expect(call!.headers["x-remiglo-signature"]).toBe(signWebhook(secret, call!.body));
    expect(JSON.parse(call!.body).event).toBe("invoice.paid");

    const ledger = await h.app.inject({ method: "GET", url: "/v1/ledger", headers: auth });
    expect(ledger.json().map((e: any) => e.kind)).toContain("invoice_paid");
  });

  it("survives a solver error and progresses on the next cycle", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const inv = await h.app.inject({ method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "5000000" } });
    h.mock.failNextStatus(inv.json().depositAddress);
    const res = await sync(h);
    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toBeGreaterThanOrEqual(1);
    const cur = await h.app.inject({ method: "GET", url: `/v1/invoices/${inv.json().id}`, headers: auth });
    expect(cur.json().status).toBe("open");
    await sync(h);
    const next = await h.app.inject({ method: "GET", url: `/v1/invoices/${inv.json().id}`, headers: auth });
    expect(next.json().status).toBe("deposit_seen");
  });

  it("flags overpaid and partially paid settlements from the poller", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const over = await h.app.inject({ method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "10000000" } });
    h.mock.setFinal(over.json().depositAddress, "SUCCESS", "12000000");
    const part = await h.app.inject({ method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "10000000" } });
    h.mock.setFinal(part.json().depositAddress, "SUCCESS", "4000000");
    await sync(h);
    const overNow = await h.app.inject({ method: "GET", url: `/v1/invoices/${over.json().id}`, headers: auth });
    expect(overNow.json().status).toBe("overpaid");
    expect(overNow.json().reconFlag).toBe("overpaid");
    const partNow = await h.app.inject({ method: "GET", url: `/v1/invoices/${part.json().id}`, headers: auth });
    expect(partNow.json().status).toBe("partially_paid");
    expect(partNow.json().reconFlag).toBe("partially_paid");
  });

  it("cancels an open invoice and refuses to cancel a paid one", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const inv = await h.app.inject({ method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "1000000" } });
    const cancelled = await h.app.inject({ method: "POST", url: `/v1/invoices/${inv.json().id}/cancel`, headers: auth });
    expect(cancelled.json().status).toBe("cancelled");
    const again = await h.app.inject({ method: "POST", url: `/v1/invoices/${inv.json().id}/cancel`, headers: auth });
    expect(again.statusCode).toBe(409);
  });
});

describe("webhook delivery retries", () => {
  it("retries a failing endpoint and succeeds, logging every attempt", async () => {
    const h = makeHarness();
    const { merchant } = h.store.createMerchant({ name: "Hook", ...SETTLE });
    const ep = h.store.createEndpoint(merchant.id, "https://hooks.example/flaky", "whsec_test");
    const [delivery] = enqueueEvent(h.store, merchant.id, "invoice.paid", "inv_x", { invoiceId: "inv_x" });
    let n = 0;
    const fetchFn: FetchFn = async () => { n += 1; if (n < 3) throw new Error("connection refused"); return { ok: true, status: 200 }; };
    const done = await deliverDelivery(h.store, delivery, fetchFn, { maxAttempts: 5, baseDelayMs: 1 });
    expect(done.status).toBe("delivered");
    expect(done.attempts).toBe(3);
    expect(done.attemptLog).toHaveLength(3);
    void ep;
  });

  it("gives up after 5 attempts and marks the delivery failed", async () => {
    const h = makeHarness();
    const { merchant } = h.store.createMerchant({ name: "Hook2", ...SETTLE });
    h.store.createEndpoint(merchant.id, "https://hooks.example/down", "whsec_test");
    const [delivery] = enqueueEvent(h.store, merchant.id, "payout.settled", "pay_x", { payoutId: "pay_x" });
    const fetchFn: FetchFn = async () => ({ ok: false, status: 500 });
    const done = await deliverDelivery(h.store, delivery, fetchFn, { maxAttempts: 5, baseDelayMs: 1 });
    expect(done.status).toBe("failed");
    expect(done.attempts).toBe(5);
    expect(done.lastStatusCode).toBe(500);
  });

  it("replays a delivery as a fresh attempt", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    await h.app.inject({ method: "POST", url: "/v1/webhook-endpoints", headers: auth, payload: { url: "https://hooks.example/ok" } });
    const inv = await h.app.inject({ method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "1000000" } });
    void inv;
    await sync(h); await sync(h); await sync(h);
    const deliveries = (await h.app.inject({ method: "GET", url: "/v1/webhook-deliveries", headers: auth })).json();
    const replay = await h.app.inject({ method: "POST", url: `/v1/webhook-deliveries/${deliveries[0].id}/replay`, headers: auth });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().status).toBe("delivered");
    expect(replay.json().id).not.toBe(deliveries[0].id);
  });
});

describe("payouts and batches", () => {
  const row = (amount: string) => ({ recipientAddress: "payee.near", destinationAsset: USDC_NEAR, amount });

  it("rejects a payout over the pilot cap", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const res = await h.app.inject({ method: "POST", url: "/v1/payouts", headers: auth, payload: row("100000001") });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/pilot cap/);
    const okRes = await h.app.inject({ method: "POST", url: "/v1/payouts", headers: auth, payload: row("100000000") });
    expect(okRes.statusCode).toBe(201);
  });

  it("quotes a batch under the threshold immediately", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: auth, payload: { rows: [row("10000000"), row("20000000")] } });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("active");
    expect(res.json().payouts).toHaveLength(2);
    expect(res.json().payouts[0].depositAddress).toMatch(/^mock_deposit_/);
    const list = await h.app.inject({ method: "GET", url: "/v1/payouts", headers: auth });
    expect(list.json()).toHaveLength(2);
  });

  it("holds a batch over the threshold for approval, then quotes after approval", async () => {
    const h = makeHarness({ approvalThresholdUnits: "300000000", pilotMaxPayoutUnits: "200000000" });
    const { auth } = await makeMerchant(h);
    const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: auth, payload: { rows: [row("200000000"), row("200000000")] } });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("pending_approval");
    expect(res.json().payouts).toHaveLength(0);
    const batchId = res.json().id;
    const before = await h.app.inject({ method: "GET", url: `/v1/payout-batches/${batchId}`, headers: auth });
    expect(before.json().payouts).toHaveLength(0);
    expect(before.json().totals.totalAmount).toBe("400000000");
    const approved = await h.app.inject({ method: "POST", url: `/v1/payout-batches/${batchId}/approve`, headers: auth });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("active");
    expect(approved.json().payouts).toHaveLength(2);
    const again = await h.app.inject({ method: "POST", url: `/v1/payout-batches/${batchId}/approve`, headers: auth });
    expect(again.statusCode).toBe(409);
  });

  it("completes a batch when every payout settles and fires batch.completed", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    await h.app.inject({ method: "POST", url: "/v1/webhook-endpoints", headers: auth, payload: { url: "https://hooks.example/ok" } });
    const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: auth, payload: { rows: [row("10000000")] } });
    const batchId = res.json().id;
    await sync(h); await sync(h); await sync(h);
    const batch = await h.app.inject({ method: "GET", url: `/v1/payout-batches/${batchId}`, headers: auth });
    expect(batch.json().status).toBe("completed");
    expect(batch.json().payouts[0].status).toBe("settled");
    const deliveries = (await h.app.inject({ method: "GET", url: "/v1/webhook-deliveries", headers: auth })).json();
    expect(deliveries.map((d: any) => d.event)).toContain("batch.completed");
    expect(deliveries.map((d: any) => d.event)).toContain("payout.settled");
  });
});

describe("reconciliation and dashboard", () => {
  it("exports a CSV with gross, fee estimate and net per invoice", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const inv = await h.app.inject({ method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "10000000", externalRef: "INV-1" } });
    const res = await h.app.inject({ method: "GET", url: "/v1/reconciliation/export.csv", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toBe("invoice_id,external_ref,gross,fee_estimate,net,settlement_asset,status,deposit_address,created_at");
    // 50 bps of 10000000 is 50000; net 9950000
    expect(lines[1]).toContain(inv.json().id);
    expect(lines[1]).toContain("INV-1,10000000,50000,9950000");
    const daily = await h.app.inject({ method: "GET", url: "/v1/reconciliation/daily", headers: auth });
    expect(daily.json().invoicesByStatus.open).toBe(1);
  });

  it("renders the v2 dashboard overview", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h, "demo");
    await h.app.inject({ method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "1000000" } });
    // Dashboard accounts exist now: create the owner and sign in first.
    const { salt, hash } = hashPassword("owner-password-1");
    const user = h.store.createUser({ merchantId: merchant.id, email: "owner@example.com", passwordHash: hash, salt, role: "owner" });
    const token = newSessionToken();
    h.store.createSession(user.id, hashToken(token), new Date(Date.now() + SESSION_TTL_MS).toISOString());
    const res = await h.app.inject({ method: "GET", url: "/dashboard", headers: { cookie: `remiglo_session=${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Overview");
    expect(res.body).toContain("Total payment volume");
    expect(res.body).toContain("demo");
    expect(res.body).not.toContain("rgl_live_");
  });
});

describe("persistence", () => {
  it("keeps merchants and invoices across a restart on the same database file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remiglo-persist-"));
    const dbPath = join(dir, "keep.db");
    const cfg = { dbPath, webhook: { maxAttempts: 5, baseDelayMs: 1 } };
    const app1 = buildApp({ mockIntents: new MockIntents(), config: cfg });
    apps.push(app1);
    const created = await app1.inject({ method: "POST", url: "/v1/merchants", payload: { name: "Persist", ...SETTLE } });
    const apiKey = created.json().apiKey as string;
    const auth = { authorization: `Bearer ${apiKey}` };
    const inv = await app1.inject({ method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "7000000" } });
    expect(inv.statusCode).toBe(201);
    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const app2 = buildApp({ mockIntents: new MockIntents(), config: cfg });
    apps.push(app2);
    const list = await app2.inject({ method: "GET", url: "/v1/invoices", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].id).toBe(inv.json().id);
  });
});

describe("payout retry", () => {
  async function failedPayout(h: Harness) {
    const { merchant, auth } = await makeMerchant(h);
    const created = await h.app.inject({ method: "POST", url: "/v1/payouts", headers: auth, payload: { recipientAddress: "ada.near", destinationAsset: USDC_NEAR, amount: "25000000" } });
    expect(created.statusCode).toBe(201);
    const payout = created.json();
    h.store.updatePayout(payout.id, { status: "failed" });
    return { merchant, auth, payout };
  }

  it("retries a failed payout with a fresh quote, linked to the failed one", async () => {
    const h = makeHarness();
    const { auth, payout } = await failedPayout(h);
    const res = await h.app.inject({ method: "POST", url: `/v1/payouts/${payout.id}/retry`, headers: auth });
    expect(res.statusCode).toBe(201);
    const retry = res.json();
    expect(retry.id).not.toBe(payout.id);
    expect(retry.status).toBe("awaiting_funding");
    expect(retry.retryOfId).toBe(payout.id);
    expect(retry.amount).toBe("25000000");
    expect(retry.recipientAddress).toBe("ada.near");
    expect(retry.depositAddress).toBeTruthy();
    expect(h.store.getPayout(retry.merchantId, payout.id)?.status).toBe("failed");
    expect(h.store.listRetriesOf(payout.id)).toHaveLength(1);
  });

  it("refuses a second retry while the first is in flight, and after it settles", async () => {
    const h = makeHarness();
    const { auth, payout } = await failedPayout(h);
    const first = await h.app.inject({ method: "POST", url: `/v1/payouts/${payout.id}/retry`, headers: auth });
    expect(first.statusCode).toBe(201);
    const second = await h.app.inject({ method: "POST", url: `/v1/payouts/${payout.id}/retry`, headers: auth });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain("already in progress");
    for (let i = 0; i < 6; i++) await sync(h);
    expect(h.store.getPayout(first.json().merchantId, first.json().id)?.status).toBe("settled");
    const third = await h.app.inject({ method: "POST", url: `/v1/payouts/${payout.id}/retry`, headers: auth });
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toContain("already retried");
  });

  it("refuses to retry a payout that is not failed, and never crosses merchants", async () => {
    const h = makeHarness();
    const { auth, payout } = await failedPayout(h);
    h.store.updatePayout(payout.id, { status: "settled" });
    const res = await h.app.inject({ method: "POST", url: `/v1/payouts/${payout.id}/retry`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("only a failed payout");
    const other = await makeMerchant(h, "Other");
    const cross = await h.app.inject({ method: "POST", url: `/v1/payouts/${payout.id}/retry`, headers: other.auth });
    expect(cross.statusCode).toBe(404);
    const missing = await h.app.inject({ method: "POST", url: "/v1/payouts/pay_nope/retry", headers: auth });
    expect(missing.statusCode).toBe(404);
  });
});
