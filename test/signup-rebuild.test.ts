import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import { MockNuvion } from "../src/services/nuvion.js";
import { hashPassword, hashToken, newSessionToken, SESSION_TTL_MS } from "../src/lib/auth.js";
import type { DashRole } from "../src/lib/core.js";
import type { FetchFn } from "../src/services/webhooks.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};

const PROFILE = {
  legalName: "Acme Ventures Limited",
  registrationNumber: "RC1234567",
  country: "NG",
};

const BANK_NGN = {
  kind: "bank", label: "Yusuf Bello", bankName: "GTBank", accountNumber: "0123456789",
  accountName: "Yusuf Bello", country: "NG", currency: "NGN",
};

const INVOICE_GUARD_MESSAGE =
  "This merchant has no settlement asset configured, so invoices are unavailable. " +
  "Invoices settle on the legacy NEAR Intents rail, which requires a settlement asset; " +
  "Nuvion payouts are unaffected.";

interface Harness {
  app: ReturnType<typeof buildApp>;
  store: Store;
  nuvion?: MockNuvion;
}

const apps: Array<ReturnType<typeof buildApp>> = [];

function makeHarness(opts: Partial<BuildOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-signup-"));
  const store = new Store(join(dir, "test.db"));
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  const app = buildApp({
    store, mockIntents: new MockIntents(), fetchFn,
    config: { webhook: { maxAttempts: 5, baseDelayMs: 1 } },
    ...opts,
  });
  apps.push(app);
  return { app, store, nuvion: opts.mockNuvion };
}

afterEach(async () => {
  while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); }
});

async function createMerchant(h: Harness, payload: Record<string, unknown>) {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { merchant: body.merchant, apiKey: body.apiKey as string, auth: { authorization: `Bearer ${body.apiKey}` } };
}

async function linkMerchant(h: Harness, merchantId: string, auth: Record<string, string>) {
  const res = await h.app.inject({ method: "POST", url: `/v1/merchants/${merchantId}/nuvion/refresh`, headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json().nuvion.accounts as Record<string, string>;
}

const sync = (h: Harness) => h.app.inject({ method: "POST", url: "/v1/internal/sync" });

function sessionCookie(h: Harness, merchantId: string, email: string, role: DashRole): string {
  const { salt, hash } = hashPassword("password-1234");
  const user = h.store.createUser({ merchantId, email, passwordHash: hash, salt, role });
  const token = newSessionToken();
  h.store.createSession(user.id, hashToken(token), new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return `remiglo_session=${token}`;
}

describe("name only merchant creation (sign up rebuild)", () => {
  it("creates with a name alone, links a mock entity, and opens accounts on refresh", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { merchant, auth } = await createMerchant(h, { name: "Name Only Ltd" });
    expect(merchant.name).toBe("Name Only Ltd");
    // No legacy settlement configuration: the fields read back empty.
    expect(merchant.settlementAsset).toBe("");
    expect(merchant.settlementAddress).toBe("");
    expect(merchant.refundTo).toBe("");
    // The Nuvion child entity link happens exactly as for a full sign up.
    expect(merchant.nuvionEntityId).toMatch(/^mock_entity_/);
    expect(merchant.nuvionEntityStatus).toBe("pending");

    const accounts = await linkMerchant(h, merchant.id, auth);
    expect(Object.keys(accounts).sort()).toEqual(["NGN", "USD"]);
    expect(h.store.getMerchant(merchant.id)?.nuvionEntityStatus).toBe("approved");
  });

  it("still requires a name", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("name is required");
  });

  it("refuses a settlement asset that is not a known asset", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const res = await h.app.inject({
      method: "POST", url: "/v1/merchants",
      payload: { name: "Bogus Asset Ltd", settlementAsset: "nep141:bogus.token.near", settlementAddress: "x.near", refundTo: "x.near" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("That settlement asset is not a known asset.");
    expect(h.store.listMerchants()).toHaveLength(0);
  });

  it("completes a Nuvion bank payout end to end for a name only merchant", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { merchant, auth } = await createMerchant(h, { name: "Payouts Only Ltd" });
    await linkMerchant(h, merchant.id, auth);

    const recRes = await h.app.inject({ method: "POST", url: "/v1/recipients", headers: auth, payload: BANK_NGN });
    expect(recRes.statusCode).toBe(201);
    const rec = recRes.json();

    const created = await h.app.inject({
      method: "POST", url: "/v1/payouts", headers: auth,
      payload: { recipientId: rec.id, amount: "5000000" },
    });
    expect(created.statusCode).toBe(201);
    const payout = created.json();
    expect(payout.status).toBe("processing");
    expect(payout.providerRef).toMatch(/^mock_transfer_/);
    expect(payout.fiatCurrency).toBe("NGN");

    await sync(h);
    await sync(h);
    const done = await h.app.inject({ method: "GET", url: `/v1/payouts/${payout.id}`, headers: auth });
    expect(done.json().status).toBe("settled");
  });
});

describe("invoice guard for merchants without a settlement asset", () => {
  it("answers a clear 400 and stores no invoice", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { merchant, auth } = await createMerchant(h, { name: "No Invoices Ltd" });
    const res = await h.app.inject({
      method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "1000000" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(INVOICE_GUARD_MESSAGE);
    const list = await h.app.inject({ method: "GET", url: "/v1/invoices", headers: auth });
    expect(list.json()).toHaveLength(0);
    expect(h.store.listInvoices(merchant.id)).toHaveLength(0);
  });
});

describe("business profile fields", () => {
  it("round trips through creation, the API record and the store", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { merchant, auth } = await createMerchant(h, { name: "Acme", ...PROFILE });
    expect(merchant.legalName).toBe(PROFILE.legalName);
    expect(merchant.registrationNumber).toBe(PROFILE.registrationNumber);
    expect(merchant.country).toBe(PROFILE.country);

    const me = await h.app.inject({ method: "GET", url: "/v1/merchants/me", headers: auth });
    expect(me.json().merchant.legalName).toBe(PROFILE.legalName);
    expect(me.json().merchant.registrationNumber).toBe(PROFILE.registrationNumber);
    expect(me.json().merchant.country).toBe(PROFILE.country);

    const stored = h.store.getMerchant(merchant.id);
    expect(stored?.legalName).toBe(PROFILE.legalName);
    expect(stored?.registrationNumber).toBe(PROFILE.registrationNumber);
    expect(stored?.country).toBe(PROFILE.country);
  });

  it("coexists with settlement fields, and the legacy invoice flow still works", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { merchant, auth } = await createMerchant(h, { name: "Full Profile Ltd", ...SETTLE, ...PROFILE });
    expect(merchant.settlementAsset).toBe(SETTLE.settlementAsset);
    expect(merchant.settlementAddress).toBe(SETTLE.settlementAddress);
    expect(merchant.refundTo).toBe(SETTLE.refundTo);
    expect(merchant.legalName).toBe(PROFILE.legalName);
    expect(merchant.registrationNumber).toBe(PROFILE.registrationNumber);
    expect(merchant.country).toBe(PROFILE.country);

    const inv = await h.app.inject({
      method: "POST", url: "/v1/invoices", headers: auth, payload: { amount: "1000000" },
    });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().settlementAsset).toBe(SETTLE.settlementAsset);
  });

  it("shows the profile on the settings page, with no empty settlement fields presented", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { merchant, auth } = await createMerchant(h, { name: "Acme", ...PROFILE });
    await linkMerchant(h, merchant.id, auth);
    const owner = sessionCookie(h, merchant.id, "owner@example.com", "owner");
    const page = await h.app.inject({ method: "GET", url: "/dashboard/settings", headers: { cookie: owner } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Nuvion fiat account");
    expect(page.body).toContain(PROFILE.legalName);
    expect(page.body).toContain(PROFILE.registrationNumber);
    expect(page.body).toContain("Entity ID");
    // No legacy settlement configuration exists, so none is presented.
    expect(page.body).not.toContain("Settlement asset ID");
    expect(page.body).not.toContain("Settlement address");
    expect(page.body).not.toContain("Refund address");
  });
});
