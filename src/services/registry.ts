import { createHash } from "node:crypto";
import { GAS_30_TGAS, NearRpc, loadKeyFile, sendTransaction } from "./nearTx.js";
import type { PayoutBatch, PayoutRow } from "../lib/core.js";

/**
 * Registry client (layer 2 integration, Slice G).
 *
 * The API anchors every created or approved payout batch into the
 * Remiglo Registry contract on NEAR (see contracts/registry). The
 * anchor carries a SHA-256 hash of the canonical batch payload, the
 * batch total and the row count, so the on chain record can be checked
 * against what the API reported.
 *
 * Anchoring is fire and forget from the API's point of view: the batch
 * row records anchorStatus (none, pending, anchored, failed) and the
 * anchor transaction hash, and failures are written to the ledger. The
 * API request path never waits on the chain and never fails because of
 * it.
 */
export interface RegistryAnchorResult {
  txHash: string;
}

export interface RegistryClient {
  readonly name: string;
  /** Anchor one batch. Throws on failure; the caller records it. */
  anchorBatch(batch: PayoutBatch, rows: PayoutRow[]): Promise<RegistryAnchorResult>;
}

/** Canonical payload hash shared by the API and the CLI script. */
export function batchPayloadHash(batchId: string, merchantId: string, rows: PayoutRow[]): string {
  const canonical = JSON.stringify({
    batchId,
    merchantId,
    rows: rows.map((r) => ({
      recipientAddress: r.recipientAddress,
      destinationAsset: r.destinationAsset,
      amount: r.amount,
      reference: r.reference ?? null,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function batchTotal(rows: PayoutRow[]): string {
  let total = 0n;
  for (const r of rows) total += BigInt(r.amount);
  return total.toString();
}

/** Offline registry used by tests and local development. */
export class MockRegistry implements RegistryClient {
  readonly name = "mock";
  readonly anchored: Array<{ batchId: string; payloadHash: string; total: string; txHash: string }> = [];
  failNext = false;

  async anchorBatch(batch: PayoutBatch, rows: PayoutRow[]): Promise<RegistryAnchorResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock registry failure");
    }
    const payloadHash = batchPayloadHash(batch.id, batch.merchantId, rows);
    const txHash = `mock_anchor_${batch.id}`;
    this.anchored.push({ batchId: batch.id, payloadHash, total: batchTotal(rows), txHash });
    return { txHash };
  }
}

export interface NearRegistryOptions {
  contractId: string;
  /** NEAR account id the contract knows as the merchant. */
  merchantAccountId: string;
  /** Path to the signer key file (NEAR JSON format). Never committed. */
  keyFile: string;
  rpcUrl?: string;
}

/** Live registry client: JSON RPC views + the minimal tx sender. */
export class NearRegistry implements RegistryClient {
  readonly name = "near";
  private readonly rpc: NearRpc;
  private readonly opts: NearRegistryOptions;

  constructor(opts: NearRegistryOptions) {
    this.opts = opts;
    this.rpc = new NearRpc(opts.rpcUrl ?? "https://rpc.testnet.near.org");
  }

  async anchorBatch(batch: PayoutBatch, rows: PayoutRow[]): Promise<RegistryAnchorResult> {
    const signer = loadKeyFile(this.opts.keyFile);
    const args = {
      merchant: this.opts.merchantAccountId,
      batch_id: batch.id,
      payload_hash: batchPayloadHash(batch.id, batch.merchantId, rows),
      total: batchTotal(rows),
      row_count: rows.length,
    };
    const { txHash } = await sendTransaction(this.rpc, signer, this.opts.contractId, [
      {
        kind: "functionCall",
        methodName: "record_batch",
        args: new TextEncoder().encode(JSON.stringify(args)),
        gas: GAS_30_TGAS,
        deposit: 0n,
      },
    ]);
    return { txHash };
  }

  /** Read back a batch record from the contract (CLI and checks). */
  async getBatch(batchId: string): Promise<unknown> {
    return this.rpc.viewFunction(this.opts.contractId, "get_batch", { batch_id: batchId });
  }
}
