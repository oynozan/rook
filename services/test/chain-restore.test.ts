// ROOK_LEDGER=chain across restarts and kills, offline: a mock signer and chain-gateway share one fake contract and
// USDC balances; a fake market lets a test decide when an agent delivers and whether CancelTask is accepted.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'rook-restore-'));
Object.assign(process.env, {
  ROOK_LLM: 'canned', ROOK_MARKET: 'sim', ROOK_LEDGER: 'chain', NEAR_NETWORK: 'testnet', ROOK_CONTRACT_ID: 'rook.test',
  ROOK_POLL_MS: '20', ROOK_PAYMENT_GRACE_S: '1', ROOK_DB: join(dir, 'rook.sqlite'),
});
const { serve, call, HttpError } = await import('../src/shared/http.ts');
const { start } = await import('../src/orchestrator/index.ts');
const { openStore } = await import('../src/orchestrator/db.ts');
type Running = Awaited<ReturnType<typeof serve>>;

// ---- the fake contract, balances and signer state ----
type CSub = { n: number; account_id: string; cap: string; topped_up: string; returned: string; status: string; attempt: number; pending_top_up: string };
const contract = new Map<string, { task: any; subs: CSub[] }>();
const bal = new Map<string, bigint>();
const auths = new Map<string, { amount: bigint; landed: boolean; until: number }>(); // account -> outstanding authorization
const calls: string[] = [];
const acct = (cid: string, n: number) => `t${cid}-${n}.rook.test`;
const openContractTask = (cid: string, caps: string[]) =>
  contract.set(cid, { task: { funder: 'owner.test', budget: '1000000', reserve: '200000', caps, status: 'Open', killed: false }, subs: [] });
const sub = (cid: string, n: number) => contract.get(cid)!.subs.find((s) => s.n === n)!;
let authTtlMs = 60_000;

// ---- the fake market: an agent's A2A task stays WORKING until a test moves it ----
const PRICE: Record<string, string> = { slowpoke: '300000', stubborn: '100000' };
const X402 = { network: 'near:testnet', asset: 'usdc.test', payTo: 'treasury.test' };
const row = (amount: string) => ({ scheme: 'exact', ...X402, amount, maxTimeoutSeconds: 60 });
const a2a = new Map<string, { handle: string; state: string }>();

const servers: Running[] = [];
before(async () => {
  servers.push(await serve('mock-signer', {
    'POST /keys': ({ body }) => (calls.push(`keys ${body.task_id}/${body.n}`), { public_key: 'ed25519:x' }),
    'POST /sign': ({ body }) => {
      calls.push(`sign ${body.account_id} ${body.row.amount}`);
      if (auths.has(body.account_id)) throw new HttpError(409, 'outstanding authorization');
      if (BigInt(body.row.amount) > (bal.get(body.account_id) ?? 0n)) throw new HttpError(409, 'exceeds the sub-account balance');
      auths.set(body.account_id, { amount: BigInt(body.row.amount), landed: false, until: Date.now() + authTtlMs });
      const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: body.row, payload: { signedDelegateAction: 'AA==' } })).toString('base64');
      return { header, payment_hash: `ph-${body.account_id}`, expires_at_block: 1, nonce: '1' };
    },
    'POST /expire': ({ body }) => {
      const a = acct(body.task_id, body.n), out = auths.get(a);
      if (!out) return { cleared: false, outstanding: false };
      if (!out.landed && !body.terminal_unpaid && Date.now() <= out.until) throw new HttpError(409, 'still valid');
      auths.delete(a);
      calls.push(`expire ${a} landed=${out.landed}`);
      return { cleared: true, landed: out.landed };
    },
    'POST /return': ({ body }) => {
      if (auths.has(body.account_id)) throw new HttpError(409, 'outstanding authorization');
      const amount = bal.get(body.account_id) ?? 0n;
      if (!amount) throw new HttpError(409, 'empty');
      bal.set(body.account_id, 0n);
      Object.assign(sub(body.task_id, body.n), { status: 'Returned', returned: String(amount) });
      calls.push(`return ${body.account_id} ${amount}`);
      return { tx_hash: 'r', amount: String(amount) };
    },
    'POST /kill': ({ body }) => (calls.push(`signer-kill ${body.task_id}`), { killed: true }),
  }, 0));
  servers.push(await serve('mock-chain-gateway', {
    'GET /config': () => ({ network: 'testnet', contract_id: 'rook.test', owner: 'owner.test', usdc: 'usdc.test' }),
    'GET /task/:id': ({ params }) => {
      const x = contract.get(params.id);
      if (!x) throw new HttpError(404, `no contract task ${params.id}`);
      return { task: x.task, subtasks: x.subs };
    },
    'POST /fund': async ({ body }) => {
      if (body.task_id === 'slow') await new Promise((ok) => setTimeout(ok, 300)); // a kill lands while this is in flight
      const x = contract.get(body.task_id)!, cap = x.task.caps[body.n - 1];
      x.subs.push({ n: body.n, account_id: acct(body.task_id, body.n), cap, topped_up: '0', returned: '0', status: 'Funded', attempt: 0, pending_top_up: '0' });
      bal.set(acct(body.task_id, body.n), BigInt(cap));
      calls.push(`fund ${body.task_id}/${body.n}`);
      return { tx_hash: 'f', success: true };
    },
    'POST /receipt': ({ body }) => (calls.push(`receipt ${body.task_id}/${body.n} ${body.receipt.amount} ${body.receipt.verdict}`), { tx_hash: 'rtx', explorer_url: 'https://testnet.nearblocks.io/txns/rtx' }),
    'POST /mark-empty': ({ body }) => {
      const s = sub(body.task_id, body.n), marked = s.status === 'Funded' && !(bal.get(s.account_id) ?? 0n);
      if (marked) s.status = 'Returned';
      calls.push(`mark-empty ${body.task_id}/${body.n} ${marked}`);
      return { tx_hash: 'm', success: true, marked };
    },
    'POST /close': ({ body }) => {
      const x = contract.get(body.task_id)!;
      if (x.subs.some((s) => s.status === 'Funded')) throw new HttpError(502, 'close_task failed: a subtask has not returned its leftover');
      x.task.status = 'Closed';
      calls.push(`close ${body.task_id}`);
      return { tx_hash: 'c', success: true };
    },
    'GET /balance': ({ query }) => ({ balance: String(bal.get(query.get('account')!) ?? 0n) }),
    'GET /payment': () => ({ found: false, tries: 1, error: null }),
  }, 0));
  servers.push(await serve('fake-market-gateway', {
    'GET /x402': () => ({ x402Version: 2, recipients: [X402] }),
    'POST /quote': ({ body }) => ({ ok: true, row: row(PRICE[body.handle]) }),
    'POST /send': ({ body }) => {
      const id = `a2a-${a2a.size + 1}`;
      a2a.set(id, { handle: body.handle, state: 'WORKING' });
      calls.push(`send ${body.handle} ${id}`);
      return { ok: true, task: { id, context_id: 'ctx', state: 'WORKING', artifacts: [] } };
    },
    'GET /task': ({ query }) => {
      const x = a2a.get(query.get('id')!)!;
      return { ok: true, task: { id: query.get('id'), context_id: 'ctx', state: x.state, artifacts: x.state === 'COMPLETED' ? [{ parts: [{ text: 'Holders report' }] }] : [] } };
    },
    'POST /cancel': ({ body }) => (a2a.get(body.id)!.handle === 'stubborn'
      ? { ok: false, error: { code: -32002, message: 'Task cannot be canceled in state WORKING' } }
      : (a2a.get(body.id)!.state = 'CANCELED', { ok: true })),
  }, 0));
  const planFor = (handle: string) => ({
    subtasks: [{
      id: 's1', title: 'Holders', brief: 'Holders\nPlease report.', search_terms: ['holders'], cap_atomic: PRICE[handle], deadline_s: 60, self_do: false,
      criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: '.' } }],
      candidates: [{ handle, name: handle, description: handle, sla_seconds: 60, success_rate: null, delivered_jobs: 0, price_atomic: PRICE[handle], quote: row(PRICE[handle]) }],
    }],
    dropped: [], notes: [], llm_calls: [],
    budget: { budget_atomic: '1000000', reserve_atomic: '200000', allocatable_atomic: '800000', allocated_atomic: PRICE[handle] },
  });
  servers.push(await serve('fake-planner', {
    'POST /plan': ({ body }) => planFor(body.prompt),
    'POST /aggregate': () => ({ final_markdown: 'final', attribution: [], llm_calls: [] }),
  }, 0));
  servers.push(await serve('fake-evaluator', {
    'POST /evaluate': () => ({ verdict: 'pass', results: [], failed_criteria: [], security_flags: [], extracted: {}, llm_calls: [], engine: 'local', attestation_hash: 'att' }),
  }, 0));
  const [signer, gateway, market, planner, evaluator] = servers;
  Object.assign(process.env, { SIGNER_URL: signer.url, CHAIN_GATEWAY_URL: gateway.url, MARKET_GATEWAY_URL: market.url, PLANNER_URL: planner.url, EVALUATOR_URL: evaluator.url });
});
after(async () => {
  for (const s of servers) await s.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; ; await new Promise((ok) => setTimeout(ok, 25))) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
  }
}
const snap = (orch: Running, id: string) => call(`${orch.url}/tasks/${id}`);
const events = async (orch: Running, id: string) =>
  (await fetch(`${orch.url}/tasks/${id}/events`).then((r) => r.text())).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
/** Plans, approves and funds a task with the human's transfer already made as contract task `cid`; returns at 'working'. */
async function fundedAndWorking(orch: Running, handle: string, cid: string) {
  const t = await call(`${orch.url}/tasks`, { prompt: handle, budget_usdc: '1' });
  await call(`${orch.url}/tasks/${t.id}/approve`, {});
  openContractTask(cid, [PRICE[handle]]);
  await call(`${orch.url}/tasks/${t.id}/funded`, { contract_task_id: cid });
  await until(async () => (await snap(orch, t.id)).subtasks[0].status === 'working');
  return t.id as string;
}

test('restart mid-hire: rebuilt from the contract, the hire is polled again by its A2A task id, paid once, closed', async () => {
  let orch = await start(0);
  const id = await fundedAndWorking(orch, 'slowpoke', 'a');
  const before = await snap(orch, id);
  await orch.close(); // the services stop with the payment header out

  // While Rook is down the agent delivers and the marketplace settles the payment from the sub-account.
  const a2aId = before.subtasks[0].hires[0].a2a_task_id, account = acct('a', 1);
  a2a.get(a2aId)!.state = 'COMPLETED';
  auths.get(account)!.landed = true;
  bal.set(account, 0n);

  orch = await start(0);
  try {
    const s = await until(async () => { const x = await snap(orch, id); return ['closed', 'failed'].includes(x.task.status) ? x : false; });
    assert.equal(s.task.status, 'closed', s.task.error);
    assert.equal(calls.filter((c) => c.startsWith(`sign ${account}`)).length, 1); // never signed twice
    assert.equal(calls.filter((c) => c.startsWith('send slowpoke')).length, 1); // never sent twice
    assert.deepEqual(s.subtasks[0].hires.map((h: any) => [h.a2a_task_id, h.state, h.paid]), [[a2aId, 'COMPLETED', true]]);
    assert.deepEqual(s.receipts.map((r: any) => [r.agent_handle, r.amount_atomic, r.verdict, r.receipt_tx]), [['slowpoke', '300000', 'pass', 'rtx']]);
    assert.ok(calls.includes('mark-empty a/1 true') && calls.includes('close a'));
    assert.deepEqual([s.ledger.spent_atomic, s.ledger.refunded_atomic, s.ledger.invariant_holds, s.ledger.closed], ['300000', '700000', true, true]);
    const evs = await events(orch, id);
    assert.ok(evs.some((e) => e.type === 'ledger' && e.data.op === 'restored' && e.data.contract_task_id === 'a'));
    assert.ok(!evs.some((e) => e.type === 'task_status' && e.data.to === 'failed'));
  } finally { await orch.close(); }
});

test('kill in chain mode: the authorization is waited out, the sub-account returned and the task closed; kill_task stays the owner\'s', async () => {
  authTtlMs = 300; // the agent refuses CancelTask, so only the authorization's expiry frees the money
  const orch = await start(0);
  try {
    const id = await fundedAndWorking(orch, 'stubborn', 'b');
    const killed = await call(`${orch.url}/tasks/${id}/kill`, {});
    assert.equal(killed.status, 'killed');
    assert.match(killed.human_action, /kill_task json-args '\{"task_id":"b"\}'/);
    const live = events(orch, id); // opened while the money is still out: the stream stays open until the task is closed
    const s = await until(async () => { const x = await snap(orch, id); return x.ledger?.closed ? x : false; });
    assert.equal((await live).at(-1).data.op, 'closeTask');
    assert.equal(s.task.status, 'killed');
    assert.deepEqual([s.ledger.spent_atomic, s.ledger.refunded_atomic, s.receipts.length], ['0', '1000000', 0]);
    assert.ok(calls.includes('signer-kill b'));
    assert.ok(calls.indexOf(`expire ${acct('b', 1)} landed=false`) < calls.indexOf(`return ${acct('b', 1)} 100000`));
    assert.ok(calls.includes('close b'));
    // Every step is recorded after the killed status, and the event names the owner's kill_task.
    const evs = await events(orch, id);
    const at = evs.findIndex((e) => e.type === 'task_status' && e.data.to === 'killed');
    assert.match(evs.find((e) => e.type === 'ledger' && e.data.op === 'kill').data.human_action, /owner's call: near contract call-function .* kill_task json-args '\{"task_id":"b"\}'/);
    assert.deepEqual(evs.slice(at + 1).filter((e) => e.type === 'ledger').map((e) => e.data.op), ['clearing', 'release', 'returnLeftover', 'closeTask']);
    assert.equal(evs.find((e) => e.data.op === 'clearing').data.how, 'wait');
  } finally { await orch.close(); authTtlMs = 60_000; }
});

test('a kill while fund_subtask is in flight still brings that sub-account back', async () => {
  const orch = await start(0);
  try {
    const t = await call(`${orch.url}/tasks`, { prompt: 'slowpoke', budget_usdc: '1' });
    await call(`${orch.url}/tasks/${t.id}/approve`, {});
    openContractTask('slow', ['300000']);
    await call(`${orch.url}/tasks/${t.id}/funded`, { contract_task_id: 'slow' });
    await until(async () => calls.includes('keys slow/1'));
    await call(`${orch.url}/tasks/${t.id}/kill`, {});
    const s = await until(async () => { const x = await snap(orch, t.id); return x.ledger?.closed ? x : false; });
    assert.ok(calls.includes(`return ${acct('slow', 1)} 300000`) && calls.includes('close slow'));
    assert.ok(!calls.some((c) => c.startsWith(`sign ${acct('slow', 1)}`)));
    assert.deepEqual([s.task.status, s.ledger.killed, s.ledger.spent_atomic, s.ledger.refunded_atomic], ['killed', true, '0', '1000000']);
  } finally { await orch.close(); }
});

test('a killed task with money still on chain is unwound when the services start again', async () => {
  process.env.ROOK_DB = join(dir, 'killed.sqlite');
  openContractTask('c', ['300000']);
  contract.get('c')!.subs.push({ n: 1, account_id: acct('c', 1), cap: '300000', topped_up: '0', returned: '0', status: 'Funded', attempt: 0, pending_top_up: '0' });
  bal.set(acct('c', 1), 250_000n); // 50 000 was paid before the kill
  const ts = new Date().toISOString();
  const store = openStore(process.env.ROOK_DB);
  store.save({
    id: 't_killed', prompt: 'p', budget_atomic: '1000000', reserve_share: 0.2, funder: 'owner.test', owner: null, status: 'killed', error: null,
    created_at: ts, updated_at: ts, plan: null, receipts: [], events: [], final_result: null, llm_calls: [],
    subtasks: [{
      id: 's1', title: 'Holders', brief: 'b', search_terms: [], criteria: [], cap_atomic: '300000', deadline_s: 60, self_do: false, candidates: [],
      n: 1, status: 'working', final_outcome: null, rehire_count: 0, tried: [], hires: [], evaluations: [], accepted: null,
    }],
    chain: { contract_task_id: 'c', nmap: { 1: 1 }, accounts: { 1: acct('c', 1) }, auths: {} },
    ledger_saved: { closed: false, subtasks: [{ n: 1, balance_atomic: '250000' }] },
  });
  store.close();
  const orch = await start(0);
  try {
    const s = await until(async () => { const x = await snap(orch, 't_killed'); return x.ledger?.closed ? x : false; });
    assert.equal(s.task.status, 'killed');
    assert.ok(calls.includes(`return ${acct('c', 1)} 250000`) && calls.includes('close c'));
    assert.deepEqual([s.ledger.spent_atomic, s.ledger.refunded_atomic, s.subtasks[0].status], ['50000', '950000', 'returned']);
  } finally { await orch.close(); }
});
