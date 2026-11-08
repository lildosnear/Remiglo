import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import type { FetchFn } from "../src/services/webhooks.js";
import { can, hashPassword } from "../src/lib/auth.js";
import type { DashRole } from "../src/lib/core.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;

const apps: Array<ReturnType<typeof buildApp>> = [];
function makeHarness(config: BuildOptions["config"] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-auth-"));
  const store = new Store(join(dir, "test.db"));
  const mock = new MockIntents();
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  const app = buildApp({ store, mockIntents: mock, fetchFn, config: { webhook: { maxAttempts: 5, baseDelayMs: 1 }, ...config } });
  apps.push(app);
  return { app, store, mock };
}
afterEach(async () => { while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); } });

type H = ReturnType<typeof makeHarness>;

async function makeMerchant(h: H, name = "Acme") {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name, ...SETTLE } });
  const body = res.json();
  return { merchant: body.merchant, auth: { authorization: `Bearer ${body.apiKey}` } };
}

function addUser(h: H, merchantId: string, email: string, role: DashRole, password = "password-123") {
  const { salt, hash } = hashPassword(password);
  return h.store.createUser({ merchantId, email, passwordHash: hash, salt, role });
}

async function login(h: H, email: string, password = "password-123") {
  const res = await h.app.inject({ method: "POST", url: "/dashboard/login", payload: { email, password } });
  return res;
}
async function cookieFor(h: H, email: string, password = "password-123") {
  const res = await login(h, email, password);
  expect(res.statusCode).toBe(303);
  expect(res.headers.location).toBe("/dashboard");
  const setCookie = res.headers["set-cookie"] as unknown as string;
  return { cookie: String(setCookie).split(";")[0] };
}

async function seedPendingBatch(h: H, auth: { authorization: string }) {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    recipientAddress: `user${i}.near`, destinationAsset: USDC_NEAR, amount: "90000000",
  }));
  const res = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: auth, payload: { rows } });
  expect(res.json().status).toBe("pending_approval");
  return res.json().id as string;
}

describe("permission matrix (lib/auth)", () => {
  it("encodes viewer read only, operator no approve, admin approve, owner team manage", () => {
    expect(can("viewer", "view")).toBe(true);
    expect(can("viewer", "create")).toBe(false);
    expect(can("viewer", "approve")).toBe(false);
    expect(can("operator", "create")).toBe(true);
    expect(can("operator", "approve")).toBe(false);
    expect(can("operator", "teamManage")).toBe(false);
    expect(can("admin", "approve")).toBe(true);
    expect(can("admin", "settings")).toBe(true);
    expect(can("admin", "teamManage")).toBe(false);
    expect(can("owner", "teamManage")).toBe(true);
  });
});

describe("setup and login flow", () => {
  it("setup creates the owner, locks the dashboard behind login, and login works", async () => {
    const h = makeHarness();
    const { merchant } = await makeMerchant(h);

    const before = await h.app.inject({ method: "GET", url: "/dashboard" });
    expect(before.statusCode).toBe(303);
    expect(before.headers.location).toBe("/dashboard/setup");

    const setup = await h.app.inject({
      method: "POST", url: "/dashboard/setup",
      payload: { merchantId: merchant.id, email: "Owner@Example.com", password: "owner-password" },
    });
    expect(setup.statusCode).toBe(303);
    expect(setup.headers.location).toBe("/dashboard");
    const ownerCookie = String(setup.headers["set-cookie"] as unknown as string).split(";")[0];
    expect(ownerCookie).toContain("remiglo_session=");
    expect(h.store.countUsers()).toBe(1);
    expect(h.store.listUsers(merchant.id)[0].role).toBe("owner");
    expect(h.store.listUsers(merchant.id)[0].email).toBe("owner@example.com");

    // Setup is closed now; the picker is gone and login is required.
    const setupAgain = await h.app.inject({ method: "GET", url: "/dashboard/setup" });
    expect(setupAgain.headers.location).toBe("/dashboard/login");
    const locked = await h.app.inject({ method: "GET", url: "/dashboard" });
    expect(locked.statusCode).toBe(303);
    expect(locked.headers.location).toBe("/dashboard/login");

    // The setup session itself works.
    const viaSetup = await h.app.inject({ method: "GET", url: "/dashboard", headers: { cookie: ownerCookie } });
    expect(viaSetup.statusCode).toBe(200);

    // Wrong password fails; right password signs in.
    const bad = await login(h, "owner@example.com", "wrong-password");
    expect(bad.headers.location).toContain("/dashboard/login?error=");
    const good = await cookieFor(h, "owner@example.com", "owner-password");
    const page = await h.app.inject({ method: "GET", url: "/dashboard", headers: good });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("owner@example.com");

    // Logout revokes the session.
    await h.app.inject({ method: "GET", url: "/dashboard/logout", headers: good });
    const afterLogout = await h.app.inject({ method: "GET", url: "/dashboard", headers: good });
    expect(afterLogout.headers.location).toBe("/dashboard/login");
  });

  it("rejects a short password and an unknown merchant at setup", async () => {
    const h = makeHarness();
    const { merchant } = await makeMerchant(h);
    const short = await h.app.inject({
      method: "POST", url: "/dashboard/setup",
      payload: { merchantId: merchant.id, email: "a@b.co", password: "short" },
    });
    expect(short.headers.location).toContain("error=");
    expect(h.store.countUsers()).toBe(0);
  });
});

describe("role enforcement on actions and pages", () => {
  async function setupAll(h: H) {
    const { merchant, auth } = await makeMerchant(h);
    addUser(h, merchant.id, "owner@example.com", "owner");
    addUser(h, merchant.id, "admin@example.com", "admin");
    addUser(h, merchant.id, "ops@example.com", "operator");
    addUser(h, merchant.id, "view@example.com", "viewer");
    const batchId = await seedPendingBatch(h, auth);
    return { merchant, auth, batchId };
  }

  it("viewer sees no approve button and cannot approve; operator cannot approve; admin can", async () => {
    const h = makeHarness();
    const { merchant, batchId } = await setupAll(h);
    const approveUrl = `/dashboard/actions/batches/${batchId}/approve`;

    const viewer = await cookieFor(h, "view@example.com");
    const overview = await h.app.inject({ method: "GET", url: "/dashboard", headers: viewer });
    expect(overview.statusCode).toBe(200);
    expect(overview.body).toContain("Pending approvals");
    expect(overview.body).not.toContain(`action="/dashboard/actions/batches/${batchId}/approve"`);
    expect(overview.body).not.toContain("Send payout</a>");
    const viewerTry = await h.app.inject({ method: "POST", url: approveUrl, headers: viewer });
    expect(viewerTry.statusCode).toBe(403);
    expect(h.store.getBatchById(batchId)?.status).toBe("pending_approval");

    const ops = await cookieFor(h, "ops@example.com");
    const opsTry = await h.app.inject({ method: "POST", url: approveUrl, headers: ops });
    expect(opsTry.statusCode).toBe(403);
    expect(h.store.getBatchById(batchId)?.status).toBe("pending_approval");
    // ...but an operator can create an invoice.
    const inv = await h.app.inject({
      method: "POST", url: `/dashboard/actions/invoices?merchant=${merchant.id}`, headers: ops,
      payload: { amount: "10", originAsset: USDC_NEAR, externalRef: "OPS-1" },
    });
    expect(inv.statusCode).toBe(303);

    const admin = await cookieFor(h, "admin@example.com");
    const adminTry = await h.app.inject({ method: "POST", url: approveUrl, headers: admin });
    expect(adminTry.statusCode).toBe(303);
    expect(h.store.getBatchById(batchId)?.status).toBe("active");
  });

  it("settings edit persists for admin and is refused for operator", async () => {
    const h = makeHarness();
    const { merchant } = await setupAll(h);
    const ops = await cookieFor(h, "ops@example.com");
    const denied = await h.app.inject({
      method: "POST", url: `/dashboard/actions/settings?merchant=${merchant.id}`, headers: ops,
      payload: { name: "Nope", settlementAsset: USDC_NEAR, settlementAddress: "x.near", refundTo: "x.near" },
    });
    expect(denied.statusCode).toBe(403);

    const admin = await cookieFor(h, "admin@example.com");
    const saved = await h.app.inject({
      method: "POST", url: `/dashboard/actions/settings?merchant=${merchant.id}`, headers: admin,
      payload: { name: "Acme Renamed", settlementAsset: USDC_NEAR, settlementAddress: "vault.near", refundTo: "refunds.near" },
    });
    expect(saved.statusCode).toBe(303);
    const after = h.store.getMerchant(merchant.id)!;
    expect(after.name).toBe("Acme Renamed");
    expect(after.settlementAddress).toBe("vault.near");
    expect(after.refundTo).toBe("refunds.near");
  });

  it("team create shows a one time temporary password; owner changes roles, admin cannot", async () => {
    const h = makeHarness();
    const { merchant } = await setupAll(h);
    const admin = await cookieFor(h, "admin@example.com");
    const created = await h.app.inject({
      method: "POST", url: `/dashboard/actions/team?merchant=${merchant.id}`, headers: admin,
      payload: { email: "new@example.com", role: "operator" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).toContain("Temporary password (shown once");
    expect(created.body).toMatch(/Rgl-[0-9a-f]{12}/);
    const member = h.store.listUsers(merchant.id).find((u) => u.email === "new@example.com")!;
    expect(member.role).toBe("operator");

    const roleUrl = `/dashboard/actions/team/${member.id}/role?merchant=${merchant.id}`;
    const adminTry = await h.app.inject({ method: "POST", url: roleUrl, headers: admin, payload: { role: "admin" } });
    expect(adminTry.statusCode).toBe(403);
    expect(h.store.getUser(member.id)?.role).toBe("operator");

    const owner = await cookieFor(h, "owner@example.com");
    const ownerTry = await h.app.inject({ method: "POST", url: roleUrl, headers: owner, payload: { role: "viewer" } });
    expect(ownerTry.statusCode).toBe(303);
    expect(h.store.getUser(member.id)?.role).toBe("viewer");

    const deact = await h.app.inject({
      method: "POST", url: `/dashboard/actions/team/${member.id}/deactivate?merchant=${merchant.id}`, headers: owner,
    });
    expect(deact.statusCode).toBe(303);
    expect(h.store.getUser(member.id)?.active).toBe(false);
  });

  it("API keys keep working unchanged alongside dashboard accounts", async () => {
    const h = makeHarness();
    const { auth } = await setupAll(h);
    const res = await h.app.inject({ method: "GET", url: "/v1/invoices", headers: auth });
    expect(res.statusCode).toBe(200);
  });
});
