// The composer's checks: the budget as people type it, the orchestrator's limits, and its refusals in plain words.
// Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetLimitError, checkDraft, draftRefusal, followUpRefusal, formatUsdc, parseBudget, PROMPT_MAX } from './draft';

test('formatUsdc: at least 2 decimals, up to the 6 USDC has', () => {
  assert.equal(formatUsdc(50_000_000n), '50.00');
  assert.equal(formatUsdc('1500000'), '1.50');
  assert.equal(formatUsdc(125_000n), '0.125');
  assert.equal(formatUsdc(1_000_001n), '1.000001');
  assert.equal(formatUsdc(0n), '0.00');
});

test('parseBudget: a dot or a comma as the decimal point, up to 6 decimals', () => {
  const ok = (s: string) => { const b = parseBudget(s); assert.ok(b.ok, s); return [b.atomic, b.usdc]; };
  assert.deepEqual(ok('3.00'), [3_000_000n, '3.00']);
  assert.deepEqual(ok(' 1,5 '), [1_500_000n, '1.50']);
  assert.deepEqual(ok('0,000001'), [1n, '0.000001']);
  assert.deepEqual(ok('2.999'), [2_999_000n, '2.999']);
  assert.deepEqual(ok('3.'), [3_000_000n, '3.00']);
  assert.deepEqual(ok('.5'), [500_000n, '0.50']);
  assert.deepEqual(ok('007'), [7_000_000n, '7.00']);
});

test('parseBudget: each problem gets its own message, never "above 0" for an amount above 0', () => {
  const error = (s: string) => { const b = parseBudget(s); assert.ok(!b.ok, s); return b.error; };
  assert.equal(error('1.5000001'), 'Use at most 6 decimals.');
  assert.equal(error('1,0000001'), 'Use at most 6 decimals.');
  assert.equal(error('0'), 'Enter an amount above 0.');
  assert.equal(error('0,00'), 'Enter an amount above 0.');
  assert.equal(error('-2'), 'Enter an amount above 0.');
  assert.equal(error(''), 'Enter a budget, like 3.00.');
  for (const s of ['abc', '1e-6', '$3', '1,000.50', '1.2.3', '.', '-', '3 USDC']) assert.equal(error(s), 'Enter the budget as a number, like 3.00.', s);
});

test('budgetLimitError: the orchestrator maximum and the contract minimum, when known', () => {
  const limits = { min_budget_atomic: '100000', max_budget_atomic: '50000000' };
  assert.equal(budgetLimitError(50_000_000n, limits), null);
  assert.equal(budgetLimitError(50_000_001n, limits), 'The largest budget is 50.00 USDC.');
  assert.equal(budgetLimitError(99_999n, limits), 'The smallest budget is 0.10 USDC.');
  assert.equal(budgetLimitError(100_000n, limits), null);
  assert.equal(budgetLimitError(999_000_000n, null), null); // services unreachable: the action checks again, and so does Rook
  assert.equal(budgetLimitError(999_000_000n, { min_budget_atomic: null }), null); // an older orchestrator sends no maximum
});

test('checkDraft: the trimmed prompt and the budget in the form the orchestrator reads, or a message per field', () => {
  assert.deepEqual(checkDraft({ prompt: '  Due diligence  ', budget: '1,5' }), { ok: true, prompt: 'Due diligence', usdc: '1.50' });
  assert.deepEqual(checkDraft({ prompt: ' ', budget: 'x' }), { ok: false, prompt: 'Describe the task first.', budget: 'Enter the budget as a number, like 3.00.' });
  assert.deepEqual(checkDraft({ prompt: 'p', budget: '60' }, { max_budget_atomic: '50000000' }), { ok: false, budget: 'The largest budget is 50.00 USDC.' });
  const long = checkDraft({ prompt: 'x'.repeat(PROMPT_MAX + 1), budget: '3' });
  assert.deepEqual(long, { ok: false, prompt: `Keep the task under ${PROMPT_MAX} characters. This one has ${PROMPT_MAX + 1}.` });
});

test('draftRefusal: the orchestrator 400s about the budget or the prompt land on that field', () => {
  assert.deepEqual(draftRefusal("budget 100.00 USDC is above this Rook's limit of 50.00 USDC (ROOK_MAX_BUDGET_USDC)"), { budget: 'The largest budget is 50.00 USDC.' });
  assert.deepEqual(draftRefusal("budget 0.05 USDC is below the contract's minimum of 0.10 USDC"), { budget: 'The smallest budget is 0.10 USDC.' });
  assert.deepEqual(draftRefusal('prompt is 4001 characters; the limit is 4000'), { prompt: 'Keep the task under 4000 characters. This one has 4001.' });
  assert.deepEqual(draftRefusal('budget_usdc must be positive'), { budget: "Rook can't use this budget. Enter an amount like 3.00." });
  assert.deepEqual(draftRefusal('invalid USDC amount: 1,5'), { budget: "Rook can't use this budget. Enter an amount like 3.00." });
  assert.equal(draftRefusal('Required'), null);
});

test('followUpRefusal: a message the orchestrator refuses because of the task it follows', () => {
  for (const m of ['Wait for the plan to be ready before sending more.', 'Wait for this run to finish, or stop it, before sending more.',
    'This conversation has a newer message: reload the page and send from there.']) assert.equal(followUpRefusal(409, m), m);
  assert.equal(followUpRefusal(404, 'no task t_1234abcd'), "Rook has no task at this link for the wallet you're signed in with.");
  assert.equal(followUpRefusal(409, 'task t_1 has another owner: a follow-up keeps its owner'), null); // the web always sends the owner
  assert.equal(followUpRefusal(400, 'Wait for it'), null);
});
