import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import type { FetchFn } from "../src/services/webhooks.js";
import { parseBatchCsv } from "../src/lib/csv.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;

const apps: Array<ReturnType<typeof buildApp>> = [];
function makeHarness(config: BuildOptions["config"] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-csv-"));
  const store = new Store(join(dir, "test.db"));
  const mock = new MockIntents();
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  const app = buildApp({ store, mockIntents: mock, fetchFn, config: { webhook: { maxAttempts: 5, baseDelayMs: 1 }, ...config } });
  apps.push(app);
  return { app, store, mock };
}
afterEach(async () => { while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); } });

async function makeMerchant(h: ReturnType<typeof makeHarness>) {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name: "Acme", ...SETTLE } });
  const body = res.json();
  return { merchant: body.merchant, auth: { authorization: `Bearer ${body.apiKey}` } };
}
const sync = (h: ReturnType<typeof makeHarness>) => h.app.inject({ method: "POST", url: "/v1/internal/sync" });

describe("CSV parser", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    const parsed = parseBatchCsv(
      `recipient_address,destination_asset,amount_units,reference\n"ada, the designer",${USDC_NEAR},10000000,"ref ""one"""\n`
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows![0].recipientAddress).toBe("ada, the designer");
    expect(parsed.rows![0].reference).toBe('ref "one"');
  });

  it("rejects a bad header", () => {
    const parsed = parseBatchCsv("who,what,when\na,b,c\n");
    expect(parsed.rows).toBeUndefined();
    expect(parsed.errors[0].line).toBe(1);
  });
});

describe("CSV batch upload", () => {
  const csvHeaders = { "content-type": "text/csv" };

  it("creates a batch from a valid CSV body", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    const csv = [
      "recipient_address,destination_asset,amount_units,reference",
      `ada.near,${USDC_NEAR},10000000,pay-1`,
      `bob.near,${USDC_NEAR},20000000,pay-2`,
    ].join("\n");
    const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: { ...auth, ...csvHeaders }, payload: csv });
    expect(res.statusCode).toBe(201);
    expect(res.json().rowCount).toBe(2);
    expect(res.json().payouts).toHaveLength(2);
    expect(h.store.listBatches(merchant.id)).toHaveLength(1);
  });

  it("supports the recipient_id header variant", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const rec = (await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Ada", address: "ada.near", assetId: USDC_NEAR },
    })).json();
    const csv = `recipient_id,amount_units\n${rec.id},10000000\n`;
    const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: { ...auth, ...csvHeaders }, payload: csv });
    expect(res.statusCode).toBe(201);
    expect(res.json().payouts[0].recipientAddress).toBe("ada.near");
  });

  it("reports per row errors with line numbers and creates nothing", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    const csv = [
      "recipient_address,destination_asset,amount_units",
      `ada.near,${USDC_NEAR},10000000`,
      `bob.near,${USDC_NEAR},notanumber`,
      `,${USDC_NEAR},10000000`,
    ].join("\n");
    const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: { ...auth, ...csvHeaders }, payload: csv });
    expect(res.statusCode).toBe(400);
    const errors = res.json().errors as Array<{ line: number; message: string }>;
    expect(errors.map((e) => e.line)).toEqual([3, 4]);
    expect(h.store.listBatches(merchant.id)).toHaveLength(0);
    expect(h.store.listPayouts(merchant.id)).toHaveLength(0);
  });

  it("enforces the pilot cap and the 100 row cap on CSV batches", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const over = `recipient_address,destination_asset,amount_units\nada.near,${USDC_NEAR},100000001\n`;
    const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: { ...auth, ...csvHeaders }, payload: over });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/pilot cap/);

    const many = ["recipient_address,destination_asset,amount_units",
      ...Array.from({ length: 101 }, (_, i) => `user${i}.near,${USDC_NEAR},1000`)].join("\n");
    const res2 = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: { ...auth, ...csvHeaders }, payload: many });
    expect(res2.statusCode).toBe(400);
    expect(JSON.stringify(res2.json())).toMatch(/100/);
  });

  it("a CSV batch over the approval threshold waits for approval", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const rows = Array.from({ length: 6 }, (_, i) => `user${i}.near,${USDC_NEAR},90000000`);
    const csv = ["recipient_address,destination_asset,amount_units", ...rows].join("\n");
    const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: { ...auth, ...csvHeaders }, payload: csv });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("pending_approval");
    expect(res.json().payouts).toHaveLength(0);
  });
});

describe("payout.sent webhook event", () => {
  it("fires exactly once, on the first transition out of awaiting_funding", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    await h.app.inject({
      method: "POST", url: "/v1/webhook-endpoints", headers: auth,
      payload: { url: "https://hooks.example/remiglo" },
    });
    const payout = (await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientAddress: "ada.near", destinationAsset: USDC_NEAR, amount: "10000000" },
    })).json();
    expect(payout.status).toBe("awaiting_funding");

    await sync(h); // KNOWN_DEPOSIT_TX -> funded: payout.sent fires here
    await sync(h); // PROCESSING -> processing: must NOT fire again
    await sync(h); // SUCCESS -> settled: payout.settled fires

    const deliveries = h.store.listDeliveries(merchant.id);
    const sent = deliveries.filter((d) => d.event === "payout.sent" && d.entityId === payout.id);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("delivered");
    const settled = deliveries.filter((d) => d.event === "payout.settled" && d.entityId === payout.id);
    expect(settled).toHaveLength(1);
  });
});
