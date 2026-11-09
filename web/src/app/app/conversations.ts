// Conversations: chains of tasks, each message following the task before it (parent_id). The sidebar lists them, the
// task page shows one, and the composer sends into it. Pure functions, so the tests use them.
// Run: npx tsx --test src/app/app/*.test.ts
import { parseBudget } from './draft';
import { usdc } from './funding';
import type { TaskSummary } from './orchestrator';

export type Conversation = {
  id: string; // its first task
  title: string; // its first request
  tasks: TaskSummary[]; // oldest first
  latest: TaskSummary; // the task a new message follows
  current: TaskSummary; // the task a new message acts on (currentTask)
};

const byAge = (a: TaskSummary, b: TaskSummary) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/**
 * Every conversation in `tasks`, the most recently active first. A task whose parent isn't listed starts its own. Each
 * is in the order its messages follow one another (a chain, so its last task is the newest), never by clock alone.
 */
export function conversations(tasks: TaskSummary[]): Conversation[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const isRoot = (t: TaskSummary) => !t.parent_id || !byId.has(t.parent_id);
  const children = new Map<string, TaskSummary[]>();
  for (const t of tasks) if (!isRoot(t)) children.set(t.parent_id!, [...(children.get(t.parent_id!) ?? []), t]);
  return tasks.filter(isRoot).map((root) => {
    const list: TaskSummary[] = [];
    const visit = (t: TaskSummary) => {
      if (list.includes(t)) return;
      list.push(t);
      for (const c of (children.get(t.id) ?? []).sort(byAge)) visit(c);
    };
    visit(root);
    return { id: root.id, title: root.prompt, tasks: list, latest: list[list.length - 1], current: currentTask(list) };
  }).sort((a, b) => byAge(b.latest, a.latest));
}

/** The conversation that task `id` is part of, or null when `tasks` doesn't have it. */
export function conversationOf(tasks: TaskSummary[], id: string): Conversation | null {
  return conversations(tasks).find((c) => c.tasks.some((t) => t.id === id)) ?? null;
}

/** A failed or stopped message that never got a plan to run (a reply that isn't a task, a failed draft). Older services can't tell. */
const planless = (t: TaskSummary) => (t.status === 'failed' || t.status === 'killed') && t.has_plan === false;

/**
 * The task a new message acts on (`chain` oldest first): the newest one that isn't planless, whatever its status, so a
 * reply that wasn't a task never hides the plan, run or report above it (services/src/orchestrator/store.ts headOf).
 * The sidebar shows its state, and the composer offers to change it, follow up on it, or wait for it.
 */
export function currentTask(chain: TaskSummary[]): TaskSummary {
  for (let i = chain.length - 1; i >= 0; i--) if (!planless(chain[i])) return chain[i];
  return chain[chain.length - 1];
}

/**
 * The plan the newest message revises while that message is still being planned, or null. Rook replaces the plan with
 * the revision once it's ready, so the plan can't be approved meanwhile (it answers "Wait for the revised plan below.").
 */
export function revisedPlan(chain: TaskSummary[]): string | null {
  if (chain.length < 2 || chain[chain.length - 1].status !== 'draft') return null;
  const head = currentTask(chain.slice(0, -1));
  return head.status === 'planned' ? head.id : null;
}

// Not 'closing': a run is closing only once its report is written, so it has finished and only its refund is left.
const RUNNING = new Set(['approved', 'funded', 'running', 'aggregating']);

/**
 * Why nothing can be sent after a task in this status yet, in the orchestrator's words (it refuses the same); null when
 * a message can go. `chain`: the chain ledger, where an approved plan waits for its funding and no run has started.
 */
export function waitReason(status: string, chain = false): string | null {
  if (status === 'draft') return 'Wait for the plan to be ready before sending more.';
  if (status === 'approved' && chain) return 'Fund or cancel the plan above before sending more.';
  if (RUNNING.has(status)) return 'Wait for this run to finish, or stop it, before sending more.';
  return null;
}

/**
 * The composer's Budget field when the budget a conversation starts from (its newest task's, atomic) moves from `was` to
 * `next`: after a message is sent, once a plan made at a total its message named is ready, or on another conversation.
 * The field follows, unless it holds a budget the user typed: that stays until it is sent, so a send Rook refused (a
 * newer message from another tab moved the conversation on) keeps it for sending again.
 */
export function budgetField(field: string, was: string | undefined, next: string): string {
  const b = parseBudget(field);
  return was === undefined || (b.ok && b.atomic === BigInt(was)) ? usdc(next) : field;
}

/** What a changed budget alone sends: the same task again, at that budget. */
export const sameTaskAt = (usdc: string) => `Same task with a budget of ${usdc} USDC.`;

/** The budget as typed, when it is a valid amount other than the current task's (whose budget older services don't send). */
function changedBudget(budget: string, current: TaskSummary | null): string | null {
  const b = parseBudget(budget);
  return b.ok && current?.budget_atomic && b.atomic !== BigInt(current.budget_atomic) ? b.usdc : null;
}

/**
 * What the composer sends in a conversation: the message as typed, or, with nothing typed and the budget changed, the
 * same task at the new budget. '' when there is nothing to send.
 */
export function outgoing(prompt: string, budget: string, current: TaskSummary | null): string {
  const typed = prompt.trim();
  if (typed) return typed;
  const usdc = changedBudget(budget, current);
  return usdc ? sameTaskAt(usdc) : '';
}

// The same budget phrases as the services' budgetAmounts (services/src/shared/money.ts).
const WORD_NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', fifteen: '15', twenty: '20', thirty: '30', forty: '40', fifty: '50',
};
// A whole number (never part of one: "12k", "10 items" and "2.5 pages" are not money), or a number word.
const NUM = String.raw`(\d+(?:[.,]\d+)?(?![.,]?\d)|\b(?:${Object.keys(WORD_NUMBERS).join('|')})\b)`;
const CURRENCY = String.raw`(?:usdc|usd|dollars?|bucks?)\b`;
/** "$2", or a number no other unit follows: "2 USDC" and "2" are money, "1 week" and "20 pages" are not. */
const AMOUNT = String.raw`(?:\$\s*${NUM}|${NUM}(?!\s*(?!${CURRENCY})[a-z]))`;
const MONEY = String.raw`(?:\$\s*${NUM}|${NUM}\s*${CURRENCY})`;
const NAMED = new RegExp([
  String.raw`\bbudget\b(?:\s+(?:of|to|is|at))?[\s:=]*${AMOUNT}`, // "budget 5 USDC", "budget: 5", "a budget of $2", "the budget to 1.5"
  String.raw`\bmake\s+it\s+${AMOUNT}`, // "make it 1 USDC", "make it five USDC"
  String.raw`\b(?:reduce|lower|cut|raise|increase|drop|bring)\b[^\d\n]{0,30}?\bto\s+${AMOUNT}`, // "cut it to two dollars"
  String.raw`\bfor\s+${MONEY}`, // "do it for 2 USDC", "for $1.5"
].join('|'), 'gi');

/**
 * Amounts the message itself names as its budget ("make it 1.5 USDC", "budget: 2", "reduce it to 1", "for $2"), in
 * atomic USDC. Rook plans at a total the message names instead of the Budget field, so the wallet check before drafting
 * takes the smallest of these and the field. Other amounts ("tokens under $1", "a 1 USD fee", "budget for 1 week")
 * don't count, so a wallet short of the field's budget still hears it before planning is paid for. The plan's own
 * budget is checked again before it is funded.
 */
export function amountsNamed(prompt: string): bigint[] {
  const out: bigint[] = [];
  for (const m of prompt.matchAll(NAMED)) {
    const raw = m.slice(1).find((g) => g !== undefined) ?? '';
    const b = parseBudget(WORD_NUMBERS[raw.toLowerCase()] ?? raw);
    if (b.ok) out.push(b.atomic);
  }
  return out;
}

/** The composer's placeholder in a conversation: what sending does there. `chain` as in waitReason. */
export function placeholderFor(current: TaskSummary | null, budget: string, chain = false): string {
  if (!current) return 'Ask a follow-up';
  const wait = waitReason(current.status, chain);
  if (wait) return wait;
  const usdc = changedBudget(budget, current);
  if (current.status === 'planned') return usdc ? `Send to revise the plan at ${usdc} USDC, or say what to change` : 'Change the plan, or ask a follow-up';
  if (usdc) return `Send to plan this task again at ${usdc} USDC`;
  return current.status === 'closed' || current.status === 'closing' ? 'Ask a follow-up, like going deeper on one part' : 'Change the task, or try it again';
}
