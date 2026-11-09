// The web server's own small store (server code only): spent sign-in nonces, sessions (so sign-out revokes them),
// the per-account draft rate limit, and funding transfers the browser reported, so a reload never offers to fund twice.
// node:sqlite comes through process.getBuiltinModule so the bundler never tries to resolve it.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// One connection per process. On globalThis because Next bundles route handlers, pages and actions separately.
const shared = globalThis as typeof globalThis & { __rookWebDb?: DatabaseSync };

function db(): DatabaseSync {
  if (shared.__rookWebDb) return shared.__rookWebDb;
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const file = process.env.ROOK_WEB_DB || join(process.cwd(), '.data', 'web.sqlite');
  mkdirSync(dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account TEXT NOT NULL, exp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (account TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS drafts_by_account ON drafts (account, at);
    CREATE TABLE IF NOT EXISTS funding_sent (
      task_id TEXT PRIMARY KEY, account TEXT NOT NULL, contract_task_id TEXT NOT NULL, tx_hash TEXT, at INTEGER NOT NULL
    );`);
  return (shared.__rookWebDb = d);
}

/** True the first time a nonce is spent, false ever after (until it would have expired anyway). */
export function spendNonce(nonce: string, exp: number): boolean {
  const d = db();
  d.prepare('DELETE FROM nonces WHERE exp < ?').run(Date.now());
  return Number(d.prepare('INSERT OR IGNORE INTO nonces (nonce, exp) VALUES (?, ?)').run(nonce, exp).changes) === 1;
}

export function createSession(account: string, exp: number): string {
  const id = randomBytes(24).toString('base64url');
  const d = db();
  d.prepare('DELETE FROM sessions WHERE exp < ?').run(Date.now());
  d.prepare('INSERT INTO sessions (id, account, exp) VALUES (?, ?, ?)').run(id, account, exp);
  return id;
}

/** The session's account while it is live and not signed out. */
export function sessionAccount(id: string): string | null {
  const row = db().prepare('SELECT account FROM sessions WHERE id = ? AND exp > ?').get(id, Date.now()) as { account: string } | undefined;
  return row?.account ?? null;
}

export function revokeSession(id: string) {
  db().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** Takes one of `limit` drafts per `windowMs` for this account, or says how long until the oldest frees up. */
export function takeDraftSlot(account: string, limit: number, windowMs: number): { ok: true } | { ok: false; retryInS: number } {
  const d = db();
  const now = Date.now();
  d.prepare('DELETE FROM drafts WHERE at <= ?').run(now - windowMs);
  const rows = d.prepare('SELECT at FROM drafts WHERE account = ? ORDER BY at ASC').all(account) as { at: number }[];
  if (rows.length >= limit) return { ok: false, retryInS: Math.max(1, Math.ceil((rows[0].at + windowMs - now) / 1000)) };
  d.prepare('INSERT INTO drafts (account, at) VALUES (?, ?)').run(account, now);
  return { ok: true };
}

export type FundingSent = { contract_task_id: string; tx_hash: string | null };

export function recordFundingSent(task_id: string, account: string, f: FundingSent) {
  db().prepare('INSERT OR REPLACE INTO funding_sent (task_id, account, contract_task_id, tx_hash, at) VALUES (?, ?, ?, ?, ?)')
    .run(task_id, account, f.contract_task_id, f.tx_hash, Date.now());
}

export function fundingSent(task_id: string, account: string): FundingSent | null {
  const row = db().prepare('SELECT contract_task_id, tx_hash FROM funding_sent WHERE task_id = ? AND account = ?').get(task_id, account) as FundingSent | undefined;
  return row ? { contract_task_id: row.contract_task_id, tx_hash: row.tx_hash } : null;
}
