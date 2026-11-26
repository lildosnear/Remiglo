import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import { MockNuvion, type CreateTransferRequest, type NuvionTransfer } from "../src/services/nuvion.js";
import type { FetchFn } from "../src/services/webhooks.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;
const USDT_ETH = "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near";
const RLUSD_ETH = "nep141:eth-0x8292bb45bf1ee4d140127049757c2e0ff06317ed.omft.near";
const EVM_WALLET = "0xabc0000000000000000000000000000000000001";

const BANK_NGN = {
  kind: "bank", label: "Yusuf Bello", bankName: "GTBank", accountNumber: "0123456789",
  accountName: "Yusuf Bello", country: "NG", currency: "NGN",
};
const MOMO_GHS = {
  kind: "momo", label: "Ama Serwaa", momoProvider: "MTN", phoneNumber: "+233241234567",
  country: "GH", currency: "GHS",
};
const WALLET_USDC_BASE = { label: "Base contractor", address: EVM_WALLET, assetId: USDC_NEAR, network: "BASE_MAINNET" };

/** A Nuvion client whose GHS transfers fail while the flag is set, for the part failed approval regression. */
class GhsTransferFailingNuvion extends MockNuvion {
  failGhs = true;
  override async createTransfer(body: CreateTransferRequest): Promise<NuvionTransfer> {
    if (this.failGhs && body.currency === "GHS") {
      throw new Error("Nuvion /transfers failed with 503: rail unavailable");
    }
    return super.createTransfer(body);
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
  const dir = mkdtempSync(join(tmpdir(), "remiglo-nuvion-stable-"));
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

describe("nuvion stablecoin payout rows", () => {
  it("executes a stablecoin row from the merchant's stablecoin account, with no FX quote, and settles it by polling", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock, config: { nuvionCurrencies: ["USC", "USD"] } });
    const { merchant, auth } = await makeMerchant(h);
    const accounts = await linkMerchant(h, merchant.id, auth);
    expect(Object.keys(accounts).sort()).toEqual(["USC", "USD"]);
    const rec = await makeRecipient(h, auth, WALLET_USDC_BASE);
    await registerEndpoint(h, auth);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000", reference: "INV-2001" },
    });
    expect(created.statusCode).toBe(201);
    const payout = created.json();
    expect(payout.status).toBe("processing");
    expect(payout.providerRef).toMatch(/^mock_transfer_/);
    expect(payout.fiatCurrency).toBe("USC");
    expect(payout.fiatAmount).toBe("500"); // 5.00 USDC at chain precision is 500 at Nuvion's 2 decimals
    expect(payout.destinationAsset).toBe(USDC_NEAR); // the row still names the asset it pays in
    expect(payout.depositAddress).toBeUndefined();

    const transfers = await mock.listTransfers(merchant.nuvionEntityId);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].type).toBe("stablecoin-transfer");
    expect(transfers[0].currency).toBe("USC");
    expect(transfers[0].amount).toBe(500);
    expect(transfers[0].account_id).toBe(accounts.USC); // funded from the USDC account itself
    expect(transfers[0].fx_quote_id).toBeUndefined(); // no conversion, no quote
    expect(transfers[0].unique_reference).toBe(payout.id);
    expect(transfers[0].narration).toBe("INV-2001");

    await sync(h);
    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payouts/${payout.id}`, headers: auth });
    expect(done.json().status).toBe("settled");
    expect(deliveredEvents(h)).toContain("payout.settled");
  });

  it("funds a stablecoin row from a fiat account through an FX quote into the stablecoin code", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock, config: { nuvionCurrencies: ["USD"] } });
    const { merchant, auth } = await makeMerchant(h);
    const accounts = await linkMerchant(h, merchant.id, auth);
    expect(Object.keys(accounts)).toEqual(["USD"]);
    const rec = await makeRecipient(h, auth, {
      label: "Eth contractor", address: EVM_WALLET, assetId: USDT_ETH, network: "ETH_MAINNET",
    });

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "2500000" },
    });
    expect(created.statusCode).toBe(201);
    const payout = created.json();
    expect(payout.fiatCurrency).toBe("UST");
    expect(payout.fiatAmount).toBe("250");

    const transfers = await mock.listTransfers(merchant.nuvionEntityId);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].type).toBe("stablecoin-transfer");
    expect(transfers[0].currency).toBe("UST");
    expect(transfers[0].account_id).toBe(accounts.USD); // no UST account, so the dollar account funds it
    expect(transfers[0].fx_quote_id).toMatch(/^mock_fx_quote_/);
    const quote = await mock.getFxQuote(transfers[0].fx_quote_id!);
    expect(quote.from_currency).toBe("USD");
    expect(quote.to_currency).toBe("UST");
  });

  it("refuses an RLUSD row on a non Ethereum network, and pays RLUSD on Ethereum", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock, config: { nuvionCurrencies: ["USD"] } });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const onBase = await makeRecipient(h, auth, {
      label: "RLUSD on Base", address: EVM_WALLET, assetId: RLUSD_ETH, network: "BASE_MAINNET",
    });

    const refused = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: onBase.id, amount: "5000000" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/RLUSD/);
    expect(refused.json().error).toMatch(/Ethereum/);
    const list = await h.app.inject({ method: "GET", url: "/v1/payouts", headers: auth });
    expect(list.json()).toHaveLength(0);
    expect(await mock.listTransfers(merchant.nuvionEntityId)).toHaveLength(0);

    const onEth = await makeRecipient(h, auth, {
      label: "RLUSD on Ethereum", address: EVM_WALLET, assetId: RLUSD_ETH, network: "ETH_MAINNET",
    });
    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: onEth.id, amount: "5000000" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().fiatCurrency).toBe("RLD");
    const transfers = await mock.listTransfers(merchant.nuvionEntityId);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].currency).toBe("RLD");
    expect(transfers[0].type).toBe("stablecoin-transfer");
  });

  it("refuses a stablecoin amount that is not exact to the cent, creating nothing", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock, config: { nuvionCurrencies: ["USC"] } });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const rec = await makeRecipient(h, auth, WALLET_USDC_BASE);

    const res = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000001" }, // below cent precision at 2 decimals
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cent/);
    const list = await h.app.inject({ method: "GET", url: "/v1/payouts", headers: auth });
    expect(list.json()).toHaveLength(0);
    expect(await mock.listTransfers(merchant.nuvionEntityId)).toHaveLength(0);
  });

  it("refuses a network carrying wallet whose destination asset is not a stablecoin Nuvion carries", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock, config: { nuvionCurrencies: ["USD"] } });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    // Written straight into the store: the API's known asset gate keeps
    // such a recipient out, but a network carrying wallet that already
    // exists must still be refused at payout time, not routed onwards.
    const rec = h.store.createRecipient({
      merchantId: merchant.id, label: "Wrapped NEAR holder", address: EVM_WALLET,
      assetId: "nep141:wrap.near", chain: "near", kind: "wallet", network: "ETH_MAINNET",
    });

    const res = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a stablecoin Nuvion carries/);
    const list = await h.app.inject({ method: "GET", url: "/v1/payouts", headers: auth });
    expect(list.json()).toHaveLength(0);
    expect(await mock.listTransfers(merchant.nuvionEntityId)).toHaveLength(0);
  });

  it("leaves a wallet recipient with no network recorded on the Intents path", async () => {
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
    expect(await mock.listTransfers(merchant.nuvionEntityId)).toHaveLength(0);
  });

  it("executes a mixed batch of bank, momo and stablecoin rows at approval and completes it", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({
      mockNuvion: mock,
      config: { approvalThresholdUnits: "1000000", nuvionCurrencies: ["NGN", "GHS", "USC", "USD"] },
    });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const bank = await makeRecipient(h, auth, BANK_NGN);
    const momo = await makeRecipient(h, auth, MOMO_GHS);
    const wallet = await makeRecipient(h, auth, WALLET_USDC_BASE);
    await registerEndpoint(h, auth);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payout-batches", headers: auth,
      payload: { rows: [
        { recipientId: bank.id, amount: "4000000" },
        { recipientId: momo.id, amount: "3000000" },
        { recipientId: wallet.id, amount: "2000000" },
      ] },
    });
    expect(created.statusCode).toBe(201);
    const batch = created.json();
    expect(batch.status).toBe("pending_approval");
    expect(await mock.listTransfers(merchant.nuvionEntityId)).toHaveLength(0);

    const approved = await h.app.inject({ method: "POST", url: `/v1/payout-batches/${batch.id}/approve`, headers: auth });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().payouts).toHaveLength(3);
    for (const p of approved.json().payouts) {
      expect(p.status).toBe("processing");
      expect(p.providerRef).toMatch(/^mock_transfer_/);
    }
    const byType = new Map((await mock.listTransfers(merchant.nuvionEntityId)).map((t) => [t.type, t]));
    expect([...byType.keys()].sort()).toEqual(["bank-transfer", "momo-transfer", "stablecoin-transfer"]);
    expect(byType.get("stablecoin-transfer")!.currency).toBe("USC");
    expect(byType.get("bank-transfer")!.currency).toBe("NGN");
    expect(byType.get("momo-transfer")!.currency).toBe("GHS");

    await sync(h);
    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payout-batches/${batch.id}`, headers: auth });
    expect(done.json().status).toBe("completed");
    expect(done.json().payouts.every((p: any) => p.status === "settled")).toBe(true);
    expect(deliveredEvents(h)).toContain("batch.completed");
  });

  it("retries a failed stablecoin row through the retry endpoint, under a fresh reference", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock, config: { nuvionCurrencies: ["USC"] } });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const rec = await makeRecipient(h, auth, WALLET_USDC_BASE);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000" },
    });
    const failed = created.json();
    expect(failed.fiatCurrency).toBe("USC");
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
    expect(retry.fiatCurrency).toBe("USC");

    const transfers = await mock.listTransfers(merchant.nuvionEntityId);
    expect(transfers).toHaveLength(2);
    expect(new Set(transfers.map((t) => t.unique_reference)).size).toBe(2);
    expect(transfers.every((t) => t.type === "stablecoin-transfer")).toBe(true);

    await sync(h);
    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payouts/${retry.id}`, headers: auth });
    expect(done.json().status).toBe("settled");
    const stillFailed = await h.app.inject({ method: "GET", url: `/v1/payouts/${failed.id}`, headers: auth });
    expect(stillFailed.json().status).toBe("failed");
  });
});

describe("batch approval sharp edge (slice 5 fix)", () => {
  it("keeps an executed row live when a later row fails approval, settles it by polling, and never executes it twice", async () => {
    const mock = new GhsTransferFailingNuvion();
    const h = makeHarness({
      mockNuvion: mock,
      config: { approvalThresholdUnits: "1000000", nuvionCurrencies: ["NGN", "GHS", "USD"] },
    });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const bank = await makeRecipient(h, auth, BANK_NGN);
    const momo = await makeRecipient(h, auth, MOMO_GHS);

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

    // First approval attempt: the bank row executes, the momo row's
    // transfer fails at the rail, and the attempt fails.
    const attempt = await h.app.inject({ method: "POST", url: `/v1/payout-batches/${batch.id}/approve`, headers: auth });
    expect(attempt.statusCode).toBe(502);

    const afterAttempt = await h.app.inject({ method: "GET", url: `/v1/payout-batches/${batch.id}`, headers: auth });
    expect(afterAttempt.json().status).toBe("pending_approval"); // approval stays retryable
    expect(afterAttempt.json().payouts).toHaveLength(1);
    const firstRow = afterAttempt.json().payouts[0];
    // The sharp edge: the executed row is NOT marked failed. Its
    // transfer is live at Nuvion and the row keeps tracking it.
    expect(firstRow.status).toBe("processing");
    expect(firstRow.providerRef).toMatch(/^mock_transfer_/);
    expect(await mock.listTransfers(merchant.nuvionEntityId)).toHaveLength(1);

    // The backstop settles the first row while the batch still waits.
    await sync(h);
    await sync(h);
    const settledRow = await h.app.inject({ method: "GET", url: `/v1/payouts/${firstRow.id}`, headers: auth });
    expect(settledRow.json().status).toBe("settled");
    const stillWaiting = await h.app.inject({ method: "GET", url: `/v1/payout-batches/${batch.id}`, headers: auth });
    expect(stillWaiting.json().status).toBe("pending_approval");

    // Re approval executes only the row that never executed. The first
    // row is reused as it stands: no second transfer is created for it.
    mock.failGhs = false;
    const approved = await h.app.inject({ method: "POST", url: `/v1/payout-batches/${batch.id}/approve`, headers: auth });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("active");
    expect(approved.json().payouts).toHaveLength(2);
    expect(approved.json().payouts.map((p: any) => p.id)).toContain(firstRow.id);
    const transfers = await mock.listTransfers(merchant.nuvionEntityId);
    expect(transfers).toHaveLength(2);
    expect(transfers.filter((t) => t.unique_reference === firstRow.id)).toHaveLength(1);

    await sync(h);
    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payout-batches/${batch.id}`, headers: auth });
    expect(done.json().status).toBe("completed");
    expect(done.json().payouts.every((p: any) => p.status === "settled")).toBe(true);
  });
});
