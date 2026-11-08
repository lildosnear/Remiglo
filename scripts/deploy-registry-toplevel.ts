/**
 * Create the TOP LEVEL remiglo.testnet account and deploy the
 * Remiglo Registry to it.
 *
 * Why this exists: the first testnet deployment used a subaccount
 * (remiglo.stipend.testnet) because the funded account on hand was
 * stipend.testnet. Desmond corrected that: Remiglo is standalone
 * and its contract account must be remiglo.testnet. Top level
 * testnet accounts are created by calling create_account on the
 * "testnet" registrar contract from any funded account, with the
 * deposit funding the new account.
 *
 * The demo merchant on this deployment is remiglo.testnet itself,
 * so no other project name appears anywhere in the setup.
 *
 * Keys: the NEW account key is written to
 *   ~/workspace/remiglo/keys/remiglo.testnet.json  (gitignored).
 * The funder key (stipend.testnet) is only read, never copied.
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
const funderKeyFile = process.env.PARENT_KEY_FILE ?? join(homedir(), "workspace/stipend/keys/stipend.testnet.json");
const accountId = "remiglo.testnet";
const wasmPath = process.env.WASM_PATH ?? join(homedir(), "workspace/remiglo/contracts/registry/target/wasm32-unknown-unknown/release/remiglo_registry.wasm");
const fundNear = process.env.FUND_NEAR ?? "3";
const keysDir = join(homedir(), "workspace/remiglo/keys");
const keyOut = join(keysDir, `${accountId}.json`);
const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

const funder = loadKeyFile(funderKeyFile);
console.log(`funder: ${funder.accountId}`);
const funderAccount = await rpc.viewAccount(funder.accountId);
console.log(`funder balance: ${(Number(BigInt(String(funderAccount.amount)) / 10n ** 12n) / 1e12).toFixed(3)} NEAR`);
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
  const created = await sendTransaction(rpc, funder, "testnet", [
    {
      kind: "functionCall", methodName: "create_account",
      args: new TextEncoder().encode(JSON.stringify({ new_account_id: accountId, new_public_key: fresh.publicKey })),
      gas: GAS_100_TGAS, deposit: fundYocto,
    },
  ]);
  console.log(`account created via testnet registrar: tx ${created.txHash}\n  ${explorer(created.txHash)}`);
  signer = loadKeyFile(keyOut);
}

const wasm = readFileSync(wasmPath);
const deployed = await sendTransaction(rpc, signer, accountId, [
  { kind: "deployContract", code: new Uint8Array(wasm) },
]);
console.log(`contract deployed (${wasm.length} bytes): tx ${deployed.txHash}\n  ${explorer(deployed.txHash)}`);

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

// Demo merchant: remiglo.testnet itself. No other project anywhere.
const merchant = accountId;
const merchantOnChain = await rpc.viewFunction(accountId, "get_merchant", { merchant }).catch(() => null);
if (!merchantOnChain) {
  const reg = await sendTransaction(rpc, signer, accountId, [
    {
      kind: "functionCall", methodName: "register_merchant",
      args: new TextEncoder().encode(JSON.stringify({ merchant, admins: [accountId] })),
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

const demoBatchId = "batch_demo_001";
const payloadHash = createHash("sha256")
  .update(JSON.stringify({ batchId: demoBatchId, merchant, rows: 6, note: "Remiglo registry deploy proof" }))
  .digest("hex");
const batchOnChain = await rpc.viewFunction(accountId, "get_batch", { batch_id: demoBatchId }).catch(() => null);
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
  console.log(`demo batch recorded: tx ${rec.txHash}\n  ${explorer(rec.txHash)}`);
}

console.log("--- verification (view calls) ---");
console.log("owner:", await rpc.viewFunction(accountId, "get_owner", {}));
console.log("merchant_count:", await rpc.viewFunction(accountId, "merchant_count", {}));
console.log("get_policy:", JSON.stringify(await rpc.viewFunction(accountId, "get_policy", { merchant })));
console.log("get_batch:", JSON.stringify(await rpc.viewFunction(accountId, "get_batch", { batch_id: demoBatchId })));
console.log("check_spend 50 USDC:", JSON.stringify(await rpc.viewFunction(accountId, "check_spend", { merchant, amount: "50000000" })));
console.log("check_spend 600 USDC:", JSON.stringify(await rpc.viewFunction(accountId, "check_spend", { merchant, amount: "600000000" })));
console.log(`account explorer: https://testnet.nearblocks.io/address/${accountId}`);
