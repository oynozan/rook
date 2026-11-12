// Task store, events and SSE listeners (docs/agentic-system.md sections 8.2, 8.3, 8.8). Tasks live in memory while the
// orchestrator runs; with ROOK_DB set, every change is also written to SQLite (db.ts) and reloaded on start.
import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_FILES, CONVERSATION_FILES_CHARS, MAX_HISTORY_HANDLES, type AgentHistory, type DeliveredFile, type EventType, type Evaluation, type LlmCall,
  type Part, type Plan, type PlanSubtask, type Receipt, type RookEvent, type SubtaskStatus, type TaskStatus, type Unaccepted, type WalletFunding,
} from '../shared/types.ts';
import { cutShort, onInputs } from '../planner/files.ts';
import type { ChainBinding } from './chain-ledger.ts';
import type { Ledger, Recipient } from './ledger.ts';

export type Hire = {
  id: string; subtask_id: string; agent_handle: string; amount_atomic: string; payment_hash: string;
  a2a_task_id: string | null; context_id: string | null;
  state: string; // A2A state, or SENDING / TIMEOUT / SEND_FAILED / OUTCOME_UNKNOWN / KILLED
  paid: boolean; deliverable_text: string | null; parts: Part[]; verdict: 'pass' | 'fail' | null;
  started_at: string; ended_at: string | null;
  // The quote's payTo and when its authorization expires: a restarted orchestrator resumes or settles the hire with them.
  pay_to?: string; expires_at?: string;
};

/** Receipt as stored and shown: explorer links are filled in chain mode (null in simulation). */
export type ReceiptView = Receipt & { payment_explorer_url?: string | null; receipt_explorer_url?: string | null };

export type Sub = PlanSubtask & {
  n: number; status: SubtaskStatus; final_outcome: 'passed' | 'abandoned' | null; rehire_count: number;
  tried: string[]; hires: Hire[]; evaluations: (Evaluation & { hire_id: string | null })[];
  accepted: { hire_id: string | null; agent_handle: string; text: string } | null;
  // Agents whose paid send got -32603 ("no reachable backend right now"), and those of them asked again since.
  unreachable?: string[]; retried?: string[];
};

export type Task = {
  id: string; prompt: string; budget_atomic: string; reserve_share: number; funder: string | null;
  owner: string | null; // the NEAR account that drafted it, verified by the web app; null for tasks from the CLI
  // Conversations: the task this message followed (same owner), and the earlier messages it was planned with, oldest
  // first (the aggregator reads the task with them). A plan replaced by a revision names the revision.
  parent_id: string | null; earlier_prompts?: string[]; replaced_by?: string | null;
  // A message sent again, as it was or edited, in the place of an earlier one (8.9): the new task names the one it
  // supersedes (`edited`: its text or budget differs), and that one names it back. Unlike a plan replaced by a
  // revision, a superseded task no longer shows in its conversation. Tasks stored before this have neither.
  supersedes?: string | null; superseded_by?: string | null; edited?: boolean;
  deleted_at?: string | null; // its owner deleted its conversation: gone for the owner, kept for the record (8.9)
  status: TaskStatus; error: string | null; created_at: string; updated_at: string;
  plan: Plan | null; subtasks: Sub[]; receipts: ReceiptView[]; events: RookEvent[];
  // The chat's current files this task was planned on (Conversation.files, with who delivered each): a part's inputs
  // are attached from it, and the report's files are it with this run's files replacing the same paths. Absent on a
  // chat's first task, a chat with no files, and tasks stored before it.
  workspace?: DeliveredFile[];
  // files: the chat's current files once this run is done (planner 5.4 plus the workspace); absent on reports stored
  // before Rook attached files. changed: the paths this run delivered new or changed; absent on reports stored before.
  // unaccepted: for each abandoned part, its best paid delivery that failed the checks (runner.ts unacceptedOf); absent
  // on reports stored before it.
  final_result: {
    final_markdown: string; attribution: { subtask_id: string; agent_handle: string }[]; files?: DeliveredFile[]; changed?: string[]; abandoned: string[];
    unaccepted?: Unaccepted[];
  } | null;
  llm_calls: LlmCall[]; // self-do and aggregate calls (plan and evaluation calls live on the plan and evaluations)
  ledger_saved?: unknown; // the ledger's last view, kept so a reloaded task still shows what it spent
  chain?: ChainBinding | null; // ROOK_LEDGER=chain: its contract task, sub-accounts and outstanding authorizations
  wallet_funding?: WalletFunding | null; // funded from the owner's agent wallet (docs/agent-wallet-plan.md), step by step
  // runtime only, never serialised
  listeners: Set<(e: RookEvent) => void>; abort: AbortController;
  inflight: Map<string, { subtask: Sub; hire: Hire; handle: string; a2a_task_id: string | null }>; // null: /send in flight
  allow: Recipient[];
  running?: Promise<void>; // the run (or a restore), so the unwind after a kill starts once its loops have stopped
  unwinding?: Promise<void>; // returning what is still on chain after a kill, a failure or a failed close
  salvaging?: boolean; // events still record after the terminal status while money moves back
  shutdown: AbortController; // aborted when the orchestrator stops: the unwind stops retrying, and the next start resumes it
  // Chain mode, after a restart: rebuilding its books from contract task `chain.contract_task_id` failed and is being
  // tried again, so it is not bound yet, though that contract task still holds its money.
  restoring?: boolean;
  // Chain mode, after a restart: its books can't be rebuilt here, and every try would fail the same way. Its money was
  // funded on another contract (`other_contract`: a Rook that runs that one moves it, never this one), or its contract
  // task's numbers don't fit Rook's books (`misfit`: it waits for Rook's operator, on this contract).
  stranded?: 'other_contract' | 'misfit';
};
type Runtime = 'listeners' | 'abort' | 'inflight' | 'allow' | 'running' | 'unwinding' | 'salvaging' | 'shutdown' | 'restoring' | 'stranded';
/** A task without its runtime parts: what SQLite stores. Tasks stored before conversations have no parent_id. */
export type TaskDoc = Omit<Task, Runtime | 'parent_id'> & { parent_id?: string | null };

// asking ends its task like a reply that is not a task: nothing runs from it, and the next message answers it.
export const TERMINAL_TASK: TaskStatus[] = ['closed', 'cancelled', 'killed', 'failed', 'asking'];
export const isTerminal = (s: TaskStatus) => TERMINAL_TASK.includes(s);
/** Every subtask is self_do: the plan pays no one, so no money is held (no contract task in chain mode). */
export const isFree = (t: { subtasks: { self_do: boolean }[] }) => t.subtasks.length > 0 && t.subtasks.every((s) => s.self_do);
export const now = () => new Date().toISOString();

// Called after every change to a task; the orchestrator points it at SQLite when ROOK_DB is set.
let persist: ((t: Task) => void) | null = null;
export function persistWith(fn: ((t: Task) => void) | null) { persist = fn; }
export const saveTask = (t: Task) => persist?.(t);

/** The task without its runtime parts, ready to store. */
export function toDoc(t: Task): TaskDoc {
  const { listeners: _l, abort: _a, inflight: _i, allow: _w, running: _r, unwinding: _u, salvaging: _s, shutdown: _d, restoring: _o, stranded: _x, ...doc } = t;
  return doc;
}

/** A stored task with fresh runtime parts. */
export function fromDoc(doc: TaskDoc): Task {
  // Tasks saved before owners existed have none; they stay out of every account's list. Tasks saved before
  // conversations each start their own.
  return { ...doc, owner: doc.owner ?? null, parent_id: doc.parent_id ?? null, listeners: new Set(), abort: new AbortController(), inflight: new Map(), allow: [], shutdown: new AbortController() };
}

export function newTask(prompt: string, budget_atomic: bigint, reserve_share: number, owner: string | null = null, parent_id: string | null = null): Task {
  const ts = now();
  const t: Task = {
    id: `t_${randomUUID().slice(0, 8)}`, prompt, budget_atomic: budget_atomic.toString(), reserve_share, funder: null, owner, parent_id,
    status: 'draft', error: null, created_at: ts, updated_at: ts,
    plan: null, subtasks: [], receipts: [], events: [], final_result: null, llm_calls: [],
    listeners: new Set(), abort: new AbortController(), inflight: new Map(), allow: [], shutdown: new AbortController(),
  };
  emit(t, 'task_status', { from: null, to: 'draft' });
  return t;
}

export function setPlan(t: Task, plan: Plan) {
  t.plan = plan;
  // The plan's reserve (the budget its caps leave, at most 90%) is what the funder approves and the ledger keeps.
  if (Number.isInteger(plan.budget.reserve_bps)) t.reserve_share = plan.budget.reserve_bps! / 10_000;
  t.subtasks = plan.subtasks.map((s, i) => ({
    ...s, n: i + 1, status: 'pending', final_outcome: null, rehire_count: 0, tried: [], hires: [], evaluations: [], accepted: null,
  }));
  saveTask(t);
}

/**
 * Append and broadcast. Nothing is emitted after the terminal task_status event, so SSE can end on it, except what
 * still moves money (`late`, or while t.salvaging): the unwind after a kill or failure, a payment found later. Those
 * reach the stored history (replay, snapshot) but not an SSE stream that already ended.
 */
export function emit(t: Task, type: EventType, data: any, subtask_id?: string, late = false) {
  if (isTerminal(t.status) && !late && !t.salvaging) return;
  const e: RookEvent = { seq: t.events.length + 1, ts: now(), task_id: t.id, ...(subtask_id ? { subtask_id } : {}), type, data };
  t.events.push(e);
  for (const fn of t.listeners) fn(e);
  saveTask(t);
}

/** Terminal states are final: a late planner reply or loop cannot move a killed task back into the state machine. */
export function setStatus(t: Task, to: TaskStatus) {
  if (t.status === to || isTerminal(t.status)) return;
  emit(t, 'task_status', { from: t.status, to });
  t.status = to;
  t.updated_at = now();
  saveTask(t);
}

export function setSub(t: Task, s: Sub, to: SubtaskStatus) {
  if (s.status === to) return;
  emit(t, 'subtask_status', { from: s.status, to }, s.id);
  s.status = to;
  t.updated_at = now();
  saveTask(t);
}

/** Hire ends that never reached the agent's work: the paid send failed (-32603 and the like), or it never answered. */
const STALLED = ['SEND_FAILED', 'TIMEOUT'];
// ponytail: a stall counts for 7 days, and a delivery clears the agent's stalls before it; no decay or per-error weight.
export const STALL_WINDOW_MS = 7 * 86_400_000;

/**
 * Rook's own record per agent: the evaluator's verdicts on its paid hires, from every task's receipts (all stored tasks
 * are loaded at start, so with ROOK_DB this spans restarts). Unjudged receipts (verdict null) do not count. `stalled`:
 * its hires of the last STALL_WINDOW_MS that ended SEND_FAILED or TIMEOUT after its last delivery (COMPLETED); none of
 * those has a receipt, so before this an agent that failed every paid send (dev-tools-agent on mainnet, two runs)
 * stayed first in every plan. The planner ranks with it (docs/agentic-system.md 5.2 step 4); it takes at most
 * MAX_HISTORY_HANDLES, those with the most on record first.
 */
export function verdictHistory(tasks: Iterable<Task>, at = Date.now()): Record<string, AgentHistory> {
  const by = new Map<string, AgentHistory>();
  const of = (handle: string) => by.get(handle) ?? by.set(handle, { pass: 0, fail: 0 }).get(handle)!;
  const ends: { handle: string; at: number; delivered: boolean }[] = [];
  for (const t of tasks) {
    for (const r of t.receipts) if (r.verdict === 'pass' || r.verdict === 'fail') of(r.agent_handle)[r.verdict]++;
    for (const s of t.subtasks) {
      for (const h of s.hires) {
        const end = Date.parse(h.ended_at ?? '');
        if (!Number.isFinite(end)) continue;
        if (h.state === 'COMPLETED') ends.push({ handle: h.agent_handle, at: end, delivered: true });
        else if (STALLED.includes(h.state) && end > at - STALL_WINDOW_MS) ends.push({ handle: h.agent_handle, at: end, delivered: false });
      }
    }
  }
  for (const e of ends.sort((a, b) => a.at - b.at)) {
    if (!e.delivered) { const h = of(e.handle); h.stalled = (h.stalled ?? 0) + 1; } else if (by.get(e.handle)?.stalled) delete by.get(e.handle)!.stalled;
  }
  const record = (h: AgentHistory) => h.pass + h.fail + (h.stalled ?? 0);
  return Object.fromEntries([...by].filter(([, h]) => record(h) > 0).sort((a, b) => record(b[1]) - record(a[1])).slice(0, MAX_HISTORY_HANDLES));
}

export function taskView(t: Task) {
  const { id, status, prompt, budget_atomic, reserve_share, funder, owner, parent_id, error, created_at, updated_at, plan } = t;
  return {
    id, status, prompt, budget_atomic, reserve_share, funder, owner, parent_id, replaced_by: t.replaced_by ?? null,
    supersedes: t.supersedes ?? null, superseded_by: t.superseded_by ?? null, edited: t.edited ?? false, deleted_at: t.deleted_at ?? null,
    error, created_at, updated_at, plan,
    wallet_funding: t.wallet_funding ?? null, // its agent wallet funding step by step; ids and amounts only, no secret
  };
}

/** The task and the tasks above it in its conversation, nearest first. */
export function ancestors(t: Task, byId: Map<string, Task>): Task[] {
  const out: Task[] = [];
  for (let x: Task | undefined = t; x && !out.includes(x); x = x.parent_id ? byId.get(x.parent_id) : undefined) out.push(x);
  return out;
}

/** The message `t` and the messages it was sent again or edited in the place of (8.9), newest first. */
export function attempts(t: Task, byId: Map<string, Task>): Task[] {
  const out: Task[] = [];
  for (let x: Task | undefined = t; x && !out.includes(x); x = x.supersedes ? byId.get(x.supersedes) : undefined) out.push(x);
  return out;
}

/**
 * A message that never got a plan to run: a reply that is not a task, a question Rook asked (asking), a planner
 * failure, a draft stopped while planning.
 */
export const planless = (t: Task) => isTerminal(t.status) && !t.subtasks.length;

/** What Rook asked and the message after `chain[0]` answers: the nearest asking task above it with no plan between. */
export function questionsFor(chain: Task[]): string[] | undefined {
  for (const x of chain) {
    if (x.status === 'asking') return x.plan?.questions?.filter((q) => q.trim()).slice(0, 10);
    if (!planless(x)) return undefined;
  }
  return undefined;
}

/**
 * The chat's current files, as a message after `chain[0]` (nearest first) finds them: every report's files, oldest
 * to newest, a later version of a path replacing the earlier one in its place. Whole, up to CONVERSATION_FILES files
 * and CONVERSATION_FILES_CHARS characters: past that the most recently delivered are kept, and `left` names the rest.
 */
export function workspaceOf(chain: Task[]): { files: DeliveredFile[]; left: string[] } {
  const latest = new Map<string, { f: DeliveredFile; at: number }>();
  const reports = chain.filter((x) => x.final_result?.files?.length).reverse();
  reports.forEach((x, at) => { for (const f of x.final_result!.files!) latest.set(f.name, { f, at }); });
  const keep = new Set<string>();
  let chars = 0;
  // Newest first, then in the chat's file order; one too big to fit never shuts out the smaller older ones.
  for (const [name, { f }] of [...latest].sort((a, b) => b[1].at - a[1].at)) {
    if (name.length > 300 || keep.size >= CONVERSATION_FILES || chars + f.text.length > CONVERSATION_FILES_CHARS) continue;
    keep.add(name);
    chars += f.text.length;
  }
  const all = [...latest.values()].map((x) => x.f);
  return { files: all.filter((f) => keep.has(f.name)), left: all.filter((f) => !keep.has(f.name)).map((f) => f.name) };
}

/**
 * A run's report files: the workspace with each file this run delivered replacing the one at its path, in the parts'
 * order, new ones after. A file carried over unchanged has no part in this run (subtask_id ''). `changed`: the paths
 * this run delivered new or with different text. `inputs`: the paths each part edits, by subtask id: a delivered file
 * at another path that stands for one of them ("portfolio/index.html" for index.html, files.ts onInputs) replaces it,
 * unless its part delivered that path too; before, the chat kept both, and the next edit worked on the old one. A
 * page cut off before its end (no </html>) never replaces a whole one.
 */
export function withWorkspace(workspace: DeliveredFile[], delivered: DeliveredFile[], inputs: Record<string, string[] | undefined> = {}): { files: DeliveredFile[]; changed: string[] } {
  const out = new Map(workspace.map((f) => [f.name, { ...f, subtask_id: '' }]));
  const changed: string[] = [];
  for (const d of delivered) {
    const own = inputs[d.subtask_id] ?? [];
    const p = out.has(d.name) ? undefined : onInputs(d.name, own);
    const name = p && !delivered.some((x) => x !== d && x.subtask_id === d.subtask_id && x.name === p) ? p : d.name;
    if (out.has(name) && cutShort(name, d.text)) continue;
    const f = name === d.name ? d : { ...d, name };
    if (out.get(name)?.text !== f.text && !changed.includes(name)) changed.push(name);
    out.set(name, f);
  }
  return { files: [...out.values()], changed };
}

/**
 * The task a new message after `chain[0]` acts on: the nearest one up the chain that is not planless, so a failed reply
 * under a plan or a run never hides it. `chain[0]` when every one is planless.
 */
export function headOf(chain: Task[]): Task | undefined {
  return chain.find((x) => !planless(x)) ?? chain[0];
}

/** The plan a new message after `chain[0]` changes: the head, when it is planned. Null: it follows up on work that ended. */
export function openPlan(chain: Task[]): Task | null {
  const head = headOf(chain);
  return head?.status === 'planned' ? head : null;
}

/** It was approved at some point, so funding may have moved for it. */
export const wasApproved = (t: Task) => t.events.some((e) => e.type === 'task_status' && e.data?.to === 'approved');

/** Statuses a task can be in before it was ever approved: no money has moved for it. */
const UNTOUCHED: TaskStatus[] = ['draft', 'asking', 'planned', 'cancelled', 'failed', 'killed'];

/**
 * Why `old` can't be sent again or edited in its place (8.9), or null when it can: only the newest message of its
 * conversation, sent again once, and only while no money has moved for it (drafting, planned, or ended before it was
 * ever approved).
 */
export function supersedeRefusal(old: Task, all: Iterable<Task>): string | null {
  if (old.superseded_by) return 'This message was already edited or sent again.';
  if (!UNTOUCHED.includes(old.status) || wasApproved(old)) return "This message's plan was approved, so it can't be changed now. Send a new message instead.";
  for (const x of all) if (x.parent_id === old.id) return 'Only the newest message can be edited or sent again.';
  return null;
}

/**
 * Every task of the conversation `t` is in: along its parent links both ways, and across messages sent again or edited
 * (sent again in place of a conversation's first message, a new first task supersedes the old one).
 */
export function conversationTasks(t: Task, all: Iterable<Task>): Task[] {
  const list = [...all];
  const byId = new Map(list.map((x) => [x.id, x]));
  const linked = new Map<string, Task[]>(); // id -> the tasks that follow it or supersede it
  for (const x of list) for (const to of [x.parent_id, x.supersedes]) if (to) linked.set(to, [...(linked.get(to) ?? []), x]);
  const out = new Set([t]);
  for (const x of out) { // a Set's iteration also visits what is added during it
    for (const to of [x.parent_id, x.supersedes, x.superseded_by]) { const y = to ? byId.get(to) : undefined; if (y) out.add(y); }
    for (const y of linked.get(x.id) ?? []) out.add(y);
  }
  return [...out];
}

export function snapshot(t: Task, ledger: Ledger) {
  const { plan, ...task } = taskView(t);
  const calls = [...(plan?.llm_calls ?? []), ...t.subtasks.flatMap((s) => s.evaluations.flatMap((e) => e.llm_calls ?? [])), ...t.llm_calls];
  return {
    task, plan,
    subtasks: t.subtasks.map((s) => ({
      id: s.id, n: s.n, title: s.title, status: s.status, final_outcome: s.final_outcome, self_do: s.self_do,
      cap_atomic: s.cap_atomic, deadline_s: s.deadline_s, rehire_count: s.rehire_count, tried: s.tried,
      // A hired agent's text is in its hire; Rook's own (self_do) text has no hire, so it comes along here.
      accepted: s.accepted && { hire_id: s.accepted.hire_id, agent_handle: s.accepted.agent_handle, ...(s.accepted.hire_id === null ? { text: s.accepted.text } : {}) },
      hires: s.hires, evaluations: s.evaluations,
    })),
    // a2a_task_id, attestation_hash, payment_tx and receipt_tx with their explorer links (null until known, and in simulation)
    receipts: t.receipts.map((r) => ({ payment_explorer_url: null, receipt_explorer_url: null, ...r })),
    ledger: ledger.view(t.id) ?? t.ledger_saved ?? null,
    final_result: t.final_result && { ...t.final_result, files: t.final_result.files ?? [] }, // always a list for clients
    llm_cost: {
      total_usd: Number(calls.reduce((x, c) => x + (c.cost_usd ?? 0), 0).toFixed(6)),
      calls: calls.length,
      unverified_signatures: calls.filter((c) => !c.signature_verified).length,
    },
  };
}
