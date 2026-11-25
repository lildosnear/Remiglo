import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { signWebhook } from "../src/lib/core.js";
import { MockIntents } from "../src/services/intents.js";
import { MockNuvion } from "../src/services/nuvion.js";
import type { FetchFn } from "../src/services/webhooks.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;

const BANK_NGN = {
  kind: "bank", label: "Yusuf Bello", bankName: "GTBank", accountNumber: "0123456789",
  accountName: "Yusuf Bello", country: "NG", currency: "NGN",
};
const MOMO_GHS = {
  kind: "momo", label: "Ama Serwaa", momoProvider: "MTN", phoneNumber: "+233241234567",
  country: "GH", currency: "GHS",
};

/** A Nuvion client whose entity creation always fails, so merchants stay unlinked. */
class FailingNuvion extends MockNuvion {
  async createEntity(): Promise<never> {
    throw new Error("Nuvion /business-entities failed with 503: unavailable");
  }
}

interface Harness {
  app: ReturnType<typeof buildApp>;
  store: Store;
  nuvion?: MockNuvion;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
}

const apps: Array<ReturnType<typeof buildApp>> = [];

function makeHarness(opts: Partial<BuildOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-nuvion-pay-"));
  const store = new Store(join(dir, "test.db"));
  const calls: Harness["calls"] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  const app = buildApp({
    store, mockIntents: new MockIntents(), fetchFn,
    config: { webhook: { maxAttempts: 5, baseDelayMs: 1 } },
    ...opts,
  });
  apps.push(app);
  return { app, store, nuvion: opts.mockNuvion, calls };
}

afterEach(async () => {
  while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); }
});

async function makeMerchant(h: Harness, name = "Acme") {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name, ...SETTLE } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { merchant: body.merchant, apiKey: body.apiKey as string, auth: { authorization: `Bearer ${body.apiKey}` } };
}

/** Refresh the merchant's Nuvion link: entity approves, currency accounts open. Returns the account map. */
async function linkMerchant(h: Harness, merchantId: string, auth: Record<string, string>) {
  const res = await h.app.inject({ method: "POST", url: `/v1/merchants/${merchantId}/nuvion/refresh`, headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json().nuvion.accounts as Record<string, string>;
}

async function makeRecipient(h: Harness, auth: Record<string, string>, payload: Record<string, unknown>) {
  const res = await h.app.inject({ method: "POST", url: "/v1/recipients", headers: auth, payload });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function registerEndpoint(h: Harness, auth: Record<string, string>) {
  const res = await h.app.inject({
    method: "POST", url: "/v1/webhook-endpoints", headers: auth,
    payload: { url: "https://merchant.example/hook" },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const sync = (h: Harness) => h.app.inject({ method: "POST", url: "/v1/internal/sync" });

/** Merchant webhook event names delivered so far, in delivery order. */
const deliveredEvents = (h: Harness) => h.calls.map((c) => JSON.parse(c.body).event as string);

describe("nuvion fiat payout execution", () => {
  it("executes a single bank payout at creation and settles it through the polling pass", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock });
    const { merchant, auth } = await makeMerchant(h);
    const accounts = await linkMerchant(h, merchant.id, auth);
    const rec = await makeRecipient(h, auth, BANK_NGN);
    await registerEndpoint(h, auth);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000", reference: "INV-1042" },
    });
    expect(created.statusCode).toBe(201);
    const payout = created.json();
    // Executed at creation: the transfer exists and the row tracks it.
    expect(payout.status).toBe("processing");
    expect(payout.providerRef).toMatch(/^mock_transfer_/);
    expect(payout.fiatCurrency).toBe("NGN");
    expect(payout.fiatAmount).toBe("500"); // 5000000 units at 6 decimals is 5.00, which is 500 at Nuvion's 2 decimals
    expect(payout.recipientId).toBe(rec.id);
    expect(payout.depositAddress).toBeUndefined();

    const transfers = await mock.listTransfers(merchant.nuvionEntityId);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].unique_reference).toBe(payout.id);
    expect(transfers[0].narration).toBe("INV-1042");
    expect(transfers[0].amount).toBe(500);
    expect(transfers[0].currency).toBe("NGN");
    expect(transfers[0].account_id).toBe(accounts.NGN); // funded from the naira account, no FX quote
    expect(transfers[0].fx_quote_id).toBeUndefined();
    expect(transfers[0].type).toBe("bank-transfer");

    await sync(h);
    const mid = await h.app.inject({ method: "GET", url: `/v1/payouts/${payout.id}`, headers: auth });
    expect(mid.json().status).toBe("processing");
    expect(deliveredEvents(h)).toContain("payout.sent");

    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payouts/${payout.id}`, headers: auth });
    expect(done.json().status).toBe("settled");
    expect(deliveredEvents(h)).toContain("payout.settled");
    const kinds = h.store.listLedger(merchant.id, payout.id).map((e) => e.kind);
    expect(kinds).toContain("payout_processing");
    expect(kinds).toContain("payout_settled");
  });

  it("executes a batch of fiat rows at approval and completes it with batch.completed fired", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({
      mockNuvion: mock,
      config: { approvalThresholdUnits: "1000000", nuvionCurrencies: ["NGN", "GHS", "USD"] },
    });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const bank = await makeRecipient(h, auth, BANK_NGN);
    const momo = await makeRecipient(h, auth, MOMO_GHS);
    await registerEndpoint(h, auth);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payout-batches", headers: auth,
      payload: { rows: [
        { recipientId: bank.id, amount: "4000000" },
        { recipientId: momo.id, amount: "3000000" },
      ] },
    });
    expect(created.statusCode).toBe(201);
    const batch = created.json();
    expect(batch.status).toBe("pending_approval");
    expect(batch.payouts).toHaveLength(0); // nothing executes before approval
    expect(await mock.listTransfers(merchant.nuvionEntityId)).toHaveLength(0);

    const approved = await h.app.inject({ method: "POST", url: `/v1/payout-batches/${batch.id}/approve`, headers: auth });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().payouts).toHaveLength(2);
    for (const p of approved.json().payouts) {
      expect(p.status).toBe("processing");
      expect(p.providerRef).toMatch(/^mock_transfer_/);
    }
    const types = (await mock.listTransfers(merchant.nuvionEntityId)).map((t) => t.type).sort();
    expect(types).toEqual(["bank-transfer", "momo-transfer"]);

    await sync(h);
    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payout-batches/${batch.id}`, headers: auth });
    expect(done.json().status).toBe("completed");
    expect(done.json().payouts.every((p: any) => p.status === "settled")).toBe(true);
    expect(deliveredEvents(h)).toContain("batch.completed");
  });

  it("records an inbound webhook and applies it in the sync loop, not in the request", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const rec = await makeRecipient(h, auth, BANK_NGN);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000" },
    });
    const payout = created.json();
    expect(payout.status).toBe("processing");

    const hook = await h.app.inject({
      method: "POST", url: "/webhooks/nuvion",
      payload: {
        id: "evt_test_1", type: "outflows.completed",
        data: { id: payout.providerRef, unique_reference: payout.id, status: "successful" },
      },
    });
    expect(hook.statusCode).toBe(200);
    expect(hook.json()).toEqual({ received: true });

    // Recorded verbatim, unapplied, and the payout has not moved yet.
    const events = h.store.listNuvionEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("outflows.completed");
    expect(events[0].providerEventId).toBe("evt_test_1");
    expect(events[0].transferId).toBe(payout.providerRef);
    expect(events[0].applied).toBe(false);
    const before = await h.app.inject({ method: "GET", url: `/v1/payouts/${payout.id}`, headers: auth });
    expect(before.json().status).toBe("processing");

    const result = await sync(h);
    expect(result.json().nuvionEventsApplied).toBe(1);
    expect(h.store.listNuvionEvents()[0].applied).toBe(true);
    const after = await h.app.inject({ method: "GET", url: `/v1/payouts/${payout.id}`, headers: auth });
    expect(after.json().status).toBe("settled");
  });

  it("settles a transfer by polling alone when its webhook never arrives", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const rec = await makeRecipient(h, auth, BANK_NGN);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000" },
    });
    const payout = created.json();
    expect(h.store.listNuvionEvents()).toHaveLength(0);

    await sync(h);
    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payouts/${payout.id}`, headers: auth });
    expect(done.json().status).toBe("settled");
    expect(h.store.listNuvionEvents()).toHaveLength(0);
  });

  it("fails the row and fires payout.failed when the transfer fails", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const rec = await makeRecipient(h, auth, BANK_NGN);
    await registerEndpoint(h, auth);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000" },
    });
    const payout = created.json();
    mock.failTransfer(payout.providerRef);

    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payouts/${payout.id}`, headers: auth });
    expect(done.json().status).toBe("failed");
    expect(deliveredEvents(h)).toContain("payout.failed");
    const kinds = h.store.listLedger(merchant.id, payout.id).map((e) => e.kind);
    expect(kinds).toContain("payout_failed");
  });

  it("refuses a fiat amount that is not exact to the cent, creating nothing", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const rec = await makeRecipient(h, auth, BANK_NGN);

    const res = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000001" }, // 50.000001: below cent precision
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cent/);
    const list = await h.app.inject({ method: "GET", url: "/v1/payouts", headers: auth });
    expect(list.json()).toHaveLength(0);
    expect(await mock.listTransfers(merchant.nuvionEntityId)).toHaveLength(0);
  });

  it("refuses a bank payout when the merchant is not linked, and when Nuvion is not configured", async () => {
    const failing = makeHarness({ mockNuvion: new FailingNuvion() });
    const f = await makeMerchant(failing);
    expect(f.merchant.nuvionEntityStatus).toBe("unlinked");
    const fRec = await makeRecipient(failing, f.auth, BANK_NGN);
    const fRes = await failing.app.inject({
      method: "POST", url: "/v1/payouts", headers: f.auth,
      payload: { recipientId: fRec.id, amount: "5000000" },
    });
    expect(fRes.statusCode).toBe(400);
    expect(fRes.json().error).toMatch(/not linked/);

    const plain = makeHarness();
    const p = await makeMerchant(plain);
    const pRec = await makeRecipient(plain, p.auth, BANK_NGN);
    const pRes = await plain.app.inject({
      method: "POST", url: "/v1/payouts", headers: p.auth,
      payload: { recipientId: pRec.id, amount: "5000000" },
    });
    expect(pRes.statusCode).toBe(400);
    expect(pRes.json().error).toMatch(/not configured/);
  });

  it("retries a failed Nuvion row through the retry endpoint, under a fresh reference", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const rec = await makeRecipient(h, auth, BANK_NGN);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000", reference: "INV-1042" },
    });
    const failed = created.json();
    mock.failTransfer(failed.providerRef);
    await sync(h);
    const failedNow = await h.app.inject({ method: "GET", url: `/v1/payouts/${failed.id}`, headers: auth });
    expect(failedNow.json().status).toBe("failed");

    const retried = await h.app.inject({ method: "POST", url: `/v1/payouts/${failed.id}/retry`, headers: auth });
    expect(retried.statusCode).toBe(201);
    const retry = retried.json();
    expect(retry.id).not.toBe(failed.id);
    expect(retry.retryOfId).toBe(failed.id);
    expect(retry.status).toBe("processing");
    expect(retry.providerRef).toMatch(/^mock_transfer_/);
    expect(retry.providerRef).not.toBe(failed.providerRef);
    expect(retry.fiatAmount).toBe(failed.fiatAmount);

    // Two transfers, two distinct single use references.
    const transfers = await mock.listTransfers(merchant.nuvionEntityId);
    expect(transfers).toHaveLength(2);
    expect(new Set(transfers.map((t) => t.unique_reference)).size).toBe(2);
    expect(transfers.map((t) => t.unique_reference)).toContain(retry.id);

    await sync(h);
    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payouts/${retry.id}`, headers: auth });
    expect(done.json().status).toBe("settled");
    const stillFailed = await h.app.inject({ method: "GET", url: `/v1/payouts/${failed.id}`, headers: auth });
    expect(stillFailed.json().status).toBe("failed");
  });

  it("funds through an FX quote when the merchant has no account in the payout currency", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock, config: { nuvionCurrencies: ["USD"] } });
    const { merchant, auth } = await makeMerchant(h);
    const accounts = await linkMerchant(h, merchant.id, auth);
    expect(Object.keys(accounts)).toEqual(["USD"]);
    const rec = await makeRecipient(h, auth, BANK_NGN);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000" },
    });
    expect(created.statusCode).toBe(201);
    const transfers = await mock.listTransfers(merchant.nuvionEntityId);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].account_id).toBe(accounts.USD);
    expect(transfers[0].currency).toBe("NGN");
    expect(transfers[0].fx_quote_id).toMatch(/^mock_fx_quote_/);
    const quote = await mock.getFxQuote(transfers[0].fx_quote_id!);
    expect(quote.from_currency).toBe("USD");
    expect(quote.to_currency).toBe("NGN");
  });

  it("leaves wallet recipient payouts on the Intents path, untouched", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const wallet = await makeRecipient(h, auth, {
      label: "Near contractor", address: "contractor.near", assetId: USDC_NEAR,
    });

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: wallet.id, amount: "5000000" },
    });
    expect(created.statusCode).toBe(201);
    const payout = created.json();
    expect(payout.status).toBe("awaiting_funding");
    expect(payout.depositAddress).toMatch(/^mock_deposit_/);
    expect(payout.providerRef).toBeUndefined();
    expect(payout.fiatCurrency).toBeUndefined();
    expect(await mock.listTransfers(merchant.nuvionEntityId)).toHaveLength(0);
  });
});

describe("inbound nuvion webhook signature", () => {
  it("refuses an invalid signature and accepts a valid one when a secret is configured", async () => {
    const secret = "nuvion-wh-secret";
    const h = makeHarness({ mockNuvion: new MockNuvion(), config: { nuvionWebhookSecret: secret } });
    const raw = JSON.stringify({
      id: "evt_sig_1", type: "outflows.completed",
      data: { id: "mock_transfer_1", unique_reference: "pay_x", status: "successful" },
    });

    const bad = await h.app.inject({
      method: "POST", url: "/webhooks/nuvion",
      headers: { "content-type": "application/json", "x-nuvion-signature": "deadbeef" },
      payload: raw,
    });
    expect(bad.statusCode).toBe(401);
    expect(h.store.listNuvionEvents()).toHaveLength(0);

    const missing = await h.app.inject({
      method: "POST", url: "/webhooks/nuvion",
      headers: { "content-type": "application/json" },
      payload: raw,
    });
    expect(missing.statusCode).toBe(401);
    expect(h.store.listNuvionEvents()).toHaveLength(0);

    const good = await h.app.inject({
      method: "POST", url: "/webhooks/nuvion",
      headers: { "content-type": "application/json", "x-nuvion-signature": signWebhook(secret, raw) },
      payload: raw,
    });
    expect(good.statusCode).toBe(200);
    expect(h.store.listNuvionEvents()).toHaveLength(1);
  });

  it("records unknown event types and marks them applied with no action", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const hook = await h.app.inject({
      method: "POST", url: "/webhooks/nuvion",
      payload: { id: "evt_other", type: "entities.updated", data: { id: "mock_entity_1", status: "approved" } },
    });
    expect(hook.statusCode).toBe(200);
    const result = await sync(h);
    expect(result.json().nuvionEventsApplied).toBe(1);
    const events = h.store.listNuvionEvents();
    expect(events).toHaveLength(1);
    expect(events[0].applied).toBe(true);
  });
});
