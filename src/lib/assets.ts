/**
 * Asset display info for customer facing pages.
 *
 * Resolution order is decided by the caller: in live mode the 1Click token
 * list is consulted first, in mock or offline mode this built in map is.
 * Either way the other source is the fallback, and a conservative guess
 * (6 decimals, chain parsed from the asset id) is the last resort so a page
 * never renders a raw smallest unit number without context.
 */
export interface AssetInfo {
  assetId: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  chainName: string;
}

const CHAIN_NAMES: Record<string, string> = {
  near: "NEAR",
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  sol: "Solana",
  pol: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
  op: "Optimism",
  gnosis: "Gnosis",
  tron: "Tron",
  sui: "Sui",
  stellar: "Stellar",
  ton: "TON",
  btc: "Bitcoin",
  aptos: "Aptos",
  scroll: "Scroll",
  xlayer: "X Layer",
  monad: "Monad",
  hypercore: "Hyperliquid",
};

export function chainNameFor(blockchain: string): string {
  return CHAIN_NAMES[blockchain] ?? (blockchain ? blockchain[0].toUpperCase() + blockchain.slice(1) : "the origin chain");
}

type RawAsset = { symbol: string; decimals: number; blockchain: string };

/**
 * Common USDC and USDT asset ids, verified against the live 1Click token
 * list on 2026-11-06. Used in mock mode and whenever the live list cannot
 * be reached, so a payment page still renders correct amounts offline.
 */
export const BUILTIN_ASSETS: Record<string, RawAsset> = {
  // NEAR
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { symbol: "USDC", decimals: 6, blockchain: "near" },
  "nep141:usdt.tether-token.near": { symbol: "USDT", decimals: 6, blockchain: "near" },
  // Base
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": { symbol: "USDC", decimals: 6, blockchain: "base" },
  // Ethereum
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near": { symbol: "USDC", decimals: 6, blockchain: "eth" },
  "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near": { symbol: "USDT", decimals: 6, blockchain: "eth" },
  // Arbitrum
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near": { symbol: "USDC", decimals: 6, blockchain: "arb" },
  // Solana
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near": { symbol: "USDC", decimals: 6, blockchain: "sol" },
  "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near": { symbol: "USDT", decimals: 6, blockchain: "sol" },
  // Polygon
  "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L": { symbol: "USDC", decimals: 6, blockchain: "pol" },
  "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr": { symbol: "USDT", decimals: 6, blockchain: "pol" },
  // Tron
  "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near": { symbol: "USDT", decimals: 6, blockchain: "tron" },
};

export function builtinAsset(assetId: string): AssetInfo | undefined {
  const raw = BUILTIN_ASSETS[assetId];
  if (!raw) return undefined;
  return { assetId, ...raw, chainName: chainNameFor(raw.blockchain) };
}

/** Best effort chain guess from the asset id shape, for unknown assets. */
export function guessAsset(assetId: string): AssetInfo {
  let blockchain = "near";
  const omni = assetId.match(/:(\d+)_/);
  if (omni) {
    const byChainId: Record<string, string> = { "137": "pol", "56": "bsc", "10": "op", "43114": "avax", "42161": "arb", "8453": "base", "1": "eth" };
    blockchain = byChainId[omni[1]] ?? blockchain;
  } else {
    const seg = assetId.split(":")[1] ?? "";
    const prefix = seg.split("-")[0];
    if (prefix && CHAIN_NAMES[prefix]) blockchain = prefix;
  }
  const lower = assetId.toLowerCase();
  const symbol = lower.includes("usdt") || lower.includes("dac17f958d2ee523a2206206994597c13d831ec7") ? "USDT" : "USDC";
  return { assetId, symbol, decimals: 6, blockchain, chainName: chainNameFor(blockchain) };
}

/**
 * Format a smallest unit integer string for humans. Integer math only.
 * Always shows at least two decimal places, trims extra trailing zeros.
 * 10000000 at 6 decimals becomes "10.00"; 4996960 becomes "4.99696".
 */
export function formatUnits(units: string, decimals: number): string {
  const neg = units.startsWith("-");
  const digits = (neg ? units.slice(1) : units).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  let frac = decimals > 0 ? digits.slice(digits.length - decimals) : "";
  frac = frac.replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return `${neg ? "-" : ""}${grouped}${decimals > 0 ? `.${frac}` : ""}`;
}

export function formatAmount(units: string, info: AssetInfo): string {
  return `${formatUnits(units, info.decimals)} ${info.symbol}`;
}

/**
 * Parse a human decimal amount ("25", "25.5") into smallest units for an
 * asset with the given decimals. Integer math only. Returns undefined for
 * anything malformed, zero, negative, or with more fractional digits
 * than the asset supports.
 */
export function parseDecimalToUnits(value: string, decimals: number): string | undefined {
  const v = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return undefined;
  const [whole, frac = ""] = v.split(".");
  if (frac.length > decimals) return undefined;
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return units > 0n ? units.toString() : undefined;
}
