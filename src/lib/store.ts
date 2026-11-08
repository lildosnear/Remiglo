import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";

// node:sqlite is loaded at runtime on purpose: Vite and older type
// resolvers do not know this Node 24 builtin and try to resolve it as a
// package. createRequire goes straight to Node.
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDb;
};
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DashRole, DashUser, Invoice, LedgerEntry, Merchant, Payout, PayoutBatch, Recipient, RegistryEvent,
  Schedule, ScheduleRun, WebhookDelivery, WebhookEndpoint,
} from "./core.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  settlement_asset TEXT NOT NULL, settlement_address TEXT NOT NULL, refund_to TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, external_ref TEXT,
  amount TEXT NOT NULL, currency TEXT NOT NULL, origin_asset TEXT,
  settlement_asset TEXT NOT NULL, settlement_address TEXT NOT NULL, refund_to TEXT,
  status TEXT NOT NULL, deposit_address TEXT, amount_out TEXT, observed_amount TEXT, expires_at TEXT,
  recon_flag TEXT, idempotency_key TEXT, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_idem ON invoices(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, batch_id TEXT,
  recipient_address TEXT NOT NULL, destination_asset TEXT NOT NULL, origin_asset TEXT NOT NULL,
  refund_to TEXT, amount TEXT NOT NULL, status TEXT NOT NULL, deposit_address TEXT,
  amount_out TEXT, idempotency_key TEXT, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_idem ON payouts(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS payout_batches (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, status TEXT NOT NULL,
  total_amount TEXT NOT NULL, row_count INTEGER NOT NULL, rows_json TEXT NOT NULL,
  anchor_tx_hash TEXT, anchor_status TEXT,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY, merchant_id TEXT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  kind TEXT NOT NULL, amount TEXT NOT NULL, asset TEXT NOT NULL, tx_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL, asset_id TEXT NOT NULL, chain TEXT NOT NULL DEFAULT '',
  notes TEXT, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, kind TEXT NOT NULL, cadence TEXT NOT NULL,
  day_of_month INTEGER, payload_json TEXT NOT NULL, next_run_at TEXT NOT NULL, last_run_at TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
  occurrence_at TEXT NOT NULL, status TEXT NOT NULL, entity_id TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT,
  UNIQUE(schedule_id, occurrence_at)
);
CREATE TABLE IF NOT EXISTS dash_users (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dash_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS registry_events (
  id TEXT PRIMARY KEY, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
  block_height INTEGER NOT NULL, contract_id TEXT NOT NULL, event TEXT NOT NULL,
  data_json TEXT NOT NULL, indexed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_event ON registry_events(tx_hash, log_index);
CREATE TABLE IF NOT EXISTS indexer_state (
  contract_id TEXT PRIMARY KEY, last_height INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, event TEXT NOT NULL,
  entity_id TEXT, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  attempt_log TEXT NOT NULL DEFAULT '[]', last_status_code INTEGER, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT
);
`;

const now = () => new Date().toISOString();
const uid = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const newApiKey = () => `rgl_live_${randomBytes(24).toString("hex")}`;
export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("hex")}`;

/** SQLite backed store. Routes and services go through this layer only. */
export class Store {
  private db: SqliteDb;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // Migration for databases created before observed_amount existed.
    const cols = this.db.prepare("PRAGMA table_info(invoices)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "observed_amount")) {
      this.db.exec("ALTER TABLE invoices ADD COLUMN observed_amount TEXT");
    }
    // Migration for databases created before registry anchoring (Slice G).
    const batchCols = this.db.prepare("PRAGMA table_info(payout_batches)").all() as Array<{ name: string }>;
    if (!batchCols.some((c) => c.name === "anchor_tx_hash")) {
      this.db.exec("ALTER TABLE payout_batches ADD COLUMN anchor_tx_hash TEXT");
    }
    if (!batchCols.some((c) => c.name === "anchor_status")) {
      this.db.exec("ALTER TABLE payout_batches ADD COLUMN anchor_status TEXT");
    }
  }

  close() { this.db.close(); }

  // ---- merchants and keys ----
  createMerchant(input: { name: string; settlementAsset: string; settlementAddress: string; refundTo: string }) {
    const merchant: Merchant = {
      id: uid("mch"), name: input.name, settlementAsset: input.settlementAsset,
      settlementAddress: input.settlementAddress, refundTo: input.refundTo, createdAt: now(),
    };
    this.db.prepare("INSERT INTO merchants (id,name,settlement_asset,settlement_address,refund_to,created_at) VALUES (?,?,?,?,?,?)")
      .run(merchant.id, merchant.name, merchant.settlementAsset, merchant.settlementAddress, merchant.refundTo, merchant.createdAt);
    const apiKey = newApiKey();
    this.db.prepare("INSERT INTO api_keys (id,merchant_id,key_hash,prefix,created_at) VALUES (?,?,?,?,?)")
      .run(uid("key"), merchant.id, hashKey(apiKey), apiKey.slice(0, 12), merchant.createdAt);
    return { merchant, apiKey };
  }

  merchantByApiKey(apiKey: string): Merchant | undefined {
    const row = this.db.prepare(
      `SELECT m.id, m.name, m.settlement_asset, m.settlement_address, m.refund_to, m.created_at
       FROM api_keys k JOIN merchants m ON m.id = k.merchant_id WHERE k.key_hash = ?`
    ).get(hashKey(apiKey)) as any;
    if (!row) return undefined;
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?").run(now(), hashKey(apiKey));
    return this.rowMerchant(row);
  }

  getMerchant(id: string): Merchant | undefined {
    const row = this.db.prepare("SELECT * FROM merchants WHERE id = ?").get(id) as any;
    return row ? this.rowMerchant(row) : undefined;
  }

  listMerchants(): Merchant[] {
    return (this.db.prepare("SELECT * FROM merchants ORDER BY created_at").all() as any[]).map((r) => this.rowMerchant(r));
  }

  updateMerchant(id: string, patch: Partial<Pick<Merchant, "name" | "settlementAsset" | "settlementAddress" | "refundTo">>): Merchant | undefined {
    const cur = this.getMerchant(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db.prepare("UPDATE merchants SET name=?, settlement_asset=?, settlement_address=?, refund_to=? WHERE id=?")
      .run(next.name, next.settlementAsset, next.settlementAddress, next.refundTo, id);
    return next;
  }

  // ---- dashboard users and sessions ----
  countUsers(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM dash_users").get() as any;
    return Number(r?.n ?? 0);
  }

  createUser(input: { merchantId: string; email: string; passwordHash: string; salt: string; role: DashRole }): DashUser {
    const user: DashUser = {
      id: uid("usr"), merchantId: input.merchantId, email: input.email.toLowerCase(),
      role: input.role, active: true, createdAt: now(),
    };
    this.db.prepare("INSERT INTO dash_users (id,merchant_id,email,password_hash,salt,role,active,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(user.id, user.merchantId, user.email, input.passwordHash, input.salt, user.role, 1, user.createdAt);
    return user;
  }

  userCredentialsByEmail(email: string): { user: DashUser; passwordHash: string; salt: string } | undefined {
    const r = this.db.prepare("SELECT * FROM dash_users WHERE email = ?").get(email.toLowerCase()) as any;
    if (!r) return undefined;
    return { user: this.rowUser(r), passwordHash: r.password_hash, salt: r.salt };
  }

  getUser(id: string): DashUser | undefined {
    const r = this.db.prepare("SELECT * FROM dash_users WHERE id = ?").get(id) as any;
    return r ? this.rowUser(r) : undefined;
  }

  listUsers(merchantId: string): DashUser[] {
    return (this.db.prepare("SELECT * FROM dash_users WHERE merchant_id = ? ORDER BY created_at, id").all(merchantId) as any[]).map((r) => this.rowUser(r));
  }

  updateUser(id: string, patch: Partial<Pick<DashUser, "role" | "active">>): DashUser | undefined {
    const cur = this.getUser(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db.prepare("UPDATE dash_users SET role=?, active=? WHERE id=?").run(next.role, next.active ? 1 : 0, id);
    if (!next.active) this.deleteUserSessions(id);
    return next;
  }

  private rowUser(r: any): DashUser {
    return {
      id: r.id, merchantId: r.merchant_id, email: r.email, role: r.role as DashRole,
      active: r.active === 1, createdAt: r.created_at,
    };
  }

  createSession(userId: string, tokenHash: string, expiresAt: string): void {
    this.db.prepare("INSERT INTO dash_sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)")
      .run(uid("ses"), userId, tokenHash, now(), expiresAt);
  }

  /** The active user behind a session token hash, or undefined when expired, revoked or deactivated. */
  sessionUser(tokenHash: string): DashUser | undefined {
    const r = this.db.prepare("SELECT user_id, expires_at FROM dash_sessions WHERE token_hash = ?").get(tokenHash) as any;
    if (!r) return undefined;
    if (Date.parse(r.expires_at) < Date.now()) {
      this.db.prepare("DELETE FROM dash_sessions WHERE token_hash = ?").run(tokenHash);
      return undefined;
    }
    const user = this.getUser(r.user_id);
    return user?.active ? user : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM dash_sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteUserSessions(userId: string): void {
    this.db.prepare("DELETE FROM dash_sessions WHERE user_id = ?").run(userId);
  }

  private rowMerchant(r: any): Merchant {
    return { id: r.id, name: r.name, settlementAsset: r.settlement_asset, settlementAddress: r.settlement_address, refundTo: r.refund_to, createdAt: r.created_at };
  }

  // ---- invoices ----
  createInvoice(inv: Invoice) {
    this.db.prepare(`INSERT INTO invoices (id,merchant_id,external_ref,amount,currency,origin_asset,settlement_asset,settlement_address,refund_to,status,deposit_address,amount_out,observed_amount,expires_at,recon_flag,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(inv.id, inv.merchantId, inv.externalRef ?? null, inv.amount, inv.currency, inv.originAsset ?? null,
        inv.settlementAsset, inv.settlementAddress, inv.refundTo ?? null, inv.status, inv.depositAddress ?? null,
        inv.amountOut ?? null, inv.observedAmount ?? null, inv.expiresAt ?? null, inv.reconFlag ?? null, inv.idempotencyKey ?? null, inv.createdAt, inv.createdAt);
    return inv;
  }

  getInvoice(merchantId: string, id: string): Invoice | undefined {
    const r = this.db.prepare("SELECT * FROM invoices WHERE merchant_id = ? AND id = ?").get(merchantId, id) as any;
    return r ? this.rowInvoice(r) : undefined;
  }

  /** Public lookup by id alone. The id is the capability on payment links. */
  getInvoiceById(id: string): Invoice | undefined {
    const r = this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as any;
    return r ? this.rowInvoice(r) : undefined;
  }

  invoiceByIdempotency(merchantId: string, key: string): Invoice | undefined {
    const r = this.db.prepare("SELECT * FROM invoices WHERE merchant_id = ? AND idempotency_key = ?").get(merchantId, key) as any;
    return r ? this.rowInvoice(r) : undefined;
  }

  listInvoices(merchantId: string): Invoice[] {
    return (this.db.prepare("SELECT * FROM invoices WHERE merchant_id = ? ORDER BY created_at, id").all(merchantId) as any[]).map((r) => this.rowInvoice(r));
  }

  openInvoices(): Invoice[] {
    return (this.db.prepare("SELECT * FROM invoices WHERE status IN ('open','deposit_seen','processing') AND deposit_address IS NOT NULL").all() as any[]).map((r) => this.rowInvoice(r));
  }

  updateInvoice(id: string, patch: Partial<Invoice>) {
    const cur = this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as any;
    if (!cur) return undefined;
    const next = { ...this.rowInvoice(cur), ...patch, updatedAt: now() };
    this.db.prepare(`UPDATE invoices SET status=?, deposit_address=?, amount_out=?, observed_amount=?, recon_flag=?, updated_at=? WHERE id=?`)
      .run(next.status, next.depositAddress ?? null, next.amountOut ?? null, next.observedAmount ?? null, next.reconFlag ?? null, next.updatedAt, id);
    return next;
  }

  private rowInvoice(r: any): Invoice {
    return {
      id: r.id, merchantId: r.merchant_id, externalRef: r.external_ref ?? undefined, amount: r.amount,
      currency: r.currency, originAsset: r.origin_asset ?? undefined, settlementAsset: r.settlement_asset,
      settlementAddress: r.settlement_address, refundTo: r.refund_to ?? undefined, status: r.status,
      depositAddress: r.deposit_address ?? undefined, amountOut: r.amount_out ?? undefined,
      observedAmount: r.observed_amount ?? undefined,
      expiresAt: r.expires_at ?? undefined, reconFlag: r.recon_flag ?? undefined,
      idempotencyKey: r.idempotency_key ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
    };
  }

  // ---- payouts and batches ----
  createPayout(p: Payout) {
    this.db.prepare(`INSERT INTO payouts (id,merchant_id,batch_id,recipient_address,destination_asset,origin_asset,refund_to,amount,status,deposit_address,amount_out,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, p.merchantId, p.batchId ?? null, p.recipientAddress, p.destinationAsset, p.originAsset,
        p.refundTo ?? null, p.amount, p.status, p.depositAddress ?? null, p.amountOut ?? null,
        p.idempotencyKey ?? null, p.createdAt, p.createdAt);
    return p;
  }

  getPayout(merchantId: string, id: string): Payout | undefined {
    const r = this.db.prepare("SELECT * FROM payouts WHERE merchant_id = ? AND id = ?").get(merchantId, id) as any;
    return r ? this.rowPayout(r) : undefined;
  }

  payoutByIdempotency(merchantId: string, key: string): Payout | undefined {
    const r = this.db.prepare("SELECT * FROM payouts WHERE merchant_id = ? AND idempotency_key = ?").get(merchantId, key) as any;
    return r ? this.rowPayout(r) : undefined;
  }

  listPayouts(merchantId: string, batchId?: string): Payout[] {
    const rows = batchId
      ? this.db.prepare("SELECT * FROM payouts WHERE merchant_id = ? AND batch_id = ? ORDER BY created_at, id").all(merchantId, batchId)
      : this.db.prepare("SELECT * FROM payouts WHERE merchant_id = ? ORDER BY created_at, id").all(merchantId);
    return (rows as any[]).map((r) => this.rowPayout(r));
  }

  openPayouts(): Payout[] {
    return (this.db.prepare("SELECT * FROM payouts WHERE status IN ('awaiting_funding','funded','processing','quoted') AND deposit_address IS NOT NULL").all() as any[]).map((r) => this.rowPayout(r));
  }

  updatePayout(id: string, patch: Partial<Payout>) {
    const cur = this.db.prepare("SELECT * FROM payouts WHERE id = ?").get(id) as any;
    if (!cur) return undefined;
    const next = { ...this.rowPayout(cur), ...patch, updatedAt: now() };
    this.db.prepare(`UPDATE payouts SET status=?, deposit_address=?, amount_out=?, updated_at=? WHERE id=?`)
      .run(next.status, next.depositAddress ?? null, next.amountOut ?? null, next.updatedAt, id);
    return next;
  }

  private rowPayout(r: any): Payout {
    return {
      id: r.id, merchantId: r.merchant_id, batchId: r.batch_id ?? undefined, recipientAddress: r.recipient_address,
      destinationAsset: r.destination_asset, originAsset: r.origin_asset, refundTo: r.refund_to ?? undefined,
      amount: r.amount, status: r.status, depositAddress: r.deposit_address ?? undefined,
      amountOut: r.amount_out ?? undefined, idempotencyKey: r.idempotency_key ?? undefined,
      createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
    };
  }

  createBatch(b: PayoutBatch) {
    this.db.prepare(`INSERT INTO payout_batches (id,merchant_id,status,total_amount,row_count,rows_json,anchor_tx_hash,anchor_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(b.id, b.merchantId, b.status, b.totalAmount, b.rowCount, JSON.stringify(b.rows), b.anchorTxHash ?? null, b.anchorStatus ?? "none", b.createdAt, b.createdAt);
    return this.getBatchById(b.id) ?? b;
  }

  getBatch(merchantId: string, id: string): PayoutBatch | undefined {
    const r = this.db.prepare("SELECT * FROM payout_batches WHERE merchant_id = ? AND id = ?").get(merchantId, id) as any;
    return r ? this.rowBatch(r) : undefined;
  }

  listBatches(merchantId: string): PayoutBatch[] {
    return (this.db.prepare("SELECT * FROM payout_batches WHERE merchant_id = ? ORDER BY created_at, id").all(merchantId) as any[]).map((r) => this.rowBatch(r));
  }

  payoutsByBatch(batchId: string): Payout[] {
    return (this.db.prepare("SELECT * FROM payouts WHERE batch_id = ? ORDER BY created_at, id").all(batchId) as any[]).map((r) => this.rowPayout(r));
  }

  getBatchById(id: string): PayoutBatch | undefined {
    const r = this.db.prepare("SELECT * FROM payout_batches WHERE id = ?").get(id) as any;
    return r ? this.rowBatch(r) : undefined;
  }

  updateBatch(id: string, patch: Partial<PayoutBatch>) {
    const cur = this.db.prepare("SELECT * FROM payout_batches WHERE id = ?").get(id) as any;
    if (!cur) return undefined;
    const next = { ...this.rowBatch(cur), ...patch, updatedAt: now() };
    this.db.prepare("UPDATE payout_batches SET status=?, anchor_tx_hash=?, anchor_status=?, updated_at=? WHERE id=?")
      .run(next.status, next.anchorTxHash ?? null, next.anchorStatus ?? "none", next.updatedAt, id);
    return next;
  }

  private rowBatch(r: any): PayoutBatch {
    return {
      id: r.id, merchantId: r.merchant_id, status: r.status, totalAmount: r.total_amount,
      rowCount: r.row_count, rows: JSON.parse(r.rows_json),
      anchorTxHash: r.anchor_tx_hash ?? null, anchorStatus: r.anchor_status ?? "none",
      createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
    };
  }

  // ---- recipients (address book) ----
  createRecipient(input: { merchantId: string; label: string; address: string; assetId: string; chain: string; notes?: string }): Recipient {
    const r: Recipient = {
      id: uid("rcp"), merchantId: input.merchantId, label: input.label, address: input.address,
      assetId: input.assetId, chain: input.chain, notes: input.notes, createdAt: now(),
    };
    this.db.prepare("INSERT INTO recipients (id,merchant_id,label,address,asset_id,chain,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(r.id, r.merchantId, r.label, r.address, r.assetId, r.chain, r.notes ?? null, r.createdAt, r.createdAt);
    return r;
  }

  getRecipient(merchantId: string, id: string): Recipient | undefined {
    const r = this.db.prepare("SELECT * FROM recipients WHERE merchant_id = ? AND id = ?").get(merchantId, id) as any;
    return r ? this.rowRecipient(r) : undefined;
  }

  listRecipients(merchantId: string): Recipient[] {
    return (this.db.prepare("SELECT * FROM recipients WHERE merchant_id = ? ORDER BY created_at, id").all(merchantId) as any[]).map((r) => this.rowRecipient(r));
  }

  updateRecipient(merchantId: string, id: string, patch: Partial<Recipient>): Recipient | undefined {
    const cur = this.getRecipient(merchantId, id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updatedAt: now() };
    this.db.prepare("UPDATE recipients SET label=?, address=?, asset_id=?, chain=?, notes=?, updated_at=? WHERE merchant_id=? AND id=?")
      .run(next.label, next.address, next.assetId, next.chain, next.notes ?? null, next.updatedAt, merchantId, id);
    return next;
  }

  deleteRecipient(merchantId: string, id: string): boolean {
    const before = this.getRecipient(merchantId, id);
    if (!before) return false;
    this.db.prepare("DELETE FROM recipients WHERE merchant_id = ? AND id = ?").run(merchantId, id);
    return true;
  }

  private rowRecipient(r: any): Recipient {
    return {
      id: r.id, merchantId: r.merchant_id, label: r.label, address: r.address, assetId: r.asset_id,
      chain: r.chain, notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
    };
  }

  // ---- schedules ----
  createSchedule(input: Omit<Schedule, "id" | "createdAt" | "updatedAt" | "lastRunAt">): Schedule {
    const s: Schedule = { ...input, id: uid("sch"), createdAt: now() };
    this.db.prepare(`INSERT INTO schedules (id,merchant_id,kind,cadence,day_of_month,payload_json,next_run_at,last_run_at,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(s.id, s.merchantId, s.kind, s.cadence, s.dayOfMonth ?? null, JSON.stringify(s.payload), s.nextRunAt, null, s.active ? 1 : 0, s.createdAt, s.createdAt);
    return s;
  }

  getSchedule(merchantId: string, id: string): Schedule | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE merchant_id = ? AND id = ?").get(merchantId, id) as any;
    return r ? this.rowSchedule(r) : undefined;
  }

  getScheduleById(id: string): Schedule | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as any;
    return r ? this.rowSchedule(r) : undefined;
  }

  listSchedules(merchantId: string): Schedule[] {
    return (this.db.prepare("SELECT * FROM schedules WHERE merchant_id = ? ORDER BY created_at, id").all(merchantId) as any[]).map((r) => this.rowSchedule(r));
  }

  dueSchedules(atIso: string): Schedule[] {
    return (this.db.prepare("SELECT * FROM schedules WHERE active = 1 AND next_run_at <= ? ORDER BY next_run_at").all(atIso) as any[]).map((r) => this.rowSchedule(r));
  }

  updateSchedule(id: string, patch: Partial<Schedule>): Schedule | undefined {
    const cur = this.getScheduleById(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updatedAt: now() };
    this.db.prepare("UPDATE schedules SET kind=?, cadence=?, day_of_month=?, payload_json=?, next_run_at=?, last_run_at=?, active=?, updated_at=? WHERE id=?")
      .run(next.kind, next.cadence, next.dayOfMonth ?? null, JSON.stringify(next.payload), next.nextRunAt, next.lastRunAt ?? null, next.active ? 1 : 0, next.updatedAt, id);
    return next;
  }

  deleteSchedule(merchantId: string, id: string): boolean {
    if (!this.getSchedule(merchantId, id)) return false;
    this.db.prepare("DELETE FROM schedules WHERE merchant_id = ? AND id = ?").run(merchantId, id);
    return true;
  }

  private rowSchedule(r: any): Schedule {
    return {
      id: r.id, merchantId: r.merchant_id, kind: r.kind, cadence: r.cadence,
      dayOfMonth: r.day_of_month ?? undefined, payload: JSON.parse(r.payload_json),
      nextRunAt: r.next_run_at, lastRunAt: r.last_run_at ?? undefined,
      active: r.active === 1, createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
    };
  }

  /** Insert a run row for an occurrence. Returns false when it already exists (the double tick guard). */
  createRunIfAbsent(schedule: Schedule, occurrenceAt: string): ScheduleRun | undefined {
    const existing = this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? AND occurrence_at = ?")
      .get(schedule.id, occurrenceAt) as any;
    if (existing) return undefined;
    const run: ScheduleRun = {
      id: uid("run"), scheduleId: schedule.id, merchantId: schedule.merchantId,
      occurrenceAt, status: "started", createdAt: now(),
    };
    this.db.prepare("INSERT INTO schedule_runs (id,schedule_id,merchant_id,occurrence_at,status,entity_id,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(run.id, run.scheduleId, run.merchantId, run.occurrenceAt, run.status, null, null, run.createdAt, run.createdAt);
    return run;
  }

  updateRun(id: string, patch: Partial<ScheduleRun>): ScheduleRun | undefined {
    const cur = this.db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as any;
    if (!cur) return undefined;
    const next = { ...this.rowRun(cur), ...patch, updatedAt: now() };
    this.db.prepare("UPDATE schedule_runs SET status=?, entity_id=?, error=?, updated_at=? WHERE id=?")
      .run(next.status, next.entityId ?? null, next.error ?? null, next.updatedAt, id);
    return next;
  }

  listRuns(merchantId: string, scheduleId?: string): ScheduleRun[] {
    const rows = scheduleId
      ? this.db.prepare("SELECT * FROM schedule_runs WHERE merchant_id = ? AND schedule_id = ? ORDER BY occurrence_at").all(merchantId, scheduleId)
      : this.db.prepare("SELECT * FROM schedule_runs WHERE merchant_id = ? ORDER BY occurrence_at").all(merchantId);
    return (rows as any[]).map((r) => this.rowRun(r));
  }

  private rowRun(r: any): ScheduleRun {
    return {
      id: r.id, scheduleId: r.schedule_id, merchantId: r.merchant_id, occurrenceAt: r.occurrence_at,
      status: r.status, entityId: r.entity_id ?? undefined, error: r.error ?? undefined,
      createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
    };
  }

  // ---- ledger ----
  addLedger(e: Omit<LedgerEntry, "id" | "createdAt">): LedgerEntry {
    const entry: LedgerEntry = { ...e, id: uid("led"), createdAt: now() };
    this.db.prepare("INSERT INTO ledger_entries (id,merchant_id,entity_type,entity_id,kind,amount,asset,tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(entry.id, entry.merchantId ?? null, entry.entityType, entry.entityId, entry.kind, entry.amount, entry.asset, entry.txHash ?? null, entry.createdAt);
    return entry;
  }

  listLedger(merchantId: string, entityId?: string): LedgerEntry[] {
    const rows = entityId
      ? this.db.prepare("SELECT * FROM ledger_entries WHERE merchant_id = ? AND entity_id = ? ORDER BY created_at, id").all(merchantId, entityId)
      : this.db.prepare("SELECT * FROM ledger_entries WHERE merchant_id = ? ORDER BY created_at, id").all(merchantId);
    return (rows as any[]).map((r) => ({
      id: r.id, merchantId: r.merchant_id ?? undefined, entityType: r.entity_type, entityId: r.entity_id,
      kind: r.kind, amount: r.amount, asset: r.asset, txHash: r.tx_hash ?? undefined, createdAt: r.created_at,
    }));
  }

  recentLedger(limit = 20): LedgerEntry[] {
    return (this.db.prepare("SELECT * FROM ledger_entries ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as any[]).map((r) => ({
      id: r.id, merchantId: r.merchant_id ?? undefined, entityType: r.entity_type, entityId: r.entity_id,
      kind: r.kind, amount: r.amount, asset: r.asset, txHash: r.tx_hash ?? undefined, createdAt: r.created_at,
    }));
  }

  // ---- webhooks ----
  createEndpoint(merchantId: string, url: string, secret: string): WebhookEndpoint & { secret: string } {
    const ep = { id: uid("whk"), merchantId, url, createdAt: now() };
    this.db.prepare("INSERT INTO webhook_endpoints (id,merchant_id,url,secret,created_at) VALUES (?,?,?,?,?)")
      .run(ep.id, merchantId, url, secret, ep.createdAt);
    return { ...ep, secret };
  }

  listEndpoints(merchantId: string): Array<WebhookEndpoint & { secret: string }> {
    return (this.db.prepare("SELECT * FROM webhook_endpoints WHERE merchant_id = ? ORDER BY created_at").all(merchantId) as any[])
      .map((r) => ({ id: r.id, merchantId: r.merchant_id, url: r.url, secret: r.secret, createdAt: r.created_at }));
  }

  createDelivery(d: Omit<WebhookDelivery, "id" | "createdAt" | "attempts" | "attemptLog" | "status"> & { status?: string }): WebhookDelivery {
    const delivery: WebhookDelivery = {
      ...d, id: uid("dlv"), status: d.status ?? "pending", attempts: 0, attemptLog: [], createdAt: now(),
    };
    this.db.prepare(`INSERT INTO webhook_deliveries (id,merchant_id,endpoint_id,event,entity_id,payload,status,attempts,attempt_log,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(delivery.id, delivery.merchantId, delivery.endpointId, delivery.event, delivery.entityId ?? null,
        delivery.payload, delivery.status, 0, "[]", delivery.createdAt, delivery.createdAt);
    return delivery;
  }

  getDelivery(merchantId: string, id: string): WebhookDelivery | undefined {
    const r = this.db.prepare("SELECT * FROM webhook_deliveries WHERE merchant_id = ? AND id = ?").get(merchantId, id) as any;
    return r ? this.rowDelivery(r) : undefined;
  }

  listDeliveries(merchantId?: string, limit = 100): WebhookDelivery[] {
    const rows = merchantId
      ? this.db.prepare("SELECT * FROM webhook_deliveries WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(merchantId, limit)
      : this.db.prepare("SELECT * FROM webhook_deliveries ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
    return (rows as any[]).map((r) => this.rowDelivery(r));
  }

  pendingDeliveries(): WebhookDelivery[] {
    return (this.db.prepare("SELECT * FROM webhook_deliveries WHERE status = 'pending' ORDER BY created_at").all() as any[]).map((r) => this.rowDelivery(r));
  }

  updateDelivery(id: string, patch: Partial<WebhookDelivery>) {
    const cur = this.db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id) as any;
    if (!cur) return undefined;
    const next = { ...this.rowDelivery(cur), ...patch, updatedAt: now() };
    this.db.prepare(`UPDATE webhook_deliveries SET status=?, attempts=?, attempt_log=?, last_status_code=?, last_error=?, updated_at=? WHERE id=?`)
      .run(next.status, next.attempts, JSON.stringify(next.attemptLog), next.lastStatusCode ?? null, next.lastError ?? null, next.updatedAt, id);
    return next;
  }

  endpointSecret(endpointId: string): string | undefined {
    const r = this.db.prepare("SELECT secret FROM webhook_endpoints WHERE id = ?").get(endpointId) as any;
    return r?.secret;
  }

  endpointUrl(endpointId: string): string | undefined {
    const r = this.db.prepare("SELECT url FROM webhook_endpoints WHERE id = ?").get(endpointId) as any;
    return r?.url;
  }

  private rowDelivery(r: any): WebhookDelivery {
    return {
      id: r.id, merchantId: r.merchant_id, endpointId: r.endpoint_id, event: r.event,
      entityId: r.entity_id ?? undefined, payload: r.payload, status: r.status, attempts: r.attempts,
      attemptLog: JSON.parse(r.attempt_log || "[]"), lastStatusCode: r.last_status_code ?? undefined,
      lastError: r.last_error ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
    };
  }

  // ---- registry events + indexer cursor (Slice I) ----
  /** Insert one indexed event; returns false when it was already stored. */
  addRegistryEvent(e: Omit<RegistryEvent, "id" | "indexedAt">): boolean {
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO registry_events (id,tx_hash,log_index,block_height,contract_id,event,data_json,indexed_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(uid("evt"), e.txHash, e.logIndex, e.blockHeight, e.contractId, e.event, JSON.stringify(e.data), now()) as any;
    return Number(res.changes) > 0;
  }

  listRegistryEvents(contractId?: string, limit = 50): RegistryEvent[] {
    const rows = (contractId
      ? this.db.prepare("SELECT * FROM registry_events WHERE contract_id = ? ORDER BY block_height DESC, log_index DESC LIMIT ?").all(contractId, limit)
      : this.db.prepare("SELECT * FROM registry_events ORDER BY block_height DESC, log_index DESC LIMIT ?").all(limit)) as any[];
    return rows.map((r) => ({
      id: r.id, txHash: r.tx_hash, logIndex: r.log_index, blockHeight: r.block_height,
      contractId: r.contract_id, event: r.event, data: JSON.parse(r.data_json), indexedAt: r.indexed_at,
    }));
  }

  registryEventCounts(contractId: string): { total: number; byKind: Record<string, number> } {
    const rows = this.db.prepare("SELECT event, COUNT(*) AS n FROM registry_events WHERE contract_id = ? GROUP BY event").all(contractId) as any[];
    const byKind: Record<string, number> = {};
    let total = 0;
    for (const r of rows) { byKind[r.event] = Number(r.n); total += Number(r.n); }
    return { total, byKind };
  }

  getIndexerCursor(contractId: string): number | undefined {
    const r = this.db.prepare("SELECT last_height FROM indexer_state WHERE contract_id = ?").get(contractId) as any;
    return r ? Number(r.last_height) : undefined;
  }

  setIndexerCursor(contractId: string, height: number) {
    this.db.prepare(
      `INSERT INTO indexer_state (contract_id,last_height,updated_at) VALUES (?,?,?)
       ON CONFLICT(contract_id) DO UPDATE SET last_height=excluded.last_height, updated_at=excluded.updated_at`
    ).run(contractId, height, now());
  }
}

export function makeId(prefix: string) { return uid(prefix); }
