/**
 * Anchor one batch into the Remiglo Registry contract from the CLI.
 *
 * Usage:
 *   REGISTRY_CONTRACT_ID=remiglo.testnet \
 *   REGISTRY_KEY_FILE=keys/remiglo.testnet.json \
 *   REGISTRY_MERCHANT_ACCOUNT=remiglo.testnet \
 *   npx tsx scripts/anchor-batch.ts <batch.json>
 *
 * The batch JSON is the shape the API returns for a batch:
 *   { "id": "batch_...", "merchantId": "...", "rows": [ {recipientAddress,
 *     destinationAsset, amount, reference?}, ... ] }
 *
 * This is the isolated on chain path for Slice G: the API calls the
 * same NearRegistry client asynchronously; this script runs it in the
 * foreground and prints the transaction hash and explorer link.
 */
import { readFileSync } from "node:fs";
import { NearRegistry } from "../src/services/registry.js";
import type { PayoutBatch, PayoutRow } from "../src/lib/core.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: anchor-batch.ts <batch.json>");
  process.exit(2);
}
const contractId = process.env.REGISTRY_CONTRACT_ID;
const keyFile = process.env.REGISTRY_KEY_FILE;
const merchantAccountId = process.env.REGISTRY_MERCHANT_ACCOUNT;
if (!contractId || !keyFile || !merchantAccountId) {
  console.error("REGISTRY_CONTRACT_ID, REGISTRY_KEY_FILE and REGISTRY_MERCHANT_ACCOUNT must be set");
  process.exit(2);
}

const parsed = JSON.parse(readFileSync(file, "utf8")) as PayoutBatch;
const rows = (parsed.rows ?? []) as unknown as PayoutRow[];
const registry = new NearRegistry({
  contractId,
  keyFile,
  merchantAccountId,
  rpcUrl: process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
});
const { txHash } = await registry.anchorBatch(parsed, rows);
console.log(`anchored batch ${parsed.id}`);
console.log(`tx: ${txHash}`);
console.log(`explorer: https://testnet.nearblocks.io/txns/${txHash}`);
const onChain = await registry.getBatch(parsed.id);
console.log("on chain record:", JSON.stringify(onChain));
