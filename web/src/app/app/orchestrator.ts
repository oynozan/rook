// Server-side client for the orchestrator API (docs/agentic-system.md section 8.1). It listens on localhost with no
// CORS, so the browser only ever reaches it through this app's server.
import type { Funding } from './funding';
import type { Network } from './network';

export const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:7100';

/** Service auth (SHARED API DECISION 3): every call carries ROOK_SERVICE_TOKEN when it is set. Never sent to the browser. */
export const serviceHeaders = (): Record<string, string> =>
  process.env.ROOK_SERVICE_TOKEN ? { 'x-rook-token': process.env.ROOK_SERVICE_TOKEN } : {};

export type TaskSummary = { id: string; status: string; prompt: string; created_at: string };

/** An agent the planner can hire. On the live market these come from market.near.ai. success_rate is a percentage there
 * (0 to 100) and a share (0 to 1) on the simulator. */
export type Candidate = {
  handle: string; name: string; description: string; price_atomic: string;
  sla_seconds: number; success_rate: number | null; delivered_jobs: number;
};

/**
 * What the services run with (GET /mode, SHARED API DECISION 2). `simulated`: the market, ledger or model is simulated.
 * Older orchestrators send only market, llm, ledger and paying; useMode fills in the rest.
 */
export type Mode = {
  market: 'sim' | 'live'; llm: 'canned' | 'near'; ledger: 'sim' | 'chain'; paying: boolean;
  network?: Network | 'sim'; contract_id?: string | null; usdc?: string | null; simulated?: boolean;
};

export type PlanView = {
  subtasks: {
    id: string; title: string; brief?: string; cap_atomic: string; deadline_s?: number; self_do: boolean;
    criteria: { id: string; description: string }[];
    candidates: Candidate[];
  }[];
  dropped: { title: string; reason: string }[];
  budget: { reserve_atomic: string; allocated_atomic: string };
};

export type TaskView = TaskSummary & { budget_atomic: string; error: string | null; owner: string | null; plan: PlanView | null };

/** attestation_hash is the evaluator's verdict hash: shown as "evaluation hash" (no TEE attests it yet). */
export type Receipt = {
  id: string; subtask_id?: string; agent_handle: string; a2a_task_id?: string | null; amount_atomic: string;
  verdict: 'pass' | 'fail' | null; attestation_hash?: string | null; payment_tx?: string | null; receipt_tx?: string | null;
  // Chain mode, filled by the orchestrator; the page builds its own links from the hashes. amount_atomic "0": the agent
  // delivered but no payment showed on chain.
  payment_explorer_url?: string | null; receipt_explorer_url?: string | null;
};

export type LedgerSub = { n: number; cap_atomic: string; balance_atomic: string; topped_up_atomic: string; spent_atomic: string; returned_atomic: string | null };

export type TaskSnapshot = {
  task: Omit<TaskView, 'plan'>;
  plan: PlanView | null;
  subtasks?: { id: string; n: number; status: string }[];
  receipts: Receipt[];
  // Chain mode adds contract_id and contract_task_id once the human's funding is bound to the task.
  ledger: {
    spent_atomic: string; refunded_atomic: string; reserve_used_atomic: string;
    contract_id?: string | null; contract_task_id?: string; subtasks?: LedgerSub[];
  } | null;
  final_result: { final_markdown: string; abandoned: string[] } | null;
  /** Added by this web server (api/tasks/[id]): a funding transfer the browser reported for a task not yet running. */
  funding_sent?: { contract_task_id: string; tx_hash: string | null } | null;
};

export type RookEvent = { seq: number; type: string; subtask_id?: string; data: any };

export class OrchestratorDown extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(ORCHESTRATOR + path, { cache: 'no-store', ...init, headers: { ...serviceHeaders(), ...(init?.headers as Record<string, string>) } });
  } catch {
    throw new OrchestratorDown(`cannot reach the orchestrator at ${ORCHESTRATOR}`);
  }
  const data = await r.json().catch(() => null);
  if (r.status === 401) throw new Error('The orchestrator refused this web server: ROOK_SERVICE_TOKEN differs between them.');
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
/** With `owner`, the orchestrator answers 404 for anyone else's task (the routes check the owner again). */
export const getTask = (id: string, owner?: string) => request<TaskSnapshot>(taskPath(id) + (owner ? `?owner=${encodeURIComponent(owner)}` : ''));
export const eventsUrl = (id: string, owner: string) => `${ORCHESTRATOR}${taskPath(id)}/events?owner=${encodeURIComponent(owner)}`;
/** Chain mode answers with `funding`: the transfer the owner's wallet sends. Called again, it repeats the instructions. */
export const approveTask = (id: string, owner: string) => post<TaskView & { funding?: Funding }>(`${taskPath(id)}/approve`, { funder_account: owner, owner });
/** The wallet's transfer created contract task `contract_task_id`; the orchestrator checks it against the plan, then runs. */
export const fundedTask = (id: string, contract_task_id: string, owner: string) => post<TaskView>(`${taskPath(id)}/funded`, { contract_task_id, owner });
export const cancelTask = (id: string, owner: string) => post<TaskView>(`${taskPath(id)}/cancel`, { owner });
export const killTask = (id: string, owner: string) => post<TaskView>(`${taskPath(id)}/kill`, { owner });
