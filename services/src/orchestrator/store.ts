// Task store, events and SSE listeners (docs/agentic-system.md sections 8.2, 8.3, 8.8). Tasks live in memory while the
// orchestrator runs; with ROOK_DB set, every change is also written to SQLite (db.ts) and reloaded on start.
import { randomUUID } from 'node:crypto';
import type {
  EventType, Evaluation, LlmCall, Part, Plan, PlanSubtask, Receipt, RookEvent, SubtaskStatus, TaskStatus,
} from '../shared/types.ts';
import type { Ledger, Recipient } from './ledger.ts';

export type Hire = {
  id: string; subtask_id: string; agent_handle: string; amount_atomic: string; payment_hash: string;
  a2a_task_id: string | null; context_id: string | null;
  state: string; // A2A state, or SENDING / TIMEOUT / SEND_FAILED / OUTCOME_UNKNOWN / KILLED
  paid: boolean; deliverable_text: string | null; parts: Part[]; verdict: 'pass' | 'fail' | null;
  started_at: string; ended_at: string | null;
};

export type Sub = PlanSubtask & {
  n: number; status: SubtaskStatus; final_outcome: 'passed' | 'abandoned' | null; rehire_count: number;
  tried: string[]; hires: Hire[]; evaluations: (Evaluation & { hire_id: string | null })[];
  accepted: { hire_id: string | null; agent_handle: string; text: string } | null;
};

export type Task = {
  id: string; prompt: string; budget_atomic: string; reserve_share: number; funder: string | null;
  owner: string | null; // the NEAR account that drafted it, verified by the web app; null for tasks from the CLI
  status: TaskStatus; error: string | null; created_at: string; updated_at: string;
  plan: Plan | null; subtasks: Sub[]; receipts: Receipt[]; events: RookEvent[];
  final_result: { final_markdown: string; attribution: { subtask_id: string; agent_handle: string }[]; abandoned: string[] } | null;
  llm_calls: LlmCall[]; // self-do and aggregate calls (plan and evaluation calls live on the plan and evaluations)
  ledger_saved?: unknown; // the ledger's last view, kept so a reloaded task still shows what it spent
  // runtime only, never serialised
  listeners: Set<(e: RookEvent) => void>; abort: AbortController;
  inflight: Map<string, { subtask: Sub; hire: Hire; handle: string; a2a_task_id: string | null }>; // null: /send in flight
  allow: Recipient[];
};

export const TERMINAL_TASK: TaskStatus[] = ['closed', 'cancelled', 'killed', 'failed'];
export const isTerminal = (s: TaskStatus) => TERMINAL_TASK.includes(s);
export const now = () => new Date().toISOString();

// Called after every change to a task; the orchestrator points it at SQLite when ROOK_DB is set.
let persist: ((t: Task) => void) | null = null;
export function persistWith(fn: ((t: Task) => void) | null) { persist = fn; }
export const saveTask = (t: Task) => persist?.(t);

/** The task without its runtime parts, ready to store. */
export function toDoc(t: Task) {
  const { listeners: _l, abort: _a, inflight: _i, allow: _w, ...doc } = t;
  return doc;
}

/** A stored task with fresh runtime parts. */
export function fromDoc(doc: Omit<Task, 'listeners' | 'abort' | 'inflight' | 'allow'>): Task {
  // Tasks saved before owners existed have none; they stay out of every account's list.
  return { ...doc, owner: doc.owner ?? null, listeners: new Set(), abort: new AbortController(), inflight: new Map(), allow: [] };
}

export function newTask(prompt: string, budget_atomic: bigint, reserve_share: number, owner: string | null = null): Task {
  const ts = now();
  const t: Task = {
    id: `t_${randomUUID().slice(0, 8)}`, prompt, budget_atomic: budget_atomic.toString(), reserve_share, funder: null, owner,
    status: 'draft', error: null, created_at: ts, updated_at: ts,
    plan: null, subtasks: [], receipts: [], events: [], final_result: null, llm_calls: [],
    listeners: new Set(), abort: new AbortController(), inflight: new Map(), allow: [],
  };
  emit(t, 'task_status', { from: null, to: 'draft' });
  return t;
}

export function setPlan(t: Task, plan: Plan) {
  t.plan = plan;
  t.subtasks = plan.subtasks.map((s, i) => ({
    ...s, n: i + 1, status: 'pending', final_outcome: null, rehire_count: 0, tried: [], hires: [], evaluations: [], accepted: null,
  }));
  saveTask(t);
}

/** Append and broadcast. Nothing is emitted after the terminal task_status event, so SSE can end on it. */
export function emit(t: Task, type: EventType, data: any, subtask_id?: string) {
  if (isTerminal(t.status)) return;
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

export function taskView(t: Task) {
  const { id, status, prompt, budget_atomic, reserve_share, funder, owner, error, created_at, updated_at, plan } = t;
  return { id, status, prompt, budget_atomic, reserve_share, funder, owner, error, created_at, updated_at, plan };
}

export function snapshot(t: Task, ledger: Ledger) {
  const { plan, ...task } = taskView(t);
  const calls = [...(plan?.llm_calls ?? []), ...t.subtasks.flatMap((s) => s.evaluations.flatMap((e) => e.llm_calls ?? [])), ...t.llm_calls];
  return {
    task, plan,
    subtasks: t.subtasks.map((s) => ({
      id: s.id, n: s.n, title: s.title, status: s.status, final_outcome: s.final_outcome, self_do: s.self_do,
      cap_atomic: s.cap_atomic, deadline_s: s.deadline_s, rehire_count: s.rehire_count, tried: s.tried,
      accepted: s.accepted && { hire_id: s.accepted.hire_id, agent_handle: s.accepted.agent_handle },
      hires: s.hires, evaluations: s.evaluations,
    })),
    receipts: t.receipts,
    ledger: ledger.view(t.id) ?? t.ledger_saved ?? null,
    final_result: t.final_result,
    llm_cost: {
      total_usd: Number(calls.reduce((x, c) => x + (c.cost_usd ?? 0), 0).toFixed(6)),
      calls: calls.length,
      unverified_signatures: calls.filter((c) => !c.signature_verified).length,
    },
  };
}
