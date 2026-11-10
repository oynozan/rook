// Sending a message again and editing it: what a conversation shows, and what each message offers.
// Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attemptNote, canEdit, canSendAgain, conversationIds, deleteRefusal, fundingHeld, fundingHeldRefusal, messageProblem, redoRefusal, redoWait, shownInstead, shownTasks,
} from './chat-actions';
import { conversationOf, conversations } from './conversations';
import type { TaskSummary } from './orchestrator';

const task = (id: string, minute: number, o: Partial<TaskSummary> = {}): TaskSummary =>
  ({ id, status: 'closed', prompt: `prompt ${id}`, created_at: `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`, parent_id: null, budget_atomic: '3000000', ...o });
const ids = (ts: TaskSummary[]) => ts.map((t) => t.id);

test('a message sent again or edited shows in the place of the one it supersedes, which the conversation leaves out', () => {
  const list = [
    task('a1', 0, { status: 'cancelled' }),
    task('a2', 1, { parent_id: 'a1', status: 'failed', has_plan: false, superseded_by: 'a3' }),
    task('a3', 2, { parent_id: 'a1', status: 'planned', supersedes: 'a2' }),
    // A first message sent again starts the conversation again: the old one is no conversation of its own.
    task('b1', 3, { status: 'failed', has_plan: false, superseded_by: 'b2' }),
    task('b2', 4, { supersedes: 'b1', status: 'planned' }),
  ];
  const shown = shownTasks(list);
  assert.deepEqual(ids(shown), ['a1', 'a3', 'b2']);
  assert.deepEqual(conversations(shown).map((c) => [c.id, ids(c.tasks), c.latest.id]), [['b2', ['b2'], 'b2'], ['a1', ['a1', 'a3'], 'a3']]);
  // A message just sent from the page knows only what it supersedes; the list may not know it yet.
  const sent = task('a4', 5, { parent_id: 'a1', status: 'draft', supersedes: 'a3' });
  assert.deepEqual(ids(conversationOf(shownTasks([...list, sent]), 'a4')!.tasks), ['a1', 'a4']);
  // An old link to a superseded message leads to the message shown in its place, however many times it was redone.
  assert.equal(shownInstead([...list, sent], 'a2'), 'a4');
  assert.equal(shownInstead(list, 'b1'), 'b2');
  assert.equal(shownInstead(list, 'a1'), 'a1');
  assert.equal(shownInstead(list, 'zz'), 'zz');
  // Tasks from older services have no links: nothing is left out.
  assert.deepEqual(ids(shownTasks([task('x', 1), task('y', 2, { parent_id: 'x' })])), ['x', 'y']);
});

test('the newest message can be edited until its plan is approved; it can be sent again when planning failed before any plan', () => {
  const facts = (status: string, subtasks: number | null = null, ledger = false) => ({ status, subtasks, ledger });
  // Still planning, waiting for approval, cancelled before it ran, or ended before it got a plan to run.
  for (const f of [facts('draft'), facts('planned', 2), facts('cancelled', 2), facts('failed'), facts('failed', 0), facts('killed')]) assert.ok(canEdit(f), JSON.stringify(f));
  // Approved or later, a run that failed or was stopped, or a plan cancelled after its funding came back.
  for (const f of [facts('approved', 2), facts('running', 2), facts('closed', 2), facts('failed', 2), facts('killed', 2), facts('cancelled', 2, true)]) assert.ok(!canEdit(f), JSON.stringify(f));
  assert.ok(canSendAgain(facts('failed')));
  // Every part dropped (a plan with nothing in it): editing the budget or the request is what helps.
  assert.ok(!canSendAgain(facts('failed', 0)));
  assert.ok(!canSendAgain(facts('planned', 2)) && !canSendAgain(facts('cancelled', 2)) && !canSendAgain(facts('killed')));

  // Rook's own trouble: sending again helps. The planner's sentence about the message: editing it does.
  assert.ok(!messageProblem('planner: planner LLM failed: NEAR AI 500'));
  assert.ok(!messageProblem("Rook's services restarted while this task was draft, so it stopped there. It hired no agent, so nothing was paid."));
  assert.ok(messageProblem('That reads like a go-ahead for the plan above. Use its button to start it.'));
  assert.ok(messageProblem('Your message asks for a budget of 60.00 USDC, but the most Rook takes is 50.00 USDC.'));
  // The planner's model read a budget into a message that names none: Rook's mistake, and its sentence says to send it again.
  assert.ok(!messageProblem("Rook's planner set a budget your message doesn't name, so this plan wasn't kept. Send your message again."));
  // Older services stored the not-a-task sentence with the prefix: still about the message, as plannerReason shows it.
  assert.ok(messageProblem('planner: That reads like a reply, not a task: to run a plan, use its button; to start something new, say what you want done.'));
  assert.ok(messageProblem('planner: This does not read as a task Rook can plan: say what you want done.'));
  assert.ok(!messageProblem('planner: planner LLM failed: NEAR AI 400 for plan.draft: not a task'));

  assert.equal(attemptNote({ supersedes: 'a1', edited: true }), 'Edited');
  assert.equal(attemptNote({ supersedes: 'a1', edited: false }), 'Sent again');
  assert.equal(attemptNote({ supersedes: null }), null);
});

test('the newest message waits like any message for the task above it, and refusals read plainly', () => {
  const chain = (above: string) => [task('a1', 0, { status: above, has_plan: true }), task('a2', 1, { parent_id: 'a1', status: 'failed', has_plan: false })];
  assert.equal(redoWait(chain('planned')), null); // it revises that plan
  assert.equal(redoWait(chain('closed')), null);
  assert.equal(redoWait(chain('running')), 'Wait for this run to finish, or stop it, before sending more.');
  assert.equal(redoWait(chain('approved'), true), 'Fund or cancel the plan above before sending more.');
  assert.equal(redoWait([task('a1', 0, { status: 'failed', has_plan: false })]), null); // a first message

  assert.equal(redoRefusal(409, 'This message was already edited or sent again.'), 'This message was already edited or sent again. The newer one now shows in its place.');
  assert.equal(redoRefusal(409, 'Only the newest message can be edited or sent again.'), 'This conversation has a newer message now, so only that one can be edited or sent again.');
  const approved = "This message's plan was approved, so it can't be changed now. Send a new message instead.";
  assert.equal(redoRefusal(409, approved), approved);
  assert.equal(redoRefusal(409, 'Wait for this run to finish, or stop it, before sending more.'), null); // followUpRefusal's
  assert.equal(redoRefusal(500, 'boom'), null);
});

test('deleting a chat takes every task of it, the replaced ones too; refused while its funding is out, and in plain words', () => {
  const list = [
    task('a0', 0, { status: 'failed', has_plan: false, superseded_by: 'a1' }), // its first message, sent again
    task('a1', 1, { supersedes: 'a0' }),
    task('a2', 2, { parent_id: 'a1', status: 'failed', has_plan: false, superseded_by: 'a3' }),
    task('a3', 3, { parent_id: 'a1', supersedes: 'a2', status: 'planned' }),
    task('b1', 4),
  ];
  // Any of its tasks names it.
  for (const id of ['a0', 'a1', 'a3']) assert.deepEqual(conversationIds(list, id).sort(), ['a0', 'a1', 'a2', 'a3']);
  assert.deepEqual(conversationIds(list, 'b1'), ['b1']);
  assert.deepEqual(conversationIds(list, 'zz'), []);

  // A transfer for a task that never ran and isn't back yet holds the chat: its refund is on that task's page.
  assert.ok(fundingHeld('approved', false, { refunded: false }));
  assert.ok(fundingHeld('killed', false, { refunded: false }));
  assert.ok(!fundingHeld('killed', false, { refunded: true }));
  assert.ok(!fundingHeld('killed', true, { refunded: false })); // Rook took the funding: its own books brought it back
  assert.ok(!fundingHeld('closed', true, { refunded: false }));
  assert.ok(!fundingHeld('approved', false, null));

  // Its words follow what that task's page offers: waiting to start (or to be stopped), or stopped with a refund button.
  assert.match(fundingHeldRefusal('approved'), /waiting on its page: start the run there, or stop it and take the USDC back, then delete the chat\.$/);
  assert.match(fundingHeldRefusal('killed'), /hasn't come back yet\. Refund it to your wallet on that task's page, then delete the chat\.$/);

  // Rook's refusals name the task that holds the chat, which the dialog links; an older orchestrator names none.
  const run = 'A run in this chat is still under way. Stop it or let it finish, then delete the chat.';
  assert.deepEqual(deleteRefusal(409, run, { task_id: 't_1a2b3c4d' }), { gone: false, message: run, known: true, task: 't_1a2b3c4d' });
  assert.deepEqual(deleteRefusal(409, run), { gone: false, message: run, known: true });
  assert.deepEqual(deleteRefusal(409, run, { task_id: '../x' }), { gone: false, message: run, known: true }); // never an odd link
  const waiting = 'A plan in this chat is waiting for its funding. Cancel it on its page first, then delete the chat.';
  assert.deepEqual(deleteRefusal(409, waiting, { task_id: 't_9' }), { gone: false, message: waiting, known: true, task: 't_9' });
  const back = 'Rook is still returning the unspent USDC of a task in this chat. Delete the chat once it is back in your wallet.';
  assert.deepEqual(deleteRefusal(409, back, { task_id: 't_2' }), { gone: false, message: back, known: true, task: 't_2' });
  const operator = "A task in this chat still holds USDC that Rook can't send back by itself, so Rook's operator will. Delete the chat once it is back in your wallet.";
  assert.deepEqual(deleteRefusal(409, operator, { task_id: 't_3' }), { gone: false, message: operator, known: true, task: 't_3' });
  assert.deepEqual(deleteRefusal(404, 'no task t_1'), { gone: true }); // deleted from another tab already
  assert.deepEqual(deleteRefusal(500, 'boom'), { gone: false, message: "Rook couldn't delete this chat right now. Try again in a moment.", known: false });
  assert.equal(deleteRefusal(null, '').gone, false);
});
