// Conversations: chains of tasks, each message following the task before it (parent_id). The sidebar lists them, the
// task page shows one, and the composer sends into it. Pure functions, so the tests use them.
// Run: npx tsx --test src/app/app/*.test.ts
import { parseBudget } from './draft';
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

/**
 * The task a new message acts on (`chain` oldest first): the newest, or the plan above it when only messages that never
 * got a plan came after it (a reply that isn't a task). Rook revises that plan (services/src/orchestrator/store.ts
 * openPlan), so the sidebar shows it as ready and the composer offers to change it.
 */
export function currentTask(chain: TaskSummary[]): TaskSummary {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].status === 'planned') return chain[i];
    if (chain[i].status !== 'failed' && chain[i].status !== 'killed') break;
  }
  return chain[chain.length - 1];
}

const RUNNING = new Set(['approved', 'funded', 'running', 'aggregating', 'closing']);

/** Why nothing can be sent after a task in this status yet, in the orchestrator's words (it refuses the same); null when a message can go. */
export function waitReason(status: string): string | null {
  if (status === 'draft') return 'Wait for the plan to be ready before sending more.';
  if (RUNNING.has(status)) return 'Wait for this run to finish, or stop it, before sending more.';
  return null;
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

/** The composer's placeholder in a conversation: what sending does there. */
export function placeholderFor(current: TaskSummary | null, budget: string): string {
  if (!current) return 'Ask a follow-up';
  const wait = waitReason(current.status);
  if (wait) return wait;
  const usdc = changedBudget(budget, current);
  if (current.status === 'planned') return usdc ? `Send to revise the plan at ${usdc} USDC, or say what to change` : 'Change the plan, or ask a follow-up';
  if (usdc) return `Send to plan this task again at ${usdc} USDC`;
  return current.status === 'closed' ? 'Ask a follow-up, like going deeper on one part' : 'Change the task, or try it again';
}
