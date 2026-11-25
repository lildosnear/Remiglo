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

/** A Nuvion client whose entity creation always fails (outage, bad key, ...). */
class FailingNuvion extends MockNuvion {
  async createEntity(): Promise<never> {
    throw new Error("Nuvion /business-entities failed with 503: unavailable");
  }
}

interface Harness {
  app: ReturnType<typeof buildApp>;
  store: Store;
  nuvion?: MockNuvion;
}

const apps: Array<ReturnType<typeof buildApp>> = [];

function makeHarness(opts: Partial<BuildOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-nuvion-link-"));
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

describe("nuvion merchant linking at creation", () => {
  it("creates a child entity and stores the link when Nuvion is available", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { merchant, auth } = await makeMerchant(h);
    expect(merchant.nuvionEntityId).toMatch(/^mock_entity_/);
    expect(merchant.nuvionEntityStatus).toBe("pending");
    const stored = h.store.getMerchant(merchant.id);
    expect(stored?.nuvionEntityId).toBe(merchant.nuvionEntityId);
    expect(stored?.nuvionEntityStatus).toBe("pending");
    // The link is visible through the API key path too.
    const me = await h.app.inject({ method: "GET", url: "/v1/merchants/me", headers: auth });
    expect(me.json().merchant.nuvionEntityId).toBe(merchant.nuvionEntityId);
    const kinds = h.store.listLedger(merchant.id).map((e) => e.kind);
    expect(kinds).toContain("nuvion_entity_linked");
  });

  it("still creates the merchant, unlinked, when Nuvion fails", async () => {
    const h = makeHarness({ mockNuvion: new FailingNuvion() });
    const { merchant, apiKey } = await makeMerchant(h);
    expect(apiKey).toMatch(/^rgl_live_[0-9a-f]{48}$/);
    expect(merchant.nuvionEntityId).toBeUndefined();
    expect(merchant.nuvionEntityStatus).toBe("unlinked");
    const stored = h.store.getMerchant(merchant.id);
    expect(stored?.nuvionEntityStatus).toBe("unlinked");
    const kinds = h.store.listLedger(merchant.id).map((e) => e.kind);
    expect(kinds).toContain("nuvion_link_failed");
  });

  it("leaves merchant creation exactly as before when no Nuvion client is configured", async () => {
    const h = makeHarness();
    const { merchant } = await makeMerchant(h);
    expect(merchant.nuvionEntityId).toBeUndefined();
    expect(merchant.nuvionEntityStatus).toBeUndefined();
    expect(merchant.nuvionAccounts).toBeUndefined();
  });
});

describe("nuvion status refresh", () => {
  it("mirrors approval and opens the default currency accounts exactly once", async () => {
    const mock = new MockNuvion();
    const h = makeHarness({ mockNuvion: mock });
    const { merchant, auth } = await makeMerchant(h);

    const first = await h.app.inject({ method: "POST", url: `/v1/merchants/${merchant.id}/nuvion/refresh`, headers: auth });
    expect(first.statusCode).toBe(200);
    const state = first.json().nuvion;
    expect(state.entityId).toBe(merchant.nuvionEntityId);
    expect(state.status).toBe("approved");
    expect(Object.keys(state.accounts).sort()).toEqual(["NGN", "USD"]);
    expect(h.store.getMerchant(merchant.id)?.nuvionEntityStatus).toBe("approved");
    expect(await mock.listAccounts(merchant.nuvionEntityId)).toHaveLength(2);

    const second = await h.app.inject({ method: "POST", url: `/v1/merchants/${merchant.id}/nuvion/refresh`, headers: auth });
    expect(second.statusCode).toBe(200);
    expect(second.json().nuvion.accounts).toEqual(state.accounts);
    expect(await mock.listAccounts(merchant.nuvionEntityId)).toHaveLength(2);
  });

  it("honours a configured currency list", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion(), config: { nuvionCurrencies: ["NGN", "KES", "USD"] } });
    const { merchant, auth } = await makeMerchant(h);
    const res = await h.app.inject({ method: "POST", url: `/v1/merchants/${merchant.id}/nuvion/refresh`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().nuvion.accounts).sort()).toEqual(["KES", "NGN", "USD"]);
  });

  it("refuses cross merchant refresh with a 404 and no key with a 401", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const a = await makeMerchant(h, "A");
    const b = await makeMerchant(h, "B");
    const cross = await h.app.inject({ method: "POST", url: `/v1/merchants/${a.merchant.id}/nuvion/refresh`, headers: b.auth });
    expect(cross.statusCode).toBe(404);
    const anon = await h.app.inject({ method: "POST", url: `/v1/merchants/${a.merchant.id}/nuvion/refresh` });
    expect(anon.statusCode).toBe(401);
    // A's state is untouched by B's attempt.
    expect(h.store.getMerchant(a.merchant.id)?.nuvionEntityStatus).toBe("pending");
  });

  it("answers 409 when Nuvion is not configured or the merchant is unlinked", async () => {
    const plain = makeHarness();
    const p = await makeMerchant(plain);
    const noClient = await plain.app.inject({ method: "POST", url: `/v1/merchants/${p.merchant.id}/nuvion/refresh`, headers: p.auth });
    expect(noClient.statusCode).toBe(409);

    const failing = makeHarness({ mockNuvion: new FailingNuvion() });
    const f = await makeMerchant(failing);
    const unlinked = await failing.app.inject({ method: "POST", url: `/v1/merchants/${f.merchant.id}/nuvion/refresh`, headers: f.auth });
    expect(unlinked.statusCode).toBe(409);
  });
});

describe("nuvion state on the dashboard settings page", () => {
  it("shows the entity and its accounts to owner and viewer alike", async () => {
    const h = makeHarness({ mockNuvion: new MockNuvion() });
    const { merchant, auth } = await makeMerchant(h);
    const refreshed = await h.app.inject({ method: "POST", url: `/v1/merchants/${merchant.id}/nuvion/refresh`, headers: auth });
    const accounts = refreshed.json().nuvion.accounts as Record<string, string>;

    const owner = sessionCookie(h, merchant.id, "owner@example.com", "owner");
    const page = await h.app.inject({ method: "GET", url: "/dashboard/settings", headers: { cookie: owner } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Nuvion fiat account");
    expect(page.body).toContain(merchant.nuvionEntityId);
    expect(page.body).toContain(accounts.NGN);
    expect(page.body).toContain(accounts.USD);

    const viewer = sessionCookie(h, merchant.id, "viewer@example.com", "viewer");
    const viewerPage = await h.app.inject({ method: "GET", url: "/dashboard/settings", headers: { cookie: viewer } });
    expect(viewerPage.statusCode).toBe(200);
    expect(viewerPage.body).toContain("Nuvion fiat account");
    expect(viewerPage.body).toContain(merchant.nuvionEntityId);
  });

  it("shows a plain not linked state when there is no entity", async () => {
    const h = makeHarness();
    const { merchant } = await makeMerchant(h);
    const owner = sessionCookie(h, merchant.id, "owner@example.com", "owner");
    const page = await h.app.inject({ method: "GET", url: "/dashboard/settings", headers: { cookie: owner } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Nuvion fiat account");
    expect(page.body).toContain("Not linked");
  });
});
