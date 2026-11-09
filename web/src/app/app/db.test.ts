// The web server's store: one-time nonces, revocable sessions and the per-account draft limit survive in SQLite.
// Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createSession, fundingSent, recordFundingSent, revokeSession, sessionAccount, spendNonce, takeDraftSlot } from './db';

const dir = mkdtempSync(join(tmpdir(), 'rook-web-db-'));
process.env.ROOK_WEB_DB = join(dir, 'web.sqlite'); // read on first use
after(() => {
  (globalThis as { __rookWebDb?: { close(): void } }).__rookWebDb?.close();
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

test('a funding transfer is remembered for its owner only', () => {
  recordFundingSent('t1', 'ops.near', { contract_task_id: '1a', tx_hash: null });
  assert.deepEqual(fundingSent('t1', 'ops.near'), { contract_task_id: '1a', tx_hash: null });
  assert.equal(fundingSent('t1', 'someone.near'), null);
  assert.equal(fundingSent('t2', 'ops.near'), null);
});
