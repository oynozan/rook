// Server-side client for the orchestrator API (docs/agentic-system.md section 8.1). It listens on localhost with no
// CORS, so the browser only ever reaches it through this app's server.
import type { Funding } from '@/lib/funding';
import type { Network } from '@/lib/network';

export const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:7100';

/** Service auth (SHARED API DECISION 3): every call carries ROOK_SERVICE_TOKEN when it is set. Never sent to the browser. */
export const serviceHeaders = (): Record<string, string> =>
  process.env.ROOK_SERVICE_TOKEN ? { 'x-rook-token': process.env.ROOK_SERVICE_TOKEN } : {};

/**
 * parent_id: the task this one follows in its conversation; null starts a conversation. has_plan: it got a plan with
 * something to run (false for a reply that wasn't a task, or a failed draft). Older orchestrators send no parent_id
 * (every task starts its own), no budget_atomic and no has_plan. supersedes / superseded_by: a message sent again or
 * edited names the one it took the place of, which names it back (chat-actions.ts shownTasks).
 */
export type TaskSummary = {
  id: string; status: string; prompt: string; created_at: string; parent_id?: string | null; budget_atomic?: string; has_plan?: boolean;
  supersedes?: string | null; superseded_by?: string | null;
};

/**
 * An agent the planner can hire, in the order Rook hires them: lowest expected cost first (price divided by the chance it
 * passes, from the market's record and Rook's own verdicts). success_rate is a percentage (0 to 100). Older
 * orchestrators send no p_pass, expected_cost_atomic or rank_reason.
 */
export type Candidate = {
  handle: string; name: string; description: string; price_atomic: string;
  sla_seconds: number; success_rate: number | null; delivered_jobs: number;
  p_pass?: number; expected_cost_atomic?: string; rank_reason?: string;
};

/**
 * What the services run with (GET /mode, SHARED API DECISION 2). `simulated`: the market, ledger or model is simulated.
 * Older orchestrators send only market, llm, ledger and paying; useMode fills in the rest.
 */
export type Mode = {
  market: 'sim' | 'live'; llm: 'canned' | 'near'; ledger: 'sim' | 'chain'; paying: boolean;
  network?: Network | 'sim'; contract_id?: string | null; usdc?: string | null; simulated?: boolean;
  /** Chain mode: the contract's smallest budget (atomic USDC) and tasks one funder may have open at once. */
  min_budget_atomic?: string | null; max_open_tasks?: number | null; contract_owner?: string | null;
  /** The largest budget this Rook takes (atomic USDC). Older orchestrators leave it out. */
  max_budget_atomic?: string | null;
};

export type PlanView = {
  subtasks: {
    id: string; title: string; brief?: string; cap_atomic: string; deadline_s?: number; self_do: boolean;
    /** Why a self_do subtask is Rook's own: no agent fits it, or the ones found cost more than the budget allows. Older plans leave it out. */
    self_do_reason?: 'no_agent' | 'over_budget';
    /** over_budget: the cheapest quote found (atomic USDC), what one hire would have cost. Older plans leave it out. */
    self_do_need_atomic?: string;
    criteria: { id: string; description: string }[];
    candidates: Candidate[];
  }[];
  dropped: { title: string; reason: string }[];
  budget: { reserve_atomic: string; allocated_atomic: string };
};

/**
 * replaced_by: a plan cancelled because a revision replaced it names that revision. edited: a message that supersedes
 * another changed its text or budget (otherwise it was sent again as it was).
 */
export type TaskView = TaskSummary & { budget_atomic: string; error: string | null; owner: string | null; plan: PlanView | null; replaced_by?: string | null; edited?: boolean };

/** attestation_hash is the evaluator's verdict hash: shown as "evaluation hash" (no TEE attests it yet). */
export type Receipt = {
  id: string; subtask_id?: string; agent_handle: string; a2a_task_id?: string | null; amount_atomic: string;
  verdict: 'pass' | 'fail' | null; attestation_hash?: string | null; payment_tx?: string | null; receipt_tx?: string | null;
  // Chain mode, filled by the orchestrator; the page builds its own links from the hashes. amount_atomic "0": the agent
  // delivered but no payment showed on chain.
  payment_explorer_url?: string | null; receipt_explorer_url?: string | null;
};

/** authorized_atomic: a payment authorization still outstanding (it may yet settle). */
export type LedgerSub = {
  n: number; cap_atomic: string; balance_atomic: string; topped_up_atomic: string; spent_atomic: string; returned_atomic: string | null;
  authorized_atomic?: string | null;
};

/**
 * A subtask as the run left it. A passed one's deliverable is its accepted hire's deliverable_text, or, for a part Rook
 * did itself (no hire), accepted.text. Older orchestrators send only id, n and status.
 */
export type SubtaskView = {
  id: string; n: number; status: string; title?: string; self_do?: boolean; final_outcome?: 'passed' | 'abandoned' | null;
  accepted?: { hire_id: string | null; agent_handle: string; text?: string } | null;
  hires?: { id: string; agent_handle: string; deliverable_text: string | null }[];
};

export type TaskSnapshot = {
  task: Omit<TaskView, 'plan'>;
  plan: PlanView | null;
  subtasks?: SubtaskView[];
  receipts: Receipt[];
  // Chain mode adds contract_id and contract_task_id once the human's funding is bound to the task.
  ledger: {
    spent_atomic: string; refunded_atomic: string; reserve_used_atomic: string;
    /** The contract closed the task and refunded the funder (older orchestrators leave it out). */
    closed?: boolean;
    contract_id?: string | null; contract_task_id?: string; subtasks?: LedgerSub[];
  } | null;
  final_result: { final_markdown: string; abandoned: string[] } | null;
  /**
   * Added by this web server (api/tasks/[id]): a funding transfer the browser reported for a task not yet running.
   * contract_task_id is null while only its hash is known; refunded once the funder's close_task took the USDC back.
   */
  funding_sent?: { contract_task_id: string | null; tx_hash: string | null; refunded: boolean; refund_tx: string | null } | null;
};

export type RookEvent = { seq: number; type: string; subtask_id?: string; data: any };

export class OrchestratorDown extends Error {}

/**
 * The orchestrator answered with an error: its HTTP status, its own message, and what it adds for some (`details`: a
 * refused chat delete names the task that holds the money as `task_id`).
 */
export class OrchestratorError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) { super(message); this.status = status; this.details = details; }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(ORCHESTRATOR + path, { cache: 'no-store', ...init, headers: { ...serviceHeaders(), ...(init?.headers as Record<string, string>) } });
  } catch {
    throw new OrchestratorDown(`cannot reach the orchestrator at ${ORCHESTRATOR}`);
  }
  const data = await r.json().catch(() => null);
  if (r.status === 401) throw new OrchestratorError(401, 'The orchestrator refused this web server: ROOK_SERVICE_TOKEN differs between them.');
  if (!r.ok) throw new OrchestratorError(r.status, data?.error ?? `orchestrator answered HTTP ${r.status}`, data?.details);
  return data as T;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// `owner` is always the signed-in account from the session (session.ts), never a value from the browser.
export const listTasks = (owner: string) => request<{ tasks: TaskSummary[] }>(`/tasks?owner=${encodeURIComponent(owner)}`).then((d) => d.tasks);
export const getMode = () => request<Mode>('/mode');
// wait: false returns the draft task at once; planning continues and reports progress as `planning` events.
// parent_id: the conversation's newest task, which this message follows; none starts a conversation. supersedes: the
// newest message, sent again or edited, whose place this one takes (it follows that one's parent).
export const createTask = (prompt: string, budget_usdc: string, owner: string, parent_id?: string, supersedes?: string) =>
  post<TaskView>('/tasks', { prompt, budget_usdc, owner, wait: false, ...(parent_id ? { parent_id } : {}), ...(supersedes ? { supersedes } : {}) });
/** Deletes the conversation task `id` is in, every task of it at once; answers with their ids. */
export const deleteConversation = (id: string, owner: string) =>
  post<{ deleted: string[] }>(`/conversations/${encodeURIComponent(id)}/delete`, { owner });
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
