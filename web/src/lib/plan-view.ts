// What the plan card says before any money moves, beyond each part's title: the most a part and the plan can cost once
// fallback agents are counted, what happens if no agent delivers, the delivered files a part edits, how long each agent
// gets, and the planner's notes a user needs (pages read or not, dead links, agents this budget can't pay). Also what a
// run's parts spent, from the reserve too. Pure functions, so the page and the tests both use them.
// Run: npx tsx --test test/*.test.ts (from web/)
import { usdc } from '@/lib/funding';
import { aboveLargest, budgetFor, tooSmall } from '@/lib/planner';
import { patienceS } from '@/lib/run-view';
import type { LedgerSub, PlanView } from '@/lib/server/orchestrator';

type Subtask = PlanView['subtasks'][number];

/**
 * ponytail: the services' default ROOK_MAX_REHIRES (2), so a part pays for at most 3 deliveries that fail their checks
 * before it is given up (runner.ts failedVerdict). A Rook run with another limit would need /mode to send it.
 */
export const MAX_PAID_HIRES = 3;

const big = (s: string | undefined) => (/^\d+$/.test(s ?? '') ? BigInt(s!) : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * The most a part can cost: each agent is paid at most once, and at most MAX_PAID_HIRES of them, so the dearest ones'
 * prices added up, but never more than its cap plus the whole reserve (top-ups come from it). Rook's own part: 0.
 */
export function partMost(s: Subtask, reserve: bigint): bigint {
  if (s.self_do) return 0n;
  const cap = big(s.cap_atomic);
  const paid = s.candidates.map((c) => big(c.price_atomic)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, MAX_PAID_HIRES);
  const most = min(paid.reduce((n, p) => n + p, 0n), cap + reserve);
  return most > cap ? most : cap;
}

/** What the plan's caps add up to, and the most it can cost: every part's most, within the caps plus the reserve. */
export function planCost(plan: Pick<PlanView, 'subtasks' | 'budget'>): { caps: bigint; most: bigint } {
  const caps = big(plan.budget.allocated_atomic), reserve = big(plan.budget.reserve_atomic);
  const most = min(plan.subtasks.reduce((n, s) => n + partMost(s, reserve), 0n), caps + reserve);
  return { caps, most: most > caps ? most : caps };
}

/** A part's money on its row: Rook's own, its cap, or the most it can cost once Rook hires the next agent. */
export function costLabel(s: Subtask, reserve: bigint): { label: string; line: string | null } {
  if (s.self_do) return { label: 'Rook does this', line: null };
  const cap = big(s.cap_atomic), most = partMost(s, reserve);
  if (most <= cap) return { label: `Cap ${usdc(cap)}`, line: `Costs at most ${usdc(cap)} USDC, its cap.` };
  return { label: `Up to ${usdc(most)}`, line: `Costs at most ${usdc(most)} USDC: its cap is ${usdc(cap)}, and the reserve pays more if Rook hires the next agent.` };
}

/** What happens to a hired part if no agent delivers: Rook writes it, or it is left out. Null for Rook's own part. */
export function fallbackLine(s: Pick<Subtask, 'self_do' | 'self_do_ok'>): string | null {
  if (s.self_do) return null;
  return s.self_do_ok
    ? 'If no agent delivers, Rook writes this part itself.'
    : "If no agent delivers, this part is left out. What isn't spent comes back to you.";
}

/** The delivered files a part edits (its inputs), or null for a part that makes something new. */
export function editLine(s: Pick<Subtask, 'inputs'>): string | null {
  const files = (s.inputs ?? []).filter(Boolean);
  if (!files.length) return null;
  const named = files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more` : files.join(', ');
  return `Edits ${named} from the work above.`;
}

/**
 * How long a hired part can take, as Rook waits (run-view.ts patienceS): each agent up to its own limit, and every
 * candidate is tried in turn. Null for Rook's own part.
 */
export function timeLine(s: Pick<Subtask, 'self_do' | 'candidates'>): string | null {
  if (s.self_do || !s.candidates.length) return null;
  const mins = Math.round(Math.max(...s.candidates.map((c) => patienceS(c.sla_seconds))) / 60);
  const n = s.candidates.length;
  return n === 1 ? `The agent gets up to ${mins} min to deliver.` : `Each agent gets up to ${mins} min to deliver; up to ${n} agents are tried.`;
}

export type NoteLine = { text: string; tone: 'normal' | 'alert' };

/** A sentence about a page Rook couldn't read or a link that doesn't work: the user should check it before paying. */
const TROUBLE = /could not|couldn't|did not|didn't|not read|doesn't|does not|failed/i;
/** The planner's own note on a fallback agent whose price no cap plus the reserve can pay (services planner/plan.ts). */
const UNPAYABLE = /^"(.+)": candidate \S+ dropped, price (\d+) exceeds cap \+ reserve$/;

/**
 * The planner's notes a user needs before paying, in plain lines. Its sentences for people (they start with "Rook ":
 * pages it read, pages it couldn't open) as they are, those about trouble as alerts; and for a part whose other agents
 * ask more than this budget can pay, what they ask and the budget that would hire one. Its other notes (quotes that
 * failed, criteria it fixed) are its own and stay out. `max`: the largest budget Rook takes (GET /mode).
 */
export function planNotes(plan: Pick<PlanView, 'subtasks' | 'budget' | 'notes'>, max?: string | null): NoteLine[] {
  const out: NoteLine[] = [];
  const unpayable = new Map<string, bigint[]>();
  for (const note of plan.notes ?? []) {
    if (note.startsWith('Rook ')) {
      // ponytail: drops the services' claim that the agent is asked to look at a page it can't open (false for a link
      // that only goes on the site); a reworded note shows as written.
      const text = note.replace(/\s*The plan asks the agent to look at it instead of describing it\.$/, '').slice(0, 400);
      out.push({ text, tone: TROUBLE.test(text) ? 'alert' : 'normal' });
      continue;
    }
    const m = note.match(UNPAYABLE);
    if (m) unpayable.set(m[1], [...(unpayable.get(m[1]) ?? []), BigInt(m[2])]);
  }
  for (const [title, prices] of unpayable) {
    const s = plan.subtasks.find((x) => x.title === title);
    if (!s) continue;
    prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const least = prices[0], most = prices[prices.length - 1], one = prices.length === 1;
    const asks = `${one ? 'Another agent' : `${prices.length} more agents`} for “${title}” ${one ? 'asks' : 'ask'} ${least === most ? usdc(least) : `${usdc(least)} to ${usdc(most)}`} USDC, more than this budget can pay.`;
    // Hired as the lead, its price takes this part's cap: the other caps stay as they are.
    const budget = budgetFor(big(plan.budget.allocated_atomic) - big(s.cap_atomic) + least);
    const largest = aboveLargest(budget, max);
    const whom = one ? 'it' : 'the cheapest';
    out.push({ text: `${asks} ${largest !== null ? tooSmall(largest, whom) : `A budget of about ${usdc(budget)} USDC would hire ${whom}.`}`, tone: 'normal' });
  }
  return out;
}

/** What a part spent beyond its cap: the reserve's share of it. A top-up returned unspent counts nothing. */
const overCap = (l: LedgerSub) => { const over = big(l.spent_atomic) - big(l.cap_atomic); return over > 0n ? over : 0n; };

/** What the run's parts spent from the reserve, from Rook's books. */
export const reserveSpent = (subs: LedgerSub[] | undefined) => (subs ?? []).reduce((n, l) => n + overCap(l), 0n);

/** A part's money during and after a run: what it spent of its cap, and what came from the reserve when it spent more. */
export function spendLabel(l: LedgerSub): string {
  const over = overCap(l);
  return over > 0n ? `${usdc(l.spent_atomic)}: ${usdc(l.cap_atomic)} cap + ${usdc(over)} reserve` : `${usdc(l.spent_atomic)} of ${usdc(l.cap_atomic)}`;
}
