import { describe, it, expect } from "vitest";
import {
  MPC_CONTRACTS, MockChainSignatures, assertNotIntentsManaged,
  chainSignaturesFromEnv, evmAddressFromPublicKey, keccak256, signTreasuryPayload,
} from "../src/services/chainSignatures.js";

describe("keccak256 and EVM derivation helpers", () => {
  it("matches the known Keccak-256 empty string digest", () => {
    expect(Buffer.from(keccak256(new Uint8Array())).toString("hex"))
      .toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  it("derives the known Ethereum address for the generator point (private key 1)", () => {
    const x = Buffer.from("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex");
    const y = Buffer.from("483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8", "hex");
    expect(evmAddressFromPublicKey(new Uint8Array([...x, ...y])))
      .toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    // 0x04 prefixed form works too
    expect(evmAddressFromPublicKey(new Uint8Array([4, ...x, ...y])))
      .toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });
});

describe("MPC contract ids (verified in the NEAR docs 2026-11-06)", () => {
  it("uses v1.signer on mainnet and v1.signer-prod.testnet on testnet", () => {
    expect(MPC_CONTRACTS.mainnet).toBe("v1.signer");
    expect(MPC_CONTRACTS.testnet).toBe("v1.signer-prod.testnet");
  });
});

describe("boundary rule", () => {
  it("refuses any payment that carries an Intents deposit address", async () => {
    const mock = new MockChainSignatures();
    expect(() => assertNotIntentsManaged({ id: "pay_1", depositAddress: "0xabc" })).toThrow(/Intents managed/);
    await expect(
      signTreasuryPayload(mock, { id: "pay_1", depositAddress: "0xabc" }, "treasury.near", "ethereum-1", "ab".repeat(32))
    ).rejects.toThrow(/Intents managed/);
    expect(mock.signRequests).toHaveLength(0);
  });

  it("signs for a treasury payment with no Intents deposit address", async () => {
    const mock = new MockChainSignatures();
    const sig = await signTreasuryPayload(mock, { id: "pay_2", depositAddress: null }, "treasury.near", "ethereum-1", "ab".repeat(32));
    expect(sig.bigR).toBeTruthy();
    expect(mock.signRequests).toHaveLength(1);
  });

  it("mock derivation is deterministic per account, path and chain", async () => {
    const mock = new MockChainSignatures();
    const a = await mock.deriveAddress("treasury.near", "ethereum-1", "ethereum");
    const b = await mock.deriveAddress("treasury.near", "ethereum-1", "ethereum");
    const c = await mock.deriveAddress("treasury.near", "ethereum-2", "ethereum");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("the live client stays inert unless explicitly enabled with a key file", () => {
    expect(chainSignaturesFromEnv({})).toBeUndefined();
    expect(chainSignaturesFromEnv({ CHAIN_SIG_ENABLED: "1" })).toBeUndefined();
    const client = chainSignaturesFromEnv({ CHAIN_SIG_ENABLED: "1", CHAIN_SIG_KEY_FILE: "/tmp/k.json", CHAIN_SIG_NETWORK: "testnet" });
    expect(client?.name).toBe("near");
  });
});
