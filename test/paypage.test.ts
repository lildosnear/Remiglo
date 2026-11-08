import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import type { FetchFn } from "../src/services/webhooks.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant-vault.near",
  refundTo: "merchant-refunds.near",
};

const apps: Array<ReturnType<typeof buildApp>> = [];

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-pay-"));
  const store = new Store(join(dir, "test.db"));
  const mock = new MockIntents();
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  const app = buildApp({ store, mockIntents: mock, fetchFn, config: { webhook: { maxAttempts: 5, baseDelayMs: 1 } } });
  apps.push(app);
  return { app, store, mock };
}

afterEach(async () => {
  while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); }
});

async function makeMerchant(h: ReturnType<typeof makeHarness>) {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name: "Acme Studio", ...SETTLE } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { apiKey: body.apiKey as string, auth: { authorization: `Bearer ${body.apiKey}` } };
}

async function makeInvoice(h: ReturnType<typeof makeHarness>, auth: Record<string, string>, amount = "10000000") {
  const res = await h.app.inject({
    method: "POST", url: "/v1/invoices", headers: auth,
    payload: { amount, externalRef: "INV-42" },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const sync = (h: ReturnType<typeof makeHarness>) => h.app.inject({ method: "POST", url: "/v1/internal/sync" });

describe("hosted payment page", () => {
  it("renders an open invoice with deposit address, formatted amount and QR svg", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const inv = await makeInvoice(h, auth);
    expect(inv.paymentUrl).toBe(`/pay/${inv.id}`);

    const res = await h.app.inject({ method: "GET", url: inv.paymentUrl });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Acme Studio"); // merchant business name
    expect(res.body).toContain("mock_deposit_1"); // deposit address
    expect(res.body).toContain("10.00 USDC"); // formatted from 10000000 at 6 decimals
    expect(res.body).toContain("NEAR"); // plain words chain name
    expect(res.body).toContain("INV-42"); // invoice reference
    expect(res.body).toContain("<svg"); // server side QR code
    expect(res.body).toContain("Waiting for your payment");
    expect(res.body).toContain(`/pay/${inv.id}/status`); // polling wired up
  });

  it("never exposes the API key, webhook secret or refund address on page or status", async () => {
    const h = makeHarness();
    const { auth, apiKey } = await makeMerchant(h);
    const ep = await h.app.inject({ method: "POST", url: "/v1/webhook-endpoints", headers: auth, payload: { url: "https://hooks.example/x" } });
    const secret = ep.json().secret as string;
    expect(secret).toMatch(/^whsec_/);
    const inv = await makeInvoice(h, auth);

    const page = await h.app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(page.body).not.toContain(apiKey);
    expect(page.body).not.toContain(secret);
    expect(page.body).not.toContain(SETTLE.refundTo);
    expect(page.body).not.toContain(SETTLE.settlementAddress);

    const status = await h.app.inject({ method: "GET", url: `/pay/${inv.id}/status` });
    expect(status.statusCode).toBe(200);
    const json = status.json();
    expect(Object.keys(json).sort()).toEqual(["amountIn", "amountOut", "status", "updatedAt"]);
    expect(json.status).toBe("open");
    expect(json.amountIn).toBe("10000000");
    expect(status.body).not.toContain(apiKey);
    expect(status.body).not.toContain(secret);
    expect(status.body).not.toContain(SETTLE.refundTo);
  });

  it("shows the success state with the settled amount once paid", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const inv = await makeInvoice(h, auth);
    await sync(h); await sync(h); await sync(h);

    const status = await h.app.inject({ method: "GET", url: `/pay/${inv.id}/status` });
    expect(status.json().status).toBe("paid");
    expect(status.json().amountOut).toBe("10000000");

    const page = await h.app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(page.body).toContain("Payment received");
    expect(page.body).toContain("Settled 10.00 USDC");
  });

  it("shows what arrived and the excess for an overpaid invoice", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const inv = await makeInvoice(h, auth);
    h.mock.setFinal(inv.depositAddress, "SUCCESS", "12000000");
    await sync(h);
    const page = await h.app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(page.body).toContain("Invoice overpaid");
    expect(page.body).toContain("We received 12.00 USDC");
    expect(page.body).toContain("The excess is 2.00 USDC");
  });

  it("shows the outstanding balance for a partially paid invoice", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const inv = await makeInvoice(h, auth);
    h.mock.setFinal(inv.depositAddress, "SUCCESS", "4000000");
    await sync(h);
    const page = await h.app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(page.body).toContain("Part payment received");
    expect(page.body).toContain("We received 4.00 USDC");
    expect(page.body).toContain("6.00 USDC is still outstanding");
  });

  it("returns a clean 404 page and 404 status JSON for an unknown invoice", async () => {
    const h = makeHarness();
    const page = await h.app.inject({ method: "GET", url: "/pay/inv_doesnotexist" });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain("Invoice not found");
    const status = await h.app.inject({ method: "GET", url: "/pay/inv_doesnotexist/status" });
    expect(status.statusCode).toBe(404);
  });

  it("shows the cancelled state for a cancelled invoice", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const inv = await makeInvoice(h, auth);
    const cancelled = await h.app.inject({ method: "POST", url: `/v1/invoices/${inv.id}/cancel`, headers: auth });
    expect(cancelled.statusCode).toBe(200);
    const page = await h.app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(page.body).toContain("This invoice was cancelled");
    const status = await h.app.inject({ method: "GET", url: `/pay/${inv.id}/status` });
    expect(status.json().status).toBe("cancelled");
  });
});
