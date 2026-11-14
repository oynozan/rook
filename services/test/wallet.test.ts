// Agent wallet (docs/agent-wallet-plan.md), all offline: the policy builder against the Agent API's own Policy schema,
// the API client against a local mock of the API (helpers/agent-api-mock.ts), and the orchestrator's wallet routes and
// funding steps in chain mode against that mock, a mock chain-gateway and signer, and fake market, planner, evaluator.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startAgentApiMock } from './helpers/agent-api-mock.ts';

const CONTRACT = 'rook.test', OWNER = 'alice.near', PK = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
Object.assign(process.env, {
  ROOK_LLM: 'canned', ROOK_MARKET: 'sim', NEAR_NETWORK: 'testnet', ROOK_CONTRACT_ID: CONTRACT, ROOK_LEDGER: 'chain',
  ROOK_PAYMENT_GRACE_S: '1', ROOK_POLL_MS: '20', ROOK_RATE_PER_MIN: '6000',
  ROOK_AGENT_API_KEY: 'partner-key-for-tests', ROOK_WALLET_GAP_MS: '5', ROOK_WALLET_APPROVAL_GAP_MS: '10', ROOK_WALLET_SWEEP_MS: '60000', ROOK_WALLET_SETTLE_MS: '3000',
});
delete process.env.ROOK_DB;

const { serve, call, HttpError } = await import('../src/shared/http.ts');
const { agentApi, AgentApiError, USDC_ASSET, USDC_CONTRACT } = await import('../src/wallet/api.ts');
const { policyFor, usdString } = await import('../src/wallet/policy.ts');
const { createdTask } = await import('../src/chain-gateway/index.ts');
type Running = Awaited<ReturnType<typeof serve>>;

const servers: { close: () => Promise<void> }[] = [];
after(async () => { for (const s of servers) await s.close(); });

// ---- mock chain: native USDC balances, registrations and contract tasks, moved by the mock API's hooks ----
const native = new Map<string, bigint>(), registered = new Set<string>();
const contractTasks = new Map<string, any>(), outcomes = new Map<string, unknown>();
let nextTask = 0, nextTx = 0;
let api: Awaited<ReturnType<typeof startAgentApiMock>>;
const agentByNear = (near: string) => [...api.agents.values()].find((a) => a.near === near)!;

function onNearCall(account: string, b: any): string | null {
  if (b.receiver_id !== USDC_CONTRACT || b.method_name !== 'ft_transfer_call' || b.deposit !== '1') return null;
  const amount = BigInt(b.args.amount), have = native.get(account) ?? 0n;
  if (amount > have) return null; // the token panics: the transaction fails, nothing moves
  native.set(account, have - amount);
  const hash = `tx${++nextTx}`;
  if (b.args.receiver_id === 'intents.near') { // a deposit into NEAR Intents for the account named in msg
    agentByNear(b.args.msg).balance += amount;
    outcomes.set(hash, { receipts_outcome: [] });
    return hash;
  }
  const { create_task } = JSON.parse(b.args.msg);
  const task_id = String(nextTask++);
  const reserve = ((amount * BigInt(create_task.reserve_bps)) / 10_000n).toString();
  contractTasks.set(task_id, { funder: account, budget: amount.toString(), reserve, caps: create_task.caps, status: 'Open', killed: false });
  const event = { standard: 'rook', version: '1.0.0', event: 'task_created', data: [{ task_id, funder: account, budget: amount.toString(), reserve, caps: create_task.caps }] };
  outcomes.set(hash, { receipts_outcome: [
    { outcome: { executor_id: USDC_CONTRACT, logs: [], status: { SuccessReceiptId: 'r1' } } },
    { outcome: { executor_id: CONTRACT, logs: [`EVENT_JSON:${JSON.stringify(event)}`], status: { SuccessValue: '' } } },
  ] });
  return hash;
}

before(async () => {
  api = await startAgentApiMock({
    key: 'partner-key-for-tests', onNearCall, registered: (a) => registered.has(a),
    onWithdraw: (to, amount) => native.set(to, (native.get(to) ?? 0n) + amount),
  });
  servers.push(api);
  process.env.ROOK_AGENT_API_URL = api.url;
});

// ---- policy ----

test('policyFor: the spending rules become a complete policy the Agent API schema accepts', () => {
  const near = 'a'.repeat(64);
  for (const [rules, account] of [[{}, null], [{ budget_usd: 1000 }, near], [{ budget_usd: 50, period: 'day', per_task_max_usd: 20, approval: 'every', expires_days: 14 }, near]] as const) {
    assert.equal(api.validPolicy(policyFor(rules, account)), true, JSON.stringify(rules));
  }
  // The plan's table (docs/agent-wallet-plan.md): "Only spend $1000" is a monthly budget; the period picks the window.
  assert.deepEqual(policyFor({ budget_usd: 1000 }, null).budget, { daily_usd: null, weekly_usd: null, monthly_usd: '1000' });
  assert.deepEqual(policyFor({ budget_usd: 50, period: 'day' }, null).budget, { daily_usd: '50', weekly_usd: null, monthly_usd: null });
  assert.deepEqual(policyFor({ budget_usd: 70, period: 'week' }, null).budget, { daily_usd: null, weekly_usd: '70', monthly_usd: null });
  assert.deepEqual(policyFor({ per_task_max_usd: 20 }, null).limits, { per_transaction: { [USDC_ASSET]: '20000000' } });
  assert.deepEqual(policyFor({}, null).limits, {});
  assert.equal(policyFor({ approval: 'every' }, null).owner_approval, true);
  assert.equal(policyFor({ approval: 'none' }, null).owner_approval, false);
  const p = policyFor({}, near);
  assert.deepEqual([p.actions, p.assets, p.timelock_ms, p.frozen], [['withdraw'], [USDC_ASSET, 'nep141:wrap.near'], 0, false]);
  // Only the wallet's own native account, and the USDC contract for the 1 yoctoNEAR each ft_transfer_call attaches.
  assert.deepEqual(p.destinations, { mode: 'only', list: [
    { action: 'withdraw', chain: 'near', address: near, memo: null }, { action: 'withdraw', chain: 'near', address: USDC_CONTRACT, memo: null },
  ] });
  assert.deepEqual(policyFor({}, null).destinations.list, [{ action: 'withdraw', chain: 'near', address: USDC_CONTRACT, memo: null }]);
  assert.deepEqual(p.native, {
    near: { sign_message: [], transfer: false, call: [USDC_CONTRACT] },
    evm: { sign_typed_data: [], sign_message: false, sign_transaction: false }, solana: { sign_message: false, sign_transaction: false },
  });
  // USD strings: at most 2 decimals, cut down, never above what the user said.
  assert.deepEqual([12.5, 12.05, 12.349, 0.29, 1_000_000].map(usdString), ['12.5', '12.05', '12.34', '0.29', '1000000']);
});

// ---- client ----

test('agent API client: key on every call, grant and Idempotency-Key only where the spec says, typed errors with the code', async () => {
  const c = agentApi();
  assert.deepEqual(await c.whoami(), { api_key_id: 'k1', tenant_id: 't1' });
  const e = await c.agent('f'.repeat(64)).catch((x) => x);
  assert.ok(e instanceof AgentApiError);
  assert.deepEqual([e.status, e.code, e.layer, e.request_id], [404, 'agent_not_found', 'request', 'req-1']);
  const bad = await agentApi({ key: 'wrong' }).whoami().catch((x) => x);
  assert.deepEqual([bad.status, bad.code, bad.layer], [401, 'api_key_invalid', 'auth']);
  const none = await agentApi({ key: '' }).whoami().catch((x) => x);
  assert.equal(none.code, 'not_configured');
  const gone = await agentApi({ url: 'http://127.0.0.1:1' }).whoami().catch((x) => x);
  assert.deepEqual([gone.code, gone.retryable], ['unreachable', true]);
});

test('chain-gateway createdTask: the contract task from a succeeded task_created event, or why the contract refunded', () => {
  const ev = (status: object) => ({ receipts_outcome: [{ outcome: { executor_id: CONTRACT, status, logs: [`EVENT_JSON:${JSON.stringify({ standard: 'rook', event: 'task_created', data: [{ task_id: '1a', funder: 'w', budget: '5', reserve: '1', caps: ['4'] }] })}`] } }] });
  assert.deepEqual(createdTask(ev({ SuccessValue: '' }), CONTRACT), { found: true, task_id: '1a', funder: 'w', budget: '5', reserve: '1', caps: ['4'] });
  // A failed receipt logged the event before it rolled back: no task.
  assert.equal(createdTask(ev({ Failure: { x: 1 } }), CONTRACT).found, false);
  assert.equal(createdTask(ev({ SuccessValue: '' }), 'other.test').found, false); // only the contract's own logs count
  const refunded = { receipts_outcome: [{ outcome: { executor_id: CONTRACT, status: { SuccessValue: '' }, logs: ['refunding 5: caps add up to more than budget - reserve'] } }] };
  assert.deepEqual(createdTask(refunded, CONTRACT), { found: false, refunded: 'caps add up to more than budget - reserve' });
});

// ---- orchestrator ----

let orch: Running;
const calls: string[] = [];
let gwDown = false; // the chain-gateway's GET /config answers 503, as while it starts
let gwCreated: (() => unknown) | null = null; // a test's own answer of the chain-gateway's GET /created-task
let gwTask: ((id: string) => unknown) | null = null; // a test's own answer of the chain-gateway's GET /task/:id (undefined: the usual one)
const paid = new Map<string, bigint>(); // contract task -> what its hires spent

before(async () => {
  const rec = (name: string, body?: any) => { calls.push(`${name} ${JSON.stringify(body ?? {})}`); };
  const left = new Map<string, bigint>(), auths = new Set<string>(), returned = new Map<string, Set<number>>(), subs = new Map<string, any[]>();
  const mockSigner = await serve('mock-signer', {
    'POST /keys': ({ body }) => (rec('keys', body), { public_key: 'ed25519:x', tx_hash: 'k' }),
    'POST /sign': ({ body }) => {
      if (auths.has(body.account_id)) throw new HttpError(409, 'outstanding authorization');
      auths.add(body.account_id);
      left.set(body.account_id, left.get(body.account_id)! - BigInt(body.row.amount));
      paid.set(body.task_id, (paid.get(body.task_id) ?? 0n) + BigInt(body.row.amount));
      const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: body.row, payload: { signedDelegateAction: 'AA==' } })).toString('base64');
      return { header, payment_hash: createHash('sha256').update(header).digest('hex'), expires_at_block: 1, nonce: '1' };
    },
    'POST /expire': ({ body }) => (auths.delete(`t${body.task_id}-${body.n}.${CONTRACT}`) ? { cleared: true, landed: true } : { cleared: false, outstanding: false }),
    'POST /return': ({ body }) => {
      if (!left.get(body.account_id)) throw new HttpError(409, 'empty: nothing to return');
      (returned.get(body.task_id) ?? returned.set(body.task_id, new Set()).get(body.task_id)!).add(body.n);
      return { tx_hash: 'r', amount: String(left.get(body.account_id)) };
    },
    'POST /kill': () => ({ killed: true }),
    'POST /reclaim': () => ({ deleted: true }),
  }, 0);
  const mockGw = await serve('mock-chain-gateway', {
    'GET /config': () => {
      if (gwDown) throw new HttpError(503, 'chain-gateway is starting');
      return { network: 'mainnet', contract_id: CONTRACT, owner: 'owner.test', usdc: USDC_CONTRACT };
    },
    'GET /task/:id': ({ params }) => gwTask?.(params.id) ?? { task: contractTasks.get(params.id), subtasks: subs.get(params.id) ?? [] },
    'POST /fund': ({ body }) => {
      const account_id = `t${body.task_id}-${body.n}.${CONTRACT}`, cap = contractTasks.get(body.task_id).caps[body.n - 1];
      (subs.get(body.task_id) ?? subs.set(body.task_id, []).get(body.task_id)!).push({ n: body.n, account_id, cap, status: 'Funded' });
      left.set(account_id, BigInt(cap));
      return { tx_hash: 'f', success: true };
    },
    'POST /receipt': ({ body }) => ({ tx_hash: `rtx-${body.n}`, explorer_url: 'x' }),
    'POST /mark-empty': ({ body }) => {
      const marked = !left.get(`t${body.task_id}-${body.n}.${CONTRACT}`);
      if (marked) (returned.get(body.task_id) ?? returned.set(body.task_id, new Set()).get(body.task_id)!).add(body.n);
      return { tx_hash: 'm', success: true, marked };
    },
    'POST /close': ({ body }) => { // the contract refunds what the task did not spend to its funder
      const ct = contractTasks.get(body.task_id);
      ct.status = 'Closed';
      native.set(ct.funder, (native.get(ct.funder) ?? 0n) + BigInt(ct.budget) - (paid.get(body.task_id) ?? 0n));
      return { tx_hash: 'c', success: true };
    },
    'GET /balance': ({ query }) => {
      const a = query.get('account')!;
      return { balance: String(native.has(a) ? native.get(a) : left.get(a) ?? 0n) };
    },
    'GET /registered': ({ query }) => ({ registered: registered.has(query.get('account')!) }),
    'GET /created-task': ({ query }) => gwCreated?.() ?? createdTask(outcomes.get(query.get('tx')!), CONTRACT),
    'GET /payment': () => ({ found: true, tx_hash: 'pay', explorer_url: 'x' }),
  }, 0);
  const X402 = { network: 'near:mainnet', asset: USDC_CONTRACT, payTo: 'treasury.test' };
  const r = (amount: string) => ({ scheme: 'exact', ...X402, amount, maxTimeoutSeconds: 60 });
  const fakeMarket = await serve('fake-market-gateway', {
    'GET /x402': () => ({ x402Version: 2, recipients: [X402] }),
    'POST /quote': ({ body }) => ({ ok: true, row: r(body.handle === 'holders' ? '300000' : '150000') }),
    'POST /send': () => ({ ok: true, task: { id: `a2a-${calls.length}`, context_id: null, state: 'COMPLETED', artifacts: [{ parts: [{ text: 'report' }] }] } }),
    'GET /task': ({ query }) => ({ ok: true, task: { id: query.get('id'), context_id: null, state: 'COMPLETED', artifacts: [{ parts: [{ text: 'report' }] }] } }),
    'POST /cancel': () => ({ ok: true }),
  }, 0);
  const cand = (handle: string, price: string) => ({ handle, name: handle, description: handle, sla_seconds: 5, success_rate: null, delivered_jobs: 0, price_atomic: price, quote: r(price) });
  const sub = (id: string, cap: string, candidates: any[]) => ({
    id, title: id, brief: `${id}\nPlease report.`, search_terms: [id], cap_atomic: cap, deadline_s: 5, self_do: false, candidates,
    criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: '.' } }],
  });
  const plan = {
    subtasks: [sub('s1', '300000', [cand('holders', '300000')]), sub('s3', '200000', [cand('check', '150000')])], dropped: [], notes: [], llm_calls: [],
    budget: { budget_atomic: '1000000', reserve_atomic: '200000', allocatable_atomic: '800000', allocated_atomic: '500000', reserve_bps: 2000 },
  };
  const planner = await serve('fake-planner', {
    'POST /plan': () => plan,
    'POST /self-do': () => ({ text: 'self report', llm_calls: [] }),
    'POST /aggregate': () => ({ final_markdown: 'final', attribution: [], llm_calls: [] }),
  }, 0);
  const evaluator = await serve('fake-evaluator', {
    'POST /evaluate': () => ({ verdict: 'pass', results: [], failed_criteria: [], security_flags: [], extracted: {}, llm_calls: [], engine: 'local', attestation_hash: 'att' }),
  }, 0);
  Object.assign(process.env, { SIGNER_URL: mockSigner.url, CHAIN_GATEWAY_URL: mockGw.url, MARKET_GATEWAY_URL: fakeMarket.url, PLANNER_URL: planner.url, EVALUATOR_URL: evaluator.url });
  orch = await (await import('../src/orchestrator/index.ts')).start(0);
  servers.unshift(orch, mockSigner, mockGw, fakeMarket, planner, evaluator);
});

const refused = (p: Promise<unknown>, status: number, re: RegExp) => assert.rejects(p, (e: any) => e instanceof HttpError && e.status === status && re.test(e.message));
const until = async <T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 10_000): Promise<T> => {
  let x = await fn();
  for (const end = Date.now() + ms; !ok(x) && Date.now() < end; await new Promise((r) => setTimeout(r, 20))) x = await fn();
  return x;
};
const wallet = (base = orch.url, owner = OWNER) => call(`${base}/wallet?owner=${owner}`);
const snap = (id: string, base = orch.url, owner = OWNER) => call(`${base}/tasks/${id}?owner=${owner}`);
/** The task's wallet events so far: its event stream read for a moment (it stays open while the task runs). */
async function walletOps(id: string, base = orch.url, owner = OWNER): Promise<any[]> {
  const ac = new AbortController();
  const r = await fetch(`${base}/tasks/${id}/events?owner=${owner}`, { signal: ac.signal });
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  const stop = setTimeout(() => ac.abort(), 150);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += value; } } catch { /* read for long enough */ } finally { clearTimeout(stop); }
  return text.split('\n\n').filter((e) => e.includes('"op":"wallet_')).map((e) => JSON.parse(e.split('\ndata: ')[1]).data);
}
/** A step of the setup: generate as `OWNER`, then submit what a wallet would return. */
async function sign(type: string, extra: object = {}, base = orch.url, owner = OWNER) {
  const g = await call(`${base}/wallet/intents`, { owner, type, ...extra });
  const out = g.intent.standard === 'nep366' ? { signed_delegate: 'A'.repeat(64) } : { public_key: PK, signature: 'B'.repeat(88) };
  // A browser that sends a payload of its own is not heard: the signed data is rebuilt from the intent Rook issued.
  return call(`${base}/wallet/intents/${g.correlation_id}/submit`, { owner, signed_data: { ...out, payload: { evil: true } } });
}
const allText = () => JSON.stringify(api.requests.filter((r) => r.method === 'GET'));

let near = '', agentId = '', grantToken = '';

test('wallet setup: three signatures (create, allow its own account, issue the grant); a wrong owner or an unknown request is refused', async () => {
  const saved = process.env.ROOK_AGENT_API_KEY;
  delete process.env.ROOK_AGENT_API_KEY;
  try {
    const v = await wallet();
    assert.deepEqual([v.configured, v.status, v.next_step, v.agent_id], [false, 'none', null, null]);
    await refused(call(`${orch.url}/wallet/intents`, { owner: OWNER, type: 'agent_create', public_key: PK }), 409, /isn't set up on this server/);
  } finally { process.env.ROOK_AGENT_API_KEY = saved; }
  assert.deepEqual([(await wallet()).configured, (await wallet()).next_step], [true, null]);
  await refused(call(`${orch.url}/wallet`), 400, /owner is required/);
  await refused(call(`${orch.url}/wallet/intents`, { owner: OWNER, type: 'policy_update' }), 409, /Create your agent wallet first/);
  await refused(call(`${orch.url}/wallet/intents`, { owner: OWNER, type: 'agent_create' }), 400, /public_key is required/);

  const rules = { budget_usd: 100, per_task_max_usd: 2 };
  const g = await call(`${orch.url}/wallet/intents`, { owner: OWNER, type: 'agent_create', rules, public_key: PK });
  assert.deepEqual([g.type, g.intent.standard, typeof g.summary, g.policy], ['agent_create', 'nep366', 'string', policyFor(rules, null)]);
  const sent = api.requests.find((r) => r.path === '/v1/generate-intent')!.body;
  assert.deepEqual(sent.owner, { type: 'near', account_id: OWNER, public_key: PK });
  assert.equal(sent.external_user_id, OWNER);
  // Only the owner it was issued to submits it, and only an intent Rook issued.
  await refused(call(`${orch.url}/wallet/intents/${g.correlation_id}/submit`, { owner: 'bob.near', signed_data: { signed_delegate: 'A'.repeat(64) } }), 404, /no signature request/);
  await refused(call(`${orch.url}/wallet/intents/intent_${'x'.repeat(43)}/submit`, { owner: OWNER, signed_data: { signed_delegate: 'A'.repeat(64) } }), 404, /no signature request/);
  await refused(call(`${orch.url}/wallet/intents/${g.correlation_id}/submit`, { owner: OWNER, signed_data: { signature: 'x' } }), 400, /signed_delegate/);
  let v = await call(`${orch.url}/wallet/intents/${g.correlation_id}/submit`, { owner: OWNER, signed_data: { signed_delegate: 'A'.repeat(64), payload: { evil: true } } });
  const submitted = api.requests.find((r) => r.path === '/v1/submit-intent')!.body;
  assert.deepEqual(submitted.signed_data, { ...g.intent, signed_delegate: 'A'.repeat(64) }); // the payload as issued
  assert.deepEqual([v.status, v.next_step, v.rules], ['active', 'allow_destination', rules]);
  ({ near_account_id: near, agent_id: agentId } = v);
  assert.match(near, /^[0-9a-f]{64}$/);
  await refused(call(`${orch.url}/wallet/intents/${g.correlation_id}/submit`, { owner: OWNER, signed_data: { signed_delegate: 'A'.repeat(64) } }), 409, /already/);
  await refused(call(`${orch.url}/wallet/intents`, { owner: OWNER, type: 'agent_create', public_key: PK }), 409, /already have an agent wallet/);
  await refused(call(`${orch.url}/wallet/intents`, { owner: OWNER, type: 'grant_issue' }), 409, /Allow the withdrawal/);

  v = await sign('policy_update');
  assert.equal(v.next_step, 'issue_grant');
  assert.deepEqual(api.agents.get(agentId)!.policy, policyFor(rules, near)); // its own account is now a destination

  v = await sign('grant_issue');
  assert.equal(v.next_step, 'ready');
  const [grantId, g2] = [...api.agents.get(agentId)!.grants][0];
  assert.deepEqual(v.grant, { grant_id: grantId, expires_at: g2.expires_at });
  const days = (Date.parse(g2.expires_at) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `grant lasts ${days} days`);
  assert.equal(g2.label, 'Rook');
  assert.match(g2.credential, /^[0-9a-f]{64}$/); // the API sees only the token's SHA-256
  assert.ok(!JSON.stringify(v).includes('ngt_'));
  assert.deepEqual([v.budget?.period, v.budget?.limit_usd, v.budget?.remaining_usd, v.pending_approvals], ['month', 100, 100, []]);
});

test('fund from the wallet: refused over the per-task limit, unregistered, or short of USDC; then withdraw, transfer, bind, run, and the leftover swept back', async () => {
  const t3 = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '3', owner: OWNER });
  await refused(call(`${orch.url}/tasks/${t3.id}/fund-from-wallet`, { owner: OWNER }), 409, /^This task's budget is 3\.00 USDC, above your limit of 2\.00 USDC per task\.$/);
  const t = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1', owner: OWNER });
  await refused(call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: 'bob.near' }), 404, /no task/);
  await refused(call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: OWNER }), 409, /can't receive USDC yet/);
  registered.add(near); // the user's deposit registered it
  await refused(call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: OWNER }), 409, /holds 0\.00 USDC and this task needs 1\.00 USDC/);
  api.deposit(agentId, 5_000_000n);

  const a = await call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: OWNER });
  assert.equal(a.status, 'approved');
  assert.deepEqual([a.wallet_funding.state, a.wallet_funding.amount_atomic], ['withdrawing', '1000000']);
  await refused(call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: OWNER }), 409, /already/);
  const s = await until(() => snap(t.id), (x: any) => ['closed', 'failed', 'planned'].includes(x.task.status));
  assert.equal(s.task.status, 'closed', JSON.stringify(s.task.wallet_funding));
  const ct = contractTasks.get('0');
  assert.deepEqual([ct.funder, ct.budget, ct.reserve, ct.caps], [near, '1000000', '200000', ['300000', '200000']]);
  assert.equal(s.task.funder, near); // the agent wallet's account funded it, as the contract records
  assert.deepEqual([s.task.wallet_funding.state, s.task.wallet_funding.tx_hash], ['bound', 'tx1']);
  assert.equal(s.ledger.contract_task_id, '0');

  // The withdrawal went to the wallet's own account, the call to USDC with the plan's create_task msg, both under the grant.
  const w = api.requests.find((r) => r.path.endsWith('/withdraw'))!;
  assert.deepEqual(w.body, { asset: USDC_ASSET, amount: '1000000', chain: 'near', recipient: near });
  const c = api.requests.find((r) => r.path.endsWith('/native/near/call'))!;
  assert.deepEqual(c.body, {
    receiver_id: USDC_CONTRACT, method_name: 'ft_transfer_call', gas: '100000000000000', deposit: '1',
    args: { receiver_id: CONTRACT, amount: '1000000', msg: '{"create_task":{"reserve_bps":2000,"caps":["300000","200000"]}}' },
  });
  grantToken = w.grant!;
  assert.match(grantToken, /^ngt_[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(grantToken).digest('hex'), [...api.agents.get(agentId)!.grants.values()][0].credential);
  assert.ok(w.idem && c.idem && w.idem !== c.idem);
  assert.ok(api.requests.filter((r) => r.path !== '/v1/whoami').every((r) => r.key)); // the partner key on every call (whoami tried wrong ones)
  assert.ok(api.requests.filter((r) => r.grant).every((r) => r.method === 'POST' && /\/(withdraw|native\/near\/call)$/.test(r.path)));
  // The grant token reaches no view: not the task, not the wallet, not its events.
  assert.ok(!JSON.stringify([s, await wallet(), await walletOps(t.id)]).includes(grantToken));

  // The run spent 450000 of 1000000: the contract refunded 550000 to the wallet's account, and Rook swept it back in.
  const swept = await until(() => walletOps(t.id), (x) => x.some((e: any) => e.op === 'wallet_swept'));
  assert.deepEqual(swept.map((e: any) => e.op), ['wallet_withdraw', 'wallet_transfer', 'wallet_bound', 'wallet_swept']);
  assert.deepEqual(swept.at(-1).amount_atomic, '550000');
  assert.equal(native.get(near), 0n);
  assert.equal(api.agents.get(agentId)!.balance, 5_000_000n - 1_000_000n + 550_000n);
  const sweep = api.requests.filter((r) => r.path.endsWith('/native/near/call')).at(-1)!.body;
  assert.deepEqual(sweep.args, { receiver_id: 'intents.near', amount: '550000', msg: near });
  const v = await wallet();
  assert.deepEqual([v.balance_atomic, v.native_balance_atomic, v.budget.spent_usd], ['4550000', '0', 1]);
});

test('a send the API answers retryable is repeated under the same key until it lands; a chain-gateway blip at the bind is retried', async () => {
  api.busy('/withdraw', 6); // "may have taken effect": only the same key can tell, so Rook keeps asking with it
  let blips = 2;
  gwTask = (id) => {
    if (blips-- > 0) throw new HttpError(503, 'chain-gateway busy');
    return undefined;
  };
  try {
    const before = api.requests.length;
    const t = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1', owner: OWNER });
    await call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: OWNER });
    const s = await until(() => snap(t.id), (x: any) => ['closed', 'failed', 'planned'].includes(x.task.status));
    assert.equal(s.task.status, 'closed', JSON.stringify(s.task.wallet_funding));
    const keys = api.requests.slice(before).filter((r) => r.path.endsWith('/withdraw')).map((r) => r.idem);
    assert.equal(keys.length, 7);
    assert.equal(new Set(keys).size, 1);
    assert.ok(blips < 0);
    await until(() => walletOps(t.id), (x) => x.some((e: any) => e.op === 'wallet_swept'));
  } finally { gwTask = null; }
});

test('a contract task the funding created but could not bind is closed, and its USDC swept back into the wallet', async () => {
  const has = api.agents.get(agentId)!.balance;
  gwTask = (id) => ({ task: { ...contractTasks.get(id), killed: true }, subtasks: [] }); // it can never match the plan
  try {
    const t = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1', owner: OWNER });
    await call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: OWNER });
    const s = await until(() => snap(t.id), (x: any) => x.task.wallet_funding?.state === 'failed');
    assert.equal(s.task.status, 'planned');
    const cid = String(nextTask - 1);
    assert.equal(contractTasks.get(cid).status, 'Closed'); // Rook closed it: the contract refunded the wallet's account
    assert.match(s.task.wallet_funding.error, new RegExp(`^The USDC reached Rook's contract as task ${cid}, but the run could not start: .*Rook closed that contract task`));
    assert.notEqual(s.task.status, 'failed'); // the USDC came back: not a stop for the double-funding guard
    await until(() => walletOps(t.id), (x) => x.some((e: any) => e.op === 'wallet_swept'));
    assert.equal(native.get(near), 0n);
    assert.equal(api.agents.get(agentId)!.balance, has); // all of it back in the wallet
  } finally { gwTask = null; }
});

test('a transfer that went through but whose contract task cannot be read says the USDC was sent, never that it is still on the account', async () => {
  // Browser QA 2026-11-12: NEAR's RPC timed out on the transaction, and the page said the USDC was on the wallet's account.
  gwCreated = () => { throw new HttpError(502, 'NEAR RPC tx: TIMEOUT_ERROR {"cause":"NOT_OBSERVED"}'); };
  try {
    const t = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1', owner: OWNER });
    await call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: OWNER });
    const s = await until(() => snap(t.id), (x: any) => x.task.wallet_funding?.state === 'failed');
    const { error, tx_hash } = s.task.wallet_funding;
    assert.ok(tx_hash);
    assert.ok(error.startsWith(`Your agent wallet's NEAR account sent 1.00 USDC to Rook's contract (transaction ${tx_hash}), but Rook couldn't read the contract task it made: NEAR didn't show that transaction in time.`), error);
    assert.match(error, /this plan stops here: check that transaction, then send the task again.$/);
    assert.doesNotMatch(error, /TIMEOUT_ERROR|is on your agent wallet's NEAR account/);
    // USDC that may sit in a contract task never leaves the plan fundable: a second funding would pay twice.
    assert.equal(s.task.status, 'failed');
    await assert.rejects(call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: OWNER }));
    await assert.rejects(call(`${orch.url}/tasks/${t.id}/approve`, { owner: OWNER }));
  } finally { gwCreated = null; }
  // What did reach the contract is not this test's: the next tests start from a wallet without that open contract task.
  for (const [id, ct] of contractTasks) if (ct.status === 'Open' && ct.funder === near) ct.status = 'Closed';
});

test('budgetCovers: the budget window is compared in atomic USDC, not floats', async () => {
  const { budgetCovers } = await import('../src/wallet/policy.ts');
  assert.equal(budgetCovers('1.15', 1_150_000n), true); // 1.15 * 1e6 is 1149999.99... as a float
  assert.equal(budgetCovers('1.149999', 1_150_000n), false);
  assert.equal(budgetCovers('0', 1n), false);
  assert.equal(budgetCovers(null, 10n ** 12n), true);
});

test('owner approval: the withdrawal waits for the vote; approve runs it, reject or expiry leave the plan to fund again', async () => {
  let v = await sign('policy_update', { rules: { budget_usd: 100, per_task_max_usd: 2, approval: 'every' } });
  assert.equal(api.agents.get(agentId)!.policy.owner_approval, true);
  assert.equal(v.rules.approval, 'every');

  const fund = async () => {
    const t = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1', owner: OWNER });
    await call(`${orch.url}/tasks/${t.id}/fund-from-wallet`, { owner: OWNER });
    const s = await until(() => snap(t.id), (x: any) => x.task.wallet_funding?.state === 'awaiting_approval');
    assert.equal(s.task.wallet_funding.state, 'awaiting_approval');
    return { id: t.id, approval_id: s.task.wallet_funding.approval_id as string };
  };

  const a = await fund();
  assert.match(a.approval_id, /^[0-9a-f-]{36}$/);
  v = await wallet();
  assert.deepEqual(v.pending_approvals.map((x: any) => [x.approval_id, x.task_id, x.amount_atomic]), [[a.approval_id, a.id, '1000000']]);
  assert.ok(v.pending_approvals[0].created_at);
  assert.deepEqual((await walletOps(a.id)).map((e: any) => e.op), ['wallet_withdraw', 'wallet_approval_needed']);
  // While the wallet's withdrawal waits, the user's own funding or a second wallet funding would fund it twice.
  await refused(call(`${orch.url}/tasks/${a.id}/approve`, { owner: OWNER }), 409, /being funded from your agent wallet/);
  await refused(call(`${orch.url}/tasks/${a.id}/funded`, { owner: OWNER, contract_task_id: '9' }), 409, /being funded from your agent wallet/);
  await refused(call(`${orch.url}/conversations/${a.id}/delete`, { owner: OWNER }), 409, /^A plan in this chat is being funded from your agent wallet\. Wait for it, or stop it on its page, then delete the chat\.$/);
  await sign('approval_vote', { approval_id: a.approval_id, verdict: 'approve' });
  const done = await until(() => snap(a.id), (x: any) => ['closed', 'failed', 'planned'].includes(x.task.status));
  assert.equal(done.task.status, 'closed', JSON.stringify(done.task.wallet_funding));
  assert.equal(done.task.wallet_funding.state, 'bound');

  const r = await fund();
  await sign('approval_vote', { approval_id: r.approval_id, verdict: 'reject' });
  const rejected = await until(() => snap(r.id), (x: any) => x.task.status !== 'approved');
  assert.deepEqual([rejected.task.status, rejected.task.wallet_funding.state], ['planned', 'failed']);
  assert.equal(rejected.task.wallet_funding.error, "You rejected this spend, so Rook didn't fund the task. Your USDC is still in your agent wallet.");
  assert.deepEqual((await walletOps(r.id)).map((e: any) => e.op), ['wallet_withdraw', 'wallet_approval_needed', 'wallet_failed']);
  assert.deepEqual((await wallet()).pending_approvals, []);

  const x = await fund();
  api.expire(x.approval_id);
  const expired = await until(() => snap(x.id), (y: any) => y.task.status !== 'approved');
  assert.deepEqual([expired.task.status, expired.task.wallet_funding.error], ['planned', 'The approval request expired before you answered. Your USDC is still in your agent wallet.']);
  // Approvable again: the next funding is a new withdrawal under a new key.
  const again = await call(`${orch.url}/tasks/${x.id}/fund-from-wallet`, { owner: OWNER });
  assert.equal(again.wallet_funding.state, 'withdrawing');
  assert.notEqual(again.wallet_funding.key, expired.task.wallet_funding.key);
  await until(() => snap(x.id), (y: any) => y.task.wallet_funding?.state === 'awaiting_approval');
  await call(`${orch.url}/tasks/${x.id}/kill`, { owner: OWNER }); // stopped while it waits: nothing reached the contract
  const killed = await until(() => snap(x.id), (y: any) => y.task.wallet_funding?.state === 'failed');
  assert.deepEqual([killed.task.status, killed.task.wallet_funding.error], ['killed', "Stopped before the USDC reached Rook's contract. If the withdrawal still goes through, Rook moves the USDC back into your agent wallet."]);
  assert.ok(!allText().includes('ngt_')); // no read ever carried the grant
});

test('a restart picks the wallet funding up where it was: the wallet and its grant come back from ROOK_DB, the vote goes through, the run follows', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rook-wallet-'));
  process.env.ROOK_DB = join(dir, 'rook.db');
  const start = async () => (await import('../src/orchestrator/index.ts')).start(0);
  const CAROL = 'carol.near';
  let o = await start();
  try {
    await sign('agent_create', { rules: { approval: 'every' }, public_key: PK }, o.url, CAROL);
    await sign('policy_update', {}, o.url, CAROL);
    const v = await sign('grant_issue', {}, o.url, CAROL);
    assert.equal(v.next_step, 'ready');
    registered.add(v.near_account_id);
    api.deposit(v.agent_id, 2_000_000n);
    const t = await call(`${o.url}/tasks`, { prompt: 'p', budget_usdc: '1', owner: CAROL });
    await call(`${o.url}/tasks/${t.id}/fund-from-wallet`, { owner: CAROL });
    const waiting = await until(() => snap(t.id, o.url, CAROL), (x: any) => x.task.wallet_funding?.state === 'awaiting_approval');
    const approval_id = waiting.task.wallet_funding.approval_id;
    await o.close(); // a shutdown is not a failure: the funding stays where it was
    gwDown = true; // and the chain-gateway comes up after Rook: the resume waits for it
    o = await start();
    setTimeout(() => { gwDown = false; }, 100);
    const back = await wallet(o.url, CAROL);
    assert.deepEqual([back.next_step, back.agent_id, back.pending_approvals.map((x: any) => [x.approval_id, x.task_id])], ['ready', v.agent_id, [[approval_id, t.id]]]);
    assert.deepEqual([(await snap(t.id, o.url, CAROL)).task.status, (await snap(t.id, o.url, CAROL)).task.wallet_funding.state], ['approved', 'awaiting_approval']);
    await sign('approval_vote', { approval_id, verdict: 'approve' }, o.url, CAROL);
    const done = await until(() => snap(t.id, o.url, CAROL), (x: any) => ['closed', 'failed', 'planned'].includes(x.task.status));
    assert.equal(done.task.status, 'closed', JSON.stringify(done.task.wallet_funding));
    assert.equal(contractTasks.get(done.ledger.contract_task_id).funder, v.near_account_id);
    // One withdrawal across both starts: the resumed funding followed the one it had sent.
    assert.equal(api.requests.filter((r) => r.path === `/v1/agents/${v.agent_id}/withdraw`).length, 1);
    assert.deepEqual((await walletOps(t.id, o.url, CAROL)).map((e: any) => e.op).slice(0, 4), ['wallet_withdraw', 'wallet_approval_needed', 'wallet_transfer', 'wallet_bound']);
  } finally {
    await o.close();
    delete process.env.ROOK_DB;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stored wallet the API no longer knows (a new API key, say demo to production) is set aside, and a new setup can start', async () => {
  const DAVE = 'dave.near';
  await sign('agent_create', { rules: { budget_usd: 50 }, public_key: PK }, orch.url, DAVE);
  await sign('policy_update', {}, orch.url, DAVE);
  const first = await sign('grant_issue', {}, orch.url, DAVE);
  assert.equal(first.next_step, 'ready');
  api.agents.delete(first.agent_id); // the API key that made it is gone
  // Asking to create a new one finds the old one gone and goes ahead.
  const g = await call(`${orch.url}/wallet/intents`, { owner: DAVE, type: 'agent_create', rules: { budget_usd: 50 }, public_key: PK });
  assert.equal(g.type, 'agent_create');
  const second = await call(`${orch.url}/wallet/intents/${g.correlation_id}/submit`, { owner: DAVE, signed_data: { signed_delegate: 'A'.repeat(64) } });
  assert.deepEqual([second.next_step, second.grant], ['allow_destination', null]);
  assert.notEqual(second.agent_id, first.agent_id);
  // Reading the wallet finds it gone too: no wallet shows, the rules stay, the old one is kept aside.
  api.agents.delete(second.agent_id);
  const v = await wallet(orch.url, DAVE);
  assert.deepEqual([v.status, v.agent_id, v.next_step, v.grant, v.rules], ['none', null, null, null, { budget_usd: 50 }]);
  const kept = await call(`${orch.url}/wallet/intents`, { owner: DAVE, type: 'agent_create', public_key: PK });
  assert.equal(kept.type, 'agent_create');
});
