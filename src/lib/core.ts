import { createHmac } from "node:crypto";

export interface Merchant {
  id: string;
  name: string;
  settlementAsset: string;
  settlementAddress: string;
  refundTo: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  merchantId: string;
  externalRef?: string;
  amount: string;
  currency: string;
  originAsset?: string;
  settlementAsset: string;
  settlementAddress: string;
  refundTo?: string;
  status: string;
  depositAddress?: string;
  amountOut?: string;
  /** Settlement amount actually observed on chain at SUCCESS, when known. amountOut keeps the quoted expectation. */
  observedAmount?: string;
  expiresAt?: string;
  reconFlag?: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt?: string;
}

/** One row of a payout request (single payout or batch row), resolved. */
export interface PayoutRow {
  recipientAddress: string;
  destinationAsset: string;
  amount: string;
  reference?: string;
}

export interface Payout {
  id: string;
  merchantId: string;
  batchId?: string;
  recipientAddress: string;
  destinationAsset: string;
  originAsset: string;
  refundTo?: string;
  amount: string;
  status: string;
  depositAddress?: string;
  amountOut?: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Recipient {
  id: string;
  merchantId: string;
  label: string;
  address: string;
  assetId: string;
  /** Chain key derived from the asset (for example "near", "base"). */
  chain: string;
  notes?: string;
  createdAt: string;
  updatedAt?: string;
}

export type ScheduleKind = "invoice" | "payout_batch";
export type ScheduleCadence = "weekly" | "biweekly" | "monthly";

/**
 * Recurring schedule. Cadence model (kept deliberately simple):
 * weekly = every 7 days, biweekly = every 14 days, monthly = the same
 * day of month (dayOfMonth, clamped to 28). nextRunAt always holds the
 * next occurrence; after a run it advances from that occurrence.
 * payload is the invoice fields or { rows } for the batch to create.
 */
export interface Schedule {
  id: string;
  merchantId: string;
  kind: ScheduleKind;
  cadence: ScheduleCadence;
  dayOfMonth?: number;
  payload: Record<string, unknown>;
  nextRunAt: string;
  lastRunAt?: string;
  active: boolean;
  createdAt: string;
  updatedAt?: string;
}

export type DashRole = "owner" | "admin" | "operator" | "viewer";

/** A dashboard user. Password material never leaves the store layer. */
export interface DashUser {
  id: string;
  merchantId: string;
  email: string;
  role: DashRole;
  active: boolean;
  createdAt: string;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  merchantId: string;
  occurrenceAt: string;
  status: string; // started | succeeded | failed
  entityId?: string;
  error?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface PayoutBatch {
  id: string;
  merchantId: string;
  status: string; // pending_approval | active | completed
  totalAmount: string;
  rowCount: number;
  rows: Array<Record<string, unknown>>;
  /** Registry anchoring (Slice G): none | pending | anchored | failed. */
  anchorTxHash?: string | null;
  anchorStatus?: string;
  createdAt: string;
  updatedAt?: string;
}

/** One audit event indexed from the registry contract (Slice I). */
export interface RegistryEvent {
  id: string;
  txHash: string;
  logIndex: number;
  blockHeight: number;
  contractId: string;
  event: string;
  data: Record<string, unknown>;
  indexedAt: string;
}

export interface LedgerEntry {
  id: string;
  merchantId?: string;
  entityType: "invoice" | "payout" | "batch";
  entityId: string;
  kind: string;
  amount: string;
  asset: string;
  txHash?: string;
  createdAt: string;
}

export interface WebhookEndpoint {
  id: string;
  merchantId: string;
  url: string;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  merchantId: string;
  endpointId: string;
  event: string;
  entityId?: string;
  payload: string;
  status: string; // pending | delivered | failed
  attempts: number;
  attemptLog: Array<{ at: string; statusCode?: number; error?: string }>;
  lastStatusCode?: number;
  lastError?: string;
  createdAt: string;
  updatedAt?: string;
}

export function signWebhook(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export interface ReconResult {
  matched: boolean;
  reason: string;
  diff?: string;
}

/**
 * Compare an observed settlement amount (smallest units, string) with what an
 * invoice expected. Expected is amountOut when known, otherwise amount.
 * Flags partially_paid and overpaid on any difference. Never uses floats.
 */
export function reconcile(
  invoice: Pick<Invoice, "amount" | "amountOut">,
  observedAmount?: string
): ReconResult {
  if (!observedAmount) return { matched: false, reason: "no settlement observed yet" };
  const expected = invoice.amountOut ?? invoice.amount;
  if (observedAmount === expected) return { matched: true, reason: "matched" };
  const diff = BigInt(observedAmount) - BigInt(expected);
  return { matched: false, reason: diff > 0n ? "overpaid" : "partially_paid", diff: diff.toString() };
}

/** Fee estimate in smallest units: gross * bps / 10000, integer math only. */
export function feeEstimate(grossUnits: string, bps: number): string {
  return ((BigInt(grossUnits) * BigInt(bps)) / 10000n).toString();
}

export function isAmountString(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]+$/.test(v) && BigInt(v) > 0n;
}

export const INVOICE_TERMINAL = ["paid", "partially_paid", "overpaid", "expired", "refunded", "failed", "cancelled"];
export const PAYOUT_TERMINAL = ["settled", "failed", "refunded"];
