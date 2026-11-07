// End-to-end: all five services in one process, sim market + canned LLM. Acceptance check A (docs section 12).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

// Never touch NEAR AI or the real market; fast simulator timings. Set before importing services.
Object.assign(process.env, {
  ROOK_LLM: 'canned', ROOK_MARKET: 'sim',
  SIM_DELIVERY_MS: '300', SIM_HOLD_MS: '100', SIM_SLA_S: '2',
  ROOK_PAYMENT_GRACE_S: '1', ROOK_POLL_MS: '100', ROOK_RATE_PER_MIN: '6000', // the bucket guards market.near.ai, not the local simulator
});

const { call } = await import('../src/shared/http.ts');
const services: [string, () => Promise<{ url: string; close: () => Promise<void> }>][] = [
  ['SIMULATOR', async () => (await import('../src/simulator/index.ts')).start(0)],
  ['MARKET_GATEWAY', async () => (await import('../src/market-gateway/index.ts')).start(0)],
  ['PLANNER', async () => (await import('../src/planner/index.ts')).start(0)],
  ['EVALUATOR', async () => (await import('../src/evaluator/index.ts')).start(0)],
  ['ORCHESTRATOR', async () => (await import('../src/orchestrator/index.ts')).start(0)],
];
const running: { close: () => Promise<void> }[] = [];
let orch = '';

before(async () => {
  for (const [name, start] of services) {
    const r = await start();
    process.env[`${name}_URL`] = r.url;
    running.push(r);
  }
  orch = process.env.ORCHESTRATOR_URL!;
});
after(async () => { for (const r of running.reverse()) await r.close(); });

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function waitFor(id: string, pred: (snap: any) => boolean, ms = 60_000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) {
    const snap = await call(`${orch}/tasks/${id}`);
    if (pred(snap)) return snap;
  }
  throw new Error(`timed out waiting on task ${id}`);
}
/** The SSE stream replays every event and ends once the task is terminal. */
async function events(id: string): Promise<any[]> {
  const text = await (await fetch(`${orch}/tasks/${id}/events`)).text();
  return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

test('acceptance A: plan, faults caught, re-hires from the reserve, closed with 1.20 spent', { timeout: 90_000 }, async () => {
  const task = await call(`${orch}/tasks`, { prompt: 'Due diligence on the NEAR token', budget_usdc: '3' });
  assert.equal(task.status, 'planned', task.error);
  const plan = task.plan;
  assert.deepEqual(plan.subtasks.map((s: any) => s.cap_atomic), ['300000', '200000', '240000', '160000']);
  assert.equal(plan.budget.reserve_atomic, '600000');
  assert.equal(plan.budget.allocated_atomic, '900000');
  assert.deepEqual(plan.subtasks.map((s: any) => s.candidates.map((c: any) => c.handle)), [
    ['sim-holders-lite', 'sim-holders'], ['sim-wallets-express', 'sim-wallets'],
    ['sim-tokencheck-fast', 'sim-tokencheck'], ['sim-price-slow', 'sim-price'],
  ]);
  for (const s of plan.subtasks) assert.ok(s.criteria.length > 0);

  await call(`${orch}/tasks/${task.id}/approve`, {});
  const snap = await waitFor(task.id, (s) => ['closed', 'failed', 'killed'].includes(s.task.status));
  assert.equal(snap.task.status, 'closed', snap.task.error);

  const receipts = (sid: string) => snap.receipts.filter((r: any) => r.subtask_id === sid).map((r: any) => [r.agent_handle, r.verdict]);
  assert.deepEqual(receipts('s1'), [['sim-holders-lite', 'fail'], ['sim-holders', 'pass']]);
  assert.deepEqual(receipts('s2'), [['sim-wallets-express', 'fail'], ['sim-wallets', 'pass']]);
  assert.deepEqual(receipts('s3'), [['sim-tokencheck', 'pass']]);
  assert.deepEqual(receipts('s4'), [['sim-price', 'pass']]);
  assert.equal(snap.receipts.length, 6);

  const hires = (sid: string) => snap.subtasks.find((s: any) => s.id === sid).hires.map((h: any) => [h.agent_handle, h.state]);
  assert.deepEqual(hires('s3'), [['sim-tokencheck-fast', 'FAILED'], ['sim-tokencheck', 'COMPLETED']]);
  assert.deepEqual(hires('s4'), [['sim-price-slow', 'TIMEOUT'], ['sim-price', 'COMPLETED']]);

  const evs = await events(task.id);
  const alert = evs.find((e) => e.type === 'security_alert' && e.data.agent_handle === 'sim-wallets-express');
  assert.match(alert.data.flag, /evil-collector\.near|X-PAYMENT|ignore previous/i);
  const topUps = evs.filter((e) => e.type === 'ledger' && e.data.op === 'topUp').map((e) => [e.subtask_id, e.data.amount_atomic]);
  assert.deepEqual(topUps.sort(), [['s1', '150000'], ['s2', '100000'], ['s3', '10000'], ['s4', '40000']]);
  assert.equal(evs.at(-1).data.to, 'closed');

  const sum = snap.receipts.reduce((x: bigint, r: any) => x + BigInt(r.amount_atomic), 0n);
  assert.equal(sum, 1_200_000n);
  assert.equal(snap.ledger.spent_atomic, '1200000');
  assert.equal(snap.ledger.reserve_used_atomic, '300000');
  assert.equal(snap.ledger.refunded_atomic, '1800000');
  assert.equal(snap.ledger.invariant_holds, true);

  assert.deepEqual(snap.final_result.attribution, [
    { subtask_id: 's1', agent_handle: 'sim-holders' }, { subtask_id: 's2', agent_handle: 'sim-wallets' },
    { subtask_id: 's3', agent_handle: 'sim-tokencheck' }, { subtask_id: 's4', agent_handle: 'sim-price' },
  ]);
  for (const h of ['sim-holders', 'sim-wallets', 'sim-tokencheck', 'sim-price']) assert.ok(snap.final_result.final_markdown.includes(h));
  assert.ok(!snap.final_result.final_markdown.includes('evil-collector'));
});

test('kill during a run: killed, authorizations released, no hire after the kill', { timeout: 30_000 }, async () => {
  const task = await call(`${orch}/tasks`, { prompt: 'Due diligence on the NEAR token', budget_usdc: '3' });
  await call(`${orch}/tasks/${task.id}/approve`, {});
  // sim-price-slow holds an authorization for its whole SLA, so a kill now has something to release.
  await waitFor(task.id, (s) => s.subtasks.find((x: any) => x.id === 's4').hires.some((h: any) => h.agent_handle === 'sim-price-slow' && h.a2a_task_id), 10_000);
  const killed = await call(`${orch}/tasks/${task.id}/kill`, {});
  assert.equal(killed.status, 'killed');

  await sleep(1500);
  const snap = await call(`${orch}/tasks/${task.id}`);
  assert.equal(snap.task.status, 'killed');
  assert.ok(snap.ledger.killed);
  assert.ok(snap.ledger.subtasks.every((s: any) => s.authorized_atomic === null));
  assert.ok(snap.ledger.invariant_holds);
  const open = snap.subtasks.flatMap((s: any) => s.hires).filter((h: any) => ['SENDING', 'SUBMITTED', 'WORKING'].includes(h.state));
  assert.deepEqual(open, []);
  const evs = await events(task.id);
  const k = evs.findIndex((e) => e.type === 'ledger' && e.data.op === 'kill');
  assert.ok(k > 0);
  assert.ok(evs.slice(k).every((e) => e.type !== 'hire_sent'));
  assert.ok(evs.slice(k).some((e) => e.type === 'ledger' && e.data.op === 'release'));
  assert.equal(evs.at(-1).data.to, 'killed');
  await assert.rejects(call(`${orch}/tasks/${task.id}/approve`, {}), /killed/);
});
