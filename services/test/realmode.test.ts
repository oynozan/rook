// Real-mode profile (pnpm live), service token, /mode and request limits. Offline: fake planner, no network.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

const TOKEN = 'realmode-test-token-0123456789abcdef';
Object.assign(process.env, { ROOK_LLM: 'canned', ROOK_MARKET: 'sim', ROOK_LEDGER: 'sim', ROOK_SERVICE_TOKEN: TOKEN, ROOK_DB: '' });

const { serve } = await import('../src/shared/http.ts');
const { config, profileProblems } = await import('../src/shared/config.ts');
const orchestrator = await import('../src/orchestrator/index.ts');
const planner = await import('../src/planner/index.ts');
type Running = Awaited<ReturnType<typeof serve>>;

const run = promisify(execFile);
const SERVICES = fileURLToPath(new URL('..', import.meta.url));
const KEYS = ['ROOK_PROFILE', 'ROOK_MARKET', 'ROOK_LEDGER', 'ROOK_LLM', 'NEAR_NETWORK', 'NEAR_RPC_URL', 'ROOK_CONTRACT_ID', 'NEARAI_API_KEY',
  'ROOK_SERVICE_TOKEN', 'ROOK_SIGNER_ACCOUNT', 'ROOK_SIGNER_KEY', 'ROOK_ORCHESTRATOR_ACCOUNT', 'ROOK_ORCHESTRATOR_KEY'];
const LIVE: Record<string, string> = {
  ROOK_PROFILE: 'live', ROOK_MARKET: 'live', ROOK_LEDGER: 'chain', ROOK_LLM: 'near', NEAR_NETWORK: 'mainnet',
  NEAR_RPC_URL: 'http://127.0.0.1:9', ROOK_CONTRACT_ID: 'rook.example.near', NEARAI_API_KEY: 'test', ROOK_SERVICE_TOKEN: 'x'.repeat(32),
  ROOK_SIGNER_ACCOUNT: 'signer.example.near', ROOK_SIGNER_KEY: 'ed25519:test', ROOK_ORCHESTRATOR_ACCOUNT: 'orch.example.near', ROOK_ORCHESTRATOR_KEY: 'ed25519:test',
};
const SIM = { ROOK_MARKET: 'sim', ROOK_LEDGER: 'sim', ROOK_LLM: 'canned' };

/** Runs fn with exactly these mode variables (the rest of KEYS unset), then restores the environment. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try { return fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const problems = (vars: Record<string, string | undefined>, service?: string) => withEnv(vars, () => profileProblems(service));
/** A child process env with every mode variable set (empty means unset), so the repo's .env cannot fill one in. */
const childEnv = (vars: Record<string, string>) => ({ ...process.env, ...Object.fromEntries(KEYS.map((k) => [k, ''])), NO_COLOR: '1', ...vars });

test('profile rules: full sim and a complete live setup start; canned only in full sim; live+chain only on mainnet', () => {
  assert.deepEqual(problems(SIM), []);
  assert.equal(withEnv(SIM, () => config.simulated), true);
  assert.deepEqual(problems(LIVE), []);
  assert.equal(withEnv(LIVE, () => config.simulated), false);
  // The simulated market against a testnet contract (plan step 3) is still simulation, with a real LLM.
  assert.deepEqual(problems({ ROOK_MARKET: 'sim', ROOK_LEDGER: 'chain', ROOK_LLM: 'near' }), []);

  assert.match(problems({ ...SIM, ROOK_MARKET: 'live' }).join('\n'), /ROOK_LLM=canned runs only with ROOK_MARKET=sim and ROOK_LEDGER=sim/);
  assert.match(problems({ ...SIM, ROOK_LEDGER: 'chain' }).join('\n'), /ROOK_LLM=canned/);
  // canned is also what an unset ROOK_LLM means without NEARAI_API_KEY
  assert.match(problems({ ROOK_MARKET: 'live' }).join('\n'), /default without NEARAI_API_KEY/);
  assert.match(problems({ ROOK_MARKET: 'live', ROOK_LEDGER: 'chain', ROOK_LLM: 'near', NEAR_NETWORK: 'testnet' }).join('\n'), /needs NEAR_NETWORK=mainnet/);
  // Paying real agents needs the live profile, even with every variable present.
  assert.match(problems({ ...LIVE, ROOK_PROFILE: undefined }).join('\n'), /pnpm live/);
});

test('live profile lists everything missing; role keys are checked only where they are held', () => {
  const p = problems({ ROOK_PROFILE: 'live', ROOK_MARKET: 'live', NEARAI_API_KEY: 'test' }).join('\n');
  for (const k of ['ROOK_LEDGER=chain is required', 'ROOK_LLM=near is required (it is not set)', 'NEAR_NETWORK=mainnet is required', 'NEAR_RPC_URL is not set',
    'ROOK_CONTRACT_ID is not set', 'ROOK_SERVICE_TOKEN is not set', 'ROOK_SIGNER_KEY is not set', 'ROOK_ORCHESTRATOR_KEY is not set']) assert.ok(p.includes(k), k);
  const noSignerKey = { ...LIVE, ROOK_SIGNER_KEY: undefined };
  assert.match(problems(noSignerKey).join('\n'), /ROOK_SIGNER_KEY is not set/);
  assert.match(problems(noSignerKey, 'signer').join('\n'), /ROOK_SIGNER_KEY is not set/);
  assert.deepEqual(problems(noSignerKey, 'planner'), []);
  assert.deepEqual(problems(noSignerKey, 'chain-gateway'), []);
  assert.match(problems(LIVE, 'simulator').join('\n'), /simulator does not run in the live profile/);
  assert.match(problems({ ...LIVE, ROOK_SERVICE_TOKEN: 'short' }).join('\n'), /at least 32 characters/);
});

test('pnpm live (dev.ts --live) and a service started alone refuse to start, listing what is missing', { timeout: 120_000 }, async () => {
  const fail = (args: string[], env: Record<string, string>) =>
    run(process.execPath, ['--import', 'tsx', ...args], { cwd: SERVICES, env: childEnv(env), timeout: 60_000 }).then(
      () => assert.fail(`${args.join(' ')} started`), (e: any) => { assert.equal(e.code, 1, e.stderr); return String(e.stderr); });
  const live = await fail(['scripts/dev.ts', '--live'], { ROOK_MARKET: 'live' });
  assert.match(live, /live profile\) refuses to start/);
  for (const k of ['ROOK_LEDGER=chain is required', 'NEARAI_API_KEY is not set', 'NEAR_RPC_URL is not set', 'ROOK_SIGNER_KEY is not set']) assert.ok(live.includes(k), k);
  const dev = await fail(['scripts/dev.ts'], { ROOK_MARKET: 'live', ROOK_LEDGER: 'sim', ROOK_LLM: 'canned' });
  assert.match(dev, /sim profile\) refuses to start[\s\S]*ROOK_LLM=canned/);
  const { ROOK_SIGNER_KEY: _, ...noKey } = LIVE;
  assert.match(await fail(['scripts/service.ts', 'signer'], noKey), /signer\) refuses to start[\s\S]*ROOK_SIGNER_KEY is not set/);
});

// ---- orchestrator: token, /mode, limits, owners ----
const servers: Running[] = [];
let orch: Running;
const PLAN = {
  subtasks: [{
    id: 's1', title: 'T', brief: 'T\nReport.', search_terms: ['t'], cap_atomic: '100000', deadline_s: 5, self_do: false,
    criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: '.' } }],
    candidates: [{ handle: 'a', name: 'a', description: 'a', sla_seconds: 5, success_rate: null, delivered_jobs: 0, price_atomic: '100000',
      quote: { scheme: 'exact', network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim', amount: '100000', maxTimeoutSeconds: 60 } }],
  }],
  dropped: [], notes: [], llm_calls: [],
  budget: { budget_atomic: '1000000', reserve_atomic: '200000', allocatable_atomic: '800000', allocated_atomic: '100000' },
};
before(async () => {
  const fake = await serve('fake-planner', { 'POST /plan': () => PLAN }, 0);
  servers.push(fake);
  process.env.PLANNER_URL = fake.url;
  orch = await orchestrator.start(0);
});
after(async () => { await orch.close(); for (const s of servers) await s.close(); });

async function req(path: string, body?: unknown, token: string | null = TOKEN) {
  const r = await fetch(orch.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token === null ? {} : { 'x-rook-token': token }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
}

test('ROOK_SERVICE_TOKEN: every orchestrator route needs x-rook-token; /mode has the agreed shape', async () => {
  assert.equal((await req('/mode', undefined, null)).status, 401);
  assert.equal((await req('/mode', undefined, 'wrong')).status, 401);
  assert.equal((await req('/tasks', undefined, null)).status, 401);
  assert.equal((await req('/tasks', { prompt: 'p', budget_usdc: '1' }, null)).status, 401);
  assert.equal((await req('/tasks/t_x/events', undefined, null)).status, 401);
  const m = await req('/mode');
  assert.equal(m.status, 200);
  assert.deepEqual(m.body, { market: 'sim', llm: 'canned', ledger: 'sim', network: 'sim', contract_id: null, usdc: null, paying: false, simulated: true });
});

test('request limits: prompt at most 4000 characters, budget at most ROOK_MAX_BUDGET_USDC (default 50)', async () => {
  const long = await req('/tasks', { prompt: 'x'.repeat(4001), budget_usdc: '1' });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /4001 characters; the limit is 4000/);
  assert.equal((await req('/tasks', { prompt: 'x'.repeat(4000), budget_usdc: '1' })).body.status, 'planned');
  const big = await req('/tasks', { prompt: 'p', budget_usdc: '50.000001' });
  assert.equal(big.status, 400);
  assert.match(big.body.error, /above this Rook's limit of 50\.00 USDC/);
  assert.equal((await req('/tasks', { prompt: 'p', budget_usdc: '50' })).body.status, 'planned');
  process.env.ROOK_MAX_BUDGET_USDC = '2';
  try { assert.equal((await req('/tasks', { prompt: 'p', budget_usdc: '3' })).status, 400); } finally { delete process.env.ROOK_MAX_BUDGET_USDC; }

  // The planner checks the same limits before any LLM call.
  const p = await planner.start(0);
  servers.push(p);
  const plan = (body: object) => fetch(`${p.url}/plan`, { method: 'POST', body: JSON.stringify({ task_id: 't', reserve_share: 0.2, ...body }) });
  const r1 = await plan({ prompt: 'x'.repeat(4001), budget_atomic: '1000000' });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error, /limit is 4000/);
  assert.equal((await plan({ prompt: 'p', budget_atomic: '50000001' })).status, 400);
});

test('owners: every task route checks a named owner; /funded must name the owner; an unknown owner lists nothing', async () => {
  const t = (await req('/tasks', { prompt: 'alice task', budget_usdc: '1', owner: 'alice.near' })).body;
  assert.equal(t.status, 'planned');
  assert.equal((await req(`/tasks/${t.id}?owner=bob.near`)).status, 404);
  assert.equal((await req(`/tasks/${t.id}?owner=alice.near`)).status, 200);
  assert.equal((await req(`/tasks/${t.id}/events?owner=bob.near`)).status, 404);
  assert.equal((await req(`/tasks/${t.id}/attack`, { owner: 'bob.near' })).status, 404);
  for (const op of ['approve', 'cancel', 'kill']) assert.equal((await req(`/tasks/${t.id}/${op}`, { owner: 'bob.near' })).status, 404, op);
  assert.equal((await req(`/tasks/${t.id}/funded`, { contract_task_id: '1' })).status, 403);
  assert.equal((await req(`/tasks/${t.id}/funded`, { contract_task_id: '1', owner: 'bob.near' })).status, 404);
  const own = await req(`/tasks/${t.id}/funded`, { contract_task_id: '1', owner: 'alice.near' });
  assert.equal(own.status, 409); // past the owner check: sim ledger has nothing to fund
  assert.match(own.body.error, /ROOK_LEDGER=chain/);
  assert.deepEqual((await req('/tasks?owner=carol.near')).body.tasks, []);
  assert.deepEqual((await req('/tasks?owner=alice.near')).body.tasks.map((x: any) => x.id), [t.id]);
});

test('rook CLI sends ROOK_SERVICE_TOKEN as x-rook-token', { timeout: 120_000 }, async () => {
  const cli = (token: string) => run(process.execPath, ['--import', 'tsx', 'scripts/rook.ts', 'list'], {
    cwd: SERVICES, env: childEnv({ ...SIM, ORCHESTRATOR_URL: orch.url, ROOK_SERVICE_TOKEN: token }), timeout: 60_000,
  });
  assert.match((await cli(TOKEN)).stdout, /alice task|planned/);
  await assert.rejects(cli(''), (e: any) => e.code === 1 && /ROOK_SERVICE_TOKEN/.test(e.stderr));
});
