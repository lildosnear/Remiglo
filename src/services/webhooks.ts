import { signWebhook, type WebhookDelivery } from "../lib/core.js";
import type { Store } from "../lib/store.js";

export type FetchFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>;

export const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

export interface WebhookConfig {
  maxAttempts: number;
  baseDelayMs: number;
}

export const webhookConfigFromEnv = (): WebhookConfig => ({
  maxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5),
  baseDelayMs: Number(process.env.WEBHOOK_BACKOFF_MS || 1000),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Create one pending delivery per registered endpoint for this merchant. */
export function enqueueEvent(
  store: Store,
  merchantId: string,
  event: string,
  entityId: string,
  data: Record<string, unknown>
): WebhookDelivery[] {
  const payload = JSON.stringify({
    event,
    entityId,
    data,
    createdAt: new Date().toISOString(),
  });
  return store.listEndpoints(merchantId).map((ep) =>
    store.createDelivery({ merchantId, endpointId: ep.id, event, entityId, payload })
  );
}

/**
 * Attempt one delivery until success or maxAttempts is reached.
 * Every attempt is appended to the delivery attempt log. Backoff doubles
 * per attempt from baseDelayMs. Never throws.
 */
export async function deliverDelivery(
  store: Store,
  delivery: WebhookDelivery,
  fetchFn: FetchFn,
  cfg: WebhookConfig
): Promise<WebhookDelivery> {
  const secret = store.endpointSecret(delivery.endpointId);
  const url = store.endpointUrl(delivery.endpointId);
  let current: WebhookDelivery = delivery;
  if (!secret || !url) {
    return store.updateDelivery(delivery.id, {
      status: "failed", lastError: "endpoint missing", attempts: delivery.attempts + 1,
      attemptLog: [...delivery.attemptLog, { at: new Date().toISOString(), error: "endpoint missing" }],
    })!;
  }
  const signature = signWebhook(secret, delivery.payload);
  while (current.attempts < cfg.maxAttempts) {
    const attemptNo = current.attempts + 1;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-remiglo-signature": signature,
          "x-remiglo-event": delivery.event,
          "x-remiglo-delivery": delivery.id,
        },
        body: delivery.payload,
      });
      const log = [...current.attemptLog, { at: new Date().toISOString(), statusCode: res.status }];
      if (res.ok) {
        return store.updateDelivery(delivery.id, {
          status: "delivered", attempts: attemptNo, attemptLog: log, lastStatusCode: res.status, lastError: undefined,
        })!;
      }
      current = store.updateDelivery(delivery.id, {
        status: attemptNo >= cfg.maxAttempts ? "failed" : "pending",
        attempts: attemptNo, attemptLog: log, lastStatusCode: res.status,
        lastError: `HTTP ${res.status}`,
      })!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const log = [...current.attemptLog, { at: new Date().toISOString(), error: message }];
      current = store.updateDelivery(delivery.id, {
        status: attemptNo >= cfg.maxAttempts ? "failed" : "pending",
        attempts: attemptNo, attemptLog: log, lastError: message,
      })!;
    }
    if (current.status === "pending" && current.attempts < cfg.maxAttempts) {
      await sleep(cfg.baseDelayMs * 2 ** (attemptNo - 1));
    }
  }
  return current;
}

/** Attempt every pending delivery once through its retry loop. */
export async function processPendingDeliveries(
  store: Store,
  fetchFn: FetchFn,
  cfg: WebhookConfig
): Promise<{ attempted: number; delivered: number; failed: number }> {
  let delivered = 0, failed = 0;
  const pending = store.pendingDeliveries();
  for (const d of pending) {
    try {
      const done = await deliverDelivery(store, d, fetchFn, cfg);
      if (done.status === "delivered") delivered += 1;
      else if (done.status === "failed") failed += 1;
    } catch {
      failed += 1; // a single bad delivery never breaks the loop
    }
  }
  return { attempted: pending.length, delivered, failed };
}
