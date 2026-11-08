import type { Store } from "../lib/store.js";
import { NearRpc } from "./nearTx.js";

/**
 * Registry indexer (layer 5 completion for the registry, Slice I).
 *
 * An RPC polling indexer for the Remiglo Registry contract: it walks
 * blocks from a stored cursor, finds transactions sent to the
 * contract, reads their receipt outcome logs, and stores every
 * EVENT_JSON audit log (merchant_registered, policy_updated,
 * batch_recorded, batch_status_changed, payout_anchored) into the
 * registry_events table. The cursor lives in indexer_state, and the
 * (tx_hash, log_index) unique index makes restarts and replays safe:
 * an event is stored exactly once.
 *
 * Honest scope note: this RPC indexer is the built layer today. A
 * NEAR QueryAPI indexer function is a drop in replacement for the
 * same registry_events table when a queryapi account is provisioned;
 * no QueryAPI integration is faked here.
 *
 * Archival fallback: when the primary RPC has pruned the requested
 * block, set NEAR_ARCHIVAL_RPC_URL (or pass archivalRpcUrl) and block,
 * chunk and tx status reads retry against it.
 */
export interface IndexerDeps {
  store: Store;
  rpc: NearRpc;
  archivalRpc?: NearRpc;
  contractId: string;
  /** Blocks per run (default 50). */
  maxBlocks?: number;
  /** First run starts this many blocks behind the tip (default 200). */
  firstRunLookback?: number;
}

export interface IndexerRunResult {
  contractId: string;
  fromHeight: number;
  toHeight: number;
  blocksScanned: number;
  eventsStored: number;
}

async function callWithFallback<T>(deps: IndexerDeps, fn: (rpc: NearRpc) => Promise<T>): Promise<T> {
  try {
    return await fn(deps.rpc);
  } catch (err) {
    if (deps.archivalRpc) return fn(deps.archivalRpc);
    throw err;
  }
}

interface ParsedEvent { event: string; data: Record<string, unknown> }

export function parseEventLog(log: string): ParsedEvent | undefined {
  const prefix = "EVENT_JSON:";
  if (!log.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(log.slice(prefix.length)) as any;
    if (!parsed || typeof parsed.event !== "string") return undefined;
    return { event: parsed.event, data: (parsed.data ?? {}) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/** Run one indexing pass. Safe to call repeatedly and after restarts. */
export async function indexOnce(deps: IndexerDeps): Promise<IndexerRunResult> {
  const { store, contractId } = deps;
  const maxBlocks = deps.maxBlocks ?? 50;
  const tip = await callWithFallback(deps, (rpc) => rpc.call("block", { finality: "final" }));
  const tipHeight = Number(tip?.header?.height ?? 0);
  const cursor = store.getIndexerCursor(contractId);
  const start = cursor === undefined
    ? Math.max(0, tipHeight - (deps.firstRunLookback ?? 200))
    : cursor;
  const end = Math.min(tipHeight, start + maxBlocks);
  let stored = 0;

  for (let height = start + 1; height <= end; height++) {
    const block = await callWithFallback(deps, (rpc) => rpc.call("block", { block_id: height }));
    const chunkHashes: string[] = (block?.chunks ?? []).map((c: any) => String(c.chunk_hash));
    for (const chunkHash of chunkHashes) {
      const chunk = await callWithFallback(deps, (rpc) => rpc.call("chunk", { chunk_id: chunkHash }));
      const txs: any[] = chunk?.transactions ?? [];
      for (const tx of txs) {
        if (String(tx.receiver_id) !== contractId) continue;
        const txHash = String(tx.hash);
        const sender = String(tx.signer_id ?? "");
        const status = await callWithFallback(deps, (rpc) =>
          rpc.call("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: sender })
        );
        const outcomes: any[] = status?.receipts_outcome ?? [];
        for (const outcome of outcomes) {
          const logs: string[] = outcome?.outcome?.logs ?? [];
          logs.forEach((log, logIndex) => {
            const parsed = parseEventLog(String(log));
            if (!parsed) return;
            const inserted = store.addRegistryEvent({
              txHash, logIndex, blockHeight: height, contractId,
              event: parsed.event, data: parsed.data,
            });
            if (inserted) stored++;
          });
        }
      }
    }
    store.setIndexerCursor(contractId, height);
  }

  return { contractId, fromHeight: start, toHeight: end, blocksScanned: Math.max(0, end - start), eventsStored: stored };
}

/** Status for GET /v1/internal/indexer/status. */
export function indexerStatus(store: Store, contractId: string | undefined) {
  if (!contractId) return { configured: false as const };
  const counts = store.registryEventCounts(contractId);
  return {
    configured: true as const,
    contractId,
    cursor: store.getIndexerCursor(contractId) ?? null,
    totalEvents: counts.total,
    byKind: counts.byKind,
  };
}
