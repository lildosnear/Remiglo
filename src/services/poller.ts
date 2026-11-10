import { reconcile, PAYOUT_TERMINAL } from "../lib/core.js";
import type { Store } from "../lib/store.js";
import { mapPayoutStatus, mapStatus, type IntentsClient } from "./intents.js";
import { enqueueEvent, processPendingDeliveries, type FetchFn, type WebhookConfig } from "./webhooks.js";
import { runDueSchedules, type ScheduleRunResult, type ScheduleServices } from "./schedules.js";
import type { IndexerRunResult } from "./indexer.js";

export interface SyncDeps {
  store: Store;
  intents: IntentsClient;
  fetchFn: FetchFn;
  webhookCfg: WebhookConfig;
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
 * out of the awaiting states (awaiting_funding, quoted) into a state
 * where the deposit is on its way (funded, processing). A payout that
 * later moves funded -> processing does not fire it again, because its
 * previous state is no longer an awaiting state.
 */
export const PAYOUT_SENT_FROM = ["awaiting_funding", "quoted"];
export const PAYOUT_SENT_TO = ["funded", "processing"];

/**
 * One sync cycle. Polls every open invoice and funded payout, applies at
 * most one transition per entity, writes a ledger entry per transition and
 * enqueues a webhook per transition. Per entity errors are caught and left
 * for the next cycle. Then due webhook deliveries are attempted and batch
 * completion is checked.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  const { store, intents } = deps;
  const result: SyncResult = {
    invoicesChecked: 0, invoicesUpdated: 0, payoutsChecked: 0, payoutsUpdated: 0,
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
      if (mapped === pay.status) continue;
      store.updatePayout(pay.id, { status: mapped, amountOut: st.swapDetails?.amountOut ?? pay.amountOut });
      const txHash = st.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? st.swapDetails?.originChainTxHashes?.[0]?.hash;
      store.addLedger({
        merchantId: pay.merchantId, entityType: "payout", entityId: pay.id,
        kind: `payout_${mapped}`, amount: st.swapDetails?.amountOut ?? pay.amount,
        asset: pay.destinationAsset, txHash,
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
      if (pay.batchId) touchedBatches.add(pay.batchId);
      result.payoutsUpdated += 1;
    } catch {
      result.errors += 1;
    }
  }

  // Batch completion: every payout terminal means the batch is done.
  for (const batchId of touchedBatches) {
    try {
      const batch = store.getBatchById(batchId);
      if (!batch || batch.status === "completed") continue;
      const rows = store.payoutsByBatch(batchId);
      if (rows.length > 0 && rows.every((r) => PAYOUT_TERMINAL.includes(r.status))) {
        store.updateBatch(batchId, { status: "completed" });
        store.addLedger({ merchantId: batch.merchantId, entityType: "batch", entityId: batchId, kind: "batch_completed", amount: batch.totalAmount, asset: rows[0].destinationAsset });
        enqueueEvent(store, batch.merchantId, "batch.completed", batchId, { batchId, status: "completed", totalAmount: batch.totalAmount });
        result.batchesCompleted += 1;
      }
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
