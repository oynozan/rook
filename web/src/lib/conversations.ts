// Conversations: chains of tasks, each message following the task before it (parent_id). The sidebar lists them, the
// task page shows one, and the composer sends into it. Pure functions, so the tests use them.
// Run: npx tsx --test test/*.test.ts (from web/)
import { parseBudget } from '@/lib/draft';
import { usdc } from '@/lib/funding';
import type { TaskSummary } from '@/lib/server/orchestrator';

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

/**
 * What tells apart chats that start with the same request, in the viewer's time zone (`timeZone`; the runtime's own when
 * left out): the day each started ("11 Nov"); when that is the same too, the time it started ("11 Nov, 02:57"); and
 * when even the minute is the same, its place among them by age ("11 Nov, 02:57 · 2"). Only those chats get one. The
 * page renders it only in the browser (AppShell), so a server in another time zone never shows the wrong day.
 */
export function chatDates(convs: Conversation[], timeZone?: string): Map<string, string> {
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone });
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  const at = (c: Conversation) => {
    const d = new Date(c.tasks[0].created_at);
    return Number.isNaN(d.getTime()) ? { day: '', time: '' } : { day: day.format(d), time: time.format(d) };
  };
  const same = new Map<string, Conversation[]>();
  for (const c of convs) {
    const key = c.title.trim().toLowerCase();
    same.set(key, [...(same.get(key) ?? []), c]);
  }
  const out = new Map<string, string>();
  for (const group of same.values()) {
    if (group.length < 2) continue;
    const byAgeAsc = [...group].sort((a, b) => byAge(a.tasks[0], b.tasks[0]));
    for (const c of group) {
      const when = at(c);
      const sameDay = byAgeAsc.filter((x) => at(x).day === when.day);
      if (sameDay.length < 2) { out.set(c.id, when.day); continue; }
      const sameMinute = sameDay.filter((x) => at(x).time === when.time);
      const label = when.day && when.time ? `${when.day}, ${when.time}` : '';
      out.set(c.id, sameMinute.length > 1 ? `${label} · ${sameMinute.indexOf(c) + 1}`.trim() : label);
    }
  }
  return out;
}

/** The conversation that task `id` is part of, or null when `tasks` doesn't have it. */
export function conversationOf(tasks: TaskSummary[], id: string): Conversation | null {
  return conversations(tasks).find((c) => c.tasks.some((t) => t.id === id)) ?? null;
}

/**
 * A failed or stopped message that never got a plan to run (a reply that isn't a task, a failed draft). Older services
 * can't tell. Rook's questions (asking) are not: the next message answers them, so they are what it acts on.
 */
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
// Any language: a number next to a currency word ("1,5 USDC", "2 dolar", "$3", "5 dólares", "1,5 USDC'ye") in a message
// that names the budget in a word of its language ("Bütçeyi 1,5 USDC yap.", "presupuesto de 2 USD").
// \b sees no edge before a letter outside ASCII (Cyrillic), so the start is "no letter before".
const BUDGET_WORD = /(?<![\p{L}\d])(?:budget|bütçe|butce|presupuest|orçamento|orcamento|budżet|бюджет|anggaran|ngân sách|bajet)|预算|予算|예산|ميزانية|बजट|งบประมาณ/iu;
const DIGITS = String.raw`(\d+(?:[.,]\d+)?)(?![.,]?\d)`;
const CURRENCY_ANY = String.raw`(?:usdc|usd|dollars?|dolar\p{L}*|dólar\p{L}*|dolares|bucks?|долл\p{L}*|ドル|美元|달러)`;
const MONEY_ANY = new RegExp(String.raw`\$\s*${DIGITS}|(?<![\p{L}\d.,])${DIGITS}\s*${CURRENCY_ANY}(?![\p{L}\d])(?:['’]\p{L}*)?`, 'giu');

/**
 * Amounts the message itself names as its budget ("make it 1.5 USDC", "budget: 2", "reduce it to 1", "for $2",
 * "Bütçeyi 1,5 USDC yap."), in atomic USDC, each once. Rook plans at a total the message names instead of the Budget
 * field, so the wallet check before drafting takes the smallest of these and the field. Other amounts ("tokens under
 * $1", "a 1 USD fee", "budget for 1 week") don't count, so a wallet short of the field's budget still hears it before
 * planning is paid for. The plan's own budget is checked again before it is funded.
 */
export function amountsNamed(prompt: string): bigint[] {
  const out: bigint[] = [];
  const add = (raw: string) => {
    const b = parseBudget(WORD_NUMBERS[raw.toLowerCase()] ?? raw);
    if (b.ok && !out.includes(b.atomic)) out.push(b.atomic);
  };
  for (const m of prompt.matchAll(NAMED)) {
    const raw = m.slice(1).find((g) => g !== undefined);
    if (raw) add(raw);
  }
  if (BUDGET_WORD.test(prompt)) for (const m of prompt.matchAll(MONEY_ANY)) add(m[1] ?? m[2]);
  return out;
}

/** The composer's placeholder in a conversation: what sending does there. `chain` as in waitReason. */
export function placeholderFor(current: TaskSummary | null, budget: string, chain = false): string {
  if (!current) return 'Ask a follow-up';
  // Rook asked for details: the next message answers it, whatever the budget field says. An action in the world (a
  // booking, a post) is never done on placeholders, so none are offered.
  if (current.status === 'asking') return current.action ? 'Answer here' : 'Answer here, or say “use placeholders”';
  const wait = waitReason(current.status, chain);
  if (wait) return wait;
  const usdc = changedBudget(budget, current);
  if (current.status === 'planned') return usdc ? `Send to revise the plan at ${usdc} USDC, or say what to change` : 'Change the plan, or ask a follow-up';
  if (usdc) return `Send to plan this task again at ${usdc} USDC`;
  if (current.status === 'closed' || current.status === 'closing') {
    return current.missing?.length ? 'Ask to try the missing part again, or for a change' : 'Ask for a change or a follow-up';
  }
  return 'Change the task, or try it again';
}

/** Rook's questions, as its message opens them: in Rook's voice, as the questions and the rest of the page are. */
export const ASK_LEAD = 'Rook needs a few details before it plans this:';
/** The answer the "Use placeholders" button sends: the planner takes it as an answer to its questions. */
export const PLACEHOLDERS_ANSWER = 'Use placeholders';

/**
 * The line under Rook's questions, and whether the "Use placeholders" button shows: only on the newest message, which
 * nothing has answered yet (an answered one keeps its questions and nothing else), and never for an action in the
 * world (a booking, a post, a purchase), which Rook never does on placeholders. Null: no line, no button.
 */
export function askPrompt(o: { newest: boolean; action?: boolean }): { line: string; placeholders: boolean } | null {
  if (!o.newest) return null;
  return o.action
    ? { line: 'Answer below. Rook needs the real details for this, so it never fills them in for you.', placeholders: false }
    : { line: 'Answer below. Or Rook can use clearly marked placeholders for you to replace later.', placeholders: true };
}

/**
 * Rook's questions to show for a task that is asking (PlanView.questions), each trimmed; when its plan carries none
 * (an older or unexpected one), its error as the one question, if it has one.
 */
export function questionsOf(plan: { questions?: string[] } | null | undefined, error?: string | null): string[] {
  const asked = (plan?.questions ?? []).map((q) => q.trim()).filter(Boolean);
  return asked.length ? asked : error?.trim() ? [error.trim()] : [];
}

/** What a finished run's parts that delivered nothing are called (final_result.abandoned holds their ids). */
export const missingParts = (abandoned: string[] | undefined, titles: Map<string, string>) => (abandoned ?? []).map((id) => titles.get(id) ?? id);

/** The follow-up that asks Rook to try a run's missing parts again (a new plan, shown before anything is spent). */
export function retryMessage(missing: string[]): string {
  return missing.length === 1 ? `Try “${missing[0]}” again.` : `Try the parts that weren't delivered again: ${missing.map((t) => `“${t}”`).join(', ')}.`;
}
