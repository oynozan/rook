import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

// Never touch NEAR AI or the real market; tiny timings. Set before importing services.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';
process.env.ROOK_POLL_MS = '20';
process.env.ROOK_PAYMENT_GRACE_S = '1';

const { serve, call, HttpError } = await import('../src/shared/http.ts');
const { start } = await import('../src/orchestrator/index.ts');
type Running = Awaited<ReturnType<typeof start>>;

const X402 = { network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim' };
const row = (amount: string) => ({ scheme: 'exact', ...X402, amount, maxTimeoutSeconds: 60 });
const cand = (handle: string, price: string, sla = 5) => ({
  handle, name: handle, description: handle, sla_seconds: sla, success_rate: null, delivered_jobs: 0, price_atomic: price, quote: row(price),
});
// profile: what GetTask returns once the agent "finishes"
// quoted: price at hire time if it differs; polls: GetTask calls before the final state; sendDelay: ms /send holds;
// unknown: /send reports outcome_unknown; noCancel: CancelTask refused.
type Profile = { price: string; state: string; text?: string; quoted?: string; polls?: number; sendDelay?: number; unknown?: boolean; noCancel?: boolean };
const PROFILES: Record<string, Profile> = {
  'holders-bad': { price: '150000', state: 'COMPLETED', text: 'Top 10 holders share: 291.2%' },
  'holders-good': { price: '300000', state: 'COMPLETED', text: 'Total supply: 1,250,000,000 NEAR' },
  'check-fails': { price: '100000', state: 'FAILED' },
  'check-good': { price: '200000', state: 'COMPLETED', text: 'Owner can mint: no. Total supply: 1,250,000,000 NEAR' },
  hang: { price: '100000', state: 'WORKING' },
  pricey: { price: '100000', quoted: '300000', state: 'COMPLETED', text: 'never hired' },
  'eval-down': { price: '100000', state: 'COMPLETED', text: 'EVAL-DOWN report' },
  'slow-send': { price: '100000', state: 'WORKING', sendDelay: 400 },
  unknown: { price: '100000', state: 'COMPLETED', unknown: true },
  late: { price: '100000', state: 'COMPLETED', text: 'Late but complete', polls: 40, noCancel: true },
};
let planGate: Promise<void> = Promise.resolve();

let plan: any;
const sent: { handle: string; payment: string }[] = [];
const cancelled: string[] = [];
const a2a = new Map<string, { handle: string; polls: number }>();
const evalRequests: any[] = [];
const planRequests: any[] = [];
const servers: Running[] = [];
let orch: Running;

before(async () => {
  const planner = await serve('fake-planner', {
    'POST /plan': async ({ body }) => { planRequests.push(body); await planGate; return plan; },
    'POST /aggregate': ({ body }) => {
      if (body.prompt.includes('AGG-DOWN')) throw new HttpError(502, 'planner LLM failed: cost guard', { llm_calls: [{ cost_usd: 0.01, signature_verified: true }] });
      return {
      final_markdown: body.subtasks.map((s: any) => `## ${s.title} (${s.agent_handle})\n${s.deliverable_text}`).join('\n'),
      attribution: body.subtasks.map((s: any) => ({ subtask_id: s.id, agent_handle: s.agent_handle })),
      llm_calls: [],
    }; },
  }, 0);
  const evaluator = await serve('fake-evaluator', {
    'POST /evaluate': ({ body }) => {
      evalRequests.push(body);
      if (body.deliverable.text.includes('EVAL-DOWN')) throw new HttpError(502, 'evaluator LLM failed', { llm_calls: [{ cost_usd: 0.002, signature_verified: true }] });
      const bad = /291\.2%/.test(body.deliverable.text);
      return {
        verdict: bad ? 'fail' : 'pass', results: [], failed_criteria: bad ? ['c1'] : [], security_flags: [], extracted: {},
        llm_calls: [{ cost_usd: 0.001, signature_verified: true }], engine: 'local', attestation_hash: `att-${body.subtask_id}-${evalRequests.length}`,
      };
    },
  }, 0);
  const gateway = await serve('fake-gateway', {
    'GET /x402': () => ({ x402Version: 2, recipients: [X402] }),
    'POST /quote': ({ body }) => ({ ok: true, row: row(PROFILES[body.handle].quoted ?? PROFILES[body.handle].price) }),
    'POST /send': async ({ body }) => {
      const p = PROFILES[body.handle];
      const h = JSON.parse(Buffer.from(body.payment, 'base64').toString());
      if (h.accepted.amount !== p.price) return { ok: false, error: { code: 402, message: 'bad payment' } };
      sent.push({ handle: body.handle, payment: body.payment });
      if (p.sendDelay) await new Promise((ok) => setTimeout(ok, p.sendDelay));
      if (p.unknown) return { ok: false, error: { code: 'outcome_unknown', message: 'after a 502 the agent answered HTTP 402' } };
      const id = `a2a-${a2a.size + 1}`;
      a2a.set(id, { handle: body.handle, polls: 0 });
      return { ok: true, task: { id, context_id: 'ctx', state: 'SUBMITTED', artifacts: [] } };
    },
    'GET /task': ({ query }) => {
      const t = a2a.get(query.get('id')!)!;
      const p = PROFILES[t.handle];
      const done = ++t.polls >= (p.polls ?? 2);
      return { ok: true, task: {
        id: query.get('id'), context_id: 'ctx', state: done ? p.state : 'WORKING',
        artifacts: done && p.text ? [{ parts: [{ text: p.text }] }] : [],
      } };
    },
    'POST /cancel': ({ body }) => {
      if (PROFILES[a2a.get(body.id)!.handle].noCancel) return { ok: false, error: { code: -32002, message: 'Task cannot be canceled in state WORKING' } };
      cancelled.push(body.id); return { ok: true };
    },
  }, 0);
  servers.push(planner, evaluator, gateway);
  process.env.PLANNER_URL = planner.url;
  process.env.EVALUATOR_URL = evaluator.url;
  process.env.MARKET_GATEWAY_URL = gateway.url;
  orch = await start(0);
});

after(async () => {
  await orch.close();
  for (const s of servers) await s.close();
});

const sub = (id: string, title: string, cap: string, candidates: any[], criteria: any[] = []) => ({
  id, title, brief: `${title}\nPlease report.`, search_terms: [title], cap_atomic: cap, deadline_s: 5, self_do: false, candidates,
  criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: '.' } }, ...criteria],
});
const budget = (allocated: string) => ({ budget_atomic: '1000000', reserve_atomic: '200000', allocatable_atomic: '800000', allocated_atomic: allocated });

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((ok) => setTimeout(ok, 25));
  }
}
const snap = (id: string) => call(`${orch.url}/tasks/${id}`);

test('re-hire after a failed verdict with a top-up, skip a FAILED agent, close with refunds', async () => {
  plan = {
    subtasks: [
      sub('s1', 'Holders', '300000', [cand('holders-bad', '150000'), cand('holders-good', '300000')]),
      sub('s2', 'Contract', '200000', [cand('check-fails', '100000'), cand('check-good', '200000')], [
        { id: 'c2', kind: 'cross_check', description: 'x', spec: { label: 'Total supply', other_subtask: 's1', other_label: 'Total supply', tolerance_pct: 1 } },
      ]),
    ],
    dropped: [], budget: budget('500000'), notes: [], llm_calls: [],
  };
  const created = await call(`${orch.url}/tasks`, { prompt: 'Due diligence on the NEAR token', budget_usdc: '1' });
  assert.equal(created.status, 'planned');
  const approved = await call(`${orch.url}/tasks/${created.id}/approve`, {});
  assert.equal(approved.status, 'approved');

  const s = await until(async () => { const x = await snap(created.id); return x.task.status === 'closed' || x.task.status === 'failed' ? x : false; });
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.subtasks.map((x: any) => [x.status, x.final_outcome, x.accepted?.agent_handle]),
    [['returned', 'passed', 'holders-good'], ['returned', 'passed', 'check-good']]);

  // Receipts only for COMPLETED hires: holders-bad (fail), holders-good (pass), check-good (pass).
  assert.deepEqual(s.receipts.map((r: any) => `${r.agent_handle}:${r.verdict}`).sort(),
    ['check-good:pass', 'holders-bad:fail', 'holders-good:pass']);
  assert.equal(s.subtasks[0].rehire_count, 1);
  assert.equal(s.subtasks[1].rehire_count, 0);
  assert.ok(s.receipts.every((r: any) => /^[0-9a-f]{64}$/.test(r.payment_hash) && r.payment_tx === null));
  // Same receipt shape as chain mode, with no transactions and no explorer links in simulation.
  assert.ok(s.receipts.every((r: any) => /^a2a-/.test(r.a2a_task_id) && r.attestation_hash && r.receipt_tx === null
    && r.payment_explorer_url === null && r.receipt_explorer_url === null));

  const receiptSum = s.receipts.reduce((x: bigint, r: any) => x + BigInt(r.amount_atomic), 0n);
  const L = s.ledger;
  assert.equal(BigInt(L.spent_atomic), receiptSum);
  assert.equal(receiptSum, 650_000n);
  assert.equal(L.reserve_used_atomic, '150000');
  assert.equal(L.refunded_atomic, '350000');
  assert.ok(L.invariant_holds && L.closed);
  assert.equal(BigInt(L.budget_atomic), BigInt(L.unallocated_atomic) + BigInt(L.reserve_remaining_atomic) + BigInt(L.spent_atomic) + BigInt(L.refunded_atomic)
    + L.subtasks.reduce((x: bigint, v: any) => x + BigInt(v.balance_atomic), 0n));

  // Cross-check peers: s2 was evaluated with s1's accepted deliverable.
  const s2eval = evalRequests.filter((r) => r.subtask_id === 's2').at(-1);
  assert.deepEqual(s2eval.peers, [{ subtask_id: 's1', text: 'Total supply: 1,250,000,000 NEAR' }]);
  assert.match(s.final_result.final_markdown, /holders-good/);
  assert.equal(s.llm_cost.calls, 3);

  // Events: SSE replay of the whole history, ends with closed; the payment header never appears.
  const r = await fetch(`${orch.url}/tasks/${created.id}/events`);
  const body = await r.text();
  const events = body.trim().split('\n\n').map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6)));
  const types = events.map((e) => e.type);
  assert.deepEqual(events.at(-1).data, { from: 'closing', to: 'closed' });
  assert.ok(events.some((e) => e.type === 'ledger' && e.data.op === 'topUp' && e.subtask_id === 's1' && e.data.amount_atomic === '150000'));
  assert.ok(!events.some((e) => e.type === 'ledger' && e.data.op === 'topUp' && e.subtask_id === 's2'));
  assert.ok(events.some((e) => e.type === 'a2a_state' && e.data.agent_handle === 'check-fails' && e.data.state === 'FAILED'));
  for (const t of ['plan', 'quote', 'hire_sent', 'evaluation', 'receipt', 'final', 'subtask_status']) assert.ok(types.includes(t), t);
  for (const p of sent) assert.ok(!body.includes(p.payment));
  assert.ok(!JSON.stringify(s).includes(sent[0].payment));

  const tail = await (await fetch(`${orch.url}/tasks/${created.id}/events`, { headers: { 'last-event-id': String(events.length - 1) } })).text();
  assert.equal(tail.trim().split('\n\n').length, 1);
});

test('kill releases the authorization, cancels the A2A task and stops hiring', async () => {
  plan = { subtasks: [sub('s1', 'Hang', '200000', [cand('hang', '100000', 60), cand('holders-good', '300000')])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] };
  const created = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' });
  await call(`${orch.url}/tasks/${created.id}/approve`, {});
  await until(async () => (await snap(created.id)).subtasks[0].status === 'working');

  const killed = await call(`${orch.url}/tasks/${created.id}/kill`, {});
  assert.equal(killed.status, 'killed');
  await new Promise((ok) => setTimeout(ok, 200));
  const s = await snap(created.id);
  assert.equal(s.task.status, 'killed');
  assert.equal(s.ledger.killed, true);
  assert.equal(s.ledger.subtasks[0].authorized_atomic, null);
  assert.equal(s.ledger.spent_atomic, '0');
  assert.ok(s.ledger.invariant_holds);
  assert.ok(cancelled.includes(s.subtasks[0].hires[0].a2a_task_id));
  assert.equal(s.receipts.length, 0);
  const evs = (await fetch(`${orch.url}/tasks/${created.id}/events`).then((r) => r.text())).split('\n\n').filter(Boolean);
  const killAt = evs.findIndex((e) => e.includes('"op":"kill"'));
  assert.ok(killAt > 0 && !evs.slice(killAt).some((e) => e.includes('event: hire_sent')));
  assert.match(evs.at(-1)!, /"to":"killed"/);
  await assert.rejects(call(`${orch.url}/tasks/${created.id}/kill`, {}), /already killed/);
});

test('a hire past sla_seconds + grace times out, is cancelled and released, then the next candidate is hired', async () => {
  plan = { subtasks: [sub('s1', 'Slow', '300000', [cand('hang', '100000', 0), cand('holders-good', '300000')])], dropped: [], budget: budget('300000'), notes: [], llm_calls: [] };
  const created = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' });
  await call(`${orch.url}/tasks/${created.id}/approve`, {});
  const s = await until(async () => { const x = await snap(created.id); return ['closed', 'failed'].includes(x.task.status) ? x : false; });
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.subtasks[0].hires.map((h: any) => [h.agent_handle, h.state, h.paid]), [['hang', 'TIMEOUT', false], ['holders-good', 'COMPLETED', true]]);
  assert.ok(cancelled.includes(s.subtasks[0].hires[0].a2a_task_id));
  assert.deepEqual(s.receipts.map((r: any) => r.agent_handle), ['holders-good']);
  assert.equal(s.ledger.spent_atomic, '300000');
  assert.equal(s.ledger.reserve_used_atomic, '0');
});

const runToEnd = async (p: any, prompt = 'p') => {
  plan = p;
  const created = await call(`${orch.url}/tasks`, { prompt, budget_usdc: '1' });
  await call(`${orch.url}/tasks/${created.id}/approve`, {});
  return until(async () => { const x = await snap(created.id); return ['closed', 'failed', 'killed'].includes(x.task.status) ? x : false; });
};
const spentMatchesReceipts = (s: any) =>
  assert.equal(BigInt(s.ledger.spent_atomic), s.receipts.reduce((x: bigint, r: any) => x + BigInt(r.amount_atomic), 0n));

test('a task killed while planning stays killed when the planner answers', async () => {
  let open!: () => void;
  planGate = new Promise((ok) => (open = ok));
  plan = { subtasks: [sub('s1', 'Holders', '300000', [cand('holders-good', '300000')])], dropped: [], budget: budget('300000'), notes: [], llm_calls: [] };
  const creating = call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' });
  const draft = await until(async () => (await call(`${orch.url}/tasks`)).tasks.find((x: any) => x.status === 'draft'));
  assert.equal((await call(`${orch.url}/tasks/${draft.id}/kill`, {})).status, 'killed');
  open();
  assert.equal((await creating).status, 'killed');
  planGate = Promise.resolve();
  assert.equal((await snap(draft.id)).task.status, 'killed');
  await assert.rejects(call(`${orch.url}/tasks/${draft.id}/approve`, {}), /killed/);
});

test('raised price is skipped; evaluator outage gives an unjudged receipt and abandons only that subtask; aggregate outage falls back', async () => {
  const s = await runToEnd({
    subtasks: [
      sub('s1', 'Down', '200000', [cand('pricey', '100000'), cand('eval-down', '100000'), cand('holders-good', '300000')]),
      sub('s2', 'Holders', '300000', [cand('holders-good', '300000')]),
    ],
    dropped: [], budget: budget('500000'), notes: [], llm_calls: [],
  }, 'AGG-DOWN report');
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.subtasks.map((x: any) => x.final_outcome), ['abandoned', 'passed']);
  assert.deepEqual(s.subtasks[0].hires.map((h: any) => h.agent_handle), ['eval-down']); // pricey never authorized, no re-hire after the outage
  assert.equal(s.subtasks[0].rehire_count, 0);
  assert.deepEqual(s.receipts.map((r: any) => [r.agent_handle, r.verdict, r.attestation_hash === null]).sort(),
    [['eval-down', null, true], ['holders-good', 'pass', false]]);
  spentMatchesReceipts(s);
  assert.match(s.final_result.final_markdown, /holders-good/);
  assert.match(s.final_result.final_markdown, /Gaps/);
  assert.deepEqual(s.final_result.attribution, [{ subtask_id: 's2', agent_handle: 'holders-good' }]);
  assert.ok(s.llm_cost.calls >= 4); // 3 failed evaluator attempts + the failed aggregate are paid calls too
});

test('kill while /send is in flight: the task is cancelled once its id is known, then the authorization is released', async () => {
  plan = { subtasks: [sub('s1', 'Send', '200000', [cand('slow-send', '100000', 60)])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] };
  const created = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' });
  await call(`${orch.url}/tasks/${created.id}/approve`, {});
  await until(async () => (await snap(created.id)).subtasks[0].hires.length > 0);
  await call(`${orch.url}/tasks/${created.id}/kill`, {});
  assert.equal((await snap(created.id)).ledger.subtasks[0].authorized_atomic, '100000'); // still out: the header was sent
  const s = await until(async () => { const x = await snap(created.id); return x.subtasks[0].hires[0].state === 'KILLED' ? x : false; });
  await until(async () => cancelled.includes(s.subtasks[0].hires[0].a2a_task_id));
  assert.equal((await snap(created.id)).ledger.subtasks[0].authorized_atomic, null);
  assert.equal(s.ledger.spent_atomic, '0');
});

test('an unknown send outcome is counted as spent with a receipt, then the next candidate is hired', async () => {
  const s = await runToEnd({ subtasks: [sub('s1', 'Unknown', '300000', [cand('unknown', '100000'), cand('holders-good', '300000')])], dropped: [], budget: budget('300000'), notes: [], llm_calls: [] });
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.receipts.map((r: any) => [r.agent_handle, r.verdict]), [['unknown', null], ['holders-good', 'pass']]);
  assert.equal(s.ledger.spent_atomic, '400000');
  spentMatchesReceipts(s);
});

test('timeout with CancelTask refused waits until the authorization expires and pays a late completion', async () => {
  const late = { ...cand('late', '100000', 0), quote: { ...row('100000'), maxTimeoutSeconds: 5 } };
  const s = await runToEnd({ subtasks: [sub('s1', 'Late', '300000', [late, cand('holders-good', '300000')])], dropped: [], budget: budget('300000'), notes: [], llm_calls: [] });
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.subtasks[0].hires.map((h: any) => [h.agent_handle, h.state, h.paid]), [['late', 'COMPLETED', true]]);
  assert.deepEqual(s.receipts.map((r: any) => [r.agent_handle, r.verdict]), [['late', 'pass']]);
  spentMatchesReceipts(s);
});

test("hires in the plan's candidate order, not by price; the next /plan carries Rook's verdicts per agent", async () => {
  // Ranked by expected cost, the pricier agent can come first: the runner must not re-sort by price.
  const s = await runToEnd({ subtasks: [sub('s1', 'Ranked', '300000', [cand('holders-good', '300000'), cand('holders-bad', '150000')])], dropped: [], budget: budget('300000'), notes: [], llm_calls: [] });
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.subtasks[0].hires.map((h: any) => h.agent_handle), ['holders-good']);
  assert.equal(s.ledger.reserve_used_atomic, '0');

  plan = { subtasks: [], dropped: [], budget: budget('0'), notes: [], llm_calls: [] };
  const next = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' });
  const body = planRequests.at(-1);
  const { PlanRequest } = await import('../src/shared/types.ts');
  assert.ok(PlanRequest.safeParse(body).success);
  assert.ok(body.history['holders-good'].pass >= 1);
  assert.ok(Object.values(body.history).every((h: any) => h.pass + h.fail > 0)); // judged receipts only
  await call(`${orch.url}/tasks/${next.id}/cancel`, {});
});
