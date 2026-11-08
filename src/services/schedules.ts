import type { Merchant, Schedule } from "../lib/core.js";
import type { Store } from "../lib/store.js";
import { enqueueEvent } from "./webhooks.js";

/**
 * Recurring schedules (Slice D).
 *
 * Cadence model, deliberately simple and documented in
 * docs/ARCHITECTURE.md: weekly advances 7 days, biweekly 14 days,
 * monthly advances to the same day of month (dayOfMonth, clamped to
 * 28 so February never skips). nextRunAt is always the next
 * occurrence; after a run it advances from the occurrence that ran,
 * never from "now", so a late tick does not drift the cadence.
 *
 * Double creation is impossible by construction: an invoice run uses
 * an idempotency key derived from schedule id + occurrence, and every
 * run (either kind) first claims a schedule_runs row whose
 * (schedule_id, occurrence_at) pair is unique.
 */

export interface ScheduleServices {
  createInvoiceFor: (m: Merchant, fields: {
    amount: string; externalRef?: string; currency?: string;
    originAsset?: string; settlementAsset?: string; settlementAddress?: string; refundTo?: string;
    idempotencyKey?: string;
  }) => Promise<{ invoice: { id: string } }>;
  createBatchFor: (m: Merchant, rows: any[]) => Promise<{ batch: { id: string }; quoteError?: string }>;
  /** Resolve recipientId rows and validate them; error string on failure. */
  prepareBatchRows: (m: Merchant, rows: any[]) => { rows?: any[]; error?: string };
}

const DAY_MS = 86400000;

export function firstRunAt(cadence: Schedule["cadence"], dayOfMonth: number | undefined, from: Date): string {
  if (cadence === "weekly") return new Date(from.getTime() + 7 * DAY_MS).toISOString();
  if (cadence === "biweekly") return new Date(from.getTime() + 14 * DAY_MS).toISOString();
  const day = Math.min(dayOfMonth ?? from.getUTCDate(), 28);
  const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), day, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()));
  if (candidate.getTime() <= from.getTime()) {
    candidate.setUTCMonth(candidate.getUTCMonth() + 1);
  }
  return candidate.toISOString();
}

export function nextAfter(schedule: Pick<Schedule, "cadence" | "dayOfMonth">, occurrenceIso: string): string {
  const from = new Date(occurrenceIso);
  if (schedule.cadence === "weekly") return new Date(from.getTime() + 7 * DAY_MS).toISOString();
  if (schedule.cadence === "biweekly") return new Date(from.getTime() + 14 * DAY_MS).toISOString();
  const day = Math.min(schedule.dayOfMonth ?? from.getUTCDate(), 28);
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, day, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()));
  return next.toISOString();
}

export interface ScheduleRunResult { ran: number; skipped: number; failed: number }

/** Run every due, active schedule once. Never throws. */
export async function runDueSchedules(
  store: Store,
  services: ScheduleServices,
  nowIso: string = new Date().toISOString()
): Promise<ScheduleRunResult> {
  const result: ScheduleRunResult = { ran: 0, skipped: 0, failed: 0 };
  for (const schedule of store.dueSchedules(nowIso)) {
    const merchant = store.getMerchant(schedule.merchantId);
    if (!merchant) { result.skipped += 1; continue; }
    const occurrence = schedule.nextRunAt;
    const run = store.createRunIfAbsent(schedule, occurrence);
    if (!run) {
      // A previous tick already claimed this occurrence. Just advance.
      store.updateSchedule(schedule.id, { nextRunAt: nextAfter(schedule, occurrence) });
      result.skipped += 1;
      continue;
    }
    try {
      let entityId: string;
      if (schedule.kind === "invoice") {
        const idem = `sched_${schedule.id}_${occurrence}`;
        const existing = store.invoiceByIdempotency(schedule.merchantId, idem);
        if (existing) {
          entityId = existing.id;
        } else {
          const p = schedule.payload as any;
          const { invoice } = await services.createInvoiceFor(merchant, {
            amount: String(p.amount),
            externalRef: p.externalRef ? String(p.externalRef) : undefined,
            currency: p.currency ? String(p.currency) : undefined,
            originAsset: p.originAsset ? String(p.originAsset) : undefined,
            settlementAsset: p.settlementAsset ? String(p.settlementAsset) : undefined,
            settlementAddress: p.settlementAddress ? String(p.settlementAddress) : undefined,
            refundTo: p.refundTo ? String(p.refundTo) : undefined,
            idempotencyKey: idem,
          });
          entityId = invoice.id;
        }
      } else {
        const prepared = services.prepareBatchRows(merchant, ((schedule.payload as any)?.rows ?? []) as any[]);
        if (prepared.error || !prepared.rows) throw new Error(prepared.error ?? "invalid batch rows");
        const { batch, quoteError } = await services.createBatchFor(merchant, prepared.rows);
        if (quoteError) throw new Error(`quote failed: ${quoteError}`);
        entityId = batch.id;
      }
      store.updateRun(run.id, { status: "succeeded", entityId });
      store.updateSchedule(schedule.id, { lastRunAt: occurrence, nextRunAt: nextAfter(schedule, occurrence) });
      enqueueEvent(store, schedule.merchantId, "schedule.executed", schedule.id, {
        scheduleId: schedule.id, kind: schedule.kind, occurrenceAt: occurrence, entityId, outcome: "succeeded",
      });
      result.ran += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.updateRun(run.id, { status: "failed", error: message });
      store.updateSchedule(schedule.id, { lastRunAt: occurrence, nextRunAt: nextAfter(schedule, occurrence) });
      enqueueEvent(store, schedule.merchantId, "schedule.executed", schedule.id, {
        scheduleId: schedule.id, kind: schedule.kind, occurrenceAt: occurrence, outcome: "failed", error: message,
      });
      result.failed += 1;
    }
  }
  return result;
}
