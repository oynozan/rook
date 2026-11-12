// The agent wallet's routes (lib/server/wallet.ts) against a stand-in orchestrator on a local port: the owner always
// comes from the session, an agent_create's rules from the plan Rook holds, its owner key only once NEAR calls it a
// full-access key, and only the fields the page reads go back. Nothing here reaches the Agent API.
// Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

type Seen = { method: string; path: string; body: any };
const seen: Seen[] = [];
let reply: (s: Seen) => { status: number; body: unknown } = () => ({ status: 500, body: { error: 'no reply set' } });

const KEY = `ed25519:${'1'.repeat(44)}`;
const PLAN = { subtasks: [], dropped: [], budget: { reserve_atomic: '0', allocated_atomic: '0' }, spending: { budget_usd: 1000, period: 'month', approval: 'every' } };
const snapshot = (owner: string) => ({ task: { id: 't_1', owner, status: 'planned', budget_atomic: '3000000' }, plan: PLAN, receipts: [], ledger: null, final_result: null });
const WALLET = {
  configured: true, owner: 'ozan.near', agent_id: 'agt_1', near_account_id: 'a'.repeat(64), status: 'active', next_step: 'ready', rules: PLAN.spending,
  policy: { owner_approval: true }, balance_atomic: '25000000', native_balance_atomic: '0', budget: null, grant: { grant_id: 'grt_1', expires_at: '2027-01-01T00:00:00Z' },
  pending_approvals: [], grant_token: 'ngt_secret_never_shown',
};

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const s: Seen = { method: req.method ?? '', path: req.url ?? '', body: raw ? JSON.parse(raw) : null };
  seen.push(s);
  const out = reply(s);
  res.writeHead(out.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out.body));
});

let w: typeof import('@/lib/server/wallet');
before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  process.env.ORCHESTRATOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // read when orchestrator.ts loads
  w = await import('@/lib/server/wallet');
});
after(() => server.close());

const fresh = (r: typeof reply) => { seen.length = 0; reply = r; };
const yes = { fullAccess: async () => true };

test('GET /wallet: as the signed-in owner, with only the fields the page reads; no wallet routes means not configured', async () => {
  fresh(() => ({ status: 200, body: WALLET }));
  const out = await w.readWallet('ozan.near');
  assert.equal(seen[0].path, '/wallet?owner=ozan.near');
  assert.equal(out.status, 200);
  assert.equal(out.body.balance_atomic, '25000000');
  assert.doesNotMatch(JSON.stringify(out.body), /ngt_secret/);
  fresh(() => ({ status: 404, body: { error: 'not found' } })); // an orchestrator from before the agent wallet
  assert.deepEqual([(await w.readWallet('ozan.near')).body.configured], [false]);
});

test("agent_create: the rules are the plan's and the owner the session's, whatever the browser sends", async () => {
  fresh((s) => s.path.startsWith('/tasks/') ? { status: 200, body: snapshot('ozan.near') }
    : { status: 200, body: { correlation_id: 'intent_1', type: 'agent_create', intent: { standard: 'nep366', payload: { receiverId: 'x', actions: [] } }, summary: 'Create an agent', expires_at: 'e', extra: 'dropped' } });
  const out = await w.prepareIntent('ozan.near', { type: 'agent_create', task_id: 't_1', public_key: KEY, owner: 'evil.near', rules: { budget_usd: 999999 } }, yes);
  assert.equal(out.status, 200);
  assert.equal(seen[0].path, '/tasks/t_1?owner=ozan.near');
  assert.deepEqual(seen[1], { method: 'POST', path: '/wallet/intents', body: { owner: 'ozan.near', type: 'agent_create', rules: PLAN.spending, public_key: KEY } });
  assert.equal(out.body.correlation_id, 'intent_1');
  assert.equal('extra' in out.body, false);
});

test("agent_create: someone else's task is no task, a plan with no rules has none to give, and a key NEAR doesn't call full access is refused", async () => {
  fresh(() => ({ status: 200, body: snapshot('other.near') }));
  assert.equal((await w.prepareIntent('ozan.near', { type: 'agent_create', task_id: 't_1', public_key: KEY }, yes)).status, 404);
  assert.equal(seen.length, 1); // nothing generated

  fresh(() => ({ status: 200, body: { ...snapshot('ozan.near'), plan: { ...PLAN, spending: undefined } } }));
  const none = await w.prepareIntent('ozan.near', { type: 'agent_create', task_id: 't_1', public_key: KEY }, yes);
  assert.equal(none.status, 400);
  assert.match(String(none.body.error), /states no spending rules/);

  fresh(() => ({ status: 200, body: snapshot('ozan.near') }));
  const limited = await w.prepareIntent('ozan.near', { type: 'agent_create', task_id: 't_1', public_key: KEY }, { fullAccess: async () => false });
  assert.equal(limited.status, 403);
  assert.match(String(limited.body.error), /isn't one of ozan\.near's full-access keys/);
  assert.equal(seen.length, 1);

  fresh(() => ({ status: 404, body: { error: 'no task t_9' } }));
  assert.equal((await w.prepareIntent('ozan.near', { type: 'agent_create', task_id: 't_9', public_key: KEY }, yes)).status, 404);
});

test('a vote carries its approval and verdict; a refusal comes back in plain words, with whether trying again may help', async () => {
  fresh(() => ({ status: 409, body: { error: 'Agent API refused: approval_closed' } }));
  const closed = await w.prepareIntent('ozan.near', { type: 'approval_vote', approval_id: 'apr_1', verdict: 'approve' });
  assert.deepEqual(seen[0].body, { owner: 'ozan.near', type: 'approval_vote', approval_id: 'apr_1', verdict: 'approve' });
  assert.deepEqual([closed.status, closed.body], [409, { error: "Rook couldn't prepare your vote for signing: this approval is already closed." }]);

  fresh(() => ({ status: 503, body: { error: 'Agent API 503 sponsor_busy' } }));
  const busy = await w.prepareIntent('ozan.near', { type: 'grant_issue' });
  assert.deepEqual([busy.status, busy.body], [503, { error: "Rook couldn't prepare this step for your signature: the Agent API is busy right now. Try again in a moment.", retry: true }]);
  fresh(() => ({ status: 500, body: { error: 'TypeError: x is undefined' } })); // Rook's own crash: said as one, its text logged
  const crash = await w.prepareIntent('ozan.near', { type: 'grant_issue' });
  assert.equal(crash.status, 502);
  assert.match(String(crash.body.error), /^Rook couldn't prepare this step for your signature: Rook's orchestrator hit an error/);

  fresh(() => ({ status: 409, body: { error: 'intent_expired' } }));
  assert.equal((await w.submitIntent('ozan.near', 'intent_1', { signed_data: { standard: 'nep413', payload: { a: 1 }, public_key: KEY, signature: 's' } })).body.retry, true);
});

test("a signature is forwarded as the wallet gave it, for the session's owner; anything that isn't one never leaves", async () => {
  fresh(() => ({ status: 200, body: WALLET }));
  const signed = { standard: 'nep413', payload: { message: 'm', nonce: 'n', recipient: 'r' }, public_key: KEY, signature: 'sig' };
  const out = await w.submitIntent('ozan.near', 'intent_1', { signed_data: signed, owner: 'evil.near' });
  assert.deepEqual(seen[0], { method: 'POST', path: '/wallet/intents/intent_1/submit', body: { owner: 'ozan.near', signed_data: signed } });
  assert.doesNotMatch(JSON.stringify(out.body), /ngt_secret/);

  fresh(() => ({ status: 200, body: WALLET }));
  assert.equal((await w.submitIntent('ozan.near', 'intent_1', { signed_data: { standard: 'eip712', payload: {} } })).status, 400);
  assert.equal((await w.submitIntent('ozan.near', '../tasks', { signed_data: signed })).status, 400);
  assert.equal(seen.length, 0);
});

test("funding from the wallet: only the task's owner, and the funding state comes back", async () => {
  fresh((s) => s.method === 'GET' ? { status: 200, body: snapshot('ozan.near') }
    : { status: 200, body: { id: 't_1', status: 'approved', wallet_funding: { state: 'awaiting_approval', agent_id: 'agt_1', amount_atomic: '3000000', approval_id: 'apr_1' } } });
  const out = await w.fundTaskFromWallet('ozan.near', 't_1');
  assert.deepEqual(seen.map((s) => [s.method, s.path, s.body]), [['GET', '/tasks/t_1?owner=ozan.near', null], ['POST', '/tasks/t_1/fund-from-wallet', { owner: 'ozan.near' }]]);
  assert.deepEqual(out.body, { status: 'approved', wallet_funding: { state: 'awaiting_approval', agent_id: 'agt_1', amount_atomic: '3000000', approval_id: 'apr_1' } });

  fresh(() => ({ status: 200, body: snapshot('other.near') }));
  assert.equal((await w.fundTaskFromWallet('ozan.near', 't_1')).status, 404);
  assert.equal(seen.length, 1);

  fresh((s) => s.method === 'GET' ? { status: 200, body: snapshot('ozan.near') } : { status: 403, body: { error: 'withdraw refused: spend_budget_exceeded' } });
  assert.equal((await w.fundTaskFromWallet('ozan.near', 't_1')).body.error,
    "Rook couldn't fund this task from your agent wallet: your agent wallet's budget for this period is used up.");
});

test('an orchestrator that is down says so, and nothing else is tried', async () => {
  const was = server.address() as AddressInfo;
  await new Promise<void>((ok) => server.close(() => ok()));
  const out = await w.readWallet('ozan.near');
  assert.equal(out.status, 503);
  assert.match(String(out.body.error), /^Rook's orchestrator isn't answering/);
  await new Promise<void>((ok) => server.listen(was.port, '127.0.0.1', ok));
});
