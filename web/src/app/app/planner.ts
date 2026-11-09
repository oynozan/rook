// What the planner reports, in plain words for the page: why a draft failed, and why Rook does a part itself. Pure
// functions, so the tests use them too. Run: npx tsx --test src/app/app/*.test.ts
import type { PlanView } from './orchestrator';

/**
 * Why Rook couldn't draft a plan. The orchestrator stores the planner's failures as "planner: <error>"
 * (services/src/orchestrator/index.ts): internal text, so it is put in plain words here, with a plain fallback. Any
 * other error is a sentence Rook wrote for the user (the planner's answer to a message that isn't a task), shown as is.
 */
export function plannerReason(error: string): string {
  if (/^Rook's services restarted while this task was draft\b/.test(error)) return 'Rook restarted while it was planning this task, so the plan was never finished. Send the task again.';
  if (!error.startsWith('planner: ')) return error;
  const why = error.slice('planner: '.length);
  // NEAR AI, the model Rook plans with (services/src/shared/llm.ts, wrapped by the planner as "planner LLM failed: ...").
  if (why.startsWith('planner LLM failed: ')) {
    if (/no_limit_configured|No spending limit/i.test(why)) return 'NEAR AI has no credits set up for Rook, so the planning model could not run.';
    if (/NEAR AI 401|invalid api key|unauthorized/i.test(why)) return "NEAR AI rejected Rook's API key, so the planning model could not run.";
    if (/LLM cost guard/.test(why)) return "Rook's planner reached its daily spending limit. Try again later.";
    if (/NEAR AI (429|5\d\d)\b|failed: (fetch failed|terminated)/.test(why)) return 'The planning model is busy or out of reach right now. Try again in a minute.';
    if (/invalid JSON|no JSON object/.test(why)) return "The planning model gave an answer Rook couldn't use. Try again; rewording the task can help.";
  }
  // The market, through the market gateway: "market gateway search failed: ..." or "market gateway x402 failed: ...".
  if (/^market gateway \w+ failed/.test(why)) return 'The NEAR AI market could not be reached. Try again in a minute.';
  // The planner itself: down, or gone before it answered.
  if (/^(fetch failed|terminated|other side closed|planner ended without a plan|planner answered HTTP 5)|ECONNREFUSED|ECONNRESET/.test(why)) {
    return "Rook's planner could not be reached. Try again in a minute.";
  }
  return "Rook's planner hit a problem. Try again in a moment.";
}

type SelfDoReason = PlanView['subtasks'][number]['self_do_reason'];

/** Why Rook does this part with its own model. Older plans don't say, so that wording claims no reason. */
export function selfDoWhy(reason: SelfDoReason): string {
  if (reason === 'no_agent') return 'No agent on the market fits this part, so Rook does it with its own model.';
  if (reason === 'over_budget') return 'The agents found for this part cost more than this budget allows, so Rook does it with its own model. A larger budget would hire one.';
  return 'No agent is hired: Rook does this part with its own model.';
}

/** The same for a plan that hires no agent at all, from every subtask's reason. */
export function allSelfDoWhy(reasons: SelfDoReason[]): string {
  const every = (r: SelfDoReason) => reasons.length > 0 && reasons.every((x) => x === r);
  if (every('no_agent')) return 'No agent on the market fits these parts, so Rook does them all itself with its own model.';
  if (every('over_budget')) {
    return 'The agents Rook found for these parts cost more than this budget allows, so Rook does them all itself with its own model. Draft it again with a larger budget to hire them.';
  }
  if (reasons.includes('no_agent') && reasons.includes('over_budget')) {
    return 'No agent on the market fits some of these parts, and the agents found for the others cost more than this budget allows, so Rook does them all itself with its own model. Draft it again with a larger budget to hire agents for those.';
  }
  return 'No agent is hired for these parts, so Rook does them all itself with its own model.';
}
