// Cross-service payloads. docs/agentic-system.md is the source of truth; keep these in sync with it.
import { z } from 'zod';

const atomic = z.string().regex(/^\d+$/, 'atomic USDC integer string');

// ---- Criteria (section 7) ----
const base = { id: z.string(), description: z.string() };
export const Criterion = z.discriminatedUnion('kind', [
  // `absent`: the text must NOT hold the pattern (a rename's old name). Without it a planner wrote "Old name is gone" as
  // a check for the old name, which every correct rename failed (t_095f2819).
  z.object({ ...base, kind: z.literal('contains'), spec: z.object({ pattern: z.string().min(1), absent: z.boolean().optional() }) }),
  z.object({ ...base, kind: z.literal('schema'), spec: z.object({ json_schema: z.record(z.string(), z.any()) }) }),
  z.object({
    ...base, kind: z.literal('numeric_match'),
    spec: z.object({ label: z.string().min(1), min: z.number().optional(), max: z.number().optional() })
      .refine((s) => s.min !== undefined || s.max !== undefined, 'numeric_match needs min or max'),
  }),
  z.object({
    ...base, kind: z.literal('cross_check'),
    spec: z.object({ label: z.string().min(1), other_subtask: z.string(), other_label: z.string().min(1), tolerance_pct: z.number().min(0) }),
  }),
  z.object({ ...base, kind: z.literal('llm_judge'), spec: z.object({ question: z.string().min(1) }) }),
  // A link the delivery gives (on a line "<label>: <url>", default label "Live URL") must load as a public web page,
  // through the same SSRF-guarded reader as reference pages, and show `must_contain` when set: a deploy is checked, not believed.
  z.object({ ...base, kind: z.literal('live_url'), spec: z.object({ label: z.string().min(1).optional(), must_contain: z.string().min(1).optional() }) }),
  // Each path must come back as a whole file (planner/files.ts reads the delivery's files): a project or an edit is
  // checked file by file, and a file holding a placeholder such as "rest of the code here" fails.
  z.object({ ...base, kind: z.literal('files'), spec: z.object({ paths: z.array(z.string().min(1)).min(1).max(60) }) }),
  // An image, video or audio the delivery gives (a file part or a link) must load through the guarded reader as that
  // kind of media, at least `min` of them (default 1): a logo or a video is checked as media, not by the reply's prose.
  z.object({ ...base, kind: z.literal('media'), spec: z.object({ kinds: z.array(z.enum(['image', 'video', 'audio'])).min(1), min: z.number().int().min(1).max(20).optional() }) }),
  // The links the delivery cites as sources must load as public pages, at least `min` of them (default 2), and a figure a
  // label line states must appear on a page cited for it when `figures` is true: a source is checked, not believed.
  z.object({ ...base, kind: z.literal('sources'), spec: z.object({ min: z.number().int().min(1).max(10).optional(), figures: z.boolean().optional() }) }),
]);
export type Criterion = z.infer<typeof Criterion>;

// ---- Market (section 9) ----
export const AcceptsRow = z.object({
  scheme: z.string(), network: z.string(), asset: z.string(), amount: atomic,
  payTo: z.string(), maxTimeoutSeconds: z.number(),
}).passthrough();
export type AcceptsRow = z.infer<typeof AcceptsRow>;

export type X402Config = { x402Version: number; recipients: { network: string; asset: string; payTo: string }[] };

export type AgentSummary = {
  handle: string; name: string; description: string; category: string | null; tags: string[];
  available_now: boolean; listing_status: string; payable_with: string[];
  sla_seconds: number; success_rate: number | null; delivered_jobs: number;
};

export type A2AState = 'SUBMITTED' | 'WORKING' | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'CANCELED';
export const TERMINAL: A2AState[] = ['COMPLETED', 'REJECTED', 'FAILED', 'CANCELED'];
export type Part = { text?: string; url?: string; raw?: string };
export type A2ATask = { id: string; context_id: string | null; state: A2AState; artifacts: { name?: string; parts: Part[] }[] };
export type GatewayError = { code: number | string; message: string };
export type GatewayResult<T> = ({ ok: true } & T) | { ok: false; error: GatewayError };

// ---- LLM (section 6.5) ----
export type LlmCall = {
  purpose: string; model: string; chat_id: string;
  request_sha256: string; response_sha256: string;
  input_tokens: number; output_tokens: number; cost_usd: number;
  signature: string | null; signing_address: string | null; signing_algo: string | null; signature_kind: string | null;
  signature_verified: boolean;
  // Verification (docs/model-choice.md): signer recovered from the signature; the signer's attestation report checked
  // (true / false, null when it could not be fetched).
  signer_recovered: boolean; attested: boolean | null; attestation_checked_at: string | null;
};

// ---- Planner (section 5) ----
// Ranked by expected cost (5.2 step 4): p_pass is the Laplace pass chance (0 to 1, 3 decimals) from the market's record
// and Rook's own verdicts, expected_cost_atomic = ceil(price / p_pass), rank_reason says how in one sentence.
export type Candidate = {
  handle: string; name: string; description: string; sla_seconds: number;
  success_rate: number | null; delivered_jobs: number; price_atomic: string; quote: AcceptsRow;
  p_pass: number; expected_cost_atomic: string; rank_reason: string;
};
/**
 * Why a subtask is self_do: no agent could be hired for it, no agent's price fit what was left of the budget, or it is a
 * small edit of delivered files Rook makes itself at once (a rename, a colour), with no agent fee and no 30 min wait.
 */
export type SelfDoReason = 'no_agent' | 'over_budget' | 'rook_edit';
export type PlanSubtask = {
  id: string; title: string; brief: string; search_terms: string[];
  category?: string; // the market category the draft named, when Rook knows it: a part carried into a later plan lists it again
  criteria: Criterion[]; cap_atomic: string; deadline_s: number; self_do: boolean;
  self_do_reason?: SelfDoReason; // set on every self_do subtask
  self_do_need_atomic?: string; // over_budget only: the cheapest quoted price, what one hire would have cost
  self_do_ok?: boolean; // Rook may write it itself when no hired agent delivers (absent in older plans: it may not)
  // An edit of delivered work: the conversation's files (by path) this part changes. They are attached to the brief
  // verbatim when the part is sent (to an agent or to Rook's own writer), never retyped by a model; the part returns
  // each changed file whole, and the report's files are the conversation's files with the changed ones replaced.
  inputs?: string[];
  candidates: Candidate[];
};
export type Plan = {
  subtasks: PlanSubtask[];
  // need_atomic: the cheapest quoted price of a part dropped as over budget, so the user sees the budget that hires one.
  dropped: { title: string; reason: string; need_atomic?: string }[];
  /**
   * reserve_bps: the reserve the funding transfer asks the contract for; every budget unit no cap takes, at most 90%.
   * from_message: budget_atomic is the total the message itself names ("make it 1 USDC"), not the one sent with it.
   */
  budget: { budget_atomic: string; reserve_atomic: string; reserve_bps?: number; allocatable_atomic: string; allocated_atomic: string; from_message?: boolean };
  notes: string[];
  /**
   * Facts only the user can give are missing (their name, projects, prices, contact details, a choice for an action
   * in the world): Rook asks these, in the user's language, instead of planning, and `subtasks` is empty. The next
   * message in the chat answers them (Conversation.questions); "use placeholders" is an answer too.
   */
  questions?: string[];
  /** What the plan takes as given or leaves out, in plain words, shown with the plan before any money moves. */
  assumptions?: string[];
  /**
   * The task is an action in the world on the user's behalf (book, call, post, buy, deploy to their account): Rook never
   * offers placeholders for it, and an action brief holding a [bracketed] placeholder is refused at planning.
   */
  action?: boolean;
  /**
   * Why this plan can't be funded as it is, in plain words (for example the files a part edits pass the 300 KB Rook
   * sends): the plan is shown, its funding button is not.
   */
  blocked?: string;
  /**
   * The rules the user stated in the chat for how Rook may spend ("Only spend $1000, every transaction comes to me for
   * approval"), never invented: they become the policy of the user's agent wallet (docs/agent-wallet-plan.md).
   */
  spending?: SpendingRules;
  llm_calls: LlmCall[];
};

// ---- Agent wallet (docs/agent-wallet-plan.md) ----

/**
 * Spending rules from the chat. budget_usd with period: the most the wallet spends per day, week or month (the Agent
 * API's USD budget has no lifetime total; "only spend $1000" is a monthly budget). per_task_max_usd: the most one task
 * may be funded with (the policy's per-transaction limit). approval "every": each funding waits for the owner's vote.
 * expires_days: how long Rook's grant lasts (at most 365).
 */
export const SpendingRules = z.object({
  budget_usd: z.number().positive().max(1_000_000).optional(),
  period: z.enum(['day', 'week', 'month']).optional(),
  per_task_max_usd: z.number().positive().max(1_000_000).optional(),
  approval: z.enum(['every', 'none']).optional(),
  expires_days: z.number().int().min(1).max(365).optional(),
});
export type SpendingRules = z.infer<typeof SpendingRules>;

/** Where a user's agent wallet is in its one-time setup: each step is one signature by the owner. */
export type WalletSetupStep = 'create' | 'allow_destination' | 'issue_grant' | 'ready';

/** What the web app shows of a user's agent wallet (GET /wallet?owner=). Amounts in USDC atomic units (6 decimals). */
export type AgentWalletView = {
  configured: boolean; // ROOK_AGENT_API_KEY is set: without it nothing below is filled
  owner: string;
  agent_id: string | null;
  near_account_id: string | null; // the wallet's NEAR Intents account, and its native NEAR account (same id)
  status: 'none' | 'pending' | 'active' | 'frozen';
  next_step: WalletSetupStep | null; // null: no wallet yet (the first step is 'create')
  rules: SpendingRules | null;
  policy: unknown | null; // the policy as the API holds it, shown as is
  balance_atomic: string | null; // USDC in the wallet's NEAR Intents balance
  native_balance_atomic: string | null; // USDC on its native NEAR account (withdrawn, not yet spent or swept back)
  budget: { period: 'day' | 'week' | 'month'; limit_usd: number; spent_usd: number; remaining_usd: number; resets_at: string | null } | null;
  grant: { grant_id: string; expires_at: string } | null;
  pending_approvals: { approval_id: string; task_id: string | null; amount_atomic: string; created_at: string; expires_at: string | null }[];
};

/**
 * An owner intent to sign (POST /wallet/intents answers this): the Agent API's generate-intent output, passed through.
 * standard nep366: sign with signDelegateActions; nep413: with signMessage (payload.nonce is base64).
 */
export type OwnerIntentView = {
  correlation_id: string;
  type: 'agent_create' | 'policy_update' | 'grant_issue' | 'approval_vote';
  intent: { standard: 'nep366' | 'nep413'; payload: any };
  summary: string; // preview.summary: one sentence of what is signed
  policy?: unknown; // preview.policy for policy changes
  expires_at: string;
};

/**
 * A task funded from the agent wallet (POST /tasks/:id/fund-from-wallet), step by step: withdraw to the wallet's native
 * account (policy-gated; with approval on it waits in 'awaiting_approval'), then ft_transfer_call to Rook's contract.
 */
export type WalletFunding = {
  state: 'withdrawing' | 'awaiting_approval' | 'transferring' | 'bound' | 'failed';
  agent_id: string;
  amount_atomic: string;
  key?: string; // this attempt's Idempotency-Key prefix: a restart repeats a call under the same key, never pays twice
  withdraw_correlation_id?: string;
  approval_id?: string;
  call_correlation_id?: string;
  tx_hash?: string;
  error?: string;
};
/**
 * Rook's own evaluator verdicts on its earlier hires of one agent (from its receipts). `stalled`: its recent hires that
 * never reached work (the paid send failed, or it timed out) since it last delivered; such an agent ranks after the others.
 */
export const AgentHistory = z.object({ pass: z.number().int().min(0), fail: z.number().int().min(0), stalled: z.number().int().min(0).optional() });
export type AgentHistory = z.infer<typeof AgentHistory>;
export const MAX_HISTORY_HANDLES = 500;
/** A follow-up's context: at most this many earlier messages (the first one and the latest), and this much of a report. */
export const CONVERSATION_MESSAGES = 12;
export const CONVERSATION_REPORT_CHARS = 12_000;
/** The conversation's current files travel whole, outside the report's limit, up to these sizes. */
export const CONVERSATION_FILES = 200;
export const CONVERSATION_FILES_CHARS = 600_000;
const Earlier = z.array(z.string().min(1)).min(1).max(CONVERSATION_MESSAGES); // each at most MAX_PROMPT_CHARS (the planner checks)
/** A file of the conversation's current work: the latest version of each path delivered in the chat. */
export const WorkFile = z.object({ path: z.string().min(1).max(300), text: z.string() });
export type WorkFile = z.infer<typeof WorkFile>;
/**
 * A part of the plan a message revises, as the user saw it: its title and brief, and the rest of the part the planner
 * keeps (its criteria, search terms, market category, whether Rook may write it, the files it edits, why Rook does it).
 * Read leniently: a field that doesn't parse is left out, never a refused request (a plan stored long ago may hold an
 * older criterion).
 */
export const PlanPart = z.object({
  title: z.string(), brief: z.string(),
  criteria: z.array(Criterion).optional().catch(undefined),
  search_terms: z.array(z.string().min(1)).min(1).max(3).optional().catch(undefined),
  category: z.string().nullish().catch(undefined),
  self_do_ok: z.boolean().optional().catch(undefined),
  inputs: z.array(z.string().min(1)).max(CONVERSATION_FILES).optional().catch(undefined),
  self_do_reason: z.string().optional().catch(undefined),
});
export type PlanPart = z.infer<typeof PlanPart>;
/**
 * The conversation a task's prompt continues (docs/agentic-system.md 5.1). `earlier`: the user's earlier messages, oldest
 * first. `revising`: the prompt changes a plan that has not run, so the whole revised task is planned. `report`: the
 * newest report in the conversation, cut to CONVERSATION_REPORT_CHARS. `files`: the conversation's current files, whole
 * (every report's files, later ones replacing earlier ones by path). `questions`: what Rook asked in reply to the newest
 * earlier message, which the prompt answers. `plan`: the parts of the plan being revised, as the user saw them.
 * `spending`: the spending rules in force in this conversation (the newest plan's Plan.spending): a later message keeps
 * them unless it changes them.
 */
export const Conversation = z.object({
  earlier: Earlier, revising: z.boolean(), report: z.string().min(1).max(CONVERSATION_REPORT_CHARS).optional(),
  files: z.array(WorkFile).max(CONVERSATION_FILES)
    .refine((fs) => fs.reduce((n, f) => n + f.text.length, 0) <= CONVERSATION_FILES_CHARS, `files hold more than ${CONVERSATION_FILES_CHARS} characters`).optional(),
  questions: z.array(z.string().min(1)).max(10).optional(),
  plan: z.array(PlanPart).max(10).optional(),
  spending: SpendingRules.optional(),
});
export type Conversation = z.infer<typeof Conversation>;
export const PlanRequest = z.object({
  task_id: z.string(), prompt: z.string().min(1), budget_atomic: atomic, reserve_share: z.number().min(0).max(0.9),
  // The contract's smallest budget, so a smaller total named in the message is refused before the market is searched.
  min_budget_atomic: atomic.optional(),
  // By agent handle; optional, so the planner also ranks without it (market record only).
  history: z.record(z.string().min(1), AgentHistory)
    .refine((h) => Object.keys(h).length <= MAX_HISTORY_HANDLES, `history lists more than ${MAX_HISTORY_HANDLES} handles`).optional(),
  conversation: Conversation.optional(),
});
export const SelfDoRequest = z.object({
  task_id: z.string(), subtask_id: z.string(), brief: z.string(), criteria: z.array(Criterion),
  files: z.array(WorkFile).max(CONVERSATION_FILES).optional(), // the part's inputs, whole: an edit starts from them
});
export const AggregateRequest = z.object({
  task_id: z.string(), prompt: z.string(),
  earlier: Earlier.optional(), // the conversation's earlier messages, oldest first: what the prompt changes or builds on
  subtasks: z.array(z.object({
    id: z.string(), title: z.string(), status: z.string(),
    agent_handle: z.string().optional(), deliverable_text: z.string().optional(),
  })),
});
/**
 * A code file taken out of a merged delivery as written (5.4): the web app offers it to open or save. `name` is its
 * path inside the project ("app/pricing/page.tsx", "postcss.config.mjs"), folders separated by "/", never absolute or "..".
 */
export type DeliveredFile = { subtask_id: string; agent_handle: string; name: string; mime: string; text: string };
export type AggregateResult = {
  final_markdown: string; attribution: { subtask_id: string; agent_handle: string }[];
  files: DeliveredFile[]; // always present, possibly empty
  llm_calls: LlmCall[];
};
/**
 * A part that ended abandoned after paid deliveries failed their checks: the best of them, shown to the user marked as
 * not passing, with the checks it failed (`description`: the criterion's, or what a built-in check asks). Kept apart
 * from the report: never in its text or files, so an edit never builds on it.
 */
export type Unaccepted = {
  subtask_id: string; hire_id: string; agent_handle: string;
  failed: { id: string; description: string; detail: string }[];
  text: string;
};

// ---- Evaluator (section 6) ----
export const EvaluateRequest = z.object({
  task_id: z.string(), subtask_id: z.string(), brief: z.string(),
  criteria: z.array(Criterion),
  // An edit's input files as they were before it: the evaluator checks the edit against them (only what was asked
  // changed, nothing cut off) and never flags text the files already held as the agent's own.
  inputs: z.array(WorkFile).max(CONVERSATION_FILES).optional(),
  deliverable: z.object({ text: z.string(), parts: z.array(z.object({ text: z.string().optional(), url: z.string().optional(), raw: z.string().optional() })) }),
  peers: z.array(z.object({ subtask_id: z.string(), text: z.string() })).default([]),
});
export type EvaluateRequest = z.infer<typeof EvaluateRequest>;
export type CriterionResult = { criterion_id: string; kind: string; passed: boolean; skipped: boolean; detail: string };
export type Extracted = Record<string, { value: number; quote: string } | null>;
export type Evaluation = {
  verdict: 'pass' | 'fail';
  results: CriterionResult[];
  failed_criteria: string[];
  security_flags: string[];
  extracted: Extracted;
  llm_calls: LlmCall[];
  engine: 'local';
  attestation_hash: string;
};

// ---- Orchestrator (section 8) ----
// asking: the planner needs facts only the user can give (Plan.questions); nothing is planned or funded, and the next
// message in the chat answers it.
export type TaskStatus = 'draft' | 'asking' | 'planned' | 'approved' | 'funded' | 'running' | 'aggregating' | 'closing' | 'closed' | 'cancelled' | 'killed' | 'failed';
export type SubtaskStatus = 'pending' | 'funded' | 'quoting' | 'working' | 'evaluating' | 'passed' | 'abandoned' | 'returned';
export type EventType = 'task_status' | 'subtask_status' | 'plan' | 'quote' | 'quote_rejected' | 'hire_sent' | 'a2a_state'
  | 'evaluation' | 'security_alert' | 'ledger' | 'receipt' | 'final' | 'error'
  | 'planning'; // progress while the plan is drafted: { stage: 'drafting' | 'searching' | 'found' | 'quoting', ... }
export type RookEvent = { seq: number; ts: string; task_id: string; subtask_id?: string; type: EventType; data: any };
// verdict and attestation_hash are null when a paid hire was never judged (kill or evaluator outage during evaluation,
// or a payment whose outcome is unknown); a2a_task_id is null when the agent's task id was never learned.
export type Receipt = {
  id: string; task_id: string; subtask_id: string; hire_id: string; agent_handle: string; a2a_task_id: string | null;
  amount_atomic: string; verdict: 'pass' | 'fail' | null; attestation_hash: string | null; payment_hash: string;
  payment_tx: string | null; receipt_tx: string | null;
  // ROOK_LEDGER=chain: the sub-account's USDC balance read right after the hire settled (no indexer yet).
  evidence?: { account_id: string; ft_balance_atomic: string };
};
