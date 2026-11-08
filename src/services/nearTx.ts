import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Minimal NEAR transaction sender: just enough borsh, base58 and
 * ed25519 (via node:crypto) to create accounts, deploy contracts and
 * call functions on NEAR testnet/mainnet without adding a dependency.
 * Used by the registry client (Slice G) and the deploy script.
 *
 * Key files use the standard NEAR format:
 *   { "account_id": "...", "public_key": "ed25519:...", "private_key": "ed25519:..." }
 */

// ---------------------------------------------------------------- base58
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));

export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const val = B58_MAP.get(ch);
    if (val === undefined) throw new Error(`invalid base58 character ${ch}`);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i];
  return out;
}

export function base58Encode(data: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of data) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const x = digits[i] * 256 + carry;
      digits[i] = x % 58;
      carry = Math.floor(x / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let zeros = 0;
  while (zeros < data.length && data[zeros] === 0) zeros++;
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

// ---------------------------------------------------------------- borsh
export class BorshWriter {
  private chunks: Uint8Array[] = [];
  u8(v: number) { this.chunks.push(Uint8Array.of(v & 0xff)); return this; }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.chunks.push(b); return this; }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.chunks.push(b); return this; }
  u128(v: bigint) {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(v & ((1n << 64n) - 1n), 0);
    b.writeBigUInt64LE(v >> 64n, 8);
    this.chunks.push(b);
    return this;
  }
  bytes(data: Uint8Array) { this.chunks.push(Uint8Array.from(data)); return this; }
  rawBytes(data: Uint8Array) { return this.bytes(data); }
  byteVec(data: Uint8Array) { return this.u32(data.length).bytes(data); }
  str(s: string) { return this.byteVec(new TextEncoder().encode(s)); }
  option<T>(v: T | undefined, write: (w: BorshWriter, v: T) => void) {
    if (v === undefined) return this.u8(0);
    this.u8(1);
    write(this, v);
    return this;
  }
  build(): Uint8Array {
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    return out;
  }
}

// ---------------------------------------------------------------- keys
export interface NearKeyPair {
  accountId: string;
  publicKeyBytes: Uint8Array; // 32 bytes ed25519
  publicKey: string;          // "ed25519:base58"
  sign(message: Uint8Array): Uint8Array;
}

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function keyPairFromSecret(secretKey: string, accountId: string): NearKeyPair {
  const raw = base58Decode(secretKey.replace(/^ed25519:/, ""));
  const seed = raw.length === 64 ? raw.slice(0, 32) : raw;
  if (seed.length !== 32) throw new Error("unexpected NEAR secret key length");
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der", type: "pkcs8",
  });
  // Public key bytes: when the secret is 64 bytes, the last 32 are the
  // public key; for a bare 32 byte seed, export the public point as JWK.
  let publicKeyBytes: Uint8Array;
  if (raw.length === 64) {
    publicKeyBytes = raw.slice(32);
  } else {
    const pub = createPublicKey(privateKey) as any;
    const j = pub.export({ format: "jwk" }) as { x: string };
    publicKeyBytes = new Uint8Array(Buffer.from(j.x, "base64url"));
  }
  return {
    accountId,
    publicKeyBytes,
    publicKey: `ed25519:${base58Encode(publicKeyBytes)}`,
    sign: (message: Uint8Array) => new Uint8Array(cryptoSign(null, Buffer.from(message), privateKey)),
  };
}

export function loadKeyFile(path: string): NearKeyPair {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { account_id: string; private_key: string; public_key?: string };
  const kp = keyPairFromSecret(parsed.private_key, parsed.account_id);
  if (parsed.public_key && parsed.public_key !== kp.publicKey) {
    // Prefer the file's declared public key material when the secret
    // was a bare seed (some tools store it separately).
    const declared = base58Decode(parsed.public_key.replace(/^ed25519:/, ""));
    if (declared.length === 32) return { ...kp, publicKeyBytes: declared, publicKey: parsed.public_key };
  }
  return kp;
}

export function generateKeyPair(accountId: string): NearKeyPair & { secretKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const seed = new Uint8Array(Buffer.from(privJwk.d, "base64url"));
  const pub = new Uint8Array(Buffer.from(pubJwk.x, "base64url"));
  const secret = base58Encode(new Uint8Array([...seed, ...pub]));
  const kp = keyPairFromSecret(`ed25519:${secret}`, accountId);
  return { ...kp, secretKey: `ed25519:${secret}` };
}

// ---------------------------------------------------------------- RPC
export class NearRpc {
  constructor(public url: string) {}

  async call(method: string, params: unknown): Promise<any> {
    const res = await fetch(this.url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "remiglo", method, params }),
    });
    const json = await res.json() as any;
    if (json.error) throw new Error(`NEAR RPC ${method} failed: ${JSON.stringify(json.error).slice(0, 300)}`);
    return json.result;
  }

  async viewFunction(accountId: string, methodName: string, args: Record<string, unknown> = {}): Promise<any> {
    const result = await this.call("query", {
      request_type: "call_function", finality: "final",
      account_id: accountId, method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    const bytes = Buffer.from(result.result as number[]);
    return JSON.parse(bytes.toString("utf8"));
  }

  async viewAccount(accountId: string): Promise<any> {
    return this.call("query", { request_type: "view_account", finality: "final", account_id: accountId });
  }

  async accessKey(accountId: string, publicKey: string): Promise<{ nonce: number; blockHash: string }> {
    const result = await this.call("query", {
      request_type: "view_access_key", finality: "final",
      account_id: accountId, public_key: publicKey,
    });
    return { nonce: Number(result.nonce), blockHash: result.block_hash as string };
  }

  async broadcast(signedTxBytesBase64: string): Promise<any> {
    return this.call("broadcast_tx_commit", [signedTxBytesBase64]);
  }
}

// ---------------------------------------------------------------- actions
export type NearAction =
  | { kind: "createAccount" }
  | { kind: "deployContract"; code: Uint8Array }
  | { kind: "functionCall"; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint }
  | { kind: "transfer"; deposit: bigint }
  | { kind: "addKey"; publicKeyBytes: Uint8Array; permission: "fullAccess" | { functionCall: { receiverId: string; methodNames: string[]; allowance?: bigint } } }
  | { kind: "deleteAccount"; beneficiaryId: string };

function writeAction(w: BorshWriter, a: NearAction): void {
  switch (a.kind) {
    case "createAccount": w.u8(0); break;
    case "deployContract": w.u8(1).byteVec(a.code); break;
    case "functionCall":
      w.u8(2).str(a.methodName).byteVec(a.args).u64(a.gas).u128(a.deposit);
      break;
    case "transfer": w.u8(3).u128(a.deposit); break;
    case "deleteAccount": w.u8(7).str(a.beneficiaryId); break;
    case "addKey": {
      w.u8(5).u8(0).bytes(a.publicKeyBytes).u64(0n);
      if (a.permission === "fullAccess") {
        w.u8(1);
      } else {
        w.u8(0);
        w.option(a.permission.functionCall.allowance, (ww, v) => ww.u128(v));
        ww2Receiver(w, a.permission.functionCall.receiverId, a.permission.functionCall.methodNames);
      }
      break;
    }
  }
}

function ww2Receiver(w: BorshWriter, receiverId: string, methodNames: string[]): void {
  w.str(receiverId);
  w.u32(methodNames.length);
  for (const m of methodNames) w.str(m);
}

/**
 * Sign and broadcast one transaction. Returns the transaction hash
 * (base58) and the raw RPC result.
 */
export async function sendTransaction(
  rpc: NearRpc,
  signer: NearKeyPair,
  receiverId: string,
  actions: NearAction[]
): Promise<{ txHash: string; result: any }> {
  const { nonce, blockHash } = await rpc.accessKey(signer.accountId, signer.publicKey);
  const w = new BorshWriter();
  w.str(signer.accountId);
  w.u8(0).bytes(signer.publicKeyBytes);
  w.u64(BigInt(nonce) + 1n);
  w.str(receiverId);
  w.bytes(base58Decode(blockHash));
  w.u32(actions.length);
  for (const a of actions) writeAction(w, a);
  const txBytes = w.build();
  const hash = createHash("sha256").update(txBytes).digest();
  const signature = signer.sign(new Uint8Array(hash));
  const signed = new BorshWriter().bytes(txBytes).u8(0).bytes(signature).build();
  const result = await rpc.broadcast(Buffer.from(signed).toString("base64"));
  const status = result?.status as any;
  if (status && typeof status === "object" && "Failure" in status) {
    throw new Error(`NEAR transaction failed: ${JSON.stringify(status.Failure).slice(0, 400)}`);
  }
  return { txHash: base58Encode(new Uint8Array(hash)), result };
}

export const GAS_30_TGAS = 30_000_000_000_000n;
export const GAS_100_TGAS = 100_000_000_000_000n;
