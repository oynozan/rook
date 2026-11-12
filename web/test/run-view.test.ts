// What each part of a run is doing now, and the run's one-line status, from the events and the snapshot. Modelled on the
// mainnet run of "make me a portfolio websites like oynozan.com" (t_c08f6e29). Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nowLine, partViews, patienceS, phaseOf, phaseWords, preview, span, type Clock } from '@/lib/run-view';
import type { Candidate, HireView, PlanView, RookEvent, SubtaskView } from '@/lib/server/orchestrator';

const T0 = Date.parse('2026-11-10T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const clock = (s: number): Clock => ({ now: T0 + s * 1000, time: (ms) => new Date(ms).toISOString().slice(11, 16) });
let seq = 0;
const ev = (s: number, type: string, subtask_id: string, data: object = {}): RookEvent => ({ seq: ++seq, ts: at(s), type, subtask_id, data });
const cand = (handle: string, sla_seconds: number): Candidate => ({ handle, name: handle, description: '', price_atomic: '80000', sla_seconds, success_rate: null, delivered_jobs: 0 });
const sub = (id: string, title: string, candidates: Candidate[], self_do = false): PlanView['subtasks'][number] => ({
  id, title, brief: `Brief for ${title}`, cap_atomic: '100000', self_do, criteria: [], candidates,
});
const plan: PlanView = {
  subtasks: [
    sub('s1', 'Design brief', [cand('taifoon-creative', 600)]),
    sub('s2', 'Build one-page portfolio website', [cand('dev-tools-agent', 1800), cand('codex-engineer-01', 3600)]),
    sub('s3', 'Write portfolio copy', [cand('taifoon-creative', 600), cand('quill-writer', 900)]),
  ],
  dropped: [], budget: { reserve_atomic: '0', allocated_atomic: '300000' },
};
const s2 = plan.subtasks[1];
const words = (events: RookEvent[], s: number, hires: HireView[] = []) => phaseWords(phaseOf(s2, events, hires).phase, clock(s), s2.title);

test('Rook waits on a hire for its SLA plus 10 minutes, at most 12 minutes', () => {
  assert.equal(patienceS(60), 660);
  assert.equal(patienceS(600), 720);
  assert.equal(patienceS(3600), 720);
  assert.equal(patienceS(0), 600);
});

test('the status says what Rook is doing on a part: its price, its send, the wait with time used, never "lining up" meanwhile', () => {
  seq = 0;
  const events = [ev(0, 'subtask_status', 's2', { from: 'funded', to: 'quoting' })];
  // Quoting the plan's first candidate, which no event names yet.
  assert.deepEqual(words(events, 1).line, { state: 'researching', label: "Getting dev-tools-agent's price" });
  events.push(ev(2, 'quote', 's2', { agent_handle: 'dev-tools-agent' }));
  assert.equal(words(events, 3).line?.label, 'Sending the job to dev-tools-agent');
  // Its paid send failed (-32603): on to the next candidate, by name.
  events.push(ev(4, 'ledger', 's2', { op: 'release', agent_handle: 'dev-tools-agent', settled: false }));
  events.push(ev(4, 'quote_rejected', 's2', { agent_handle: 'dev-tools-agent', reason: 'send failed: -32603 internal error' }));
  assert.equal(words(events, 5).line?.label, "Getting codex-engineer-01's price");
  events.push(ev(6, 'quote', 's2', { agent_handle: 'codex-engineer-01' }));
  events.push(ev(60, 'hire_sent', 's2', { agent_handle: 'codex-engineer-01', hire_id: 'h2' }));
  events.push(ev(61, 'subtask_status', 's2', { from: 'quoting', to: 'working' }));
  events.push(ev(62, 'a2a_state', 's2', { agent_handle: 'codex-engineer-01', hire_id: 'h2', state: 'SUBMITTED' }));
  // 5 minutes in, of the 12 Rook gives it (SLA 1 h, capped). The snapshot's started_at is when it began.
  assert.deepEqual(words(events, 60 + 5 * 60 + 30).line, { state: 'analyzing', label: 'Waiting on codex-engineer-01', detail: '5 of 12 min' });
  assert.equal(words(events, 5 * 60, [{ id: 'h2', agent_handle: 'codex-engineer-01', deliverable_text: null, started_at: at(0) }]).line?.detail, '5 of 12 min');
  assert.equal(words(events, 70).status, 'codex-engineer-01 is working on it');
  // Past its time: Rook cancels it and takes one last look.
  assert.deepEqual(words(events, 60 + 12 * 60).line, { state: 'analyzing', label: 'Giving up on codex-engineer-01', detail: 'nothing in 12 min' });
  // Timed out: "Moving on" until its payment is released, however long that takes on NEAR (13 minutes on mainnet).
  events.push(ev(60 + 12 * 60 + 5, 'a2a_state', 's2', { agent_handle: 'codex-engineer-01', hire_id: 'h2', state: 'TIMEOUT' }));
  assert.equal(words(events, 60 + 25 * 60).line?.label, 'Moving on from codex-engineer-01');
  events.push(ev(60 + 26 * 60, 'ledger', 's2', { op: 'release', agent_handle: 'codex-engineer-01', settled: false }));
  // Every candidate tried: nothing specific is known until Rook says what it does next.
  assert.deepEqual(words(events, 60 + 26 * 60), { status: 'Finding the next agent', line: null });
  // Asked again after the market said "no reachable backend": at what time, in the reader's zone.
  events.push(ev(3600, 'error', 's2', { kind: 'unreachable_retry', agent_handle: 'dev-tools-agent', message: 'x' }));
  assert.equal(words(events, 3610).line?.label, 'Asking dev-tools-agent again at 13:03');
  assert.equal(words(events, 3790).line?.label, 'Asking dev-tools-agent again');
  events.push(ev(3790, 'quote', 's2', { agent_handle: 'dev-tools-agent' }));
  events.push(ev(3791, 'hire_sent', 's2', { agent_handle: 'dev-tools-agent', hire_id: 'h3' }));
  events.push(ev(3900, 'a2a_state', 's2', { agent_handle: 'dev-tools-agent', hire_id: 'h3', state: 'COMPLETED' }));
  assert.equal(words(events, 3901).line?.label, "Settling dev-tools-agent's payment");
  events.push(ev(3902, 'subtask_status', 's2', { from: 'working', to: 'evaluating' }));
  assert.equal(words(events, 3903).line?.label, "Checking dev-tools-agent's work");
  // Failed a check, nobody left: Rook writes it itself.
  events.push(ev(3910, 'evaluation', 's2', { agent_handle: 'dev-tools-agent', verdict: 'fail' }));
  events.push(ev(3911, 'error', 's2', { kind: 'rook_writes', message: 'x' }));
  events.push(ev(3911, 'subtask_status', 's2', { from: 'quoting', to: 'working' }));
  assert.deepEqual(words(events, 3912).line, { state: 'writing', label: 'Rook is writing', detail: s2.title });
  events.push(ev(3950, 'subtask_status', 's2', { from: 'working', to: 'evaluating' }));
  assert.equal(words(events, 3951).line?.label, "Checking Rook's own work");
});

test('a part given up on is done: the run never says it waits on its agent', () => {
  seq = 0;
  const events = [
    ev(0, 'hire_sent', 's2', { agent_handle: 'codex-engineer-01', hire_id: 'h2' }),
    ev(10, 'error', 's2', { kind: 'abandoned', message: 's2 abandoned: x' }),
    ev(10, 'subtask_status', 's2', { from: 'working', to: 'abandoned' }),
  ];
  assert.deepEqual(words(events, 20), { status: "Couldn't be done", line: null });
});

test('the run status line: the part that moved last, how many others are under way, null between hires', () => {
  seq = 0;
  const events = [
    ev(0, 'hire_sent', 's1', { agent_handle: 'taifoon-creative', hire_id: 'h1' }),
    ev(5, 'hire_sent', 's2', { agent_handle: 'codex-engineer-01', hire_id: 'h2' }),
    ev(9, 'subtask_status', 's3', { from: 'funded', to: 'quoting' }),
  ];
  const parts = partViews(plan, undefined, events, clock(65), false);
  assert.deepEqual(nowLine(parts), { state: 'researching', label: "Getting taifoon-creative's price", detail: 'and 2 other parts' });
  // The lone working part: its time used.
  assert.deepEqual(nowLine(partViews(plan, undefined, events.slice(0, 1), clock(65), false)), { state: 'analyzing', label: 'Waiting on taifoon-creative', detail: '1 of 12 min' });
  // Nothing specific anywhere: the page falls back to "Lining up the next hire".
  assert.equal(nowLine(partViews(plan, undefined, [], clock(0), false)), null);
  // A finished task says nothing is under way, whatever its last events were.
  assert.equal(nowLine(partViews(plan, undefined, events, clock(65), true)), null);
});

test('each part: its status, the agent on it now, every agent tried and what came of it, the brief, a passed delivery', () => {
  seq = 0;
  const hires: HireView[] = [
    { id: 'h1', agent_handle: 'dev-tools-agent', deliverable_text: null, state: 'SEND_FAILED', started_at: at(2), ended_at: at(4), amount_atomic: '80000', paid: false },
    { id: 'h2', agent_handle: 'codex-engineer-01', deliverable_text: null, state: 'TIMEOUT', started_at: at(60), ended_at: at(60 + 1805), amount_atomic: '500000', paid: false },
    { id: 'h3', agent_handle: 'dev-tools-agent', deliverable_text: null, state: 'WORKING', started_at: at(3790), ended_at: null, amount_atomic: '80000', paid: false },
  ];
  const events = [
    ev(1, 'quote_rejected', 's2', { agent_handle: 'pricey-agent', reason: 'price rose from 0.10 in the approved plan to 0.15' }),
    ev(4, 'ledger', 's2', { op: 'release', agent_handle: 'dev-tools-agent', settled: false }),
    ev(4, 'quote_rejected', 's2', { agent_handle: 'dev-tools-agent', reason: 'send failed: -32603 internal error' }),
    ev(60, 'hire_sent', 's2', { agent_handle: 'codex-engineer-01', hire_id: 'h2' }),
    ev(1865, 'a2a_state', 's2', { agent_handle: 'codex-engineer-01', hire_id: 'h2', state: 'TIMEOUT' }),
    ev(3790, 'hire_sent', 's2', { agent_handle: 'dev-tools-agent', hire_id: 'h3' }),
    ev(10, 'subtask_status', 's3', { from: 'evaluating', to: 'passed' }),
  ];
  const subtasks: SubtaskView[] = [
    { id: 's2', n: 2, status: 'working', final_outcome: null, hires },
    { id: 's3', n: 3, status: 'passed', final_outcome: 'passed', accepted: { hire_id: 'h9', agent_handle: 'quill-writer' },
      hires: [{ id: 'h9', agent_handle: 'quill-writer', deliverable_text: `Hi, I'm Ozan.\n\n${'word '.repeat(100)}`, state: 'COMPLETED', paid: true, amount_atomic: '20000', verdict: 'pass', started_at: at(0), ended_at: at(9) }] },
  ];
  const [p1, p2, p3] = partViews(plan, subtasks, events, clock(3790 + 125), false);
  assert.equal(p1.status, 'Not started yet');
  // Its brief hasn't gone out yet; the others' has.
  assert.deepEqual([p1.sent, p2.sent, p3.sent], [false, true, true]);
  assert.equal(p1.tone, 'idle');
  assert.equal(p2.status, 'dev-tools-agent is working on it');
  assert.equal(p2.brief, 'Brief for Build one-page portfolio website');
  assert.deepEqual(p2.working, { agent: 'dev-tools-agent', since: T0 + 3790_000, until: T0 + (3790 + 720) * 1000, said: null }); // it said nothing while working
  assert.deepEqual(p2.tried, [
    { key: 'q1', agent: 'pricey-agent', outcome: 'Skipped: its price went up from 0.10 to 0.15 USDC since you approved the plan', tone: 'muted' },
    { key: 'h1', agent: 'dev-tools-agent', outcome: "Couldn't take the job", tone: 'muted', money: 'Not paid' },
    // Timed out, its payment not released yet: it may still land, so it isn't "Not paid" yet.
    { key: 'h2', agent: 'codex-engineer-01', outcome: 'Timed out after 30 min', tone: 'muted', money: 'Quoted 0.50 USDC' },
    // The same agent asked again: its first release doesn't count for this hire.
    { key: 'h3', agent: 'dev-tools-agent', outcome: 'Working on it', tone: 'normal', money: 'Quoted 0.08 USDC' },
  ]);
  assert.equal(p3.status, 'Done. It passed every check');
  assert.equal(p3.tone, 'passed');
  assert.equal(p3.delivered?.by, 'quill-writer');
  assert.ok(p3.delivered!.preview.startsWith("Hi, I'm Ozan. word word"));
  assert.ok(p3.delivered!.preview.length <= 281 && p3.delivered!.preview.endsWith('…'));
  assert.deepEqual(p3.tried, [{ key: 'h9', agent: 'quill-writer', outcome: 'Delivered and passed every check', tone: 'normal', money: 'Paid 0.02 USDC' }]);
  // The task stopped: nothing is under way any more.
  const stopped = partViews(plan, subtasks, events, clock(4000), true);
  assert.equal(stopped[1].status, 'Stopped');
  assert.equal(stopped[1].line, null);
});

test("between snapshots the events tell a hire's state: a hire the snapshot still has as being sent, or doesn't have yet", () => {
  seq = 0;
  // The snapshot was loaded right after the payment was authorized, before the job went out.
  const subtasks: SubtaskView[] = [{ id: 's2', n: 2, status: 'quoting', hires: [
    { id: 'h2', agent_handle: 'codex-engineer-01', deliverable_text: null, state: 'SENDING', started_at: at(0), ended_at: null, amount_atomic: '500000', paid: false },
  ] }];
  const events = [
    ev(1, 'hire_sent', 's2', { agent_handle: 'codex-engineer-01', hire_id: 'h2', amount_atomic: '500000' }),
    ev(1800, 'a2a_state', 's2', { agent_handle: 'codex-engineer-01', hire_id: 'h2', state: 'TIMEOUT' }),
    ev(1900, 'hire_sent', 's2', { agent_handle: 'dev-tools-agent', hire_id: 'h3', amount_atomic: '80000' }),
  ];
  assert.deepEqual(partViews(plan, subtasks, events, clock(1910), false)[1].tried, [
    { key: 'h2', agent: 'codex-engineer-01', outcome: 'Timed out after 30 min', tone: 'muted', money: 'Quoted 0.50 USDC' },
    { key: 'h3', agent: 'dev-tools-agent', outcome: 'Working on it', tone: 'normal', money: 'Quoted 0.08 USDC' },
  ]);
});

test('spans and previews read as people say them', () => {
  assert.equal(span(45_000), '45 s');
  assert.equal(span(12 * 60_000 + 5_000), '12 min 5 s');
  assert.equal(span(30 * 60_000), '30 min');
  assert.equal(span(63 * 60_000), '1 h 3 min');
  assert.equal(span(-5), '0 s');
  assert.equal(preview('  short\n\ntext '), 'short text');
  assert.equal(preview('aaaa bbbb cccc', 10), 'aaaa bbbb…');
  // A delivered web page previews as its note, its code as a count (mainnet: the preview began "# index.html ```html <!DOCTYPE").
  assert.equal(preview('# index.html\n\n```html\n<!DOCTYPE html>\n<html>\n</html>\n```\n\nA dark portfolio.'), 'index.html (html, 3 lines) A dark portfolio.');
});

test('the run header says when a part delivered nothing, never just "Finished."', async () => {
  const { runHeadline } = await import('@/lib/run-view');
  const done = { live: false, status: 'closed', report: true, missing: [] as string[], parts: 3 };
  assert.equal(runHeadline({ ...done, live: true }), 'Running.');
  assert.equal(runHeadline({ ...done, status: 'killed' }), 'Stopped.');
  assert.equal(runHeadline({ ...done, status: 'failed', report: false }), 'This run hit a problem.');
  assert.equal(runHeadline({ ...done, status: 'failed' }), 'Finished.'); // the work finished, only the refund hit a problem
  assert.equal(runHeadline(done), 'Finished.');
  // t_c08f6e29: the website part couldn't be done, and the header said "Finished.".
  assert.equal(runHeadline({ ...done, missing: ['Build one-page portfolio website'] }), 'Finished without “Build one-page portfolio website”.');
  assert.equal(runHeadline({ ...done, missing: ['A', 'B'] }), 'Finished without 2 of its 3 parts.');
  assert.equal(runHeadline({ ...done, missing: ['A', 'B', 'C'] }), 'Finished, but no part was delivered.');
  assert.equal(runHeadline({ ...done, parts: 1, missing: ['Build the site'] }), 'Finished without “Build the site”: nothing was delivered.');
});

test("what a working agent says shows under its part, newest first; an agent that declined reads as such", async () => {
  const { saidBy } = await import('@/lib/run-view');
  const events: RookEvent[] = [
    { seq: 1, ts: at(10), type: 'agent_message', subtask_id: 's1', data: { agent_handle: 'quill-writer', text: 'Drafting section 1' } },
    { seq: 2, ts: at(20), type: 'agent_message', subtask_id: 's2', data: { agent_handle: 'quill-writer', text: 'Other part' } },
    { seq: 3, ts: at(30), type: 'agent_message', subtask_id: 's1', data: { agent_handle: 'quill-writer', text: 'Drafting section 2' } },
  ];
  assert.equal(saidBy(events, 's1', 'quill-writer'), 'Drafting section 2');
  assert.equal(saidBy(events, 's1', 'web-assets'), null);
  assert.equal(saidBy([], 's1', 'quill-writer'), null);
});
