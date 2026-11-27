/**
 * Nuvion client: Remiglo's settlement rail for fiat and stablecoin
 * payouts, shaped like the Intents client in intents.ts (typed
 * interface, real fetch implementation, deterministic mock,
 * getNuvionClient switch). It is wired through the server: merchant
 * sign up creates a child entity and stores the link, recipients link
 * counterparties and payment details, payout execution creates
 * transfers for bank, mobile money and wallet rows, the inbound
 * webhook receiver records outflow events, and the sync loop applies
 * their transitions with a polling pass as backstop. Spec: the Nuvion
 * integration map in the stablecoin rails goal files.
 *
 * Wire format follows Nuvion's public docs (docs.nuvion.co): snake_case
 * field names, amounts as numbers in the smallest currency unit, and
 * responses wrapped in a `data` envelope, which call() unwraps.
 */

/** ISO 4217 code, or Nuvion's stablecoin codes: USC (USDC), UST (USDT), RLD (RLUSD). */
export type NuvionCurrency = string;

export type NuvionTransferStatus =
  | "new"
  | "pending"
  | "processing"
  | "successful"
  | "failed"
  | "reversed"
  | "cancelled";

export type NuvionTransferType =
  | "bank-transfer"
  | "momo-transfer"
  | "stablecoin-transfer"
  | "book-transfer";

export interface NuvionEntity {
  id: string;
  status: string;
  [key: string]: unknown;
}

export interface NuvionAccount {
  id: string;
  entity_id?: string;
  currency: NuvionCurrency;
  balance?: number;
  status?: string;
  [key: string]: unknown;
}

export interface NuvionAccountDetails {
  id: string;
  account_id?: string;
  status: string;
  account_number?: string;
  iban?: string;
  sort_code?: string;
  wallet_address?: string;
  chain?: string;
  [key: string]: unknown;
}

export interface NuvionCounterparty {
  id: string;
  entity_id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface NuvionPaymentDetail {
  id: string;
  counterparty_id?: string;
  payment_method: string;
  scheme?: string;
  currency?: NuvionCurrency;
  country?: string;
  [key: string]: unknown;
}

export interface NuvionFxQuote {
  id: string;
  from_currency: NuvionCurrency;
  to_currency: NuvionCurrency;
  amount_from?: number;
  amount_to?: number;
  rate: number;
  status?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface NuvionTransfer {
  id: string;
  account_id: string;
  payment_detail_id?: string;
  counterparty_id?: string;
  entity_id?: string;
  currency: NuvionCurrency;
  amount: number;
  /** Charged on top of amount, in the same smallest units. */
  fee?: number;
  type: NuvionTransferType;
  status: NuvionTransferStatus;
  narration?: string;
  unique_reference: string;
  fx_quote_id?: string;
  meta?: Record<string, unknown>;
  created_at?: string;
  [key: string]: unknown;
}

export interface CreateAccountRequest {
  entity_id?: string;
  currency: NuvionCurrency;
  [key: string]: unknown;
}

export interface CreateAccountDetailsRequest {
  account_id: string;
  /** Required for a stablecoin account: the chain the wallet address lives on. */
  chain?: string;
  [key: string]: unknown;
}

export interface CreateCounterpartyRequest {
  entity_id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface CreatePaymentDetailRequest {
  counterparty_id: string;
  payment_method: NuvionTransferType | string;
  scheme?: string;
  currency?: NuvionCurrency;
  country?: string;
  [key: string]: unknown;
}

export interface CreateFxQuoteRequest {
  from_currency: NuvionCurrency;
  to_currency: NuvionCurrency;
  amount_from?: number;
  amount_to?: number;
  entity_id?: string;
  [key: string]: unknown;
}

export interface CreateTransferRequest {
  account_id: string;
  payment_detail_id: string;
  counterparty_id: string;
  currency: NuvionCurrency;
  /** Smallest currency unit. Stablecoins count at 2 decimals at Nuvion: 10000 is 100.00 USDC. */
  amount: number;
  type: NuvionTransferType;
  narration: string;
  /** Unique per entity, forever: a failed transfer still burns its reference. */
  unique_reference: string;
  fx_quote_id?: string;
  entity_id?: string;
  meta?: Record<string, unknown>;
}

export interface ListTransfersParams {
  entity_id?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface NuvionClient {
  /** Generic pass through: the body shape differs for individual and business entities. */
  createEntity(body: Record<string, unknown>, kind?: "individual" | "business"): Promise<NuvionEntity>;
  getEntity(id: string): Promise<NuvionEntity>;
  createAccount(body: CreateAccountRequest): Promise<NuvionAccount>;
  listAccounts(entityId?: string): Promise<NuvionAccount[]>;
  createAccountDetails(body: CreateAccountDetailsRequest): Promise<NuvionAccountDetails>;
  createCounterparty(body: CreateCounterpartyRequest): Promise<NuvionCounterparty>;
  createPaymentDetails(body: CreatePaymentDetailRequest): Promise<NuvionPaymentDetail>;
  createFxQuote(body: CreateFxQuoteRequest): Promise<NuvionFxQuote>;
  getFxQuote(id: string): Promise<NuvionFxQuote>;
  createTransfer(body: CreateTransferRequest): Promise<NuvionTransfer>;
  getTransfer(id: string): Promise<NuvionTransfer>;
  listTransfers(params?: ListTransfersParams): Promise<NuvionTransfer[]>;
}

const BASE = process.env.NUVION_BASE_URL || "https://api.nuvion.dev";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.NUVION_API_KEY) headers.authorization = `Bearer ${process.env.NUVION_API_KEY}`;
  const timeoutMs = Number(process.env.NUVION_TIMEOUT_MS || 45000);
  const res = await fetch(`${BASE}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs), headers: { ...headers, ...(init?.headers as object) } });
  if (!res.ok) throw new Error(`Nuvion ${path} failed with ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: T } | T;
  // Nuvion wraps responses in a data envelope; pass through anything that is not wrapped.
  if (body !== null && typeof body === "object" && "data" in body) return (body as { data: T }).data;
  return body as T;
}

function query(params?: Record<string, unknown>): string {
  if (!params) return "";
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export const nuvion: NuvionClient = {
  createEntity: (body, kind = "individual") =>
    call<NuvionEntity>(kind === "business" ? "/business-entities" : "/individual-entities", { method: "POST", body: JSON.stringify(body) }),
  getEntity: (id) => call<NuvionEntity>(`/entities/${encodeURIComponent(id)}`),
  createAccount: (body) => call<NuvionAccount>("/accounts", { method: "POST", body: JSON.stringify(body) }),
  listAccounts: (entityId) => call<NuvionAccount[]>(`/accounts${query(entityId ? { entity_id: entityId } : undefined)}`),
  createAccountDetails: (body) => call<NuvionAccountDetails>("/account-details", { method: "POST", body: JSON.stringify(body) }),
  createCounterparty: (body) => call<NuvionCounterparty>("/counterparties", { method: "POST", body: JSON.stringify(body) }),
  createPaymentDetails: (body) => call<NuvionPaymentDetail>("/payment-details", { method: "POST", body: JSON.stringify(body) }),
  createFxQuote: (body) => call<NuvionFxQuote>("/fx-quotes", { method: "POST", body: JSON.stringify(body) }),
  getFxQuote: (id) => call<NuvionFxQuote>(`/fx-quotes/${encodeURIComponent(id)}`),
  createTransfer: (body) => call<NuvionTransfer>("/transfers", { method: "POST", body: JSON.stringify(body) }),
  getTransfer: (id) => call<NuvionTransfer>(`/transfers/${encodeURIComponent(id)}`),
  listTransfers: (params) => call<NuvionTransfer[]>(`/transfers${query(params)}`),
};

export const nuvionClient: NuvionClient = nuvion;

/**
 * Deterministic offline fake for tests and local dev (NUVION_MOCK=1),
 * mirroring MockIntents. Ids are sequential. An entity reads as pending
 * at creation and approved from its first getEntity poll. A transfer
 * starts pending, reads pending on the first poll and successful on the
 * second, unless a test forces another outcome. FX quotes apply a fixed
 * rate (fxRate, default 1) so amounts echo predictably.
 */
export class MockNuvion implements NuvionClient {
  /** Fixed FX rate applied by createFxQuote: amount_to = amount_from * fxRate. */
  fxRate = 1;

  private counter = 0;
  private entities = new Map<string, NuvionEntity & { polls: number }>();
  private accounts = new Map<string, NuvionAccount>();
  private accountDetails = new Map<string, NuvionAccountDetails>();
  private counterparties = new Map<string, NuvionCounterparty>();
  private paymentDetails = new Map<string, NuvionPaymentDetail>();
  private fxQuotes = new Map<string, NuvionFxQuote>();
  private transfers = new Map<string, NuvionTransfer & { polls: number }>();
  private forcedTransfers = new Map<string, NuvionTransferStatus>();
  private usedReferences = new Set<string>();

  private next(prefix: string): string {
    this.counter += 1;
    return `mock_${prefix}_${this.counter}`;
  }

  async createEntity(body: Record<string, unknown>, _kind: "individual" | "business" = "individual"): Promise<NuvionEntity> {
    const entity: NuvionEntity & { polls: number } = { ...body, id: this.next("entity"), status: "pending", polls: 0 };
    this.entities.set(entity.id, entity);
    const { polls: _polls, ...rest } = entity;
    return rest;
  }

  /** Force an entity approved without polling. */
  approveEntity(id: string) {
    const e = this.entities.get(id);
    if (e) e.status = "approved";
  }

  async getEntity(id: string): Promise<NuvionEntity> {
    const e = this.entities.get(id);
    if (!e) throw new Error(`mock: unknown entity ${id}`);
    e.polls += 1;
    if (e.status === "pending" && e.polls >= 1) e.status = "approved";
    const { polls: _polls, ...rest } = e;
    return rest;
  }

  async createAccount(body: CreateAccountRequest): Promise<NuvionAccount> {
    const account: NuvionAccount = { ...body, id: this.next("account"), balance: 0, status: "active" };
    this.accounts.set(account.id, account);
    return account;
  }

  async listAccounts(entityId?: string): Promise<NuvionAccount[]> {
    const all = [...this.accounts.values()];
    return entityId ? all.filter((a) => a.entity_id === entityId) : all;
  }

  async createAccountDetails(body: CreateAccountDetailsRequest): Promise<NuvionAccountDetails> {
    const id = this.next("account_details");
    const details: NuvionAccountDetails = body.chain
      ? { ...body, id, status: "active", wallet_address: `mock_wallet_${this.counter}` }
      : { ...body, id, status: "active", account_number: `mock_account_number_${this.counter}` };
    this.accountDetails.set(id, details);
    return details;
  }

  async createCounterparty(body: CreateCounterpartyRequest): Promise<NuvionCounterparty> {
    const counterparty: NuvionCounterparty = { ...body, id: this.next("counterparty") };
    this.counterparties.set(counterparty.id, counterparty);
    return counterparty;
  }

  async createPaymentDetails(body: CreatePaymentDetailRequest): Promise<NuvionPaymentDetail> {
    const detail: NuvionPaymentDetail = { ...body, id: this.next("payment_detail") };
    this.paymentDetails.set(detail.id, detail);
    return detail;
  }

  async createFxQuote(body: CreateFxQuoteRequest): Promise<NuvionFxQuote> {
    const amountFrom = body.amount_from ?? (body.amount_to !== undefined ? Math.round(body.amount_to / this.fxRate) : 0);
    const amountTo = body.amount_to ?? Math.round(amountFrom * this.fxRate);
    const quote: NuvionFxQuote = {
      ...body,
      id: this.next("fx_quote"),
      amount_from: amountFrom,
      amount_to: amountTo,
      rate: this.fxRate,
      status: "active",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    this.fxQuotes.set(quote.id, quote);
    return quote;
  }

  async getFxQuote(id: string): Promise<NuvionFxQuote> {
    const q = this.fxQuotes.get(id);
    if (!q) throw new Error(`mock: unknown fx quote ${id}`);
    return q;
  }

  /** Force a transfer's status from its next poll onwards (failed, reversed, cancelled). */
  forceTransferStatus(id: string, status: NuvionTransferStatus) {
    this.forcedTransfers.set(id, status);
  }

  /** Force a transfer to fail on its next poll. */
  failTransfer(id: string) {
    this.forcedTransfers.set(id, "failed");
  }

  async createTransfer(body: CreateTransferRequest): Promise<NuvionTransfer> {
    const refKey = `${body.entity_id ?? ""}:${body.unique_reference}`;
    if (this.usedReferences.has(refKey)) {
      throw new Error(`Nuvion /transfers failed with 409: duplicate unique_reference ${body.unique_reference}`);
    }
    this.usedReferences.add(refKey);
    const transfer: NuvionTransfer & { polls: number } = {
      ...body,
      id: this.next("transfer"),
      status: "pending",
      fee: 0,
      created_at: new Date().toISOString(),
      polls: 0,
    };
    this.transfers.set(transfer.id, transfer);
    const { polls: _polls, ...rest } = transfer;
    return rest;
  }

  async getTransfer(id: string): Promise<NuvionTransfer> {
    const t = this.transfers.get(id);
    if (!t) throw new Error(`mock: unknown transfer ${id}`);
    const forced = this.forcedTransfers.get(id);
    if (forced) {
      t.status = forced;
    } else if (t.status === "pending") {
      t.polls += 1;
      if (t.polls >= 2) t.status = "successful";
    }
    const { polls: _polls, ...rest } = t;
    return rest;
  }

  async listTransfers(params?: ListTransfersParams): Promise<NuvionTransfer[]> {
    let all = [...this.transfers.values()];
    if (params?.entity_id) all = all.filter((t) => t.entity_id === params.entity_id);
    return all.reverse().map(({ polls: _polls, ...rest }) => rest);
  }
}

export function getNuvionClient(mock?: MockNuvion): NuvionClient {
  if (mock) return mock;
  if (process.env.NUVION_MOCK === "1") return new MockNuvion();
  return nuvionClient;
}

/** Map a Nuvion transfer status onto Remiglo payout states. */
export function mapNuvionPayoutStatus(s: NuvionTransferStatus): string {
  switch (s) {
    case "new": return "sent";
    case "pending": return "processing";
    case "processing": return "processing";
    case "successful": return "settled";
    case "failed": return "failed";
    case "reversed": return "refunded";
    case "cancelled": return "failed";
  }
}

/**
 * Convert an integer smallest unit amount between decimal scales, using
 * BigInt maths only. Scaling up is exact. Scaling down throws when the
 * amount is not exactly representable at the coarser scale, so a value
 * can never be silently rounded at a money boundary.
 */
export function convertDecimals(units: string, fromDecimals: number, toDecimals: number): string {
  if (!/^[0-9]+$/.test(units)) throw new Error(`invalid amount: ${units}`);
  const value = BigInt(units);
  if (toDecimals >= fromDecimals) {
    return (value * 10n ** BigInt(toDecimals - fromDecimals)).toString();
  }
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  if (value % divisor !== 0n) {
    throw new Error(`amount ${units} is not exact at ${toDecimals} decimals (from ${fromDecimals})`);
  }
  return (value / divisor).toString();
}

/** Nuvion stablecoin units (2 decimals) to chain units (6 decimals). Exact: always a whole number of cents. */
export function nuvionUnitsToChainUnits(units: string): string {
  return convertDecimals(units, 2, 6);
}

/** Chain units (6 decimals) to Nuvion stablecoin units (2 decimals). Throws unless the amount is exact to the cent. */
export function chainUnitsToNuvionUnits(units: string): string {
  return convertDecimals(units, 6, 2);
}
