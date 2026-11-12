// A local stand-in for the NEAR Intents Agent API (api.agentsonintents.com), for tests only: nothing calls the real
// API. It implements the routes Rook uses as the API's /openapi.json and its skill's references describe them (read
// 2026-11-12): JSON:API errors with code and layer, 201/202 answers, request bodies checked against the spec's own
// schemas (fixtures/agent-api-requests.schema.json), grant tokens checked against the SHA-256 the owner signed,
// Idempotency-Key replays, policy checks (actions, assets, destinations, per-transaction limit, USD budget, native
// call list and its deposit's destination), and the PENDING_APPROVAL flow with approval_vote.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Ajv } from 'ajv';

const schemas = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/agent-api-requests.schema.json'), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
const check = {
  generate: ajv.compile(schemas.generate_intent), submit: ajv.compile(schemas.submit_intent),
  withdraw: ajv.compile(schemas.withdraw), nearCall: ajv.compile(schemas.near_call), policy: ajv.compile(schemas.Policy),
};

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const hex = (n: number) => randomBytes(n).toString('hex');
const cid = (prefix: 'op' | 'intent') => `${prefix}_${randomBytes(33).toString('base64url').slice(0, 43)}`;
const now = () => new Date().toISOString();

class ApiErr extends Error {
  constructor(public status: number, public code: string, public layer: string, public meta: Record<string, unknown> = {}) { super(code); }
}

type Agent = {
  id: string; owner: { type: 'near'; account_id: string; public_key: string }; status: 'PENDING' | 'ACTIVE'; near: string;
  policy: any; revision: number; balance: bigint; spent_usd: number;
  grants: Map<string, { credential: string; label: string; issued_at: string; expires_at: string }>;
};
type Op = {
  correlation_id: string; agent_id: string | null; type: string; status: string; failure_code: string | null; created_at: string; updated_at: string;
  details: Record<string, any>; grant: { id: string; label: string } | null;
  next?: () => void; // run on the next status read: how a dispatched operation settles
};

/**
 * `onNearCall`: what NEAR does with a native function call from `account` (Rook's tests move mock-chain balances
 * there); answers the transaction hash, or null for a finalized failure. `onWithdraw`: a withdrawal on chain `near`
 * landing at `recipient`. `registered`: whether a NEAR account can receive the token (a withdrawal to one that can't is
 * refused with 409 invalid_address, as the API does). `port`: where it listens (default any free port; a fixed one for
 * running it standalone against the web app, services/.ops).
 */
export async function startAgentApiMock(hooks: {
  key: string;
  onNearCall: (account: string, body: any) => string | null;
  onWithdraw: (recipient: string, amount: bigint) => void;
  registered: (account: string) => boolean;
  port?: number;
}) {
  const agents = new Map<string, Agent>();
  const intents = new Map<string, { type: string; body: any; agent_id: string; intent: any; signer: Agent['owner']; done: boolean }>();
  const ops = new Map<string, Op>();
  const idem = new Map<string, { body: string; cid: string }>();
  const approvals = new Map<string, { approval_id: string; status: string; op: string; amount: bigint; usd: number; expires_at: string; request_data: any }>();
  const requests: { method: string; path: string; grant: string | undefined; idem: string | undefined; key: boolean; body: any }[] = [];

  const agentOf = (id: string) => { const a = agents.get(id); if (!a) throw new ApiErr(404, 'agent_not_found', 'request'); return a; };
  const op = (o: Omit<Op, 'created_at' | 'updated_at' | 'failure_code' | 'grant'> & Partial<Op>): Op => {
    const x: Op = { failure_code: null, grant: null, created_at: now(), updated_at: now(), ...o };
    ops.set(x.correlation_id, x);
    return x;
  };
  const view = (o: Op) => { const { next: _n, ...rest } = o; return { dispatch_committed_at: null, ...rest }; };
  const grantOf = (a: Agent, token: string | undefined) => {
    const credential = token ? createHash('sha256').update(token).digest('hex') : '';
    const g = [...a.grants.entries()].find(([, x]) => x.credential === credential && Date.parse(x.expires_at) > Date.now());
    if (!g) throw new ApiErr(403, 'agent_grant_required', 'grant');
    return { id: g[0], label: g[1].label };
  };
  const budgetLimit = (a: Agent) => {
    const b = a.policy.budget;
    return Number(b.monthly_usd ?? b.weekly_usd ?? b.daily_usd ?? Infinity);
  };
  const window = (a: Agent, which: 'daily_usd' | 'weekly_usd' | 'monthly_usd') => {
    const limit = a.policy.budget[which];
    return limit === null
      ? { limit_usd: null, spent_usd: null, remaining_usd: null, resets_at: null }
      : { limit_usd: limit, spent_usd: String(a.spent_usd), remaining_usd: String(Math.max(0, Number(limit) - a.spent_usd)), resets_at: '2026-12-12T00:00:00.000Z' };
  };
  /** One Idempotency-Key, one operation: the same key and body replay it; another body under the key is refused. */
  const replay = (agent: string, key: string | undefined, body: unknown, make: () => Op) => {
    if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApiErr(400, 'validation_failed', 'request');
    const k = `${agent}/${key}`, b = JSON.stringify(body), seen = idem.get(k);
    if (seen) { if (seen.body !== b) throw new ApiErr(409, 'idempotency_conflict', 'request'); return ops.get(seen.cid)!; }
    const o = make();
    idem.set(k, { body: b, cid: o.correlation_id });
    return o;
  };
  const valid = (v: (x: unknown) => boolean, body: unknown) => { if (!v(body)) throw new ApiErr(400, 'validation_failed', 'request', { errors: (v as any).errors }); };

  function generate(b: any) {
    valid(check.generate, b);
    let agent_id: string, signer: Agent['owner'], intent: any;
    const nep413 = (message: string) => ({ standard: 'nep413', payload: { message, recipient: 'api.agentsonintents.com', nonce: randomBytes(32).toString('base64') } });
    if (b.type === 'agent_create') {
      agent_id = hex(32);
      signer = b.owner;
      agents.set(agent_id, { id: agent_id, owner: b.owner, status: 'PENDING', near: hex(32), policy: b.policy, revision: 0, balance: 0n, spent_usd: 0, grants: new Map() });
      intent = { standard: 'nep366', payload: { receiverId: 'agents.sponsor.near', actions: [{ type: 'FunctionCall', params: { methodName: 'create_wallet', args: { agent_id }, gas: '30000000000000', deposit: '0' } }] } };
    } else {
      const a = agentOf(b.agent_id);
      agent_id = a.id;
      signer = a.owner;
      if (b.type === 'policy_update' && b.expected_revision !== a.revision) throw new ApiErr(409, 'policy_revision_conflict', 'request');
      if (b.type === 'approval_vote' && approvals.get(b.approval_id)?.status !== 'PENDING') throw new ApiErr(409, 'approval_closed', 'request');
      intent = nep413(JSON.stringify({ type: b.type, agent_id }));
    }
    const correlation_id = cid('intent');
    intents.set(correlation_id, { type: b.type, body: b, agent_id, intent, signer, done: false });
    const preview = { summary: `${b.type} for ${signer.account_id}`, ...(b.policy ? { policy: b.policy, revision: (agents.get(agent_id)?.revision ?? 0) + 1 } : {}) };
    return { status: 201, body: { correlation_id, type: b.type, agent_id, status: 'PENDING_SIGNATURE', expires_at: new Date(Date.now() + 600_000).toISOString(), signer, intent, preview } };
  }

  function submit(b: any) {
    valid(check.submit, b);
    const i = intents.get(b.correlation_id);
    if (!i || i.type !== b.type) throw new ApiErr(404, 'intent_not_found', 'request');
    if (JSON.stringify(b.signed_data.payload) !== JSON.stringify(i.intent.payload) || b.signed_data.standard !== i.intent.standard) {
      throw new ApiErr(400, 'intent_payload_mismatch', 'request');
    }
    if (i.intent.standard === 'nep413' && b.signed_data.public_key !== i.signer.public_key) throw new ApiErr(403, 'signer_mismatch', 'auth');
    if (i.done) return { status: 202, body: view(ops.get(b.correlation_id)!) };
    i.done = true;
    const a = agents.get(i.agent_id)!;
    let details: any = {};
    if (i.type === 'agent_create') { a.status = 'ACTIVE'; a.revision = 1; details = { agent_id: a.id, revision: 1, policy_hash: hex(32), transaction_hash: 'tx' }; }
    if (i.type === 'policy_update') { a.policy = i.body.policy; a.revision++; details = { revision: a.revision, policy_hash: hex(32), transaction_hash: null }; }
    if (i.type === 'grant_issue') {
      const grant_id = hex(32);
      a.grants.set(grant_id, { credential: i.body.credential, label: i.body.label, issued_at: now(), expires_at: i.body.expires_at });
      details = { grant: { grant_id, agent_id: a.id, label: i.body.label, issued_at: now(), expires_at: i.body.expires_at, revoked_at: null } };
    }
    if (i.type === 'approval_vote') {
      const ap = approvals.get(i.body.approval_id)!;
      const held = ops.get(ap.op)!;
      ap.status = i.body.verdict === 'approve' ? 'APPROVED' : 'REJECTED';
      if (ap.status === 'APPROVED') dispatchWithdraw(a, held, ap.amount);
      else { a.spent_usd -= ap.usd; Object.assign(held, { status: 'FAILED', failure_code: 'rejected', details: { ...held.details, never_executed: true } }); }
      details = { approval_id: ap.approval_id, verdict: i.body.verdict };
    }
    // An on-chain owner change (nep366) reads PROCESSING once, then SUCCESS; off-chain ones settle at once.
    const o = op({ correlation_id: b.correlation_id, agent_id: a.id, type: i.type, status: i.intent.standard === 'nep366' ? 'PROCESSING' : 'SUCCESS', details });
    if (o.status === 'PROCESSING') o.next = () => { o.status = 'SUCCESS'; };
    return { status: 202, body: view(o) };
  }

  function dispatchWithdraw(a: Agent, o: Op, amount: bigint) {
    o.status = 'PROCESSING';
    o.next = () => { a.balance -= amount; hooks.onWithdraw(o.details.request.recipient, amount); Object.assign(o, { status: 'SUCCESS', updated_at: now() }); };
  }

  function withdraw(a: Agent, headers: Record<string, string | undefined>, b: any) {
    const grant = grantOf(a, headers.grant);
    valid(check.withdraw, b);
    return replay(a.id, headers.idem, b, () => {
      const p = a.policy, amount = BigInt(b.amount), usd = Number(amount) / 1e6;
      if (!p.actions.includes('withdraw')) throw new ApiErr(403, 'policy_action_denied', 'policy');
      if (p.assets !== 'any' && !p.assets.includes(b.asset)) throw new ApiErr(403, 'policy_asset_denied', 'policy');
      const dest = p.destinations.list.some((d: any) => d.action === 'withdraw' && d.chain === b.chain && d.address === b.recipient && d.memo === (b.memo ?? null));
      if (p.destinations.mode === 'only' && !dest) throw new ApiErr(403, 'policy_destination_denied', 'policy');
      const cap = p.limits.per_transaction?.[b.asset];
      if (cap !== undefined && amount > BigInt(cap)) throw new ApiErr(403, 'policy_transaction_limit_exceeded', 'policy');
      if (a.spent_usd + usd > budgetLimit(a)) throw new ApiErr(403, 'spend_budget_exceeded', 'budget');
      if (a.balance < amount) throw new ApiErr(409, 'insufficient_balance', 'balance', { available_amount: a.balance.toString() });
      if (b.chain === 'near' && !hooks.registered(b.recipient)) throw new ApiErr(409, 'invalid_address', 'request');
      a.spent_usd += usd; // charged at admission; a rejected or expired approval gives it back
      const o = op({ correlation_id: cid('op'), agent_id: a.id, type: 'withdraw', status: 'PROCESSING', grant, details: { action: 'withdraw', request: b, near_account_id: a.near } });
      if (p.owner_approval) {
        const approval_id = randomUUID();
        approvals.set(approval_id, { approval_id, status: 'PENDING', op: o.correlation_id, amount, usd, expires_at: new Date(Date.now() + 86_400_000).toISOString(), request_data: { amount: b.amount, asset: b.asset, recipient: b.recipient } });
        Object.assign(o, { status: 'PENDING_APPROVAL', details: { ...o.details, approval_id } });
      } else dispatchWithdraw(a, o, amount);
      return o;
    });
  }

  function nearCall(a: Agent, headers: Record<string, string | undefined>, b: any) {
    const grant = grantOf(a, headers.grant);
    valid(check.nearCall, b);
    return replay(a.id, headers.idem, b, () => {
      const p = a.policy;
      if (['intents.near', 'intents.far'].includes(b.receiver_id)) throw new ApiErr(403, 'native_contract_forbidden', 'policy');
      if (!p.native?.near.call.includes(b.receiver_id)) throw new ApiErr(403, 'native_method_denied', 'policy');
      if (BigInt(b.deposit ?? '0') > 0n) {
        // Native NEAR is wNEAR to the provider, and the deposit must land where destinations allows (policy.md).
        if (p.assets !== 'any' && !p.assets.includes('nep141:wrap.near')) throw new ApiErr(403, 'policy_asset_denied', 'policy');
        const ok = p.destinations.mode === 'any' || p.destinations.list.some((d: any) => d.action === 'withdraw' && d.chain === 'near' && d.address === b.receiver_id);
        if (!ok) throw new ApiErr(403, 'policy_destination_denied', 'policy');
      }
      const o = op({ correlation_id: cid('op'), agent_id: a.id, type: 'native', status: 'PROCESSING', grant, details: { method: 'call', chain: 'near', account_id: a.near, target: b.receiver_id, method_name: b.method_name, tx_hash: null, signature: null } });
      o.next = () => {
        const tx = hooks.onNearCall(a.near, b);
        Object.assign(o, tx ? { status: 'SUCCESS', details: { ...o.details, tx_hash: tx } } : { status: 'FAILED', failure_code: 'native_transaction_failed' });
      };
      return o;
    });
  }

  const busy = new Map<string, number>(); // path suffix -> POSTs still to answer 503 database_busy
  function route(method: string, path: string, q: URLSearchParams, headers: Record<string, string | undefined>, body: any): { status: number; body: unknown } {
    if (headers.key !== hooks.key) throw new ApiErr(401, 'api_key_invalid', 'auth');
    for (const [suffix, n] of busy) {
      if (method === 'POST' && path.endsWith(suffix) && n > 0) { busy.set(suffix, n - 1); throw new ApiErr(503, 'database_busy', 'api', { retryable: true }); }
    }
    if (method === 'GET' && path === '/v1/whoami') return { status: 200, body: { api_key_id: 'k1', tenant_id: 't1' } };
    if (method === 'POST' && path === '/v1/generate-intent') return generate(body);
    if (method === 'POST' && path === '/v1/submit-intent') return submit(body);
    if (method === 'GET' && path === '/v1/status') {
      const o = ops.get(q.get('correlation_id') ?? '');
      if (!o) throw new ApiErr(404, 'operation_not_found', 'request');
      const next = o.next;
      if (next) { delete o.next; next(); }
      return { status: 200, body: view(o) };
    }
    const m = path.match(/^\/v1\/agents\/([0-9a-f]{64})(\/.*)?$/);
    if (!m) throw new ApiErr(404, 'not_found', 'request');
    const a = agentOf(m[1]), rest = m[2] ?? '';
    if (method === 'GET' && rest === '') {
      return { status: 200, body: { id: a.id, name: 'x', external_user_id: a.owner.account_id, status: a.status, archived: false, deleted: false, owner: a.owner, owner_account: null, wallet: { wallet_id: `w-${a.id.slice(0, 8)}`, near_account_id: a.near, evm_account_id: null, solana_account_id: null }, created_at: now(), cooldowns: { policy_change_available_at: null, unfreeze_available_at: null } } };
    }
    if (method === 'GET' && rest === '/wallet') return { status: 200, body: { wallet_id: `w-${a.id.slice(0, 8)}`, near_account_id: a.near, evm_account_id: null, solana_account_id: null } };
    if (method === 'GET' && rest === '/balances') {
      const e = { asset_id: USDC, symbol: 'USDC', decimals: 6, blockchain: 'near', price: 1, price_updated_at: null, price_expires_at: null, balance_raw: a.balance.toString(), balance: null, available_raw: a.balance.toString(), available: null };
      return { status: 200, body: { near_account_id: a.near, source: q.get('source') ?? 'public', balances: !q.get('asset') || q.get('asset') === USDC ? [e] : [] } };
    }
    if (method === 'GET' && rest === '/policy') {
      return { status: 200, body: { wallet_id: `w-${a.id.slice(0, 8)}`, revision: a.revision, policy_hash: hex(32), status: 'APPLIED', applied_at: now(), transaction_hash: null, provider_policy_synced: true, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, policy: a.policy, usage: { budget: { daily: window(a, 'daily_usd'), weekly: window(a, 'weekly_usd'), monthly: window(a, 'monthly_usd') }, timelock: { delay_ms: 0, scheduled_count: 0 } } } };
    }
    if (method === 'GET' && rest === '/grants') return { status: 200, body: { data: [...a.grants].map(([grant_id, g]) => ({ grant_id, agent_id: a.id, label: g.label, issued_at: g.issued_at, expires_at: g.expires_at, revoked_at: null })) } };
    if (method === 'GET' && rest === '/approvals') {
      const mine = [...approvals.values()].filter((x) => ops.get(x.op)?.agent_id === a.id && x.status === 'PENDING');
      return { status: 200, body: { data: mine.map((x) => ({ approval_id: x.approval_id, wallet_id: `w-${a.id.slice(0, 8)}`, wallet_pubkey: 'ed25519:x', request_hash: 'h', status: x.status, request_type: 'withdraw', request_data: x.request_data, required_approvals: 1, expires_at: x.expires_at })) } };
    }
    if (method === 'POST' && rest === '/withdraw') return { status: 202, body: view(withdraw(a, headers, body)) };
    if (method === 'POST' && rest === '/native/near/call') return { status: 202, body: view(nearCall(a, headers, body)) };
    throw new ApiErr(404, 'not_found', 'request');
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8').on('data', (d) => (raw += d)).on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const h = (k: string) => (typeof req.headers[k] === 'string' ? (req.headers[k] as string) : undefined);
      const headers = { key: h('x-api-key'), grant: h('x-grant-token'), idem: h('idempotency-key') };
      let body: any;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      requests.push({ method: req.method!, path: u.pathname, grant: headers.grant, idem: headers.idem, key: headers.key === hooks.key, body });
      let out: { status: number; body: unknown };
      try { out = route(req.method!, u.pathname, u.searchParams, headers, body); } catch (e) {
        if (!(e instanceof ApiErr)) throw e;
        out = { status: e.status, body: { errors: [{ status: String(e.status), code: e.code, layer: e.layer, title: e.code.replace(/_/g, ' '), meta: { retryable: false, ...e.meta } }], meta: { request_id: 'req-1' } } };
      }
      res.writeHead(out.status, { 'content-type': 'application/json', 'x-request-id': 'req-1' }).end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((ok) => server.listen(hooks.port ?? 0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
    agents, approvals, requests, intents,
    /** The next `n` POSTs to a path ending in `suffix` answer 503 database_busy (retryable), taking no effect. */
    busy(suffix: string, n: number) { busy.set(suffix, n); },
    /** USDC that reached the wallet's NEAR Intents balance (a deposit). */
    deposit(agentId: string, amount: bigint) { agents.get(agentId)!.balance += amount; },
    /** The approval's deadline passed: it settles FAILED (expired), and its budget charge is released. */
    expire(approvalId: string) {
      const ap = approvals.get(approvalId)!, o = ops.get(ap.op)!;
      ap.status = 'EXPIRED';
      agents.get(o.agent_id!)!.spent_usd -= ap.usd;
      Object.assign(o, { status: 'FAILED', failure_code: 'expired', details: { ...o.details, never_executed: true } });
    },
    validPolicy: (p: unknown) => check.policy(p) || (check.policy as any).errors,
  };
}
