// The web server's store: one-time nonces, revocable sessions and the per-account draft limit survive in SQLite.
// Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import {
  createSession, forgetFundingOf, forgetUnreadFunding, fundingSent, markFundingRefunded, recordFundingSent, revokeSession, sessionAccount,
  spendNonce, takeDraftSlot,
} from './db';

const dir = mkdtempSync(join(tmpdir(), 'rook-web-db-'));
process.env.ROOK_WEB_DB = join(dir, 'web.sqlite'); // read on first use
// A store from the first version, which keyed funding records by task alone: its record must carry over.
const first = new DatabaseSync(process.env.ROOK_WEB_DB);
first.exec(`CREATE TABLE funding_sent (task_id TEXT PRIMARY KEY, account TEXT NOT NULL, contract_task_id TEXT NOT NULL, tx_hash TEXT, at INTEGER NOT NULL);
  INSERT INTO funding_sent VALUES ('t0', 'ops.near', '9', 'H0', 1);`);
first.close();
after(() => {
  (globalThis as { __rookWebDbV2?: { close(): void } }).__rookWebDbV2?.close(); // the key db.ts names
  rmSync(dir, { recursive: true, force: true });
});

test('a nonce is spent once', () => {
  const exp = Date.now() + 60_000;
  assert.equal(spendNonce('n1', exp), true);
  assert.equal(spendNonce('n1', exp), false);
  assert.equal(spendNonce('n2', exp), true);
});

test('sessions: live until revoked or expired', () => {
  const id = createSession('alice.near', Date.now() + 60_000);
  assert.equal(sessionAccount(id), 'alice.near');
  revokeSession(id);
  assert.equal(sessionAccount(id), null);
  assert.equal(sessionAccount(createSession('bob.near', Date.now() - 1)), null);
  assert.equal(sessionAccount('made-up'), null);
});

test('drafts: at most the limit per window, per account', () => {
  for (let i = 0; i < 3; i++) assert.deepEqual(takeDraftSlot('carol.near', 3, 3_600_000), { ok: true });
  const refused = takeDraftSlot('carol.near', 3, 3_600_000);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.retryInS > 3500 && refused.retryInS <= 3600);
  assert.deepEqual(takeDraftSlot('dave.near', 3, 3_600_000), { ok: true });
  assert.deepEqual(takeDraftSlot('carol.near', 3, 0), { ok: true }); // a window that has passed frees the slots
});

const known = (contract_task_id: string | null, tx_hash: string | null) => ({ contract_task_id, tx_hash, refunded: false, refund_tx: null });

test('a funding record from the first store carries over', () => {
  assert.deepEqual(fundingSent('t0', 'ops.near'), known('9', 'H0'));
});

test('a funding transfer is remembered for its owner only', () => {
  assert.equal(recordFundingSent('t1', 'ops.near', { contract_task_id: '1a', tx_hash: null }), true);
  assert.deepEqual(fundingSent('t1', 'ops.near'), known('1a', null));
  assert.equal(fundingSent('t1', 'someone.near'), null);
  assert.equal(fundingSent('t2', 'ops.near'), null);
  // Another account writing for the same task id gets its own record and leaves the owner's alone.
  assert.equal(recordFundingSent('t1', 'someone.near', { contract_task_id: '66', tx_hash: 'HX' }), true);
  assert.deepEqual(fundingSent('t1', 'ops.near'), known('1a', null));
});

test('a transfer is remembered by its hash first, and never pointed at another contract task', () => {
  assert.equal(recordFundingSent('t3', 'ops.near', { contract_task_id: null, tx_hash: 'H1' }), true);
  assert.deepEqual(fundingSent('t3', 'ops.near'), known(null, 'H1'));
  assert.equal(recordFundingSent('t3', 'ops.near', { contract_task_id: null, tx_hash: 'H2' }), false); // a second unread hash
  assert.equal(recordFundingSent('t3', 'ops.near', { contract_task_id: '1b', tx_hash: null }), true); // read: its contract task
  assert.deepEqual(fundingSent('t3', 'ops.near'), known('1b', 'H1'));
  assert.equal(recordFundingSent('t3', 'ops.near', { contract_task_id: '1b', tx_hash: 'H1' }), true);
  assert.equal(recordFundingSent('t3', 'ops.near', { contract_task_id: null, tx_hash: 'H1' }), true);
  assert.equal(recordFundingSent('t3', 'ops.near', { contract_task_id: '1c', tx_hash: 'H9' }), false); // a pasted hash for another task
  assert.equal(recordFundingSent('t3', 'ops.near', { contract_task_id: null, tx_hash: 'H9' }), false);
  assert.deepEqual(fundingSent('t3', 'ops.near'), known('1b', 'H1'));
});

test('forgetting: an unread transfer that moved nothing, or a contract task that funds another task', () => {
  recordFundingSent('t4', 'ops.near', { contract_task_id: null, tx_hash: 'H4' });
  forgetUnreadFunding('t4', 'ops.near', 'H5');
  assert.deepEqual(fundingSent('t4', 'ops.near'), known(null, 'H4'));
  forgetUnreadFunding('t4', 'ops.near', 'H4');
  assert.equal(fundingSent('t4', 'ops.near'), null);

  recordFundingSent('t4', 'ops.near', { contract_task_id: '4a', tx_hash: 'H6' });
  forgetUnreadFunding('t4', 'ops.near', 'H6'); // read already: not forgotten by its hash
  forgetFundingOf('t4', 'ops.near', '4b');
  assert.deepEqual(fundingSent('t4', 'ops.near'), known('4a', 'H6'));
  forgetFundingOf('t4', 'ops.near', '4a');
  assert.equal(fundingSent('t4', 'ops.near'), null);
});

test('a refund is remembered, and a new transfer after it starts over', () => {
  recordFundingSent('t5', 'ops.near', { contract_task_id: '5a', tx_hash: 'H7' });
  assert.equal(markFundingRefunded('t5', 'ops.near', '5b', 'R0'), false); // not this task's contract task
  assert.equal(markFundingRefunded('t5', 'ops.near', '5a', 'R1'), true);
  assert.deepEqual(fundingSent('t5', 'ops.near'), { contract_task_id: '5a', tx_hash: 'H7', refunded: true, refund_tx: 'R1' });
  forgetFundingOf('t5', 'ops.near', '5a'); // a refunded record is kept
  assert.equal(fundingSent('t5', 'ops.near')?.refunded, true);
  assert.equal(recordFundingSent('t5', 'ops.near', { contract_task_id: null, tx_hash: 'H8' }), true);
  assert.deepEqual(fundingSent('t5', 'ops.near'), known(null, 'H8'));
  // A refund read for a task whose record is still unread names the contract task it closed.
  assert.equal(markFundingRefunded('t5', 'ops.near', '5c', null), true);
  assert.deepEqual(fundingSent('t5', 'ops.near'), { contract_task_id: '5c', tx_hash: 'H8', refunded: true, refund_tx: null });
});
