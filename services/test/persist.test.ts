import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// Never touch NEAR AI or the real market. Each test gets its own database file.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';

const { serve, call } = await import('../src/shared/http.ts');
const { start } = await import('../src/orchestrator/index.ts');
const { openStore } = await import('../src/orchestrator/db.ts');

const dir = mkdtempSync(join(tmpdir(), 'rook-persist-'));
let n = 0;
const freshDb = () => (process.env.ROOK_DB = join(dir, `t${++n}.sqlite`));

const plan = {
  subtasks: [{
    id: 's1', title: 'Holders', brief: 'Holders\nPlease report.', search_terms: ['holders'], cap_atomic: '300000', deadline_s: 5, self_do: false,
    criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: '.' } }],
    candidates: [{ handle: 'holders-good', name: 'holders-good', description: '', sla_seconds: 5, success_rate: null, delivered_jobs: 0, price_atomic: '300000', quote: {} }],
  }],
  dropped: [],
  budget: { budget_atomic: '1000000', reserve_atomic: '200000', allocatable_atomic: '800000', allocated_atomic: '300000' },
  llm_calls: [],
};

let planner: Awaited<ReturnType<typeof serve>>;
before(async () => {
  planner = await serve('planner', { 'POST /plan': () => plan }, 0);
  process.env.PLANNER_URL = planner.url;
});
after(async () => {
  await planner.close();
  delete process.env.ROOK_DB;
  rmSync(dir, { recursive: true, force: true });
});

test('a planned task, its plan and its event history survive a restart', async () => {
  freshDb();
  let orch = await start(0);
  const created = await call(`${orch.url}/tasks`, { prompt: 'Check NEAR holders', budget_usdc: '1' });
  assert.equal(created.status, 'planned');
  const before = await call(`${orch.url}/tasks/${created.id}`);
  await orch.close();

  orch = await start(0);
  const list = await call(`${orch.url}/tasks`);
  assert.deepEqual(list.tasks.map((t: any) => t.id), [created.id]);
  const after = await call(`${orch.url}/tasks/${created.id}`);
  assert.equal(after.task.status, 'planned');
  assert.deepEqual(after.plan, before.plan);
  assert.equal(after.subtasks.length, 1);
  await orch.close();
});

test('a task that was mid-run when the services stopped is marked failed, with the reason in its events', async () => {
  const path = freshDb();
  const ts = new Date().toISOString();
  const store = openStore(path);
  store.save({
    id: 't_running', prompt: 'p', budget_atomic: '1000000', reserve_share: 0.2, funder: 'funder.sim', owner: null, status: 'running', error: null,
    created_at: ts, updated_at: ts, plan: null, subtasks: [], receipts: [], final_result: null, llm_calls: [],
    events: [{ seq: 1, ts, task_id: 't_running', type: 'task_status', data: { from: null, to: 'draft' } }],
  });
  store.close();

  const orch = await start(0);
  const s = await call(`${orch.url}/tasks/t_running`);
  assert.equal(s.task.status, 'failed');
  assert.match(s.task.error, /restarted while this task was running/);
  await orch.close();

  // And the change itself was saved: the next start sees it already failed.
  const [doc] = openStore(path).load();
  assert.equal(doc.status, 'failed');
  assert.deepEqual(doc.events.at(-1)?.data, { from: 'running', to: 'failed' });
});

test('a finished task keeps what it spent and refunded, though the in-memory ledger forgot it', async () => {
  const path = freshDb();
  const ts = new Date().toISOString();
  const store = openStore(path);
  store.save({
    id: 't_done', prompt: 'p', budget_atomic: '3000000', reserve_share: 0.2, funder: 'funder.sim', owner: null, status: 'closed', error: null,
    created_at: ts, updated_at: ts, plan: null, subtasks: [], receipts: [], events: [], llm_calls: [],
    final_result: { final_markdown: '# Report', attribution: [], abandoned: [] },
    ledger_saved: { spent_atomic: '1200000', refunded_atomic: '1800000' },
  });
  store.close();

  const orch = await start(0);
  const s = await call(`${orch.url}/tasks/t_done`);
  assert.equal(s.task.status, 'closed');
  assert.equal(s.ledger.spent_atomic, '1200000');
  assert.equal(s.ledger.refunded_atomic, '1800000');
  assert.equal(s.final_result.final_markdown, '# Report');
  await orch.close();
});

test('without ROOK_DB nothing is stored', async () => {
  delete process.env.ROOK_DB;
  let orch = await start(0);
  const created = await call(`${orch.url}/tasks`, { prompt: 'Memory only', budget_usdc: '1' });
  await orch.close();
  orch = await start(0);
  const list = await call(`${orch.url}/tasks`);
  assert.equal(list.tasks.some((t: any) => t.id === created.id), false);
  await orch.close();
});

test('tasks belong to the account that drafted them', async () => {
  freshDb();
  const orch = await start(0);
  const mine = await call(`${orch.url}/tasks`, { prompt: 'Mine', budget_usdc: '1', owner: 'alice.near' });
  const theirs = await call(`${orch.url}/tasks`, { prompt: 'Theirs', budget_usdc: '1', owner: 'bob.near' });
  await call(`${orch.url}/tasks`, { prompt: 'From the CLI', budget_usdc: '1' });

  const list = async (q: string) => (await call(`${orch.url}/tasks${q}`)).tasks.map((t: any) => t.prompt).sort();
  assert.deepEqual(await list('?owner=alice.near'), ['Mine']);
  assert.deepEqual(await list('?owner=bob.near'), ['Theirs']);
  assert.equal((await list('')).length, 3); // no owner given: every task, as the CLI sees it

  // Someone else's task looks like no task at all, so its existence isn't revealed.
  await assert.rejects(call(`${orch.url}/tasks/${theirs.id}/cancel`, { owner: 'alice.near' }), (e: any) => e.status === 404);
  await assert.rejects(call(`${orch.url}/tasks/${theirs.id}/approve`, { owner: 'alice.near', funder_account: 'alice.near' }), (e: any) => e.status === 404);
  assert.equal((await call(`${orch.url}/tasks/${theirs.id}`)).task.status, 'planned');
  // The owner can.
  assert.equal((await call(`${orch.url}/tasks/${mine.id}/cancel`, { owner: 'alice.near' })).status, 'cancelled');
  await orch.close();
});
