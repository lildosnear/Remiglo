import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { buildApp } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import type { FetchFn } from "../src/services/webhooks.js";
import { Remiglo, RemigloError, verifyWebhookSignature } from "../sdk/src/index.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;

let app: ReturnType<typeof buildApp>;
let sdk: Remiglo;
let baseUrl: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-sdk-"));
  const store = new Store(join(dir, "test.db"));
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  app = buildApp({ store, mockIntents: new MockIntents(), fetchFn, config: { webhook: { maxAttempts: 5, baseDelayMs: 1 } } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  const res = await fetch(`${baseUrl}/v1/merchants`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "SDK Demo Co", ...SETTLE }),
  });
  const body = await res.json() as any;
  sdk = new Remiglo({ baseUrl, apiKey: body.apiKey });
});

afterAll(async () => { await app?.close().catch(() => {}); });

describe("Remiglo SDK against a live (mock mode) server", () => {
  it("runs a full invoice lifecycle call chain", async () => {
    const invoice = await sdk.createInvoice(
      { amount: "10000000", externalRef: "SDK-ORDER-1" },
      { idempotencyKey: "sdk-order-1" }
    );
    expect(invoice.status).toBe("open");
    expect(invoice.paymentUrl).toBe(`/pay/${invoice.id}`);
    expect(invoice.payment?.depositAddress).toMatch(/^mock_deposit_/);

    const replay = await sdk.createInvoice(
      { amount: "10000000", externalRef: "SDK-ORDER-1" },
      { idempotencyKey: "sdk-order-1" }
    );
    expect(replay.id).toBe(invoice.id); // idempotent replay

    const fetched = await sdk.getInvoice(invoice.id);
    expect(fetched.externalRef).toBe("SDK-ORDER-1");
    const listed = await sdk.listInvoices();
    expect(listed.map((i) => i.id)).toContain(invoice.id);

    const second = await sdk.createInvoice({ amount: "5000000" });
    const cancelled = await sdk.cancelInvoice(second.id);
    expect(cancelled.status).toBe("cancelled");

    const daily = await sdk.reconciliationDaily();
    expect(daily.invoicesByStatus.open).toBeGreaterThanOrEqual(1);
    expect(daily.invoicesByStatus.cancelled).toBe(1);
    const csv = await sdk.reconciliationCsv();
    expect(csv).toContain("invoice_id,external_ref,gross");
  });

  it("covers recipients, payouts, CSV batches and schedules", async () => {
    const rec = await sdk.createRecipient({ label: "Ada", address: "ada.near", assetId: USDC_NEAR });
    expect(rec.chain).toBe("near");
    const payout = await sdk.createPayout({ recipientId: rec.id, amount: "10000000" });
    expect(payout.recipientAddress).toBe("ada.near");
    expect((await sdk.listPayouts()).length).toBeGreaterThanOrEqual(1);

    const batch = await sdk.createBatchFromCsv(
      `recipient_address,destination_asset,amount_units\nada.near,${USDC_NEAR},10000000\nbob.near,${USDC_NEAR},20000000\n`
    );
    expect(batch.rowCount).toBe(2);
    expect((await sdk.getBatch(batch.id)).payouts).toHaveLength(2);

    const schedule = await sdk.createSchedule({
      kind: "invoice", cadence: "weekly", payload: { amount: "10000000" },
    });
    const paused = await sdk.pauseSchedule(schedule.id);
    expect(paused.active).toBe(false);
    const resumed = await sdk.resumeSchedule(schedule.id);
    expect(resumed.active).toBe(true);
    await sdk.deleteSchedule(schedule.id);
    expect(await sdk.listSchedules()).toHaveLength(0);

    const ep = await sdk.createWebhookEndpoint("https://hooks.example/remiglo");
    expect(ep.secret).toMatch(/^whsec_/);
    expect((await sdk.listWebhookEndpoints())[0].id).toBe(ep.id);
  });

  it("throws a typed RemigloError with the status", async () => {
    await expect(sdk.getInvoice("inv_missing")).rejects.toMatchObject({
      name: "RemigloError", status: 404,
    });
    await expect(sdk.getInvoice("inv_missing")).rejects.toBeInstanceOf(RemigloError);
  });

  it("verifyWebhookSignature accepts the real signature and rejects a bad one", () => {
    const secret = "whsec_test_secret_for_sdk";
    const payload = JSON.stringify({ event: "invoice.paid", entityId: "inv_1" });
    const good = createHmac("sha256", secret).update(payload).digest("hex");
    expect(verifyWebhookSignature(secret, payload, good)).toBe(true);
    expect(verifyWebhookSignature(secret, payload, "0".repeat(64))).toBe(false);
    expect(verifyWebhookSignature(secret, payload + " ", good)).toBe(false);
    expect(verifyWebhookSignature("wrong-secret", payload, good)).toBe(false);
  });
});
