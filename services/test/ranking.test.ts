// Candidate ranking (docs/agentic-system.md 5.2 step 4): agents that keep failing to receive work, the waiting a failed
// try costs, fallbacks priced far above the lead, and candidate lines that never contradict themselves.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSummary } from '../src/shared/types.ts';
import type { ListingDetail } from '../src/market-gateway/index.ts';

const { buildPlan } = await import('../src/planner/plan.ts');
type PlanInput = import('../src/planner/plan.ts').PlanInput;
type DraftSubtask = import('../src/planner/plan.ts').DraftSubtask;
type QuoteResult = import('../src/planner/plan.ts').QuoteResult;
type History = PlanInput['history'];

const RECIPIENT = { network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim' };
const row = (amount: string): QuoteResult =>
  ({ ok: true, row: { scheme: 'exact', network: RECIPIENT.network, asset: RECIPIENT.asset, amount, payTo: RECIPIENT.payTo, maxTimeoutSeconds: 60 } });
const agent = (handle: string, o: Partial<AgentSummary & ListingDetail> = {}): AgentSummary => ({
  handle, name: handle, description: `${handle} agent`, category: null, tags: [], available_now: true,
  listing_status: 'live', payable_with: ['USDC'], sla_seconds: 20, success_rate: 90, delivered_jobs: 10, ...o,
});
const sub = (title: string, o: Partial<DraftSubtask> = {}): DraftSubtask => ({
  title, brief: `${title}\n\nDo it.`, search_terms: [title], self_do_ok: false,
  criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: 'x' } }], ...o,
});
const plan = (agents: AgentSummary[], prices: Record<string, string>, o: Partial<PlanInput> = {}, d = sub('site')) => buildPlan({
  draft: [d], selected: [agents], quotes: Object.fromEntries(Object.entries(prices).map(([h, p]) => [h, row(p)])),
  recipients: [RECIPIENT], budget_atomic: 3_000_000n, reserve_share: 0.2, ...o,
});
const handles = (p: ReturnType<typeof buildPlan>) => p.subtasks[0]?.candidates.map((c) => c.handle);

// ---- #10: agents that keep failing to receive work ----

test('an agent with 2 or more recent stalls is dropped while another candidate is left, with a note naming it', () => {
  // Mainnet: dev-tools-agent stalled on every send and still led every website plan.
  const agents = [agent('dev-tools'), agent('codex'), agent('patchforge')];
  const prices = { 'dev-tools': '80000', codex: '200000', patchforge: '150000' };
  const p = plan(agents, prices, { history: { 'dev-tools': { pass: 0, fail: 0, stalled: 2 }, codex: { pass: 1, fail: 0 } } });
  assert.deepEqual(handles(p), ['patchforge', 'codex']);
  assert.ok(p.notes.includes(`"site": candidate dev-tools dropped: Rook's last 2 jobs to it failed to send or timed out`), p.notes.join('\n'));
  // Stalled agents among themselves: the one with fewer than 2 stays, the others go, whatever their price.
  const mixed = plan(agents, prices, { history: { 'dev-tools': { pass: 0, fail: 0, stalled: 1 }, codex: { pass: 0, fail: 0, stalled: 1 }, patchforge: { pass: 0, fail: 0, stalled: 3 } } });
  assert.deepEqual(handles(mixed), ['dev-tools', 'codex']);
  assert.match(mixed.subtasks[0].candidates[0].rank_reason, /; Rook's last job to this agent failed to send or timed out$/);
  // One stall is a fallback, not a ban: it still goes after the others.
  const once = plan(agents, prices, { history: { 'dev-tools': { pass: 0, fail: 0, stalled: 1 } } });
  assert.deepEqual(handles(once), ['patchforge', 'codex', 'dev-tools']);
  assert.match(once.subtasks[0].candidates[2].rank_reason, /; ranked after the others: 1 recent hire by Rook failed to send or timed out$/);
});

test('when only failing agents are left they stay, and the line says plainly they failed and Rook will likely write the part', () => {
  const history = { 'dev-tools': { pass: 0, fail: 0, stalled: 5 } };
  const writing = plan([agent('dev-tools')], { 'dev-tools': '80000' }, { history }, sub('site', { self_do_ok: true }));
  assert.deepEqual(handles(writing), ['dev-tools']);
  // Seen live: '0.08 USDC / 0.5 pass chance (no record yet) = 0.16 USDC expected; ranked after the others: 5 recent hires
  // by Rook failed to send or timed out', on the only candidate.
  assert.equal(writing.subtasks[0].candidates[0].rank_reason,
    "0.08 USDC / 0.833 pass chance (market 9 of 10) = 0.096 USDC expected; Rook's last 5 jobs to this agent failed to send or timed out, so Rook will likely write this part itself");
  assert.ok(writing.notes.includes(`"site": dev-tools failed to send or timed out on Rook's last jobs and is the only agent found, so Rook will likely write this part itself`), writing.notes.join('\n'));
  // A part only an agent can do: Rook cannot write it, and the line does not say it will.
  const live = plan([agent('dev-tools'), agent('quiet')], { 'dev-tools': '80000', quiet: '90000' }, { history: { ...history, quiet: { pass: 0, fail: 0, stalled: 2 } } });
  assert.deepEqual(handles(live), ['dev-tools', 'quiet']);
  assert.ok(live.subtasks[0].candidates.every((c) => c.rank_reason.endsWith('failed to send or timed out, so this part may not be delivered')));
  assert.ok(live.notes.includes(`"site": dev-tools, quiet failed to send or timed out on Rook's last jobs and are the only agents found, so this part may not be delivered`), live.notes.join('\n'));
});

// ---- #44: candidate lines never contradict themselves ----

test('a line never says "no record yet" beside failed hires, nor "ranked after the others" with none before it', () => {
  const fresh = agent('fresh', { success_rate: null, delivered_jobs: 0 });
  // The only candidate, one stall and no record: no "no record yet", no others to be ranked after.
  const [only] = plan([fresh], { fresh: '80000' }, { history: { fresh: { pass: 0, fail: 0, stalled: 1 } } }).subtasks[0].candidates;
  assert.equal(only.rank_reason, "0.08 USDC / 0.5 pass chance (no finished job yet) = 0.16 USDC expected; Rook's last job to this agent failed to send or timed out");
  // The healthy agent is over budget, so the stalled one leads: nothing is before it.
  const p = plan([agent('good', { success_rate: 100, delivered_jobs: 50 }), fresh], { good: '900000', fresh: '80000' },
    { budget_atomic: 1_000_000n, history: { fresh: { pass: 0, fail: 0, stalled: 1 } } });
  assert.deepEqual(handles(p), ['fresh', 'good']);
  assert.doesNotMatch(p.subtasks[0].candidates[0].rank_reason, /ranked after/);
  // No record at all and no stall: as before.
  assert.equal(plan([fresh], { fresh: '80000' }).subtasks[0].candidates[0].rank_reason, '0.08 USDC / 0.5 pass chance (no record yet) = 0.16 USDC expected');
  // Market jobs with no pass rate: they are a record of delivering, not "no record yet".
  const [busy] = plan([agent('busy', { success_rate: null, delivered_jobs: 30 })], { busy: '100000' }).subtasks[0].candidates;
  assert.equal(busy.rank_reason, '0.10 USDC / 0.5 pass chance (30 market jobs with no pass rate) = 0.20 USDC expected');
});

// ---- #34: no-show risk and time ----

test('an agent that never delivered anywhere does not lead a proven one only to save a few cents', () => {
  // Live, t_174f2180 s2: o17-crypto-intelligence-v (0.05, no record, 2 h SLA) led cited-web-research-brief (0.15,
  // market 11 of 11, Rook 7 of 9). One no-show costs Rook's whole 30 min patience to save 0.10 USDC.
  const o17 = agent('o17-crypto', { success_rate: null, delivered_jobs: 0, sla_seconds: 7200 });
  const cited = agent('cited-research', { success_rate: 100, delivered_jobs: 11, sla_seconds: 3600 });
  const p = plan([o17, cited], { 'o17-crypto': '50000', 'cited-research': '150000' }, { history: { 'cited-research': { pass: 7, fail: 2 } } });
  assert.deepEqual(handles(p), ['cited-research', 'o17-crypto']);
  const [lead, next] = p.subtasks[0].candidates;
  assert.equal(lead.rank_reason, '0.15 USDC / 0.864 pass chance (market 11 of 11, Rook 7 of 9) = 0.173685 USDC expected');
  assert.equal(next.rank_reason, '0.05 USDC / 0.5 pass chance (no record yet) = 0.10 USDC expected; ranked after cited-research: it has delivered no job yet, and a no-show holds the part up to 30 min');
  assert.deepEqual([lead.expected_cost_atomic, next.expected_cost_atomic], ['173685', '100000']); // money per pass, as before
  // Live, t_f56afaec s1: o17-web-research-v (0.05, market 0 of 0) led token-holder-distribution-2 (0.50, 7 of 7, 120 s).
  const holders = agent('holders-2', { success_rate: 100, delivered_jobs: 7, sla_seconds: 120 });
  const web = agent('o17-web', { success_rate: 0, delivered_jobs: 0, sla_seconds: 7200 });
  assert.deepEqual(handles(plan([web, holders], { 'o17-web': '50000', 'holders-2': '500000' })), ['holders-2', 'o17-web']);
  // Saving a whole USDC is worth the risk: the unproven agent leads, and the proven one's line says nothing odd.
  const dear = plan([o17, cited], { 'o17-crypto': '50000', 'cited-research': '1200000' }, { history: { 'cited-research': { pass: 7, fail: 2 } } });
  assert.deepEqual(handles(dear), ['o17-crypto', 'cited-research']);
  assert.doesNotMatch(dear.subtasks[0].candidates[1].rank_reason, /;/);
  // A short SLA makes a no-show cheap in time: Rook gives up on it after its SLA plus the 10 min grace.
  const quick = agent('quick-new', { success_rate: null, delivered_jobs: 0, sla_seconds: 60 });
  assert.deepEqual(handles(plan([quick, cited], { 'quick-new': '50000', 'cited-research': '400000' }, { history: { 'cited-research': { pass: 7, fail: 2 } } })), ['quick-new', 'cited-research']);
  // But a no-show is waited out to the end of that grace, not its SLA alone: a 10 min SLA holds the part 20 min.
  const tenMin = agent('ten-min-new', { success_rate: null, delivered_jobs: 0, sla_seconds: 600 });
  const near = agent('cited-research', { success_rate: 100, delivered_jobs: 11, sla_seconds: 600 });
  const graced = plan([tenMin, near], { 'ten-min-new': '50000', 'cited-research': '220000' }, { history: { 'cited-research': { pass: 7, fail: 2 } } });
  assert.deepEqual(handles(graced), ['cited-research', 'ten-min-new']);
  assert.match(graced.subtasks[0].candidates[1].rank_reason, /; ranked after cited-research: it has delivered no job yet, and a no-show holds the part up to 20 min$/);
});

test("a proven agent's failed tries cost its usual time: the market's median when listed, else its SLA up to Rook's patience", () => {
  // Both pass half the time. 'slow' lists a 1-day SLA, so a failed try holds the part 30 min; 'fast' answers in 2 min.
  const slow = agent('slow', { success_rate: 50, delivered_jobs: 10, sla_seconds: 86_400 });
  const fast = agent('fast', { success_rate: 50, delivered_jobs: 10, sla_seconds: 86_400, response_s: 120 } as any);
  const p = plan([slow, fast], { slow: '100000', fast: '110000' });
  assert.deepEqual(handles(p), ['fast', 'slow']);
  assert.equal(p.subtasks[0].candidates[1].rank_reason, '0.10 USDC / 0.5 pass chance (market 5 of 10) = 0.20 USDC expected; ranked after fast: a failed try of this agent holds the part about 30 min');
  // Equal SLAs: time changes nothing, and money per pass decides (the simulator's pairs keep their cheap-first order).
  const even = plan([agent('pricey'), agent('cheap-low', { success_rate: 50 }), agent('cheap-high', { success_rate: 95, sla_seconds: 45 })],
    { pricey: '300000', 'cheap-low': '150000', 'cheap-high': '150000' });
  assert.deepEqual(handles(even), ['cheap-high', 'cheap-low', 'pricey']);
  assert.ok(even.subtasks[0].candidates.every((c) => !c.rank_reason.includes(';')));
});

// ---- #33: fallbacks priced far above the lead ----

test('a fallback priced over 10 times the lead is dropped from a part Rook can write, kept with a note on one only an agent can do', () => {
  // Live, 10 USDC budget: a 0.02 USDC guide had fallbacks at 5.00 and 8.00, paid from a 9.00 reserve.
  const agents = [agent('cheap', { success_rate: 95, delivered_jobs: 100 }), agent('near', { success_rate: 50 }), agent('far', { success_rate: 99, delivered_jobs: 200 })];
  const prices = { cheap: '20000', near: '150000', far: '5000000' };
  const writing = plan(agents, prices, { budget_atomic: 10_000_000n }, sub('guide', { self_do_ok: true }));
  assert.deepEqual(handles(writing), ['cheap', 'near']); // 7.5 times: kept
  assert.ok(writing.notes.includes('"guide": candidate far dropped: its price, 5.00 USDC, is more than 10 times the 0.02 USDC of the agent hired first, and Rook writes this part itself if the cheaper agents fail'), writing.notes.join('\n'));
  assert.equal(writing.notes.filter((n) => n.includes('10 times')).length, 1);
  const deploy = plan(agents, prices, { budget_atomic: 10_000_000n }, sub('deploy'));
  assert.deepEqual(handles(deploy), ['cheap', 'near', 'far']);
  assert.ok(deploy.notes.includes('"deploy": if the agents before it fail, far may be hired at 5.00 USDC, more than 10 times the 0.02 USDC of the agent hired first, paid from the reserve: only an agent can do this part'), deploy.notes.join('\n'));
  // The cap is never sized for the dropped one: 2 x 0.02 covers 'near' up to 0.04 only, as before.
  assert.equal(writing.subtasks[0].cap_atomic, '40000');
  // One the reserve can never pay is dropped as before, and gets no "may be hired" note.
  const small = plan(agents, prices, { budget_atomic: 1_000_000n }, sub('deploy'));
  assert.deepEqual(handles(small), ['cheap', 'near']);
  assert.ok(!small.notes.some((n) => n.includes('may be hired')), small.notes.join('\n'));
});

test('sweep: dropped stalls, far fallbacks and the wait never break the plan: the lead fits, caps are covered, lines name only listed agents', () => {
  let seed = 23;
  const rnd = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
  for (let i = 0; i < 300; i++) {
    const agents = [0, 1, 2, 3].map((k) => agent(`x${k}`, { success_rate: rnd(3) ? rnd(101) : null, delivered_jobs: rnd(3) ? rnd(300) : 0, sla_seconds: [20, 600, 7200, 86_400][rnd(4)], ...(rnd(2) ? { response_s: 1 + rnd(900) } : {}) } as any));
    const prices = Object.fromEntries(agents.map((a) => [a.handle, String(1000 + rnd(3_000_000))]));
    const history: History = Object.fromEntries(agents.filter(() => rnd(3) === 0).map((a) => [a.handle, { pass: rnd(3), fail: rnd(3), stalled: rnd(4) }]));
    const selfDoOk = !!rnd(2);
    const p = plan(agents, prices, { history, budget_atomic: BigInt(500_000 + rnd(4_000_000)) }, sub('t', { self_do_ok: selfDoOk }));
    const s = p.subtasks[0];
    if (!s || s.self_do) continue;
    const listed = s.candidates.map((c) => c.handle), reserve = BigInt(p.budget.reserve_atomic), lead = BigInt(s.candidates[0].price_atomic);
    const stalls = (h: string) => history?.[h]?.stalled ?? 0;
    assert.ok(BigInt(s.cap_atomic) >= lead, `case ${i}`);
    assert.ok(s.candidates.every((c) => BigInt(c.price_atomic) <= BigInt(s.cap_atomic) + reserve), `case ${i}`);
    if (listed.some((h) => stalls(h) < 2)) assert.ok(listed.every((h) => stalls(h) < 2), `case ${i}: a failing agent kept beside a working one`);
    if (selfDoOk) assert.ok(s.candidates.every((c) => BigInt(c.price_atomic) <= 10n * lead), `case ${i}: a far fallback on a part Rook can write`);
    for (const c of s.candidates) {
      for (const m of c.rank_reason.matchAll(/ranked after ([\w-]+)(?: and ([\w-]+))?/g)) {
        if (m[1] === 'the') continue;
        for (const h of [m[1], m[2]].filter(Boolean)) assert.ok(listed.indexOf(h) >= 0 && listed.indexOf(h) < listed.indexOf(c.handle), `case ${i}: ${c.rank_reason}`);
      }
      if (/ranked after the others/.test(c.rank_reason)) assert.ok(listed.indexOf(c.handle) > 0, `case ${i}`);
      if (stalls(c.handle) > 0) assert.doesNotMatch(c.rank_reason, /no record yet/, `case ${i}`);
    }
  }
});
