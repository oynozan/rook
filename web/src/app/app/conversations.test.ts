// Conversations: how tasks group and order, what the sidebar shows, and what the composer sends and says.
// Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amountsNamed, budgetField, conversationOf, conversations, currentTask, outgoing, placeholderFor, revisedPlan, sameTaskAt, waitReason } from './conversations';
import type { TaskSummary } from './orchestrator';

const task = (id: string, minute: number, o: Partial<TaskSummary> = {}): TaskSummary =>
  ({ id, status: 'closed', prompt: `prompt ${id}`, created_at: `2026-11-09T10:${String(minute).padStart(2, '0')}:00.000Z`, parent_id: null, budget_atomic: '3000000', ...o });
const ids = (ts: TaskSummary[]) => ts.map((t) => t.id);

test('tasks group into conversations by parent, each in message order, the most recently active first', () => {
  const list = [
    task('b2', 30, { parent_id: 'b1' }),
    task('a1', 0),
    task('b1', 10),
    task('a2', 20, { parent_id: 'a1' }),
    task('c1', 25), // before conversations: a conversation of its own
    task('a3', 40, { parent_id: 'a2', status: 'planned' }),
  ];
  const cs = conversations(list);
  assert.deepEqual(cs.map((c) => [c.id, c.title, ids(c.tasks), c.latest.id]), [
    ['a1', 'prompt a1', ['a1', 'a2', 'a3'], 'a3'],
    ['b1', 'prompt b1', ['b1', 'b2'], 'b2'],
    ['c1', 'prompt c1', ['c1'], 'c1'],
  ]);
  assert.deepEqual(ids(conversationOf(list, 'a2')!.tasks), ['a1', 'a2', 'a3']); // any of its tasks finds it
  assert.equal(conversationOf(list, 'zz'), null);
  // Older services send no parent_id: every task is its own conversation, as before.
  assert.deepEqual(conversations([task('x', 1, { parent_id: undefined }), task('y', 2, { parent_id: undefined })]).map((c) => c.id), ['y', 'x']);
});

test('a conversation follows its links, not the clock; a task whose parent is not listed starts one', () => {
  // A message just sent here carries this browser's clock, which can be behind the server's: it still comes last.
  const list = [task('a1', 30), task('a2', 40, { parent_id: 'a1' }), task('a3', 5, { parent_id: 'a2', status: 'draft' })];
  assert.deepEqual(ids(conversationOf(list, 'a3')!.tasks), ['a1', 'a2', 'a3']);
  assert.deepEqual(conversations([task('orphan', 1, { parent_id: 'gone' })]).map((c) => [c.id, ids(c.tasks)]), [['orphan', ['orphan']]]);
});

test('the task a message acts on: the newest that got a plan, whatever its status, above replies that never got one', () => {
  const reply = (id: string, minute: number, parent: string) => task(id, minute, { status: 'failed', has_plan: false, parent_id: parent });
  assert.equal(currentTask([task('a', 1), task('b', 2, { status: 'planned', has_plan: true })]).id, 'b');
  // "go ahead" under a plan fails as not a task; the plan above it is still what a message changes.
  const replied = [task('a', 1, { status: 'planned', has_plan: true }), reply('b', 2, 'a'), reply('c', 3, 'b')];
  assert.equal(currentTask(replied).id, 'a');
  assert.equal(conversations(replied)[0].current.status, 'planned'); // the sidebar says "Plan ready", not "Failed"
  // Then the plan runs from its button: the run is what the sidebar shows, and nothing is sent until it ends.
  const running = [task('a', 1, { status: 'running', has_plan: true }), reply('b', 2, 'a')];
  assert.equal(conversations(running)[0].current.status, 'running');
  assert.equal(placeholderFor(currentTask(running), '1.00'), 'Wait for this run to finish, or stop it, before sending more.');
  // Once it closed, a message follows up on it.
  const closed = [task('a', 1, { status: 'closed', has_plan: true }), reply('b', 2, 'a')];
  assert.equal(conversations(closed)[0].current.id, 'a');
  assert.equal(placeholderFor(currentTask(closed), '3.00'), 'Ask a follow-up, like going deeper on one part');
  // A run that failed or was stopped had a plan: it is the newest, not a reply.
  assert.equal(currentTask([task('a', 1, { status: 'closed', has_plan: true }), task('b', 2, { status: 'failed', has_plan: true })]).id, 'b');
  assert.equal(currentTask([task('a', 1, { status: 'planned', has_plan: true }), task('b', 2, { status: 'killed', has_plan: true })]).id, 'b');
  // Only replies: the newest. Older services send no has_plan, so nothing is skipped.
  assert.equal(currentTask([reply('a', 1, 'x'), reply('b', 2, 'a')]).id, 'b');
  assert.equal(currentTask([task('a', 1, { status: 'planned' }), task('b', 2, { status: 'failed' })]).id, 'b');
});

test('a plan whose revision is still being planned: the one the newest message revises, through replies that never got a plan', () => {
  const plan = task('a', 1, { status: 'planned', has_plan: true });
  assert.equal(revisedPlan([plan, task('b', 2, { status: 'draft', parent_id: 'a' })]), 'a');
  assert.equal(revisedPlan([plan, task('b', 2, { status: 'failed', has_plan: false, parent_id: 'a' }), task('c', 3, { status: 'draft', parent_id: 'b' })]), 'a');
  assert.equal(revisedPlan([plan, task('b', 2, { status: 'planned', has_plan: true, parent_id: 'a' })]), null); // ready: it replaced the plan
  assert.equal(revisedPlan([task('a', 1, { status: 'closed', has_plan: true }), task('b', 2, { status: 'draft', parent_id: 'a' })]), null); // a follow-up
  assert.equal(revisedPlan([task('a', 1, { status: 'draft' })]), null); // a first message revises nothing
});

test('nothing goes while the task it follows is planning or running, in the orchestrator\'s words', () => {
  assert.equal(waitReason('draft'), 'Wait for the plan to be ready before sending more.');
  for (const s of ['approved', 'funded', 'running', 'aggregating']) assert.equal(waitReason(s), 'Wait for this run to finish, or stop it, before sending more.', s);
  for (const s of ['planned', 'closed', 'failed', 'cancelled', 'killed']) assert.equal(waitReason(s), null, s);
  // Closing: the report is written and only the refund is left, so the run has finished and takes a follow-up.
  assert.equal(waitReason('closing'), null);
  assert.equal(waitReason('closing', true), null);
  // The chain ledger: an approved plan waits for its funding, and no run has started.
  assert.equal(waitReason('approved', true), 'Fund or cancel the plan above before sending more.');
  assert.equal(waitReason('running', true), 'Wait for this run to finish, or stop it, before sending more.');
  assert.equal(placeholderFor(task('a', 1, { status: 'approved' }), '3.00', true), 'Fund or cancel the plan above before sending more.');
});

test('a changed budget alone asks for the same task at that budget; typed words go as typed', () => {
  const planned = task('a', 1, { status: 'planned', budget_atomic: '3000000' });
  assert.equal(outgoing('  Skip the market part ', '3.00', planned), 'Skip the market part');
  assert.equal(outgoing('', '1,5', planned), sameTaskAt('1.50'));
  assert.equal(sameTaskAt('1.50'), 'Same task with a budget of 1.50 USDC.');
  assert.equal(outgoing(' ', '3', planned), ''); // the same budget: nothing to send
  assert.equal(outgoing('', 'abc', planned), ''); // the budget field says what is wrong with it
  assert.equal(outgoing('', '1.50', task('b', 1, { budget_atomic: undefined })), ''); // older services: budget unknown
  assert.equal(outgoing('', '1.50', null), '');
});

test("the Budget field follows the conversation's budget, but keeps one the user typed until it is sent", () => {
  assert.equal(budgetField('3.00', undefined, '1500000'), '1.50'); // a conversation opened: its budget
  assert.equal(budgetField('3.00', '3000000', '1000000'), '1.00'); // the plan was made at the total its message named
  assert.equal(budgetField('3', '3000000', '5000000'), '5.00'); // the same amount, typed another way
  // Changed to 1.5, then Rook refused the send for a newer message, which the list now shows: the typed 1.5 stays.
  assert.equal(budgetField('1.5', '3000000', '2000000'), '1.5');
  assert.equal(budgetField('abc', '3000000', '2000000'), 'abc'); // the field says what is wrong with it
  assert.equal(budgetField('1.5', '1500000', '1000000'), '1.00'); // sent at 1.5 and planned at a named 1.00
});

test('amounts a message names as its budget, which the wallet check before drafting may use instead of the Budget field', () => {
  assert.deepEqual(amountsNamed('Make it 1 USDC'), [1_000_000n]);
  assert.deepEqual(amountsNamed('make it $2.5, thanks'), [2_500_000n]);
  assert.deepEqual(amountsNamed('is it possible to reduce budget?'), []);
  assert.deepEqual(amountsNamed('reduce the budget to 1.5'), [1_500_000n]);
  assert.deepEqual(amountsNamed('Cut it to 1 USDC'), [1_000_000n]);
  assert.deepEqual(amountsNamed('Do it for 2 usdc, or for $1,5 if you can'), [2_000_000n, 1_500_000n]);
  assert.deepEqual(amountsNamed('Due diligence on the NEAR token, budget: 5 USDC'), [5_000_000n]);
  assert.deepEqual(amountsNamed('Research it with a budget of $2'), [2_000_000n]);
  assert.deepEqual(amountsNamed(sameTaskAt('1.50')), [1_500_000n]); // what a changed budget alone sends
  assert.deepEqual(amountsNamed('make it 10'), [10_000_000n]);
  assert.deepEqual(amountsNamed('make it $12'), [12_000_000n]);
  assert.deepEqual(amountsNamed('for 10 USDC'), [10_000_000n]);
  assert.deepEqual(amountsNamed('budget: 25'), [25_000_000n]);
  assert.deepEqual(amountsNamed('make it five USDC'), [5_000_000n]);
  assert.deepEqual(amountsNamed('cut it to two dollars'), [2_000_000n]);
  // Numbers and money that aren't a budget: the check stays at the Budget field. Numbers of two or more digits are never
  // cut short ("10 items" once read as 1 USDC).
  for (const m of ['Top 10 holders of NEAR in 2026', 'List tokens under $1', 'Explain a 1 USD fee', 'Plan a marketing budget for 1 week',
    'Make it 2 pages', 'Reduce the list to 5 items', 'A $3 stablecoin depeg: what happened?', 'Reduce the list to 10 items', 'Make it 20 pages',
    'Plan a marketing budget of 10 weeks', 'make it 2.5 pages', 'raise it to 12k', 'make it two sentences']) assert.deepEqual(amountsNamed(m), [], m);
});

test('the placeholder says what a message does there', () => {
  const at = (status: string) => task('a', 1, { status, budget_atomic: '3000000' });
  assert.equal(placeholderFor(at('planned'), '3.00'), 'Change the plan, or ask a follow-up');
  assert.equal(placeholderFor(at('planned'), '1.5'), 'Send to revise the plan at 1.50 USDC, or say what to change');
  assert.equal(placeholderFor(at('closed'), '3.00'), 'Ask a follow-up, like going deeper on one part');
  assert.equal(placeholderFor(at('closed'), '5'), 'Send to plan this task again at 5.00 USDC');
  assert.equal(placeholderFor(at('closing'), '3.00'), 'Ask a follow-up, like going deeper on one part'); // finished, refund on its way
  for (const s of ['failed', 'cancelled', 'killed']) assert.equal(placeholderFor(at(s), '3.00'), 'Change the task, or try it again', s);
  assert.equal(placeholderFor(at('failed'), '10'), 'Send to plan this task again at 10.00 USDC');
  assert.equal(placeholderFor(at('running'), '1'), 'Wait for this run to finish, or stop it, before sending more.');
  assert.equal(placeholderFor(at('draft'), '3.00'), 'Wait for the plan to be ready before sending more.');
  assert.equal(placeholderFor(null, '3.00'), 'Ask a follow-up');
});
