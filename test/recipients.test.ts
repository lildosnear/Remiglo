import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import type { FetchFn } from "../src/services/webhooks.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

const apps: Array<ReturnType<typeof buildApp>> = [];
function makeHarness(config: BuildOptions["config"] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-rcp-"));
  const store = new Store(join(dir, "test.db"));
  const mock = new MockIntents();
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  const app = buildApp({ store, mockIntents: mock, fetchFn, config: { webhook: { maxAttempts: 5, baseDelayMs: 1 }, ...config } });
  apps.push(app);
  return { app, store, mock };
}
afterEach(async () => { while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); } });


/** Run the first run setup flow and return the session cookie header. */
async function dashCookie(h: { app: ReturnType<typeof buildApp> }, merchantId: string) {
  const res = await h.app.inject({
    method: "POST", url: "/dashboard/setup",
    payload: { merchantId, email: "owner@example.com", password: "owner-password-1" },
  });
  expect(res.statusCode).toBe(303);
  const setCookie = res.headers["set-cookie"] as unknown as string;
  return { cookie: String(setCookie).split(";")[0] };
}

async function makeMerchant(h: ReturnType<typeof makeHarness>, name = "Acme") {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name, ...SETTLE } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { merchant: body.merchant, auth: { authorization: `Bearer ${body.apiKey}` } };
}

describe("recipients address book", () => {
  it("supports CRUD and derives the chain from the asset", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const created = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Ada the designer", address: "ada.near", assetId: USDC_NEAR, notes: "Brand work" },
    });
    expect(created.statusCode).toBe(201);
    const rec = created.json();
    expect(rec.chain).toBe("near");
    expect(rec.label).toBe("Ada the designer");

    const listed = await h.app.inject({ method: "GET", url: "/v1/recipients", headers: auth });
    expect(listed.json()).toHaveLength(1);

    const patched = await h.app.inject({
      method: "PATCH", url: `/v1/recipients/${rec.id}`, headers: auth,
      payload: { label: "Ada (lead designer)", assetId: USDC_BASE },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().label).toBe("Ada (lead designer)");
    expect(patched.json().chain).toBe("base");

    const removed = await h.app.inject({ method: "DELETE", url: `/v1/recipients/${rec.id}`, headers: auth });
    expect(removed.statusCode).toBe(200);
    const gone = await h.app.inject({ method: "GET", url: `/v1/recipients/${rec.id}`, headers: auth });
    expect(gone.statusCode).toBe(404);
  });

  it("rejects an unknown asset", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const res = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "X", address: "x.near", assetId: "nep141:does-not-exist.near" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a known asset/);
  });

  it("scopes recipients to the owning merchant (cross merchant reads 404)", async () => {
    const h = makeHarness();
    const a = await makeMerchant(h, "A");
    const b = await makeMerchant(h, "B");
    const created = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: a.auth,
      payload: { label: "Ada", address: "ada.near", assetId: USDC_NEAR },
    });
    const id = created.json().id;
    expect((await h.app.inject({ method: "GET", url: `/v1/recipients/${id}`, headers: b.auth })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "PATCH", url: `/v1/recipients/${id}`, headers: b.auth, payload: { label: "Hijack" } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "DELETE", url: `/v1/recipients/${id}`, headers: b.auth })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/v1/recipients", headers: b.auth })).json()).toHaveLength(0);
  });

  it("resolves recipientId on single payouts and batch rows", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    const rec = (await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Base contractor", address: "0xabc0000000000000000000000000000000000001", assetId: USDC_BASE },
    })).json();

    const payout = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "10000000" },
    });
    expect(payout.statusCode).toBe(201);
    expect(payout.json().recipientAddress).toBe("0xabc0000000000000000000000000000000000001");
    expect(payout.json().destinationAsset).toBe(USDC_BASE);

    const batch = await h.app.inject({
      method: "POST", url: "/v1/payout-batches", headers: auth,
      payload: { rows: [{ recipientId: rec.id, amount: "20000000" }] },
    });
    expect(batch.statusCode).toBe(201);
    expect(batch.json().rows[0].recipientAddress).toBe("0xabc0000000000000000000000000000000000001");
    // The stored batch row is resolved, so deleting the recipient cannot break it.
    await h.app.inject({ method: "DELETE", url: `/v1/recipients/${rec.id}`, headers: auth });
    const stored = h.store.getBatch(merchant.id, batch.json().id);
    expect((stored!.rows[0] as any).recipientAddress).toBe("0xabc0000000000000000000000000000000000001");

    const bad = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "10000000" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("dashboard address book shows saved recipients and history stats", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Ada the designer", address: "ada.near", assetId: USDC_NEAR },
    });
    await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientAddress: "ada.near", destinationAsset: USDC_NEAR, amount: "10000000" },
    });
    const page = await h.app.inject({ method: "GET", url: `/dashboard/recipients?merchant=${merchant.id}`, headers: await dashCookie(h, merchant.id) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Address book");
    expect(page.body).toContain("Ada the designer");
    expect(page.body).toContain("Add recipient");
  });
});
