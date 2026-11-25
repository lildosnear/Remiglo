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
const USDC_NEAR = SETTLE.settlementAsset;
const EVM_WALLET = "0xabc0000000000000000000000000000000000001";

const BANK = {
  kind: "bank", label: "Yusuf Bello", bankName: "GTBank", accountNumber: "0123456789",
  accountName: "Yusuf Bello", country: "NG", currency: "NGN",
};
const MOMO = {
  kind: "momo", label: "Ama Serwaa", momoProvider: "MTN", phoneNumber: "+233241234567",
  country: "GH", currency: "GHS",
};

/** A Nuvion client whose counterparty creation always fails. */
class CounterpartyFailingNuvion extends MockNuvion {
  async createCounterparty(): Promise<never> {
    throw new Error("Nuvion /counterparties failed with 503: unavailable");
  }
}

interface Harness {
  app: ReturnType<typeof buildApp>;
  store: Store;
  nuvion?: MockNuvion;
}

const apps: Array<ReturnType<typeof buildApp>> = [];

function makeHarness(opts: Partial<BuildOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-rcp-kinds-"));
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

async function makeMerchant(h: Harness, name = "Acme") {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name, ...SETTLE } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { merchant: body.merchant, apiKey: body.apiKey as string, auth: { authorization: `Bearer ${body.apiKey}` } };
}

function sessionCookie(h: Harness, merchantId: string, email: string, role: DashRole): string {
  const { salt, hash } = hashPassword("password-1234");
  const user = h.store.createUser({ merchantId, email, passwordHash: hash, salt, role });
  const token = newSessionToken();
  h.store.createSession(user.id, hashToken(token), new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return `remiglo_session=${token}`;
}

describe("recipient kinds", () => {
  it("stores a bank recipient's details", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    const created = await h.app.inject({ method: "POST", url: "/v1/recipients", headers: auth, payload: BANK });
    expect(created.statusCode).toBe(201);
    const rec = created.json();
    expect(rec.kind).toBe("bank");
    expect(rec.bankName).toBe("GTBank");
    expect(rec.accountNumber).toBe("0123456789");
    expect(rec.accountName).toBe("Yusuf Bello");
    expect(rec.country).toBe("NG");
    expect(rec.currency).toBe("NGN");
    // The account number is where the money goes, so it fills address.
    expect(rec.address).toBe("0123456789");
    const stored = h.store.getRecipient(merchant.id, rec.id);
    expect(stored?.kind).toBe("bank");
    expect(stored?.bankName).toBe("GTBank");
  });

  it("stores a mobile money recipient's details", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    const created = await h.app.inject({ method: "POST", url: "/v1/recipients", headers: auth, payload: MOMO });
    expect(created.statusCode).toBe(201);
    const rec = created.json();
    expect(rec.kind).toBe("momo");
    expect(rec.momoProvider).toBe("MTN");
    expect(rec.phoneNumber).toBe("+233241234567");
    expect(rec.country).toBe("GH");
    expect(rec.currency).toBe("GHS");
    expect(rec.address).toBe("+233241234567");
    expect(h.store.getRecipient(merchant.id, rec.id)?.momoProvider).toBe("MTN");
  });

  it("accepts a wallet recipient with a supported network and refuses the rest", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const ok = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Base contractor", address: EVM_WALLET, assetId: USDC_NEAR, network: "BASE_MAINNET" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().kind).toBe("wallet");
    expect(ok.json().network).toBe("BASE_MAINNET");

    const bad = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Near contractor", address: "ada.near", assetId: USDC_NEAR, network: "NEAR_MAINNET" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/not supported/);

    const polygon = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Polygon contractor", address: EVM_WALLET, assetId: USDC_NEAR, network: "POLYGON_MAINNET" },
    });
    expect(polygon.statusCode).toBe(400);
    expect(polygon.json().error).toMatch(/MATIC_MAINNET/);
  });

  it("keeps the original address only shape working, read back as kind wallet", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    const created = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Ada the designer", address: "ada.near", assetId: USDC_NEAR },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().kind).toBe("wallet");
    expect(created.json().network).toBeUndefined();
    expect(h.store.getRecipient(merchant.id, created.json().id)?.kind).toBe("wallet");
  });

  it("refuses unknown kinds and incomplete bank or momo recipients", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const unknown = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { kind: "crypto", label: "X", address: "x.near", assetId: USDC_NEAR },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/kind must be one of/);

    const noBankName = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { ...BANK, bankName: undefined },
    });
    expect(noBankName.statusCode).toBe(400);
    expect(noBankName.json().error).toMatch(/bankName is required/);

    const noPhone = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { ...MOMO, phoneNumber: undefined },
    });
    expect(noPhone.statusCode).toBe(400);
    expect(noPhone.json().error).toMatch(/phoneNumber is required/);
  });

  it("switches a recipient's kind on update when the new kind's fields are complete", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const created = (await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Ada", address: "ada.near", assetId: USDC_NEAR },
    })).json();

    const incomplete = await h.app.inject({
      method: "PATCH", url: `/v1/recipients/${created.id}`, headers: auth, payload: { kind: "bank" },
    });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json().error).toMatch(/required for a bank recipient/);

    const switched = await h.app.inject({
      method: "PATCH", url: `/v1/recipients/${created.id}`, headers: auth,
      payload: { kind: "bank", bankName: "GTBank", accountNumber: "0987654321", accountName: "Ada Lovelace", country: "NG", currency: "NGN" },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().kind).toBe("bank");
    expect(switched.json().accountNumber).toBe("0987654321");
    expect(switched.json().address).toBe("0987654321");
  });
});

describe("recipient nuvion counterparty linking", () => {
  it("stores counterparty and payment detail ids at creation for a linked merchant", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { auth, merchant } = await makeMerchant(h);
    expect(merchant.nuvionEntityId).toMatch(/^mock_entity_/);

    const bank = await h.app.inject({ method: "POST", url: "/v1/recipients", headers: auth, payload: BANK });
    expect(bank.statusCode).toBe(201);
    expect(bank.json().nuvionCounterpartyId).toMatch(/^mock_counterparty_/);
    expect(bank.json().nuvionPaymentDetailId).toMatch(/^mock_payment_detail_/);
    const stored = h.store.getRecipient(merchant.id, bank.json().id);
    expect(stored?.nuvionCounterpartyId).toBe(bank.json().nuvionCounterpartyId);
    expect(stored?.nuvionPaymentDetailId).toBe(bank.json().nuvionPaymentDetailId);

    const wallet = await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Base contractor", address: EVM_WALLET, assetId: USDC_NEAR, network: "BASE_MAINNET" },
    });
    expect(wallet.statusCode).toBe(201);
    expect(wallet.json().nuvionCounterpartyId).toMatch(/^mock_counterparty_/);
    expect(wallet.json().nuvionPaymentDetailId).toMatch(/^mock_payment_detail_/);

    const kinds = h.store.listLedger(merchant.id).map((e) => e.kind);
    expect(kinds.filter((k) => k === "nuvion_counterparty_linked")).toHaveLength(2);
  });

  it("still creates the recipient, unlinked, when Nuvion fails", async () => {
    const h = makeHarness({ mockNuvion: new CounterpartyFailingNuvion() });
    const { auth, merchant } = await makeMerchant(h);
    const created = await h.app.inject({ method: "POST", url: "/v1/recipients", headers: auth, payload: BANK });
    expect(created.statusCode).toBe(201);
    expect(created.json().kind).toBe("bank");
    expect(created.json().nuvionCounterpartyId).toBeUndefined();
    expect(created.json().nuvionPaymentDetailId).toBeUndefined();
    const kinds = h.store.listLedger(merchant.id).map((e) => e.kind);
    expect(kinds).toContain("nuvion_counterparty_link_failed");
  });

  it("leaves recipients exactly as before when the merchant is not linked", async () => {
    const h = makeHarness();
    const { auth } = await makeMerchant(h);
    const created = await h.app.inject({ method: "POST", url: "/v1/recipients", headers: auth, payload: BANK });
    expect(created.statusCode).toBe(201);
    expect(created.json().nuvionCounterpartyId).toBeUndefined();
    expect(created.json().nuvionPaymentDetailId).toBeUndefined();
  });

  it("re links when payment details change, and not when only the label changes", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { auth } = await makeMerchant(h);
    const created = (await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Base contractor", address: EVM_WALLET, assetId: USDC_NEAR, network: "BASE_MAINNET" },
    })).json();
    const firstCounterparty = created.nuvionCounterpartyId;
    expect(firstCounterparty).toMatch(/^mock_counterparty_/);

    const relabelled = await h.app.inject({
      method: "PATCH", url: `/v1/recipients/${created.id}`, headers: auth, payload: { label: "Base contractor (lead)" },
    });
    expect(relabelled.statusCode).toBe(200);
    expect(relabelled.json().nuvionCounterpartyId).toBe(firstCounterparty);

    const moved = await h.app.inject({
      method: "PATCH", url: `/v1/recipients/${created.id}`, headers: auth, payload: { network: "ETH_MAINNET" },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().network).toBe("ETH_MAINNET");
    expect(moved.json().nuvionCounterpartyId).toMatch(/^mock_counterparty_/);
    expect(moved.json().nuvionCounterpartyId).not.toBe(firstCounterparty);
  });
});

describe("recipient kinds on the dashboard", () => {
  it("renders bank, mobile money and wallet recipients with their details", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    await h.app.inject({ method: "POST", url: "/v1/recipients", headers: auth, payload: BANK });
    await h.app.inject({ method: "POST", url: "/v1/recipients", headers: auth, payload: MOMO });
    await h.app.inject({
      method: "POST", url: "/v1/recipients", headers: auth,
      payload: { label: "Base contractor", address: EVM_WALLET, assetId: USDC_NEAR, network: "BASE_MAINNET" },
    });

    const owner = sessionCookie(h, merchant.id, "owner@example.com", "owner");
    const page = await h.app.inject({ method: "GET", url: "/dashboard/recipients", headers: { cookie: owner } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Bank account");
    expect(page.body).toContain("GTBank");
    expect(page.body).toContain("0123456789");
    expect(page.body).toContain("Mobile money");
    expect(page.body).toContain("MTN");
    expect(page.body).toContain("+233241234567");
    expect(page.body).toContain("Wallet");
    expect(page.body).toContain("BASE_MAINNET");
    // The create form offers all three kinds.
    expect(page.body).toContain('name="kind"');
    expect(page.body).toContain('name="bankName"');
    expect(page.body).toContain('name="momoProvider"');
  });

  it("creates a bank recipient from the dashboard form", async () => {
    const h = makeHarness();
    const { merchant } = await makeMerchant(h);
    const owner = sessionCookie(h, merchant.id, "owner@example.com", "owner");
    const res = await h.app.inject({
      method: "POST", url: `/dashboard/actions/recipients?merchant=${merchant.id}`,
      headers: { cookie: owner, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        label: "Yusuf Bello", kind: "bank", bankName: "GTBank", accountNumber: "0123456789",
        accountName: "Yusuf Bello", country: "NG", currency: "NGN",
      }).toString(),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("notice=");
    const stored = h.store.listRecipients(merchant.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].kind).toBe("bank");
    expect(stored[0].accountNumber).toBe("0123456789");
  });
});
