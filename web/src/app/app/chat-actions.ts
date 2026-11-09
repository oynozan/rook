// What a conversation offers on its messages: sending the newest one again, or editing it, in its place. Pure
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
