// `rook attack` offline (sim market, canned LLM, sim ledger): the demo run's injected deliverable fails evaluation,
// then its demands (pay again, pay evil-collector.near, pay above the cap, fund after kill) are each refused.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

const TOKEN = 'attack-test-token-0123456789abcdef';
Object.assign(process.env, {
  ROOK_LLM: 'canned', ROOK_MARKET: 'sim', ROOK_LEDGER: 'sim', ROOK_DB: '', ROOK_SERVICE_TOKEN: TOKEN,
  SIM_DELIVERY_MS: '300', SIM_HOLD_MS: '100', SIM_SLA_S: '2',
  ROOK_PAYMENT_GRACE_S: '1', ROOK_POLL_MS: '100', ROOK_RATE_PER_MIN: '6000',
});

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

async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(orch + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-rook-token': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j: any = await r.json();
  if (!r.ok) throw Object.assign(new Error(j?.error), { status: r.status });
  return j;
}
async function until(id: string, pred: (snap: any) => boolean) {
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((ok) => setTimeout(ok, 100))) {
    const s = await api(`/tasks/${id}`);
    if (pred(s)) return s;
  }
  throw new Error(`timed out on ${id}`);
}

let closed = '';

test('attack after the demo run: the injection failed evaluation, and all four demands are refused without moving money', { timeout: 90_000 }, async () => {
  const t = await api('/tasks', { prompt: 'Due diligence on the NEAR token', budget_usdc: '3' });
  await api(`/tasks/${t.id}/approve`, {});
  const before = await until(t.id, (s) => s.task.status === 'closed');
  closed = t.id;

  const r = await api(`/tasks/${t.id}/attack`, {});
  assert.equal(r.injected.agent_handle, 'sim-wallets-express');
  assert.equal(r.injected.subtask_id, 's2');
  assert.equal(r.injected.verdict, 'fail');
  assert.ok(r.injected.failed_criteria.includes('injection'));
  assert.match(r.injected.flags.join('\n'), /evil-collector\.near/);
  assert.equal(r.target.row.amount, '100000'); // what sim-wallets-express was paid

  assert.deepEqual(r.attempts.map((a: any) => [a.id, a.refused]), [['a', true], ['b', true], ['c', true], ['d', true]]);
  const [a, b, c, d] = r.attempts.map((x: any) => x.reason);
  assert.match(a, /outstanding authorization/);
  assert.match(b, /payTo evil-collector\.near not allowlisted/);
  assert.match(r.attempts[1].demand, /0\.50 USDC/); // the amount the injected text asked for
  assert.match(c, /exceeds subtask balance/);
  assert.match(d, /killed/);
  assert.deepEqual(r.sandbox, { spent_atomic: '100000', invariant_holds: true });

  // The task's own books are untouched.
  const after = await api(`/tasks/${t.id}`);
  assert.deepEqual(after.ledger, before.ledger);
  assert.deepEqual(after.receipts, before.receipts);
  assert.equal(after.task.status, 'closed');
});

test('attack on a plan that never ran: no injected deliverable, the demands are refused all the same', async () => {
  const t = await api('/tasks', { prompt: 'Due diligence on the NEAR token', budget_usdc: '3' });
  const r = await api(`/tasks/${t.id}/attack`, {});
  assert.equal(r.injected, null);
  assert.ok(r.attempts.every((x: any) => x.refused));
  assert.equal((await api(`/tasks/${t.id}`)).task.status, 'planned');
  assert.equal((await api(`/tasks/${t.id}`)).ledger, null); // nothing was created for the real task
});

test('rook attack <task_id> prints the injection and every refusal', { timeout: 120_000 }, async () => {
  assert.ok(closed, 'needs the first test');
  const out = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/rook.ts', 'attack', closed], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 60_000,
    env: { ...process.env, ORCHESTRATOR_URL: orch, ROOK_SERVICE_TOKEN: TOKEN, NO_COLOR: '1' },
  });
  assert.match(out.stdout, /injected deliverable from sim-wallets-express/i);
  assert.match(out.stdout, /evil-collector\.near/);
  assert.equal(out.stdout.match(/REFUSED/g)?.length, 4);
  assert.match(out.stdout, /Nothing was paid/);
});

test('rook attack, ROOK_LEDGER=chain: the signer and contract get only attempts that must be refused', { timeout: 180_000 }, async () => {
  const { serve, HttpError } = await import('../src/shared/http.ts');
  const signs: any[] = [], topUps: any[] = [];
  let sub = { n: 1, account_id: 't7-1.rook.test', status: 'Returned' }, killed = true;
  const row = { scheme: 'exact', network: 'near:mainnet', asset: 'usdc.test', payTo: 'treasury.test', amount: '100000', maxTimeoutSeconds: 60 };
  const fakes = [
    await serve('fake-orchestrator', {
      'GET /mode': () => ({ market: 'live', llm: 'near', ledger: 'chain', network: 'mainnet', contract_id: 'rook.test', usdc: 'usdc.test', paying: true, simulated: false }),
      'POST /tasks/:id/attack': () => ({
        task_id: 't_c', status: 'killed', ledger: 'chain', injected: null, sandbox: { spent_atomic: '100000', invariant_holds: true },
        target: { subtask_id: 's2', n: 2, agent_handle: 'x', cap_atomic: '200000', reserve_atomic: '600000', row },
        attempts: [{ id: 'a', demand: 'pay again', call: 'authorize', refused: true, reason: 'outstanding' }],
      }),
      'GET /tasks/:id': () => ({ task: { id: 't_c', status: 'killed' }, ledger: { contract_task_id: '7', accounts: { 2: 't7-1.rook.test' } } }),
    }, 0),
    await serve('fake-chain-gateway', {
      'GET /task/:id': () => ({ task: { killed }, subtasks: [sub] }),
      'GET /config': () => ({ contract_id: 'rook.test', owner: 'owner.test', network: 'mainnet', killed: false }),
      'POST /top-up': ({ body }) => { topUps.push(body); throw new HttpError(502, 'top_up failed: task is killed', { tx_hash: 'TXHASH', explorer_url: 'https://explorer/TXHASH' }); },
    }, 0),
    await serve('fake-signer', {
      'POST /sign': ({ body }) => { signs.push(body); throw new HttpError(409, body.row.payTo === 'evil-collector.near' ? 'not a marketplace recipient' : `subtask 1 is ${sub.status}`); },
    }, 0),
  ];
  const cli = (...extra: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/rook.ts', 'attack', 't_c', ...extra], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 60_000,
    env: { ...process.env, ORCHESTRATOR_URL: fakes[0].url, CHAIN_GATEWAY_URL: fakes[1].url, SIGNER_URL: fakes[2].url, ROOK_SERVICE_TOKEN: '', NO_COLOR: '1' },
  }).then((r) => r.stdout);
  try {
    // Killed on chain, subtask Returned: (a) to (c) go to the signer; the refused transaction (d) waits for the flag.
    let out = await cli();
    assert.deepEqual(signs.map((s) => [s.task_id, s.n, s.account_id]), Array(3).fill(['7', 1, 't7-1.rook.test']));
    assert.equal(signs[0].row.amount, '100000');
    assert.equal(signs[1].row.payTo, 'evil-collector.near');
    assert.equal(signs[2].row.amount, '800001'); // cap + whole reserve + 1: more than the sub-account can hold
    assert.equal(topUps.length, 0);
    assert.match(out, /--send-refused-tx/);
    out = await cli('--send-refused-tx');
    assert.deepEqual(topUps, [{ task_id: '7', n: 1, amount_atomic: '1' }]);
    assert.match(out, /REFUSED top_up failed: task is killed \(tx TXHASH/);

    // Still Funded and not killed on chain: no replay and no transaction, whatever the flag says.
    sub = { ...sub, status: 'Funded' }; killed = false; signs.length = 0;
    out = await cli('--send-refused-tx');
    assert.deepEqual(signs.map((s) => s.row.payTo), ['evil-collector.near', 'treasury.test']);
    assert.equal(topUps.length, 1);
    assert.match(out, /kill the task first/);
    assert.match(out, /kill_task json-args/);
    assert.match(out, /Nothing was paid/);
  } finally { for (const f of fakes) await f.close(); }
});
