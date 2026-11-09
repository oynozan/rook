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
    -- Keyed by task and account: a record is written before Rook confirms who owns the task, so one account's record
    -- can never replace another's. contract_task_id is null until the transfer's outcome is read.
    CREATE TABLE IF NOT EXISTS funding (
      task_id TEXT NOT NULL, account TEXT NOT NULL, tx_hash TEXT, contract_task_id TEXT,
      refunded INTEGER NOT NULL DEFAULT 0, refund_tx TEXT, at INTEGER NOT NULL,
      PRIMARY KEY (task_id, account)
    );`);
  // The first version keyed funding_sent by task alone: carry its records over once (checked again under the write lock,
  // in case another process got there first).
  const legacy = () => d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'funding_sent'").get();
  if (legacy()) {
    d.exec('BEGIN IMMEDIATE');
    try {
      if (legacy()) {
        d.exec(`INSERT OR IGNORE INTO funding (task_id, account, tx_hash, contract_task_id, at)
          SELECT task_id, account, tx_hash, contract_task_id, at FROM funding_sent;
          DROP TABLE funding_sent;`);
      }
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  }
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

/**
 * A funding transfer this account's wallet sent for a task Rook hasn't bound yet. contract_task_id is null while only the
 * hash is known; refunded once the funder's close_task took the USDC back.
 */
export type FundingSent = { contract_task_id: string | null; tx_hash: string | null; refunded: boolean; refund_tx: string | null };

/**
 * Remembers a transfer: by its hash as soon as the wallet returns one, then with the contract task it created once read.
 * A record that names a contract task is never pointed at another (false, nothing changes), and an unread hash is
 * replaced only by a record that names its contract task. A refunded record starts over.
 */
export function recordFundingSent(task_id: string, account: string, f: { contract_task_id: string | null; tx_hash: string | null }): boolean {
  const was = fundingSent(task_id, account);
  const live = was && !was.refunded ? was : null;
  if (live?.contract_task_id) {
    // The same contract task, or its own hash again, changes nothing; anything else is refused.
    return f.contract_task_id === live.contract_task_id || (f.contract_task_id === null && f.tx_hash === live.tx_hash);
  }
  if (live && f.contract_task_id === null) return f.tx_hash === live.tx_hash;
  db().prepare('INSERT OR REPLACE INTO funding (task_id, account, tx_hash, contract_task_id, at) VALUES (?, ?, ?, ?, ?)')
    .run(task_id, account, f.tx_hash ?? live?.tx_hash ?? null, f.contract_task_id, Date.now());
  return true;
}

/** Forgets an unread transfer that turned out to move no USDC (it failed, or the contract refunded it at once). */
export function forgetUnreadFunding(task_id: string, account: string, tx_hash: string) {
  db().prepare('DELETE FROM funding WHERE task_id = ? AND account = ? AND contract_task_id IS NULL AND tx_hash = ?').run(task_id, account, tx_hash);
}

/** Forgets a record naming a contract task that Rook says funds another task, so this one can be funded again. */
export function forgetFundingOf(task_id: string, account: string, contract_task_id: string) {
  db().prepare('DELETE FROM funding WHERE task_id = ? AND account = ? AND contract_task_id = ? AND refunded = 0').run(task_id, account, contract_task_id);
}

/** The funder's close_task refunded `contract_task_id`. False if this task's record names another contract task. */
export function markFundingRefunded(task_id: string, account: string, contract_task_id: string, refund_tx: string | null): boolean {
  const was = fundingSent(task_id, account);
  if (was?.contract_task_id && was.contract_task_id !== contract_task_id) return false;
  db().prepare('INSERT OR REPLACE INTO funding (task_id, account, tx_hash, contract_task_id, refunded, refund_tx, at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(task_id, account, was?.tx_hash ?? null, contract_task_id, refund_tx, Date.now());
  return true;
}

export function fundingSent(task_id: string, account: string): FundingSent | null {
  const row = db().prepare('SELECT contract_task_id, tx_hash, refunded, refund_tx FROM funding WHERE task_id = ? AND account = ?').get(task_id, account) as
    { contract_task_id: string | null; tx_hash: string | null; refunded: number; refund_tx: string | null } | undefined;
  return row ? { contract_task_id: row.contract_task_id, tx_hash: row.tx_hash, refunded: row.refunded === 1, refund_tx: row.refund_tx } : null;
}
