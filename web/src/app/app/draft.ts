// What the composer sends: checked in the browser before anything is sent, and again by the draftTask action.
import { usdc } from './funding';

export const PROMPT_MAX = 4000;

export type Budget = { ok: true; atomic: bigint; usdc: string } | { ok: false; error: string };

/**
 * The budget as typed. A comma works as the decimal point ("1,5" is 1.5), as on phone keypads in many countries.
 * `usdc` is the amount in the form the orchestrator reads ("1.50").
 */
export function parseBudget(input: string): Budget {
  const s = input.trim().replace(',', '.');
  if (!s) return { ok: false, error: 'Enter a budget, like 3.00.' };
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return { ok: false, error: 'Enter the budget as a number, like 3.00.' };
  const [, minus, whole, frac = ''] = m;
  if (frac.length > 6) return { ok: false, error: 'Use at most 6 decimals.' };
  const atomic = BigInt(whole || '0') * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  if (minus || atomic === 0n) return { ok: false, error: 'Enter an amount above 0.' };
  return { ok: true, atomic, usdc: usdc(atomic) };
}

/** The orchestrator's budget limits from GET /mode, in atomic USDC. Either may be missing (older services, or none). */
export type BudgetLimits = { min_budget_atomic?: string | null; max_budget_atomic?: string | null };

const limit = (v: string | null | undefined) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null);

export function budgetLimitError(atomic: bigint, limits: BudgetLimits | null | undefined): string | null {
  const min = limit(limits?.min_budget_atomic), max = limit(limits?.max_budget_atomic);
  if (max !== null && atomic > max) return `The largest budget is ${usdc(max)} USDC.`;
  // The budget contract refunds a transfer below its minimum, so this is said before any planning is paid for.
  if (min !== null && atomic < min) return `The smallest budget is ${usdc(min)} USDC.`;
  return null;
}

export type DraftCheck =
  | { ok: true; prompt: string; usdc: string; atomic: bigint }
  | { ok: false; prompt?: string; budget?: string };

export function checkDraft(input: { prompt: string; budget: string }, limits?: BudgetLimits | null): DraftCheck {
  const prompt = String(input.prompt ?? '').trim();
  const out: Extract<DraftCheck, { ok: false }> = { ok: false };
  if (!prompt) out.prompt = 'Describe the task first.';
  else if (prompt.length > PROMPT_MAX) out.prompt = `Keep the task under ${PROMPT_MAX} characters. This one has ${prompt.length}.`;
  const budget = parseBudget(String(input.budget ?? ''));
  const budgetError = budget.ok ? budgetLimitError(budget.atomic, limits) : budget.error;
  if (budgetError) out.budget = budgetError;
  if (out.prompt || !budget.ok || budgetError) return out;
  return { ok: true, prompt, usdc: budget.usdc, atomic: budget.atomic };
}

/**
 * POST /tasks refused the draft (HTTP 400): the field it is about, in plain words, or null when it names neither. The
 * checks above catch these first; this covers limits the page didn't know (GET /mode unreachable, a changed limit).
 */
export function draftRefusal(message: string): { prompt?: string; budget?: string } | null {
  let m = /above this Rook's limit of ([\d.]+) USDC/.exec(message);
  if (m) return { budget: `The largest budget is ${m[1]} USDC.` };
  m = /below the contract's minimum of ([\d.]+) USDC/.exec(message);
  if (m) return { budget: `The smallest budget is ${m[1]} USDC.` };
  m = /^prompt is (\d+) characters; the limit is (\d+)/.exec(message);
  if (m) return { prompt: `Keep the task under ${m[2]} characters. This one has ${m[1]}.` };
  if (/^budget|USDC amount/.test(message)) return { budget: "Rook can't use this budget. Enter an amount like 3.00." };
  return null;
}

/**
 * POST /tasks refused a message about the task it follows: the conversation is planning or running (its words are
 * written for people), has a newer message than this page knew (the draftTask action brings the list up to date, so it
 * shows above), or isn't this account's. Null for any other refusal.
 */
export function followUpRefusal(status: number, message: string): string | null {
  if (status === 409 && /^This conversation has a newer message/.test(message)) return 'This conversation has a newer message, now shown above. Send again to add yours after it.';
  if (status === 409 && /^(Wait for |Fund or cancel )/.test(message)) return message;
  if (status === 404 && /^no task /.test(message)) return "Rook has no task at this link for the wallet you're signed in with.";
  return null;
}
