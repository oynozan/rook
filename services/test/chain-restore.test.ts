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
const expireWaits = new Map<string, number>(); // account -> /expire calls answered 409 (still valid)
const calls: string[] = [];
const acct = (cid: string, n: number) => `t${cid}-${n}.rook.test`;
const openContractTask = (cid: string, caps: string[]) =>
  contract.set(cid, { task: { funder: 'owner.test', budget: '1000000', reserve: '200000', caps, status: 'Open', killed: false }, subs: [] });
const sub = (cid: string, n: number) => contract.get(cid)!.subs.find((s) => s.n === n)!;
const fundedSub = (cid: string, n: number, cap: string): CSub => ({ n, account_id: acct(cid, n), cap, topped_up: '0', returned: '0', status: 'Funded', attempt: 0, pending_top_up: '0', account_exists: true });
let authTtlMs = 60_000;
let openTasks = 0; // the funder's open tasks on the contract (its limit is 1 below)
let openTasksGate: Promise<void> = Promise.resolve(); // holds the open-task read, as a slow NEAR RPC does
const failing = new Map<string, number>(); // gateway route -> how many more calls fail, as a NEAR RPC hiccup does
const reads = new Map<string, number>(); // contract task -> how often the gateway read it
const hiccup = (route: string) => {
  const n = failing.get(route) ?? 0;
  if (n > 0) { failing.set(route, n - 1); throw new HttpError(502, `${route} failed: NEAR RPC send_tx: INVALID_TRANSACTION {}`); }
};

// ---- the fake market: an agent's A2A task stays WORKING until a test moves it ----
const PRICE: Record<string, string> = { slowpoke: '300000', stubborn: '100000', hangs: '100000', alpha: '100000', beta: '100000', unsure: '100000' };
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
      // void: the signer spends the delegate's nonce, so it clears at once (landed when the payment ran first).
      if (!out.landed && !body.terminal_unpaid && !body.void && Date.now() <= out.until) {
        expireWaits.set(a, (expireWaits.get(a) ?? 0) + 1);
        throw new HttpError(409, 'still valid');
      }
      auths.delete(a);
      calls.push(`expire ${a} landed=${out.landed}${body.terminal_unpaid ? ' terminal' : ''}${body.void ? ' void' : ''}`);
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
      hiccup('return-answer'); // the transfer landed, but its answer is lost (send_tx "outcome unknown", a dropped call)
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
    'GET /open-tasks': async ({ query }) => { calls.push(`open-tasks ${query.get('account')}`); await openTasksGate; return { open: openTasks }; },
    'GET /task/:id': ({ params }) => {
      reads.set(params.id, (reads.get(params.id) ?? 0) + 1);
      hiccup('task');
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
      hiccup('mark-empty');
      const s = sub(body.task_id, body.n), marked = s.status === 'Funded' && !(bal.get(s.account_id) ?? 0n);
      if (marked) s.status = 'Returned';
      calls.push(`mark-empty ${body.task_id}/${body.n} ${marked}`);
      return { tx_hash: 'm', success: true, marked };
    },
    'POST /close': ({ body }) => {
      hiccup('close');
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
      if (body.handle === 'unsure') return { ok: false, error: { code: 'outcome_unknown', message: 'the market answered 502' } };
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
    // 'zero cap': a plan drafted before 0 USDC quotes were dropped, with a hired part capped at 0
    'POST /plan': ({ body }) => body.prompt === 'zero cap'
      ? { ...planFor('alpha'), subtasks: [{ ...planFor('alpha').subtasks[0], cap_atomic: '0' }] }
      : planFor(body.prompt),
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

test("kill in chain mode: an agent that refuses CancelTask has its payment voided, the sub-account returned and the task closed; kill_task stays the funder's, in the CLI's /kill answer", async () => {
  // The agent refuses CancelTask. Its authorization is valid for a minute here (often a day on mainnet), and the kill
  // must not wait that out: the signer voids it, so the money comes back at once.
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
    assert.ok(calls.indexOf(`expire ${acct('b', 1)} landed=false void`) < calls.indexOf(`return ${acct('b', 1)} 100000`));
    assert.ok(calls.includes('close b'));
    // Every step is recorded after the killed status. The event only says the money comes back: no command in the stream.
    const evs = await events(orch, id);
    const at = evs.findIndex((e) => e.type === 'task_status' && e.data.to === 'killed');
    assert.deepEqual(evs.find((e) => e.type === 'ledger' && e.data.op === 'kill').data, { op: 'kill', returning: true });
    assert.deepEqual(evs.slice(at + 1).filter((e) => e.type === 'ledger').map((e) => e.data.op), ['clearing', 'release', 'returnLeftover', 'closeTask']);
    assert.equal(evs.find((e) => e.data.op === 'clearing').data.how, 'void');
  } finally { await orch.close(); }
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
function storeTask(id: string, status: string, cid: string, sub: object, auths: object, balance: string, chain: object = {}, doc: object = {}) {
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
    ...doc,
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

/** A task restarted while closing with its report: its hire paid 200 000 of the 300 000 cap, the rest still in the sub-account. */
function storeClosing(id: string, cid: string) {
  openContractTask(cid, ['300000']);
  contract.get(cid)!.subs.push(fundedSub(cid, 1, '300000'));
  bal.set(acct(cid, 1), 100_000n);
  storeTask(id, 'closing', cid, { cap_atomic: '300000', status: 'passed', final_outcome: 'passed' }, {}, '100000', { contract_id: 'rook.test', network: 'testnet' },
    { final_result: { final_markdown: 'report', attribution: [], abandoned: [] } });
}
const restoreErrors = (doc: { events: { type: string; data: any }[] }) => doc.events.filter((e) => e.type === 'error' && e.data.kind === 'restore');

test('a restore that fails at start is tried again once the API listens, until a shutdown; the next start finishes the close', async () => {
  process.env.ROOK_DB = join(dir, 'restore-again.sqlite');
  storeClosing('t_again', 'ra');
  failing.set('task', 999); // the chain gateway can't read the contract
  let orch = await start(0);
  try {
    assert.equal((await snap(orch, 't_again')).task.status, 'closing'); // the API listens meanwhile
    await until(async () => (failing.get('task') ?? 0) <= 993); // the try at start (3 reads), then another
  } finally { await orch.close(); }
  await new Promise((ok) => setTimeout(ok, 1200)); // a try under way at the shutdown finishes its reads
  const left = failing.get('task');
  await new Promise((ok) => setTimeout(ok, 500));
  assert.equal(failing.get('task'), left); // the shutdown stopped the tries
  const store = openStore(process.env.ROOK_DB!);
  const doc = store.load().find((d) => d.id === 't_again')!;
  store.close();
  assert.equal(doc.status, 'closing');
  const errs = restoreErrors(doc);
  assert.equal(errs.length, 1); // reported once, however often it failed
  assert.match(errs[0].data.message, /^after a restart Rook could not rebuild contract task ra: .*Rook tries again, waiting longer each time\.$/);

  failing.set('task', 3); // the try at start fails again; the next one reads the contract
  orch = await start(0);
  try {
    const s = await until(async () => { const x = await snap(orch, 't_again'); return x.task.status === 'closed' ? x : false; });
    assert.deepEqual([s.final_result.final_markdown, s.ledger.spent_atomic, s.ledger.refunded_atomic], ['report', '200000', '800000']);
    assert.ok(calls.includes(`return ${acct('ra', 1)} 100000`) && calls.includes('close ra'));
  } finally { await orch.close(); failing.clear(); }
});

test('a task restarted while closing with its report, whose contract task the funder killed meanwhile, finishes the close and ends closed', async () => {
  process.env.ROOK_DB = join(dir, 'closing-killed.sqlite');
  storeClosing('t_closing_killed', 'ck');
  contract.get('ck')!.task.killed = true; // the funder's kill_task while Rook was down
  const orch = await start(0);
  try {
    const s = await until(async () => { const x = await snap(orch, 't_closing_killed'); return x.ledger?.closed ? x : false; });
    assert.deepEqual([s.task.status, s.final_result.final_markdown, s.ledger.spent_atomic, s.ledger.refunded_atomic], ['closed', 'report', '200000', '800000']);
    assert.ok(calls.includes(`return ${acct('ck', 1)} 100000`) && calls.includes('close ck'));
    const evs = await events(orch, 't_closing_killed');
    assert.ok(!evs.some((e) => (e.type === 'task_status' && e.data.to === 'killed') || (e.type === 'ledger' && e.data.op === 'kill')));
  } finally { await orch.close(); }
});

test('a task stopped while its restore is being tried again: the signer hears it, the page follows, and once the books are rebuilt what it holds comes back', async () => {
  process.env.ROOK_DB = join(dir, 'restore-kill.sqlite');
  openContractTask('rk', ['300000']);
  contract.get('rk')!.subs.push(fundedSub('rk', 1, '300000'));
  bal.set(acct('rk', 1), 100_000n); // 200 000 was paid before the restart
  storeTask('t_again_kill', 'running', 'rk', { cap_atomic: '300000' }, {}, '100000', { contract_id: 'rook.test', network: 'testnet' });
  failing.set('task', 6); // the try at start fails, and so does the first try after the API listens
  const orch = await start(0);
  try {
    const killed = await call(`${orch.url}/tasks/t_again_kill/kill`, {});
    assert.equal(killed.status, 'killed');
    assert.match(killed.human_action, /kill_task json-args '\{"task_id":"rk"\}'/); // its contract task, though not bound yet
    const live = events(orch, 't_again_kill'); // opened before the books are back: it stays open until the money is
    const s = await until(async () => { const x = await snap(orch, 't_again_kill'); return x.ledger?.closed ? x : false; });
    assert.deepEqual([s.task.status, s.ledger.killed, s.ledger.spent_atomic, s.ledger.refunded_atomic], ['killed', true, '200000', '800000']);
    assert.ok(calls.includes(`return ${acct('rk', 1)} 100000`) && calls.includes('close rk'));
    assert.ok(calls.includes('signer-kill rk')); // sent once the books were rebuilt
    const evs = await live;
    assert.deepEqual(evs.find((e) => e.type === 'ledger' && e.data.op === 'kill').data, { op: 'kill', returning: true });
    assert.ok(evs.some((e) => e.type === 'ledger' && e.data.op === 'restored' && e.data.contract_task_id === 'rk'));
    assert.equal(evs.at(-1).data.op, 'closeTask');
  } finally { await orch.close(); failing.clear(); }
});

test("a rebuild the books refuse half-way (the contract's numbers don't fit them) leaves nothing half-built and is not tried again", async () => {
  const { createChainLedger, Unrebuildable } = await import('../src/orchestrator/chain-ledger.ts');
  // Topped up by more than the 200 000 reserve Rook's books keep: the books refuse the top-up after they were opened.
  const misfit = (cid: string) => {
    openContractTask(cid, ['300000']);
    contract.get(cid)!.subs.push({ ...fundedSub(cid, 1, '300000'), topped_up: '300000' });
    bal.set(acct(cid, 1), 600_000n);
  };
  misfit('hb');
  const l = createChainLedger();
  const bd = { contract_task_id: 'hb', contract_id: 'rook.test', network: 'testnet', nmap: { 1: 1 }, accounts: { 1: acct('hb', 1) }, auths: {} };
  const t = { funder: 'owner.test', budget: 1_000_000n, reserve_share: 0.2, saved: null };
  const refused = (e: any) => e instanceof Unrebuildable && /don't fit Rook's books: .*exceeds remaining reserve/.test(e.message);
  await assert.rejects(l.restore('T-hb', bd, t), refused);
  assert.deepEqual([l.view('T-hb'), l.contractTaskOf('T-hb')], [null, null]); // no books left half-built, nothing bound
  await assert.rejects(l.restore('T-hb', bd, t), refused); // the same answer again, never "task already exists"

  // The orchestrator reports it once and leaves the task as it is, showing the books it stored.
  process.env.ROOK_DB = join(dir, 'misfit.sqlite');
  misfit('hb2');
  storeTask('t_misfit', 'running', 'hb2', { cap_atomic: '300000' }, {}, '600000', { contract_id: 'rook.test', network: 'testnet' });
  const orch = await start(0);
  try {
    const s = await snap(orch, 't_misfit');
    assert.deepEqual([s.task.status, s.ledger], ['running', { closed: false, subtasks: [{ n: 1, balance_atomic: '600000' }] }]);
    const seen = reads.get('hb2');
    await new Promise((ok) => setTimeout(ok, 300)); // longer than the first waits before a try again
    assert.equal(reads.get('hb2'), seen);
  } finally { await orch.close(); }
  const store = openStore(process.env.ROOK_DB!);
  const doc = store.load().find((d) => d.id === 't_misfit')!;
  store.close();
  assert.equal(doc.status, 'running');
  const errs = restoreErrors(doc);
  assert.equal(errs.length, 1);
  assert.match(errs[0].data.message, /^after a restart Rook could not rebuild contract task hb2: the contract's numbers don't fit Rook's books: .*Every try would fail the same way, so it is left as it is for Rook's operator\.$/);
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

test("unwind: an authorization with no hire on record is voided, not waited out, and each sub-account returns on its own", async () => {
  process.env.ROOK_DB = join(dir, 'two-subs.sqlite');
  const [a1, a2] = [acct('h', 1), acct('h', 2)];
  openContractTask('h', ['300000', '200000']);
  contract.get('h')!.subs.push(fundedSub('h', 1, '300000'), fundedSub('h', 2, '200000'));
  bal.set(a1, 300_000n); bal.set(a2, 200_000n);
  auths.set(a1, { amount: 100_000n, landed: false, until: Date.now() + 60_000 }); // its hire is not on record: voided
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
    assert.ok(at(`return ${a2} 200000`) < at('close h'));
    assert.ok(at(`expire ${a1} landed=false void`) < at(`return ${a1} 300000`) && at(`return ${a1} 300000`) < at('close h'));
    assert.deepEqual([x.ledger.spent_atomic, x.ledger.refunded_atomic], ['0', '1000000']);
  } finally { await orch.close(); }
});

test('a kill while the run waits for a delivered hire\'s payment that never lands does not hold back the other sub-account\'s return', async () => {
  process.env.ROOK_DB = join(dir, 'kill-settling.sqlite');
  const [a1, a2] = [acct('w', 1), acct('w', 2)];
  openContractTask('w', ['300000', '200000']);
  contract.get('w')!.subs.push(fundedSub('w', 1, '300000'), fundedSub('w', 2, '200000'));
  bal.set(a1, 300_000n); bal.set(a2, 200_000n);
  // alpha delivered, but the facilitator never settles its payment; beta is still working (it accepts CancelTask).
  a2a.set('a2a-w1', { handle: 'alpha', state: 'COMPLETED' });
  a2a.set('a2a-w2', { handle: 'beta', state: 'WORKING' });
  const until1 = Date.now() + 3000;
  for (const a of [a1, a2]) auths.set(a, { amount: 100_000n, landed: false, until: until1 });
  const ts = new Date().toISOString(), later = new Date(Date.now() + 60_000).toISOString();
  const s = (n: number, cap: string, handle: string) => ({
    id: `s${n}`, title: 'T', brief: 'b', search_terms: [], cap_atomic: cap, deadline_s: 60, self_do: false, candidates: [cand(handle)],
    criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: '.' } }],
    n, status: 'working', final_outcome: null, rehire_count: 0, tried: [handle], evaluations: [], accepted: null,
    hires: [{
      id: `h_w${n}`, subtask_id: `s${n}`, agent_handle: handle, amount_atomic: '100000', payment_hash: `ph-${acct('w', n)}`, a2a_task_id: `a2a-w${n}`,
      context_id: 'ctx', state: 'WORKING', paid: false, deliverable_text: null, parts: [], verdict: null, started_at: ts, ended_at: null, pay_to: X402.payTo, expires_at: later,
    }],
  });
  const auth = (a: string) => ({ payment_hash: `ph-${a}`, amount: '100000', expires_at_block: 1, nonce: '1' });
  const store = openStore(process.env.ROOK_DB);
  store.save({
    id: 't_settling', prompt: 'p', budget_atomic: '1000000', reserve_share: 0.2, funder: 'owner.test', owner: null, status: 'running', error: null,
    created_at: ts, updated_at: ts, plan: null, receipts: [], events: [], final_result: null, llm_calls: [], subtasks: [s(1, '300000', 'alpha'), s(2, '200000', 'beta')] as any,
    chain: { contract_task_id: 'w', contract_id: 'rook.test', network: 'testnet', nmap: { 1: 1, 2: 2 }, accounts: { 1: a1, 2: a2 }, auths: { 1: auth(a1), 2: auth(a2) } },
    ledger_saved: { closed: false, subtasks: [{ n: 1, balance_atomic: '300000' }, { n: 2, balance_atomic: '200000' }] },
  });
  store.close();
  const orch = await start(0);
  try {
    await until(async () => (expireWaits.get(a1) ?? 0) > 0); // the run is settling alpha's payment, which has not landed
    await call(`${orch.url}/tasks/t_settling/kill`, {});
    const x = await until(async () => { const v = await snap(orch, 't_settling'); return v.ledger?.closed ? v : false; });
    const at = (c: string) => { const i = calls.indexOf(c); assert.ok(i >= 0, `${c} missing:\n${calls.join('\n')}`); return i; };
    // The kill stopped the run's wait: beta's money came back while alpha's authorization was still being waited out.
    assert.ok(at(`return ${a2} 200000`) < at(`expire ${a1} landed=false`));
    assert.ok(at(`expire ${a1} landed=false`) < at(`return ${a1} 300000`) && at(`return ${a1} 300000`) < at('close w'));
    assert.deepEqual([x.task.status, x.ledger.spent_atomic, x.ledger.refunded_atomic], ['killed', '0', '1000000']);
    assert.deepEqual(x.subtasks[0].hires.map((h: any) => [h.state, h.paid]), [['COMPLETED', false]]);
  } finally { await orch.close(); }
});

test('a send whose outcome is unknown is voided at once in chain mode: no payment showed, so it is unpaid and the money comes back', async () => {
  // No task id came back, so no deliverable can: Rook does not wait out the authorization (often a day on mainnet).
  process.env.ROOK_DB = join(dir, 'unsure.sqlite');
  const orch = await start(0);
  try {
    const t = await call(`${orch.url}/tasks`, { prompt: 'unsure', budget_usdc: '1' });
    await call(`${orch.url}/tasks/${t.id}/approve`, {});
    openContractTask('u', [PRICE.unsure]);
    await call(`${orch.url}/tasks/${t.id}/funded`, { contract_task_id: 'u' });
    const account = acct('u', 1);
    const s = await until(async () => { const x = await snap(orch, t.id); return x.ledger?.closed ? x : false; });
    assert.equal(expireWaits.get(account) ?? 0, 0); // never waited for the expiry
    assert.deepEqual(s.subtasks[0].hires.map((h: any) => [h.agent_handle, h.state, h.paid]), [['unsure', 'SEND_FAILED', false]]);
    assert.ok(calls.indexOf(`expire ${account} landed=false void`) < calls.indexOf(`return ${account} 100000`) && calls.includes('close u'));
    assert.deepEqual([s.ledger.spent_atomic, s.ledger.refunded_atomic], ['0', '1000000']);
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

test('a revision whose plan is ready while the funding is being read: approve answers 409, never a transfer for the replaced plan', async () => {
  process.env.ROOK_DB = join(dir, 'approve-revised.sqlite');
  const orch = await start(0);
  let open!: () => void;
  try {
    const t = await call(`${orch.url}/tasks`, { prompt: 'alpha', budget_usdc: '1', owner: 'robin.test' });
    openTasksGate = new Promise((ok) => (open = ok));
    const approving = call(`${orch.url}/tasks/${t.id}/approve`, { owner: 'robin.test' }).then(() => null, (e) => e);
    await until(async () => calls.includes('open-tasks robin.test'));
    const revised = await call(`${orch.url}/tasks`, { prompt: 'beta', budget_usdc: '1', owner: 'robin.test', parent_id: t.id });
    assert.equal(revised.status, 'planned');
    open();
    const refused = await approving;
    assert.deepEqual([refused?.status, refused?.message], [409, 'task is cancelled, approve needs planned']);
    assert.deepEqual([(await snap(orch, t.id)).task.status, (await snap(orch, t.id)).task.replaced_by], ['cancelled', revised.id]);
  } finally { open?.(); openTasksGate = Promise.resolve(); await orch.close(); }
});

test('a plan with a 0 USDC cap is refused before the wallet opens, and the task stays planned', async () => {
  process.env.ROOK_DB = join(dir, 'zero-cap.sqlite');
  const orch = await start(0);
  try {
    const t = await call(`${orch.url}/tasks`, { prompt: 'zero cap', budget_usdc: '1' });
    await assert.rejects(call(`${orch.url}/tasks/${t.id}/approve`, {}), (e: any) => e.status === 409 && e.message === 'this plan has a 0 USDC cap; draft the task again');
    assert.equal((await snap(orch, t.id)).task.status, 'planned');
    assert.equal((await call(`${orch.url}/tasks/${t.id}/cancel`, {})).status, 'cancelled');
  } finally { await orch.close(); }
});

/** The agent of a funded, working task delivers and the marketplace takes its payment from the sub-account. */
async function deliverAndPay(orch: Running, id: string, cid: string) {
  const a2aId = (await snap(orch, id)).subtasks[0].hires[0].a2a_task_id, account = acct(cid, 1);
  auths.get(account)!.landed = true;
  bal.set(account, 0n);
  a2a.get(a2aId)!.state = 'COMPLETED';
}

test('a return or a close that fails for a moment is tried again: the task closes with its report', async () => {
  process.env.ROOK_DB = join(dir, 'hiccup.sqlite');
  const orch = await start(0);
  try {
    const id = await fundedAndWorking(orch, 'alpha', 'hc');
    failing.set('mark-empty', 1).set('close', 2);
    await deliverAndPay(orch, id, 'hc');
    const s = await until(async () => { const x = await snap(orch, id); return ['closed', 'failed'].includes(x.task.status) ? x : false; });
    assert.equal(s.task.status, 'closed', s.task.error);
    assert.equal(s.final_result.final_markdown, 'final');
    assert.deepEqual([s.subtasks[0].status, s.ledger.closed, s.ledger.refunded_atomic], ['returned', true, '900000']);
    const errs = (await events(orch, id)).filter((e) => e.type === 'error' && e.data.kind !== 'payment_lookup');
    assert.deepEqual(errs.map((e) => e.data.kind), ['return', 'close_retry', 'close_retry']);
  } finally { await orch.close(); failing.clear(); }
});

test('a close that fails past its quick retries: the task stays closing, the unwind keeps trying, and it ends closed with its report', async () => {
  // Seen on mainnet (t_891b1147): send_tx failed with INVALID_TRANSACTION for minutes, longer than the quick retries.
  process.env.ROOK_DB = join(dir, 'close-slow.sqlite');
  const orch = await start(0);
  try {
    const id = await fundedAndWorking(orch, 'alpha', 'cs');
    failing.set('close', 8); // 5 quick tries, then the unwind's rounds 1 to 3 fail and round 4 closes
    await deliverAndPay(orch, id, 'cs');
    const s = await until(async () => { const x = await snap(orch, id); return ['closed', 'failed'].includes(x.task.status) ? x : false; });
    assert.deepEqual([s.task.status, s.task.error, s.final_result.final_markdown], ['closed', null, 'final']);
    assert.deepEqual([s.ledger.closed, s.ledger.refunded_atomic], [true, '900000']);
    const evs = await events(orch, id);
    assert.deepEqual(evs.filter((e) => e.type === 'task_status').map((e) => e.data.to).slice(-2), ['closing', 'closed']);
    assert.deepEqual(evs.find((e) => e.type === 'final').data.refunded_atomic, '900000');
    // Each problem is reported once, however often the same close fails again.
    const errs = evs.filter((e) => e.type === 'error' && e.data.kind !== 'payment_lookup');
    assert.deepEqual(errs.map((e) => e.data.kind), ['close_retry', 'close_retry', 'close_retry', 'close_retry', 'close', 'unwind']);
    assert.match(errs.at(-1).data.message, /^closing, closeTask: .*INVALID_TRANSACTION/);
  } finally { await orch.close(); failing.clear(); }
});

test('a close that keeps failing after the report keeps the report and the task closing; a shutdown stops the retries and the next start closes it', async () => {
  process.env.ROOK_DB = join(dir, 'close-fails.sqlite');
  let orch = await start(0);
  const id = await fundedAndWorking(orch, 'alpha', 'cf');
  try {
    failing.set('close', 99);
    await deliverAndPay(orch, id, 'cf');
    await until(async () => (failing.get('close') ?? 0) <= 90); // the quick tries and 4 of the unwind's rounds
    const s = await snap(orch, id);
    assert.deepEqual([s.task.status, s.task.error, s.final_result.final_markdown], ['closing', null, 'final']); // paid for and passed: never thrown away
    assert.deepEqual([s.subtasks[0].status, s.ledger.closed], ['returned', false]);
    // A Stop from a page that still shows the run can't end the finished task as stopped.
    await assert.rejects(call(`${orch.url}/tasks/${id}/kill`, {}), (e: any) => e.status === 409 && /^the report is written; Rook is only returning the unspent USDC now/.test(e.message));
    assert.equal((await snap(orch, id)).task.status, 'closing');
  } finally { await orch.close(); }
  const settle = () => new Promise((ok) => setTimeout(ok, 700)); // longer than the unwind's next two waits
  await settle(); // a close already sent at the shutdown lands
  const left = failing.get('close');
  await settle();
  assert.equal(failing.get('close'), left); // stopped retrying at the shutdown
  failing.clear();
  const store = openStore(process.env.ROOK_DB!);
  const doc = store.load().find((d) => d.id === id)!;
  store.close();
  assert.deepEqual(doc.events.filter((e) => e.type === 'error').map((e) => e.data.kind).filter((k) => k === 'close' || k === 'unwind'), ['close', 'unwind']);

  orch = await start(0);
  try {
    const s = await until(async () => { const x = await snap(orch, id); return ['closed', 'failed'].includes(x.task.status) ? x : false; });
    assert.deepEqual([s.task.status, s.final_result.final_markdown, s.ledger.closed, s.ledger.refunded_atomic], ['closed', 'final', true, '900000']);
    const evs = await events(orch, id);
    assert.ok(!evs.some((e) => e.type === 'task_status' && e.data.to === 'failed'));
    assert.equal(evs.filter((e) => e.type === 'final').length, 1);
  } finally { await orch.close(); }
});

test('a run whose report is written takes a follow-up while its refund is still under way', async () => {
  process.env.ROOK_DB = join(dir, 'closing-follow-up.sqlite');
  const orch = await start(0);
  try {
    const id = await fundedAndWorking(orch, 'alpha', 'cu');
    failing.set('close', 99);
    await deliverAndPay(orch, id, 'cu');
    await until(async () => { const x = await snap(orch, id); return x.task.status === 'closing' && x.final_result ? x : false; });
    const follow = await call(`${orch.url}/tasks`, { prompt: 'beta', budget_usdc: '1', parent_id: id });
    assert.deepEqual([follow.status, follow.parent_id], ['planned', id]);
    assert.equal((await snap(orch, id)).task.status, 'closing'); // the refund goes on beside it
  } finally { await orch.close(); failing.clear(); }
});

test("a return whose answer was lost: the next try finds the subtask Returned on the contract, books it and closes, never mark_empty", async () => {
  process.env.ROOK_DB = join(dir, 'lost-return.sqlite');
  const orch = await start(0);
  try {
    const id = await fundedAndWorking(orch, 'alpha', 'lr');
    failing.set('return-answer', 1);
    await call(`${orch.url}/tasks/${id}/kill`, {});
    const s = await until(async () => { const x = await snap(orch, id); return x.ledger?.closed ? x : false; });
    const account = acct('lr', 1);
    assert.deepEqual([s.task.status, s.subtasks[0].status, s.ledger.spent_atomic, s.ledger.refunded_atomic], ['killed', 'returned', '0', '1000000']);
    assert.equal(calls.filter((c) => c === `return ${account} 100000`).length, 1); // returned once, booked from the contract
    assert.ok(!calls.some((c) => c.startsWith('mark-empty lr/')), calls.join('\n'));
    assert.ok(calls.indexOf(`reclaim ${account}`) < calls.indexOf('close lr'));
    const errs = (await events(orch, id)).filter((e) => e.type === 'error');
    assert.deepEqual(errs.map((e) => [e.data.kind, e.data.op]), [['unwind', 'returnLeftover']]);
  } finally { await orch.close(); failing.clear(); }
});

test('a return booked from the contract: a subtask Failed on chain counts as returned, with nothing sent back', async () => {
  const { createChainLedger } = await import('../src/orchestrator/chain-ledger.ts');
  const l = createChainLedger();
  openContractTask('fl', ['300000']);
  l.bind('T-fl', 'fl', new Map([[1, 1]]));
  l.createTask('T-fl', 'owner.test', 1_000_000n, 0.2);
  await l.fundSubtask('T-fl', 1, 300_000n);
  Object.assign(sub('fl', 1), { status: 'Failed', account_exists: true }); // its funding undone on chain: the cap is back in the task
  bal.set(acct('fl', 1), 0n);
  assert.equal(await l.returnLeftover('T-fl', 1), 300_000n);
  assert.ok(!calls.some((c) => c.startsWith('mark-empty fl/')));
  assert.ok(calls.includes(`reclaim ${acct('fl', 1)}`));
  assert.equal(String(l.view('T-fl')!.subtasks[0].returned_atomic), '300000');
});

test('a kill whose close keeps failing for a while: the unwind tries again until the books close, reporting the problem once', async () => {
  process.env.ROOK_DB = join(dir, 'kill-close.sqlite');
  const orch = await start(0);
  try {
    const id = await fundedAndWorking(orch, 'alpha', 'kc');
    failing.set('close', 3);
    await call(`${orch.url}/tasks/${id}/kill`, {});
    const s = await until(async () => { const x = await snap(orch, id); return x.ledger?.closed ? x : false; });
    assert.deepEqual([s.task.status, s.ledger.spent_atomic, s.ledger.refunded_atomic], ['killed', '0', '1000000']);
    assert.ok(calls.includes('close kc'));
    const errs = (await events(orch, id)).filter((e) => e.type === 'error');
    assert.deepEqual(errs.map((e) => e.data.kind), ['unwind']);
    assert.match(errs[0].data.message, /^after kill, closeTask: /);
  } finally { await orch.close(); failing.clear(); }
});

// ---- deleting a chat while its money is on chain ----

const del = (orch: Running, id: string) => call(`${orch.url}/conversations/${id}/delete`, {});
/** The delete was refused in words matching `re`, naming task `id` for the web app to link. */
const heldBy = (id: string, re: RegExp) => (e: any) => e.status === 409 && re.test(e.message) && e.body?.details?.task_id === id;
const RETURNING = /^Rook is still returning the unspent USDC of a task in this chat\. Delete the chat once it is back in your wallet\.$/;

test('a chat is not deleted while a task of it unwinds after a kill, or closes with its report written, until its books close', async () => {
  process.env.ROOK_DB = join(dir, 'delete-held.sqlite');
  const orch = await start(0);
  try {
    // Stopped, its close failing for a while: the unwind keeps trying, and the chat waits for the money to come back.
    const killed = await fundedAndWorking(orch, 'alpha', 'dk');
    failing.set('close', 5);
    await call(`${orch.url}/tasks/${killed}/kill`, {});
    await assert.rejects(del(orch, killed), heldBy(killed, RETURNING));
    await until(async () => (await snap(orch, killed)).ledger?.closed);
    assert.deepEqual((await del(orch, killed)).deleted, [killed]);

    // The report is written and the close keeps failing: the run has finished and takes a follow-up, but its refund is
    // still on its way, so the chat is refused from any of its tasks, naming the one whose books are open.
    const done = await fundedAndWorking(orch, 'alpha', 'dc');
    failing.set('close', 99);
    await deliverAndPay(orch, done, 'dc');
    await until(async () => { const x = await snap(orch, done); return x.task.status === 'closing' && x.final_result; });
    const follow = await call(`${orch.url}/tasks`, { prompt: 'beta', budget_usdc: '1', parent_id: done });
    await assert.rejects(del(orch, follow.id), heldBy(done, RETURNING));
    const kept = (await snap(orch, follow.id)).task;
    assert.deepEqual([kept.status, kept.deleted_at], ['planned', null]); // refused as a whole: nothing of it changed
    failing.set('close', 0);
    await until(async () => (await snap(orch, done)).ledger?.closed);
    assert.deepEqual((await del(orch, follow.id)).deleted.sort(), [done, follow.id].sort());
    assert.deepEqual([(await snap(orch, done)).task.status, (await snap(orch, follow.id)).task.status], ['closed', 'cancelled']);
  } finally { await orch.close(); failing.clear(); }
});

test('after a restart a chat waits while its books are rebuilt, and says so in its own words when they never can be; a task of another contract does not hold it', async () => {
  // Its rebuild from the contract keeps failing: the money is on the contract, Rook's books for it are not back yet.
  process.env.ROOK_DB = join(dir, 'delete-restoring.sqlite');
  openContractTask('dr', ['300000']);
  contract.get('dr')!.subs.push(fundedSub('dr', 1, '300000'));
  bal.set(acct('dr', 1), 300_000n);
  storeTask('t_del_restoring', 'killed', 'dr', { cap_atomic: '300000' }, {}, '300000', { contract_id: 'rook.test', network: 'testnet' });
  failing.set('task', 999);
  let orch = await start(0);
  try {
    await assert.rejects(del(orch, 't_del_restoring'), heldBy('t_del_restoring', RETURNING));
  } finally { await orch.close(); failing.clear(); }

  // Never rebuilt here. Funded on another contract: only a Rook that runs that one moves its money, so it holds the chat
  // no longer, and the delete stops it, so that Rook returns its money rather than resume a run nobody can see. Numbers
  // that don't fit Rook's books: the money waits for Rook's operator, which the refusal says.
  process.env.ROOK_DB = join(dir, 'delete-stranded.sqlite');
  storeTask('t_del_other', 'running', 'k', { cap_atomic: '100000' }, {}, '100000', { contract_id: 'rook.old', network: 'testnet' });
  openContractTask('dm', ['300000']);
  contract.get('dm')!.subs.push({ ...fundedSub('dm', 1, '300000'), topped_up: '300000' });
  bal.set(acct('dm', 1), 600_000n);
  storeTask('t_del_misfit', 'running', 'dm', { cap_atomic: '300000' }, {}, '600000', { contract_id: 'rook.test', network: 'testnet' });
  orch = await start(0);
  try {
    assert.deepEqual((await del(orch, 't_del_other')).deleted, ['t_del_other']);
    assert.equal((await snap(orch, 't_del_other')).task.status, 'killed');
    await assert.rejects(del(orch, 't_del_misfit'),
      heldBy('t_del_misfit', /^A task in this chat still holds USDC that Rook can't send back by itself, so Rook's operator has to\. Until then this chat can't be deleted\.$/));
    assert.equal((await snap(orch, 't_del_misfit')).task.deleted_at, null);
  } finally { await orch.close(); }
});
