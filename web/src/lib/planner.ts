// What the planner reports, in plain words for the page: why a draft failed, and why Rook does a part itself. Pure
// functions, so the tests use them too. Run: npx tsx --test test/*.test.ts (from web/)
import { detail } from '@/lib/errors';
import { usdc } from '@/lib/funding';
import type { PlanView } from '@/lib/server/orchestrator';

/**
 * Why Rook couldn't draft a plan. The orchestrator stores the planner's failures as "planner: <error>"
 * (services/src/orchestrator/index.ts): internal text, so it is put in plain words here; a failure with no plainer
 * words is shown as the planner gave it (errors.ts detail), so the page still names the problem. Any
 * other error is a sentence Rook wrote for the user (the planner's answer to a message that isn't a task), shown as is.
 */
export function plannerReason(error: string): string {
  if (/^Rook's services restarted while this task was draft\b/.test(error)) return 'Rook restarted while it was planning this task, so the plan was never finished. Send the task again.';
  if (!error.startsWith('planner: ')) return error;
  const why = error.slice('planner: '.length);
  // NEAR AI, the model Rook plans with (services/src/shared/llm.ts, wrapped by the planner as "planner LLM failed: ...").
  if (why.startsWith('planner LLM failed: ')) {
    // 402 is NEAR AI refusing to bill Rook (no spending limit set up, or the credits used up): a retry can't help.
    if (/NEAR AI 402\b|no_limit_configured|No spending limit/i.test(why)) return 'NEAR AI has no credits available for Rook, so the planning model could not run.';
    if (/NEAR AI 401|invalid api key|unauthorized/i.test(why)) return "NEAR AI rejected Rook's API key, so the planning model could not run.";
    // Calls in flight hold the guard for a moment (services/src/shared/llm.ts): busy, not the daily limit.
    if (/Rook is busy/.test(why)) return 'Rook is busy. Try again in a minute.';
    if (/LLM cost guard/.test(why)) return "Rook's planner reached its daily spending limit. Try again later.";
    if (/NEAR AI (429|5\d\d)\b|failed: (fetch failed|terminated)/.test(why)) return 'The planning model is busy or out of reach right now. Try again in a minute.';
    if (/invalid JSON|no JSON object/.test(why)) return "The planning model gave an answer Rook couldn't use. Try again; rewording the task can help.";
  }
  // The market, through the market gateway: "market gateway search failed: ..." or "market gateway x402 failed: ...".
  if (/^market gateway \w+ failed/.test(why)) return 'The NEAR AI market could not be reached. Try again in a minute.';
  // The planner itself: down, or gone before it answered.
  if (/^(fetch failed|terminated|other side closed|planner ended without a plan|planner answered HTTP 5)|ECONNREFUSED|ECONNRESET/.test(why)) {
    return "Rook's planner service didn't answer (it is stopped, restarting or crashed while planning). Try again in a minute.";
  }
  if (olderNotATask(why)) return why;
  return `Rook's planner hit an error it doesn't explain further: ${detail(why)}. Try again in a moment.`;
}

/**
 * `why`, a planner failure stored as "planner: <why>", is the planner's sentence about a message that isn't a task:
 * services from before that sentence was kept as is stored it with the prefix too. Still the user's sentence.
 */
export const olderNotATask = (why: string) => !why.startsWith('planner LLM failed: ') && /not a task|read as a task Rook can plan/.test(why);

type Subtask = PlanView['subtasks'][number];
type SelfDoReason = Subtask['self_do_reason'];

/**
 * The share of every budget the planner holds back for re-hires before it hires anyone (the orchestrator's default
 * reserve_share, which every task drafted here uses), in basis points.
 */
const RESERVE_BPS = 2_000n;

/**
 * The budget that would hire the over-budget parts too, up to and including `upTo` (every one when left out): what is
 * left after the reserve must cover the plan's caps plus each such part's cheapest quote (self_do_need_atomic), as the
 * planner hires in plan order. Rounded up to a cent. An estimate, as a new draft quotes again. Null when one of those
 * parts doesn't say what its cheapest agent asks (older services), or `upTo` isn't an over-budget part.
 */
export function budgetToHire(plan: Pick<PlanView, 'subtasks' | 'budget'>, upTo?: string): bigint | null {
  if (upTo !== undefined && plan.subtasks.find((s) => s.id === upTo)?.self_do_reason !== 'over_budget') return null;
  let caps: bigint;
  try { caps = BigInt(plan.budget.allocated_atomic || '0'); } catch { return null; }
  let needs = 0n, any = false;
  for (const s of plan.subtasks) {
    if (s.self_do && s.self_do_reason === 'over_budget') {
      if (!/^\d+$/.test(s.self_do_need_atomic ?? '')) return null;
      needs += BigInt(s.self_do_need_atomic!);
      any = true;
    }
    if (s.id === upTo) break;
  }
  return any ? budgetFor(caps + needs) : null;
}

/** The least budget that leaves `caps` (atomic USDC) to allocate after the reserve, rounded up to a cent. */
export function budgetFor(caps: bigint): bigint {
  const budget = (caps * 10_000n + (10_000n - RESERVE_BPS) - 1n) / (10_000n - RESERVE_BPS);
  return ((budget + 9_999n) / 10_000n) * 10_000n;
}

/**
 * The largest budget this Rook takes (GET /mode max_budget_atomic, atomic USDC) when `budget` is above it, so no draft
 * can hire what `budget` would; null otherwise, or when the services don't say.
 */
export function aboveLargest(budget: bigint | null | undefined, max: string | null | undefined): bigint | null {
  const largest = typeof max === 'string' && /^\d+$/.test(max) ? BigInt(max) : null;
  return budget && largest !== null && budget > largest ? largest : null;
}
export const tooSmall = (largest: bigint, whom: string) => `Even the largest budget Rook takes, ${usdc(largest)} USDC, is too small to hire ${whom}.`;

/** A small edit of delivered files (a rename, a colour): Rook makes it at once, so no agent is paid or waited for. */
const ROOK_EDIT = 'Rook makes this change itself now, with no agent fee.';

/**
 * Why Rook does this part with its own model; `budget`: what would hire one (budgetToHire); `afterHired`: a hired part
 * comes before it, so took its share of the budget first; `max`: the largest budget Rook takes (GET /mode), never
 * suggested past. Older plans don't say why, so that wording claims no reason.
 */
export function selfDoWhy(s: Pick<Subtask, 'self_do_reason' | 'self_do_need_atomic'>, budget?: bigint | null, afterHired = true, max?: string | null): string {
  if (s.self_do_reason === 'rook_edit') return ROOK_EDIT;
  if (s.self_do_reason === 'no_agent') return 'No agent on the market fits this part, so Rook does it with its own model.';
  if (s.self_do_reason === 'over_budget') {
    const left = `this budget has left for it after the reserve${afterHired ? ' and the parts before it' : ''}, so Rook does it with its own model.`;
    if (!s.self_do_need_atomic) return `The agents found for this part cost more than ${left} A larger budget would hire one.`;
    const largest = aboveLargest(budget, max);
    const hire = largest !== null ? tooSmall(largest, 'one') : budget ? `A budget of about ${usdc(budget)} USDC would hire one.` : 'A larger budget would hire one.';
    return `The cheapest agent found for this part asks ${usdc(s.self_do_need_atomic)} USDC, more than ${left} ${hire}`;
  }
  return 'No agent is hired: Rook does this part with its own model.';
}

/**
 * The same for a plan that hires no agent at all, from its subtasks; `budget`: what would hire them (budgetToHire);
 * `max`: the largest budget Rook takes. A plan of one part says it of that part, in the singular (QA found "these parts"
 * and "them all" on every one-part plan).
 */
export function allSelfDoWhy(parts: Pick<Subtask, 'self_do_reason' | 'self_do_need_atomic'>[], budget?: bigint | null, max?: string | null): string {
  if (parts.length === 1) return selfDoWhy(parts[0], budget, false, max);
  const reasons = parts.map((p) => p.self_do_reason);
  const every = (r: SelfDoReason) => reasons.length > 0 && reasons.every((x) => x === r);
  const largest = aboveLargest(budget, max);
  const hire = (whom: string) => largest !== null ? tooSmall(largest, whom)
    : `Draft it again with ${budget ? `a budget of about ${usdc(budget)} USDC` : 'a larger budget'} to hire ${whom}.`;
  if (every('rook_edit')) return 'Rook makes these changes itself now, with no agent fee.';
  if (every('no_agent')) return 'No agent on the market fits these parts, so Rook does them all itself with its own model.';
  if (every('over_budget')) {
    return `The agents Rook found for these parts cost more than this budget allows, so Rook does them all itself with its own model. ${hire('them')}`;
  }
  if (reasons.includes('no_agent') && reasons.includes('over_budget')) {
    return `No agent on the market fits some of these parts, and the agents found for the others cost more than this budget allows, so Rook does them all itself with its own model. ${hire('agents for those')}`;
  }
  return 'No agent is hired for these parts, so Rook does them all itself with its own model.';
}
