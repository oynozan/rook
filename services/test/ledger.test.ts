import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createLedger, LedgerError } from '../src/orchestrator/ledger.ts';

const allow = [{ network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim' }];
const row = (amount: string, over: object = {}) => ({ scheme: 'exact', network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim', maxTimeoutSeconds: 60, amount, ...over });
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: any) => e instanceof LedgerError && re.test(e.reason));

test('happy path keeps the invariant and refunds the rest', () => {
  const l = createLedger();
  l.createTask('t', 'alice.near', 3_000_000n, 0.2); // reserve 0.60
  l.fundSubtask('t', 1, 300_000n);
  l.fundSubtask('t', 2, 200_000n);

  const a = l.authorize('t', 1, row('150000'), allow);
  const decoded = JSON.parse(Buffer.from(a.header, 'base64').toString());
  assert.equal(decoded.x402Version, 2);
  assert.deepEqual(decoded.accepted, row('150000'));
  assert.equal(decoded.payload.sim.task_id, 't');
  assert.equal(a.payment_hash, createHash('sha256').update(a.header).digest('hex'));
  assert.equal(l.settle('t', 1), 150_000n);

  assert.equal(l.topUp('t', 1, 150_000n), 150_000n); // balance 0.15 -> 0.30 for the re-hire
  l.authorize('t', 1, row('300000'), allow);
  l.settle('t', 1);

  l.authorize('t', 2, row('100000'), allow);
  assert.equal(l.release('t', 2), 100_000n); // FAILED: nothing charged
  l.authorize('t', 2, row('200000'), allow);
  l.settle('t', 2);

  assert.equal(l.returnLeftover('t', 1), 0n);
  assert.equal(l.returnLeftover('t', 2), 0n);
  assert.ok(l.holds('t'));
  assert.equal(l.closeTask('t'), 3_000_000n - 650_000n);
  const v = l.view('t')!;
  assert.equal(v.spent_atomic, 650_000n);
  assert.equal(v.reserve_used_atomic, 150_000n);
  assert.equal(v.refunded_atomic, 2_350_000n);
  assert.equal(v.unallocated_atomic + v.reserve_remaining_atomic, 0n);
  assert.ok(v.invariant_holds);
});

test('refusals', () => {
  const l = createLedger();
  l.createTask('t', 'alice.near', 1_000_000n, 0.2); // allocatable 0.80, reserve 0.20
  refused(() => l.fundSubtask('t', 1, 800_001n), /exceeds unallocated/);
  l.fundSubtask('t', 1, 300_000n);
  refused(() => l.topUp('t', 1, 200_001n), /exceeds remaining reserve/);
  refused(() => l.authorize('t', 1, row('300001'), allow), /exceeds subtask balance/);
  refused(() => l.authorize('t', 1, row('100000', { payTo: 'evil-collector.near' }), allow), /payTo/);
  refused(() => l.authorize('t', 1, row('100000', { asset: 'usdt.sim' }), allow), /asset/);
  l.authorize('t', 1, row('100000'), allow);
  refused(() => l.authorize('t', 1, row('100000'), allow), /outstanding/);
  refused(() => l.returnLeftover('t', 1), /outstanding/);
  refused(() => l.closeTask('t'), /not returned/);
  l.release('t', 1);
  refused(() => l.release('t', 1), /no outstanding/);

  l.kill('t');
  refused(() => l.authorize('t', 1, row('100000'), allow), /killed/);
  refused(() => l.fundSubtask('t', 2, 1n), /killed/);
  refused(() => l.topUp('t', 1, 1n), /killed/);
  assert.ok(l.holds('t'));
});
