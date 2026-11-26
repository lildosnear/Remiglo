import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { hashPassword, hashToken, newSessionToken, SESSION_TTL_MS } from "../src/lib/auth.js";
import { MockIntents } from "../src/services/intents.js";
import { MockNuvion } from "../src/services/nuvion.js";
import type { FetchFn } from "../src/services/webhooks.js";

/**
 * Fiat slice 6: reconciliation and the closing proof. A linked
 * merchant holding NGN, USD and USC accounts pays one batch with a
 * bank row, a mobile money row and a stablecoin row under a single
 * approval; every row settles through Nuvion, and the reconciliation
 * export carries the rail, the fiat denomination, the FX quote and
 * the provider reference for each row, with totals that match the
 * batch. This is the build's closing proof against MockNuvion; the
 * live sandbox run is a separate step.
 */

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;
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

interface Harness {
  app: ReturnType<typeof buildApp>;
  store: Store;
  nuvion?: MockNuvion;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
}

const apps: Array<ReturnType<typeof buildApp>> = [];

function makeHarness(opts: Partial<BuildOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-nuvion-recon-"));
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

const sync = (h: Harness) => h.app.inject({ method: "POST", url: "/v1/internal/sync" });

/** Create an owner dashboard session for the merchant and return the cookie header. */
function dashAuth(h: Harness, merchantId: string): { cookie: string } {
  const { salt, hash } = hashPassword("owner-password-1");
  const user = h.store.createUser({ merchantId, email: "owner@example.com", passwordHash: hash, salt, role: "owner" });
  const token = newSessionToken();
  h.store.createSession(user.id, hashToken(token), new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return { cookie: `remiglo_session=${token}` };
}

/** Split a CSV body into a header list and one record per line, keyed by header. Safe here: no cell in these exports contains a comma. */
function parseCsv(body: string) {
  const lines = body.trim().split("\n");
  const head = lines[0].split(",");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(head.map((k, i) => [k, cells[i] ?? ""]));
  });
  return { head, rows };
}

describe("nuvion reconciliation and the mixed proof batch", () => {
  it("settles a mixed bank, momo and stablecoin batch under one approval and reconciles it", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({
      mockNuvion: mock,
      config: { approvalThresholdUnits: "1000000", nuvionCurrencies: ["NGN", "USD", "USC"] },
    });
    const { merchant, auth } = await makeMerchant(h);
    const accounts = await linkMerchant(h, merchant.id, auth);
    expect(Object.keys(accounts).sort()).toEqual(["NGN", "USC", "USD"]);
    const bank = await makeRecipient(h, auth, BANK_NGN);
    const momo = await makeRecipient(h, auth, MOMO_GHS);
    const wallet = await makeRecipient(h, auth, WALLET_USDC_BASE);

    const created = await h.app.inject({
      method: "POST", url: "/v1/payout-batches", headers: auth,
      payload: { rows: [
        { recipientId: bank.id, amount: "4000000" },
        { recipientId: momo.id, amount: "3000000" },
        { recipientId: wallet.id, amount: "5000000" },
      ] },
    });
    expect(created.statusCode).toBe(201);
    const batch = created.json();
    expect(batch.status).toBe("pending_approval");
    expect(batch.payouts).toHaveLength(0);

    const approved = await h.app.inject({ method: "POST", url: `/v1/payout-batches/${batch.id}/approve`, headers: auth });
    expect(approved.statusCode).toBe(200);
    const payouts = approved.json().payouts as any[];
    expect(payouts).toHaveLength(3);
    const byRecipient = new Map(payouts.map((p) => [p.recipientId as string, p]));
    const bankPay = byRecipient.get(bank.id)!;
    const momoPay = byRecipient.get(momo.id)!;
    const walletPay = byRecipient.get(wallet.id)!;
    for (const p of payouts) {
      expect(p.status).toBe("processing");
      expect(p.providerRef).toMatch(/^mock_transfer_/);
    }
    // Funding shape per row: the naira row pays from the naira
    // account and the stablecoin row from the USC account, so neither
    // carries a quote. The merchant holds no GHS account, so the momo
    // row converted from USD and its quote id is stored on the record.
    expect(bankPay.fxQuoteId).toBeUndefined();
    expect(walletPay.fxQuoteId).toBeUndefined();
    expect(momoPay.fxQuoteId).toMatch(/^mock_fx_quote_/);
    const transfers = await mock.listTransfers(merchant.nuvionEntityId);
    expect(transfers).toHaveLength(3);
    const momoTransfer = transfers.find((t) => t.id === momoPay.providerRef)!;
    expect(momoTransfer.fx_quote_id).toBe(momoPay.fxQuoteId);
    expect(momoTransfer.account_id).toBe(accounts.USD);

    await sync(h);
    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payout-batches/${batch.id}`, headers: auth });
    expect(done.json().status).toBe("completed");
    expect(done.json().payouts.every((p: any) => p.status === "settled")).toBe(true);

    // The fee Nuvion reported for each transfer (the mock reports 0)
    // was captured onto the payout records by the sync loop.
    for (const p of payouts) {
      const got = await h.app.inject({ method: "GET", url: `/v1/payouts/${p.id}`, headers: auth });
      expect(got.json().status).toBe("settled");
      expect(got.json().providerFee).toBe("0");
    }

    // The reconciliation export: one row per payout, each carrying
    // the Nuvion rail, its fiat denomination and provider reference.
    const csv = await h.app.inject({ method: "GET", url: "/v1/reconciliation/payouts.csv", headers: auth });
    expect(csv.statusCode).toBe(200);
    const { head, rows } = parseCsv(csv.body);
    expect(head.slice(-6)).toEqual(["rail", "fiat_currency", "fiat_amount", "fx_quote_id", "provider_ref", "provider_fee"]);
    const batchRows = rows.filter((r) => r.batch_id === batch.id);
    expect(batchRows).toHaveLength(3);
    const csvByPayout = new Map(batchRows.map((r) => [r.payout_id, r]));
    const expected: Array<[any, string, string]> = [
      [bankPay, "NGN", "400"],
      [momoPay, "GHS", "300"],
      [walletPay, "USC", "500"],
    ];
    for (const [p, currency, fiatAmount] of expected) {
      const row = csvByPayout.get(p.id)!;
      expect(row.rail).toBe("nuvion");
      expect(row.fiat_currency).toBe(currency);
      expect(row.fiat_amount).toBe(fiatAmount);
      expect(row.provider_ref).toBe(p.providerRef);
      expect(row.net_amount).toBe(p.amount);
      expect(row.provider_fee).toBe("0");
    }
    expect(csvByPayout.get(momoPay.id)!.fx_quote_id).toBe(momoPay.fxQuoteId);
    expect(csvByPayout.get(bankPay.id)!.fx_quote_id).toBe("");
    expect(csvByPayout.get(walletPay.id)!.fx_quote_id).toBe("");
    // The export's totals for the batch match the batch itself.
    const exportedTotal = batchRows.reduce((sum, r) => sum + BigInt(r.net_amount), 0n).toString();
    expect(exportedTotal).toBe(done.json().totalAmount);
    expect(exportedTotal).toBe("12000000");
  });

  it("exports a legacy Intents payout with rail intents and empty Nuvion columns", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientAddress: "ada.near", destinationAsset: USDC_NEAR, amount: "10000000" },
    });
    expect(created.statusCode).toBe(201);

    const csv = await h.app.inject({ method: "GET", url: "/v1/reconciliation/payouts.csv", headers: auth });
    expect(csv.statusCode).toBe(200);
    const { rows } = parseCsv(csv.body);
    expect(rows).toHaveLength(1);
    expect(rows[0].rail).toBe("intents");
    expect(rows[0].fiat_currency).toBe("");
    expect(rows[0].fiat_amount).toBe("");
    expect(rows[0].fx_quote_id).toBe("");
    expect(rows[0].provider_ref).toBe("");
    expect(rows[0].provider_fee).toBe("");
  });

  it("shows Nuvion transfers and the account summary on the Routing page, with the registry section retired", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock });
    const { merchant, auth } = await makeMerchant(h);
    await linkMerchant(h, merchant.id, auth);
    const rec = await makeRecipient(h, auth, BANK_NGN);
    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000" },
    });
    expect(created.statusCode).toBe(201);
    await sync(h);
    await sync(h);

    const res = await h.app.inject({ method: "GET", url: "/dashboard/routing", headers: dashAuth(h, merchant.id) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Nuvion transfers");
    expect(res.body).toContain("mock_transfer_");
    expect(res.body).toContain("Nuvion account");
    expect(res.body).toContain("NGN account");
    expect(res.body).not.toContain("Registry activity");
    expect(res.body).toContain("Routing activity");
    expect(res.body).toContain("Supported networks and assets");
  });
});
