// The planner's reports in plain words. Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allSelfDoWhy, selfDoWhy } from './planner';

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
