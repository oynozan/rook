// Spending rules from the chat (Plan.spending, docs/agent-wallet-plan.md): the draft reads them, the planner keeps only
// what the user's own words back, and the conversation carries them forward. The market and NEAR AI are fakes.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSummary, SpendingRules } from '../src/shared/types.ts';

const { Draft } = await import('../src/planner/plan.ts');
const { readSpending, describeSpending, numbersSaid, daysSaid } = await import('../src/planner/spending.ts');
const { DRAFT_SYSTEM, draftMessage } = await import('../src/planner/prompts.ts');
type DraftSubtask = import('../src/planner/plan.ts').DraftSubtask;
type QuoteResult = import('../src/planner/plan.ts').QuoteResult;

const RECIPIENT = { network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim' };
const row = (amount: string): QuoteResult =>
  ({ ok: true, row: { scheme: 'exact', network: RECIPIENT.network, asset: RECIPIENT.asset, amount, payTo: RECIPIENT.payTo, maxTimeoutSeconds: 60 } });
const agent = (handle: string): AgentSummary => ({
  handle, name: handle, description: `${handle} agent`, category: null, tags: [], available_now: true,
  listing_status: 'live', payable_with: ['USDC'], sla_seconds: 20, success_rate: 90, delivered_jobs: 10,
});
const sub = (title: string): DraftSubtask => ({
  title, brief: `${title}\n\nDo it.`, search_terms: [title], self_do_ok: false, criteria: [{ id: 'j', kind: 'llm_judge', description: 'Good', spec: { question: 'Is it good?' } }],
});

// ---- Reading the rules (spending.ts) ----

test('numbers and durations are read from the user\'s words every way they can be written', () => {
  for (const [text, n] of [['Only spend $1000', 1000], ['max 1,000 USDC', 1000], ['1.000 dolar', 1000], ['1k a week', 1000], ['a thousand dollars', 1000],
    ['two hundred bucks', 200], ['5 bin dolar', 5000], ['no task over $20', 20], ['at most 2.5 USDC', 2.5]] as const) {
    assert.ok(numbersSaid(text).includes(n), `${text}: ${numbersSaid(text)}`);
  }
  for (const [text, d] of [['for the next two weeks', 14], ['for 30 days', 30], ['a month', 30], ['önümüzdeki iki hafta', 14], ['3 aylığına', 90], ['1 yıl', 365]] as const) {
    assert.ok(daysSaid(text).includes(d), `${text}: ${daysSaid(text)}`);
  }
  assert.deepEqual(daysSaid('Top 10 holders, 3 pages'), []);
  // A decimal mark is never read as a thousands mark: "2.5" backing a limit of 25 would loosen it tenfold.
  for (const [text, n] of [['at most 2.5 USDC', 2.5], ['no task over 1,5 dolar', 1.5]] as const) assert.deepEqual(numbersSaid(text), [n], text);
});

test('rules the user stated are kept; an amount or a duration no message of theirs states is left out with a note', () => {
  const notes: string[] = [];
  const said = ['Only spend $1000, make sure all transactions come to me for approval, for the next two weeks'];
  assert.deepEqual(readSpending({ budget_usd: 1000, period: 'month', approval: 'every', expires_days: 14 }, said, undefined, notes),
    { rules: { budget_usd: 1000, period: 'month', approval: 'every', expires_days: 14 }, stated: true });
  assert.deepEqual(notes, []);
  // The model's own numbers: 500 and 30 days are nowhere in the message, the approval rule is.
  const r = readSpending({ budget_usd: 500, period: 'week', per_task_max_usd: '20', approval: 'every', expires_days: 30 }, ['Ask me before every payment'], undefined, notes);
  assert.deepEqual(r, { rules: { approval: 'every' }, stated: true });
  assert.deepEqual(notes, [
    "Rook left out the spending limit of 500 USD: no message of yours states that amount. Write it in digits, like 'only spend 1000 USDC a month'.",
    "Rook left out the per-task limit of 20 USD: no message of yours states that amount. Write it in digits, like 'only spend 1000 USDC a month'.",
    "Rook left out the time limit of 30 days: no message of yours states it. Say it in days, weeks or months, like 'for the next 2 weeks'.",
    'Rook left out the period of the spending limit: there is no spending limit for it to apply to.',
  ]);
});

test('a bad field is dropped, never a failed plan; a limit with no period is a monthly one', () => {
  const notes: string[] = [];
  const r = readSpending({ budget_usd: 50, period: 'yearly', approval: 'sometimes', per_task_max_usd: -5, colour: 'red', expires_days: null }, ['max 50 USDC'], undefined, notes);
  assert.deepEqual(r, { rules: { budget_usd: 50, period: 'month' }, stated: true });
  assert.equal(notes.length, 5, notes.join('\n'));
  assert.ok(notes.includes('Rook reads the spending limit of 50 USD as a monthly one: the wallet\'s limits renew each day, week or month.'));
  assert.ok(notes.includes('Rook left out the approval rule: "sometimes" is not one Rook can keep.'));
  // Not an object at all: the rules in force stay as they were.
  const carried: SpendingRules = { approval: 'every' };
  assert.deepEqual(readSpending('ask me', ['ask me'], carried, notes), { rules: carried, stated: false });
});

test('the rules in force carry forward: a message changes only what it states, and their amounts need no restating', () => {
  const carried: SpendingRules = { budget_usd: 1000, period: 'month', approval: 'every' };
  const notes: string[] = [];
  assert.deepEqual(readSpending(undefined, ['Write a poem'], carried, notes), { rules: carried, stated: false });
  // "make it weekly": the 1000 the model repeats was stated in a message the conversation no longer holds.
  assert.deepEqual(readSpending({ budget_usd: 1000, period: 'week' }, ['Make the limit weekly'], carried, notes),
    { rules: { budget_usd: 1000, period: 'week', approval: 'every' }, stated: true });
  assert.deepEqual(readSpending({ approval: 'none' }, ["You don't need to ask me any more"], carried, notes).rules, { budget_usd: 1000, period: 'month', approval: 'none' });
  assert.deepEqual(notes, []);
});

test('the rules are repeated back in one plain sentence', () => {
  assert.equal(describeSpending({ budget_usd: 1000, period: 'month', approval: 'every' }), 'Rook spends at most 1000 USD a month, and every payment waits for your approval.');
  assert.equal(describeSpending({ per_task_max_usd: 2.5, expires_days: 14 }), 'Rook spends at most 2.50 USD on one task, for the next 14 days.');
  assert.equal(describeSpending({ approval: 'every' }), 'Every payment waits for your approval.');
});

// ---- The draft ----

test('a draft that only states spending rules is valid; one with nothing at all is still asked again', () => {
  assert.equal(Draft.safeParse({ subtasks: [], spending: { approval: 'every' }, assumptions: ['Every payment waits for your approval.'] }).success, true);
  assert.equal(Draft.safeParse({ subtasks: [], spending: { approval: null } }).success, false);
  assert.equal(Draft.safeParse({ subtasks: [] }).success, false);
});

test('the draft prompt tells spending rules from the task budget, with examples, and sees the rules in force', () => {
  assert.match(DRAFT_SYSTEM, /\("only spend \$1000"\) is a monthly limit \("budget_usd":1000,"period":"month"\)/);
  assert.match(DRAFT_SYSTEM, /Spending rules are not "budget_usdc"\. budget_usdc is what this one task may cost/);
  assert.match(DRAFT_SYSTEM, /sets both: "budget_usdc":2 and "spending":\{"budget_usd":50,"period":"week"\}/);
  assert.match(DRAFT_SYSTEM, /Never invent a rule, an amount or a period the user didn't state/);
  // The rules-only example is the JSON the model replies with.
  const only = DRAFT_SYSTEM.match(/return (\{"subtasks":\[\],"spending":[^\n]*?\]\}) with the rules/)!;
  assert.deepEqual(Draft.parse(JSON.parse(only[1])).spending, { approval: 'every' });
  const conv = { earlier: ['Only spend $1000'], revising: false, spending: { budget_usd: 1000, period: 'month' as const } };
  assert.match(draftMessage('Write a poem', 1n, 1n, conv), /The spending rules in force in this conversation, which the latest message keeps unless it changes them: \{"budget_usd":1000,"period":"month"\}/);
  assert.doesNotMatch(draftMessage('Write a poem', 1n, 1n, { earlier: ['hi'], revising: false }), /spending rules in force/);
});

// ---- POST /plan with a fake NEAR AI and market ----

function fakeAi(t: any, answer: (system: string) => unknown, env: Record<string, string | undefined>) {
  const all = { ROOK_LLM: 'near', NEARAI_API_KEY: 'test-key', NEARAI_BASE_URL: 'https://nearai.test/v1', ...env };
  const saved = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]));
  const set = (e: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(e)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set(all);
  const real = globalThis.fetch;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!url.startsWith('https://nearai.test/')) return real(input, init);
    if (url.endsWith('/models')) return reply({ data: [] });
    if (url.includes('/signature/')) return reply({});
    if (!url.endsWith('/chat/completions')) return reply({}, 404);
    const { messages } = JSON.parse(init.body);
    return reply({ id: 'c', choices: [{ message: { content: JSON.stringify(answer(messages[0].content) ?? 'ok') }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; set(saved); });
}
const isDraft = (system: string) => system.includes('Split the user');
const isSelect = (system: string) => system.includes('For each subtask below');

async function harness(t: any, draft: () => unknown) {
  const { serve, call } = await import('../src/shared/http.ts');
  const searched: string[] = [];
  const gw = await serve('fake-gateway', {
    'GET /search': ({ query }) => (searched.push(query.get('q') ?? ''), { agents: query.get('q') === 'Holders' ? [agent('holders-agent')] : [] }),
    'GET /x402': () => ({ x402Version: 2, recipients: [RECIPIENT] }),
    'POST /quote': () => row('100000'),
  }, 0);
  fakeAi(t, (s) => (isDraft(s) ? draft() : isSelect(s) ? { selections: [{ subtask_index: 1, handles: ['holders-agent'] }] } : undefined), { MARKET_GATEWAY_URL: gw.url });
  const { start } = await import('../src/planner/index.ts');
  const planner = await start(0);
  t.after(async () => { await planner.close(); await gw.close(); });
  const body = { task_id: 't', budget_atomic: '3000000', reserve_share: 0.2 };
  return { plan: (b: Record<string, unknown>) => call<any>(`${planner.url}/plan`, { ...body, ...b }), searched };
}

test('POST /plan: a message that only states spending rules gets them back as a plan with no parts, nothing searched', async (t) => {
  let reply: unknown = { subtasks: [], spending: { budget_usd: 1000, period: 'month', approval: 'every' } };
  const h = await harness(t, () => reply);
  const p = await h.plan({ prompt: 'Only spend $1000, make sure all transactions come to me for approval' });
  assert.deepEqual(p.subtasks, []);
  assert.equal(p.questions, undefined);
  assert.deepEqual(p.spending, { budget_usd: 1000, period: 'month', approval: 'every' });
  // No confirmation from the draft: Rook writes one.
  assert.deepEqual(p.assumptions, ['Rook spends at most 1000 USD a month, and every payment waits for your approval.']);
  assert.equal(p.budget.allocated_atomic, '0');
  assert.deepEqual(h.searched, []);
  // Rules the message does not back are no reply at all: Rook says how to write them.
  reply = { subtasks: [], spending: { budget_usd: 750 } };
  await assert.rejects(h.plan({ prompt: 'Keep my spending low' }), (e: any) => e.status === 422 && /couldn't keep the spending rules in your message: write each amount in digits/.test(e.message));
});

test('POST /plan: a go-ahead that echoes the rules in force unchanged is still a go-ahead, not a rules reply', async (t) => {
  const { GO_AHEAD } = await import('../src/planner/prompts.ts');
  const conversation = { earlier: ['Research the NEAR token holders. Ask me before every payment'], revising: true, spending: { approval: 'every' } };
  let reply: unknown = { subtasks: [], not_a_task: GO_AHEAD, spending: { approval: 'every' } };
  const h = await harness(t, () => reply);
  await assert.rejects(h.plan({ prompt: 'yes', conversation }), (e: any) => e.status === 422 && e.message === GO_AHEAD);
  // A rule the message does change is the reply, whatever else the draft set.
  reply = { subtasks: [], not_a_task: GO_AHEAD, spending: { approval: 'none' } };
  assert.deepEqual((await h.plan({ prompt: "yes, and you don't need to ask me any more", conversation })).spending, { approval: 'none' });
});

test('POST /plan: a task budget and a spending limit in one message: each where it belongs', async (t) => {
  const h = await harness(t, () => ({ subtasks: [sub('Holders')], budget_usdc: 2, spending: { budget_usd: 50, period: 'week' } }));
  const p = await h.plan({ prompt: 'Research the NEAR token holders for 2 USDC, and never spend more than $50 a week' });
  assert.deepEqual([p.budget.budget_atomic, p.budget.from_message], ['2000000', true]);
  assert.deepEqual(p.spending, { budget_usd: 50, period: 'week' });
  assert.equal(p.subtasks.length, 1);
});

test('POST /plan: a spending limit the model also took for the task budget is kept as a limit, and the note says so', async (t) => {
  const h = await harness(t, () => ({ subtasks: [sub('Holders')], budget_usdc: 1000, spending: { budget_usd: 1000, period: 'month' } }));
  const p = await h.plan({ prompt: 'Research the NEAR token holders. Only spend $1000 a month.' });
  assert.equal(p.budget.budget_atomic, '3000000');
  assert.deepEqual(p.spending, { budget_usd: 1000, period: 'month' });
  assert.ok(p.notes.some((n: string) => n.startsWith("Rook kept this task's budget at 3.00 USDC: 1000.00 is your spending limit, not what this task may cost.")), p.notes.join('\n'));
});

test('POST /plan: an amount the message mentions, read as the total but not in a budget phrase, is never said to be missing', async (t) => {
  // Browser QA 2026-11-12: "Only spend $5 and ask me before paying" came back with "your message doesn't name a total of 5.00 USDC".
  const h = await harness(t, () => ({ subtasks: [sub('Copy')], budget_usdc: 5, spending: { approval: 'every' } }));
  const p = await h.plan({ prompt: 'Write a two-sentence product description for a reusable water bottle. Only spend $5 and ask me before paying.' });
  assert.equal(p.budget.budget_atomic, '3000000');
  assert.ok(!p.notes.some((n: string) => /doesn't name/.test(n)), p.notes.join('\n'));
  assert.ok(p.notes.includes("Rook kept this task's budget at 3.00 USDC, the budget sent with your message: it didn't take the 5.00 USDC you mention as this task's total. If you meant that, say 'make it 5.00 USDC', or send your next message with that budget."), p.notes.join('\n'));
});

test('POST /plan: the conversation\'s rules carry into a later plan, its questions too, and a change applies on top', async (t) => {
  let reply: unknown = { subtasks: [sub('Holders')] };
  const h = await harness(t, () => reply);
  const conversation = { earlier: ['Only spend $1000, ask me before every payment'], revising: false, spending: { budget_usd: 1000, period: 'month', approval: 'every' } };
  const kept = await h.plan({ prompt: 'Research the NEAR token holders', conversation });
  assert.deepEqual(kept.spending, conversation.spending);
  reply = { subtasks: [], questions: ['Which token?'] };
  assert.deepEqual((await h.plan({ prompt: 'Research a token', conversation })).spending, conversation.spending);
  reply = { subtasks: [sub('Holders')], spending: { budget_usd: 200 } };
  const changed = await h.plan({ prompt: 'Research the NEAR token holders, and lower the limit to 200 dollars', conversation });
  assert.deepEqual(changed.spending, { budget_usd: 200, period: 'month', approval: 'every' });
  // A plan with no rules anywhere carries none.
  reply = { subtasks: [sub('Holders')] };
  assert.equal((await h.plan({ prompt: 'Research the NEAR token holders' })).spending, undefined);
});
