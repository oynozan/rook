// Conversations: how tasks group and order, what the sidebar shows, and what the composer sends and says.
// Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationOf, conversations, currentTask, outgoing, placeholderFor, sameTaskAt, waitReason } from './conversations';
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

test('the task a message acts on: the newest, or the plan above replies that never got a plan', () => {
  assert.equal(currentTask([task('a', 1), task('b', 2, { status: 'planned' })]).id, 'b');
  // "go ahead" under a plan fails as not a task; the plan above it is still what a message changes.
  const replied = [task('a', 1, { status: 'planned' }), task('b', 2, { status: 'failed', parent_id: 'a' }), task('c', 3, { status: 'failed', parent_id: 'b' })];
  assert.equal(currentTask(replied).id, 'a');
  assert.equal(conversations(replied)[0].current.status, 'planned'); // the sidebar says "Plan ready", not "Failed"
  // A finished run in between: the newest it is.
  assert.equal(currentTask([task('a', 1, { status: 'planned' }), task('b', 2, { status: 'closed' }), task('c', 3, { status: 'failed' })]).id, 'c');
  assert.equal(currentTask([task('a', 1, { status: 'cancelled' }), task('b', 2, { status: 'failed' })]).id, 'b');
});

test('nothing goes while the task it follows is planning or running, in the orchestrator\'s words', () => {
  assert.equal(waitReason('draft'), 'Wait for the plan to be ready before sending more.');
  for (const s of ['approved', 'funded', 'running', 'aggregating', 'closing']) assert.equal(waitReason(s), 'Wait for this run to finish, or stop it, before sending more.', s);
  for (const s of ['planned', 'closed', 'failed', 'cancelled', 'killed']) assert.equal(waitReason(s), null, s);
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

test('the placeholder says what a message does there', () => {
  const at = (status: string) => task('a', 1, { status, budget_atomic: '3000000' });
  assert.equal(placeholderFor(at('planned'), '3.00'), 'Change the plan, or ask a follow-up');
  assert.equal(placeholderFor(at('planned'), '1.5'), 'Send to revise the plan at 1.50 USDC, or say what to change');
  assert.equal(placeholderFor(at('closed'), '3.00'), 'Ask a follow-up, like going deeper on one part');
  assert.equal(placeholderFor(at('closed'), '5'), 'Send to plan this task again at 5.00 USDC');
  for (const s of ['failed', 'cancelled', 'killed']) assert.equal(placeholderFor(at(s), '3.00'), 'Change the task, or try it again', s);
  assert.equal(placeholderFor(at('failed'), '10'), 'Send to plan this task again at 10.00 USDC');
  assert.equal(placeholderFor(at('running'), '1'), 'Wait for this run to finish, or stop it, before sending more.');
  assert.equal(placeholderFor(at('draft'), '3.00'), 'Wait for the plan to be ready before sending more.');
  assert.equal(placeholderFor(null, '3.00'), 'Ask a follow-up');
});
