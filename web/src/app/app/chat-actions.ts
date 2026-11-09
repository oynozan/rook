// What a conversation offers: sending its newest message again, or editing it, in its place; and deleting it. Pure
// functions, so the tests use them. Run: npx tsx --test src/app/app/*.test.ts
import { currentTask, waitReason } from './conversations';
import type { TaskSummary } from './orchestrator';

/**
 * The tasks a conversation shows: a message sent again or edited takes the place of the one it supersedes, which is
 * left out. The orchestrator links both ways; a message just sent from this page only knows the one it supersedes.
 */
export function shownTasks(tasks: TaskSummary[]): TaskSummary[] {
  const replaced = new Set(tasks.map((t) => t.supersedes).filter((id): id is string => !!id));
  return tasks.filter((t) => !t.superseded_by && !replaced.has(t.id));
}

/** The task shown in place of `id`: `id` itself, or the newest message sent again or edited in its place. */
export function shownInstead(tasks: TaskSummary[], id: string): string {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const next = new Map(tasks.filter((t) => t.supersedes).map((t) => [t.supersedes!, t.id]));
  const seen = new Set<string>();
  for (let at = id; ; ) {
    const n = byId.get(at)?.superseded_by ?? next.get(at);
    if (!n || seen.has(n)) return at;
    seen.add(at);
    at = n;
  }
}

/** What the page knows of a message's task: its status, how many parts its plan has (null: no plan), and its books. */
export type MessageFacts = { status: string; subtasks: number | null; ledger: boolean };

/**
 * The newest message can be edited while no money has moved for its task (services/src/orchestrator/store.ts
 * supersedeRefusal): still planning (that stops), a plan waiting for approval (it is cancelled), a plan cancelled
 * before it ran, or a message that ended before it got a plan to run. Never once approved: a task that ran or was
 * stopped after approval has a plan, and a cancelled one whose funding went back has books.
 */
export function canEdit(t: MessageFacts): boolean {
  if (t.status === 'draft' || t.status === 'planned') return true;
  if (t.status === 'cancelled') return !t.ledger;
  if (t.status === 'failed' || t.status === 'killed') return !t.subtasks;
  return false;
}

/** "Send again": planning failed before there was any plan (the model down, the services restarted, a timeout). */
export const canSendAgain = (t: MessageFacts) => t.status === 'failed' && t.subtasks === null;

/**
 * The failure is about the message, not Rook: the planner's own sentence (not a task, a budget out of range), stored
 * without the "planner: " prefix of its errors. Editing helps there; sending it again as it was rarely does.
 */
export const messageProblem = (error: string | null | undefined) => !!error && !error.startsWith('planner: ') && !/^Rook's services restarted/.test(error);

/** The quiet note on a message that took another's place. */
export const attemptNote = (t: { supersedes?: string | null; edited?: boolean }) => (t.supersedes ? (t.edited ? 'Edited' : 'Sent again') : null);

/**
 * Why the newest message of `chain` (shown tasks, oldest first) can't be drafted again right now, or null. It takes the
 * place of that message, so what it acts on is the task above it, which must not be planning or running (the
 * orchestrator refuses the same). `chainLedger` as in waitReason.
 */
export function redoWait(chain: TaskSummary[], chainLedger = false): string | null {
  return chain.length > 1 ? waitReason(currentTask(chain.slice(0, -1)).status, chainLedger) : null;
}

/** POST /tasks refused a message sent again or edited: in plain words, or null when the refusal is about something else. */
export function redoRefusal(status: number, message: string): string | null {
  if (status !== 409) return null;
  if (/^This message was already edited or sent again/.test(message)) return 'This message was already edited or sent again. The newer one now shows in its place.';
  if (/^Only the newest message/.test(message)) return 'This conversation has a newer message now, so only that one can be edited or sent again.';
  if (/^This message's plan was approved/.test(message)) return message;
  return null;
}

/**
 * Every task of the conversation `id` is in, as the orchestrator deletes it (services/src/orchestrator/store.ts
 * conversationTasks): along parent links both ways, and across messages sent again or edited.
 */
export function conversationIds(tasks: TaskSummary[], id: string): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const linked = new Map<string, TaskSummary[]>(); // id -> the tasks that follow it or supersede it
  for (const t of tasks) for (const to of [t.parent_id, t.supersedes]) if (to) linked.set(to, [...(linked.get(to) ?? []), t]);
  const start = byId.get(id);
  if (!start) return [];
  const out = new Set([start]);
  for (const t of out) {
    for (const to of [t.parent_id, t.supersedes, t.superseded_by]) { const x = to ? byId.get(to) : undefined; if (x) out.add(x); }
    for (const x of linked.get(t.id) ?? []) out.add(x);
  }
  return [...out].map((t) => t.id);
}

/**
 * A funding transfer this web server remembers for a task that never ran (approved and waiting, or stopped before Rook
 * took the funding), whose USDC hasn't come back: its refund is on that task's page (api/tasks/[id] shows it there).
 */
export const fundingHeld = (status: string, hasLedger: boolean, sent: { refunded: boolean } | null) =>
  !!sent && !sent.refunded && (status === 'approved' || (status === 'killed' && !hasLedger));

/** Why the chat can't be deleted while a task of it holds its funding: the page links that task. */
export const FUNDING_HELD = "Your wallet's funding for a task in this chat hasn't come back yet. Open that task and refund it to your wallet first, then delete the chat.";

/**
 * Rook refused to delete a conversation, in plain words. `gone`: it was deleted already (from another tab, say), so
 * there is nothing left to do. The orchestrator's 409s are written for people and shown as they are.
 */
export function deleteRefusal(status: number | null, message: string): { gone: true } | { gone: false; message: string; known: boolean } {
  if (status === 404 && /^no task /.test(message)) return { gone: true };
  if (status === 409 && /delete the chat\.$|Delete the chat once/.test(message)) return { gone: false, message, known: true };
  return { gone: false, message: "Rook couldn't delete this chat right now. Try again in a moment.", known: false };
}
