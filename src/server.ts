import { buildApp } from "./server-app.js";
import { syncOnce } from "./services/poller.js";

const app = buildApp();
const port = Number(process.env.PORT || 8400);

await app.listen({ port, host: "127.0.0.1" });
console.log(`remiglo listening on http://127.0.0.1:${port}`);

// Background poller. POLL_SECONDS=0 disables it (tests use the sync route).
// Each cycle also ticks the schedule runner and, when configured, the
// registry indexer (Slice I), through the shared sync dependencies.
const pollSeconds = Number(process.env.POLL_SECONDS ?? 15);
if (pollSeconds > 0 && process.env.NODE_ENV !== "test") {
  const { syncDeps } = (app as any).remiglo;
  const timer = setInterval(() => {
    syncOnce(syncDeps)
      .catch((err) => console.error("poller cycle failed", err));
  }, pollSeconds * 1000);
  timer.unref();
  console.log(`remiglo poller running every ${pollSeconds}s`);
}

// Registry indexer (Slice I). INDEXER_SECONDS=0 (the default) means no
// dedicated timer; the indexer still ticks inside every poller cycle
// whenever a registry contract is configured. A positive value runs it
// on its own interval as well.
const indexerSeconds = Number(process.env.INDEXER_SECONDS ?? 0);
const indexerRun = (app as any).remiglo.indexerRun as (() => Promise<unknown>) | undefined;
if (indexerSeconds > 0 && indexerRun && process.env.NODE_ENV !== "test") {
  const timer = setInterval(() => {
    indexerRun().catch((err) => console.error("indexer cycle failed", err));
  }, indexerSeconds * 1000);
  timer.unref();
  console.log(`remiglo registry indexer running every ${indexerSeconds}s`);
}
