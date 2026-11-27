import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import { hashPassword, hashToken, newSessionToken, SESSION_TTL_MS } from "../src/lib/auth.js";
import type { FetchFn } from "../src/services/webhooks.js";
import type { DashRole, DashUser } from "../src/lib/core.js";

const SETTLE = {
  settlementAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  settlementAddress: "merchant.near",
  refundTo: "merchant.near",
};
const USDC_NEAR = SETTLE.settlementAsset;

// Two rows of 200 USDC: 400 in total. The harness sets the approval
// threshold to 300 and the pilot cap to 200, so every batch built
// from these rows waits in pending_approval.
const OVER_THRESHOLD_CSV = [
  "recipient_address,destination_asset,amount_units",
  `ama.near,${USDC_NEAR},200000000`,
  `tunde.near,${USDC_NEAR},200000000`,
].join("\n");
const OVER_THRESHOLD_ROWS = [
  { recipientAddress: "ama.near", destinationAsset: USDC_NEAR, amount: "200000000" },
  { recipientAddress: "tunde.near", destinationAsset: USDC_NEAR, amount: "200000000" },
];

interface Harness {
  app: ReturnType<typeof buildApp>;
  store: Store;
}

const apps: Array<ReturnType<typeof buildApp>> = [];

function makeHarness(config: BuildOptions["config"] = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-maker-checker-"));
  const store = new Store(join(dir, "test.db"));
  const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
  const app = buildApp({
    store, mockIntents: new MockIntents(), fetchFn,
    config: {
      webhook: { maxAttempts: 5, baseDelayMs: 1 },
      approvalThresholdUnits: "300000000", pilotMaxPayoutUnits: "200000000",
      ...config,
    },
  });
  apps.push(app);
  return { app, store };
}

afterEach(async () => {
  while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); }
});

async function makeMerchant(h: Harness) {
  const res = await h.app.inject({ method: "POST", url: "/v1/merchants", payload: { name: "Acme", ...SETTLE } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { merchant: body.merchant, apiKey: body.apiKey as string, auth: { authorization: `Bearer ${body.apiKey}` } };
}

/** Create a dashboard user directly in the store and return it with its session cookie. */
function addUser(h: Harness, merchantId: string, email: string, role: DashRole): { user: DashUser; cookie: string } {
  const { salt, hash } = hashPassword("maker-checker-password-1");
  const user = h.store.createUser({ merchantId, email, passwordHash: hash, salt, role });
  const token = newSessionToken();
  h.store.createSession(user.id, hashToken(token), new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return { user, cookie: `remiglo_session=${token}` };
}

/** Create an over threshold batch from the dashboard CSV upload, as the given user. */
async function dashCreateBatch(h: Harness, merchantId: string, cookie: string) {
  const res = await h.app.inject({
    method: "POST", url: `/dashboard/actions/batches/csv?merchant=${merchantId}`,
    headers: { cookie }, payload: { csv: OVER_THRESHOLD_CSV },
  });
  expect(res.statusCode).toBe(303);
  const batches = h.store.listBatches(merchantId);
  expect(batches).toHaveLength(1);
  expect(batches[0].status).toBe("pending_approval");
  return batches[0];
}

const dashApprove = (h: Harness, batchId: string, cookie: string) =>
  h.app.inject({ method: "POST", url: `/dashboard/actions/batches/${batchId}/approve`, headers: { cookie } });

describe("maker and checker separation", () => {
  it("refuses the creator's own approval with a 403, executes nothing, and explains itself on the batch page", async () => {
    const h = makeHarness();
    const { merchant } = await makeMerchant(h);
    const owner = addUser(h, merchant.id, "owner-mc@example.com", "owner");

    const batch = await dashCreateBatch(h, merchant.id, owner.cookie);
    expect(batch.createdBy).toBe(owner.user.id);
    expect(batch.approvedBy).toBeUndefined();

    // The batch page tells the creator why, and offers no approve form.
    const page = await h.app.inject({ method: "GET", url: `/dashboard/payouts/batches/${batch.id}`, headers: { cookie: owner.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("You created this batch, so you cannot approve it");
    expect(page.body).not.toContain(`action="/dashboard/actions/batches/${batch.id}/approve"`);
    expect(page.body).toContain("Created by");
    expect(page.body).toContain("owner-mc@example.com");

    const refused = await dashApprove(h, batch.id, owner.cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain("You created this batch, so you cannot approve it");
    expect(refused.json().error).toContain("Maker and checker separation");

    const after = h.store.getBatchById(batch.id)!;
    expect(after.status).toBe("pending_approval");
    expect(after.approvedBy).toBeUndefined();
    expect(h.store.listPayouts(merchant.id)).toHaveLength(0);
  });

  it("lets a second approver release the creator's batch, and records and shows both actors", async () => {
    const h = makeHarness();
    const { merchant } = await makeMerchant(h);
    const owner = addUser(h, merchant.id, "owner-mc@example.com", "owner");
    const admin = addUser(h, merchant.id, "admin-mc@example.com", "admin");

    const batch = await dashCreateBatch(h, merchant.id, owner.cookie);
    const res = await dashApprove(h, batch.id, admin.cookie);
    expect(res.statusCode).toBe(303);

    const after = h.store.getBatchById(batch.id)!;
    expect(after.status).toBe("active");
    expect(after.createdBy).toBe(owner.user.id);
    expect(after.approvedBy).toBe(admin.user.id);
    expect(h.store.listPayouts(merchant.id)).toHaveLength(2);

    const page = await h.app.inject({ method: "GET", url: `/dashboard/payouts/batches/${batch.id}`, headers: { cookie: admin.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Created by");
    expect(page.body).toContain("owner-mc@example.com");
    expect(page.body).toContain("Approved by");
    expect(page.body).toContain("admin-mc@example.com");
  });

  it("lets an admin approve a batch an operator created", async () => {
    const h = makeHarness();
    const { merchant } = await makeMerchant(h);
    const operator = addUser(h, merchant.id, "ops-mc@example.com", "operator");
    const admin = addUser(h, merchant.id, "admin-mc@example.com", "admin");

    const batch = await dashCreateBatch(h, merchant.id, operator.cookie);
    expect(batch.createdBy).toBe(operator.user.id);

    const res = await dashApprove(h, batch.id, admin.cookie);
    expect(res.statusCode).toBe(303);
    const after = h.store.getBatchById(batch.id)!;
    expect(after.status).toBe("active");
    expect(after.approvedBy).toBe(admin.user.id);
  });

  it("records an API created batch as created by api, and a dashboard approver can release it", async () => {
    const h = makeHarness();
    const { merchant, auth } = await makeMerchant(h);
    const owner = addUser(h, merchant.id, "owner-mc@example.com", "owner");

    const created = await h.app.inject({ method: "POST", url: "/v1/payout-batches", headers: auth, payload: { rows: OVER_THRESHOLD_ROWS } });
    expect(created.statusCode).toBe(201);
    const batch = created.json();
    expect(batch.status).toBe("pending_approval");
    expect(batch.createdBy).toBe("api");

    const res = await dashApprove(h, batch.id, owner.cookie);
    expect(res.statusCode).toBe(303);
    const after = h.store.getBatchById(batch.id)!;
    expect(after.status).toBe("active");
    expect(after.approvedBy).toBe(owner.user.id);

    // The batch page shows the non human creator as itself.
    const page = await h.app.inject({ method: "GET", url: `/dashboard/payouts/batches/${batch.id}`, headers: { cookie: owner.cookie } });
    expect(page.body).toContain("Created by");
    expect(page.body).toContain("<td>api</td>");
  });

  it("lets an API approval release a dashboard created batch (the documented limit: API keys carry no human identity)", async () => {
    const h = makeHarness();
    const { merchant, auth } = await makeMerchant(h);
    const owner = addUser(h, merchant.id, "owner-mc@example.com", "owner");

    const batch = await dashCreateBatch(h, merchant.id, owner.cookie);
    expect(batch.createdBy).toBe(owner.user.id);

    const res = await h.app.inject({ method: "POST", url: `/v1/payout-batches/${batch.id}/approve`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().approvedBy).toBe("api");
    const after = h.store.getBatchById(batch.id)!;
    expect(after.status).toBe("active");
    expect(after.approvedBy).toBe("api");
    expect(h.store.listPayouts(merchant.id)).toHaveLength(2);
  });

  it("records a schedule created batch as created by schedule", async () => {
    const h = makeHarness();
    const { merchant, auth } = await makeMerchant(h);
    const created = await h.app.inject({
      method: "POST", url: "/v1/schedules", headers: auth,
      payload: {
        kind: "payout_batch", cadence: "monthly", dayOfMonth: 1,
        startAt: new Date(Date.now() - 60000).toISOString(),
        payload: { rows: OVER_THRESHOLD_ROWS },
      },
    });
    expect(created.statusCode).toBe(201);

    const sync = await h.app.inject({ method: "POST", url: "/v1/internal/sync" });
    expect(sync.json().schedules).toEqual({ ran: 1, skipped: 0, failed: 0 });

    const batches = h.store.listBatches(merchant.id);
    expect(batches).toHaveLength(1);
    expect(batches[0].status).toBe("pending_approval");
    expect(batches[0].createdBy).toBe("schedule");
    expect(batches[0].approvedBy).toBeUndefined();
  });
});
