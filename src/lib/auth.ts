import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DashRole } from "./core.js";

/**
 * Dashboard accounts (Slice F): password hashing and the permission
 * matrix. Passwords use scrypt from node:crypto with a per user salt;
 * session tokens are random, and only their SHA256 hash is stored.
 */

export const SESSION_COOKIE = "remiglo_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export const newSessionToken = () => randomBytes(32).toString("hex");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type DashAction = "view" | "create" | "approve" | "settings" | "team" | "teamManage";

/**
 * The permission matrix, in exactly one place:
 * - viewer: read only. No actions at all.
 * - operator: creates invoices, payouts, batches, recipients, schedules. Cannot approve.
 * - admin: operator rights plus approving batches, editing settings, creating team members.
 * - owner: admin rights plus changing roles and deactivating members.
 */
const MATRIX: Record<DashAction, DashRole[]> = {
  view: ["owner", "admin", "operator", "viewer"],
  create: ["owner", "admin", "operator"],
  approve: ["owner", "admin"],
  settings: ["owner", "admin"],
  team: ["owner", "admin"],
  teamManage: ["owner"],
};

export function can(role: DashRole, action: DashAction): boolean {
  return MATRIX[action].includes(role);
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export const clearSessionCookie = () => `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
