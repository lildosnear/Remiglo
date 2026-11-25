import { reconcile, PAYOUT_TERMINAL, type Payout } from "../lib/core.js";
import type { Store } from "../lib/store.js";
import { mapPayoutStatus, mapStatus, type IntentsClient } from "./intents.js";
import { mapNuvionPayoutStatus, type NuvionClient } from "./nuvion.js";
import { enqueueEvent, processPendingDeliveries, type FetchFn, type WebhookConfig } from "./webhooks.js";
import { runDueSchedules, type ScheduleRunResult, type ScheduleServices } from "./schedules.js";
import type { IndexerRunResult } from "./indexer.js";

export interface SyncDeps {
  store: Store;
  intents: IntentsClient;
  fetchFn: FetchFn;
  webhookCfg: WebhookConfig;
  /** When set, each sync cycle also polls open Nuvion transfers and drains recorded Nuvion webhook events. */
  nuvion?: NuvionClient;
  /** When set, each sync cycle also ticks the schedule runner. */
  scheduleServices?: ScheduleServices;
  /** When set, each sync cycle also runs one registry indexing pass. */
  indexer?: () => Promise<IndexerRunResult>;
}

export interface SyncResult {
  invoicesChecked: number;
  invoicesUpdated: number;
  payoutsChecked: number;
  payoutsUpdated: number;
  nuvionEventsApplied: number;
  nuvionPayoutsChecked: number;
  nuvionPayoutsUpdated: number;
  batchesCompleted: number;
  errors: number;
  schedules?: ScheduleRunResult;
  indexer?: IndexerRunResult | { error: string };
  webhooks: { attempted: number; delivered: number; failed: number };
}

const INVOICE_EVENT: Record<string, string> = {
  paid: "invoice.paid",
  overpaid: "invoice.paid",
  partially_paid: "invoice.paid",
  expired: "invoice.expired",
  refunded: "invoice.refunded",
  failed: "invoice.failed",
};

const PAYOUT_EVENT: Record<string, string> = {
  settled: "payout.settled",
  failed: "payout.failed",
  refunded: "payout.failed",
};

/**
 * payout.sent fires exactly once per payout: on the first transition
 * out of the awaiting states (awaiting_funding, quoted, and the Nuvion
 * queued state sent) into a state where the money is on its way
 * (funded, processing). A payout that later moves funded -> processing
 * does not fire it again, because its previous state is no longer an
 * awaiting state.
 */
export const PAYOUT_SENT_FROM = ["awaiting_funding", "quoted", "sent"];
export const PAYOUT_SENT_TO = ["funded", "processing"];

/**
 * THE payout transition path (fiat slice 4). Every payout status change
 * after creation, from either rail, goes through here: the status
 * write, one ledger entry, the payout.sent / settled / failed merchant
 * webhooks, all identical. Returns true when the status changed. The
 * caller owns batch completion checks (see completeBatchIfDone),
 * because during batch creation not all rows exist yet.
 */
export function applyPayoutTransition(
  store: Store,
  pay: Payout,
  mapped: string,
  detail?: { amountOut?: string; txHash?: string },
): boolean {
  if (mapped === pay.status) return false;
  store.updatePayout(pay.id, { status: mapped, amountOut: detail?.amountOut ?? pay.amountOut });
  store.addLedger({
    merchantId: pay.merchantId, entityType: "payout", entityId: pay.id,
    kind: `payout_${mapped}`, amount: detail?.amountOut ?? pay.amount,
    asset: pay.destinationAsset, txHash: detail?.txHash,
  });
  const refData = {
    ...(pay.reference ? { reference: pay.reference } : {}),
    ...(pay.grossAmount ? { grossAmount: pay.grossAmount, retentionAmount: pay.retentionAmount, deductionsAmount: pay.deductionsAmount } : {}),
  };
  if (PAYOUT_SENT_FROM.includes(pay.status) && PAYOUT_SENT_TO.includes(mapped)) {
    enqueueEvent(store, pay.merchantId, "payout.sent", pay.id, { payoutId: pay.id, status: mapped, batchId: pay.batchId, ...refData });
  }
  const event = PAYOUT_EVENT[mapped];
  if (event) enqueueEvent(store, pay.merchantId, event, pay.id, { payoutId: pay.id, status: mapped, batchId: pay.batchId, ...refData });
  return true;
}

/**
 * Complete a batch when every one of its payouts is terminal. Only
 * batches still active can complete; the poller calls this for batches
 * a transition touched, never during batch creation.
 */
export function completeBatchIfDone(store: Store, batchId: string): boolean {
  const batch = store.getBatchById(batchId);
  if (!batch || batch.status !== "active") return false;
  const rows = store.payoutsByBatch(batchId);
  if (rows.length === 0 || !rows.every((r) => PAYOUT_TERMINAL.includes(r.status))) return false;
  store.updateBatch(batchId, { status: "completed" });
  store.addLedger({ merchantId: batch.merchantId, entityType: "batch", entityId: batchId, kind: "batch_completed", amount: batch.totalAmount, asset: rows[0].destinationAsset });
  enqueueEvent(store, batch.merchantId, "batch.completed", batchId, { batchId, status: "completed", totalAmount: batch.totalAmount });
  return true;
}

/** Nuvion outflow webhook types that carry a payout transition. */
export const NUVION_OUTFLOW_EVENTS = ["outflows.created", "outflows.completed", "outflows.failed", "outflows.cancelled"];

/**
 * One sync cycle. Polls every open invoice and funded payout, applies at
 * most one transition per entity, writes a ledger entry per transition and
 * enqueues a webhook per transition. Per entity errors are caught and left
 * for the next cycle. Then recorded Nuvion webhook events are drained and
 * open Nuvion transfers are polled (when a Nuvion client is wired), due
 * webhook deliveries are attempted and batch completion is checked.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  const { store, intents } = deps;
  const result: SyncResult = {
    invoicesChecked: 0, invoicesUpdated: 0, payoutsChecked: 0, payoutsUpdated: 0,
    nuvionEventsApplied: 0, nuvionPayoutsChecked: 0, nuvionPayoutsUpdated: 0,
    batchesCompleted: 0, errors: 0, webhooks: { attempted: 0, delivered: 0, failed: 0 },
  };

  for (const inv of store.openInvoices()) {
    result.invoicesChecked += 1;
    try {
      // Expiry wins over a still pending deposit.
      if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) {
        store.updateInvoice(inv.id, { status: "expired" });
        store.addLedger({ merchantId: inv.merchantId, entityType: "invoice", entityId: inv.id, kind: "invoice_expired", amount: inv.amount, asset: inv.settlementAsset });
        enqueueEvent(store, inv.merchantId, "invoice.expired", inv.id, { invoiceId: inv.id, status: "expired" });
        result.invoicesUpdated += 1;
        continue;
      }
      const st = await intents.status(inv.depositAddress!);
      const mapped = mapStatus(st.status);
      if (mapped === inv.status) continue;
      let nextStatus = mapped;
      let reconFlag: string | undefined;
      if (st.status === "SUCCESS") {
        const observed = st.swapDetails?.amountOut;
        const recon = reconcile(inv, observed);
        reconFlag = recon.matched ? "matched" : recon.reason;
        if (!recon.matched) nextStatus = recon.reason; // partially_paid or overpaid
      }
      const patch: Parameters<Store["updateInvoice"]>[1] = { status: nextStatus, reconFlag };
      if (st.status === "SUCCESS") {
        // amountOut stays the quoted expectation; the amount that actually
        // arrived is stored separately so pages and exports can show both.
        if (st.swapDetails?.amountOut) patch.observedAmount = st.swapDetails.amountOut;
      } else if (st.swapDetails?.amountOut) {
        patch.amountOut = st.swapDetails.amountOut;
      }
      const updated = store.updateInvoice(inv.id, patch)!;
      const txHash = st.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? st.swapDetails?.originChainTxHashes?.[0]?.hash;
      store.addLedger({
        merchantId: inv.merchantId, entityType: "invoice", entityId: inv.id,
        kind: `invoice_${nextStatus}`, amount: st.swapDetails?.amountOut ?? inv.amount,
        asset: inv.settlementAsset, txHash,
      });
      const event = INVOICE_EVENT[nextStatus];
      if (event) enqueueEvent(store, inv.merchantId, event, inv.id, { invoiceId: inv.id, status: nextStatus, reconFlag, invoice: updated });
      result.invoicesUpdated += 1;
    } catch {
      result.errors += 1; // solver timeout or network error: retry next cycle
    }
  }

  const touchedBatches = new Set<string>();
  for (const pay of store.openPayouts()) {
    result.payoutsChecked += 1;
    try {
      const st = await intents.status(pay.depositAddress!);
      const mapped = mapPayoutStatus(st.status);
      const txHash = st.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? st.swapDetails?.originChainTxHashes?.[0]?.hash;
      const changed = applyPayoutTransition(store, pay, mapped, { amountOut: st.swapDetails?.amountOut, txHash });
      if (!changed) continue;
      if (pay.batchId) touchedBatches.add(pay.batchId);
      result.payoutsUpdated += 1;
    } catch {
      result.errors += 1;
    }
  }

  // Nuvion pass (fiat slice 4). Two halves, one transition path:
  // recorded webhook events are drained first (a webhook is a trigger
  // to read the transfer's current state, never the state itself),
  // then every open Nuvion payout is polled as the backstop for
  // webhooks that never arrive. Both apply transitions through
  // applyPayoutTransition, exactly like the Intents loop above.
  if (deps.nuvion) {
    const nuvion = deps.nuvion;
    for (const ev of store.unappliedNuvionEvents()) {
      try {
        if (NUVION_OUTFLOW_EVENTS.includes(ev.eventType) && ev.transferId) {
          const pay = store.payoutByProviderRef(ev.transferId);
          if (pay && !PAYOUT_TERMINAL.includes(pay.status)) {
            const t = await nuvion.getTransfer(ev.transferId);
            const changed = applyPayoutTransition(store, pay, mapNuvionPayoutStatus(t.status));
            if (changed) {
              if (pay.batchId) touchedBatches.add(pay.batchId);
              result.nuvionPayoutsUpdated += 1;
            }
          }
        }
        // Unknown types, and events whose payout is unknown or already
        // terminal, are applied with no action: the poller backstop
        // below owns the state, and an event must never drain forever.
        store.markNuvionEventApplied(ev.id);
        result.nuvionEventsApplied += 1;
      } catch {
        result.errors += 1; // left unapplied; the next cycle retries it
      }
    }
    for (const pay of store.openNuvionPayouts()) {
      result.nuvionPayoutsChecked += 1;
      try {
        const t = await nuvion.getTransfer(pay.providerRef!);
        const changed = applyPayoutTransition(store, pay, mapNuvionPayoutStatus(t.status));
        if (!changed) continue;
        if (pay.batchId) touchedBatches.add(pay.batchId);
        result.nuvionPayoutsUpdated += 1;
      } catch {
        result.errors += 1;
      }
    }
  }

  // Batch completion: every payout terminal means the batch is done.
  for (const batchId of touchedBatches) {
    try {
      if (completeBatchIfDone(store, batchId)) result.batchesCompleted += 1;
    } catch {
      result.errors += 1;
    }
  }

  // Schedule runner tick: due schedules create their invoice or batch
  // through the same service functions the API and dashboard use.
  if (deps.scheduleServices) {
    try {
      result.schedules = await runDueSchedules(store, deps.scheduleServices);
    } catch {
      result.errors += 1;
    }
  }

  // Registry indexer tick (Slice I): failures are reported in the
  // result, never thrown, so a chain RPC outage cannot stall syncing.
  if (deps.indexer) {
    try {
      result.indexer = await deps.indexer();
    } catch (err) {
      result.indexer = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  result.webhooks = await processPendingDeliveries(store, deps.fetchFn, deps.webhookCfg);
  return result;
}
