// Server-side client for the orchestrator API (docs/agentic-system.md section 8.1). It listens on localhost with no
// CORS, so the browser only ever reaches it through this app's server.
export const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:7100';

export type TaskSummary = { id: string; status: string; prompt: string; created_at: string };

/** An agent the planner can hire. On the live market these come from market.near.ai. success_rate is a percentage there
 * (0 to 100) and a share (0 to 1) on the simulator. */
export type Candidate = {
  handle: string; name: string; description: string; price_atomic: string;
  sla_seconds: number; success_rate: number | null; delivered_jobs: number;
};

/** What the services run with: the simulated or live market, the canned or NEAR AI planner, and whether Rook can pay. */
export type Mode = { market: 'sim' | 'live'; llm: 'canned' | 'near'; ledger: 'sim' | 'chain'; paying: boolean };

export type PlanView = {
  subtasks: {
    id: string; title: string; cap_atomic: string; self_do: boolean;
    criteria: { id: string; description: string }[];
    candidates: Candidate[];
  }[];
  dropped: { title: string; reason: string }[];
  budget: { reserve_atomic: string; allocated_atomic: string };
};

export type TaskView = TaskSummary & { budget_atomic: string; error: string | null; owner: string | null; plan: PlanView | null };

export type Receipt = { id: string; agent_handle: string; amount_atomic: string; verdict: 'pass' | 'fail' | null };

export type TaskSnapshot = {
  task: Omit<TaskView, 'plan'>;
  plan: PlanView | null;
  receipts: Receipt[];
  ledger: { spent_atomic: string; refunded_atomic: string; reserve_used_atomic: string } | null;
  final_result: { final_markdown: string; abandoned: string[] } | null;
};

export type RookEvent = { seq: number; type: string; subtask_id?: string; data: any };

export class OrchestratorDown extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(ORCHESTRATOR + path, { cache: 'no-store', ...init });
  } catch {
    throw new OrchestratorDown(`cannot reach the orchestrator at ${ORCHESTRATOR}`);
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `orchestrator answered HTTP ${r.status}`);
  return data as T;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// `owner` is always the signed-in account from the session (session.ts), never a value from the browser.
export const listTasks = (owner: string) => request<{ tasks: TaskSummary[] }>(`/tasks?owner=${encodeURIComponent(owner)}`).then((d) => d.tasks);
export const getMode = () => request<Mode>('/mode');
// wait: false returns the draft task at once; planning continues and reports progress as `planning` events.
export const createTask = (prompt: string, budget_usdc: string, owner: string) => post<TaskView>('/tasks', { prompt, budget_usdc, owner, wait: false });
const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;
export const getTask = (id: string) => request<TaskSnapshot>(taskPath(id));
export const approveTask = (id: string, owner: string) => post<TaskView & { funding?: unknown }>(`${taskPath(id)}/approve`, { funder_account: owner, owner });
export const cancelTask = (id: string, owner: string) => post<TaskView>(`${taskPath(id)}/cancel`, { owner });
export const killTask = (id: string, owner: string) => post<TaskView>(`${taskPath(id)}/kill`, { owner });
