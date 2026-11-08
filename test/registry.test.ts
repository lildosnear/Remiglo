import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import { MockRegistry, batchPayloadHash } from "../src/services/registry.js";
import type { FetchFn } from "../src/services/webhooks.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;

const apps: Array<ReturnType<typeof buildApp>> = [];
function makeHarness(registry?: MockRegistry) {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-registry-"));
  const store = new Store(join(dir, "test.db"));
  const mock = new MockIntents();
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  const opts: BuildOptions = { store, mockIntents: mock, fetchFn, config: { webhook: { maxAttempts: 5, baseDelayMs: 1 } } };
  if (registry) opts.registry = registry;
  const app = buildApp(opts);
  apps.push(app);
  return { app, store, mock };
}
afterEach(async () => { while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); } });

type H = ReturnType<typeof makeHarness>;
async function makeMerchant(h: H) {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name: "Acme", ...SETTLE } });
  const body = res.json();
  return { merchant: body.merchant, auth: { authorization: `Bearer ${body.apiKey}` } };
}

describe("registry anchoring (Slice G)", () => {
  it("mock registry anchors an active batch and records it on the batch row and ledger", async () => {
    const registry = new MockRegistry();
    const h = makeHarness(registry);
    const { auth } = await makeMerchant(h);
    const res = await h.app.inject({
      method: "POST", url: "/v1/payout-batches", headers: auth,
      payload: { rows: [{ recipientAddress: "ada.near", destinationAsset: USDC_NEAR, amount: "10000000" }] },
    });
    expect(res.statusCode).toBe(201);
    const batchId = res.json().id;
    await (h.app as any).remiglo.anchorFlush();
    const batch = h.store.getBatchById(batchId)!;
    expect(batch.anchorStatus).toBe("anchored");
    expect(batch.anchorTxHash).toBe(`mock_anchor_${batchId}`);
    expect(registry.anchored).toHaveLength(1);
    expect(registry.anchored[0].total).toBe("10000000");
    expect(registry.anchored[0].payloadHash).toBe(batchPayloadHash(batchId, batch.merchantId, batch.rows as any));
    const ledger = h.store.listLedger(batch.merchantId);
    expect(ledger.some((e) => e.kind === "batch_anchored" && e.txHash === `mock_anchor_${batchId}`)).toBe(true);
  });

  it("a pending approval batch anchors only after approval", async () => {
    const registry = new MockRegistry();
    const h = makeHarness(registry);
    const { auth } = await makeMerchant(h);
    const rows = Array.from({ length: 6 }, (_, i) => ({
      recipientAddress: `user${i}.near`, destinationAsset: USDC_NEAR, amount: "90000000",
    }));
    const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: auth, payload: { rows } });
    const batchId = res.json().id;
    await (h.app as any).remiglo.anchorFlush();
    expect(registry.anchored).toHaveLength(0);
    const approve = await h.app.inject({ method: "POST", url: `/v1/payout-batches/${batchId}/approve`, headers: auth });
    expect(approve.statusCode).toBe(200);
    await (h.app as any).remiglo.anchorFlush();
    expect(registry.anchored).toHaveLength(1);
    expect(h.store.getBatchById(batchId)?.anchorStatus).toBe("anchored");
  });

  it("API is unaffected when the registry is unconfigured (default)", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const res = await h.app.inject({
      method: "POST", url: "/v1/payout-batches", headers: auth,
      payload: { rows: [{ recipientAddress: "ada.near", destinationAsset: USDC_NEAR, amount: "10000000" }] },
    });
    expect(res.statusCode).toBe(201);
    expect(h.store.getBatchById(res.json().id)?.anchorStatus).toBe("none");
  });

  it("a failing registry marks the batch failed but never fails the API call", async () => {
    const registry = new MockRegistry();
    registry.failNext = true;
    const h = makeHarness(registry);
    const { auth } = await makeMerchant(h);
    const res = await h.app.inject({
      method: "POST", url: "/v1/payout-batches", headers: auth,
      payload: { rows: [{ recipientAddress: "ada.near", destinationAsset: USDC_NEAR, amount: "10000000" }] },
    });
    expect(res.statusCode).toBe(201);
    await (h.app as any).remiglo.anchorFlush();
    const batch = h.store.getBatchById(res.json().id)!;
    expect(batch.anchorStatus).toBe("failed");
    const ledger = h.store.listLedger(batch.merchantId);
    expect(ledger.some((e) => e.kind === "batch_anchor_failed")).toBe(true);
  });
});
