// Cross-service payloads. docs/agentic-system.md is the source of truth; keep these in sync with it.
import { z } from 'zod';

const atomic = z.string().regex(/^\d+$/, 'atomic USDC integer string');

// ---- Criteria (section 7) ----
const base = { id: z.string(), description: z.string() };
export const Criterion = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('contains'), spec: z.object({ pattern: z.string().min(1) }) }),
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
/** Why a subtask is self_do: no agent could be hired for it, or no agent's price fit what was left of the budget. */
export type SelfDoReason = 'no_agent' | 'over_budget';
export type PlanSubtask = {
  id: string; title: string; brief: string; search_terms: string[];
  criteria: Criterion[]; cap_atomic: string; deadline_s: number; self_do: boolean;
  self_do_reason?: SelfDoReason; // set on every self_do subtask
  self_do_need_atomic?: string; // over_budget only: the cheapest quoted price, what one hire would have cost
  candidates: Candidate[];
};
export type Plan = {
  subtasks: PlanSubtask[];
  dropped: { title: string; reason: string }[];
  /** reserve_bps: the reserve the funding transfer asks the contract for; every budget unit no cap takes, at most 90%. */
  budget: { budget_atomic: string; reserve_atomic: string; reserve_bps?: number; allocatable_atomic: string; allocated_atomic: string };
  notes: string[];
  llm_calls: LlmCall[];
};
/** Rook's own evaluator verdicts on its earlier hires of one agent (from its receipts). */
export const AgentHistory = z.object({ pass: z.number().int().min(0), fail: z.number().int().min(0) });
export type AgentHistory = z.infer<typeof AgentHistory>;
export const MAX_HISTORY_HANDLES = 500;
/** A follow-up's context: at most this many earlier messages (the first one and the latest), and this much of a report. */
export const CONVERSATION_MESSAGES = 12;
export const CONVERSATION_REPORT_CHARS = 12_000;
const Earlier = z.array(z.string().min(1)).min(1).max(CONVERSATION_MESSAGES); // each at most MAX_PROMPT_CHARS (the planner checks)
/**
 * The conversation a task's prompt continues (docs/agentic-system.md 5.1). `earlier`: the user's earlier messages, oldest
 * first. `revising`: the prompt changes a plan that has not run, so the whole revised task is planned. `report`: the
 * newest report in the conversation, cut to CONVERSATION_REPORT_CHARS.
 */
export const Conversation = z.object({ earlier: Earlier, revising: z.boolean(), report: z.string().min(1).max(CONVERSATION_REPORT_CHARS).optional() });
export type Conversation = z.infer<typeof Conversation>;
export const PlanRequest = z.object({
  task_id: z.string(), prompt: z.string().min(1), budget_atomic: atomic, reserve_share: z.number().min(0).max(0.9),
  // By agent handle; optional, so the planner also ranks without it (market record only).
  history: z.record(z.string().min(1), AgentHistory)
    .refine((h) => Object.keys(h).length <= MAX_HISTORY_HANDLES, `history lists more than ${MAX_HISTORY_HANDLES} handles`).optional(),
  conversation: Conversation.optional(),
});
export const SelfDoRequest = z.object({
  task_id: z.string(), subtask_id: z.string(), brief: z.string(), criteria: z.array(Criterion),
});
export const AggregateRequest = z.object({
  task_id: z.string(), prompt: z.string(),
  earlier: Earlier.optional(), // the conversation's earlier messages, oldest first: what the prompt changes or builds on
  subtasks: z.array(z.object({
    id: z.string(), title: z.string(), status: z.string(),
    agent_handle: z.string().optional(), deliverable_text: z.string().optional(),
  })),
});
export type AggregateResult = { final_markdown: string; attribution: { subtask_id: string; agent_handle: string }[]; llm_calls: LlmCall[] };

// ---- Evaluator (section 6) ----
export const EvaluateRequest = z.object({
  task_id: z.string(), subtask_id: z.string(), brief: z.string(),
  criteria: z.array(Criterion),
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
export type TaskStatus = 'draft' | 'planned' | 'approved' | 'funded' | 'running' | 'aggregating' | 'closing' | 'closed' | 'cancelled' | 'killed' | 'failed';
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
