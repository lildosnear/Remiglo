export type AssetId = string;

export interface OneClickToken {
  assetId: AssetId;
  symbol: string;
  blockchain: string;
  decimals: number;
  priceUsd?: string;
}

export interface QuoteRequest {
  originAsset: AssetId;
  destinationAsset: AssetId;
  amount: string;
  recipient: string;
  refundTo: string;
  swapType?: "EXACT_INPUT" | "EXACT_OUTPUT";
  appFeeBps?: number;
  appFeeRecipient?: string;
}

export interface QuoteResult {
  depositAddress: string;
  amountIn: string;
  amountOut: string;
  deadline: string;
  timeEstimateSeconds?: number;
}

export type OneClickStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export interface StatusResult {
  status: OneClickStatus;
  swapDetails?: {
    amountIn?: string;
    amountOut?: string;
    originChainTxHashes?: Array<{ hash: string }>;
    destinationChainTxHashes?: Array<{ hash: string }>;
  };
}

const BASE = process.env.ONECLICK_BASE_URL || "https://1click.chaindefuser.com";

async function call<T>(path: string, init?: RequestInit, timeoutOverrideMs?: number): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.ONECLICK_API_KEY) headers.authorization = `Bearer ${process.env.ONECLICK_API_KEY}`;
  // Quotes run a solver auction and are far slower than status calls, so they get their own, longer budget.
  const timeoutMs = timeoutOverrideMs ?? Number(process.env.ONECLICK_TIMEOUT_MS || 45000);
  const res = await fetch(`${BASE}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs), headers: { ...headers, ...(init?.headers as object) } });
  if (!res.ok) throw new Error(`1Click ${path} failed with ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export const intents = {
  tokens: () => call<OneClickToken[]>("/v0/tokens"),
  quote: (body: QuoteRequest & { dry: boolean }) =>
    call<{ quote: QuoteResult }>("/v0/quote", { method: "POST", body: JSON.stringify({
      dry: body.dry,
      swapType: body.swapType || "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: body.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: body.destinationAsset,
      amount: body.amount,
      refundTo: body.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: body.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...(body.appFeeBps && body.appFeeRecipient
        ? { appFees: [{ recipient: body.appFeeRecipient, fee: body.appFeeBps }] }
        : {}),
    }) }, Number(process.env.ONECLICK_QUOTE_TIMEOUT_MS || 120000)),
  status: (depositAddress: string) =>
    call<StatusResult>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`),
  submitDeposit: (txHash: string, depositAddress: string) =>
    call<unknown>("/v0/deposit/submit", { method: "POST", body: JSON.stringify({ txHash, depositAddress }) }),
};

export interface IntentsClient {
  tokens(): Promise<OneClickToken[]>;
  quote(body: QuoteRequest & { dry: boolean }): Promise<{ quote: QuoteResult }>;
  status(depositAddress: string): Promise<StatusResult>;
  submitDeposit(txHash: string, depositAddress: string): Promise<unknown>;
}

export const intentsClient: IntentsClient = intents;

/**
 * Deterministic offline fake for tests and local dev (INTENTS_MOCK=1).
 * Quote addresses are sequential. Status for each address progresses
 * KNOWN_DEPOSIT_TX, then PROCESSING, then SUCCESS, one step per poll.
 * Tests can force an outcome with setFinal().
 */
export class MockIntents implements IntentsClient {
  private counter = 0;
  private quotes = new Map<string, { amountOut: string; steps: number }>();
  private forced = new Map<string, OneClickStatus>();

  async tokens(): Promise<OneClickToken[]> {
    return [
      { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC", blockchain: "near", decimals: 6 },
      { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", symbol: "USDC", blockchain: "base", decimals: 6 },
      { assetId: "nep141:usdt.tether-token.near", symbol: "USDT", blockchain: "near", decimals: 6 },
    ];
  }

  async quote(body: QuoteRequest & { dry: boolean }): Promise<{ quote: QuoteResult }> {
    this.counter += 1;
    const depositAddress = `mock_deposit_${this.counter}`;
    const amountOut = body.amount; // same asset value in mock mode
    this.quotes.set(depositAddress, { amountOut, steps: 0 });
    return {
      quote: {
        depositAddress,
        amountIn: body.amount,
        amountOut,
        deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        timeEstimateSeconds: 22,
      },
    };
  }

  /** Force the next status result for an address (FAILED, REFUNDED, amount override tests). */
  setFinal(depositAddress: string, status: OneClickStatus, amountOut?: string) {
    this.forced.set(depositAddress, status);
    if (amountOut) {
      const q = this.quotes.get(depositAddress);
      if (q) q.amountOut = amountOut;
    }
  }

  failNextStatus(depositAddress: string) {
    this.forced.set(depositAddress, "__ERROR__" as OneClickStatus);
  }

  async status(depositAddress: string): Promise<StatusResult> {
    const forced = this.forced.get(depositAddress);
    if (forced === ("__ERROR__" as OneClickStatus)) {
      this.forced.delete(depositAddress);
      throw new Error("mock solver timeout");
    }
    if (forced) {
      this.forced.delete(depositAddress);
      const q = this.quotes.get(depositAddress);
      return {
        status: forced,
        swapDetails: {
          amountOut: q?.amountOut,
          originChainTxHashes: [{ hash: `mock_tx_in_${depositAddress}` }],
          destinationChainTxHashes: [{ hash: `mock_tx_out_${depositAddress}` }],
        },
      };
    }
    const q = this.quotes.get(depositAddress);
    if (!q) throw new Error(`mock: unknown deposit address ${depositAddress}`);
    q.steps += 1;
    const seq: OneClickStatus[] = ["KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"];
    const status = seq[Math.min(q.steps - 1, seq.length - 1)];
    return {
      status,
      swapDetails: {
        amountOut: q.amountOut,
        originChainTxHashes: [{ hash: `mock_tx_in_${depositAddress}` }],
        destinationChainTxHashes: status === "SUCCESS" ? [{ hash: `mock_tx_out_${depositAddress}` }] : [],
      },
    };
  }

  async submitDeposit(): Promise<unknown> {
    return { ok: true, mock: true };
  }
}

export function getIntentsClient(mock?: MockIntents): IntentsClient {
  if (mock) return mock;
  if (process.env.INTENTS_MOCK === "1") return new MockIntents();
  return intentsClient;
}

export function mapStatus(s: OneClickStatus): string {
  switch (s) {
    case "PENDING_DEPOSIT": return "open";
    case "KNOWN_DEPOSIT_TX": return "deposit_seen";
    case "PROCESSING": return "processing";
    case "SUCCESS": return "paid";
    case "REFUNDED": return "refunded";
    case "FAILED": return "failed";
  }
}

/** Map a 1Click status onto payout states (SUCCESS settles a payout). */
export function mapPayoutStatus(s: OneClickStatus): string {
  switch (s) {
    case "PENDING_DEPOSIT": return "awaiting_funding";
    case "KNOWN_DEPOSIT_TX": return "funded";
    case "PROCESSING": return "processing";
    case "SUCCESS": return "settled";
    case "REFUNDED": return "refunded";
    case "FAILED": return "failed";
  }
}
