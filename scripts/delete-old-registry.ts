/**
 * One time cleanup: delete the legacy remiglo.stipend.testnet
 * subaccount (the first registry deployment) and return its
 * remaining test NEAR to stipend.testnet. Run once on 2026-11-06
 * after the contract moved to the top level remiglo.testnet.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { NearRpc, loadKeyFile, sendTransaction } from "../src/services/nearTx.js";

const rpc = new NearRpc(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
const keyFile = join(homedir(), "workspace/remiglo/keys/remiglo.stipend.testnet.json");
const signer = loadKeyFile(keyFile);
console.log(`deleting ${signer.accountId}, beneficiary stipend.testnet`);
const { txHash } = await sendTransaction(rpc, signer, signer.accountId, [
  { kind: "deleteAccount", beneficiaryId: "stipend.testnet" },
]);
console.log(`deleted: tx ${txHash}\n  https://testnet.nearblocks.io/txns/${txHash}`);
const after = await rpc.viewAccount(signer.accountId).catch(() => null);
console.log("account after deletion:", after === null ? "gone (UNKNOWN_ACCOUNT)" : JSON.stringify(after));
