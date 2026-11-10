import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

// Never touch NEAR AI or the real market; tiny timings. Set before importing services.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';
process.env.ROOK_POLL_MS = '20';
process.env.ROOK_PAYMENT_GRACE_S = '1';
process.env.ROOK_UNREACHABLE_RETRY_S = '0.2';

const { serve, call, HttpError } = await import('../src/shared/http.ts');
const { start } = await import('../src/orchestrator/index.ts');
const { attach } = await import('../src/planner/canned.ts');
type Running = Awaited<ReturnType<typeof start>>;

const X402 = { network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim' };
const row = (amount: string) => ({ scheme: 'exact', ...X402, amount, maxTimeoutSeconds: 60 });
const cand = (handle: string, price: string, sla = 5) => ({
  handle, name: handle, description: handle, sla_seconds: sla, success_rate: null, delivered_jobs: 0, price_atomic: price, quote: row(price),
});
// profile: what GetTask returns once the agent "finishes"
// quoted: price at hire time if it differs; polls: GetTask calls before the final state; sendDelay: ms /send holds;
// unknown: /send reports outcome_unknown; noCancel: CancelTask refused; down: that many paid sends get -32603 first.
type Profile = { price: string; state: string; text?: string; quoted?: string; polls?: number; sendDelay?: number; unknown?: boolean; noCancel?: boolean; down?: number };
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
  'down-once': { price: '100000', state: 'COMPLETED', text: 'Total supply: 1,250,000,000 NEAR', down: 1 },
  'down-always': { price: '100000', state: 'COMPLETED', text: 'never delivered', down: 99 },
  'site-good': { price: '100000', state: 'COMPLETED', text: 'Here is the site.\n\nindex.html\n```html\n<!doctype html>\n<html><body>Ozan</body></html>\n```' },
};
const downs = new Map<string, number>();
let planGate: Promise<void> = Promise.resolve();
let planDown = false; // the planner's model is out of reach, as when NEAR AI answered 500

let plan: any;
const sent: { handle: string; payment: string }[] = [];
const cancelled: string[] = [];
const a2a = new Map<string, { handle: string; polls: number }>();
const evalRequests: any[] = [];
const planRequests: any[] = [];
const aggRequests: any[] = [];
const servers: Running[] = [];
let orch: Running;

before(async () => {
  const planner = await serve('fake-planner', {
    'POST /plan': async ({ body }) => {
      planRequests.push(body);
      await planGate;
      if (planDown) throw new HttpError(502, 'planner LLM failed: NEAR AI 500');
      if (body.prompt === 'go ahead') throw new HttpError(422, 'That reads like a go-ahead.');
      return plan;
    },
    'POST /self-do': () => ({ text: 'Rook wrote this part.', llm_calls: [] }),
    'POST /aggregate': ({ body }) => {
      aggRequests.push(body);
      if (body.prompt.includes('AGG-DOWN')) throw new HttpError(502, 'planner LLM failed: cost guard', { llm_calls: [{ cost_usd: 0.01, signature_verified: true }] });
      return {
      final_markdown: body.subtasks.map((s: any) => `## ${s.title} (${s.agent_handle})\n${s.deliverable_text}`).join('\n'),
      attribution: body.subtasks.map((s: any) => ({ subtask_id: s.id, agent_handle: s.agent_handle })),
      files: attach(body.subtasks).files, // as the planner does
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
      if ((downs.get(body.handle) ?? 0) < (p.down ?? 0)) {
        downs.set(body.handle, (downs.get(body.handle) ?? 0) + 1);
        return { ok: false, error: { code: -32603, message: 'internal error' } };
      }
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

test('an open event stream answers at once, even with nothing new to send', async () => {
  plan = holdersPlan();
  const created = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' }); // planned: the stream stays open
  const stop = new AbortController();
  const at = Date.now();
  const r = await fetch(`${orch.url}/tasks/${created.id}/events`, { signal: stop.signal, headers: { 'last-event-id': '9999' } });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - at < 2000, 'headers came only with the first write'); // the web proxy's fetch gave up at 5 min
  stop.abort();
  await call(`${orch.url}/tasks/${created.id}/cancel`, {}).catch(() => {});
});

test('kill releases the authorization, cancels the A2A task and stops hiring', async () => {
  plan = { subtasks: [sub('s1', 'Hang', '200000', [cand('hang', '100000', 60), cand('holders-good', '300000')])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] };
  const created = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' });
  await call(`${orch.url}/tasks/${created.id}/approve`, {});
  await until(async () => (await snap(created.id)).subtasks[0].status === 'working');

  const killed = await call(`${orch.url}/tasks/${created.id}/kill`, {});
  assert.equal(killed.status, 'killed');
  const s = await until(async () => { const x = await snap(created.id); return x.ledger.closed ? x : false; });
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
  // After the killed status only the unwind: the sim books close too, so the refund shows.
  const killedAt = evs.findIndex((e) => /"to":"killed"/.test(e));
  assert.deepEqual(evs.slice(killedAt + 1).map((e) => e.match(/"op":"(\w+)"|"to":"(\w+)"/)!.slice(1).join('')), ['returnLeftover', 'returned', 'closeTask']);
  assert.match(evs.at(-1)!, /"op":"closeTask"/);
  assert.ok(!evs[killAt].includes('near contract')); // no CLI command in the stream
  assert.deepEqual([s.ledger.closed, s.ledger.refunded_atomic], [true, '1000000']);
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

test('an advertised 1-day SLA does not hold the run: past ROOK_HIRE_PATIENCE_S Rook cancels the hire and hires the next', async () => {
  process.env.ROOK_HIRE_PATIENCE_S = '1';
  try {
    plan = { subtasks: [sub('s1', 'Slow', '300000', [cand('hang', '100000', 86_400), cand('holders-good', '300000')])], dropped: [], budget: budget('300000'), notes: [], llm_calls: [] };
    const created = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' });
    await call(`${orch.url}/tasks/${created.id}/approve`, {});
    const s = await until(async () => { const x = await snap(created.id); return ['closed', 'failed'].includes(x.task.status) ? x : false; });
    assert.equal(s.task.status, 'closed', s.task.error);
    assert.deepEqual(s.subtasks[0].hires.map((h: any) => [h.agent_handle, h.state]), [['hang', 'TIMEOUT'], ['holders-good', 'COMPLETED']]);
    assert.ok(cancelled.includes(s.subtasks[0].hires[0].a2a_task_id));
  } finally { delete process.env.ROOK_HIRE_PATIENCE_S; }
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

test('timeout with CancelTask refused: Rook stops waiting at once and hires the next candidate, the late agent unpaid', async () => {
  const late = { ...cand('late', '100000', 0), quote: { ...row('100000'), maxTimeoutSeconds: 3600 } };
  const s = await runToEnd({ subtasks: [sub('s1', 'Late', '300000', [late, cand('holders-good', '300000')])], dropped: [], budget: budget('300000'), notes: [], llm_calls: [] });
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.subtasks[0].hires.map((h: any) => [h.agent_handle, h.state, h.paid]), [['late', 'TIMEOUT', false], ['holders-good', 'COMPLETED', true]]);
  assert.deepEqual(s.receipts.map((r: any) => [r.agent_handle, r.verdict]), [['holders-good', 'pass']]);
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
  // Judged receipts, and hires that never reached work: 'late' timed out in an earlier test and has delivered nothing since.
  assert.ok(Object.values(body.history).every((h: any) => h.pass + h.fail + (h.stalled ?? 0) > 0));
  assert.deepEqual(body.history.late, { pass: 0, fail: 0, stalled: 1 });
  await until(async () => (await snap(next.id)).task.status === 'failed'); // its plan is empty
});

test('a plan with every part dropped ends the task as failed, with the reason in plain words and the plan kept', async () => {
  const cases: [string[], RegExp][] = [
    [['no fitting agent', 'no fitting agent'], /^No agent on the market can do any part of this task\.$/],
    [['over budget'], /^Every part costs more than this budget allows; try a larger budget\.$/],
    [['no fitting agent', 'over budget'], /^No agent on the market can do some parts of this task, and the others cost more than this budget allows\.$/],
  ];
  for (const [reasons, want] of cases) {
    plan = { subtasks: [], dropped: reasons.map((reason, i) => ({ title: `Part ${i + 1}`, reason })), budget: budget('0'), notes: [], llm_calls: [] };
    const created = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' });
    assert.equal(created.status, 'failed');
    assert.match(created.error, want);
    assert.deepEqual(created.plan.dropped.map((d: any) => d.reason), reasons);
    await assert.rejects(call(`${orch.url}/tasks/${created.id}/approve`, {}), /approve needs planned/);
  }
});

test("a delivered web page reaches the snapshot's final_result as a file, also through the deterministic merge; the final event leaves it out", async () => {
  const page = '<!doctype html>\n<html><body>Ozan</body></html>';
  for (const prompt of ['make me a portfolio website like oynozan.com', 'AGG-DOWN portfolio']) {
    const s = await runToEnd({ subtasks: [sub('s1', 'Build one-page portfolio website', '200000', [cand('site-good', '100000')])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] }, prompt);
    assert.equal(s.task.status, 'closed', s.task.error);
    assert.deepEqual(s.final_result.files, [{ subtask_id: 's1', agent_handle: 'site-good', name: 'index.html', mime: 'text/html', text: page }], prompt);
    const evs = (await fetch(`${orch.url}/tasks/${s.task.id}/events`).then((r) => r.text())).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const final = evs.find((e) => e.type === 'final').data;
    assert.deepEqual([typeof final.final_markdown, 'files' in final], ['string', false]); // the snapshot carries them
    if (prompt.startsWith('AGG-DOWN')) {
      assert.match(s.final_result.final_markdown, /index\.html\n\[file index\.html, 2 lines, attached below the report\]/);
      assert.doesNotMatch(s.final_result.final_markdown, /<!doctype/);
    }
  }
  // A plan with nothing delivered still has a list.
  const none = await runToEnd({ subtasks: [sub('s1', 'Down', '200000', [cand('check-fails', '100000')])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] });
  assert.deepEqual(none.final_result.files, []);
});

test("a self_do subtask is 'working' while Rook writes it, and its text is in the snapshot (it has no hire)", async () => {
  const s = await runToEnd({ subtasks: [{ ...sub('s1', 'Summary', '0', []), self_do: true }], dropped: [], budget: budget('0'), notes: [], llm_calls: [] });
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.subtasks[0].accepted, { hire_id: null, agent_handle: 'rook:self-do', text: 'Rook wrote this part.' });
  const evs = (await fetch(`${orch.url}/tasks/${s.task.id}/events`).then((r) => r.text())).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(evs.filter((e) => e.type === 'subtask_status').map((e) => e.data.to), ['working', 'evaluating', 'passed', 'returned']);
  assert.deepEqual([s.ledger.budget_atomic, s.ledger.closed], ['0', true]); // a plan that hires no agent holds nothing
});

test('no hired agent delivers: a part Rook may write is written by Rook and its cap goes back; one it may not is left out', async () => {
  const s = await runToEnd({
    subtasks: [{ ...sub('s1', 'Copy', '200000', [cand('pricey', '100000')]), self_do_ok: true }, sub('s2', 'Live data', '200000', [cand('pricey', '100000')])],
    dropped: [], budget: budget('400000'), notes: [], llm_calls: [],
  });
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.subtasks.map((x: any) => x.final_outcome), ['passed', 'abandoned']);
  assert.deepEqual(s.subtasks[0].accepted, { hire_id: null, agent_handle: 'rook:self-do', text: 'Rook wrote this part.' });
  assert.deepEqual([s.ledger.spent_atomic, s.ledger.closed], ['0', true]); // both caps went back
  const evs = (await fetch(`${orch.url}/tasks/${s.task.id}/events`).then((r) => r.text())).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(evs.filter((e) => e.type === 'error' && e.data.kind === 'rook_writes').map((e) => e.subtask_id), ['s1']);
});

test('an agent with no reachable backend (-32603) is asked again once, after the other candidates: once is enough, twice is not', async () => {
  const s = await runToEnd({
    subtasks: [sub('s1', 'Retry', '100000', [cand('down-once', '100000'), cand('check-fails', '100000')]), sub('s2', 'Still down', '100000', [cand('down-always', '100000')])],
    dropped: [], budget: budget('200000'), notes: [], llm_calls: [],
  });
  assert.equal(s.task.status, 'closed', s.task.error);
  assert.deepEqual(s.subtasks.map((x: any) => x.final_outcome), ['passed', 'abandoned']);
  assert.deepEqual(s.subtasks[0].hires.map((h: any) => [h.agent_handle, h.state]), [['down-once', 'SEND_FAILED'], ['check-fails', 'FAILED'], ['down-once', 'COMPLETED']]);
  assert.deepEqual(s.subtasks[1].hires.map((h: any) => h.state), ['SEND_FAILED', 'SEND_FAILED']); // asked twice, then left
  spentMatchesReceipts(s);
  const evs = (await fetch(`${orch.url}/tasks/${s.task.id}/events`).then((r) => r.text())).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(evs.filter((e) => e.data?.kind === 'unreachable_retry').map((e) => [e.subtask_id, e.data.agent_handle]).sort(), [['s1', 'down-once'], ['s2', 'down-always']]);
});

// ---- conversations ----

const holdersPlan = () => ({ subtasks: [sub('s1', 'Holders', '300000', [cand('holders-good', '300000')])], dropped: [], budget: budget('300000'), notes: [], llm_calls: [] });
const ended = (id: string) => until(async () => { const x = await snap(id); return ['closed', 'failed', 'killed'].includes(x.task.status) ? x : false; });

test('a follow-up on a finished task gives the planner the earlier messages and the newest report, and the aggregator the earlier messages', async () => {
  const first = await runToEnd(holdersPlan(), 'Due diligence on the NEAR token');
  assert.equal(first.task.status, 'closed', first.task.error);
  assert.equal(first.task.parent_id, null);

  plan = { subtasks: [sub('s1', 'Contract', '200000', [cand('check-good', '200000')])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] };
  const follow = await call(`${orch.url}/tasks`, { prompt: 'Now translate it to Turkish', budget_usdc: '2', parent_id: first.task.id });
  assert.deepEqual([follow.status, follow.parent_id, follow.replaced_by], ['planned', first.task.id, null]);
  assert.equal(planRequests.at(-1).prompt, 'Now translate it to Turkish');
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Due diligence on the NEAR token'], revising: false, report: first.final_result.final_markdown.trim() });
  assert.equal((await snap(first.task.id)).task.status, 'closed'); // a finished task stays as it was
  const rows = (await call(`${orch.url}/tasks`)).tasks;
  assert.deepEqual(rows.find((x: any) => x.id === follow.id),
    { id: follow.id, status: 'planned', prompt: 'Now translate it to Turkish', budget_atomic: '2000000', created_at: follow.created_at, parent_id: first.task.id, has_plan: true,
      supersedes: null, superseded_by: null, edited: false, deleted_at: null });
  assert.equal(rows.find((x: any) => x.id === first.task.id).parent_id, null);

  await call(`${orch.url}/tasks/${follow.id}/approve`, {});
  const second = await ended(follow.id);
  assert.equal(second.task.status, 'closed', second.task.error);
  assert.deepEqual(aggRequests.at(-1).earlier, ['Due diligence on the NEAR token']); // "translate it" means little alone
  assert.equal(aggRequests.at(-1).prompt, 'Now translate it to Turkish');

  // The next message: every earlier message, oldest first, and the newest report (the follow-up's, not the first one's).
  const third = await call(`${orch.url}/tasks`, { prompt: 'Go deeper on part 2', budget_usdc: '1', parent_id: follow.id });
  assert.equal(third.status, 'planned');
  assert.match(second.final_result.final_markdown, /check-good/);
  assert.deepEqual(planRequests.at(-1).conversation,
    { earlier: ['Due diligence on the NEAR token', 'Now translate it to Turkish'], revising: false, report: second.final_result.final_markdown.trim() });
  await call(`${orch.url}/tasks/${third.id}/cancel`, {});
});

test('a follow-up on a delivered site gives the planner the files after the report, which only names them', async () => {
  // The report has a marker where the page was: without the files, "make the header blue" had no page to change.
  const first = await runToEnd({ subtasks: [sub('s1', 'Build one-page portfolio website', '200000', [cand('site-good', '100000')])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] }, 'AGG-DOWN portfolio');
  assert.equal(first.task.status, 'closed', first.task.error);
  assert.doesNotMatch(first.final_result.final_markdown, /<!doctype/);
  plan = holdersPlan();
  const follow = await call(`${orch.url}/tasks`, { prompt: 'make the header blue', budget_usdc: '1', parent_id: first.task.id });
  assert.equal(follow.status, 'planned');
  assert.deepEqual(planRequests.at(-1).conversation, {
    earlier: ['AGG-DOWN portfolio'], revising: false,
    report: `${first.final_result.final_markdown.trim()}\n\nThe files attached to the report, as delivered:\n\nindex.html:\n\`\`\`\n<!doctype html>\n<html><body>Ozan</body></html>\n\`\`\``,
  });
  await call(`${orch.url}/tasks/${follow.id}/cancel`, {});
});

test('a revision replaces the plan it changes once its own plan is ready, and that plan waits for it; a reply that is not a task leaves that plan usable', async () => {
  plan = holdersPlan();
  const first = await call(`${orch.url}/tasks`, { prompt: 'Due diligence on the NEAR token', budget_usdc: '3', owner: 'alice.near' });
  assert.equal(first.status, 'planned');

  // A bare go-ahead is not a task: it fails with the planner's sentence, and the plan above it stays planned.
  const reply = await call(`${orch.url}/tasks`, { prompt: 'go ahead', budget_usdc: '3', owner: 'alice.near', parent_id: first.id });
  assert.deepEqual([reply.status, reply.error], ['failed', 'That reads like a go-ahead.']);
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Due diligence on the NEAR token'], revising: true });
  assert.equal((await snap(first.id)).task.status, 'planned');

  // The next message follows the failed reply, and still revises the plan above it.
  const revised = await call(`${orch.url}/tasks`, { prompt: 'Same task with a budget of 1.50 USDC.', budget_usdc: '1.5', owner: 'alice.near', parent_id: reply.id });
  assert.deepEqual([revised.status, revised.budget_atomic, revised.parent_id], ['planned', '1500000', reply.id]);
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Due diligence on the NEAR token', 'go ahead'], revising: true });
  const old = await call(`${orch.url}/tasks/${first.id}?owner=alice.near`);
  assert.deepEqual([old.task.status, old.task.replaced_by], ['cancelled', revised.id]);
  assert.equal((await snap(reply.id)).task.status, 'failed'); // the reply is left as it was
  const evs = (await fetch(`${orch.url}/tasks/${first.id}/events`).then((r) => r.text())).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(evs.at(-1).data, { from: 'planned', to: 'cancelled' });
  await assert.rejects(call(`${orch.url}/tasks/${first.id}/approve`, { owner: 'alice.near' }), /cancelled/);

  // While a revision is being planned, the plan it changes can't be approved, even through a failed reply: running it
  // would leave two live plans. Once the revision is ready, it replaces that plan.
  const approve = (id: string) => call(`${orch.url}/tasks/${id}/approve`, { owner: 'alice.near' });
  const waits = (e: any) => e.status === 409 && e.message === 'Wait for the revised plan below.';
  let open!: () => void;
  const gate = () => { planGate = new Promise((ok) => (open = ok)); };
  const release = () => { open(); planGate = Promise.resolve(); };
  plan = holdersPlan();
  const base = await call(`${orch.url}/tasks`, { prompt: 'Revise me', budget_usdc: '1', owner: 'alice.near' });
  const nod = await call(`${orch.url}/tasks`, { prompt: 'go ahead', budget_usdc: '1', owner: 'alice.near', parent_id: base.id });
  gate();
  const shorter = await call(`${orch.url}/tasks`, { prompt: 'Make it shorter', budget_usdc: '1', owner: 'alice.near', parent_id: nod.id, wait: false });
  assert.equal(shorter.status, 'draft');
  await assert.rejects(approve(base.id), waits);
  release();
  await until(async () => (await snap(shorter.id)).task.status === 'planned');
  assert.deepEqual([(await snap(base.id)).task.status, (await snap(base.id)).task.replaced_by], ['cancelled', shorter.id]);

  // A revision that fails leaves the plan as it was, and it can run then.
  gate();
  const reply2 = await call(`${orch.url}/tasks`, { prompt: 'go ahead', budget_usdc: '1', owner: 'alice.near', parent_id: shorter.id, wait: false });
  await assert.rejects(approve(shorter.id), waits);
  release();
  await until(async () => (await snap(reply2.id)).task.status === 'failed');
  assert.equal((await approve(shorter.id)).status, 'approved');
  const ran = await ended(shorter.id);
  assert.deepEqual([ran.task.status, ran.task.replaced_by], ['closed', null]);
});

test('a failed reply under a plan never hides it: once that plan runs, a message waits for the run, then follows up on it', async () => {
  const send = (prompt: string, parent_id: string) => call(`${orch.url}/tasks`, { prompt, budget_usdc: '1', owner: 'dan.near', parent_id });
  const refused = (e: any) => e.status === 409 && e.message === 'Wait for this run to finish, or stop it, before sending more.';

  // [running, failed reply]: "go ahead" fails as not a task, then the plan above runs from its button.
  plan = { subtasks: [sub('s1', 'Hang', '200000', [cand('hang', '100000', 60)])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] };
  const hang = await call(`${orch.url}/tasks`, { prompt: 'Holders', budget_usdc: '1', owner: 'dan.near' });
  const reply = await send('go ahead', hang.id);
  assert.equal(reply.status, 'failed');
  await call(`${orch.url}/tasks/${hang.id}/approve`, { owner: 'dan.near' });
  await until(async () => (await snap(hang.id)).task.status === 'running');
  const asked = planRequests.length;
  await assert.rejects(send('More', reply.id), refused);
  assert.equal(planRequests.length, asked); // never planned as if the run had ended, so no second run beside it
  // The list tells a failed run from a failed reply.
  assert.deepEqual((await call(`${orch.url}/tasks?owner=dan.near`)).tasks.map((x: any) => [x.id, x.status, x.has_plan]),
    [[hang.id, 'running', true], [reply.id, 'failed', false]]);
  await call(`${orch.url}/tasks/${hang.id}/kill`, { owner: 'dan.near' });
  plan = holdersPlan();
  const afterKill = await send('Try it again', reply.id);
  assert.equal(afterKill.status, 'planned');
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Holders', 'go ahead'], revising: false });
  await call(`${orch.url}/tasks/${afterKill.id}/cancel`, {});

  // [closed, failed reply]: the next message follows up on the finished run, with its report.
  const first = await call(`${orch.url}/tasks`, { prompt: 'Due diligence', budget_usdc: '1', owner: 'dan.near' });
  const again = await send('go ahead', first.id);
  await call(`${orch.url}/tasks/${first.id}/approve`, { owner: 'dan.near' });
  const done = await ended(first.id);
  assert.equal(done.task.status, 'closed', done.task.error);
  const follow = await send('Now translate it to Turkish', again.id);
  assert.deepEqual([follow.status, follow.parent_id], ['planned', again.id]);
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Due diligence', 'go ahead'], revising: false, report: done.final_result.final_markdown.trim() });
  await call(`${orch.url}/tasks/${follow.id}/cancel`, {});
});

test('a message is refused while the task it follows is planning or running, after a newer message, and for another owner', async () => {
  const send = (parent_id: string, owner?: string) => call(`${orch.url}/tasks`, { prompt: 'More', budget_usdc: '1', parent_id, ...(owner ? { owner } : {}) });
  const refused = (status: number, message?: string) => (e: any) => e.status === status && (message === undefined || e.message === message);

  let open!: () => void;
  planGate = new Promise((ok) => (open = ok));
  plan = holdersPlan();
  const drafting = await call(`${orch.url}/tasks`, { prompt: 'Holders', budget_usdc: '1', owner: 'bob.near', wait: false });
  await assert.rejects(send(drafting.id, 'bob.near'), refused(409, 'Wait for the plan to be ready before sending more.'));
  open();
  planGate = Promise.resolve();
  await until(async () => (await snap(drafting.id)).task.status === 'planned');

  // Someone else's task, or none: 404, as on every route. The CLI (no owner) cannot follow an account's task either.
  await assert.rejects(send(drafting.id, 'carol.near'), refused(404));
  await assert.rejects(send('t_nothere', 'bob.near'), refused(404));
  await assert.rejects(send(drafting.id), refused(409));

  // A conversation is a chain: once a task has a follow-up, only the newest task takes the next message.
  const next = await send(drafting.id, 'bob.near');
  assert.equal(next.status, 'planned');
  await assert.rejects(send(drafting.id, 'bob.near'), refused(409, 'This conversation has a newer message: send after the newest one.'));

  // Approved and running: wait or stop. Stopped: a follow-up is fine, and it changes no plan.
  plan = { subtasks: [sub('s1', 'Hang', '200000', [cand('hang', '100000', 60)])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] };
  const running = await send(next.id, 'bob.near');
  await call(`${orch.url}/tasks/${running.id}/approve`, { owner: 'bob.near' });
  await until(async () => (await snap(running.id)).subtasks[0].status === 'working');
  await assert.rejects(send(running.id, 'bob.near'), refused(409, 'Wait for this run to finish, or stop it, before sending more.'));
  await call(`${orch.url}/tasks/${running.id}/kill`, { owner: 'bob.near' });
  plan = holdersPlan();
  const after = await send(running.id, 'bob.near');
  assert.equal(after.status, 'planned');
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Holders', 'More', 'More'], revising: false });
  assert.equal((await snap(running.id)).task.replaced_by, null);
});

test("a total budget the message names becomes the task's budget, within the limits; one out of range ends the draft with the reason", async () => {
  const named = (budget_atomic: string, reserve_atomic: string, reserve_bps: number) => ({
    ...holdersPlan(), budget: { budget_atomic, reserve_atomic, reserve_bps, allocatable_atomic: String(BigInt(budget_atomic) - BigInt(reserve_atomic)), allocated_atomic: '300000', from_message: true },
  });
  plan = named('1500000', '1200000', 8000);
  const first = await call(`${orch.url}/tasks`, { prompt: 'Holders of NEAR, make it 1.5 USDC', budget_usdc: '3', owner: 'erin.near' });
  assert.deepEqual([first.status, first.budget_atomic, first.reserve_share], ['planned', '1500000', 0.8]);
  // The planner got the budget sent with the message, and the contract's minimum (none with the sim ledger).
  assert.deepEqual([planRequests.at(-1).budget_atomic, planRequests.at(-1).min_budget_atomic], ['3000000', '0']);
  assert.equal((await call(`${orch.url}/tasks?owner=erin.near`)).tasks[0].budget_atomic, '1500000');
  await call(`${orch.url}/tasks/${first.id}/approve`, { owner: 'erin.near' });
  const ran = await ended(first.id);
  assert.equal(ran.task.status, 'closed', ran.task.error);
  assert.equal(ran.ledger.budget_atomic, '1500000'); // the run's books hold the named budget

  // Out of range (a planner that didn't check): the draft fails with the reason and keeps the budget it was sent with.
  plan = named('60000000', '1200000', 8000);
  const big = await call(`${orch.url}/tasks`, { prompt: 'Holders of NEAR for 60 USDC', budget_usdc: '3', owner: 'erin.near' });
  assert.deepEqual([big.status, big.error, big.budget_atomic, big.plan],
    ['failed', 'Your message asks for a budget of 60.00 USDC, but the most Rook takes is 50.00 USDC.', '3000000', null]);

  // A planner that says the message named a total when it names no amount at all: the plan is never kept, so the
  // budget sent is never moved by a model's mistake.
  const { BUDGET_NOT_NAMED } = await import('../src/orchestrator/index.ts');
  plan = named('1500000', '1200000', 8000);
  const silent = await call(`${orch.url}/tasks`, { prompt: 'Now translate it to Turkish', budget_usdc: '3', owner: 'erin.near' });
  assert.deepEqual([silent.status, silent.error, silent.budget_atomic, silent.plan], ['failed', BUDGET_NOT_NAMED, '3000000', null]);
});

test('the conversation sent to the planner keeps the first and the newest messages, and the newest report cut to size', async () => {
  const { conversationFor } = await import('../src/orchestrator/index.ts');
  const { newTask } = await import('../src/orchestrator/store.ts');
  const { Conversation, CONVERSATION_MESSAGES, CONVERSATION_REPORT_CHARS } = await import('../src/shared/types.ts');
  const chain = Array.from({ length: 15 }, (_, i) => newTask(`m${i}`, 1_000_000n, 0.2)).reverse(); // nearest first
  const report = (text: string) => ({ final_markdown: text, attribution: [], abandoned: [] });
  chain[5].final_result = report('older report');
  chain[3].final_result = report('x'.repeat(20_000));
  const c = conversationFor(chain, null);
  assert.equal(c.earlier.length, CONVERSATION_MESSAGES);
  assert.deepEqual([c.earlier[0], c.earlier[1], c.earlier.at(-1)], ['m0', 'm4', 'm14']);
  assert.equal(c.report!.length, CONVERSATION_REPORT_CHARS);
  assert.match(c.report!, /^x+\n\n\[The rest of the report is left out here\.\]$/);
  assert.equal(c.revising, false);
  assert.ok(Conversation.safeParse(c).success);
  // Short ones go as they are; with no report, there is no report field.
  assert.deepEqual(conversationFor(chain.slice(-2), chain.at(-1)!), { earlier: ['m0', 'm1'], revising: true });

  // With files: the newest report's files only, each fenced and named (a fence longer than any in the file).
  const file = (name: string, text: string) => ({ subtask_id: 's1', agent_handle: 'web-dev', name, mime: 'text/html', text });
  chain[5].final_result = { ...report('older report'), files: [file('old.html', 'never sent')] };
  chain[3].final_result = { ...report('Here is the site.\n[file index.html, 2 lines, attached below the report]'), files: [file('index.html', '<p>a</p>\n<pre>```x```</pre>')] };
  assert.equal(conversationFor(chain, null).report,
    'Here is the site.\n[file index.html, 2 lines, attached below the report]\n\nThe files attached to the report, as delivered:\n\nindex.html:\n````\n<p>a</p>\n<pre>```x```</pre>\n````');
  // Too long: the report keeps its first 4000 characters, the files fill the rest, and a note says what is left out.
  const line = (n: number) => `<p>line ${String(n).padStart(4, '0')}</p>`; // 17 characters
  const page = Array.from({ length: 600 }, (_, n) => line(n + 1)).join('\n');
  chain[3].final_result = { ...report('r'.repeat(9000)), files: [file('index.html', page), file('styles.css', 'body {}'), file('app.js', 'go();')] };
  const big = conversationFor(chain, null).report!;
  assert.ok(Conversation.safeParse({ earlier: ['m0'], revising: false, report: big }).success, String(big.length));
  assert.match(big, /^r{3956}\n\n\[The rest of the report is left out here\.\]\n\nThe files attached to the report, as delivered:\n\nindex\.html:\n```\n<p>line 0001<\/p>\n/);
  const shown = big.match(/<p>line (\d+)<\/p>\n```\n\n\[Cut for length: index\.html is cut at line (\d+) of 600; 2 more files are left out\.\]$/);
  assert.ok(shown && Number(shown[1]) === Number(shown[2]) && Number(shown[1]) > 400, big.slice(-300)); // cut at a line end, and said so
  // A report that leaves no room cuts the file too, never past the limit.
  chain[3].final_result = { ...report('r'.repeat(3000)), files: [file('a.html', 'x'.repeat(20_000))] };
  const one = conversationFor(chain, null).report!;
  assert.ok(one.length <= CONVERSATION_REPORT_CHARS && one.endsWith('\n```\n\n[Cut for length: a.html is cut at line 1 of 1.]'), one.slice(-200));
});

// ---- sending again, editing, deleting ----

const as = (owner: string) => ({
  send: (body: any) => call(`${orch.url}/tasks`, { budget_usdc: '1', owner, ...body }),
  approve: (id: string) => call(`${orch.url}/tasks/${id}/approve`, { owner }),
  del: (id: string, who: string | null = owner) => call(`${orch.url}/conversations/${id}/delete`, who ? { owner: who } : {}),
});
const refusedWith = (status: number, message?: string) => (e: any) => e.status === status && (message === undefined || e.message === message);
const NEWER = 'This conversation has a newer message: send after the newest one.';

test('a message that failed before it got a plan, sent again, takes its place: it follows the same task, and the failed one is superseded', async () => {
  const { send } = as('fay.near');
  plan = holdersPlan();
  const first = await send({ prompt: 'Holders of NEAR' });
  planDown = true;
  const failed = await send({ prompt: 'Make it shorter', parent_id: first.id });
  planDown = false;
  assert.deepEqual([failed.status, failed.error], ['failed', 'planner: planner LLM failed: NEAR AI 500']);

  const again = await send({ prompt: 'Make it shorter', supersedes: failed.id });
  assert.deepEqual([again.status, again.parent_id, again.supersedes, again.edited], ['planned', first.id, failed.id, false]);
  // It revises the plan above, as the failed one was going to; the failed one stays as it was, superseded.
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Holders of NEAR'], revising: true });
  assert.deepEqual([(await snap(first.id)).task.status, (await snap(first.id)).task.replaced_by], ['cancelled', again.id]);
  const was = (await snap(failed.id)).task;
  assert.deepEqual([was.status, was.superseded_by, was.replaced_by], ['failed', again.id, null]);
  const rows = (await call(`${orch.url}/tasks?owner=fay.near`)).tasks.filter((x: any) => [failed.id, again.id].includes(x.id));
  assert.deepEqual(rows.map((x: any) => [x.id, x.parent_id, x.supersedes, x.superseded_by, x.edited]), [[failed.id, first.id, null, again.id, false], [again.id, first.id, failed.id, null, false]]);

  // Once only; and a page that still shows the failed one as the newest sends after the newer one.
  await assert.rejects(send({ prompt: 'Make it shorter', supersedes: failed.id }), refusedWith(409, 'This message was already edited or sent again.'));
  await assert.rejects(send({ prompt: 'More', parent_id: failed.id }), refusedWith(409, NEWER));
  await assert.rejects(send({ prompt: 'More', parent_id: first.id }), refusedWith(409, NEWER));
  // It keeps its place: a parent_id sent with it must be the one it had.
  await assert.rejects(send({ prompt: 'x', supersedes: again.id, parent_id: failed.id }), refusedWith(400));

  // A conversation's first message, sent again, starts it again: no conversation for the planner.
  planDown = true;
  const root = await send({ prompt: 'Due diligence on Aurora' });
  planDown = false;
  const root2 = await send({ prompt: 'Due diligence on Aurora', supersedes: root.id });
  assert.deepEqual([root2.status, root2.parent_id, root2.supersedes], ['planned', null, root.id]);
  assert.equal(planRequests.at(-1).conversation, undefined);
  await call(`${orch.url}/tasks/${root2.id}/cancel`, {});
  await call(`${orch.url}/tasks/${again.id}/cancel`, {});
});

test('the newest message can be edited until its plan is approved: its draft stops or its plan is cancelled, and the edit takes its place', async () => {
  const { send, approve } = as('gil.near');
  plan = holdersPlan();
  const first = await send({ prompt: 'Holders of NEAR' });
  const edited = await send({ prompt: 'Holders of Aurora', budget_usdc: '2', supersedes: first.id });
  assert.deepEqual([edited.status, edited.parent_id, edited.edited, edited.budget_atomic], ['planned', null, true, '2000000']);
  const old = (await snap(first.id)).task;
  assert.deepEqual([old.status, old.superseded_by, old.replaced_by], ['cancelled', edited.id, null]); // superseded, not revised
  assert.equal((await call(`${orch.url}/tasks`)).tasks.find((x: any) => x.id === edited.id).edited, true); // `rook list` says "edited as"
  await assert.rejects(approve(first.id), /cancelled/);

  // Still drafting: its planning stops, and the planner's late answer changes nothing.
  let open!: () => void;
  planGate = new Promise((ok) => (open = ok));
  const drafting = await send({ prompt: 'Add the holders', parent_id: edited.id, wait: false });
  const fixed = await send({ prompt: 'Add the top 10 holders', supersedes: drafting.id, wait: false });
  assert.deepEqual([fixed.status, fixed.parent_id, fixed.edited], ['draft', edited.id, true]);
  assert.equal((await snap(drafting.id)).task.status, 'killed');
  open();
  planGate = Promise.resolve();
  await until(async () => (await snap(fixed.id)).task.status === 'planned');
  assert.deepEqual([(await snap(drafting.id)).task.status, (await snap(drafting.id)).task.superseded_by], ['killed', fixed.id]);
  // The edit revises the plan the stopped draft was revising.
  assert.deepEqual([(await snap(edited.id)).task.status, (await snap(edited.id)).task.replaced_by], ['cancelled', fixed.id]);

  // Only the newest message: editing an older one would branch the conversation.
  const next = await send({ prompt: 'Now in Turkish', parent_id: fixed.id });
  await assert.rejects(send({ prompt: 'x', supersedes: fixed.id }), refusedWith(409, 'Only the newest message can be edited or sent again.'));
  // Someone else's message is no message at all; the CLI, naming no owner, can't take an account's message's place.
  await assert.rejects(as('eve.near').send({ prompt: 'x', supersedes: next.id }), refusedWith(404));
  await assert.rejects(call(`${orch.url}/tasks`, { prompt: 'x', budget_usdc: '1', supersedes: next.id }), refusedWith(409));
  // Never once approved: its funding may have moved.
  await approve(next.id);
  assert.equal((await ended(next.id)).task.status, 'closed');
  await assert.rejects(send({ prompt: 'x', supersedes: next.id }), refusedWith(409, "This message's plan was approved, so it can't be changed now. Send a new message instead."));
});

test('a revision whose plan replaced the plan above, edited, still revises that plan, which names the edit in its place', async () => {
  const { send } = as('ivy.near');
  const replacedBy = async (id: string) => { const x = (await snap(id)).task; return [x.status, x.replaced_by]; };
  plan = holdersPlan();
  const first = await send({ prompt: 'Holders of NEAR' });
  const revision = await send({ prompt: 'Only the top 10', parent_id: first.id });
  assert.deepEqual(await replacedBy(first.id), ['cancelled', revision.id]);

  // The plan above never ran: the edit is planned as a revision of it, as the message it replaces was.
  const edit = await send({ prompt: 'Only the top 20', supersedes: revision.id });
  assert.deepEqual([edit.status, edit.parent_id, edit.edited], ['planned', first.id, true]);
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Holders of NEAR'], revising: true });
  assert.deepEqual([(await snap(revision.id)).task.status, (await snap(revision.id)).task.superseded_by], ['cancelled', edit.id]);
  assert.deepEqual(await replacedBy(first.id), ['cancelled', edit.id]);

  // An edit whose planning fails leaves that plan naming the last revision that got a plan; sent again, it revises it still.
  planDown = true;
  const failed = await send({ prompt: 'Only the top 5', supersedes: edit.id });
  planDown = false;
  assert.equal(failed.status, 'failed');
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Holders of NEAR'], revising: true });
  assert.deepEqual(await replacedBy(first.id), ['cancelled', edit.id]);
  const again = await send({ prompt: 'Only the top 5', supersedes: failed.id });
  assert.deepEqual([again.status, again.edited], ['planned', false]);
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Holders of NEAR'], revising: true });
  assert.deepEqual(await replacedBy(first.id), ['cancelled', again.id]);

  // Below a failed reply the plan above it is still what the revision changed, so an edit of the revision revises it too.
  const base = await send({ prompt: 'Due diligence on Aurora' });
  const nod = await send({ prompt: 'go ahead', parent_id: base.id });
  const shorter = await send({ prompt: 'Make it shorter', parent_id: nod.id });
  assert.deepEqual(await replacedBy(base.id), ['cancelled', shorter.id]);
  const shorter2 = await send({ prompt: 'Make it much shorter', supersedes: shorter.id });
  assert.deepEqual([shorter2.status, shorter2.parent_id], ['planned', nod.id]);
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Due diligence on Aurora', 'go ahead'], revising: true });
  assert.deepEqual(await replacedBy(base.id), ['cancelled', shorter2.id]);

  // A follow-up on work that ended is no revision, edited or not.
  await call(`${orch.url}/tasks/${shorter2.id}/cancel`, {});
  const after = await send({ prompt: 'Start over', parent_id: shorter2.id });
  const after2 = await send({ prompt: 'Start over, top 3 only', supersedes: after.id });
  assert.deepEqual(planRequests.at(-1).conversation, { earlier: ['Due diligence on Aurora', 'go ahead', 'Make it much shorter'], revising: false });
  assert.deepEqual(await replacedBy(shorter2.id), ['cancelled', null]);
  await call(`${orch.url}/tasks/${after2.id}/cancel`, {});
  await call(`${orch.url}/tasks/${again.id}/cancel`, {});
});

test('deleting a conversation leaves all its tasks out for their owner, refused while one holds money; the CLI still sees them', async () => {
  const { send, approve, del } = as('hal.near');
  planDown = true;
  const root = await send({ prompt: 'Holders' });
  planDown = false;
  plan = { subtasks: [sub('s1', 'Hang', '200000', [cand('hang', '100000', 60)])], dropped: [], budget: budget('200000'), notes: [], llm_calls: [] };
  const root2 = await send({ prompt: 'Holders', supersedes: root.id });
  await approve(root2.id);
  await until(async () => (await snap(root2.id)).subtasks[0].status === 'working');
  // Asked from any of its tasks, the refusal names the one that holds the money, for the web app to link.
  const running = (e: any) => refusedWith(409, 'A run in this chat is still under way. Stop it or let it finish, then delete the chat.')(e) && e.body?.details?.task_id === root2.id;
  await assert.rejects(del(root2.id), running);
  await assert.rejects(del(root.id), running);
  await call(`${orch.url}/tasks/${root2.id}/kill`, { owner: 'hal.near' });
  const stopped = await until(async () => { const x = await snap(root2.id); return x.ledger?.closed ? x : false; });

  plan = holdersPlan();
  const follow = await send({ prompt: 'Try it again', parent_id: root2.id });
  let open!: () => void;
  planGate = new Promise((ok) => (open = ok));
  const drafting = await send({ prompt: 'Make it shorter', parent_id: follow.id, wait: false });
  const other = await send({ prompt: 'Another chat', wait: false });
  await assert.rejects(del(follow.id, 'eve.near'), refusedWith(404));

  // Any of its tasks names it, the superseded first message too. A plan waiting is cancelled, a draft stopped.
  const out = await del(drafting.id);
  assert.deepEqual(out.deleted.sort(), [root.id, root2.id, follow.id, drafting.id].sort());
  open();
  planGate = Promise.resolve();
  assert.deepEqual([(await snap(follow.id)).task.status, (await snap(drafting.id)).task.status], ['cancelled', 'killed']);
  await until(async () => (await snap(other.id)).task.status === 'planned'); // another conversation is left alone

  // Gone for the owner: not listed, 404 on its routes (saying why, so the page can tell them), and nothing can follow
  // it. Anyone else still learns nothing of it.
  assert.deepEqual((await call(`${orch.url}/tasks?owner=hal.near`)).tasks.map((x: any) => x.id), [other.id]);
  await assert.rejects(call(`${orch.url}/tasks/${follow.id}?owner=hal.near`), refusedWith(404, `no task ${follow.id}: its conversation was deleted`));
  await assert.rejects(call(`${orch.url}/tasks/${follow.id}?owner=eve.near`), refusedWith(404, `no task ${follow.id}`));
  assert.equal((await fetch(`${orch.url}/tasks/${root2.id}/events?owner=hal.near`)).status, 404);
  await assert.rejects(send({ prompt: 'More', parent_id: drafting.id }), refusedWith(404, `no task ${drafting.id}: its conversation was deleted`));
  await assert.rejects(call(`${orch.url}/tasks`, { prompt: 'More', budget_usdc: '1', parent_id: drafting.id }), refusedWith(409, 'This conversation was deleted.'));
  await assert.rejects(del(follow.id), refusedWith(404));
  // Kept for the record: the CLI still sees every task, marked deleted, with its books and receipts.
  const kept = await snap(root2.id);
  assert.ok(kept.task.deleted_at);
  assert.deepEqual([kept.ledger, kept.receipts], [stopped.ledger, stopped.receipts]);
  assert.ok((await call(`${orch.url}/tasks`)).tasks.find((x: any) => x.id === root.id).deleted_at);
  await call(`${orch.url}/tasks/${other.id}/cancel`, {});
});
