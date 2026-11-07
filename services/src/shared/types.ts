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
};

// ---- Planner (section 5) ----
export type Candidate = {
  handle: string; name: string; description: string; sla_seconds: number;
  success_rate: number | null; delivered_jobs: number; price_atomic: string; quote: AcceptsRow;
};
export type PlanSubtask = {
  id: string; title: string; brief: string; search_terms: string[];
  criteria: Criterion[]; cap_atomic: string; deadline_s: number; self_do: boolean;
  candidates: Candidate[];
};
export type Plan = {
  subtasks: PlanSubtask[];
  dropped: { title: string; reason: string }[];
  budget: { budget_atomic: string; reserve_atomic: string; allocatable_atomic: string; allocated_atomic: string };
  notes: string[];
  llm_calls: LlmCall[];
};
export const PlanRequest = z.object({
  task_id: z.string(), prompt: z.string().min(1), budget_atomic: atomic, reserve_share: z.number().min(0).max(0.9),
});
export const SelfDoRequest = z.object({
  task_id: z.string(), subtask_id: z.string(), brief: z.string(), criteria: z.array(Criterion),
});
export const AggregateRequest = z.object({
  task_id: z.string(), prompt: z.string(),
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
  | 'evaluation' | 'security_alert' | 'ledger' | 'receipt' | 'final' | 'error';
export type RookEvent = { seq: number; ts: string; task_id: string; subtask_id?: string; type: EventType; data: any };
// verdict and attestation_hash are null when a paid hire was never judged (kill or evaluator outage during evaluation,
// or a payment whose outcome is unknown); a2a_task_id is null when the agent's task id was never learned.
export type Receipt = {
  id: string; task_id: string; subtask_id: string; hire_id: string; agent_handle: string; a2a_task_id: string | null;
  amount_atomic: string; verdict: 'pass' | 'fail' | null; attestation_hash: string | null; payment_hash: string;
  payment_tx: string | null; receipt_tx: string | null;
};
