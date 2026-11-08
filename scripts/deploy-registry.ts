/**
 * LEGACY — superseded by scripts/deploy-registry-toplevel.ts.
 *
 * This was the first testnet deploy path: it created a subaccount
 * of the funder (remiglo.stipend.testnet). Desmond corrected that
 * on 2026-11-06: Remiglo is standalone, the live contract account
 * is the top level remiglo.testnet, and the subaccount has been
 * deleted. Kept for history only; do not run.
 *
 * Original description: creates a fresh subaccount for the registry
 * funded by an existing funded parent
 * account, deploys the wasm built by scripts/build-contract.sh,
 * initialises it, registers a demo merchant, sets a policy and
 * records one demo batch, then verifies everything with view calls.
 *
 * Keys: the NEW account key is written to
 *   ~/workspace/remiglo/keys/<account>.json
 * which is gitignored. The parent key is only read, never copied.
 *
 * Env overrides: PARENT_KEY_FILE, REGISTRY_ACCOUNT, NEAR_RPC_URL,
 * WASM_PATH, FUND_NEAR (default 3).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GAS_100_TGAS, GAS_30_TGAS, NearRpc, generateKeyPair, loadKeyFile, sendTransaction,
} from "../src/services/nearTx.js";

const rpcUrl = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const rpc = new NearRpc(rpcUrl);
const parentKeyFile = process.env.PARENT_KEY_FILE ?? join(homedir(), "workspace/stipend/keys/stipend.testnet.json");
const accountId = process.env.REGISTRY_ACCOUNT ?? "remiglo.stipend.testnet";
const wasmPath = process.env.WASM_PATH ?? join(homedir(), "workspace/remiglo/contracts/registry/target/wasm32-unknown-unknown/release/remiglo_registry.wasm");
const fundNear = process.env.FUND_NEAR ?? "3";
const keysDir = join(homedir(), "workspace/remiglo/keys");
const keyOut = join(keysDir, `${accountId}.json`);
const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

const parent = loadKeyFile(parentKeyFile);
console.log(`parent (funder): ${parent.accountId}`);
console.log(`new registry account: ${accountId}`);

const existing = await rpc.viewAccount(accountId).catch(() => null);
let signer;
if (existing && existsSync(keyOut)) {
  signer = loadKeyFile(keyOut);
  console.log("account already exists; reusing saved key");
} else if (existing) {
  throw new Error(`${accountId} exists on chain but ${keyOut} is missing; refusing to continue`);
} else {
  const fresh = generateKeyPair(accountId);
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(keyOut, JSON.stringify({
    account_id: accountId,
    public_key: fresh.publicKey,
    private_key: fresh.secretKey,
  }, null, 2));
  console.log(`key saved to ${keyOut} (gitignored)`);
  const fundYocto = BigInt(Math.round(Number(fundNear) * 1e6)) * 10n ** 18n;
  const created = await sendTransaction(rpc, parent, accountId, [
    { kind: "createAccount" },
    { kind: "transfer", deposit: fundYocto },
    { kind: "addKey", publicKeyBytes: fresh.publicKeyBytes, permission: "fullAccess" },
  ]);
  console.log(`account created: tx ${created.txHash}\n  ${explorer(created.txHash)}`);
  signer = loadKeyFile(keyOut);
}

// Deploy (or redeploy) the wasm.
const wasm = readFileSync(wasmPath);
const deployed = await sendTransaction(rpc, signer, accountId, [
  { kind: "deployContract", code: new Uint8Array(wasm) },
]);
console.log(`contract deployed (${wasm.length} bytes): tx ${deployed.txHash}\n  ${explorer(deployed.txHash)}`);

// Initialise if needed.
const owner = await rpc.viewFunction(accountId, "get_owner", {}).catch(() => null);
if (!owner) {
  const init = await sendTransaction(rpc, signer, accountId, [
    {
      kind: "functionCall", methodName: "new",
      args: new TextEncoder().encode(JSON.stringify({ owner: accountId })),
      gas: GAS_30_TGAS, deposit: 0n,
    },
  ]);
  console.log(`initialised: tx ${init.txHash}\n  ${explorer(init.txHash)}`);
} else {
  console.log(`already initialised; owner ${owner}`);
}

// Demo merchant: the parent account, administered by the registry
// account itself so the API anchoring signer is authorized.
const merchant = parent.accountId;
const merchantOnChain = await rpc.viewFunction(accountId, "get_merchant", { merchant }).catch(() => null);
if (!merchantOnChain) {
  const reg = await sendTransaction(rpc, signer, accountId, [
    {
      kind: "functionCall", methodName: "register_merchant",
      args: new TextEncoder().encode(JSON.stringify({ merchant, admins: [accountId, merchant] })),
      gas: GAS_30_TGAS, deposit: 0n,
    },
  ]);
  console.log(`demo merchant registered (${merchant}): tx ${reg.txHash}\n  ${explorer(reg.txHash)}`);
}
const policy = await rpc.viewFunction(accountId, "get_policy", { merchant }).catch(() => null);
if (!policy) {
  const set = await sendTransaction(rpc, signer, accountId, [
    {
      kind: "functionCall", methodName: "set_policy",
      args: new TextEncoder().encode(JSON.stringify({
        merchant, per_payout_cap: "100000000", daily_budget: "1000000000", approval_threshold: "500000000",
      })),
      gas: GAS_30_TGAS, deposit: 0n,
    },
  ]);
  console.log(`policy set: tx ${set.txHash}\n  ${explorer(set.txHash)}`);
}

// One demo batch record.
const demoBatchId = "batch_demo_001";
const payloadHash = createHash("sha256")
  .update(JSON.stringify({ batchId: demoBatchId, merchant, rows: 6, note: "Remiglo registry deploy proof" }))
  .digest("hex");
const batchOnChain = await rpc.viewFunction(accountId, "get_batch", { batch_id: demoBatchId }).catch(() => null);
let batchTx = "";
if (!batchOnChain) {
  const rec = await sendTransaction(rpc, signer, accountId, [
    {
      kind: "functionCall", methodName: "record_batch",
      args: new TextEncoder().encode(JSON.stringify({
        merchant, batch_id: demoBatchId, payload_hash: payloadHash, total: "540000000", row_count: 6,
      })),
      gas: GAS_100_TGAS, deposit: 0n,
    },
  ]);
  batchTx = rec.txHash;
  console.log(`demo batch recorded: tx ${batchTx}\n  ${explorer(batchTx)}`);
}

// Verify with views.
console.log("--- verification (view calls) ---");
console.log("owner:", await rpc.viewFunction(accountId, "get_owner", {}));
console.log("merchant_count:", await rpc.viewFunction(accountId, "merchant_count", {}));
console.log("get_merchant:", JSON.stringify(await rpc.viewFunction(accountId, "get_merchant", { merchant })));
console.log("get_policy:", JSON.stringify(await rpc.viewFunction(accountId, "get_policy", { merchant })));
console.log("get_batch:", JSON.stringify(await rpc.viewFunction(accountId, "get_batch", { batch_id: demoBatchId })));
console.log("check_spend 50 USDC:", JSON.stringify(await rpc.viewFunction(accountId, "check_spend", { merchant, amount: "50000000" })));
console.log("check_spend 600 USDC:", JSON.stringify(await rpc.viewFunction(accountId, "check_spend", { merchant, amount: "600000000" })));
console.log(`contract account: ${accountId}`);
console.log(`account explorer: https://testnet.nearblocks.io/address/${accountId}`);
if (batchTx) console.log(`batch record tx: ${explorer(batchTx)}`);
