// Server-side client for the orchestrator API (docs/agentic-system.md section 8.1). It listens on localhost with no
// CORS, so the browser only ever reaches it through this app's server.
import { cause, DOWN } from '@/lib/errors';
import type { Funding } from '@/lib/funding';
import type { Network } from '@/lib/network';

export const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:7100';

/** Service auth (SHARED API DECISION 3): every call carries ROOK_SERVICE_TOKEN when it is set. Never sent to the browser. */
export const serviceHeaders = (): Record<string, string> =>
  process.env.ROOK_SERVICE_TOKEN ? { 'x-rook-token': process.env.ROOK_SERVICE_TOKEN } : {};

/**
 * A task's status (services/src/shared/types.ts TaskStatus). asking: the planner needs facts only the user can give
 * (PlanView.questions); nothing is planned or funded, and the next message in the chat answers it.
 */
export type TaskStatus = 'draft' | 'asking' | 'planned' | 'approved' | 'funded' | 'running' | 'aggregating' | 'closing' | 'closed' | 'cancelled' | 'killed' | 'failed';

/**
 * parent_id: the task this one follows in its conversation; null starts a conversation. has_plan: it got a plan with
 * something to run (false for a reply that wasn't a task, a question, or a failed draft). Older orchestrators send no
 * parent_id (every task starts its own), no budget_atomic and no has_plan. supersedes / superseded_by: a message sent
 * again or edited names the one it took the place of, which names it back (chat-actions.ts shownTasks). missing: added
 * by this page, the titles of a finished run's parts that delivered nothing (the composer offers to try them again).
 */
export type TaskSummary = {
  id: string; status: TaskStatus; prompt: string; created_at: string; parent_id?: string | null; budget_atomic?: string; has_plan?: boolean;
  supersedes?: string | null; superseded_by?: string | null; missing?: string[];
  /** Added by this page from the task's plan (PlanView.action): Rook asks about an action in the world, never offering placeholders. */
  action?: boolean;
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

/**
 * Why a self_do subtask is Rook's own: no agent fits it, the ones found cost more than the budget allows, or it is a
 * small edit of delivered files Rook makes itself at once (a rename, a colour), with no agent fee and no wait.
 */
export type SelfDoReason = 'no_agent' | 'over_budget' | 'rook_edit';

export type PlanView = {
  subtasks: {
    id: string; title: string; brief?: string; cap_atomic: string; deadline_s?: number; self_do: boolean;
    /** Older plans leave it out. */
    self_do_reason?: SelfDoReason;
    /** over_budget: the cheapest quote found (atomic USDC), what one hire would have cost. Older plans leave it out. */
    self_do_need_atomic?: string;
    /** Rook may write it itself when no hired agent delivers. Absent in older plans: it may not. */
    self_do_ok?: boolean;
    /** An edit of delivered work: the conversation's files (by path) this part changes, attached to its brief whole. */
    inputs?: string[];
    /** kind and spec: how Rook checks it (services/src/shared/types.ts Criterion); older plans may leave them out. */
    criteria: { id: string; description: string; kind?: string; spec?: Record<string, unknown> }[];
    candidates: Candidate[];
  }[];
  /** reason: 'over budget' or 'no fitting agent'. need_atomic: an over-budget part's cheapest quote (older plans leave it out). */
  dropped: { title: string; reason: string; need_atomic?: string }[];
  budget: { reserve_atomic: string; allocated_atomic: string; budget_atomic?: string };
  /** The planner's notes: some are sentences for people (they start with "Rook "), the rest are its own (plan-view.ts planNotes). */
  notes?: string[];
  /** Facts only the user can give, asked instead of planning (the task is 'asking' and there are no subtasks). */
  questions?: string[];
  /** What the plan takes as given or leaves out, in plain words, shown before any money moves. */
  assumptions?: string[];
  /** An action in the world on the user's behalf (book, post, buy, deploy): Rook asks for the facts, never offers placeholders. */
  action?: boolean;
  /** Why this plan can't be funded as it is, in plain words: shown on the card in place of the funding button. */
  blocked?: string;
  /** The rules the user stated in the chat for how Rook may spend from their agent wallet (never invented). */
  spending?: SpendingRules;
};

// ---- Agent wallet (docs/agent-wallet-plan.md), as services/src/shared/types.ts has them ----

/**
 * Spending rules from the chat. budget_usd per period (no lifetime total: "only spend $1000" is a monthly budget);
 * per_task_max_usd: the most one task is funded with; approval 'every': each funding waits for the owner's vote;
 * expires_days: how long Rook's grant lasts.
 */
export type SpendingRules = {
  budget_usd?: number; period?: 'day' | 'week' | 'month'; per_task_max_usd?: number; approval?: 'every' | 'none'; expires_days?: number;
};

/** Where the agent wallet is in its one-time setup: each step is one signature by the owner. */
export type WalletSetupStep = 'create' | 'allow_destination' | 'issue_grant' | 'ready';

export type PendingApproval = { approval_id: string; task_id: string | null; amount_atomic: string; created_at: string; expires_at: string | null };

/** GET /wallet?owner=. configured false: the services have no Agent API key, and the page shows nothing of the wallet. */
export type AgentWalletView = {
  configured: boolean;
  owner: string;
  agent_id: string | null;
  near_account_id: string | null; // its NEAR Intents account, and its native NEAR account (same id)
  status: 'none' | 'pending' | 'active' | 'frozen';
  next_step: WalletSetupStep | null; // null: no wallet yet (the first step is 'create')
  rules: SpendingRules | null;
  policy: unknown | null;
  balance_atomic: string | null; // USDC in its NEAR Intents balance
  native_balance_atomic: string | null; // USDC on its native NEAR account (withdrawn, not yet spent or swept back)
  budget: { period: 'day' | 'week' | 'month'; limit_usd: number; spent_usd: number; remaining_usd: number; resets_at: string | null } | null;
  grant: { grant_id: string; expires_at: string } | null;
  pending_approvals: PendingApproval[];
};

export type OwnerIntentType = 'agent_create' | 'policy_update' | 'grant_issue' | 'approval_vote';

/** An owner intent to sign (POST /wallet/intents): nep366 is signed with signDelegateActions, nep413 with signMessage. */
export type OwnerIntentView = {
  correlation_id: string;
  type: OwnerIntentType;
  intent: { standard: 'nep366' | 'nep413'; payload: any };
  summary: string; // one sentence of what is signed
  policy?: unknown; // the policy as the wallet gets it, for policy changes
  expires_at: string;
};

/**
 * A task funded from the agent wallet, step by step: withdraw to the wallet's native account (with approval on it waits
 * in 'awaiting_approval'), then ft_transfer_call to Rook's contract ('transferring'), bound once Rook runs on it.
 */
export type WalletFunding = {
  state: 'withdrawing' | 'awaiting_approval' | 'transferring' | 'bound' | 'failed';
  agent_id: string; amount_atomic: string;
  withdraw_correlation_id?: string; approval_id?: string; call_correlation_id?: string; tx_hash?: string; error?: string;
};

/**
 * replaced_by: a plan cancelled because a revision replaced it names that revision. edited: a message that supersedes
 * another changed its text or budget (otherwise it was sent again as it was).
 */
export type TaskView = TaskSummary & {
  budget_atomic: string; error: string | null; owner: string | null; plan: PlanView | null; replaced_by?: string | null; edited?: boolean;
  /** Funded from the owner's agent wallet (POST /tasks/:id/fund-from-wallet). Older orchestrators leave it out. */
  wallet_funding?: WalletFunding | null;
};

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
 * One hire of a subtask. state: the agent's A2A state (SUBMITTED, WORKING, COMPLETED, FAILED, REJECTED, CANCELED), or
 * Rook's own: SENDING, TIMEOUT, SEND_FAILED, OUTCOME_UNKNOWN, KILLED. ended_at is null while it runs. Older
 * orchestrators send only id, agent_handle and deliverable_text.
 */
export type HireView = {
  id: string; agent_handle: string; deliverable_text: string | null;
  state?: string; started_at?: string; ended_at?: string | null; amount_atomic?: string; paid?: boolean; verdict?: 'pass' | 'fail' | null;
};

/**
 * A subtask as the run left it. A passed one's deliverable is its accepted hire's deliverable_text, or, for a part Rook
 * did itself (no hire), accepted.text. tried: the agents Rook got to, in order. Older orchestrators send only id, n
 * and status.
 */
export type SubtaskView = {
  id: string; n: number; status: string; title?: string; self_do?: boolean; final_outcome?: 'passed' | 'abandoned' | null;
  cap_atomic?: string; deadline_s?: number; tried?: string[];
  accepted?: { hire_id: string | null; agent_handle: string; text?: string } | null;
  hires?: HireView[];
  evaluations?: { hire_id: string | null; verdict: 'pass' | 'fail'; failed_criteria: string[] }[];
};

/**
 * A file a hired agent (or Rook) delivered, kept apart from the report text. `name` is its path inside the project
 * ("app/pricing/page.tsx", "postcss.config.mjs"), folders separated by "/", never absolute or "..": older results have
 * a bare name. Older results have no files at all.
 */
export type ReportFile = { subtask_id: string; agent_handle: string; name: string; mime: string; text: string };

/**
 * A paid delivery that failed Rook's checks, for a part the run left out: shown apart from the report, marked as not
 * passing. `failed`: each check it failed, in the criterion's words (`description`) and the evaluator's (`detail`).
 */
export type Unaccepted = {
  subtask_id: string; hire_id: string; agent_handle: string;
  failed: { id: string; description: string; detail: string }[];
  text: string;
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
  /**
   * changed: the paths this run delivered new or changed (the others were carried over); older reports leave it out.
   * unaccepted: for a part left out after paid deliveries failed their checks, the best of them; older reports leave it out.
   */
  final_result: { final_markdown: string; abandoned: string[]; files?: ReportFile[]; changed?: string[]; unaccepted?: Unaccepted[] } | null;
  /**
   * Added by this web server (api/tasks/[id]): a funding transfer the browser reported for a task not yet running.
   * contract_task_id is null while only its hash is known; refunded once the funder's close_task took the USDC back.
   */
  funding_sent?: { contract_task_id: string | null; tx_hash: string | null; refunded: boolean; refund_tx: string | null } | null;
};

/** ts: when Rook emitted it (ISO, Rook's clock). */
export type RookEvent = { seq: number; ts?: string; type: string; subtask_id?: string; data: any };

export class OrchestratorDown extends Error {}

/** Why a page can't load from the orchestrator, as a clause: it isn't answering, a token mismatch, or what it said. */
export const whyUnreachable = (e: unknown) => e instanceof OrchestratorDown ? DOWN
  : cause(e instanceof OrchestratorError ? e.status : null, e instanceof Error ? e.message : String(e));

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

// Agent wallet (docs/agent-wallet-plan.md). The Agent API key and Rook's grant token stay in the services: none of
// these answers carry them, and the routes pass on only the fields the page reads (agent-wallet.ts walletViewOf).
export const getWallet = (owner: string) => request<AgentWalletView>(`/wallet?owner=${encodeURIComponent(owner)}`);
/** The services build the intent from the owner's stored wallet and rules; `rules` only for agent_create. */
export const walletIntent = (owner: string, body: { type: OwnerIntentType; rules?: SpendingRules; approval_id?: string; verdict?: 'approve' | 'reject'; public_key?: string }) =>
  post<OwnerIntentView>('/wallet/intents', { owner, ...body });
/** The wallet's signature on intent `cid`, as the browser forwards it; the services check the intent is `owner`'s. */
export const submitWalletIntent = (cid: string, owner: string, signed_data: unknown) =>
  post<AgentWalletView>(`/wallet/intents/${encodeURIComponent(cid)}/submit`, { owner, signed_data });
/** Funds a planned task from the owner's agent wallet, in place of their own transfer. */
export const fundFromWallet = (id: string, owner: string) => post<TaskView>(`${taskPath(id)}/fund-from-wallet`, { owner });
