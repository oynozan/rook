// Conversations: how tasks group and order, what the sidebar shows, and what the composer sends and says.
// Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amountsNamed, ASK_LEAD, askPrompt, budgetField, chatDates, conversationOf, conversations, currentTask, missingParts, outgoing, placeholderFor, questionsOf, retryMessage, revisedPlan, sameTaskAt, waitReason,
} from '@/lib/conversations';
import type { TaskStatus, TaskSummary } from '@/lib/server/orchestrator';

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
  assert.equal(placeholderFor(currentTask(closed), '3.00'), 'Ask for a change or a follow-up');
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

test('a budget named in any language counts, as the services read it (money.ts budgetAmounts)', () => {
  // The services' cases (services/test/planner-qa2.test.ts and planner.test.ts). QA t_2c4c5357: "Bütçeyi 1,5 USDC yap."
  assert.deepEqual(amountsNamed('Bütçeyi 1,5 USDC yap.'), [1_500_000n]);
  assert.deepEqual(amountsNamed('bütçe 2 USDC olsun'), [2_000_000n]);
  assert.deepEqual(amountsNamed('Bütçe 1 USDC toplamda kalır'), [1_000_000n]);
  assert.deepEqual(amountsNamed('Bütçeyi 3 dolara düşür'), [3_000_000n]);
  assert.deepEqual(amountsNamed("Toplam bütçe 2,5 USDC'ye çıksın"), [2_500_000n]);
  assert.deepEqual(amountsNamed('Haz el presupuesto de 2 USD'), [2_000_000n]);
  assert.deepEqual(amountsNamed('Pon el presupuesto en 4 dólares'), [4_000_000n]);
  assert.deepEqual(amountsNamed('Сделай бюджет 2 доллара'), [2_000_000n]);
  // A number with no currency word, or money in a message that names no budget, is no budget.
  assert.deepEqual(amountsNamed('Bütçe raporunda ilk 10 cüzdan'), []);
  assert.deepEqual(amountsNamed('10 USDC fiyatlı ajanlar hangileri?'), []);
  // English as before; a total named twice counts once.
  for (const [m, total] of [['make it 1 USDC', 1_000_000n], ['reduce the budget to 1.5', 1_500_000n], ['do it for $2', 2_000_000n], ['make it 2,5', 2_500_000n],
    ['Due diligence on the NEAR token, budget: 5 USDC', 5_000_000n], ['Same task with a budget of 1.50 USDC.', 1_500_000n]] as const) assert.deepEqual(amountsNamed(m), [total], m);
  for (const m of ['Compare the 3 biggest DEXs', 'Now translate it to Turkish', 'is it possible to reduce the budget?', 'go ahead', 'Same task, cheaper']) {
    assert.deepEqual(amountsNamed(m), [], m);
  }
});

test('the placeholder says what a message does there', () => {
  const at = (status: TaskStatus) => task('a', 1, { status, budget_atomic: '3000000' });
  assert.equal(placeholderFor(at('planned'), '3.00'), 'Change the plan, or ask a follow-up');
  assert.equal(placeholderFor(at('planned'), '1.5'), 'Send to revise the plan at 1.50 USDC, or say what to change');
  assert.equal(placeholderFor(at('closed'), '3.00'), 'Ask for a change or a follow-up');
  assert.equal(placeholderFor(at('closed'), '5'), 'Send to plan this task again at 5.00 USDC');
  assert.equal(placeholderFor(at('closing'), '3.00'), 'Ask for a change or a follow-up'); // finished, refund on its way
  // A run that finished without one of its parts: the next step is trying it again (t_c08f6e29 had no website).
  assert.equal(placeholderFor({ ...at('closed'), missing: ['Build one-page portfolio website'] }, '3.00'), 'Ask to try the missing part again, or for a change');
  // Rook asked for details: the next message answers, whatever the budget says.
  assert.equal(placeholderFor(at('asking'), '3.00'), 'Answer here, or say “use placeholders”');
  assert.equal(placeholderFor(at('asking'), '5'), 'Answer here, or say “use placeholders”');
  // An action in the world (a booking, a post) is never done on placeholders: none are offered.
  assert.equal(placeholderFor({ ...at('asking'), action: true }, '3.00'), 'Answer here');
  for (const s of ['failed', 'cancelled', 'killed'] as const) assert.equal(placeholderFor(at(s), '3.00'), 'Change the task, or try it again', s);
  assert.equal(placeholderFor(at('failed'), '10'), 'Send to plan this task again at 10.00 USDC');
  assert.equal(placeholderFor(at('running'), '1'), 'Wait for this run to finish, or stop it, before sending more.');
  assert.equal(placeholderFor(at('draft'), '3.00'), 'Wait for the plan to be ready before sending more.');
  assert.equal(placeholderFor(null, '3.00'), 'Ask a follow-up');
});

test("Rook's questions: the message after them answers them, and what they say", () => {
  // The questions are what a new message acts on: it follows them, and nothing waits.
  const chain = [task('a1', 0, { status: 'closed', has_plan: true }), task('a2', 1, { parent_id: 'a1', status: 'asking', has_plan: false })];
  assert.equal(currentTask(chain).id, 'a2');
  assert.equal(waitReason('asking'), null);
  const cs = conversations(chain);
  assert.equal(cs[0].current.status, 'asking');
  assert.equal(cs[0].latest.id, 'a2'); // the answer's parent
  // The plan's questions, trimmed; with none, the task's own sentence; else nothing.
  assert.deepEqual(questionsOf({ questions: [' Your name? ', '', 'Three projects, with links?'] }), ['Your name?', 'Three projects, with links?']);
  assert.deepEqual(questionsOf({ questions: [] }, 'What is your name?'), ['What is your name?']);
  assert.deepEqual(questionsOf(null, null), []);
});

test('a run that finished without some of its parts names them, and the next message tries them again', () => {
  const titles = new Map([['s1', 'Design brief'], ['s2', 'Build one-page portfolio website']]);
  assert.deepEqual(missingParts(['s2'], titles), ['Build one-page portfolio website']);
  assert.deepEqual(missingParts(['s9'], titles), ['s9']);
  assert.deepEqual(missingParts(undefined, titles), []);
  assert.equal(retryMessage(['Build one-page portfolio website']), 'Try “Build one-page portfolio website” again.');
  assert.equal(retryMessage(['A', 'B']), "Try the parts that weren't delivered again: “A”, “B”.");
});

test("chats that start with the same request are told apart by their local day, then the time they started", () => {
  const list = [
    task('a', 0, { prompt: 'make me a portfolio website', created_at: '2026-11-08T20:30:00.000Z' }),
    task('b', 1, { prompt: 'Make me a portfolio website ', created_at: '2026-11-09T10:00:00.000Z' }),
    task('c', 2, { prompt: 'make me a portfolio website', created_at: '2026-11-09T12:00:00.000Z' }),
    task('d', 3, { prompt: 'write my CV' }),
  ];
  assert.deepEqual(Object.fromEntries(chatDates(conversations(list), 'UTC')), { a: '8 Nov', b: '9 Nov, 10:00', c: '9 Nov, 12:00' });
  // The viewer's day, not UTC's: QA's t_ba5f8816 started at 02:57 on 11 Nov in Istanbul and showed "10 Nov".
  const late = [
    task('x', 0, { prompt: 'make me a portfolio website', created_at: '2026-11-10T23:57:00.000Z' }),
    task('y', 1, { prompt: 'make me a portfolio website', created_at: '2026-11-10T08:00:00.000Z' }),
  ];
  assert.deepEqual(Object.fromEntries(chatDates(conversations(late), 'Europe/Istanbul')), { x: '11 Nov', y: '10 Nov' });
  assert.deepEqual(Object.fromEntries(chatDates(conversations(late), 'UTC')), { x: '10 Nov, 23:57', y: '10 Nov, 08:00' });
  // The same minute too: their place among them by age.
  const twin = [task('p', 5, { prompt: 'hi' }), task('q', 5, { prompt: 'hi' })];
  assert.deepEqual(Object.fromEntries(chatDates(conversations(twin), 'UTC')), { p: '9 Nov, 10:05 · 1', q: '9 Nov, 10:05 · 2' });
});

test("Rook's questions ask in Rook's voice, and only the newest unanswered ones ask for an answer", () => {
  assert.equal(ASK_LEAD, 'Rook needs a few details before it plans this:');
  // An answered message (a newer one follows it) keeps its questions and nothing else (QA: "Answer below" on answered ones).
  assert.equal(askPrompt({ newest: false }), null);
  assert.equal(askPrompt({ newest: false, action: true }), null);
  assert.deepEqual(askPrompt({ newest: true }), { line: 'Answer below. Or Rook can use clearly marked placeholders for you to replace later.', placeholders: true });
  // QA t_390c58c5: one click on "Use placeholders" planned a real booking under "[Your name]". An action offers none.
  const action = askPrompt({ newest: true, action: true })!;
  assert.equal(action.placeholders, false);
  assert.doesNotMatch(action.line, /placeholders for you/);
  assert.match(action.line, /^Answer below\./);
});
