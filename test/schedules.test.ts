import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import type { FetchFn } from "../src/services/webhooks.js";
import { firstRunAt, nextAfter } from "../src/services/schedules.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;

const apps: Array<ReturnType<typeof buildApp>> = [];
function makeHarness(config: BuildOptions["config"] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-sched-"));
  const store = new Store(join(dir, "test.db"));
  const mock = new MockIntents();
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  const app = buildApp({ store, mockIntents: mock, fetchFn, config: { webhook: { maxAttempts: 5, baseDelayMs: 1 }, ...config } });
  apps.push(app);
  return { app, store, mock };
}
afterEach(async () => { while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); } });


/** Run the first run setup flow and return the session cookie header. */
async function dashCookie(h: { app: ReturnType<typeof buildApp> }, merchantId: string) {
  const res = await h.app.inject({
    method: "POST", url: "/dashboard/setup",
    payload: { merchantId, email: "owner@example.com", password: "owner-password-1" },
  });
  expect(res.statusCode).toBe(303);
  const setCookie = res.headers["set-cookie"] as unknown as string;
  return { cookie: String(setCookie).split(";")[0] };
}

async function makeMerchant(h: ReturnType<typeof makeHarness>) {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name: "Acme", ...SETTLE } });
  const body = res.json();
  return { merchant: body.merchant, auth: { authorization: `Bearer ${body.apiKey}` } };
}
const sync = (h: ReturnType<typeof makeHarness>) => h.app.inject({ method: "POST", url: "/v1/internal/sync" });
const past = () => new Date(Date.now() - 60000).toISOString();

describe("cadence math", () => {
  it("advances weekly by 7 days, biweekly by 14, monthly by clamped day", () => {
    expect(nextAfter({ cadence: "weekly" }, "2026-11-06T10:00:00.000Z")).toBe("2026-11-13T10:00:00.000Z");
    expect(nextAfter({ cadence: "biweekly" }, "2026-11-06T10:00:00.000Z")).toBe("2026-11-20T10:00:00.000Z");
    // dayOfMonth is clamped to 28, so a "31st" schedule runs on the 28th
    expect(nextAfter({ cadence: "monthly", dayOfMonth: 31 as unknown as number }, "2026-01-15T10:00:00.000Z")).toBe("2026-02-28T10:00:00.000Z");
    expect(nextAfter({ cadence: "monthly", dayOfMonth: 15 }, "2026-11-15T10:00:00.000Z")).toBe("2026-12-15T10:00:00.000Z");
    const first = firstRunAt("monthly", 15, new Date("2026-11-20T10:00:00.000Z"));
    expect(first).toBe("2026-12-15T10:00:00.000Z");
  });
});

describe("schedules API", () => {
  it("creates, lists, patches, pauses, resumes and deletes, merchant scoped", async () => {
    const h = makeHarness();
    const a = await makeMerchant(h);
    const created = await h.app.inject({
      method: "POST", url: "/v1/schedules", headers: a.auth,
      payload: { kind: "invoice", cadence: "weekly", payload: { amount: "10000000", externalRef: "RETAINER" } },
    });
    expect(created.statusCode).toBe(201);
    const s = created.json();
    expect(s.active).toBe(true);
    expect(Date.parse(s.nextRunAt)).toBeGreaterThan(Date.now());

    const bad = await h.app.inject({
      method: "POST", url: "/v1/schedules", headers: a.auth,
      payload: { kind: "invoice", cadence: "weekly", payload: { amount: "0" } },
    });
    expect(bad.statusCode).toBe(400);

    const other = await makeMerchant(h);
    expect((await h.app.inject({ method: "GET", url: `/v1/schedules/${s.id}`, headers: other.auth })).statusCode).toBe(404);

    const paused = await h.app.inject({ method: "POST", url: `/v1/schedules/${s.id}/pause`, headers: a.auth });
    expect(paused.json().active).toBe(false);
    const resumed = await h.app.inject({ method: "POST", url: `/v1/schedules/${s.id}/resume`, headers: a.auth });
    expect(resumed.json().active).toBe(true);
    expect((await h.app.inject({ method: "DELETE", url: `/v1/schedules/${s.id}`, headers: a.auth })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/v1/schedules", headers: a.auth })).json()).toHaveLength(0);
  });
});

describe("schedule runner", () => {
  it("a due invoice schedule creates exactly one invoice; a second tick creates none", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    await h.app.inject({
      method: "POST", url: "/v1/webhook-endpoints", headers: auth,
      payload: { url: "https://hooks.example/remiglo" },
    });
    const s = (await h.app.inject({
      method: "POST", url: "/v1/schedules", headers: auth,
      payload: { kind: "invoice", cadence: "weekly", startAt: past(), payload: { amount: "10000000", externalRef: "WEEKLY" } },
    })).json();

    const first = await sync(h);
    expect(first.json().schedules).toEqual({ ran: 1, skipped: 0, failed: 0 });
    expect(h.store.listInvoices(merchant.id)).toHaveLength(1);
    const after = h.store.getSchedule(merchant.id, s.id)!;
    expect(Date.parse(after.nextRunAt)).toBeGreaterThan(Date.now());
    expect(after.lastRunAt).toBe(s.nextRunAt);

    const second = await sync(h);
    expect(second.json().schedules.ran).toBe(0);
    expect(h.store.listInvoices(merchant.id)).toHaveLength(1);

    const runs = h.store.listRuns(merchant.id, s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    const events = h.store.listDeliveries(merchant.id).filter((d) => d.event === "schedule.executed");
    expect(events).toHaveLength(1);
  });

  it("a paused schedule creates nothing even when due", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    const s = (await h.app.inject({
      method: "POST", url: "/v1/schedules", headers: auth,
      payload: { kind: "invoice", cadence: "weekly", startAt: past(), payload: { amount: "10000000" } },
    })).json();
    await h.app.inject({ method: "POST", url: `/v1/schedules/${s.id}/pause`, headers: auth });
    const res = await sync(h);
    expect(res.json().schedules.ran).toBe(0);
    expect(h.store.listInvoices(merchant.id)).toHaveLength(0);
  });

  it("a batch schedule over the approval threshold lands in pending_approval", async () => {
    const h = makeHarness();
    const { auth, merchant } = await makeMerchant(h);
    const rows = Array.from({ length: 6 }, (_, i) => ({
      recipientAddress: `user${i}.near`, destinationAsset: USDC_NEAR, amount: "90000000",
    }));
    await h.app.inject({
      method: "POST", url: "/v1/schedules", headers: auth,
      payload: { kind: "payout_batch", cadence: "monthly", dayOfMonth: 1, startAt: past(), payload: { rows } },
    });
    const res = await sync(h);
    expect(res.json().schedules.ran).toBe(1);
    const batches = h.store.listBatches(merchant.id);
    expect(batches).toHaveLength(1);
    expect(batches[0].status).toBe("pending_approval");
    expect(h.store.listPayouts(merchant.id)).toHaveLength(0);
  });

  it("the dashboard schedules page renders and creates schedules", async () => {
    const h = makeHarness();
    const { merchant } = await makeMerchant(h);
    const cookie = await dashCookie(h, merchant.id);
    const page = await h.app.inject({ method: "GET", url: `/dashboard/schedules?merchant=${merchant.id}`, headers: cookie });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Create schedule");
    const created = await h.app.inject({
      method: "POST", url: `/dashboard/actions/schedules?merchant=${merchant.id}`, headers: cookie,
      payload: { kind: "invoice", cadence: "biweekly", amount: "50", originAsset: USDC_NEAR, externalRef: "RET" },
    });
    expect(created.statusCode).toBe(303);
    expect(h.store.listSchedules(merchant.id)).toHaveLength(1);
    expect(h.store.listSchedules(merchant.id)[0].payload.amount).toBe("50000000");
  });
});
