import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server-app.js";
import { Store } from "../src/lib/store.js";
import { MockIntents } from "../src/services/intents.js";
import { indexOnce, parseEventLog } from "../src/services/indexer.js";
import type { NearRpc } from "../src/services/nearTx.js";
import type { FetchFn } from "../src/services/webhooks.js";

const CONTRACT = "registry.testnet";
const TIP = 5;

const EVENT = (event: string, data: Record<string, unknown>) =>
  `EVENT_JSON:${JSON.stringify({ standard: "remiglo", version: "1.0.0", event, data })}`;

/** A fake NEAR RPC with a tiny scripted chain. */
function fakeRpc(): NearRpc {
  const call = async (method: string, params: any): Promise<any> => {
    if (method === "block" && params.finality === "final") {
      return { header: { height: TIP }, chunks: [{ chunk_hash: `C${TIP}` }] };
    }
    if (method === "block") {
      return { chunks: [{ chunk_hash: `C${params.block_id}` }] };
    }
    if (method === "chunk") {
      const h = Number(String(params.chunk_id).slice(1));
      if (h === 3) {
        return { transactions: [
          { hash: "TXA", signer_id: "merchant.near", receiver_id: CONTRACT },
          { hash: "TXB", signer_id: "someone.near", receiver_id: "other.testnet" },
        ] };
      }
      if (h === 5) {
        return { transactions: [{ hash: "TXC", signer_id: "merchant.near", receiver_id: CONTRACT }] };
      }
      return { transactions: [] };
    }
    if (method === "EXPERIMENTAL_tx_status") {
      if (params.tx_hash === "TXA") {
        return { receipts_outcome: [{ outcome: { logs: [
          EVENT("merchant_registered", { merchant: "merchant.near" }),
          "an unrelated log line",
          EVENT("batch_recorded", { merchant: "merchant.near", batch_id: "batch_1" }),
        ] } }] };
      }
      if (params.tx_hash === "TXC") {
        return { receipts_outcome: [{ outcome: { logs: [
          EVENT("payout_anchored", { merchant: "merchant.near", anchor_id: "pay_1" }),
        ] } }] };
      }
      return { receipts_outcome: [] };
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  return { call } as unknown as NearRpc;
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "remiglo-indexer-"));
  return new Store(join(dir, "test.db"));
}

describe("parseEventLog", () => {
  it("parses EVENT_JSON logs and ignores everything else", () => {
    expect(parseEventLog(EVENT("batch_recorded", { batch_id: "b" }))?.event).toBe("batch_recorded");
    expect(parseEventLog("plain log")).toBeUndefined();
    expect(parseEventLog("EVENT_JSON:not json")).toBeUndefined();
  });
});

describe("registry indexer (Slice I)", () => {
  it("stores contract events once, advances the cursor, and a restart does not duplicate", async () => {
    const store = makeStore();
    const first = await indexOnce({ store, rpc: fakeRpc(), contractId: CONTRACT });
    expect(first.blocksScanned).toBe(TIP);
    expect(first.eventsStored).toBe(3);
    expect(store.getIndexerCursor(CONTRACT)).toBe(TIP);

    const events = store.listRegistryEvents(CONTRACT);
    expect(events.map((e) => e.event).sort()).toEqual(["batch_recorded", "merchant_registered", "payout_anchored"]);
    expect(events.find((e) => e.event === "batch_recorded")?.blockHeight).toBe(3);
    const counts = store.registryEventCounts(CONTRACT);
    expect(counts.total).toBe(3);
    expect(counts.byKind.merchant_registered).toBe(1);

    // Restart: a second pass over the same store stores nothing new.
    const second = await indexOnce({ store, rpc: fakeRpc(), contractId: CONTRACT });
    expect(second.eventsStored).toBe(0);
    expect(store.registryEventCounts(CONTRACT).total).toBe(3);
    store.close();
  });

  it("replaying the same heights cannot duplicate an event (unique tx and log index)", async () => {
    const store = makeStore();
    await indexOnce({ store, rpc: fakeRpc(), contractId: CONTRACT });
    // Wind the cursor back and replay: INSERT OR IGNORE holds the line.
    store.setIndexerCursor(CONTRACT, 0);
    const replay = await indexOnce({ store, rpc: fakeRpc(), contractId: CONTRACT });
    expect(replay.eventsStored).toBe(0);
    expect(store.registryEventCounts(CONTRACT).total).toBe(3);
    store.close();
  });
});

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => { while (apps.length) { const a = apps.pop()!; await a.close().catch(() => {}); } });

describe("indexer status route", () => {
  it("reports configured false by default and cursor plus counts when configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remiglo-indexer-route-"));
    const fetchFn: FetchFn = async () => ({ ok: true, status: 200 });
    const plain = buildApp({ store: new Store(join(dir, "a.db")), mockIntents: new MockIntents(), fetchFn });
    apps.push(plain);
    const off = await plain.inject({ method: "GET", url: "/v1/internal/indexer/status" });
    expect(off.json()).toEqual({ configured: false });

    const store = new Store(join(dir, "b.db"));
    const configured = buildApp({
      store, mockIntents: new MockIntents(), fetchFn,
      config: { registryContractId: CONTRACT },
    });
    apps.push(configured);
    const on = await configured.inject({ method: "GET", url: "/v1/internal/indexer/status" });
    expect(on.json().configured).toBe(true);
    expect(on.json().contractId).toBe(CONTRACT);
    expect(on.json().totalEvents).toBe(0);
  });
});
