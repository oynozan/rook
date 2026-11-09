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
type CSub = { n: number; account_id: string; cap: string; topped_up: string; returned: string; status: string; attempt: number; pending_top_up: string; account_exists?: boolean };
const contract = new Map<string, { task: any; subs: CSub[] }>();
const bal = new Map<string, bigint>();
const auths = new Map<string, { amount: bigint; landed: boolean; until: number }>(); // account -> outstanding authorization
const calls: string[] = [];
const acct = (cid: string, n: number) => `t${cid}-${n}.rook.test`;
const openContractTask = (cid: string, caps: string[]) =>
  contract.set(cid, { task: { funder: 'owner.test', budget: '1000000', reserve: '200000', caps, status: 'Open', killed: false }, subs: [] });
const sub = (cid: string, n: number) => contract.get(cid)!.subs.find((s) => s.n === n)!;
const fundedSub = (cid: string, n: number, cap: string): CSub => ({ n, account_id: acct(cid, n), cap, topped_up: '0', returned: '0', status: 'Funded', attempt: 0, pending_top_up: '0', account_exists: true });
let authTtlMs = 60_000;
let openTasks = 0; // the funder's open tasks on the contract (its limit is 1 below)

// ---- the fake market: an agent's A2A task stays WORKING until a test moves it ----
const PRICE: Record<string, string> = { slowpoke: '300000', stubborn: '100000', hangs: '100000', alpha: '100000', beta: '100000' };
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
      calls.push(`expire ${a} landed=${out.landed}${body.terminal_unpaid ? ' terminal' : ''}`);
      return { cleared: true, landed: out.landed };
    },
    'POST /return': ({ body }) => {
      if (auths.has(body.account_id)) throw new HttpError(409, 'outstanding authorization');
      const amount = bal.get(body.account_id) ?? 0n;
      if (!amount) throw new HttpError(409, 'empty');
      bal.set(body.account_id, 0n);
      Object.assign(sub(body.task_id, body.n), { status: 'Returned', returned: String(amount) });
      // like the contract: a return to a Closed task waits in it for another close_task
      const t = contract.get(body.task_id)!.task;
      if (t.status === 'Closed') t.unallocated = String(BigInt(t.unallocated ?? 0) + amount);
      calls.push(`return ${body.account_id} ${amount}`);
      return { tx_hash: 'r', amount: String(amount) };
    },
    'POST /reclaim': ({ body }) => { // like the signer: a Returned account, or a failed attempt's created one, at 0 USDC
      const s = sub(body.task_id, body.n);
      if (s.account_id !== body.account_id) throw new HttpError(409, 'not the current account');
      if (s.status !== 'Returned' && !(s.status === 'Failed' && s.account_exists)) throw new HttpError(409, `subtask is ${s.status}`);
      if (bal.get(body.account_id)) throw new HttpError(409, 'still holds USDC');
      calls.push(`reclaim ${body.account_id}`);
      return { tx_hash: 'd', beneficiary: 'rook.test' };
    },
    'POST /kill': ({ body }) => (calls.push(`signer-kill ${body.task_id}`), { killed: true }),
  }, 0));
  servers.push(await serve('mock-chain-gateway', {
    'GET /config': () => ({ network: 'testnet', contract_id: 'rook.test', owner: 'owner.test', usdc: 'usdc.test', max_open_tasks: 1 }),
    'GET /open-tasks': () => ({ open: openTasks }),
    'GET /task/:id': ({ params }) => {
      const x = contract.get(params.id);
      if (!x) throw new HttpError(404, `no contract task ${params.id}`);
      return { task: x.task, subtasks: x.subs };
    },
    'POST /fund': async ({ body }) => {
      if (body.task_id === 'slow') await new Promise((ok) => setTimeout(ok, 300)); // a kill lands while this is in flight
      const x = contract.get(body.task_id)!, cap = x.task.caps[body.n - 1];
      if (body.task_id === 'failx') { // a kill landed between create_account and the transfer: the account exists, no USDC
        x.subs.push({ ...fundedSub(body.task_id, body.n, cap), status: 'Failed' });
        throw new HttpError(502, 'fund_subtask failed: callback returned false (rolled back)');
      }
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
      // like the contract: a Closed task closes again only to refund what reached it after its close
      if (x.task.status === 'Closed' && !BigInt(x.task.unallocated ?? 0)) throw new HttpError(502, 'close_task failed: Smart contract panicked: task is already closed');
      Object.assign(x.task, { status: 'Closed', unallocated: '0' });
      calls.push(`close ${body.task_id}`);
      return { tx_hash: 'c', success: true };
    },
    'GET /balance': ({ query }) => ({ balance: String(bal.get(query.get('account')!) ?? 0n) }),
    'GET /payment': () => ({ found: false, tries: 1, error: null }),
  }, 0));
  servers.push(await serve('fake-market-gateway', {
    'GET /x402': () => ({ x402Version: 2, recipients: [X402] }),
    'POST /quote': ({ body }) => ({ ok: true, row: row(PRICE[body.handle]) }),
    'POST /send': async ({ body }) => {
      const id = `a2a-${a2a.size + 1}`;
      a2a.set(id, { handle: body.handle, state: 'WORKING' });
      calls.push(`send ${body.handle} ${id}`);
      if (body.handle === 'hangs') await new Promise(() => {}); // holds the connection, as a short window does; never answers
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

test('kill in chain mode: the authorization is waited out, the sub-account returned and the task closed; kill_task stays the funder\'s', async () => {
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
    assert.match(evs.find((e) => e.type === 'ledger' && e.data.op === 'kill').data.human_action, /funder's call: near contract call-function .* kill_task json-args '\{"task_id":"b"\}'/);
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

const cand = (handle: string) => ({ handle, name: handle, description: handle, sla_seconds: 60, success_rate: null, delivered_jobs: 0, price_atomic: PRICE[handle], quote: row(PRICE[handle]) });
/** A task as the orchestrator stores it, for the next start to load: one subtask, bound to contract task `cid`. */
function storeTask(id: string, status: string, cid: string, sub: object, auths: object, balance: string, chain: object = {}) {
  const ts = new Date().toISOString();
  const store = openStore(process.env.ROOK_DB!);
  store.save({
    id, prompt: 'p', budget_atomic: '1000000', reserve_share: 0.2, funder: 'owner.test', owner: null, status: status as any, error: null,
    created_at: ts, updated_at: ts, plan: null, receipts: [], events: [], final_result: null, llm_calls: [],
    subtasks: [{
      id: 's1', title: 'Holders', brief: 'Holders\nPlease report.', search_terms: [], deadline_s: 60, self_do: false, cap_atomic: '0', candidates: [],
      criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: '.' } }],
      n: 1, status: 'working', final_outcome: null, rehire_count: 0, tried: [], hires: [], evaluations: [], accepted: null, ...sub,
    } as any],
    chain: { contract_task_id: cid, nmap: { 1: 1 }, accounts: { 1: acct(cid, 1) }, auths: auths as any, ...chain },
    ledger_saved: { closed: false, subtasks: [{ n: 1, balance_atomic: balance }] },
  });
  store.close();
}

test('restart while /send is out: the hire was saved before it, so its landed payment gets a receipt and the task closes', async () => {
  process.env.ROOK_DB = join(dir, 'sending.sqlite');
  let orch = await start(0);
  const t = await call(`${orch.url}/tasks`, { prompt: 'hangs', budget_usdc: '1' });
  await call(`${orch.url}/tasks/${t.id}/approve`, {});
  openContractTask('d', [PRICE.hangs]);
  await call(`${orch.url}/tasks/${t.id}/funded`, { contract_task_id: 'd' });
  await until(async () => calls.some((c) => c.startsWith('send hangs')));
  await orch.close(); // the services stop while /send, and with it the payment header, is out

  // While Rook is down the agent delivers and its payment settles; Rook never learned its A2A task id.
  const account = acct('d', 1);
  auths.get(account)!.landed = true;
  bal.set(account, 0n);

  orch = await start(0);
  try {
    const s = await until(async () => { const x = await snap(orch, t.id); return ['closed', 'failed'].includes(x.task.status) ? x : false; });
    assert.equal(s.task.status, 'closed', s.task.error);
    assert.equal(calls.filter((c) => c.startsWith(`sign ${account}`)).length, 1);
    assert.deepEqual(s.subtasks[0].hires.map((h: any) => [h.agent_handle, h.paid, h.state]), [['hangs', true, 'OUTCOME_UNKNOWN']]);
    assert.deepEqual(s.receipts.map((r: any) => [r.agent_handle, r.amount_atomic, r.verdict]), [['hangs', '100000', null]]);
    assert.deepEqual([s.ledger.spent_atomic, s.ledger.refunded_atomic], ['100000', '900000']);
  } finally { await orch.close(); }
});

test('after a restart an older unpaid hire never stands in for an outstanding authorization it was not signed for', async () => {
  process.env.ROOK_DB = join(dir, 'orphan.sqlite');
  const account = acct('e', 1);
  openContractTask('e', ['200000']);
  contract.get('e')!.subs.push({ n: 1, account_id: account, cap: '200000', topped_up: '0', returned: '0', status: 'Funded', attempt: 0, pending_top_up: '0' });
  bal.set(account, 200_000n);
  // alpha FAILED unpaid earlier; beta was then authorized, and the services stopped before beta's hire was stored.
  a2a.set('a2a-alpha', { handle: 'alpha', state: 'FAILED' });
  auths.set(account, { amount: 100_000n, landed: false, until: Date.now() + 400 });
  const ts = new Date().toISOString();
  const alpha = {
    id: 'h_alpha', subtask_id: 's1', agent_handle: 'alpha', amount_atomic: '100000', payment_hash: 'ph-alpha', a2a_task_id: 'a2a-alpha', context_id: 'ctx',
    state: 'FAILED', paid: false, deliverable_text: null, parts: [], verdict: null, started_at: ts, ended_at: ts, pay_to: X402.payTo, expires_at: ts,
  };
  storeTask('t_orphan', 'running', 'e', { cap_atomic: '200000', candidates: [cand('alpha'), cand('beta')], tried: ['alpha', 'beta'], hires: [alpha] },
    { 1: { payment_hash: `ph-${account}`, amount: '100000', expires_at_block: 1, nonce: '1' } }, '200000');
  const orch = await start(0);
  try {
    // beta's authorization is waited out, never cleared as if it were alpha's; only then is beta signed for again.
    const [id] = await until(async () => [...a2a].find(([, v]) => v.handle === 'beta'));
    auths.get(account)!.landed = true;
    bal.set(account, 100_000n);
    a2a.get(id)!.state = 'COMPLETED';
    const s = await until(async () => { const x = await snap(orch, 't_orphan'); return ['closed', 'failed'].includes(x.task.status) ? x : false; });
    assert.equal(s.task.status, 'closed', s.task.error);
    assert.ok(!calls.some((c) => c.startsWith(`expire ${account}`) && c.endsWith('terminal')), calls.join('\n'));
    assert.equal(calls.filter((c) => c.startsWith(`sign ${account}`)).length, 1);
    assert.ok(calls.indexOf(`expire ${account} landed=false`) < calls.indexOf(`sign ${account} 100000`));
    assert.deepEqual(s.receipts.map((r: any) => [r.agent_handle, r.amount_atomic, r.verdict]), [['beta', '100000', 'pass']]);
    assert.deepEqual([s.ledger.spent_atomic, s.ledger.refunded_atomic], ['100000', '900000']);
  } finally { await orch.close(); }
});

test('a killed task the owner closed on chain with a sub-account still Funded: Rook returns it and closes the task again', async () => {
  process.env.ROOK_DB = join(dir, 'owner-closed.sqlite');
  const account = acct('g', 1);
  openContractTask('g', ['300000']);
  Object.assign(contract.get('g')!.task, { status: 'Closed', killed: true }); // the owner's kill_task, then close_task
  contract.get('g')!.subs.push({ n: 1, account_id: account, cap: '300000', topped_up: '0', returned: '0', status: 'Funded', attempt: 0, pending_top_up: '0' });
  bal.set(account, 200_000n); // 100 000 was paid before the kill
  storeTask('t_owner_closed', 'killed', 'g', { cap_atomic: '300000' }, {}, '200000');
  const orch = await start(0);
  try {
    const s = await until(async () => { const x = await snap(orch, 't_owner_closed'); return x.ledger?.closed ? x : false; });
    assert.ok(calls.includes(`return ${account} 200000`) && calls.includes('close g'));
    assert.deepEqual([s.task.status, s.ledger.spent_atomic, sub('g', 1).status, contract.get('g')!.task.status], ['killed', '100000', 'Returned', 'Closed']);
  } finally { await orch.close(); }
});

test('restore: a contract task deleted by an empty close counts as closed, its whole budget refunded', async () => {
  const { createChainLedger } = await import('../src/orchestrator/chain-ledger.ts');
  const l = createChainLedger();
  const here = { contract_id: 'rook.test', network: 'testnet' }, t = { funder: 'alice.test', budget: 1_000_000n, reserve_share: 0.2, saved: null };
  const r = await l.restore('T-gone', { contract_task_id: 'gone', ...here, nmap: { 1: 1 }, accounts: {}, auths: {} }, t);
  assert.deepEqual([r.status, r.deleted], ['Closed', true]);
  assert.match(r.notes[0], /deleted/);
  const v = l.view('T-gone')!;
  assert.deepEqual([v.closed, String(v.refunded_atomic), String(v.spent_atomic)], [true, '1000000', '0']);
  assert.equal(l.contractTaskOf('T-gone'), null); // a deleted id is never handed out again: nothing to bind
  // With a funded sub-account on record, a missing contract task is an error, never a silent close.
  await assert.rejects(l.restore('T-odd', { contract_task_id: 'gone2', ...here, nmap: { 1: 1 }, accounts: { 1: 'tgone2-1.rook.test' }, auths: {} }, t), /gone but Rook funded/);
  // An older binding that names no contract (nor does its stored view) may be another contract's task: left alone.
  await assert.rejects(l.restore('T-old', { contract_task_id: 'gone3', nmap: { 1: 1 }, accounts: {}, auths: {} }, t), /does not say which contract/);
  assert.equal(l.view('T-old'), null);
});

test('restore refuses a binding made on another contract or network, or another funder\'s task, and binds nothing', async () => {
  const { createChainLedger, OtherContract } = await import('../src/orchestrator/chain-ledger.ts');
  const l = createChainLedger();
  openContractTask('o', ['100000']);
  const t = { funder: 'owner.test', budget: 1_000_000n, reserve_share: 0.2, saved: null };
  const bd = (o: object = {}) => ({ contract_task_id: 'o', nmap: { 1: 1 }, accounts: {}, auths: {}, ...o });
  const other = (re: RegExp) => (e: any) => e instanceof OtherContract && re.test(e.message);
  await assert.rejects(l.restore('T1', bd({ contract_id: 'rook.old', network: 'testnet' }), t), other(/funded on rook\.old \(testnet\), and this Rook runs rook\.test \(testnet\)/));
  // An older binding: the ledger view stored with its task names the network, and its sub-account ids the contract.
  await assert.rejects(l.restore('T2', bd(), { ...t, saved: { contract_id: 'rook.test', network: 'mainnet' } }), other(/\(mainnet\)/));
  await assert.rejects(l.restore('T3', bd({ accounts: { 1: 'to-1.rook.old' } }), t), other(/to-1\.rook\.old is not one of rook\.test's/));
  await assert.rejects(l.restore('T4', bd(), { ...t, funder: 'mallory.test' }), other(/from owner\.test, not this task's 1000000 from mallory\.test/));
  for (const id of ['T1', 'T2', 'T3', 'T4']) assert.deepEqual([l.contractTaskOf(id), l.view(id)], [null, null]);
  assert.equal((await l.restore('T5', bd(), t)).status, 'Open'); // an older binding nothing contradicts
  assert.deepEqual([l.contractTaskOf('T5'), l.binding('T5')!.contract_id, l.binding('T5')!.network], ['o', 'rook.test', 'testnet']);
  l.bind('T6', 'p', new Map([[1, 1]]));
  assert.deepEqual([l.binding('T6')!.contract_id, l.binding('T6')!.network], ['rook.test', 'testnet']);
});

test('a task bound on another contract is left as it is, and its contract task id does not block /funded here', async () => {
  process.env.ROOK_DB = join(dir, 'stale.sqlite');
  // A testnet run's task, bound to its contract task 'k', in the database a run against this contract shares.
  storeTask('t_stale', 'running', 'k', { cap_atomic: '100000' }, {}, '100000', { contract_id: 'rook.old', network: 'testnet' });
  const orch = await start(0);
  try {
    assert.equal((await snap(orch, 't_stale')).task.status, 'running');
    const id = await fundedAndWorking(orch, 'alpha', 'k'); // this contract's task 'k', a stranger's id twin
    assert.equal((await snap(orch, id)).ledger.contract_task_id, 'k');
    assert.equal(calls.filter((c) => c === 'keys k/1').length, 1); // the new task's funding only
  } finally { await orch.close(); }
  const store = openStore(process.env.ROOK_DB!);
  const stale = store.load().find((d) => d.id === 't_stale')!;
  store.close();
  assert.equal(stale.status, 'running');
  assert.match(stale.events.at(-1)!.data.message, /funded on rook\.old \(testnet\), and this Rook runs rook\.test \(testnet\)\. It is left as it is/);
});

test('a task whose contract task was refunded and deleted before Rook funded anything is cancelled after a restart, not run', async () => {
  process.env.ROOK_DB = join(dir, 'deleted.sqlite');
  storeTask('t_deleted', 'funded', 'del', { cap_atomic: '100000', candidates: [cand('alpha')] }, {}, '0', { accounts: {}, contract_id: 'rook.test', network: 'testnet' });
  const orch = await start(0);
  try {
    const s = await snap(orch, 't_deleted'); // settled before the API listens
    assert.deepEqual([s.task.status, s.ledger.closed, s.ledger.refunded_atomic, s.ledger.spent_atomic], ['cancelled', true, '1000000', '0']);
    assert.ok(!calls.includes('keys del/1'));
    const evs = await events(orch, 't_deleted');
    assert.match(evs.find((e) => e.data.op === 'refunded_before_run').data.note, /refunded to its funder and deleted before Rook funded any subtask/);
  } finally { await orch.close(); }
});

test('unwind: an authorization waited out on one sub-account does not hold back the other sub-account\'s return', async () => {
  process.env.ROOK_DB = join(dir, 'two-subs.sqlite');
  const [a1, a2] = [acct('h', 1), acct('h', 2)];
  openContractTask('h', ['300000', '200000']);
  contract.get('h')!.subs.push(fundedSub('h', 1, '300000'), fundedSub('h', 2, '200000'));
  bal.set(a1, 300_000n); bal.set(a2, 200_000n);
  auths.set(a1, { amount: 100_000n, landed: false, until: Date.now() + 1500 }); // its hire is not on record: waited out
  const ts = new Date().toISOString();
  const s = (n: number, cap: string) => ({
    id: `s${n}`, title: 'T', brief: 'b', search_terms: [], criteria: [], cap_atomic: cap, deadline_s: 60, self_do: false, candidates: [],
    n, status: 'working', final_outcome: null, rehire_count: 0, tried: [], hires: [], evaluations: [], accepted: null,
  });
  const store = openStore(process.env.ROOK_DB);
  store.save({
    id: 't_two', prompt: 'p', budget_atomic: '1000000', reserve_share: 0.2, funder: 'owner.test', owner: null, status: 'killed', error: null,
    created_at: ts, updated_at: ts, plan: null, receipts: [], events: [], final_result: null, llm_calls: [], subtasks: [s(1, '300000'), s(2, '200000')] as any,
    chain: { contract_task_id: 'h', nmap: { 1: 1, 2: 2 }, accounts: { 1: a1, 2: a2 }, auths: { 1: { payment_hash: 'ph-h', amount: '100000', expires_at_block: 1, nonce: '1' } } },
    ledger_saved: { closed: false, subtasks: [{ n: 1, balance_atomic: '300000' }, { n: 2, balance_atomic: '200000' }] },
  });
  store.close();
  const orch = await start(0);
  try {
    const x = await until(async () => { const v = await snap(orch, 't_two'); return v.ledger?.closed ? v : false; });
    const at = (c: string) => { const i = calls.indexOf(c); assert.ok(i >= 0, `${c} missing:\n${calls.join('\n')}`); return i; };
    assert.ok(at(`return ${a2} 200000`) < at(`expire ${a1} landed=false`));
    assert.ok(at(`expire ${a1} landed=false`) < at(`return ${a1} 300000`) && at(`return ${a1} 300000`) < at('close h'));
    assert.deepEqual([x.ledger.spent_atomic, x.ledger.refunded_atomic], ['0', '1000000']);
  } finally { await orch.close(); }
});

test('after the funder closed a killed task, an emptied sub-account is marked empty and Rook books the task closed', async () => {
  process.env.ROOK_DB = join(dir, 'funder-closed.sqlite');
  const account = acct('m', 1);
  openContractTask('m', ['300000']);
  // The funder's kill_task, then close_task: refunded, nothing left in the task. The hire had spent the whole cap.
  Object.assign(contract.get('m')!.task, { status: 'Closed', killed: true, unallocated: '0', reserve_remaining: '0' });
  contract.get('m')!.subs.push(fundedSub('m', 1, '300000'));
  bal.set(account, 0n);
  storeTask('t_funder_closed', 'killed', 'm', { cap_atomic: '300000' }, {}, '0');
  const orch = await start(0);
  try {
    const s = await until(async () => { const x = await snap(orch, 't_funder_closed'); return x.ledger?.closed ? x : false; });
    assert.ok(calls.includes('mark-empty m/1 true') && calls.includes(`reclaim ${account}`));
    assert.ok(!calls.includes('close m')); // the contract answered "task is already closed": nothing left to refund
    assert.deepEqual([sub('m', 1).status, s.ledger.spent_atomic, s.ledger.invariant_holds], ['Returned', '300000', true]);
    const evs = await events(orch, 't_funder_closed');
    assert.equal(evs.at(-1).data.op, 'closeTask');
    assert.ok(!evs.some((e) => e.type === 'error' && /closeTask/.test(e.data.message)));
  } finally { await orch.close(); }
});

test('a return that reached a Closed task after its close is refunded by Rook\'s close_task after a restart', async () => {
  process.env.ROOK_DB = join(dir, 'late-return.sqlite');
  openContractTask('n', ['300000']);
  // The funder closed the killed task; then subtask 1 returned 100 000, which waits in the Closed task.
  Object.assign(contract.get('n')!.task, { status: 'Closed', killed: true, unallocated: '100000', reserve_remaining: '0' });
  contract.get('n')!.subs.push({ ...fundedSub('n', 1, '300000'), status: 'Returned', returned: '100000' });
  storeTask('t_late', 'killed', 'n', { cap_atomic: '300000' }, {}, '100000');
  const orch = await start(0);
  try {
    const s = await until(async () => { const x = await snap(orch, 't_late'); return x.ledger?.closed ? x : false; });
    assert.ok(calls.includes('close n'));
    assert.deepEqual([contract.get('n')!.task.unallocated, s.ledger.spent_atomic, s.ledger.refunded_atomic], ['0', '200000', '800000']);
  } finally { await orch.close(); }
});

test('a funding attempt that failed after its account was created: the account is deleted, at funding and at restore', async () => {
  const { createChainLedger } = await import('../src/orchestrator/chain-ledger.ts');
  const l = createChainLedger();
  openContractTask('failx', ['300000']);
  l.bind('T-fx', 'failx', new Map([[1, 1]]));
  l.createTask('T-fx', 'owner.test', 1_000_000n, 0.2);
  await assert.rejects(async () => { await l.fundSubtask('T-fx', 1, 300_000n); }, /callback returned false/);
  assert.ok(calls.includes(`reclaim ${acct('failx', 1)}`));
  // After a restart, restore finds such an attempt and deletes its account before the run funds the subtask again.
  openContractTask('fr', ['300000']);
  contract.get('fr')!.subs.push({ ...fundedSub('fr', 1, '300000'), status: 'Failed' });
  const r = await createChainLedger().restore('T-fr', { contract_task_id: 'fr', contract_id: 'rook.test', network: 'testnet', nmap: { 1: 1 }, accounts: { 1: acct('fr', 1) }, auths: {} },
    { funder: 'owner.test', budget: 1_000_000n, reserve_share: 0.2, saved: null });
  assert.equal(r.status, 'Open');
  assert.ok(calls.includes(`reclaim ${acct('fr', 1)}`));
  // An attempt that failed before create_account has no account to delete.
  openContractTask('fn', ['300000']);
  contract.get('fn')!.subs.push({ ...fundedSub('fn', 1, '300000'), status: 'Failed', account_exists: false });
  await createChainLedger().restore('T-fn', { contract_task_id: 'fn', contract_id: 'rook.test', network: 'testnet', nmap: { 1: 1 }, accounts: {}, auths: {} },
    { funder: 'owner.test', budget: 1_000_000n, reserve_share: 0.2, saved: null });
  assert.ok(!calls.includes(`reclaim ${acct('fn', 1)}`));
});

test('approving again to reprint the funding instructions skips the open-task limit: the funder\'s own transfer counts toward it', async () => {
  process.env.ROOK_DB = join(dir, 'reprint.sqlite');
  const orch = await start(0);
  try {
    const t = await call(`${orch.url}/tasks`, { prompt: 'alpha', budget_usdc: '1', owner: 'alice.test' });
    openTasks = 0;
    assert.equal((await call(`${orch.url}/tasks/${t.id}/approve`, { owner: 'alice.test' })).funding.amount_atomic, '1000000');
    openTasks = 1; // her transfer created the contract task, and the limit is 1
    const again = await call(`${orch.url}/tasks/${t.id}/approve`, { owner: 'alice.test' });
    assert.deepEqual([again.status, again.funding.amount_atomic], ['approved', '1000000']);
    const next = await call(`${orch.url}/tasks`, { prompt: 'beta', budget_usdc: '1', owner: 'alice.test' });
    await assert.rejects(call(`${orch.url}/tasks/${next.id}/approve`, { owner: 'alice.test' }), /alice\.test already has 1 open tasks/);
  } finally { await orch.close(); openTasks = 0; }
});
