/**
 * Remiglo SDK: a typed TypeScript client for the Remiglo payments API.
 * No runtime dependencies beyond the platform fetch (Node 18+).
 *
 *   import { Remiglo } from "remiglo-sdk";
 *   const remiglo = new Remiglo({ baseUrl: "http://127.0.0.1:8400", apiKey: "rgl_live_..." });
 *   const invoice = await remiglo.createInvoice({ amount: "10000000" }, { idempotencyKey: "order-1" });
 *   // invoice.paymentUrl -> share with the customer
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export class RemigloError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const message = (body as any)?.error ?? `Remiglo API request failed with ${status}`;
    super(String(message));
    this.name = "RemigloError";
    this.status = status;
    this.body = body;
  }
}

export interface Merchant {
  id: string; name: string; settlementAsset: string; settlementAddress: string;
  refundTo: string; createdAt: string;
}

export interface Invoice {
  id: string; merchantId: string; externalRef?: string; amount: string; currency: string;
  originAsset?: string; settlementAsset: string; settlementAddress: string; refundTo?: string;
  status: string; depositAddress?: string; amountOut?: string; observedAmount?: string;
  expiresAt?: string; reconFlag?: string; paymentUrl: string; createdAt: string; updatedAt?: string;
  payment?: { depositAddress: string; amountIn: string; amountOut: string; deadline: string; qrPayload: string };
}

export interface CreateInvoiceInput {
  amount: string;
  externalRef?: string;
  currency?: string;
  originAsset?: string;
  settlementAsset?: string;
  settlementAddress?: string;
  refundTo?: string;
}

export interface Payout {
  id: string; merchantId: string; batchId?: string; recipientAddress: string;
  destinationAsset: string; originAsset: string; refundTo?: string; amount: string;
  status: string; depositAddress?: string; amountOut?: string; createdAt: string; updatedAt?: string;
  retryOfId?: string;
  reference?: string;
  grossAmount?: string; retentionAmount?: string; deductionsAmount?: string;
}

export interface PayoutRow {
  recipientAddress?: string;
  destinationAsset?: string;
  recipientId?: string;
  originAsset?: string;
  refundTo?: string;
  amount: string;
  reference?: string;
  /** Optional certified breakdown: amount must equal grossAmount - retentionAmount - deductionsAmount. */
  grossAmount?: string;
  retentionAmount?: string;
  deductionsAmount?: string;
}

export interface PayoutBatch {
  id: string; merchantId: string; status: string; totalAmount: string; rowCount: number;
  rows: PayoutRow[]; createdAt: string; updatedAt?: string;
  payouts?: Payout[];
  totals?: { totalAmount: string; rowCount: number };
  anchorTxHash?: string;
  anchorStatus?: string;
}

export interface Recipient {
  id: string; merchantId: string; label: string; address: string; assetId: string;
  chain: string; notes?: string; createdAt: string; updatedAt?: string;
}

export interface Schedule {
  id: string; merchantId: string; kind: "invoice" | "payout_batch";
  cadence: "weekly" | "biweekly" | "monthly"; dayOfMonth?: number;
  payload: Record<string, unknown>; nextRunAt: string; lastRunAt?: string;
  active: boolean; createdAt: string; updatedAt?: string;
}

export interface CreateScheduleInput {
  kind: Schedule["kind"];
  cadence: Schedule["cadence"];
  dayOfMonth?: number;
  startAt?: string;
  active?: boolean;
  payload: Record<string, unknown>;
}

export interface WebhookEndpoint { id: string; url: string; createdAt: string }
export interface WebhookDelivery {
  id: string; event: string; entityId?: string; status: string; attempts: number;
  lastStatusCode?: number; lastError?: string; createdAt: string;
}

export interface ReconDaily {
  merchantId: string;
  invoicesByStatus: Record<string, number>;
  reconFlags: Record<string, number>;
  ledgerEntries: number;
  payouts: number;
  batches: number;
}

export interface RemigloOptions {
  baseUrl: string;
  apiKey: string;
  /** Inject a fetch implementation (tests, non standard runtimes). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export class Remiglo {
  private baseUrl: string;
  private apiKey: string;
  private fetchFn: typeof fetch;

  constructor(options: RemigloOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async request<T>(method: string, path: string, opts: {
    body?: unknown; rawBody?: string; contentType?: string; idempotencyKey?: string;
  } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    let body: string | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      headers["content-type"] = opts.contentType ?? "text/plain";
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* CSV and plain text stay raw */ }
    if (!res.ok) throw new RemigloError(res.status, parsed);
    return parsed as T;
  }

  // ---- invoices ----
  createInvoice(input: CreateInvoiceInput, opts: { idempotencyKey?: string } = {}): Promise<Invoice> {
    return this.request("POST", "/v1/invoices", { body: input, idempotencyKey: opts.idempotencyKey });
  }
  listInvoices(): Promise<Invoice[]> { return this.request("GET", "/v1/invoices"); }
  getInvoice(id: string): Promise<Invoice> { return this.request("GET", `/v1/invoices/${encodeURIComponent(id)}`); }
  cancelInvoice(id: string): Promise<Invoice> { return this.request("POST", `/v1/invoices/${encodeURIComponent(id)}/cancel`, { body: {} }); }

  // ---- payouts ----
  createPayout(row: PayoutRow, opts: { idempotencyKey?: string } = {}): Promise<Payout> {
    return this.request("POST", "/v1/payouts", { body: row, idempotencyKey: opts.idempotencyKey });
  }
  listPayouts(): Promise<Payout[]> { return this.request("GET", "/v1/payouts"); }
  getPayout(id: string): Promise<Payout> { return this.request("GET", `/v1/payouts/${encodeURIComponent(id)}`); }

  // ---- payout batches ----
  createBatch(rows: PayoutRow[]): Promise<PayoutBatch> {
    return this.request("POST", "/v1/payout-batches", { body: { rows } });
  }
  /** Create a batch from CSV text (headers per the API docs). */
  createBatchFromCsv(csv: string): Promise<PayoutBatch> {
    return this.request("POST", "/v1/payout-batches", { rawBody: csv, contentType: "text/csv" });
  }
  listBatches(): Promise<PayoutBatch[]> { return this.request("GET", "/v1/payout-batches"); }
  getBatch(id: string): Promise<PayoutBatch> { return this.request("GET", `/v1/payout-batches/${encodeURIComponent(id)}`); }
  approveBatch(id: string): Promise<PayoutBatch> { return this.request("POST", `/v1/payout-batches/${encodeURIComponent(id)}/approve`, { body: {} }); }

  // ---- recipients ----
  createRecipient(input: { label?: string; address: string; assetId: string; notes?: string }): Promise<Recipient> {
    return this.request("POST", "/v1/recipients", { body: input });
  }
  listRecipients(): Promise<Recipient[]> { return this.request("GET", "/v1/recipients"); }
  getRecipient(id: string): Promise<Recipient> { return this.request("GET", `/v1/recipients/${encodeURIComponent(id)}`); }
  updateRecipient(id: string, patch: { label?: string; address?: string; assetId?: string; notes?: string }): Promise<Recipient> {
    return this.request("PATCH", `/v1/recipients/${encodeURIComponent(id)}`, { body: patch });
  }
  deleteRecipient(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v1/recipients/${encodeURIComponent(id)}`);
  }

  // ---- schedules ----
  createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    return this.request("POST", "/v1/schedules", { body: input });
  }
  listSchedules(): Promise<Schedule[]> { return this.request("GET", "/v1/schedules"); }
  getSchedule(id: string): Promise<Schedule & { runs: unknown[] }> {
    return this.request("GET", `/v1/schedules/${encodeURIComponent(id)}`);
  }
  updateSchedule(id: string, patch: Partial<CreateScheduleInput> & { active?: boolean }): Promise<Schedule> {
    return this.request("PATCH", `/v1/schedules/${encodeURIComponent(id)}`, { body: patch });
  }
  pauseSchedule(id: string): Promise<Schedule> { return this.request("POST", `/v1/schedules/${encodeURIComponent(id)}/pause`, { body: {} }); }
  resumeSchedule(id: string): Promise<Schedule> { return this.request("POST", `/v1/schedules/${encodeURIComponent(id)}/resume`, { body: {} }); }
  deleteSchedule(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v1/schedules/${encodeURIComponent(id)}`);
  }

  // ---- reconciliation ----
  reconciliationDaily(): Promise<ReconDaily> { return this.request("GET", "/v1/reconciliation/daily"); }
  /** The reconciliation CSV export, returned as raw text. */
  reconciliationCsv(): Promise<string> { return this.request("GET", "/v1/reconciliation/export.csv"); }
  ledger(entityId?: string): Promise<unknown[]> {
    return this.request("GET", `/v1/ledger${entityId ? `?entity_id=${encodeURIComponent(entityId)}` : ""}`);
  }

  // ---- webhooks ----
  createWebhookEndpoint(url: string): Promise<WebhookEndpoint & { secret: string }> {
    return this.request("POST", "/v1/webhook-endpoints", { body: { url } });
  }
  listWebhookEndpoints(): Promise<WebhookEndpoint[]> { return this.request("GET", "/v1/webhook-endpoints"); }
  listWebhookDeliveries(): Promise<WebhookDelivery[]> { return this.request("GET", "/v1/webhook-deliveries"); }
  replayWebhookDelivery(id: string): Promise<WebhookDelivery> {
    return this.request("POST", `/v1/webhook-deliveries/${encodeURIComponent(id)}/replay`, { body: {} });
  }

  me(): Promise<{ merchant: Merchant }> { return this.request("GET", "/v1/merchants/me"); }
}

/**
 * Verify a Remiglo webhook signature: HMAC SHA256 of the raw payload
 * with the endpoint secret, compared in constant time against the
 * x-remiglo-signature header value (hex).
 */
export function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default Remiglo;
