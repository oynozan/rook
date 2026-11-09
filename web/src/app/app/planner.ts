// What the planner reports, in plain words for the page: why Rook does a part itself. Pure functions, so the tests use
// them too. Run: npx tsx --test src/app/app/*.test.ts
import type { PlanView } from './orchestrator';

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
