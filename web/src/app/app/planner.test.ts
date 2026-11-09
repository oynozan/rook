// The planner's reports in plain words. Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allSelfDoWhy, plannerReason, selfDoWhy } from './planner';

test("a planner failure reads in plain words, never the services' raw text", () => {
  // The strings the orchestrator stores (services/src/orchestrator/index.ts: "planner: " + the planner's error).
  const plain: [string, RegExp][] = [
    ['planner: fetch failed', /^Rook's planner could not be reached/],
    ['planner: planner ended without a plan', /^Rook's planner could not be reached/],
    ['planner: market gateway search failed: fetch failed', /^The NEAR AI market could not be reached/],
    ['planner: market gateway search failed: GET http://127.0.0.1:7102/search?q=holders -> 502', /^The NEAR AI market could not be reached/],
    ['planner: market gateway search failed: market search unreachable: fetch failed', /^The NEAR AI market could not be reached/],
    ['planner: market gateway x402 failed: GET http://127.0.0.1:7102/x402 -> 502', /^The NEAR AI market could not be reached/],
    ['planner: planner LLM failed: NEAR AI 503 for plan.draft: <html><body>Service Unavailable</body></html>', /^The planning model is busy/],
    ['planner: planner LLM failed: NEAR AI 429 for plan.select: {"error":"rate limited"}', /^The planning model is busy/],
    ['planner: planner LLM failed: fetch failed', /^The planning model is busy or out of reach/],
    ['planner: planner LLM failed: LLM plan.draft returned invalid JSON twice: [ { "origin": "array", "code": "too_big", "maximum": 3, "path": [ "subtasks", 2, "search_terms" ] } ]', /^The planning model gave an answer Rook couldn't use/],
    ['planner: planner LLM failed: no JSON object in model output', /^The planning model gave an answer Rook couldn't use/],
    ['planner: planner LLM failed: NEAR AI 402 for plan.draft: {"error":{"type":"no_limit_configured"}}', /^NEAR AI has no credits/],
    ['planner: planner LLM failed: NEAR AI 401 for plan.draft: {"error":"invalid api key"}', /^NEAR AI rejected Rook's API key/],
    ['planner: planner LLM failed: LLM cost guard: 1.0200 USD spent in the last 24 h (0.0000 in flight), limit ROOK_LLM_MAX_USD=1 per day', /daily spending limit/],
    // Anything else internal gets the plain fallback, never the raw text.
    ['planner: [ { "code": "invalid_type", "path": [ "prompt" ] } ]', /^Rook's planner hit a problem/],
    ["planner: Cannot read properties of undefined (reading 'handle')", /^Rook's planner hit a problem/],
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
});

test('a part Rook does itself says the true reason: no fitting agent, or a budget too small for the agents found', () => {
  assert.match(selfDoWhy('no_agent'), /^No agent on the market fits this part/);
  assert.match(selfDoWhy('over_budget'), /cost more than this budget allows.*A larger budget would hire one\.$/);
  // Older plans don't say: no reason is claimed.
  assert.equal(selfDoWhy(undefined), 'No agent is hired: Rook does this part with its own model.');
});

test('a plan Rook does all by itself blames the market or the budget only when that is the reason', () => {
  assert.match(allSelfDoWhy(['no_agent', 'no_agent']), /^No agent on the market fits these parts/);
  const over = allSelfDoWhy(['over_budget']);
  assert.match(over, /cost more than this budget allows/);
  assert.match(over, /larger budget/);
  assert.doesNotMatch(over, /No agent on the market fits/);
  // Mixed: both, briefly.
  const mixed = allSelfDoWhy(['no_agent', 'over_budget']);
  assert.match(mixed, /fits some of these parts/);
  assert.match(mixed, /cost more than this budget allows/);
  // Unknown (an older plan): neutral, neither the market nor the budget is blamed.
  const unknown: Parameters<typeof allSelfDoWhy>[0][] = [[undefined], [undefined, 'no_agent'], []];
  for (const r of unknown) {
    const s = allSelfDoWhy(r);
    assert.doesNotMatch(s, /fits|budget/, s);
  }
});
