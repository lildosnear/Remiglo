import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import QRCode from "qrcode";
import { feeEstimate, isAmountString, PAYOUT_TERMINAL, type Invoice, type Merchant, type PayoutBatch } from "./lib/core.js";
import { Store, makeId, newWebhookSecret } from "./lib/store.js";
import {
  pickMerchant, renderAnalytics, renderBatchDetail, renderDevelopers, renderInvoices, renderLogin, renderNoMerchant,
  renderOverview, renderPayments, renderPayouts, renderRecipients, renderReconciliation, renderRouting,
  renderSchedules, renderSettings, renderSetup,
  type DashData,
} from "./lib/dashboard.js";
import {
  can, clearSessionCookie, hashPassword, hashToken, newSessionToken, parseCookieHeader,
  sessionCookie, verifyPassword, SESSION_COOKIE, SESSION_TTL_MS, type DashAction,
} from "./lib/auth.js";
import type { DashUser } from "./lib/core.js";
import { BUILTIN_ASSETS, builtinAsset, chainNameFor, guessAsset, parseDecimalToUnits, type AssetInfo } from "./lib/assets.js";
import { renderPayNotFound, renderPayPage } from "./lib/paypage.js";
import { parseBatchCsv } from "./lib/csv.js";
import { getIntentsClient, MockIntents, type IntentsClient } from "./services/intents.js";
import { getNuvionClient, MockNuvion, chainUnitsToNuvionUnits, mapNuvionPayoutStatus, type CreatePaymentDetailRequest, type NuvionClient } from "./services/nuvion.js";
import { NearRegistry, type RegistryClient } from "./services/registry.js";
import { indexOnce, indexerStatus } from "./services/indexer.js";
import { NearRpc } from "./services/nearTx.js";
import type { Payout, PayoutRow, Recipient, RecipientKind } from "./lib/core.js";
import { applyPayoutTransition, syncOnce } from "./services/poller.js";
import { firstRunAt, type ScheduleServices } from "./services/schedules.js";
import {
  defaultFetch, deliverDelivery, enqueueEvent, webhookConfigFromEnv, type FetchFn, type WebhookConfig,
} from "./services/webhooks.js";

export interface AppConfig {
  dbPath: string;
  adminToken?: string;
  appFeeBps: number;
  appFeeRecipient?: string;
  pilotMaxPayoutUnits: string;
  approvalThresholdUnits: string;
  webhook: WebhookConfig;
  // Registry anchoring (Slice G). All three registry fields must be set
  // for the live NearRegistry to engage; otherwise anchoring is off.
  registryContractId?: string;
  registryKeyFile?: string;
  registryMerchantAccount?: string;
  nearRpcUrl?: string;
  registryNetwork?: string;
  nearArchivalRpcUrl?: string;
  // Nuvion merchant linking (fiat slice 2): currencies that get an
  // account opened for a merchant once its Nuvion entity is approved.
  nuvionCurrencies: string[];
  // Inbound Nuvion webhooks (fiat slice 4): the HMAC secret and the
  // header the signature arrives in. No secret configured means
  // deliveries are accepted unverified (development and mock mode).
  nuvionWebhookSecret?: string;
  nuvionWebhookSignatureHeader: string;
}

export interface BuildOptions {
  store?: Store;
  intents?: IntentsClient;
  mockIntents?: MockIntents;
  nuvion?: NuvionClient;
  mockNuvion?: MockNuvion;
  fetchFn?: FetchFn;
  registry?: RegistryClient;
  config?: Partial<AppConfig>;
}

export function resolveConfig(partial?: Partial<AppConfig>): AppConfig {
  return {
    dbPath: partial?.dbPath ?? process.env.REMIGLO_DB ?? "./data/remiglo.db",
    adminToken: partial?.adminToken ?? process.env.ADMIN_TOKEN,
    appFeeBps: partial?.appFeeBps ?? Number(process.env.APP_FEE_BPS || 50),
    appFeeRecipient: partial?.appFeeRecipient ?? process.env.APP_FEE_RECIPIENT,
    pilotMaxPayoutUnits: partial?.pilotMaxPayoutUnits ?? process.env.PILOT_MAX_PAYOUT_UNITS ?? "100000000",
    approvalThresholdUnits: partial?.approvalThresholdUnits ?? process.env.APPROVAL_THRESHOLD_UNITS ?? "500000000",
    webhook: partial?.webhook ?? webhookConfigFromEnv(),
    registryContractId: partial?.registryContractId ?? process.env.REGISTRY_CONTRACT_ID,
    registryKeyFile: partial?.registryKeyFile ?? process.env.REGISTRY_KEY_FILE,
    registryMerchantAccount: partial?.registryMerchantAccount ?? process.env.REGISTRY_MERCHANT_ACCOUNT,
    nearRpcUrl: partial?.nearRpcUrl ?? process.env.NEAR_RPC_URL,
    registryNetwork: partial?.registryNetwork ?? process.env.REGISTRY_NETWORK,
    nearArchivalRpcUrl: partial?.nearArchivalRpcUrl ?? process.env.NEAR_ARCHIVAL_RPC_URL,
    nuvionCurrencies: partial?.nuvionCurrencies
      ?? (process.env.NUVION_CURRENCIES ?? "NGN,USD").split(",").map((c) => c.trim()).filter(Boolean),
    nuvionWebhookSecret: partial?.nuvionWebhookSecret ?? process.env.NUVION_WEBHOOK_SECRET,
    nuvionWebhookSignatureHeader: partial?.nuvionWebhookSignatureHeader
      ?? process.env.NUVION_WEBHOOK_SIGNATURE_HEADER ?? "x-nuvion-signature",
  };
}

declare module "fastify" {
  interface FastifyRequest { merchant?: Merchant; dashUser?: DashUser }
}

export function buildApp(options: BuildOptions = {}) {
  const cfg = resolveConfig(options.config);
  const store = options.store ?? new Store(cfg.dbPath);
  const intents = options.intents ?? options.mockIntents ?? getIntentsClient();
  // Nuvion (fiat slice 2): a client counts as available only when one is
  // injected, a real key is configured, or NUVION_MOCK=1 asks for the
  // mock. getNuvionClient on its own always returns the live client, so
  // availability is decided here, not there. When unavailable, merchant
  // linking is skipped and behaviour is exactly the pre Nuvion one.
  const nuvionClient: NuvionClient | undefined = options.nuvion ?? options.mockNuvion
    ?? (process.env.NUVION_API_KEY || process.env.NUVION_MOCK === "1" ? getNuvionClient() : undefined);
  const fetchFn = options.fetchFn ?? defaultFetch;
  const app = Fastify({ logger: false });

  // Dashboard forms post urlencoded bodies; Fastify core has no parser
  // for that type, so register a small one (flat fields only).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(body as string))); }
    catch (err) { done(err as Error); }
  });

  // CSV batch uploads arrive as a raw text/csv body (no multipart
  // dependency). The body reaches the route as a plain string.
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) => {
    done(null, body as string);
  });

  (app as any).remiglo = { store, intents, cfg, fetchFn, nuvion: nuvionClient };
  app.addHook("onClose", async () => { try { store.close(); } catch { /* already closed */ } });

  // ---- registry anchoring (Slice G) ----
  // Engages only when a client is injected or all three registry env
  // fields are configured. Fire and forget by design: anchoring never
  // blocks or fails an API request; outcomes land on the batch row and
  // in the ledger.
  const registryClient: RegistryClient | undefined = options.registry
    ?? (cfg.registryContractId && cfg.registryKeyFile && cfg.registryMerchantAccount
      ? new NearRegistry({
          contractId: cfg.registryContractId,
          keyFile: cfg.registryKeyFile,
          merchantAccountId: cfg.registryMerchantAccount,
          rpcUrl: cfg.nearRpcUrl,
        })
      : undefined);
  const anchorPending = new Set<Promise<void>>();
  const anchorBatchNow = (batch: PayoutBatch, rows: PayoutRow[]): void => {
    if (!registryClient) return;
    store.updateBatch(batch.id, { anchorStatus: "pending" });
    const job = (async () => {
      try {
        const res = await registryClient.anchorBatch(batch, rows);
        store.updateBatch(batch.id, { anchorStatus: "anchored", anchorTxHash: res.txHash });
        store.addLedger({
          merchantId: batch.merchantId, entityType: "batch", entityId: batch.id,
          kind: "batch_anchored", amount: batch.totalAmount, asset: String((rows[0] as any)?.destinationAsset ?? ""),
          txHash: res.txHash,
        });
      } catch (err) {
        store.updateBatch(batch.id, { anchorStatus: "failed" });
        store.addLedger({
          merchantId: batch.merchantId, entityType: "batch", entityId: batch.id,
          kind: "batch_anchor_failed", amount: batch.totalAmount, asset: String((rows[0] as any)?.destinationAsset ?? ""),
        });
        console.error(`registry anchor failed for batch ${batch.id}:`, err instanceof Error ? err.message : err);
      }
    })();
    anchorPending.add(job);
    void job.finally(() => anchorPending.delete(job));
  };
  (app as any).remiglo.registry = registryClient;
  (app as any).remiglo.anchorFlush = async (): Promise<void> => {
    while (anchorPending.size > 0) await Promise.all([...anchorPending]);
  };

  // ---- registry indexer (Slice I) ----
  // Engages when a registry contract is configured. Runs inside the
  // sync loop; INDEXER_SECONDS adds a dedicated timer in server.ts.
  const indexerRun = cfg.registryContractId
    ? () => indexOnce({
        store,
        rpc: new NearRpc(cfg.nearRpcUrl ?? (cfg.registryNetwork === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org")),
        archivalRpc: cfg.nearArchivalRpcUrl ? new NearRpc(cfg.nearArchivalRpcUrl) : undefined,
        contractId: cfg.registryContractId!,
      })
    : undefined;
  (app as any).remiglo.indexerRun = indexerRun;

  // ---- asset display info (payment page) ----
  // Live mode: the 1Click token list is the source of truth, cached 10 min.
  // Mock or offline mode: the built in map is. Either source falls back to
  // the other, then to a conservative guess, so a page always renders.
  const mockMode = intents instanceof MockIntents || process.env.INTENTS_MOCK === "1";
  let tokenCache: { at: number; tokens: Awaited<ReturnType<IntentsClient["tokens"]>> } | undefined;
  const fromTokenList = async (assetId: string): Promise<AssetInfo | undefined> => {
    try {
      if (!tokenCache || Date.now() - tokenCache.at > 10 * 60 * 1000) {
        tokenCache = { at: Date.now(), tokens: await intents.tokens() };
      }
      const t = tokenCache.tokens.find((x) => x.assetId === assetId);
      return t ? { assetId, symbol: t.symbol, decimals: t.decimals, blockchain: t.blockchain, chainName: chainNameFor(t.blockchain) } : undefined;
    } catch {
      return undefined;
    }
  };
  const assetInfo = async (assetId?: string): Promise<AssetInfo> => {
    if (!assetId) return guessAsset("");
    if (mockMode) return builtinAsset(assetId) ?? (await fromTokenList(assetId)) ?? guessAsset(assetId);
    return (await fromTokenList(assetId)) ?? builtinAsset(assetId) ?? guessAsset(assetId);
  };

  const withPaymentUrl = <T extends Invoice>(inv: T) => ({ ...inv, paymentUrl: `/pay/${inv.id}` });

  const requireMerchant = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return reply.code(401).send({ error: "missing Authorization Bearer API key" });
    const merchant = store.merchantByApiKey(header.slice("Bearer ".length).trim());
    if (!merchant) return reply.code(401).send({ error: "invalid API key" });
    req.merchant = merchant;
  };

  const isLocal = (req: FastifyRequest) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
  const hasAdmin = (req: FastifyRequest) => !!cfg.adminToken && req.headers["x-admin-token"] === cfg.adminToken;

  app.get("/health", async () => ({ ok: true, service: "remiglo", version: "1.0.0" }));

  // The root path has no page of its own; send browsers to the dashboard.
  app.get("/", async (req, reply) => reply.redirect(303, "/dashboard"));

  // Brand mark for the dashboard sidebar (assets/logo-lockup.png in the repo).
  app.get("/brand/logo.png", async (req, reply) => {
    try {
      const buf = await readFile(join(process.cwd(), "assets", "logo-lockup.png"));
      return reply.type("image/png").header("cache-control", "public, max-age=86400").send(buf);
    } catch {
      return reply.code(404).send({ error: "logo not found" });
    }
  });

  // ---- business dashboard (docs/DASHBOARD-DESIGN.md) ----
  // Accounts model (Slice F): while no dashboard users exist, the
  // instance is in setup mode and pages redirect to /dashboard/setup.
  // Once the owner exists, every page needs a session login, and action
  // routes check the session role against the permission matrix in
  // lib/auth.ts. The old localhost-or-admin-token guard survives only
  // as a break glass for actions while no users exist yet.
  const usersExist = () => store.countUsers() > 0;
  const currentUser = (req: FastifyRequest): DashUser | undefined => {
    const token = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return undefined;
    return store.sessionUser(hashToken(token));
  };
  const startSession = (reply: FastifyReply, userId: string) => {
    const token = newSessionToken();
    store.createSession(userId, hashToken(token), new Date(Date.now() + SESSION_TTL_MS).toISOString());
    reply.header("set-cookie", sessionCookie(token));
  };

  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/dashboard")) return;
    if (req.url.startsWith("/dashboard/setup") || req.url.startsWith("/dashboard/login") || req.url.startsWith("/dashboard/logout")) return;
    if (req.method !== "GET") return; // action routes guard themselves
    if (!usersExist()) return reply.redirect(303, "/dashboard/setup");
    const user = currentUser(req);
    if (!user) return reply.redirect(303, "/dashboard/login");
    req.dashUser = user;
  });

  app.get("/dashboard/setup", async (req, reply) => {
    if (usersExist()) return reply.redirect(303, "/dashboard/login");
    return reply.type("text/html").send(renderSetup(store.listMerchants(), (req.query as any)?.error));
  });

  app.post("/dashboard/setup", async (req, reply) => {
    if (usersExist()) return reply.redirect(303, "/dashboard/login");
    const b = (req.body ?? {}) as any;
    const merchant = store.getMerchant(String(b.merchantId ?? ""));
    if (!merchant) return reply.redirect(303, "/dashboard/setup?error=" + encodeURIComponent("Choose the business this owner account belongs to."));
    const email = String(b.email ?? "").trim().toLowerCase();
    const password = String(b.password ?? "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.redirect(303, "/dashboard/setup?error=" + encodeURIComponent("Enter a valid email address."));
    if (password.length < 8) return reply.redirect(303, "/dashboard/setup?error=" + encodeURIComponent("Password must be at least 8 characters."));
    const { salt, hash } = hashPassword(password);
    const user = store.createUser({ merchantId: merchant.id, email, passwordHash: hash, salt, role: "owner" });
    startSession(reply, user.id);
    return reply.redirect(303, "/dashboard");
  });

  app.get("/dashboard/login", async (req, reply) => {
    if (!usersExist()) return reply.redirect(303, "/dashboard/setup");
    if (currentUser(req)) return reply.redirect(303, "/dashboard");
    return reply.type("text/html").send(renderLogin((req.query as any)?.error));
  });

  app.post("/dashboard/login", async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const creds = store.userCredentialsByEmail(String(b.email ?? ""));
    const ok = creds?.user.active && verifyPassword(String(b.password ?? ""), creds.salt, creds.passwordHash);
    if (!creds || !ok) {
      return reply.redirect(303, "/dashboard/login?error=" + encodeURIComponent("Email or password did not match."));
    }
    startSession(reply, creds.user.id);
    return reply.redirect(303, "/dashboard");
  });

  const logout = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
    if (token) store.deleteSession(hashToken(token));
    reply.header("set-cookie", clearSessionCookie());
    return reply.redirect(303, "/dashboard/login");
  };
  app.get("/dashboard/logout", logout);
  app.post("/dashboard/logout", logout);

  const dashMerchant = (req: FastifyRequest) => {
    if (req.dashUser) return store.getMerchant(req.dashUser.merchantId);
    return pickMerchant(store, (req.query as any)?.merchant);
  };
  const dashData = (merchant: Merchant, req?: FastifyRequest): DashData => ({
    store, merchant, feeBps: cfg.appFeeBps, pilotMaxPayoutUnits: cfg.pilotMaxPayoutUnits,
    role: req?.dashUser?.role, userEmail: req?.dashUser?.email,
  });
  const dashRedirect = (reply: FastifyReply, path: string, params: Record<string, string | undefined>) => {
    const qs = Object.entries(params).filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
    return reply.redirect(303, qs ? `${path}?${qs}` : path);
  };
  /** API validation messages are lowercase fragments; dashboard banners read as sentences. */
  const dashError = (msg: string) => msg.charAt(0).toUpperCase() + msg.slice(1) + (msg.endsWith(".") ? "" : ".");
  const guardDashAction = (req: FastifyRequest, reply: FastifyReply, action: DashAction = "create"): boolean => {
    if (!usersExist()) {
      // Break glass: only while no owner account exists yet.
      if (!hasAdmin(req) && !isLocal(req)) {
        reply.code(403).send({ error: "dashboard actions require the admin token or a localhost request" });
        return false;
      }
      return true;
    }
    const user = currentUser(req);
    if (!user) {
      reply.code(403).send({ error: "dashboard actions require a signed in session" });
      return false;
    }
    req.dashUser = user;
    const requestedMerchant = (req.query as any)?.merchant as string | undefined;
    if (requestedMerchant && requestedMerchant !== user.merchantId) {
      // A session only ever acts on its own merchant.
      reply.code(403).send({ error: "this session belongs to a different merchant" });
      return false;
    }
    if (!can(user.role, action)) {
      reply.code(403).send({ error: `the ${user.role} role cannot perform this action` });
      return false;
    }
    return true;
  };

  app.get("/dashboard", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("overview", "Overview"));
    const q = req.query as any;
    return reply.type("text/html").send(renderOverview(dashData(m, req), { notice: q.notice, error: q.error }));
  });

  app.get("/dashboard/payments", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("payments", "Payments"));
    return reply.type("text/html").send(renderPayments(dashData(m, req), { status: (req.query as any).status }));
  });

  app.get("/dashboard/payouts", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("payouts", "Payouts"));
    const q = req.query as any;
    return reply.type("text/html").send(renderPayouts(dashData(m, req), { notice: q.notice, error: q.error }));
  });

  app.get("/dashboard/payouts/batches/:id", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("payouts", "Payout batch"));
    const batch = store.getBatch(m.id, (req.params as any).id as string);
    if (!batch) return dashRedirect(reply, "/dashboard/payouts", { merchant: m.id, error: "That batch was not found for this business." });
    const q = req.query as any;
    return reply.type("text/html").send(renderBatchDetail(dashData(m, req), batch, { notice: q.notice, error: q.error }));
  });

  app.get("/dashboard/recipients", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("recipients", "Recipients"));
    const q = req.query as any;
    return reply.type("text/html").send(renderRecipients(dashData(m, req), { notice: q.notice, error: q.error }));
  });

  app.get("/dashboard/invoices", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("invoices", "Invoices"));
    const q = req.query as any;
    return reply.type("text/html").send(renderInvoices(dashData(m, req), { notice: q.notice, error: q.error }));
  });

  app.get("/dashboard/schedules", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("schedules", "Schedules"));
    const q = req.query as any;
    return reply.type("text/html").send(renderSchedules(dashData(m, req), { notice: q.notice, error: q.error }));
  });

  app.get("/dashboard/routing", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("routing", "Routing"));
    // Live mode: the 1Click token list. Mock or offline: the built in map.
    const builtinList = Object.entries(BUILTIN_ASSETS).map(([assetId, a]) => ({
      assetId, symbol: a.symbol, blockchain: a.blockchain, decimals: a.decimals,
    }));
    let tokens = builtinList;
    if (!mockMode) {
      try { tokens = await intents.tokens(); } catch { tokens = builtinList; }
    }
    return reply.type("text/html").send(renderRouting(dashData(m, req), tokens));
  });

  app.get("/dashboard/reconciliation", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("reconciliation", "Reconciliation"));
    return reply.type("text/html").send(renderReconciliation(dashData(m, req)));
  });

  app.get("/dashboard/analytics", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("analytics", "Analytics"));
    return reply.type("text/html").send(renderAnalytics(dashData(m, req)));
  });

  app.get("/dashboard/developers", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("developers", "Developers"));
    return reply.type("text/html").send(renderDevelopers(dashData(m, req)));
  });

  app.get("/dashboard/settings", async (req, reply) => {
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("settings", "Settings"));
    const q = req.query as any;
    return reply.type("text/html").send(renderSettings(dashData(m, req), { notice: q.notice, error: q.error }));
  });

  app.post("/dashboard/actions/settings", async (req, reply) => {
    if (!guardDashAction(req, reply, "settings")) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/settings", { error: "No merchant exists yet." });
    const back = (params: Record<string, string | undefined>) =>
      dashRedirect(reply, "/dashboard/settings", { merchant: m.id, ...params });
    const b = (req.body ?? {}) as any;
    if (!b.name) {
      return back({ error: "Name is required." });
    }
    // Settlement fields fall back to what the merchant already has: a
    // merchant created name only has none, and saving its profile must
    // not demand them. When an asset is supplied it must be a known one.
    const settlementAsset = b.settlementAsset ? String(b.settlementAsset) : m.settlementAsset;
    if (settlementAsset && !(await knownAsset(settlementAsset))) return back({ error: "That settlement asset is not a known asset." });
    store.updateMerchant(m.id, {
      name: String(b.name), settlementAsset,
      settlementAddress: b.settlementAddress ? String(b.settlementAddress) : m.settlementAddress,
      refundTo: b.refundTo ? String(b.refundTo) : m.refundTo,
    });
    return back({ notice: "Business profile saved." });
  });

  app.post("/dashboard/actions/team", async (req, reply) => {
    if (!guardDashAction(req, reply, "team")) return;
    const m = dashMerchant(req);
    if (!m) return reply.type("text/html").send(renderNoMerchant("settings", "Settings"));
    const b = (req.body ?? {}) as any;
    const email = String(b.email ?? "").trim().toLowerCase();
    const role = String(b.role ?? "operator");
    const fail = (msg: string) => reply.type("text/html").send(renderSettings(dashData(m, req), { error: msg }));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a valid email address for the new member.");
    if (!["owner", "admin", "operator", "viewer"].includes(role)) return fail("Choose a valid role.");
    if (store.userCredentialsByEmail(email)) return fail("A dashboard user with that email already exists.");
    // Temporary password: generated here, shown once on this page, never stored in plain text.
    const tempPassword = `Rgl-${newSessionToken().slice(0, 12)}`;
    const { salt, hash } = hashPassword(tempPassword);
    store.createUser({ merchantId: m.id, email, passwordHash: hash, salt, role: role as DashUser["role"] });
    return reply.type("text/html").send(renderSettings(dashData(m, req), {
      notice: `Team member ${email} created with the ${role} role. Temporary password (shown once, hand it over yourself): ${tempPassword}`,
    }));
  });

  app.post("/dashboard/actions/team/:id/role", async (req, reply) => {
    if (!guardDashAction(req, reply, "teamManage")) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/settings", { error: "No merchant exists yet." });
    const back = (params: Record<string, string | undefined>) =>
      dashRedirect(reply, "/dashboard/settings", { merchant: m.id, ...params });
    const target = store.getUser((req.params as any).id);
    if (!target || target.merchantId !== m.id) return back({ error: "Team member not found." });
    const role = String((req.body as any)?.role ?? "");
    if (!["owner", "admin", "operator", "viewer"].includes(role)) return back({ error: "Choose a valid role." });
    store.updateUser(target.id, { role: role as DashUser["role"] });
    return back({ notice: `${target.email} is now ${role}.` });
  });

  app.post("/dashboard/actions/team/:id/deactivate", async (req, reply) => {
    if (!guardDashAction(req, reply, "teamManage")) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/settings", { error: "No merchant exists yet." });
    const back = (params: Record<string, string | undefined>) =>
      dashRedirect(reply, "/dashboard/settings", { merchant: m.id, ...params });
    const target = store.getUser((req.params as any).id);
    if (!target || target.merchantId !== m.id) return back({ error: "Team member not found." });
    if (req.dashUser && target.id === req.dashUser.id) return back({ error: "You cannot deactivate your own account." });
    store.updateUser(target.id, { active: false });
    return back({ notice: `${target.email} deactivated. Their sessions are revoked.` });
  });

  app.post("/dashboard/actions/batches/:id/approve", async (req, reply) => {
    if (!guardDashAction(req, reply, "approve")) return;
    const batch = store.getBatchById((req.params as any).id);
    if (!batch) return dashRedirect(reply, "/dashboard/payouts", { error: "Batch not found." });
    const detailPath = `/dashboard/payouts/batches/${batch.id}`;
    if (batch.status !== "pending_approval") {
      return dashRedirect(reply, detailPath, { merchant: batch.merchantId, error: `Batch is ${batch.status}, not pending approval.` });
    }
    const m = store.getMerchant(batch.merchantId);
    if (!m) return dashRedirect(reply, "/dashboard/payouts", { error: "The merchant for this batch no longer exists." });
    try {
      await approveBatchFor(m, batch);
      return dashRedirect(reply, detailPath, { merchant: batch.merchantId, notice: "Batch approved. Its payouts are quoted and awaiting funding." });
    } catch (err) {
      return dashRedirect(reply, detailPath, { merchant: batch.merchantId, error: `Approval failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.post("/dashboard/actions/payouts/:id/retry", async (req, reply) => {
    if (!guardDashAction(req, reply, "create")) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/payouts", { error: "No merchant exists yet." });
    const failed = store.getPayout(m.id, (req.params as any).id);
    if (!failed) return dashRedirect(reply, "/dashboard/payouts", { merchant: m.id, error: "That payout was not found for this business." });
    const backPath = failed.batchId ? `/dashboard/payouts/batches/${failed.batchId}` : "/dashboard/payouts";
    try {
      const payout = await retryPayoutFor(m, failed);
      return dashRedirect(reply, backPath, { merchant: m.id, notice: `Retry created: payout ${payout.id} is quoted and awaiting funding.` });
    } catch (err) {
      return dashRedirect(reply, backPath, { merchant: m.id, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/dashboard/actions/payouts", async (req, reply) => {
    if (!guardDashAction(req, reply)) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/payouts", { error: "No merchant exists yet." });
    const back = (params: Record<string, string | undefined>) =>
      dashRedirect(reply, "/dashboard/payouts", { merchant: m.id, ...params });
    const b = (req.body ?? {}) as any;
    if (!b.recipientAddress || !b.destinationAsset) return back({ error: "Destination address and asset are required." });
    const destInfo = builtinAsset(String(b.destinationAsset)) ?? guessAsset(String(b.destinationAsset));
    const units = parseDecimalToUnits(String(b.amount ?? ""), destInfo.decimals);
    if (!units) return back({ error: "Amount must be a positive number this asset supports." });
    const row: any = { recipientAddress: String(b.recipientAddress), destinationAsset: String(b.destinationAsset), amount: units };
    if (b.reference && String(b.reference).trim()) row.reference = String(b.reference).trim();
    for (const [field, key] of [["grossAmount", "grossAmount"], ["retentionAmount", "retentionAmount"], ["deductionsAmount", "deductionsAmount"]] as const) {
      const raw = b[field];
      if (raw !== undefined && String(raw).trim() !== "") {
        const parsed = parseDecimalToUnits(String(raw), destInfo.decimals);
        if (parsed === null) return back({ error: "Gross, retention and deductions must be numbers this asset supports." });
        row[key] = parsed;
      }
    }
    const problem = validPayoutRow(row);
    if (problem) return back({ error: problem });
    try {
      const payout = await createPayoutFor(m, row);
      return back({ notice: `Payout ${payout.id} created and awaiting funding.` });
    } catch (err) {
      return back({ error: `Payout failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.post("/dashboard/actions/invoices", async (req, reply) => {
    if (!guardDashAction(req, reply)) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/invoices", { error: "No merchant exists yet." });
    const back = (params: Record<string, string | undefined>) =>
      dashRedirect(reply, "/dashboard/invoices", { merchant: m.id, ...params });
    const b = (req.body ?? {}) as any;
    const originAsset = b.originAsset ? String(b.originAsset) : m.settlementAsset;
    const originInfo = builtinAsset(originAsset) ?? guessAsset(originAsset);
    const units = parseDecimalToUnits(String(b.amount ?? ""), originInfo.decimals);
    if (!units) return back({ error: "Amount must be a positive number this asset supports." });
    try {
      const { invoice } = await createInvoiceFor(m, {
        amount: units, originAsset,
        externalRef: b.externalRef ? String(b.externalRef) : undefined,
      });
      return back({ notice: `Invoice created. Share its payment page: /pay/${invoice.id}` });
    } catch (err) {
      return back({ error: `Invoice creation failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.post("/dashboard/actions/schedules", async (req, reply) => {
    if (!guardDashAction(req, reply)) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/schedules", { error: "No merchant exists yet." });
    const back = (params: Record<string, string | undefined>) =>
      dashRedirect(reply, "/dashboard/schedules", { merchant: m.id, ...params });
    const b = (req.body ?? {}) as any;
    if (!["invoice", "payout_batch"].includes(b.kind)) return back({ error: "Kind must be invoice or payout batch." });
    if (!["weekly", "biweekly", "monthly"].includes(b.cadence)) return back({ error: "Cadence must be weekly, biweekly or monthly." });
    let payload: Record<string, unknown>;
    if (b.kind === "invoice") {
      const originAsset = b.originAsset ? String(b.originAsset) : m.settlementAsset;
      const originInfo = builtinAsset(originAsset) ?? guessAsset(originAsset);
      const units = parseDecimalToUnits(String(b.amount ?? ""), originInfo.decimals);
      if (!units) return back({ error: "Invoice amount must be a positive number this asset supports." });
      payload = { amount: units, originAsset, ...(b.externalRef ? { externalRef: String(b.externalRef) } : {}) };
    } else {
      let rows: any;
      try { rows = JSON.parse(String(b.rowsJson ?? "")); } catch { return back({ error: "Batch rows must be valid JSON." }); }
      const prepared = prepareBatchRows(m, rows);
      if (prepared.error) return back({ error: prepared.error });
      payload = { rows };
    }
    const dayOfMonth = b.dayOfMonth ? Number(b.dayOfMonth) : undefined;
    if (dayOfMonth !== undefined && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28)) {
      return back({ error: "Day of month must be between 1 and 28." });
    }
    const schedule = store.createSchedule({
      merchantId: m.id, kind: b.kind, cadence: b.cadence,
      dayOfMonth: b.cadence === "monthly" ? (dayOfMonth ?? Math.min(new Date().getUTCDate(), 28)) : undefined,
      payload, nextRunAt: firstRunAt(b.cadence, dayOfMonth, new Date()), active: true,
    });
    return back({ notice: `Schedule ${schedule.id} created. First run ${schedule.nextRunAt.slice(0, 10)}.` });
  });

  app.post("/dashboard/actions/schedules/:id/pause", async (req, reply) => {
    if (!guardDashAction(req, reply)) return;
    const m = dashMerchant(req);
    const s = m ? store.getSchedule(m.id, (req.params as any).id) : undefined;
    if (!s) return dashRedirect(reply, "/dashboard/schedules", { error: "Schedule not found." });
    store.updateSchedule(s.id, { active: false });
    return dashRedirect(reply, "/dashboard/schedules", { merchant: m!.id, notice: "Schedule paused." });
  });

  app.post("/dashboard/actions/schedules/:id/resume", async (req, reply) => {
    if (!guardDashAction(req, reply)) return;
    const m = dashMerchant(req);
    const s = m ? store.getSchedule(m.id, (req.params as any).id) : undefined;
    if (!s) return dashRedirect(reply, "/dashboard/schedules", { error: "Schedule not found." });
    const nextRunAt = Date.parse(s.nextRunAt) < Date.now() ? firstRunAt(s.cadence, s.dayOfMonth, new Date()) : s.nextRunAt;
    store.updateSchedule(s.id, { active: true, nextRunAt });
    return dashRedirect(reply, "/dashboard/schedules", { merchant: m!.id, notice: "Schedule resumed." });
  });

  app.post("/dashboard/actions/batches/csv", async (req, reply) => {
    if (!guardDashAction(req, reply)) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/payouts", { error: "No merchant exists yet." });
    const back = (params: Record<string, string | undefined>) =>
      dashRedirect(reply, "/dashboard/payouts", { merchant: m.id, ...params });
    const csv = String((req.body as any)?.csv ?? "");
    const parsed = parseBatchCsv(csv);
    if (parsed.errors.length > 0 || !parsed.rows) {
      const first = parsed.errors[0];
      return back({ error: `CSV is invalid; nothing was created. ${first ? `Line ${first.line}: ${first.message}` : ""}` });
    }
    const resolvedRows: any[] = [];
    for (const row of parsed.rows) {
      const resolved = resolvePayoutRow(m, row);
      if (resolved.error) return back({ error: resolved.error });
      const rec = recipientForRow(m, resolved.row);
      const problem = validPayoutRow(resolved.row, { nuvionBound: isNuvionBound(rec) }) ?? nuvionRowProblem(m, resolved.row, rec);
      if (problem) return back({ error: problem });
      resolvedRows.push(resolved.row);
    }
    const { batch, quoteError } = await createBatchFor(m, resolvedRows);
    if (quoteError) return back({ error: `Quote failed: ${quoteError}` });
    return back({
      notice: batch.status === "pending_approval"
        ? `Batch ${batch.id} uploaded and waiting for approval (${batch.rowCount} rows).`
        : `Batch ${batch.id} uploaded with ${batch.rowCount} payouts quoted.`,
    });
  });

  app.post("/dashboard/actions/recipients", async (req, reply) => {
    if (!guardDashAction(req, reply)) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/recipients", { error: "No merchant exists yet." });
    const back = (params: Record<string, string | undefined>) =>
      dashRedirect(reply, "/dashboard/recipients", { merchant: m.id, ...params });
    const b = (req.body ?? {}) as any;
    if (!b.label) return back({ error: "Label is required." });
    const parsed = await parseRecipientFields(b, false);
    if ("error" in parsed) return back({ error: dashError(parsed.error) });
    let rec = store.createRecipient({
      merchantId: m.id, label: String(b.label),
      notes: b.notes ? String(b.notes) : undefined,
      ...parsed.fields,
    });
    rec = await linkRecipientToNuvion(m, rec);
    return back({ notice: "Recipient saved to the address book." });
  });

  app.post("/dashboard/actions/recipients/:id/update", async (req, reply) => {
    if (!guardDashAction(req, reply)) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/recipients", { error: "No merchant exists yet." });
    const back = (params: Record<string, string | undefined>) =>
      dashRedirect(reply, "/dashboard/recipients", { merchant: m.id, ...params });
    const existing = store.getRecipient(m.id, (req.params as any).id);
    if (!existing) return back({ error: "Recipient not found." });
    const b = (req.body ?? {}) as any;
    const parsed = await parseRecipientFields(b, true, existing);
    if ("error" in parsed) return back({ error: dashError(parsed.error) });
    const patch: Record<string, unknown> = { ...parsed.fields };
    if (b.label !== undefined) patch.label = String(b.label);
    if (b.notes !== undefined) patch.notes = b.notes ? String(b.notes) : undefined;
    let rec = store.updateRecipient(m.id, existing.id, patch as any)!;
    if (recipientLinkNeeded(existing, rec, b)) rec = await linkRecipientToNuvion(m, rec);
    return back({ notice: "Recipient updated." });
  });

  app.post("/dashboard/actions/recipients/:id/delete", async (req, reply) => {
    if (!guardDashAction(req, reply)) return;
    const m = dashMerchant(req);
    if (!m) return dashRedirect(reply, "/dashboard/recipients", { error: "No merchant exists yet." });
    const ok = store.deleteRecipient(m.id, (req.params as any).id);
    return dashRedirect(reply, "/dashboard/recipients", {
      merchant: m.id,
      ...(ok ? { notice: "Recipient deleted." } : { error: "Recipient not found." }),
    });
  });

  // ---- public hosted payment page (no auth: the invoice id is the capability) ----
  app.get("/pay/:invoiceId", async (req, reply) => {
    const inv = store.getInvoiceById((req.params as any).invoiceId);
    if (!inv) return reply.code(404).type("text/html").send(renderPayNotFound());
    const merchant = store.getMerchant(inv.merchantId);
    const [origin, settle] = await Promise.all([
      assetInfo(inv.originAsset ?? inv.settlementAsset),
      assetInfo(inv.settlementAsset),
    ]);
    let qrSvg = "";
    if (inv.depositAddress) {
      try { qrSvg = await QRCode.toString(inv.depositAddress, { type: "svg", margin: 1, width: 220 }); } catch { qrSvg = ""; }
    }
    return reply.type("text/html").send(renderPayPage(inv, merchant?.name ?? "a business", origin, settle, qrSvg));
  });

  app.get("/pay/:invoiceId/status", async (req, reply) => {
    const inv = store.getInvoiceById((req.params as any).invoiceId);
    if (!inv) return reply.code(404).send({ error: "invoice not found" });
    // Public fields only. Never add merchant, key or secret data here.
    return {
      status: inv.status,
      amountIn: inv.amount,
      amountOut: inv.observedAmount ?? inv.amountOut ?? null,
      updatedAt: inv.updatedAt ?? inv.createdAt,
    };
  });

  // ---- inbound Nuvion webhooks (fiat slice 4) ----
  // Remiglo's first inbound webhook. Public by necessity (Nuvion calls
  // it, not a merchant), so authenticity is the HMAC signature when a
  // secret is configured. The handler only verifies and records: it
  // answers 2xx immediately and the sync loop applies the transitions
  // later, because an endpoint that fails delivery three times in 24
  // hours is blacklisted by Nuvion and there is no replay. The route
  // lives in an encapsulated scope whose JSON parser keeps the raw
  // body string, which the signature check needs byte for byte.
  app.register(async (instance) => {
    instance.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      done(null, body as string);
    });
    instance.post("/webhooks/nuvion", async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      if (cfg.nuvionWebhookSecret) {
        const provided = String(req.headers[cfg.nuvionWebhookSignatureHeader.toLowerCase()] ?? "")
          .replace(/^sha256=/, "").trim().toLowerCase();
        const expected = createHmac("sha256", cfg.nuvionWebhookSecret).update(raw).digest("hex");
        const ok = provided.length === expected.length
          && timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        if (!ok) return reply.code(401).send({ error: "invalid webhook signature" });
      } else {
        console.log("nuvion webhook accepted without signature verification (NUVION_WEBHOOK_SECRET is not configured)");
      }
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: "webhook body is not valid JSON" });
      }
      // Assumed payload shape (the docs confirm the event names and the
      // HMAC scheme, not the envelope): { id, type, data: <transfer> },
      // with the event name under type (or event) and the transfer
      // object under data, so the transfer id is data.id. The fallbacks
      // keep a differently nested delivery findable.
      const data = (payload?.data ?? payload) as any;
      const transferId = data?.id ?? data?.transfer_id ?? payload?.transfer_id ?? data?.transfer?.id;
      store.recordNuvionEvent({
        providerEventId: payload?.id ?? payload?.event_id,
        eventType: String(payload?.type ?? payload?.event ?? "unknown"),
        transferId: transferId !== undefined ? String(transferId) : undefined,
        payload: raw,
      });
      return reply.code(200).send({ received: true });
    });
  });

  // ---- merchants ----
  // Nuvion linking (fiat slice 2): create the merchant's child entity
  // (business kind) and store the link. Best effort by design, like
  // registry anchoring: a Nuvion failure never blocks or fails merchant
  // creation. The merchant is left with the "unlinked" status marker,
  // and both outcomes land in the ledger.
  const linkMerchantToNuvion = async (merchant: Merchant): Promise<Merchant> => {
    if (!nuvionClient) return merchant;
    try {
      const entity = await nuvionClient.createEntity({ name: merchant.name }, "business");
      const linked = store.updateMerchantNuvion(merchant.id, {
        nuvionEntityId: entity.id, nuvionEntityStatus: entity.status,
      });
      store.addLedger({
        merchantId: merchant.id, entityType: "merchant", entityId: merchant.id,
        kind: "nuvion_entity_linked", amount: "0", asset: "",
      });
      return linked ?? merchant;
    } catch (err) {
      store.updateMerchantNuvion(merchant.id, { nuvionEntityStatus: "unlinked" });
      store.addLedger({
        merchantId: merchant.id, entityType: "merchant", entityId: merchant.id,
        kind: "nuvion_link_failed", amount: "0", asset: "",
      });
      console.error(`nuvion link failed for merchant ${merchant.id}:`, err instanceof Error ? err.message : err);
      return store.getMerchant(merchant.id) ?? merchant;
    }
  };

  app.post("/v1/merchants", async (req, reply) => {
    if (cfg.adminToken && !hasAdmin(req)) {
      return reply.code(401).send({ error: "merchant creation requires the admin token" });
    }
    const b = req.body as any;
    if (!b?.name) {
      return reply.code(400).send({ error: "name is required" });
    }
    // Settlement fields are optional since the sign up rebuild: they
    // belong to the retired invoice rail, and a merchant created with
    // a name alone settles through Nuvion. When a settlement asset IS
    // given it must be a known asset, the same check the dashboard
    // settings path has always applied.
    if (b.settlementAsset && !(await knownAsset(String(b.settlementAsset)))) {
      return reply.code(400).send({ error: "That settlement asset is not a known asset." });
    }
    const created = store.createMerchant({
      name: String(b.name),
      settlementAsset: b.settlementAsset ? String(b.settlementAsset) : undefined,
      settlementAddress: b.settlementAddress ? String(b.settlementAddress) : undefined,
      refundTo: b.refundTo ? String(b.refundTo) : undefined,
      legalName: b.legalName ? String(b.legalName) : undefined,
      registrationNumber: b.registrationNumber ? String(b.registrationNumber) : undefined,
      country: b.country ? String(b.country) : undefined,
    });
    const merchant = await linkMerchantToNuvion(created.merchant);
    return reply.code(201).send({ merchant, apiKey: created.apiKey, note: "Store this API key now. It is shown once and only its hash is kept." });
  });

  // Everything below /v1 (except internal sync, which has its own rule) needs a merchant key.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/v1/")) return;
    // Only merchant creation itself is exempt; other POSTs under
    // /v1/merchants (the Nuvion refresh) go through merchant auth.
    if (req.method === "POST" && (req.url === "/v1/merchants" || req.url.startsWith("/v1/merchants?"))) return;
    if (req.url.startsWith("/v1/internal/")) return;
    await requireMerchant(req, reply);
  });

  app.get("/v1/merchants/me", async (req) => ({ merchant: req.merchant }));

  // Nuvion status refresh (fiat slice 2): read the entity back, mirror
  // its status, and when it is approved open one account per enabled
  // currency that does not have one yet. Scoped like every other /v1
  // route: the caller's own id only, anything else is a 404.
  app.post("/v1/merchants/:id/nuvion/refresh", async (req, reply) => {
    const m = req.merchant!;
    if (m.id !== (req.params as any).id) return reply.code(404).send({ error: "merchant not found" });
    if (!nuvionClient) return reply.code(409).send({ error: "Nuvion is not configured on this instance" });
    if (!m.nuvionEntityId) return reply.code(409).send({ error: "merchant is not linked to a Nuvion entity" });
    let entity;
    try {
      entity = await nuvionClient.getEntity(m.nuvionEntityId);
    } catch (err) {
      return reply.code(502).send({ error: `Nuvion entity read failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    let merchant = store.updateMerchantNuvion(m.id, { nuvionEntityStatus: entity.status }) ?? m;
    if (entity.status === "approved") {
      const accounts = { ...(merchant.nuvionAccounts ?? {}) };
      let changed = false;
      for (const currency of cfg.nuvionCurrencies) {
        if (accounts[currency]) continue;
        try {
          const account = await nuvionClient.createAccount({ entity_id: m.nuvionEntityId, currency });
          accounts[currency] = account.id;
          changed = true;
        } catch (err) {
          // A failed account never fails the refresh; the currency
          // stays absent so a later refresh retries it.
          store.addLedger({
            merchantId: m.id, entityType: "merchant", entityId: m.id,
            kind: "nuvion_account_failed", amount: "0", asset: currency,
          });
          console.error(`nuvion account creation failed for merchant ${m.id} (${currency}):`, err instanceof Error ? err.message : err);
        }
      }
      if (changed) merchant = store.updateMerchantNuvion(m.id, { nuvionAccounts: accounts }) ?? merchant;
    }
    return {
      merchant,
      nuvion: {
        entityId: merchant.nuvionEntityId ?? null,
        status: merchant.nuvionEntityStatus ?? null,
        accounts: merchant.nuvionAccounts ?? {},
      },
    };
  });

  app.get("/v1/tokens", async () => intents.tokens());

  // ---- invoices ----
  /** An invoice request refused before any quote: the merchant has no settlement asset for the legacy rail. The API maps it to a 400. */
  class InvoiceUnavailable extends Error {}

  /** The one invoice creation path: quote, store, ledger. API and dashboard both call this. */
  const createInvoiceFor = async (m: Merchant, fields: {
    amount: string; externalRef?: string; currency?: string;
    originAsset?: string; settlementAsset?: string; settlementAddress?: string; refundTo?: string;
    idempotencyKey?: string;
  }) => {
    const settlementAsset = fields.settlementAsset ?? m.settlementAsset;
    // Invoices settle on the retired NEAR Intents rail and cannot
    // exist without a settlement asset. A merchant created name only
    // (the Nuvion sign up) has none: refuse clearly here, in the one
    // creation path, instead of quoting against an empty asset.
    if (!settlementAsset) {
      throw new InvoiceUnavailable("This merchant has no settlement asset configured, so invoices are unavailable. Invoices settle on the legacy NEAR Intents rail, which requires a settlement asset; Nuvion payouts are unaffected.");
    }
    const settlementAddress = fields.settlementAddress ?? m.settlementAddress;
    const refundTo = fields.refundTo ?? m.refundTo;
    const originAsset = fields.originAsset ?? settlementAsset;
    const quote = await intents.quote({
      dry: false, originAsset, destinationAsset: settlementAsset, amount: fields.amount,
      recipient: settlementAddress, refundTo,
      appFeeBps: cfg.appFeeBps, appFeeRecipient: cfg.appFeeRecipient,
    });
    const invoice = store.createInvoice({
      id: makeId("inv"), merchantId: m.id, externalRef: fields.externalRef, amount: fields.amount,
      currency: fields.currency ?? "USD", originAsset, settlementAsset, settlementAddress, refundTo,
      status: "open", depositAddress: quote.quote.depositAddress, amountOut: quote.quote.amountOut,
      expiresAt: quote.quote.deadline, idempotencyKey: fields.idempotencyKey,
      createdAt: new Date().toISOString(),
    });
    store.addLedger({ merchantId: m.id, entityType: "invoice", entityId: invoice.id, kind: "invoice_created", amount: invoice.amount, asset: settlementAsset });
    return { invoice, quote: quote.quote };
  };

  app.post("/v1/invoices", async (req, reply) => {
    const m = req.merchant!;
    const b = req.body as any;
    const idem = req.headers["idempotency-key"] as string | undefined;
    if (idem) {
      const existing = store.invoiceByIdempotency(m.id, idem);
      if (existing) return reply.code(200).send(withPaymentUrl(existing));
    }
    const amount = b?.amount !== undefined ? String(b.amount) : undefined;
    if (!amount || !isAmountString(amount)) return reply.code(400).send({ error: "amount must be a positive integer string in smallest units" });
    try {
      const { invoice, quote } = await createInvoiceFor(m, {
        amount, externalRef: b.externalRef, currency: b.currency,
        originAsset: b.originAsset, settlementAsset: b.settlementAsset,
        settlementAddress: b.settlementAddress, refundTo: b.refundTo, idempotencyKey: idem,
      });
      return reply.code(201).send({
        ...withPaymentUrl(invoice),
        payment: {
          depositAddress: quote.depositAddress,
          amountIn: quote.amountIn,
          amountOut: quote.amountOut,
          deadline: quote.deadline,
          qrPayload: quote.depositAddress,
        },
      });
    } catch (err) {
      if (err instanceof InvoiceUnavailable) return reply.code(400).send({ error: err.message });
      return reply.code(502).send({ error: `quote failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get("/v1/invoices", async (req) => store.listInvoices(req.merchant!.id).map(withPaymentUrl));

  app.get("/v1/invoices/:id", async (req, reply) => {
    const inv = store.getInvoice(req.merchant!.id, (req.params as any).id);
    if (!inv) return reply.code(404).send({ error: "invoice not found" });
    return withPaymentUrl(inv);
  });

  app.post("/v1/invoices/:id/cancel", async (req, reply) => {
    const m = req.merchant!;
    const inv = store.getInvoice(m.id, (req.params as any).id);
    if (!inv) return reply.code(404).send({ error: "invoice not found" });
    if (!["open", "deposit_seen"].includes(inv.status)) return reply.code(409).send({ error: `cannot cancel an invoice in status ${inv.status}` });
    const updated = store.updateInvoice(inv.id, { status: "cancelled" })!;
    store.addLedger({ merchantId: m.id, entityType: "invoice", entityId: inv.id, kind: "invoice_cancelled", amount: inv.amount, asset: inv.settlementAsset });
    return updated;
  });

  // ---- recipients (address book) ----
  /** An asset is known when the built in map or the 1Click token list carries it. */
  const knownAsset = async (assetId: string): Promise<boolean> => {
    if (builtinAsset(assetId)) return true;
    try {
      const tokens = await intents.tokens();
      return tokens.some((t) => t.assetId === assetId);
    } catch {
      return false;
    }
  };
  const chainOf = (assetId: string) => (builtinAsset(assetId) ?? guessAsset(assetId)).blockchain;

  // Recipient kinds (fiat slice 3): bank accounts and mobile money
  // wallets join the original stablecoin wallet shape. A wallet network,
  // when recorded, must be one Nuvion can pay on; anything else is
  // refused here, at creation, not later at payout time.
  const RECIPIENT_KINDS: RecipientKind[] = ["bank", "momo", "wallet"];
  const NUVION_NETWORKS = ["ETH_MAINNET", "BASE_MAINNET", "MATIC_MAINNET", "SOLANA_MAINNET"];
  /** Body keys that decide how a recipient gets paid (provider aliases momoProvider). */
  const RECIPIENT_PAYMENT_KEYS = ["kind", "address", "assetId", "bankName", "accountNumber", "accountName",
    "country", "currency", "momoProvider", "provider", "phoneNumber", "network"];
  /** Recipient fields that decide how they get paid; changing any re links the Nuvion counterparty. */
  const RECIPIENT_PAYMENT_FIELDS = ["kind", "address", "assetId", "bankName", "accountNumber", "accountName",
    "country", "currency", "momoProvider", "phoneNumber", "network"] as const;

  interface RecipientFieldSet {
    kind: RecipientKind;
    address: string;
    assetId: string;
    chain: string;
    bankName?: string;
    accountNumber?: string;
    accountName?: string;
    country?: string;
    currency?: string;
    momoProvider?: string;
    phoneNumber?: string;
    network?: string;
  }

  /**
   * Validate a recipient body and normalise it into store ready fields.
   * With partial set, the body is merged over the existing recipient
   * first, so a kind switch is checked against the full result. The
   * wallet shape (address plus a known asset) is the original creation
   * shape and keeps its original rules. Bank and mobile money carry
   * their rail fields instead; the account number or phone number also
   * fills the address column, since that is where the money goes and
   * the column payout resolution reads.
   */
  const parseRecipientFields = async (
    b: any, partial: boolean, existing?: Recipient,
  ): Promise<{ fields: RecipientFieldSet } | { error: string }> => {
    const eff: Record<string, string> = {};
    const take = (key: string, current?: string, ...aliases: string[]) => {
      let v: string | undefined;
      for (const k of [key, ...aliases]) {
        if (b?.[k] !== undefined) { v = b[k] === null ? "" : String(b[k]).trim(); break; }
      }
      eff[key] = v !== undefined ? v : (current ?? "");
    };
    take("kind", existing?.kind);
    take("address", existing?.address);
    take("assetId", existing?.assetId);
    take("bankName", existing?.bankName);
    take("accountNumber", existing?.accountNumber);
    take("accountName", existing?.accountName);
    take("country", existing?.country);
    take("currency", existing?.currency);
    take("momoProvider", existing?.momoProvider, "provider");
    take("phoneNumber", existing?.phoneNumber);
    take("network", existing?.network);

    const kind = (eff.kind || "wallet") as RecipientKind;
    if (b?.kind !== undefined && !RECIPIENT_KINDS.includes(kind)) {
      return { error: "kind must be one of bank, momo, wallet" };
    }
    if (eff.network) {
      if (eff.network === "POLYGON_MAINNET") {
        return { error: "POLYGON_MAINNET is not a Nuvion network name; Polygon is MATIC_MAINNET" };
      }
      if (!NUVION_NETWORKS.includes(eff.network)) {
        return { error: `network ${eff.network} is not supported; supported networks are ${NUVION_NETWORKS.join(", ")}` };
      }
    }
    const kindChanged = partial && b?.kind !== undefined && !!existing && kind !== existing.kind;
    if (kind === "wallet") {
      if (!partial || b?.address !== undefined || kindChanged) {
        if (!eff.address) return { error: "address is required" };
      }
      if (!partial || b?.assetId !== undefined || kindChanged) {
        if (!eff.assetId) return { error: "assetId is required" };
        if (!(await knownAsset(eff.assetId))) return { error: "assetId is not a known asset" };
      }
      return {
        fields: {
          kind, address: eff.address, assetId: eff.assetId, chain: chainOf(eff.assetId),
          network: eff.network || undefined,
        },
      };
    }
    if (kind === "bank") {
      for (const f of ["bankName", "accountNumber", "accountName", "country", "currency"] as const) {
        if (!eff[f]) return { error: `${f} is required for a bank recipient` };
      }
      return {
        fields: {
          kind, address: eff.accountNumber, assetId: "", chain: "",
          bankName: eff.bankName, accountNumber: eff.accountNumber, accountName: eff.accountName,
          country: eff.country, currency: eff.currency,
        },
      };
    }
    for (const f of ["momoProvider", "phoneNumber", "country", "currency"] as const) {
      if (!eff[f]) return { error: `${f} is required for a momo recipient` };
    }
    return {
      fields: {
        kind, address: eff.phoneNumber, assetId: "", chain: "",
        momoProvider: eff.momoProvider, phoneNumber: eff.phoneNumber,
        country: eff.country, currency: eff.currency,
      },
    };
  };

  /**
   * The Nuvion payment detail body for a recipient. The docs describe
   * these shapes only in outline (method plus rail fields), so the flat
   * field layout is a deliberate first reading, kept in this one place.
   */
  const nuvionPaymentDetailBody = (rec: Recipient, counterpartyId: string): CreatePaymentDetailRequest => {
    if (rec.kind === "bank") {
      return {
        counterparty_id: counterpartyId, payment_method: "bank-transfer",
        ...(rec.currency === "NGN" ? { scheme: "nip" } : {}),
        currency: rec.currency, country: rec.country,
        bank_name: rec.bankName, account_number: rec.accountNumber, account_name: rec.accountName,
      };
    }
    if (rec.kind === "momo") {
      return {
        counterparty_id: counterpartyId, payment_method: "momo-transfer",
        currency: rec.currency, country: rec.country,
        provider: rec.momoProvider, phone_number: rec.phoneNumber,
      };
    }
    return {
      counterparty_id: counterpartyId, payment_method: "stablecoin-transfer",
      wallet_address: rec.address, ...(rec.network ? { network: rec.network } : {}),
    };
  };

  // Nuvion counterparty linking (fiat slice 3): create the recipient's
  // counterparty and payment detail on the merchant's child entity and
  // store both ids. Best effort by design, like merchant linking: a
  // Nuvion failure never blocks recipient creation or update, the ids
  // stay null, and both outcomes land in the ledger.
  const linkRecipientToNuvion = async (merchant: Merchant, rec: Recipient): Promise<Recipient> => {
    if (!nuvionClient || !merchant.nuvionEntityId) return rec;
    try {
      const counterparty = await nuvionClient.createCounterparty({
        entity_id: merchant.nuvionEntityId,
        name: rec.label || rec.accountName || rec.address,
      });
      const detail = await nuvionClient.createPaymentDetails(nuvionPaymentDetailBody(rec, counterparty.id));
      const linked = store.updateRecipient(rec.merchantId, rec.id, {
        nuvionCounterpartyId: counterparty.id, nuvionPaymentDetailId: detail.id,
      });
      store.addLedger({
        merchantId: merchant.id, entityType: "recipient", entityId: rec.id,
        kind: "nuvion_counterparty_linked", amount: "0", asset: "",
      });
      return linked ?? rec;
    } catch (err) {
      store.addLedger({
        merchantId: merchant.id, entityType: "recipient", entityId: rec.id,
        kind: "nuvion_counterparty_link_failed", amount: "0", asset: "",
      });
      console.error(`nuvion counterparty link failed for recipient ${rec.id}:`, err instanceof Error ? err.message : err);
      return rec;
    }
  };

  /** True when an update changed how the recipient gets paid, or touched payment fields on a recipient that was never linked. */
  const recipientLinkNeeded = (before: Recipient, after: Recipient, b: any): boolean => {
    if (RECIPIENT_PAYMENT_FIELDS.some((k) => before[k] !== after[k])) return true;
    return RECIPIENT_PAYMENT_KEYS.some((k) => b?.[k] !== undefined) && !after.nuvionCounterpartyId;
  };

  app.post("/v1/recipients", async (req, reply) => {
    const m = req.merchant!;
    const b = req.body as any;
    const parsed = await parseRecipientFields(b, false);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    let rec = store.createRecipient({
      merchantId: m.id, label: String(b.label ?? ""),
      notes: b.notes ? String(b.notes) : undefined,
      ...parsed.fields,
    });
    rec = await linkRecipientToNuvion(m, rec);
    return reply.code(201).send(rec);
  });

  app.get("/v1/recipients", async (req) => store.listRecipients(req.merchant!.id));

  app.get("/v1/recipients/:id", async (req, reply) => {
    const rec = store.getRecipient(req.merchant!.id, (req.params as any).id);
    if (!rec) return reply.code(404).send({ error: "recipient not found" });
    return rec;
  });

  app.patch("/v1/recipients/:id", async (req, reply) => {
    const m = req.merchant!;
    const existing = store.getRecipient(m.id, (req.params as any).id);
    if (!existing) return reply.code(404).send({ error: "recipient not found" });
    const b = (req.body ?? {}) as any;
    const parsed = await parseRecipientFields(b, true, existing);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const patch: Record<string, unknown> = { ...parsed.fields };
    if (b.label !== undefined) patch.label = String(b.label);
    if (b.notes !== undefined) patch.notes = b.notes === null ? undefined : String(b.notes);
    let rec = store.updateRecipient(m.id, existing.id, patch as any)!;
    if (recipientLinkNeeded(existing, rec, b)) rec = await linkRecipientToNuvion(m, rec);
    return rec;
  });

  app.delete("/v1/recipients/:id", async (req, reply) => {
    const ok = store.deleteRecipient(req.merchant!.id, (req.params as any).id);
    if (!ok) return reply.code(404).send({ error: "recipient not found" });
    return { deleted: true };
  });

  /**
   * Resolve a payout row that references a saved recipient. The resolved
   * row carries the recipient's address and asset, so stored batch rows
   * stay valid even if the recipient is later edited or deleted. A bank
   * or mobile money recipient has no asset id; what the row pays in is
   * the recipient's currency, so that becomes its destination asset.
   */
  const resolvePayoutRow = (m: Merchant, row: any): { row?: any; error?: string } => {
    if (!row?.recipientId) return { row };
    const rec = store.getRecipient(m.id, String(row.recipientId));
    if (!rec) return { error: `recipient ${String(row.recipientId)} not found` };
    const destinationAsset = rec.kind === "wallet" ? rec.assetId : (rec.currency ?? rec.assetId);
    return { row: { ...row, recipientAddress: rec.address, destinationAsset } };
  };

  /** The saved recipient a row came from, when it carries a recipientId. */
  const recipientForRow = (m: Merchant, row: any): Recipient | undefined => {
    if (!row?.recipientId) return undefined;
    return store.getRecipient(m.id, String(row.recipientId));
  };

  /** Nuvion's currency code for each stablecoin symbol it carries. */
  const NUVION_STABLECOIN_CODES: Record<string, string> = { USDC: "USC", USDT: "UST", RLUSD: "RLD" };

  /**
   * The Nuvion currency code for a destination asset, sourced from the
   * asset metadata the codebase already carries: the symbol recorded
   * for the asset in BUILTIN_ASSETS, mapped to Nuvion's code for that
   * symbol. Undefined when the asset is not a stablecoin Nuvion
   * carries, or carries no recorded symbol.
   */
  const nuvionCodeForAsset = (assetId?: string): string | undefined => {
    if (!assetId) return undefined;
    const symbol = builtinAsset(assetId)?.symbol;
    return symbol ? NUVION_STABLECOIN_CODES[symbol] : undefined;
  };

  /** A wallet recipient carrying one of the supported networks was created for the Nuvion rail (fiat slice 5). */
  const isNuvionWallet = (rec?: Recipient): boolean => !!rec && rec.kind === "wallet" && !!rec.network;

  /**
   * A row is Nuvion bound when it resolves to a bank or mobile money
   * recipient (fiat slice 4), or to a wallet recipient carrying a
   * Nuvion network (fiat slice 5). A wallet recipient with no network
   * recorded, and any raw address row, are legacy Intents rows.
   */
  const isNuvionBound = (rec?: Recipient): boolean =>
    !!rec && (rec.kind === "bank" || rec.kind === "momo" || isNuvionWallet(rec));

  /**
   * Creation time refusals for a Nuvion bound row. Such a row can only
   * ever execute through Nuvion, so when the rail is unavailable (no
   * client configured, merchant not linked) or the amount cannot cross
   * the 2 decimal boundary exactly, the row is refused here, before
   * anything is created, with the reason stated plainly.
   */
  const nuvionRowProblem = (m: Merchant, row: any, rec?: Recipient): string | undefined => {
    if (!isNuvionBound(rec)) return undefined;
    if (isNuvionWallet(rec)) {
      // What a network carrying wallet can be paid in is a property of
      // the row itself, so those refusals come before the rail's
      // availability: the recipient was created for the Nuvion rail,
      // and no other rail may pick the row up instead.
      const code = nuvionCodeForAsset(row?.destinationAsset ?? rec!.assetId);
      if (!code) return "this wallet recipient is set up for a Nuvion stablecoin transfer, but the destination asset is not a stablecoin Nuvion carries (USDC, USDT or RLUSD)";
      if (code === "RLD" && rec!.network !== "ETH_MAINNET") {
        return "RLUSD is only available on Ethereum through Nuvion, and this recipient's network is not ETH_MAINNET";
      }
      if (!nuvionClient) return "this recipient is paid by stablecoin transfer, but Nuvion is not configured on this instance";
      if (!m.nuvionEntityId) return "this recipient is paid by stablecoin transfer, but the merchant is not linked to a Nuvion entity";
      try {
        chainUnitsToNuvionUnits(String(row.amount ?? ""));
      } catch {
        return "a stablecoin payout amount must be exact to the cent (two decimal places)";
      }
      return undefined;
    }
    if (!nuvionClient) return "this recipient is paid in fiat, but Nuvion is not configured on this instance";
    if (!m.nuvionEntityId) return "this recipient is paid in fiat, but the merchant is not linked to a Nuvion entity";
    if (!rec!.currency) return "the recipient has no payout currency recorded";
    try {
      chainUnitsToNuvionUnits(String(row.amount ?? ""));
    } catch {
      return "a fiat payout amount must be exact to the cent (two decimal places)";
    }
    return undefined;
  };

  // ---- payouts ----
  /**
   * Execute one Nuvion bound payout (fiat slice 4, Flow A; stablecoin
   * rows joined in slice 5, Flow B). Mirrors the Intents quote step's
   * place in the flow: the external call happens first and the payout
   * record is created only once the transfer exists, so an execution
   * failure leaves no record, exactly like a quote failure. Any throw
   * is the execution failure the batch semantics in createBatchFor and
   * approveBatchFor already handle.
   *
   * The payout currency is the denomination the Nuvion transfer moves
   * in: the recipient's currency for bank and mobile money rows, and
   * the destination asset's Nuvion stablecoin code (USC, UST or RLD)
   * for wallet rows. The payout record keeps the row's destination
   * asset, which for a stablecoin row is the asset id itself.
   */
  const executeNuvionPayoutFor = async (
    m: Merchant, row: any, rec: Recipient,
    opts: { batchId?: string; idem?: string; retryOf?: string; originAsset: string; breakdown: Record<string, string | undefined> },
  ) => {
    const stable = rec.kind === "wallet";
    if (!nuvionClient) throw new Error(stable
      ? "this recipient is paid by stablecoin transfer, but Nuvion is not configured on this instance"
      : "this recipient is paid in fiat, but Nuvion is not configured on this instance");
    if (!m.nuvionEntityId) throw new Error(stable
      ? "this recipient is paid by stablecoin transfer, but the merchant is not linked to a Nuvion entity"
      : "this recipient is paid in fiat, but the merchant is not linked to a Nuvion entity");
    // Backstops for the creation time refusals in nuvionRowProblem,
    // for paths that reach execution directly (schedule runs, retries).
    let payoutCurrency: string | undefined;
    if (stable) {
      payoutCurrency = nuvionCodeForAsset(row.destinationAsset ?? rec.assetId);
      if (!payoutCurrency) throw new Error("the destination asset is not a stablecoin Nuvion carries (USDC, USDT or RLUSD)");
      if (payoutCurrency === "RLD" && rec.network !== "ETH_MAINNET") {
        throw new Error("RLUSD is only available on Ethereum through Nuvion, and this recipient's network is not ETH_MAINNET");
      }
    } else {
      payoutCurrency = rec.currency;
      if (!payoutCurrency) throw new Error("the recipient has no payout currency recorded");
    }
    // Throws when the amount is not exact to the cent; creation routes
    // refuse such rows up front, so this is the backstop for paths that
    // reach execution directly (schedule runs, retries).
    const fiatAmount = chainUnitsToNuvionUnits(String(row.amount));

    // (a) The recipient's counterparty and payment detail must exist.
    // Slice 3 creates them at recipient creation; a recipient that
    // predates the link, or whose link failed, is linked now.
    let linked = rec;
    if (!linked.nuvionCounterpartyId || !linked.nuvionPaymentDetailId) {
      linked = await linkRecipientToNuvion(m, linked);
    }
    if (!linked.nuvionCounterpartyId || !linked.nuvionPaymentDetailId) {
      throw new Error("the recipient could not be linked to a Nuvion counterparty");
    }

    // (b) Funding account: the merchant's account in the payout
    // currency when one exists (no conversion, no quote) — for a
    // stablecoin row that is the account in the row's stablecoin code.
    // Otherwise the USD account, or the first account held, with an FX
    // quote locked at execution time for the exact payout amount.
    const accounts = m.nuvionAccounts ?? {};
    let accountId = accounts[payoutCurrency];
    let fxQuoteId: string | undefined;
    if (!accountId) {
      const fallbackCurrency = accounts.USD ? "USD" : Object.keys(accounts)[0];
      if (!fallbackCurrency) throw new Error("the merchant has no Nuvion account to fund this payout");
      accountId = accounts[fallbackCurrency];
      const quote = await nuvionClient.createFxQuote({
        from_currency: fallbackCurrency, to_currency: payoutCurrency,
        amount_to: Number(fiatAmount), entity_id: m.nuvionEntityId,
      });
      fxQuoteId = quote.id;
    }

    // (c) The transfer. The payout id is minted first because it is
    // the unique_reference: unique per entity forever, so a retry
    // (a new payout with a new id) always carries a fresh reference.
    const payoutId = makeId("pay");
    const reference = row.reference ? String(row.reference).trim() : undefined;
    const transfer = await nuvionClient.createTransfer({
      account_id: accountId,
      payment_detail_id: linked.nuvionPaymentDetailId,
      counterparty_id: linked.nuvionCounterpartyId,
      currency: payoutCurrency,
      amount: Number(fiatAmount),
      type: rec.kind === "bank" ? "bank-transfer" : rec.kind === "momo" ? "momo-transfer" : "stablecoin-transfer",
      narration: reference ?? "",
      unique_reference: payoutId,
      ...(fxQuoteId ? { fx_quote_id: fxQuoteId } : {}),
      entity_id: m.nuvionEntityId,
      meta: { payout_id: payoutId },
    });
    const payout = store.createPayout({
      id: payoutId, merchantId: m.id, batchId: opts.batchId, recipientAddress: row.recipientAddress,
      destinationAsset: stable ? (row.destinationAsset ?? rec.assetId) : payoutCurrency, originAsset: opts.originAsset,
      refundTo: row.refundTo ?? m.refundTo, amount: String(row.amount), status: "awaiting_funding",
      idempotencyKey: opts.batchId ? undefined : opts.idem, retryOfId: opts.retryOf,
      recipientId: rec.id, providerRef: transfer.id, fiatCurrency: payoutCurrency, fiatAmount,
      fxQuoteId,
      reference, ...opts.breakdown,
      createdAt: new Date().toISOString(),
    });
    store.addLedger({ merchantId: m.id, entityType: "payout", entityId: payout.id, kind: "payout_created", amount: payout.amount, asset: payout.destinationAsset });
    // The initial status lands through the one transition path, so the
    // payout.sent webhook and the transition ledger entry are written
    // exactly as the poller writes them for later transitions.
    applyPayoutTransition(store, payout, mapNuvionPayoutStatus(transfer.status));
    return store.getPayout(m.id, payout.id) ?? payout;
  };

  const createPayoutFor = async (m: Merchant, row: any, batchId?: string, idem?: string, retryOf?: string) => {
    const amount = String(row.amount);
    // The merchant funds a payout from the asset they settle in, unless the
    // row names its own origin. Defaulting to the destination asset made
    // same asset payouts unquotable on backends that refuse them.
    const originAsset = row.originAsset ?? m.settlementAsset;
    const hasGross = row.grossAmount !== undefined && row.grossAmount !== null && row.grossAmount !== "";
    const breakdown = {
      grossAmount: hasGross ? String(row.grossAmount) : undefined,
      retentionAmount: hasGross ? String(row.retentionAmount ?? "0") || "0" : undefined,
      deductionsAmount: hasGross ? String(row.deductionsAmount ?? "0") || "0" : undefined,
    };
    // Nuvion bound rows (bank and mobile money recipients, and wallet
    // recipients carrying a Nuvion network) execute through Nuvion
    // and never touch the Intents quote path.
    const rec = recipientForRow(m, row);
    if (isNuvionBound(rec)) {
      return executeNuvionPayoutFor(m, row, rec!, { batchId, idem, retryOf, originAsset, breakdown });
    }
    const q = await intents.quote({
      dry: false, originAsset, destinationAsset: row.destinationAsset,
      amount, recipient: row.recipientAddress, refundTo: row.refundTo ?? m.refundTo,
      appFeeBps: cfg.appFeeBps, appFeeRecipient: cfg.appFeeRecipient,
    });
    const payout = store.createPayout({
      id: makeId("pay"), merchantId: m.id, batchId, recipientAddress: row.recipientAddress,
      destinationAsset: row.destinationAsset, originAsset,
      refundTo: row.refundTo ?? m.refundTo, amount, status: "awaiting_funding",
      depositAddress: q.quote.depositAddress, amountOut: q.quote.amountOut,
      idempotencyKey: batchId ? undefined : idem, retryOfId: retryOf, createdAt: new Date().toISOString(),
      reference: row.reference ? String(row.reference).trim() : undefined,
      recipientId: row.recipientId ? String(row.recipientId) : undefined,
      ...breakdown,
    });
    store.addLedger({ merchantId: m.id, entityType: "payout", entityId: payout.id, kind: "payout_quoted", amount, asset: row.destinationAsset });
    return payout;
  };

  /** A retry the product refuses, with the HTTP status the API should answer. */
  class RetryRefused extends Error {
    constructor(message: string, readonly httpStatus = 409) { super(message); }
  }

  /**
   * The one payout retry path. Only a failed payout can be retried. The
   * retry is a fresh quote and a new payout linked to the failed one,
   * in the same batch when there is one; the failed row stays in the
   * record and settled rows are never touched. A second retry is
   * refused while one is in flight or has already settled, so a row
   * can never be paid twice by retrying.
   */
  const retryPayoutFor = async (m: Merchant, failed: Payout) => {
    if (failed.status !== "failed") {
      throw new RetryRefused(`only a failed payout can be retried; this payout is ${failed.status}`);
    }
    const retries = store.listRetriesOf(failed.id);
    if (retries.some((r) => r.status === "settled")) {
      throw new RetryRefused("this payout was already retried and the retry settled");
    }
    if (retries.some((r) => !PAYOUT_TERMINAL.includes(r.status))) {
      throw new RetryRefused("a retry of this payout is already in progress");
    }
    const payout = await createPayoutFor(m, {
      recipientAddress: failed.recipientAddress, destinationAsset: failed.destinationAsset,
      originAsset: failed.originAsset, refundTo: failed.refundTo, amount: failed.amount,
      reference: failed.reference, grossAmount: failed.grossAmount,
      retentionAmount: failed.retentionAmount, deductionsAmount: failed.deductionsAmount,
      // A Nuvion bound row retries through Nuvion: carrying the
      // recipient id is what routes the fresh payout back to the rail,
      // under its own new id and therefore a fresh unique_reference.
      ...(failed.recipientId ? { recipientId: failed.recipientId } : {}),
    }, failed.batchId, undefined, failed.id);
    if (failed.batchId) {
      store.addLedger({ merchantId: m.id, entityType: "batch", entityId: failed.batchId, kind: "row_retried", amount: failed.amount, asset: failed.destinationAsset });
      const batch = store.getBatchById(failed.batchId);
      if (batch && batch.status === "completed") store.updateBatch(batch.id, { status: "active" });
    }
    return payout;
  };

  const validPayoutRow = (row: any, opts?: { nuvionBound?: boolean }): string | undefined => {
    // A Nuvion bound row needs no destination asset: its recipient
    // record carries the currency it pays in instead.
    if (!row?.recipientAddress || (!opts?.nuvionBound && !row?.destinationAsset)) return "each payout needs recipientAddress and destinationAsset";
    if (!isAmountString(String(row.amount ?? ""))) return "each payout amount must be a positive integer string in smallest units";
    if (BigInt(String(row.amount)) > BigInt(cfg.pilotMaxPayoutUnits)) return "a payout amount exceeds the pilot cap";
    if (row.reference !== undefined && row.reference !== null && row.reference !== "") {
      if (typeof row.reference !== "string" || row.reference.trim().length === 0 || row.reference.trim().length > 120) {
        return "a payout reference must be a string of 1 to 120 characters";
      }
    }
    const hasBreakdown = ["grossAmount", "retentionAmount", "deductionsAmount"]
      .some((k) => row[k] !== undefined && row[k] !== null && row[k] !== "");
    if (hasBreakdown) {
      if (row.grossAmount === undefined || row.grossAmount === null || row.grossAmount === "") {
        return "a gross amount is required when retention or deductions are given";
      }
      for (const k of ["grossAmount", "retentionAmount", "deductionsAmount"]) {
        const v = row[k];
        if (v !== undefined && v !== null && v !== "" && !/^[0-9]+$/.test(String(v))) {
          return "gross, retention and deductions amounts must be integer strings in smallest units";
        }
      }
      const gross = BigInt(String(row.grossAmount));
      if (gross <= 0n) return "the gross amount must be positive";
      const retention = BigInt(String(row.retentionAmount ?? "0") || "0");
      const deductions = BigInt(String(row.deductionsAmount ?? "0") || "0");
      if (gross - retention - deductions !== BigInt(String(row.amount))) {
        return "the payout amount must equal the gross amount minus retention and deductions";
      }
    }
    return undefined;
  };

  app.post("/v1/payouts", async (req, reply) => {
    const m = req.merchant!;
    const b = req.body as any;
    const idem = req.headers["idempotency-key"] as string | undefined;
    if (idem) {
      const existing = store.payoutByIdempotency(m.id, idem);
      if (existing) return reply.code(200).send(existing);
    }
    const resolved = resolvePayoutRow(m, b);
    if (resolved.error) return reply.code(400).send({ error: resolved.error });
    const rec = recipientForRow(m, resolved.row);
    const problem = validPayoutRow(resolved.row, { nuvionBound: isNuvionBound(rec) }) ?? nuvionRowProblem(m, resolved.row, rec);
    if (problem) return reply.code(400).send({ error: problem });
    try {
      const payout = await createPayoutFor(m, resolved.row, undefined, idem);
      return reply.code(201).send(payout);
    } catch (err) {
      return reply.code(502).send({ error: `quote failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get("/v1/payouts", async (req) => store.listPayouts(req.merchant!.id));

  app.get("/v1/payouts/:id", async (req, reply) => {
    const p = store.getPayout(req.merchant!.id, (req.params as any).id);
    if (!p) return reply.code(404).send({ error: "payout not found" });
    return p;
  });

  app.post("/v1/payouts/:id/retry", async (req, reply) => {
    const m = req.merchant!;
    const failed = store.getPayout(m.id, (req.params as any).id);
    if (!failed) return reply.code(404).send({ error: "payout not found" });
    try {
      const payout = await retryPayoutFor(m, failed);
      return reply.code(201).send(payout);
    } catch (err) {
      if (err instanceof RetryRefused) return reply.code(err.httpStatus).send({ error: err.message });
      return reply.code(502).send({ error: `quote failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // ---- payout batches ----
  /**
   * Mark an attempt's payouts failed after a batch creation or
   * approval attempt failed partway. A payout that already carries a
   * provider_ref holds a live Nuvion transfer that may still settle;
   * failing it locally would make the poller stop watching it, so it
   * keeps its live status and the backstop keeps tracking it (the
   * slice 5 sharp edge fix). A payout without one only ever held a
   * quote, and fails with the attempt exactly as before.
   */
  const failAttemptPayouts = (payouts: Payout[]) => {
    for (const p of payouts) {
      if (!p.providerRef) store.updatePayout(p.id, { status: "failed" });
    }
  };

  /**
   * The one batch creation path. Rows must already be resolved and
   * validated. Over threshold batches wait in pending_approval with no
   * payouts created; under threshold batches quote every row at once.
   * A quote failure fails the whole batch: the batch is marked failed,
   * and any rows already quoted are marked failed with it (see
   * failAttemptPayouts for the one exception). Their deposit
   * addresses were never returned in a success response, so nothing can
   * be funded against them.
   */
  const createBatchFor = async (m: Merchant, rows: any[]) => {
    const total = rows.reduce((acc: bigint, r: any) => acc + BigInt(String(r.amount)), 0n);
    const needsApproval = total > BigInt(cfg.approvalThresholdUnits);
    const batch = store.createBatch({
      id: makeId("batch"), merchantId: m.id, status: needsApproval ? "pending_approval" : "active",
      totalAmount: total.toString(), rowCount: rows.length, rows,
      createdAt: new Date().toISOString(),
    });
    store.addLedger({ merchantId: m.id, entityType: "batch", entityId: batch.id, kind: "batch_created", amount: total.toString(), asset: String(rows[0].destinationAsset ?? "") });
    // Anchor once the batch is live: immediately when it starts
    // active, otherwise at approval time (see approveBatchFor).
    if (!needsApproval) anchorBatchNow(batch, rows as PayoutRow[]);
    const payouts: Payout[] = [];
    let quoteError: string | undefined;
    if (!needsApproval) {
      try {
        for (const row of rows) payouts.push(await createPayoutFor(m, row, batch.id));
      } catch (err) {
        quoteError = err instanceof Error ? err.message : String(err);
        failAttemptPayouts(payouts);
        store.updateBatch(batch.id, { status: "failed" });
        store.addLedger({ merchantId: m.id, entityType: "batch", entityId: batch.id, kind: "batch_failed", amount: total.toString(), asset: String(rows[0].destinationAsset ?? "") });
        return { batch: store.getBatch(m.id, batch.id) ?? batch, payouts, quoteError };
      }
    }
    return { batch, payouts, quoteError };
  };

  app.post("/v1/payout-batches", async (req, reply) => {
    const m = req.merchant!;
    let rawRows: any[] | undefined;
    if (typeof req.body === "string") {
      // CSV upload: raw text/csv body. Validate everything up front;
      // a single bad row means nothing is created.
      const parsed = parseBatchCsv(req.body);
      if (parsed.errors.length > 0 || !parsed.rows) {
        return reply.code(400).send({ error: "CSV batch is invalid; nothing was created", errors: parsed.errors });
      }
      rawRows = parsed.rows;
    } else {
      const b = req.body as any;
      if (!Array.isArray(b?.rows) || b.rows.length < 1 || b.rows.length > 100) {
        return reply.code(400).send({ error: "rows must contain 1 to 100 payouts" });
      }
      rawRows = b.rows;
    }
    const resolvedRows: any[] = [];
    for (const row of rawRows ?? []) {
      const resolved = resolvePayoutRow(m, row);
      if (resolved.error) return reply.code(400).send({ error: resolved.error });
      const rec = recipientForRow(m, resolved.row);
      const problem = validPayoutRow(resolved.row, { nuvionBound: isNuvionBound(rec) }) ?? nuvionRowProblem(m, resolved.row, rec);
      if (problem) return reply.code(400).send({ error: problem });
      resolvedRows.push(resolved.row);
    }
    const { batch, payouts, quoteError } = await createBatchFor(m, resolvedRows);
    if (quoteError) {
      return reply.code(502).send({ error: `quote failed: ${quoteError}`, batch });
    }
    return reply.code(201).send({ ...batch, payouts });
  });

  app.get("/v1/payout-batches", async (req) => store.listBatches(req.merchant!.id));

  app.get("/v1/payout-batches/:id", async (req, reply) => {
    const m = req.merchant!;
    const batch = store.getBatch(m.id, (req.params as any).id);
    if (!batch) return reply.code(404).send({ error: "batch not found" });
    return { ...batch, payouts: store.listPayouts(m.id, batch.id), totals: { totalAmount: batch.totalAmount, rowCount: batch.rowCount } };
  });

  /** The one batch approval path: quote every row, mark active, ledger. API and dashboard both call this. */
  const approveBatchFor = async (m: Merchant, batch: PayoutBatch) => {
    const payouts: Payout[] = [];
    // Re approval after a part failed attempt: a row that already
    // executed through Nuvion carries a provider_ref and a live
    // transfer at the rail. It must never be executed a second time,
    // so the payouts a previous attempt created are matched back to
    // their rows, in order, and reused as they stand. Retry payouts
    // are excluded: they belong to the retry path, not to an approval
    // attempt. Only rows with no transfer yet execute here.
    const inFlight = store.payoutsByBatch(batch.id).filter((p) => p.providerRef && !p.retryOfId);
    let inFlightIdx = 0;
    const reuseFor = (row: any): Payout | undefined => {
      const candidate = inFlight[inFlightIdx];
      if (!candidate) return undefined;
      const matches = candidate.recipientAddress === row.recipientAddress
        && candidate.destinationAsset === row.destinationAsset
        && candidate.amount === String(row.amount)
        && (candidate.recipientId ?? undefined) === (row.recipientId ? String(row.recipientId) : undefined);
      if (!matches) return undefined;
      inFlightIdx += 1;
      return candidate;
    };
    try {
      for (const row of batch.rows) payouts.push(reuseFor(row) ?? await createPayoutFor(m, row, batch.id));
    } catch (err) {
      // Approval stays retryable: fail only the rows this attempt
      // quoted (their deposit addresses were never returned), keep the
      // batch in pending_approval, and let the caller report the quote
      // failure. A later approval creates fresh payouts for those
      // rows, so no row can be paid twice. Rows already carrying a
      // provider_ref are the exception (see failAttemptPayouts): their
      // transfers are live, they keep their status, and a later
      // approval reuses them instead of executing them again.
      failAttemptPayouts(payouts);
      throw err;
    }
    const updated = store.updateBatch(batch.id, { status: "active" })!;
    store.addLedger({ merchantId: m.id, entityType: "batch", entityId: batch.id, kind: "batch_approved", amount: batch.totalAmount, asset: String((batch.rows[0] as any)?.destinationAsset ?? "") });
    // First anchor for a batch that waited for approval.
    anchorBatchNow(updated, batch.rows as unknown as PayoutRow[]);
    return { batch: updated, payouts };
  };

  app.post("/v1/payout-batches/:id/approve", async (req, reply) => {
    const m = req.merchant!;
    const batch = store.getBatch(m.id, (req.params as any).id);
    if (!batch) return reply.code(404).send({ error: "batch not found" });
    if (batch.status !== "pending_approval") return reply.code(409).send({ error: `batch is ${batch.status}, not pending approval` });
    try {
      const { batch: updated, payouts } = await approveBatchFor(m, batch);
      return { ...updated, payouts };
    } catch (err) {
      return reply.code(502).send({ error: `quote failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // ---- ledger and reconciliation ----
  app.get("/v1/ledger", async (req) => {
    const q = req.query as any;
    return store.listLedger(req.merchant!.id, q.entity_id);
  });

  app.get("/v1/reconciliation/daily", async (req) => {
    const m = req.merchant!;
    const invoices = store.listInvoices(m.id);
    const byStatus: Record<string, number> = {};
    for (const inv of invoices) byStatus[inv.status] = (byStatus[inv.status] || 0) + 1;
    const flags: Record<string, number> = {};
    for (const inv of invoices) if (inv.reconFlag) flags[inv.reconFlag] = (flags[inv.reconFlag] || 0) + 1;
    return {
      merchantId: m.id, invoicesByStatus: byStatus, reconFlags: flags,
      ledgerEntries: store.listLedger(m.id).length, payouts: store.listPayouts(m.id).length,
      batches: store.listBatches(m.id).length,
    };
  });

  app.get("/v1/reconciliation/export.csv", async (req, reply) => {
    const m = req.merchant!;
    const head = "invoice_id,external_ref,gross,fee_estimate,net,settlement_asset,status,deposit_address,created_at";
    const lines = store.listInvoices(m.id).map((inv) => {
      const fee = feeEstimate(inv.amount, cfg.appFeeBps);
      const net = (BigInt(inv.amount) - BigInt(fee)).toString();
      const cells = [inv.id, inv.externalRef ?? "", inv.amount, fee, net, inv.settlementAsset, inv.status, inv.depositAddress ?? "", inv.createdAt];
      return cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");
    });
    reply.type("text/csv").header("content-disposition", "attachment; filename=remiglo-reconciliation.csv")
      .send([head, ...lines].join("\n") + "\n");
  });

  app.get("/v1/reconciliation/payouts.csv", async (req, reply) => {
    const m = req.merchant!;
    const head = "payout_id,batch_id,recipient_address,reference,gross_amount,retention_amount,deductions_amount,net_amount,amount_received,destination_asset,status,deposit_address,created_at,rail,fiat_currency,fiat_amount,fx_quote_id,provider_ref,provider_fee";
    const esc = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
    const lines = store.listPayouts(m.id).map((p) => {
      // Trailing Nuvion columns (fiat slice 6): the rail a row settled
      // on and its provider side record, empty for rows that have none.
      // Existing columns and their order are untouched.
      const cells = [p.id, p.batchId ?? "", p.recipientAddress, p.reference ?? "", p.grossAmount ?? "", p.retentionAmount ?? "", p.deductionsAmount ?? "", p.amount, p.amountOut ?? "", p.destinationAsset, p.status, p.depositAddress ?? "", p.createdAt,
        p.providerRef ? "nuvion" : "intents", p.fiatCurrency ?? "", p.fiatAmount ?? "", p.fxQuoteId ?? "", p.providerRef ?? "", p.providerFee ?? ""];
      return cells.map(esc).join(",");
    });
    reply.type("text/csv").header("content-disposition", "attachment; filename=remiglo-payouts.csv")
      .send([head, ...lines].join("\n") + "\n");
  });

  // ---- webhooks ----
  app.post("/v1/webhook-endpoints", async (req, reply) => {
    const m = req.merchant!;
    const b = req.body as any;
    if (!b?.url) return reply.code(400).send({ error: "url is required" });
    const secret = newWebhookSecret();
    const ep = store.createEndpoint(m.id, b.url, secret);
    return reply.code(201).send({ id: ep.id, url: ep.url, secret, createdAt: ep.createdAt, note: "Store this signing secret now. It is shown once." });
  });

  app.get("/v1/webhook-endpoints", async (req) =>
    store.listEndpoints(req.merchant!.id).map(({ secret: _s, ...rest }) => rest));

  app.get("/v1/webhook-deliveries", async (req) => store.listDeliveries(req.merchant!.id));

  app.post("/v1/webhook-deliveries/:id/replay", async (req, reply) => {
    const m = req.merchant!;
    const original = store.getDelivery(m.id, (req.params as any).id);
    if (!original) return reply.code(404).send({ error: "delivery not found" });
    const fresh = store.createDelivery({
      merchantId: m.id, endpointId: original.endpointId, event: original.event,
      entityId: original.entityId, payload: original.payload,
    });
    const done = await deliverDelivery(store, fresh, fetchFn, cfg.webhook);
    return reply.code(201).send(done);
  });

  // ---- schedules ----
  const prepareBatchRows = (m: Merchant, rows: any[]): { rows?: any[]; error?: string } => {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
      return { error: "rows must contain 1 to 100 payouts" };
    }
    const out: any[] = [];
    for (const row of rows) {
      const resolved = resolvePayoutRow(m, row);
      if (resolved.error) return { error: resolved.error };
      const rec = recipientForRow(m, resolved.row);
      const problem = validPayoutRow(resolved.row, { nuvionBound: isNuvionBound(rec) }) ?? nuvionRowProblem(m, resolved.row, rec);
      if (problem) return { error: problem };
      out.push(resolved.row);
    }
    return { rows: out };
  };

  const scheduleServices: ScheduleServices = { createInvoiceFor, createBatchFor, prepareBatchRows };

  const validSchedulePayload = (m: Merchant, kind: string, payload: any): string | undefined => {
    if (!payload || typeof payload !== "object") return "payload must be an object";
    if (kind === "invoice") {
      if (!isAmountString(String(payload.amount ?? ""))) return "invoice payload needs amount as a positive integer string in smallest units";
      return undefined;
    }
    const prepared = prepareBatchRows(m, payload.rows ?? []);
    return prepared.error;
  };

  app.post("/v1/schedules", async (req, reply) => {
    const m = req.merchant!;
    const b = (req.body ?? {}) as any;
    if (!["invoice", "payout_batch"].includes(b.kind)) return reply.code(400).send({ error: "kind must be invoice or payout_batch" });
    if (!["weekly", "biweekly", "monthly"].includes(b.cadence)) return reply.code(400).send({ error: "cadence must be weekly, biweekly or monthly" });
    if (b.dayOfMonth !== undefined && (!Number.isInteger(b.dayOfMonth) || b.dayOfMonth < 1 || b.dayOfMonth > 28)) {
      return reply.code(400).send({ error: "dayOfMonth must be an integer between 1 and 28" });
    }
    const problem = validSchedulePayload(m, b.kind, b.payload);
    if (problem) return reply.code(400).send({ error: problem });
    const nowDate = new Date();
    const nextRunAt = b.startAt && !Number.isNaN(Date.parse(String(b.startAt)))
      ? new Date(String(b.startAt)).toISOString()
      : firstRunAt(b.cadence, b.dayOfMonth, nowDate);
    const schedule = store.createSchedule({
      merchantId: m.id, kind: b.kind, cadence: b.cadence,
      dayOfMonth: b.cadence === "monthly" ? (b.dayOfMonth ?? Math.min(nowDate.getUTCDate(), 28)) : undefined,
      payload: b.payload, nextRunAt, active: b.active !== false,
    });
    return reply.code(201).send(schedule);
  });

  app.get("/v1/schedules", async (req) => store.listSchedules(req.merchant!.id));

  app.get("/v1/schedules/:id", async (req, reply) => {
    const s = store.getSchedule(req.merchant!.id, (req.params as any).id);
    if (!s) return reply.code(404).send({ error: "schedule not found" });
    return { ...s, runs: store.listRuns(req.merchant!.id, s.id) };
  });

  app.patch("/v1/schedules/:id", async (req, reply) => {
    const m = req.merchant!;
    const s = store.getSchedule(m.id, (req.params as any).id);
    if (!s) return reply.code(404).send({ error: "schedule not found" });
    const b = (req.body ?? {}) as any;
    const patch: Record<string, unknown> = {};
    if (b.payload !== undefined) {
      const problem = validSchedulePayload(m, s.kind, b.payload);
      if (problem) return reply.code(400).send({ error: problem });
      patch.payload = b.payload;
    }
    if (b.dayOfMonth !== undefined) {
      if (!Number.isInteger(b.dayOfMonth) || b.dayOfMonth < 1 || b.dayOfMonth > 28) {
        return reply.code(400).send({ error: "dayOfMonth must be an integer between 1 and 28" });
      }
      patch.dayOfMonth = b.dayOfMonth;
    }
    if (b.active !== undefined) patch.active = Boolean(b.active);
    if (b.cadence !== undefined) {
      if (!["weekly", "biweekly", "monthly"].includes(b.cadence)) return reply.code(400).send({ error: "cadence must be weekly, biweekly or monthly" });
      patch.cadence = b.cadence;
      patch.nextRunAt = firstRunAt(b.cadence, (patch.dayOfMonth as number | undefined) ?? s.dayOfMonth, new Date());
    }
    return store.updateSchedule(s.id, patch as any);
  });

  app.post("/v1/schedules/:id/pause", async (req, reply) => {
    const s = store.getSchedule(req.merchant!.id, (req.params as any).id);
    if (!s) return reply.code(404).send({ error: "schedule not found" });
    return store.updateSchedule(s.id, { active: false });
  });

  app.post("/v1/schedules/:id/resume", async (req, reply) => {
    const s = store.getSchedule(req.merchant!.id, (req.params as any).id);
    if (!s) return reply.code(404).send({ error: "schedule not found" });
    // Resume from now rather than bursting through missed occurrences.
    const nextRunAt = Date.parse(s.nextRunAt) < Date.now() ? firstRunAt(s.cadence, s.dayOfMonth, new Date()) : s.nextRunAt;
    return store.updateSchedule(s.id, { active: true, nextRunAt });
  });

  app.delete("/v1/schedules/:id", async (req, reply) => {
    const ok = store.deleteSchedule(req.merchant!.id, (req.params as any).id);
    if (!ok) return reply.code(404).send({ error: "schedule not found" });
    return { deleted: true };
  });

  // Shared sync dependencies (the background loop in server.ts uses these).
  (app as any).remiglo.syncDeps = { store, intents, fetchFn, webhookCfg: cfg.webhook, scheduleServices, indexer: indexerRun, nuvion: nuvionClient };

  // ---- internal sync (poller trigger) ----
  app.post("/v1/internal/sync", async (req, reply) => {
    if (!hasAdmin(req) && !isLocal(req)) {
      return reply.code(403).send({ error: "sync requires the admin token or a localhost request" });
    }
    const result = await syncOnce((app as any).remiglo.syncDeps);
    return result;
  });

  // ---- internal indexer status (Slice I) ----
  app.get("/v1/internal/indexer/status", async (req, reply) => {
    if (!hasAdmin(req) && !isLocal(req)) {
      return reply.code(403).send({ error: "indexer status requires the admin token or a localhost request" });
    }
    return indexerStatus(store, cfg.registryContractId);
  });

  return app;
}
