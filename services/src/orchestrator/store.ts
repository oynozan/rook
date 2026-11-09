// Task store, events and SSE listeners (docs/agentic-system.md sections 8.2, 8.3, 8.8). Tasks live in memory while the
// orchestrator runs; with ROOK_DB set, every change is also written to SQLite (db.ts) and reloaded on start.
import { randomUUID } from 'node:crypto';
import {
  MAX_HISTORY_HANDLES, type AgentHistory, type EventType, type Evaluation, type LlmCall, type Part, type Plan, type PlanSubtask,
  type Receipt, type RookEvent, type SubtaskStatus, type TaskStatus,
} from '../shared/types.ts';
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
};

export type Task = {
  id: string; prompt: string; budget_atomic: string; reserve_share: number; funder: string | null;
  owner: string | null; // the NEAR account that drafted it, verified by the web app; null for tasks from the CLI
  // Conversations: the task this message followed (same owner), and the earlier messages it was planned with, oldest
  // first (the aggregator reads the task with them). A plan replaced by a revision names the revision.
  parent_id: string | null; earlier_prompts?: string[]; replaced_by?: string | null;
  status: TaskStatus; error: string | null; created_at: string; updated_at: string;
  plan: Plan | null; subtasks: Sub[]; receipts: ReceiptView[]; events: RookEvent[];
  final_result: { final_markdown: string; attribution: { subtask_id: string; agent_handle: string }[]; abandoned: string[] } | null;
  llm_calls: LlmCall[]; // self-do and aggregate calls (plan and evaluation calls live on the plan and evaluations)
  ledger_saved?: unknown; // the ledger's last view, kept so a reloaded task still shows what it spent
  chain?: ChainBinding | null; // ROOK_LEDGER=chain: its contract task, sub-accounts and outstanding authorizations
  // runtime only, never serialised
  listeners: Set<(e: RookEvent) => void>; abort: AbortController;
  inflight: Map<string, { subtask: Sub; hire: Hire; handle: string; a2a_task_id: string | null }>; // null: /send in flight
  allow: Recipient[];
  running?: Promise<void>; // the run (or a restore), so the unwind after a kill starts once its loops have stopped
  unwinding?: Promise<void>; // returning what is still on chain after a kill, a failure or a failed close
  salvaging?: boolean; // events still record after the terminal status while money moves back
  shutdown: AbortController; // aborted when the orchestrator stops: the unwind stops retrying, and the next start resumes it
};
type Runtime = 'listeners' | 'abort' | 'inflight' | 'allow' | 'running' | 'unwinding' | 'salvaging' | 'shutdown';
/** A task without its runtime parts: what SQLite stores. Tasks stored before conversations have no parent_id. */
export type TaskDoc = Omit<Task, Runtime | 'parent_id'> & { parent_id?: string | null };

export const TERMINAL_TASK: TaskStatus[] = ['closed', 'cancelled', 'killed', 'failed'];
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
  const { listeners: _l, abort: _a, inflight: _i, allow: _w, running: _r, unwinding: _u, salvaging: _s, shutdown: _d, ...doc } = t;
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

/**
 * Rook's own record per agent: the evaluator's verdicts on its paid hires, from every task's receipts (all stored tasks
 * are loaded at start, so with ROOK_DB this spans restarts). Unjudged receipts (verdict null) do not count. The planner
 * ranks with it (docs/agentic-system.md 5.2 step 4); it takes at most MAX_HISTORY_HANDLES, the most-judged first.
 */
export function verdictHistory(tasks: Iterable<Task>): Record<string, AgentHistory> {
  const by = new Map<string, AgentHistory>();
  for (const t of tasks) {
    for (const r of t.receipts) {
      if (r.verdict !== 'pass' && r.verdict !== 'fail') continue;
      const h = by.get(r.agent_handle) ?? { pass: 0, fail: 0 };
      h[r.verdict]++;
      by.set(r.agent_handle, h);
    }
  }
  const jobs = (h: AgentHistory) => h.pass + h.fail;
  return Object.fromEntries([...by].sort((a, b) => jobs(b[1]) - jobs(a[1])).slice(0, MAX_HISTORY_HANDLES));
}

export function taskView(t: Task) {
  const { id, status, prompt, budget_atomic, reserve_share, funder, owner, parent_id, error, created_at, updated_at, plan } = t;
  return { id, status, prompt, budget_atomic, reserve_share, funder, owner, parent_id, replaced_by: t.replaced_by ?? null, error, created_at, updated_at, plan };
}

/** The task and the tasks above it in its conversation, nearest first. */
export function ancestors(t: Task, byId: Map<string, Task>): Task[] {
  const out: Task[] = [];
  for (let x: Task | undefined = t; x && !out.includes(x); x = x.parent_id ? byId.get(x.parent_id) : undefined) out.push(x);
  return out;
}

/**
 * The plan a new message after `chain[0]` changes: the nearest planned task, reached only through messages that never
 * got a plan to run (a reply that is not a task, a planner failure, a draft stopped while planning). Null: the new
 * message follows up on work that ended.
 */
export function openPlan(chain: Task[]): Task | null {
  for (const x of chain) {
    if (x.status === 'planned') return x;
    if (!isTerminal(x.status) || x.subtasks.length) return null;
  }
  return null;
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
    final_result: t.final_result,
    llm_cost: {
      total_usd: Number(calls.reduce((x, c) => x + (c.cost_usd ?? 0), 0).toFixed(6)),
      calls: calls.length,
      unverified_signatures: calls.filter((c) => !c.signature_verified).length,
    },
  };
}
