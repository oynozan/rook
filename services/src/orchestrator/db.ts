// Task storage in SQLite (node:sqlite, built into Node 22.13+; no dependency). One row per task holding its JSON
// document: everything a snapshot needs, the event history the web app replays, and the ledger's last view.
// The orchestrator writes a task on every change and loads them all on start.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bigintReplacer } from '../shared/http.ts';
import type { Task } from './store.ts';

/** A task without its runtime parts (listeners, abort signal, in-flight hires, payee allowlist). */
export type TaskDoc = Omit<Task, 'listeners' | 'abort' | 'inflight' | 'allow'>;

const SCHEMA_VERSION = 1;

export function openStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    doc TEXT NOT NULL
  )`);
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > SCHEMA_VERSION) throw new Error(`${path} was written by a newer Rook (schema ${version}); this one reads ${SCHEMA_VERSION}`);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const upsert = db.prepare(`INSERT INTO tasks (id, status, created_at, updated_at, doc) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, doc = excluded.doc`);
  const all = db.prepare('SELECT doc FROM tasks ORDER BY created_at');

  return {
    save(doc: TaskDoc) {
      upsert.run(doc.id, doc.status, doc.created_at, doc.updated_at, JSON.stringify(doc, bigintReplacer));
    },
    load(): TaskDoc[] {
      return (all.all() as { doc: string }[]).map((r) => JSON.parse(r.doc));
    },
    close() { db.close(); },
  };
}

export type Store = ReturnType<typeof openStore>;
