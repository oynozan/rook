// The planner's reports in plain words. Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanView, SelfDoReason } from '@/lib/server/orchestrator';
import { allSelfDoWhy, budgetToHire, plannerReason, selfDoWhy } from '@/lib/planner';

test("a planner failure reads in plain words; one with no plainer words says what the planner gave", () => {
  // The strings the orchestrator stores (services/src/orchestrator/index.ts: "planner: " + the planner's error).
  const plain: [string, RegExp][] = [
    ['planner: fetch failed', /^Rook's planner service didn't answer/],
    ['planner: planner ended without a plan', /^Rook's planner service didn't answer/],
    ['planner: market gateway search failed: fetch failed', /^The NEAR AI market could not be reached/],
    ['planner: market gateway search failed: GET http://127.0.0.1:7102/search?q=holders -> 502', /^The NEAR AI market could not be reached/],
    ['planner: market gateway search failed: market search unreachable: fetch failed', /^The NEAR AI market could not be reached/],
    ['planner: market gateway x402 failed: GET http://127.0.0.1:7102/x402 -> 502', /^The NEAR AI market could not be reached/],
    ['planner: planner LLM failed: NEAR AI 503 for plan.draft: <html><body>Service Unavailable</body></html>', /^The planning model is busy/],
    ['planner: planner LLM failed: NEAR AI 429 for plan.select: {"error":"rate limited"}', /^The planning model is busy/],
    ['planner: planner LLM failed: fetch failed', /^The planning model is busy or out of reach/],
    ['planner: planner LLM failed: Rook is busy, try again in a minute: the LLM calls in flight hold 0.9000 USD, and 0.2000 USD is spent in the last 24 h of the 10 USD a day ROOK_LLM_MAX_USD allows', /^Rook is busy\. Try again in a minute\.$/],
    ['planner: planner LLM failed: LLM plan.draft returned invalid JSON twice: [ { "origin": "array", "code": "too_big", "maximum": 3, "path": [ "subtasks", 2, "search_terms" ] } ]', /^The planning model gave an answer Rook couldn't use/],
    ['planner: planner LLM failed: no JSON object in model output', /^The planning model gave an answer Rook couldn't use/],
    ['planner: planner LLM failed: NEAR AI 402 for plan.draft: {"error":{"type":"no_limit_configured"}}', /^NEAR AI has no credits/],
    // Any other 402 is the same story (credits used up): no "try again", which can't help.
    ['planner: planner LLM failed: NEAR AI 402 for plan.draft: {"error":{"type":"insufficient_balance","message":"Credits exhausted"}}', /^NEAR AI has no credits available for Rook, so the planning model could not run\.$/],
    ['planner: planner LLM failed: NEAR AI 401 for plan.draft: {"error":"invalid api key"}', /^NEAR AI rejected Rook's API key/],
    ['planner: planner LLM failed: LLM cost guard: 1.0200 USD spent in the last 24 h (0.0000 in flight), limit ROOK_LLM_MAX_USD=1 per day', /daily spending limit/],
    ["Rook's services restarted while this task was draft, so it stopped there. It has no contract task on record, so nothing of it is on chain to resume.", /^Rook restarted while it was planning this task.*Send the task again\.$/],
  ];
  for (const [error, want] of plain) {
    const s = plannerReason(error);
    assert.match(s, want, error);
    assert.doesNotMatch(s, /planner LLM|gateway|127\.0\.0\.1|NEAR AI \d|JSON|draft,|contract task/, error);
  }
  // The planner's answer to a message that isn't a task is a sentence for the user (a 422, kept as is): shown as is.
  const notATask = 'That reads like a reply, not a task: to run a plan, use its button; to start something new, say what you want done.';
  assert.equal(plannerReason(notATask), notATask);
  // Tasks stored by older services carry it behind "planner: ": still the sentence, not "hit a problem".
  assert.equal(plannerReason(`planner: ${notATask}`), notATask);
  const fallback = 'This does not read as a task Rook can plan: say what you want done.';
  assert.equal(plannerReason(`planner: ${fallback}`), fallback);
  // Anything else internal says what the planner gave, after a plain lead.
  assert.equal(plannerReason("planner: Cannot read properties of undefined (reading 'handle')"),
    "Rook's planner hit an error it doesn't explain further: Cannot read properties of undefined (reading 'handle'). Try again in a moment.");
  assert.match(plannerReason('planner: [ { "code": "invalid_type", "path": [ "prompt" ] } ]'), /^Rook's planner hit an error it doesn't explain further: \[ \{ "code"/);
  // Only the planner's own sentence: model errors that happen to say it are still internal.
  assert.match(plannerReason('planner: planner LLM failed: NEAR AI 400 for plan.draft: not a task'), /^Rook's planner hit an error/);
});

test('a part Rook does itself says the true reason: no fitting agent, or a budget too small for the agents found', () => {
  assert.match(selfDoWhy({ self_do_reason: 'no_agent' }), /^No agent on the market fits this part/);
  // Not "more than this budget allows" next to a reserve: what is left for the part is what didn't fit.
  assert.equal(selfDoWhy({ self_do_reason: 'over_budget' }),
    'The agents found for this part cost more than this budget has left for it after the reserve and the parts before it, so Rook does it with its own model. A larger budget would hire one.');
  // Newer services say what the cheapest agent asks: the page names it, and the budget that would hire it.
  assert.equal(selfDoWhy({ self_do_reason: 'over_budget', self_do_need_atomic: '850000' }, 1_070_000n, false),
    'The cheapest agent found for this part asks 0.85 USDC, more than this budget has left for it after the reserve, so Rook does it with its own model. A budget of about 1.07 USDC would hire one.');
  assert.match(selfDoWhy({ self_do_reason: 'over_budget', self_do_need_atomic: '300000' }, 1_130_000n, true), /more than this budget has left for it after the reserve and the parts before it, so/);
  assert.match(selfDoWhy({ self_do_reason: 'over_budget', self_do_need_atomic: '850000' }, null), /asks 0\.85 USDC.*A larger budget would hire one\.$/);
  // Never a budget above the largest Rook takes (the composer would refuse it): say no budget can hire one.
  const big = { self_do_reason: 'over_budget' as const, self_do_need_atomic: '50000000' };
  assert.match(selfDoWhy(big, 62_500_000n, false, '50000000'), /asks 50\.00 USDC.*Even the largest budget Rook takes, 50\.00 USDC, is too small to hire one\.$/);
  assert.doesNotMatch(selfDoWhy(big, 62_500_000n, false, '50000000'), /62\.50/);
  assert.match(selfDoWhy(big, 50_000_000n, false, '50000000'), /A budget of about 50\.00 USDC would hire one\.$/); // the largest itself is fine
  assert.match(selfDoWhy(big, 62_500_000n, false, null), /A budget of about 62\.50 USDC would hire one\.$/); // older services name no limit
  // Older plans don't say: no reason is claimed.
  assert.equal(selfDoWhy({}), 'No agent is hired: Rook does this part with its own model.');
});

test('the budget that would hire the over-budget parts: what is left after the 20% reserve covers the caps and their cheapest quotes', () => {
  const sub = (id: string, extra: Partial<PlanView['subtasks'][number]>) => ({ id, title: id, cap_atomic: '0', self_do: true, criteria: [], candidates: [], ...extra });
  const hired = (id: string, cap: string) => sub(id, { cap_atomic: cap, self_do: false });
  const over = (id: string, need?: string) => sub(id, { self_do_reason: 'over_budget', ...(need ? { self_do_need_atomic: need } : {}) });
  const plan = (subtasks: PlanView['subtasks'], allocated: string) => ({ subtasks, budget: { reserve_atomic: '0', allocated_atomic: allocated } });

  // One part, nothing hired: 0.85 needs a budget whose 80% is at least 0.85, so 1.0625, rounded up to the cent.
  assert.equal(budgetToHire(plan([over('s1', '850000')], '0')), 1_070_000n);
  assert.equal(budgetToHire(plan([over('s1', '850000')], '0'), 's1'), 1_070_000n);
  // Budget 1.00, two parts hired at 0.30 and a third whose cheapest agent asks 0.30: 0.90 must be left, so 1.13
  // (1.125 rounded up; 1.13 leaves 0.904).
  const three = plan([hired('s1', '300000'), hired('s2', '300000'), over('s3', '300000')], '600000');
  assert.equal(budgetToHire(three, 's3'), 1_130_000n);
  // In plan order: a part counts the over-budget parts before it, the plan counts them all.
  const two = plan([over('s1', '400000'), hired('s2', '200000'), over('s3', '400000')], '200000');
  assert.equal(budgetToHire(two, 's1'), 750_000n); // 0.20 + 0.40 = 0.60 left: 0.75
  assert.equal(budgetToHire(two, 's3'), 1_250_000n); // 0.20 + 0.40 + 0.40 = 1.00 left: 1.25
  assert.equal(budgetToHire(two), 1_250_000n);
  // Exact cents stay as they are: 0.80 left is 1.00.
  assert.equal(budgetToHire(plan([over('s1', '800000')], '0')), 1_000_000n);
  // Nothing to name: no over-budget part, a part that isn't one, or a quote an older service didn't send.
  assert.equal(budgetToHire(plan([hired('s1', '300000'), sub('s2', { self_do_reason: 'no_agent' })], '300000')), null);
  assert.equal(budgetToHire(three, 's1'), null);
  assert.equal(budgetToHire(plan([over('s1'), over('s2', '100000')], '0')), null);
  assert.equal(budgetToHire(plan([over('s1'), over('s2', '100000')], '0'), 's2'), null);
});

// The parts of a plan Rook does all by itself, by their reasons.
const why = (...reasons: SelfDoReason[]) => reasons.map((self_do_reason) => ({ self_do_reason }));

test('a plan Rook does all by itself blames the market or the budget only when that is the reason', () => {
  assert.match(allSelfDoWhy(why('no_agent', 'no_agent')), /^No agent on the market fits these parts/);
  const over = allSelfDoWhy(why('over_budget', 'over_budget'));
  assert.match(over, /cost more than this budget allows/);
  assert.match(over, /larger budget/);
  assert.doesNotMatch(over, /No agent on the market fits/);
  // With what the agents ask, the budget that would hire them is named.
  assert.match(allSelfDoWhy(why('over_budget', 'over_budget'), 1_070_000n), /Draft it again with a budget of about 1\.07 USDC to hire them\.$/);
  assert.match(allSelfDoWhy(why('no_agent', 'over_budget'), 2_500_000n), /Draft it again with a budget of about 2\.50 USDC to hire agents for those\.$/);
  // Above the largest budget Rook takes, no draft can hire them: said so, never "draft it again".
  assert.match(allSelfDoWhy(why('over_budget', 'over_budget'), 62_500_000n, '50000000'), /them all itself with its own model\. Even the largest budget Rook takes, 50\.00 USDC, is too small to hire them\.$/);
  assert.match(allSelfDoWhy(why('no_agent', 'over_budget'), 62_500_000n, '50000000'), /Even the largest budget Rook takes, 50\.00 USDC, is too small to hire agents for those\.$/);
  assert.match(allSelfDoWhy(why('over_budget', 'over_budget'), 1_070_000n, '50000000'), /Draft it again with a budget of about 1\.07 USDC to hire them\.$/);
  // Mixed: both, briefly.
  const mixed = allSelfDoWhy(why('no_agent', 'over_budget'));
  assert.match(mixed, /fits some of these parts/);
  assert.match(mixed, /cost more than this budget allows/);
  // Unknown (an older plan): neutral, neither the market nor the budget is blamed.
  const unknown: Parameters<typeof allSelfDoWhy>[0][] = [why(undefined as unknown as SelfDoReason), [{}, { self_do_reason: 'no_agent' }], []];
  for (const r of unknown) {
    const s = allSelfDoWhy(r);
    assert.doesNotMatch(s, /fits|budget/, s);
  }
});

test('a plan of one part Rook does itself says so of that part, never "these parts" or "them all"', () => {
  // QA: t_2e17e728, one part, read "The agents Rook found for these parts cost more ... so Rook does them all itself".
  const one = allSelfDoWhy([{ self_do_reason: 'over_budget', self_do_need_atomic: '5000000' }], 6_250_000n);
  assert.equal(one, 'The cheapest agent found for this part asks 5.00 USDC, more than this budget has left for it after the reserve, so Rook does it with its own model. A budget of about 6.25 USDC would hire one.');
  assert.equal(allSelfDoWhy(why('no_agent')), 'No agent on the market fits this part, so Rook does it with its own model.');
  assert.equal(allSelfDoWhy(why('rook_edit')), 'Rook makes this change itself now, with no agent fee.');
  for (const s of [one, allSelfDoWhy(why('no_agent')), allSelfDoWhy([{}])]) assert.doesNotMatch(s, /these parts|them all|hire them/, s);
});
