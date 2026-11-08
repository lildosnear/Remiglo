import { createHash } from "node:crypto";
import { GAS_100_TGAS, NearRpc, base58Decode, loadKeyFile, sendTransaction } from "./nearTx.js";

/**
 * Chain Signatures module (layer 4, Slice H).
 *
 * THE ONE LEGITIMATE CASE (docs/ARCHITECTURE.md boundary rule): a
 * business treasury held in a NEAR controlled account signs a payout
 * deposit on a foreign chain where no NEAR Intents deposit flow covers
 * the asset or destination. Chain Signatures is used ONLY where
 * Remiglo needs NEAR controlled cross chain signing; NEAR Intents
 * handles its own routing and settlement, and the two are never made
 * responsible for the same transaction. The guard below enforces that
 * in code: nothing with an Intents deposit address can be signed here.
 *
 * Contract ids and method names verified against the NEAR docs on
 * 2026-11-06:
 *   MPC contract: mainnet v1.signer, testnet v1.signer-prod.testnet
 *   Signature request: method "sign" with
 *     { request: { payload_v2, path, domain_id } }
 *     (domain_id 0 = Secp256k1, 1 = Ed25519)
 *   Derived key view: "derived_public_key" with { path, predecessor }
 * Sources:
 *   https://docs.near.org/chain-abstraction/chain-signatures
 *   https://docs.near.org/chain-abstraction/chain-signatures/implementation
 */
export const MPC_CONTRACTS = {
  mainnet: "v1.signer",
  testnet: "v1.signer-prod.testnet",
} as const;

export type NearNetwork = keyof typeof MPC_CONTRACTS;

export interface ChainSignatureResult {
  /** Affine point x of the signature's R point, hex. */
  bigR: string;
  /** The s scalar, hex. */
  s: string;
  recoveryId: number;
}

export interface ChainSignaturesClient {
  readonly name: string;
  /** Derive the foreign chain address controlled by accountId + path. */
  deriveAddress(accountId: string, path: string, chain: string): Promise<string>;
  /** Request an MPC signature over a 32 byte payload hash (hex). */
  requestSignature(accountId: string, path: string, payloadHash: string): Promise<ChainSignatureResult>;
}

/** A payment-like object the treasury signer is asked to act on. */
export interface TreasuryPaymentRef {
  id?: string;
  /** Set when NEAR Intents manages this payment's deposit flow. */
  depositAddress?: string | null;
}

/**
 * The boundary rule, enforced: a payment that carries an Intents
 * deposit address is Intents managed, and Chain Signatures must never
 * sign for it. Throws when the payment is Intents managed.
 */
export function assertNotIntentsManaged(payment: TreasuryPaymentRef): void {
  if (payment.depositAddress) {
    throw new Error(
      `payment ${payment.id ?? ""} has an Intents deposit address (${payment.depositAddress}); ` +
      "Chain Signatures must not sign for Intents managed payments (boundary rule, docs/ARCHITECTURE.md)"
    );
  }
}

/**
 * The service entry point for the treasury case: refuse Intents
 * managed payments, then request the signature.
 */
export async function signTreasuryPayload(
  client: ChainSignaturesClient,
  payment: TreasuryPaymentRef,
  accountId: string,
  path: string,
  payloadHash: string
): Promise<ChainSignatureResult> {
  assertNotIntentsManaged(payment);
  return client.requestSignature(accountId, path, payloadHash);
}

// ------------------------------------------------------------- keccak
// Keccak-256 (the pre-NIST variant Ethereum uses) in pure TypeScript
// with BigInt lanes, so EVM address derivation needs no dependency.
/* eslint-disable no-bitwise */
const KECCAK_RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_RHO: number[] = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const MASK64 = (1n << 64n) - 1n;
function rotl(v: bigint, n: number): bigint {
  if (n === 0) return v & MASK64;
  const b = BigInt(n);
  return ((v << b) | (v >> (64n - b))) & MASK64;
}
function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= d;
    }
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], KECCAK_RHO[x + 5 * y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y] & MASK64) & b[((x + 2) % 5) + 5 * y]);
      }
    }
    state[0] ^= KECCAK_RC[round];
  }
}

export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136; // 1088 bit rate for Keccak-256
  const state = new Array<bigint>(25).fill(0n);
  const padded = Array.from(data);
  padded.push(0x01);
  while (padded.length % rate !== rate - 1) padded.push(0);
  padded.push(0x80);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      state[i] ^= lane;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}
/* eslint-enable no-bitwise */

/** Ethereum style address from an uncompressed secp256k1 public key (x||y, 64 bytes). */
export function evmAddressFromPublicKey(pubkey: Uint8Array): string {
  const key = pubkey.length === 65 && pubkey[0] === 4 ? pubkey.slice(1) : pubkey;
  if (key.length !== 64) {
    throw new Error(`expected a 64 byte uncompressed secp256k1 public key, got ${pubkey.length} bytes`);
  }
  const hash = keccak256(key);
  return `0x${Buffer.from(hash.slice(12)).toString("hex")}`;
}

// ---------------------------------------------------------------- mock
/** Deterministic offline implementation for tests and local work. */
export class MockChainSignatures implements ChainSignaturesClient {
  readonly name = "mock";
  readonly signRequests: Array<{ accountId: string; path: string; payloadHash: string }> = [];

  async deriveAddress(accountId: string, path: string, chain: string): Promise<string> {
    const digest = createHash("sha256").update(`${accountId}|${path}|${chain}`).digest();
    return `0x${digest.subarray(0, 20).toString("hex")}`;
  }

  async requestSignature(accountId: string, path: string, payloadHash: string): Promise<ChainSignatureResult> {
    this.signRequests.push({ accountId, path, payloadHash });
    const digest = createHash("sha256").update(`sig|${accountId}|${path}|${payloadHash}`).digest("hex");
    return { bigR: digest, s: digest.split("").reverse().join(""), recoveryId: 0 };
  }
}

// ---------------------------------------------------------------- live
export interface NearChainSignaturesOptions {
  network: NearNetwork;
  /** Key file of the NEAR account that owns the treasury (the signer). */
  keyFile: string;
  rpcUrl?: string;
  /** Deposit attached to a sign request (yocto). Defaults to 1 NEAR. */
  signDepositYocto?: bigint;
}

/**
 * Live implementation, gated by configuration: it is only constructed
 * when CHAIN_SIG_ENABLED=1 and a key file is configured (see
 * chainSignaturesFromEnv). Derivation is a view call; signing sends a
 * real transaction to the MPC contract from the treasury account.
 */
export class NearChainSignatures implements ChainSignaturesClient {
  readonly name = "near";
  private readonly rpc: NearRpc;
  private readonly opts: NearChainSignaturesOptions;
  readonly contractId: string;

  constructor(opts: NearChainSignaturesOptions) {
    this.opts = opts;
    this.contractId = MPC_CONTRACTS[opts.network];
    this.rpc = new NearRpc(opts.rpcUrl ?? (opts.network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org"));
  }

  async deriveAddress(accountId: string, path: string, chain: string): Promise<string> {
    // View method verified in the NEAR docs (chainsig derives EVM
    // addresses from this key): derived_public_key { path, predecessor }.
    const derived = await this.rpc.viewFunction(this.contractId, "derived_public_key", {
      path, predecessor: accountId,
    }) as string;
    if (typeof derived !== "string") throw new Error("unexpected derived_public_key response");
    const raw = derived.includes(":") ? derived.split(":")[1] : derived;
    const pubkey = base58Decode(raw);
    if (chain === "ethereum" || chain === "evm" || chain.startsWith("base") || chain.startsWith("polygon") || chain.startsWith("arbitrum")) {
      return evmAddressFromPublicKey(pubkey);
    }
    // For Ed25519 style chains the address is the public key itself.
    return derived;
  }

  async requestSignature(accountId: string, path: string, payloadHash: string): Promise<ChainSignatureResult> {
    const payload = Buffer.from(payloadHash.replace(/^0x/, ""), "hex");
    if (payload.length !== 32) throw new Error("payloadHash must be 32 bytes of hex");
    const signer = loadKeyFile(this.opts.keyFile);
    if (signer.accountId !== accountId) {
      throw new Error(`key file is for ${signer.accountId}, not the requested treasury account ${accountId}`);
    }
    const { result } = await sendTransaction(this.rpc, signer, this.contractId, [
      {
        kind: "functionCall",
        methodName: "sign",
        args: new TextEncoder().encode(JSON.stringify({
          request: { payload_v2: Array.from(payload), path, domain_id: 0 },
        })),
        gas: GAS_100_TGAS,
        deposit: this.opts.signDepositYocto ?? 10n ** 24n,
      },
    ]);
    // The MPC signature returns as the call's success value
    // ({ big_r: { affine_point }, s: { scalar }, recovery_id }).
    const successB64 = result?.status?.SuccessValue as string | undefined;
    if (!successB64) throw new Error("sign call returned no success value");
    const parsed = JSON.parse(Buffer.from(successB64, "base64").toString("utf8")) as any;
    return {
      bigR: String(parsed.big_r?.affine_point ?? ""),
      s: String(parsed.s?.scalar ?? ""),
      recoveryId: Number(parsed.recovery_id ?? 0),
    };
  }
}

/**
 * Build the live client from the environment, or return undefined.
 * The module stays inert unless CHAIN_SIG_ENABLED=1 AND a key file
 * path is configured.
 */
export function chainSignaturesFromEnv(
  env: Record<string, string | undefined> = process.env
): ChainSignaturesClient | undefined {
  if (env.CHAIN_SIG_ENABLED !== "1") return undefined;
  const keyFile = env.CHAIN_SIG_KEY_FILE;
  if (!keyFile) return undefined;
  const network = env.CHAIN_SIG_NETWORK === "mainnet" ? "mainnet" : "testnet";
  return new NearChainSignatures({ network, keyFile, rpcUrl: env.NEAR_RPC_URL });
}
