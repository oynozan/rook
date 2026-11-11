// What the plan card says before any money moves: the most each part and the plan can cost, what happens if no agent
// delivers, the files a part edits, how long agents get, and the notes a user needs. Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costLabel, editLine, fallbackLine, partMost, planCost, planNotes, reserveSpent, spendLabel, timeLine } from '@/lib/plan-view';
import { allSelfDoWhy, selfDoWhy } from '@/lib/planner';
import type { Candidate, LedgerSub, PlanView } from '@/lib/server/orchestrator';

const agent = (handle: string, price: string, sla = 600): Candidate =>
  ({ handle, name: handle, description: '', price_atomic: price, sla_seconds: sla, success_rate: null, delivered_jobs: 0 });
const part = (id: string, o: Partial<PlanView['subtasks'][number]> = {}): PlanView['subtasks'][number] =>
  ({ id, title: `Part ${id}`, cap_atomic: '0', self_do: false, criteria: [], candidates: [], ...o });

test('a part costs at most its dearest agents, each paid once and at most three, within its cap and the reserve', () => {
  // t_c08f6e29: approved at "Cap 0.02", each part cost 0.25 once the fallback was hired.
  const cheapLead = part('s1', { cap_atomic: '20000', candidates: [agent('cheap', '20000'), agent('quill', '250000')] });
  assert.equal(partMost(cheapLead, 800_000n), 270_000n);
  assert.deepEqual(costLabel(cheapLead, 800_000n), { label: 'Up to 0.27', line: 'Costs at most 0.27 USDC: its cap is 0.02, and the reserve pays more if Rook hires the next agent.' });
  // The reserve caps it: 0.02 + 0.10.
  assert.equal(partMost(cheapLead, 100_000n), 120_000n);
  // One agent: its price, the cap. t_d5c93c09 said "up to 0.90 more from the reserve" with no agent dearer than the cap.
  const one = part('s1', { cap_atomic: '80000', candidates: [agent('dev-tools-agent', '80000', 86_400)] });
  assert.equal(partMost(one, 900_000n), 80_000n);
  assert.deepEqual(costLabel(one, 900_000n), { label: 'Cap 0.08', line: 'Costs at most 0.08 USDC, its cap.' });
  // At most three paid deliveries: the dearest three of five.
  const five = part('s1', { cap_atomic: '100000', candidates: ['1', '2', '3', '4', '5'].map((n) => agent(`a${n}`, `${n}00000`)) });
  assert.equal(partMost(five, 10_000_000n), 1_200_000n);
  // Rook's own part costs nothing.
  assert.deepEqual(costLabel(part('s2', { self_do: true, self_do_reason: 'no_agent' }), 1n), { label: 'Rook does this', line: null });

  const plan = { subtasks: [cheapLead, one, part('s3', { self_do: true })], budget: { reserve_atomic: '200000', allocated_atomic: '100000' } };
  assert.deepEqual(planCost(plan), { caps: 100_000n, most: 300_000n }); // 0.22 + 0.08 is past the caps plus the reserve
  assert.deepEqual(planCost({ subtasks: [one], budget: { reserve_atomic: '900000', allocated_atomic: '80000' } }), { caps: 80_000n, most: 80_000n });
});

test('each row says what happens if no agent delivers, which files it edits, and how long agents get', () => {
  assert.equal(fallbackLine({ self_do: false, self_do_ok: true }), 'If no agent delivers, Rook writes this part itself.');
  assert.equal(fallbackLine({ self_do: false, self_do_ok: false }), "If no agent delivers, this part is left out. What isn't spent comes back to you.");
  assert.equal(fallbackLine({ self_do: false }), "If no agent delivers, this part is left out. What isn't spent comes back to you."); // older plans
  assert.equal(fallbackLine({ self_do: true }), null);

  assert.equal(editLine({ inputs: ['index.html', 'app/page.tsx'] }), 'Edits index.html, app/page.tsx from the work above.');
  assert.equal(editLine({ inputs: ['a', 'b', 'c', 'd', 'e'] }), 'Edits a, b, c and 2 more from the work above.');
  assert.equal(editLine({}), null);
  assert.equal(editLine({ inputs: [] }), null);

  // An agent promising 24 h still gets 30 min from Rook (its SLA plus 10 min, at most 30), and every candidate is tried.
  assert.equal(timeLine({ self_do: false, candidates: [agent('a', '1', 86_400)] }), 'The agent gets up to 30 min to deliver.');
  assert.equal(timeLine({ self_do: false, candidates: [agent('a', '1', 300), agent('b', '1', 600), agent('c', '1', 60)] }), 'Each agent gets up to 20 min to deliver; up to 3 agents are tried.');
  assert.equal(timeLine({ self_do: true, candidates: [] }), null);
});

test("Rook's own edit of delivered work says it is done now, with no agent fee", () => {
  assert.equal(selfDoWhy({ self_do_reason: 'rook_edit' }), 'Rook makes this change itself now, with no agent fee.');
  assert.equal(allSelfDoWhy(['rook_edit']), 'Rook makes this change itself now, with no agent fee.');
  assert.equal(allSelfDoWhy(['rook_edit', 'rook_edit']), 'Rook makes these changes itself now, with no agent fee.');
});

test('the notes a user needs show in plain lines; the planner’s own notes stay out', () => {
  const plan = {
    subtasks: [part('s1', { title: 'Build the portfolio site', cap_atomic: '80000' })],
    budget: { reserve_atomic: '200000', allocated_atomic: '80000' },
    notes: [
      'Rook read oynozan.com before planning ("Ozan Andaç"), so the plan describes what the page shows.',
      'Rook could not open github.com/oynozan/sona: it answered HTTP 404. The plan asks the agent to look at it instead of describing it.',
      'Rook could not open blog.oynozan.com: its name does not resolve. The plan asks the agent to look at it instead of describing it.',
      '"Build the portfolio site": candidate ceoclaw-web dropped, price 6000000 exceeds cap + reserve',
      '"Build the portfolio site": candidate milestone-dev-sprint dropped, price 19000000 exceeds cap + reserve',
      '"Build the portfolio site": quote from shdwtech-build dropped: payment window 9000 s is not from 1 to 3600 s (ROOK_MAX_PAYMENT_TIMEOUT_S)',
      'criterion s1.c2 removed: invalid regex',
      'the draft set a budget of 5.00 USDC, but the message names no such budget: planned at the budget sent',
    ],
  };
  assert.deepEqual(planNotes(plan), [
    { text: 'Rook read oynozan.com before planning ("Ozan Andaç"), so the plan describes what the page shows.', tone: 'normal' },
    { text: 'Rook could not open github.com/oynozan/sona: it answered HTTP 404.', tone: 'alert' },
    { text: 'Rook could not open blog.oynozan.com: its name does not resolve.', tone: 'alert' },
    // The other caps stay: 6.00 as this part's cap needs 6.00 left after the 20% reserve.
    { text: '2 more agents for “Build the portfolio site” ask 6.00 to 19.00 USDC, more than this budget can pay. A budget of about 7.50 USDC would hire the cheapest.', tone: 'normal' },
  ]);
  // Past the largest budget Rook takes, it says so instead of naming one.
  const one = { ...plan, notes: [plan.notes[4]] };
  assert.deepEqual(planNotes(one, '10000000'), [{ text: 'Another agent for “Build the portfolio site” asks 19.00 USDC, more than this budget can pay. Even the largest budget Rook takes, 10.00 USDC, is too small to hire it.', tone: 'normal' }]);
  assert.deepEqual(planNotes({ ...plan, notes: undefined }), []);
});

test("a run's money adds up: only what a part spent beyond its cap came from the reserve", () => {
  const sub = (n: number, cap: string, spent: string, topped = '0'): LedgerSub =>
    ({ n, cap_atomic: cap, balance_atomic: '0', topped_up_atomic: topped, spent_atomic: spent, returned_atomic: null });
  // t_c08f6e29: two parts at a 0.02 cap spent 0.25 each; a part topped up by 0.34 that spent nothing used none of it.
  const subs = [sub(1, '20000', '250000', '230000'), sub(2, '20000', '250000', '230000'), sub(3, '160000', '0', '340000')];
  assert.equal(reserveSpent(subs), 460_000n);
  assert.equal(reserveSpent(undefined), 0n);
  assert.equal(spendLabel(subs[0]), '0.25: 0.02 cap + 0.23 reserve');
  assert.equal(spendLabel(subs[2]), '0.00 of 0.16');
});
