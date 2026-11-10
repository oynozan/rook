// Deterministic half of planning (docs/agentic-system.md 5.2 steps 2 and 4 to 9, section 7 rules).
// No I/O and no LLM here: index.ts gathers search results, selections and quotes, then calls buildPlan.
import { Ajv } from 'ajv';
import { z } from 'zod';
import { config } from '../shared/config.ts';
import { AcceptsRow, CONVERSATION_FILES, Criterion, type AgentHistory, type AgentSummary, type Candidate, type Plan, type PlanSubtask, type SelfDoReason, type X402Config } from '../shared/types.ts';
import { formatUsdc, parseUsdc, share } from '../shared/money.ts';

// Draft as the LLM writes it. Criteria are loose here on purpose: an invalid one is removed with a note
// (step 8) instead of failing the whole draft. Cross-check `other_subtask` uses draft ids s1..sN by position.
export const DraftCriterion = z.object({
  id: z.string().optional(),
  kind: z.string(),
  description: z.string().default(''),
  spec: z.record(z.string(), z.unknown()),
});
export const DraftSubtask = z.object({
  title: z.string().min(1),
  brief: z.string().min(1),
  search_terms: z.array(z.string().min(1)).min(1).max(3),
  // The market category whose agents do this kind of work; one Rook does not know is ignored, never a failed draft.
  category: z.string().nullish(),
  self_do_ok: z.boolean(),
  criteria: z.array(DraftCriterion),
  // An edit of delivered work: the conversation's files (by path) it changes or builds on. buildPlan keeps known paths only.
  inputs: z.array(z.string().min(1)).max(CONVERSATION_FILES).nullish(),
  // A small mechanical edit of those files (a rename, a colour, a link) that Rook makes itself at once.
  rook_edit: z.boolean().nullish(),
});
const isUsdc = (v: number | string) => { try { parseUsdc(v); return true; } catch { return false; } };
export const MAX_QUESTIONS = 5;
export const MAX_ASSUMPTIONS = 5;
const lines = (n: number, what: string) => z.array(z.string().trim().min(1).max(400)).max(n, `at most ${n} ${what}`).nullish();
// No subtasks only with `not_a_task` (the message is not a task to plan: "go ahead", "hi"; that sentence says why) or
// with `questions` (facts only the user can give are missing). `budget_usdc`: the total budget the message itself
// names ("make it 1 USDC"), in USDC; absent when it names none.
export const Draft = z.object({
  subtasks: z.array(DraftSubtask).max(5),
  not_a_task: z.string().optional(),
  questions: lines(MAX_QUESTIONS, 'questions'),
  assumptions: lines(MAX_ASSUMPTIONS, 'assumptions'),
  budget_usdc: z.union([z.number(), z.string()]).nullish()
    .refine((v) => v == null || isUsdc(v), 'budget_usdc must be an amount of USDC such as 1.5, with at most 6 decimals'),
}).refine((d) => d.subtasks.length > 0 || !!d.not_a_task?.trim() || !!d.questions?.length, 'return at least one subtask, or questions, or set not_a_task')
  .refine((d) => !(d.questions?.length && d.subtasks.length), 'return either questions with no subtasks, or subtasks with no questions');
export type DraftSubtask = z.infer<typeof DraftSubtask>;
export type Draft = z.infer<typeof Draft>;

/**
 * What a brief must never hold (QA: briefs leaked the planner's self-corrections, "Acceptance:" lines, the earlier
 * messages, a "Word count: N" line that ended up in the user's CV, and a way out: "if you don't receive the file, build
 * it yourself"). A brief goes verbatim to an agent that knows nothing else. Narrow on purpose: "do not invent", "what
 * users actually use" and "the first message of the sequence" are fine.
 */
const BRIEF_RULES: [RegExp, string][] = [
  [/(?:[—–]|--|[.;!?(]|^)\s*actually[,:]?\s+(?:use|make|write|keep|call|name|change|put|set|go with|no)\b|\bscratch that\b|\bon second thought\b|\bwait,\s+(?:no|actually)\b/im,
    'corrects itself: write only the final instruction'],
  [/\b(?:earlier|previous|prior) (?:messages?|requests?|plans?|briefs?|reports?|conversation|chat)\b|\b(?:this|our) (?:conversation|chat)\b|\bthe (?:report|plan|message) above\b/i,
    'mentions the conversation or an earlier message, plan or report, which the agent never sees: write out what it needs'],
  [/^\W*acceptance\b[^:\n]{0,20}:|\b(?:will|would) be (?:checked|evaluated|verified|graded|judged|scored) (?:automatically|by (?:rook|an? (?:llm|script|model|evaluator)))\b/im,
    'says how the work is checked: leave that out'],
  [/\b(?:word|character) count\s*:|\b(?:print|state|give|add|include|end with)\b[^.\n]{0,40}\b(?:word|character) count\b/i,
    'asks for a word or character count line, which would end up in the work: Rook judges length itself'],
  [/\bif you (?:do not|don't|did not|didn't|cannot|can't|could not|couldn't) (?:receive|get|find|have|access|open|see)\b[^.\n]{0,30}\bfiles?\b|\bif you (?:truly |really )?(?:cannot|can't|could not|couldn't|are unable to) deploy\b/i,
    'gives the agent a way out (build it yourself, report no link): ask for exactly the work'],
];
/** The rules a brief breaks, each with the words that break it. */
export function briefProblems(brief: string): string[] {
  return BRIEF_RULES.flatMap(([re, why]) => {
    const m = re.exec(brief);
    return m ? [`${why} ("${m[0].trim().slice(0, 60)}")`] : [];
  });
}
/** Every rule the draft's briefs break, by subtask, worded for the model and for a plan note alike. */
export const draftProblems = (subtasks: DraftSubtask[]) =>
  subtasks.flatMap((s) => briefProblems(s.brief).map((p) => `the brief of "${s.title}" ${p}`));

// A line that only says how the work is checked can go without asking the model again.
const CHECK_LINE = /^\W*acceptance\b[^:\n]{0,20}:/i;
/**
 * The brief as sent: lines about checking dropped, and the title on the first line, then a blank line (some briefs
 * opened with "NEAR token due diligence (part 1): overview and market data. Research ...").
 */
export function repairBrief(title: string, brief: string): string {
  const body = brief.replace(/\r\n/g, '\n').split('\n').filter((l) => !CHECK_LINE.test(l)).join('\n').trim();
  const [first, second] = body.split('\n');
  if (!body) return title.trim();
  return first.trim().length <= 100 && (second === undefined || !second.trim()) ? body : `${title.trim()}\n\n${body}`;
}

/** A path inside a project as Rook keeps it: relative, "/"-separated, no "." or ".." segment; undefined when it isn't one. */
export function cleanPath(p: string): string | undefined {
  const s = p.trim().replace(/^(?:\.?\/)+/, '');
  if (!s || s.includes('\\') || /^[a-z]:/i.test(s) || s.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return undefined;
  return s;
}
/**
 * A subtask's inputs that are files of this conversation, and those that are not. A bare name ("index.html") finds the
 * one file of that name in a folder ("public/index.html").
 */
export function inputsOf(d: DraftSubtask, files: string[]): { kept: string[]; unknown: string[] } {
  const kept: string[] = [], unknown: string[] = [];
  for (const raw of d.inputs ?? []) {
    const p = cleanPath(raw);
    const named = p && !p.includes('/') ? files.filter((f) => f.split('/').pop() === p) : [];
    const hit = p && files.includes(p) ? p : named.length === 1 ? named[0] : undefined;
    if (!hit) unknown.push(raw);
    else if (!kept.includes(hit)) kept.push(hit);
  }
  return { kept, unknown };
}
// A contains pattern that only asks for a link ("URL: https?://", "Live URL:"): any string passed it, a 404 included.
const LINK_ONLY = /^(live)?url(https?s?)?$/;
const linkOnly = (pattern: unknown) => typeof pattern === 'string' && LINK_ONLY.test(pattern.toLowerCase().replace(/[^a-z]/g, ''));
/** Rook can write a part itself unless it must be deployed: no model output can pass a live link check. */
const writable = (d: DraftSubtask) => d.self_do_ok && !d.criteria.some((c) => c.kind === 'live_url' || (c.kind === 'contains' && linkOnly(c.spec.pattern)));
/** A small edit Rook makes itself at once, with no agent fee and no wait: it needs files of this conversation to edit. */
export const isRookEdit = (d: DraftSubtask, files: string[]) => !!d.rook_edit && writable(d) && inputsOf(d, files).kept.length > 0;

export type QuoteResult = { ok: true; row: unknown } | { ok: false; error: { code: number | string; message: string } };

/**
 * The market's agent categories (GET /v1/agents?category=..., as listed on 2026-11-10). A subtask's category lists
 * that category's agents next to its keyword searches: keyword search finds only agents whose description names the
 * topic, so a "portfolio website" found 9 agents of five categories, while dev_tools lists 43 available ones.
 */
export const MARKET_CATEGORIES = ['research', 'data', 'finance', 'creative', 'marketing', 'dev_tools', 'automation',
  'legal_compliance', 'sales', 'operations', 'customer_support', 'travel', 'events', 'other'] as const;
export const marketCategory = (c: string | null | undefined) =>
  (MARKET_CATEGORIES as readonly string[]).includes(c ?? '') ? c! : undefined;

export const DEFAULT_JUDGE = 'Does the deliverable fully answer the brief with specific content rather than generic filler?';
const MAX_PER_SUBTASK = 12;
// ponytail: a category listing shown to the select step is cut at 60 agents to bound its prompt; the market lists 56 at most today.
export const MAX_CATEGORY_LISTED = 60;
const MAX_JUDGES = 2;

export const hireable = (a: AgentSummary) => a.available_now && a.listing_status === 'live' && !!a.payable_with?.includes('USDC');

/**
 * Step 2: keep agents that can be hired now with USDC, and merge the per-term results by handle, taking each term's
 * next unseen agent in turn. The first term is the generic skill and often fills every slot alone, which cut the
 * specialists the other terms found (a Solidity audit offered only generic code reviewers).
 */
export function filterSearch(resultLists: AgentSummary[][]): AgentSummary[] {
  const lists = resultLists.map((l) => l.filter(hireable));
  const byHandle = new Map<string, AgentSummary>();
  const next = lists.map(() => 0);
  for (let added = true; added && byHandle.size < MAX_PER_SUBTASK;) {
    added = false;
    lists.forEach((l, t) => {
      while (next[t] < l.length && byHandle.has(l[next[t]].handle)) next[t]++;
      if (next[t] < l.length && byHandle.size < MAX_PER_SUBTASK) { byHandle.set(l[next[t]].handle, l[next[t]]); added = true; }
    });
  }
  return [...byHandle.values()];
}

/**
 * Step 3 output hygiene: keep only handles that were in that subtask's search results, at most MAX_PICKS. Five, not
 * three: the best-described agents are often unpayable (a 14-day payment window, a 6 USDC price for a 3 USDC task),
 * and with three picks the cheap generalist behind them was never quoted, so the part fell to Rook. Quotes are free;
 * buildPlan drops whatever the budget cannot pay.
 */
export const MAX_PICKS = 5;
export function applySelection(results: AgentSummary[], handles: string[]): AgentSummary[] {
  const picked = [...new Set(handles)].map((h) => results.find((a) => a.handle === h)).filter((a): a is AgentSummary => !!a);
  return picked.slice(0, MAX_PICKS);
}

export type PlanInput = {
  draft: DraftSubtask[];
  selected: AgentSummary[][]; // per draft subtask, the agents the select step picked
  quotes: Record<string, QuoteResult>; // by handle
  recipients: X402Config['recipients'];
  budget_atomic: bigint;
  reserve_share: number;
  history?: Record<string, AgentHistory>; // Rook's own verdicts by handle; without it, the market's record alone
  files?: string[]; // the paths of the conversation's current files: the only inputs a subtask may name
};

/** The contract's ceiling on the reserve, in basis points of the budget (contract/budget/src/lib.rs MAX_RESERVE_BPS). */
export const MAX_RESERVE_BPS = 9_000;

export function buildPlan(input: PlanInput): Omit<Plan, 'llm_calls'> {
  const notes: string[] = [];
  const dropped: Plan['dropped'] = [];
  const allocatable = input.budget_atomic - share(input.budget_atomic, input.reserve_share);
  const files = input.files ?? [];
  const draft = input.draft.map((d) => {
    if (d.self_do_ok && !writable(d)) notes.push(`"${d.title}": Rook can't put work online, so it can't write this part itself`);
    return writable(d) === d.self_do_ok ? d : { ...d, self_do_ok: false };
  });
  const inputs = draft.map((d) => {
    const { kept: ok, unknown } = inputsOf(d, files);
    for (const p of unknown) notes.push(`"${d.title}": input ${p} dropped, it is not one of this conversation's files`);
    return ok;
  });
  const edits = draft.map((d) => isRookEdit(d, files));
  draft.forEach((d, i) => {
    if (d.rook_edit && !edits[i]) notes.push(`"${d.title}" is not a Rook edit: ${inputs[i].length ? 'Rook can\'t write it itself' : 'it changes no file of this conversation'}`);
  });

  // Steps 4 to 7, in priority order. `draftIdx` keeps the draft position for cross-check rewriting.
  type Kept = { draftIdx: number; d: DraftSubtask; candidates: Candidate[]; cap: bigint; self_do: boolean; self_do_reason?: SelfDoReason; need?: bigint };
  const kept: Kept[] = [];
  let allocated = 0n;
  // First pass: a subtask is hired when one of its agents fits what is left to allocate, at that agent's price. The
  // first hire must fit the cap, so the first-ranked agent that fits leads, and the agents ranked above it follow it
  // in rank order: the reserve may still pay one as a fallback (the prune pass drops those it never can). Fallback
  // cover comes in the second pass, so it never costs a later subtask its agent.
  // Subtasks only an agent can do (not self_do_ok) are funded first, in priority order, then the rest: a part Rook can
  // write itself must not take the money a later part needs and be dropped for.
  const order = draft.map((d, draftIdx) => ({ d, draftIdx })).sort((x, y) => Number(x.d.self_do_ok) - Number(y.d.self_do_ok));
  order.forEach(({ d, draftIdx }) => {
    // A rename or a colour is Rook's at once: no hire to wait 30 min for, no fee (QA: a colour change could cost 0.50).
    if (edits[draftIdx]) { kept.push({ draftIdx, d, candidates: [], cap: 0n, self_do: true, self_do_reason: 'rook_edit' }); return; }
    const quoted = quotedCandidates(input.selected[draftIdx] ?? [], input.quotes, input.recipients, input.history ?? {}, d.title, notes);
    const left = allocatable - allocated;
    const fits = quoted.findIndex((c) => price(c) <= left);
    if (fits >= 0) {
      const lead = quoted[fits];
      for (const c of quoted.slice(0, fits)) notes.push(`"${d.title}": candidate ${c.handle} moved after ${lead.handle}, price ${c.price_atomic} exceeds the ${left} left to allocate`);
      const candidates = [lead, ...quoted.slice(0, fits), ...quoted.slice(fits + 1)];
      allocated += price(lead);
      kept.push({ draftIdx, d, candidates, cap: price(lead), self_do: false });
      return;
    }
    const self_do_reason: SelfDoReason = quoted.length ? 'over_budget' : 'no_agent';
    if (!d.self_do_ok) { dropped.push({ title: d.title, reason: quoted.length ? 'over budget' : 'no fitting agent' }); return; }
    if (quoted.length) notes.push(`"${d.title}" is self_do: no candidate's price fits the ${left} left to allocate`);
    // Over budget: the cheapest quote is what one hire would have cost, so a client can name the budget that hires one.
    const need = quoted.length ? quoted.map(price).reduce((a, b) => (b < a ? b : a)) : undefined;
    kept.push({ draftIdx, d, candidates: [], cap: 0n, self_do: true, self_do_reason, need });
  });
  kept.sort((x, y) => x.draftIdx - y.draftIdx); // back in priority order

  // Second pass, same order: raise each cap toward fallbackCap, as far as the allocatable budget allows.
  for (const k of kept) {
    if (k.self_do) continue;
    const want = fallbackCap(k.candidates), most = k.cap + allocatable - allocated;
    const cap = want < most ? want : most;
    if (cap > k.cap) { allocated += cap - k.cap; k.cap = cap; }
  }

  // Whatever the caps leave of the budget becomes the reserve for re-hires and top-ups, up to the contract's 90%: the
  // user's budget is what Rook may spend, so it must not sit idle while a subtask is abandoned for want of a top-up
  // (seen on mainnet: 0.90 USDC unallocated, a 0.50 re-hire refused). Whole percents, so the numbers read cleanly.
  // A fallback priced above cap + the whole reserve can never be paid. A cap raised to cover one shrinks back, which
  // grows the reserve, until no cap changes (caps only shrink, so this ends).
  const payable = (k: Kept, reserve: bigint) => k.candidates.filter((c) => price(c) <= k.cap + reserve);
  let { reserve_bps, reserve } = reserveOf(input.budget_atomic, allocated);
  for (let shrunk = true; shrunk;) {
    shrunk = false;
    for (const k of kept) {
      if (k.self_do) continue;
      const cap = fallbackCap(payable(k, reserve));
      if (cap < k.cap) { allocated -= k.cap - cap; k.cap = cap; shrunk = true; }
    }
    ({ reserve_bps, reserve } = reserveOf(input.budget_atomic, allocated));
  }
  // Listing an unpayable fallback would only stretch the deadline. Any fallback can be dropped (the order is not by
  // price), never the lead, whose price the cap always covers.
  for (const k of kept) {
    if (k.self_do) continue;
    const ok = payable(k, reserve);
    for (const c of k.candidates) if (!ok.includes(c)) notes.push(`"${k.d.title}": candidate ${c.handle} dropped, price ${c.price_atomic} exceeds cap + reserve`);
    k.candidates = ok;
  }

  // Step 9 ids: draft id (s<draftIdx+1>) -> final id, for cross-check references.
  const finalId = new Map(kept.map((k, i) => [`s${k.draftIdx + 1}`, `s${i + 1}`]));

  const subtasks: PlanSubtask[] = kept.map((k, i) => {
    const id = `s${i + 1}`;
    const ins = inputs[k.draftIdx];
    return {
      id,
      title: k.d.title,
      brief: repairBrief(k.d.title, k.d.brief),
      search_terms: k.d.search_terms,
      criteria: validateCriteria(id, i, k.d.criteria, finalId, notes, ins),
      cap_atomic: k.cap.toString(),
      // Rook waits for a hire at most ROOK_HIRE_PATIENCE_S, whatever SLA the agent advertises.
      deadline_s: k.self_do ? 0 : Math.min(Math.max(...k.candidates.map((c) => c.sla_seconds)), config.hirePatienceS),
      self_do: k.self_do,
      self_do_ok: k.d.self_do_ok,
      ...(k.self_do ? { self_do_reason: k.self_do_reason } : {}),
      ...(k.need !== undefined ? { self_do_need_atomic: k.need.toString() } : {}),
      ...(ins.length ? { inputs: ins } : {}),
      candidates: k.candidates,
    };
  });

  return {
    subtasks,
    dropped,
    budget: {
      budget_atomic: input.budget_atomic.toString(),
      reserve_atomic: reserve.toString(),
      reserve_bps,
      allocatable_atomic: (input.budget_atomic - reserve).toString(),
      allocated_atomic: allocated.toString(),
    },
    notes,
  };
}

const price = (c: Candidate) => BigInt(c.price_atomic);

/**
 * The cap that covers a subtask's fallback, over its first two listed prices: min(max(first, second), 2 x first).
 * Ranked by expected cost, so the first hire is not always the cheapest: never below the first hire's price, it also
 * covers the next-listed fallback (when the first fails without charge) unless that one costs more than twice the
 * first, so one expensive candidate cannot inflate what the user locks per subtask; a pricier fallback is paid by a
 * reserve top-up. With candidates cheapest first it is min(second, 2 x first).
 */
function fallbackCap(candidates: Candidate[]): bigint {
  const first = price(candidates[0]), second = price(candidates[Math.min(1, candidates.length - 1)]);
  const both = second > first ? second : first;
  return both < first * 2n ? both : first * 2n;
}

/** The reserve: every budget unit no cap takes, in whole percents of the budget, at most MAX_RESERVE_BPS. */
function reserveOf(budget: bigint, allocated: bigint): { reserve_bps: number; reserve: bigint } {
  const reserve_bps = budget > 0n ? Math.min(MAX_RESERVE_BPS, Math.floor(Number(((budget - allocated) * 10_000n) / budget) / 100) * 100) : 0;
  return { reserve_bps, reserve: (budget * BigInt(reserve_bps)) / 10_000n };
}

/**
 * Step 4: keep agents whose quote succeeded with a row matching a /x402 recipient, ranked by expected cost (lowest
 * first), then higher p_pass, more delivered jobs, handle; agents with recent stalls in Rook's history after the rest.
 */
function quotedCandidates(agents: AgentSummary[], quotes: Record<string, QuoteResult>, recipients: X402Config['recipients'], history: Record<string, AgentHistory>, title: string, notes: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const a of agents) {
    const q = quotes[a.handle];
    if (!q) { notes.push(`"${title}": no quote from ${a.handle}`); continue; }
    if (!q.ok) { notes.push(`"${title}": quote from ${a.handle} failed (${q.error.code}: ${q.error.message})`); continue; }
    const row = AcceptsRow.safeParse(q.row);
    const r = row.success ? row.data : undefined;
    if (!r || r.scheme !== 'exact' || !recipients.some((x) => x.network === r.network && x.asset === r.asset && x.payTo === r.payTo)) {
      notes.push(`"${title}": quote from ${a.handle} dropped: row does not match the /x402 recipients`);
      continue;
    }
    // Same rule as the orchestrator's checkQuote: x402 cannot pay 0, and the contract refuses a cap of 0.
    if (BigInt(r.amount) <= 0n) {
      notes.push(`"${title}": quote from ${a.handle} dropped: amount ${r.amount} is not a payable price`);
      continue;
    }
    // The orchestrator and the signer refuse a longer payment window at hire time, so the plan never lists such an agent.
    const max = config.maxPaymentTimeoutS;
    if (!Number.isInteger(r.maxTimeoutSeconds) || r.maxTimeoutSeconds < 1 || r.maxTimeoutSeconds > max) {
      notes.push(`"${title}": quote from ${a.handle} dropped: payment window ${r.maxTimeoutSeconds} s is not from 1 to ${max} s (ROOK_MAX_PAYMENT_TIMEOUT_S)`);
      continue;
    }
    out.push({
      handle: a.handle, name: a.name, description: a.description, sla_seconds: a.sla_seconds,
      success_rate: a.success_rate, delivered_jobs: a.delivered_jobs, price_atomic: r.amount, quote: r,
      ...rank(a, r.amount, Object.hasOwn(history, a.handle) ? history[a.handle] : undefined),
    });
  }
  const stalled = (c: Candidate) => (Object.hasOwn(history, c.handle) ? history[c.handle].stalled ?? 0 : 0) > 0;
  return out.sort((x, y) => {
    // An agent whose recent hires never reached work goes after those that did: it is a fallback, not banned.
    if (stalled(x) !== stalled(y)) return stalled(x) ? 1 : -1;
    const de = BigInt(x.expected_cost_atomic) - BigInt(y.expected_cost_atomic);
    if (de !== 0n) return de < 0n ? -1 : 1;
    return (y.p_pass - x.p_pass) || (y.delivered_jobs - x.delivered_jobs) || (x.handle < y.handle ? -1 : x.handle > y.handle ? 1 : 0);
  });
}

/**
 * p_pass = (successes + 1) / (jobs + 2) (Laplace) over the market's record plus Rook's own verdicts on this agent, and
 * expected cost = price / p_pass: what Rook pays per passing deliverable on average. With no record at all p_pass is 0.5.
 */
function rank(a: AgentSummary, price: string, own: AgentHistory | undefined): Pick<Candidate, 'p_pass' | 'expected_cost_atomic' | 'rank_reason'> {
  // success_rate is the market's percentage (0 to 100; the simulator's too). With none, the market's jobs say nothing
  // about passing, so they count as 0 of 0. Market numbers are untrusted: clamped, and non-finite ones ignored.
  const known = a.success_rate !== null && Number.isFinite(a.success_rate) && Number.isFinite(a.delivered_jobs);
  const mJobs = known ? Math.max(0, Math.floor(a.delivered_jobs)) : 0;
  // Multiply before dividing so a half rounds up exactly: 29% of 50 is 14.5 -> 15 (0.29 * 50 is 14.4999... -> 14).
  const mPass = known ? Math.min(mJobs, Math.round((Math.min(100, Math.max(0, a.success_rate!)) * mJobs) / 100)) : 0;
  const rPass = own?.pass ?? 0, rJobs = rPass + (own?.fail ?? 0);
  const s = mPass + rPass, n = mJobs + rJobs;
  // price / p = price * (n + 2) / (s + 1), rounded up in integers: money never goes through a float.
  const expected = (BigInt(price) * BigInt(n + 2) + BigInt(s)) / BigInt(s + 1);
  const p_pass = Math.min(1, Math.round(((s + 1) * 1000) / (n + 2)) / 1000); // 201 / 400 = 0.5025 -> 0.503, same reason
  const record = [mJobs > 0 && `market ${mPass} of ${mJobs}`, rJobs > 0 && `Rook ${rPass} of ${rJobs}`].filter(Boolean).join(', ') || 'no record yet';
  const stalls = own?.stalled ?? 0;
  const after = stalls > 0 ? `; ranked after the others: ${stalls} recent ${stalls === 1 ? 'hire' : 'hires'} by Rook failed to send or timed out` : '';
  return {
    p_pass, expected_cost_atomic: expected.toString(),
    rank_reason: `${formatUsdc(price)} USDC / ${p_pass} pass chance (${record}) = ${formatUsdc(expected)} USDC expected${after}`,
  };
}

// ponytail: compile-only Ajv, lenient about unknown keywords and formats; the evaluator does the real validation.
const ajv = new Ajv({ strict: false, logger: false });

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Word count", "Total words", "Number of characters", "Characters"; not "Words per minute" or "Keywords found".
const COUNT_LABEL = /\b(?:word|character|char)s?\s*(?:count|total|length)\b|\b(?:number|count|total) of (?:words|characters|chars)\b|^\W*(?:total\s+)?(?:words|characters|chars)\W*$/i;

/**
 * Step 8 + section 7 rules. `pos` is the subtask's final index; cross-checks must point strictly earlier. `inputs`: the
 * files an edit changes; it must return them whole, so an edit with no files check gets one.
 */
function validateCriteria(id: string, pos: number, raw: DraftSubtask['criteria'], finalId: Map<string, string>, notes: string[], inputs: string[] = []): Criterion[] {
  const out: Criterion[] = [];
  let judges = 0, length: Criterion | undefined;
  raw.forEach((rc, j) => {
    const remove = (why: string) => notes.push(`criterion ${id}.c${j + 1} removed: ${why}`);
    const parsed = Criterion.safeParse({ ...rc, id: 'tmp' });
    if (!parsed.success) return remove(`invalid ${rc.kind} criterion (${parsed.error.issues[0]?.message ?? 'bad shape'})`);
    let c = parsed.data;
    switch (c.kind) {
      case 'contains': {
        // The evaluator also passes a pattern found verbatim: a broken regex is that literal, never a lost check
        // (an Express plan lost both its route checks this way).
        try { new RegExp(c.spec.pattern, 'i'); } catch {
          c.spec.pattern = escapeRegExp(c.spec.pattern);
          notes.push(`criterion ${id}.c${j + 1}: invalid regex, matched as written instead`);
        }
        if (linkOnly(c.spec.pattern)) {
          c = { id: c.id, kind: 'live_url', description: c.description, spec: { label: /live/i.test(c.spec.pattern) ? 'Live URL' : 'URL' } };
          notes.push(`criterion ${id}.c${j + 1}: a link check by pattern became a live_url check, which loads the link`);
        }
        break;
      }
      case 'files': {
        const paths = [...new Set(c.spec.paths.map(cleanPath).filter((p): p is string => !!p))];
        if (!paths.length) return remove('no file path inside the project');
        c.spec.paths = paths;
        break;
      }
      case 'schema':
        try { ajv.compile(c.spec.json_schema); } catch (e: any) { return remove(`invalid JSON schema (${e?.message ?? e})`); }
        break;
      case 'numeric_match': {
        const { min, max } = c.spec;
        if ([min, max].some((b) => b !== undefined && !Number.isFinite(b))) return remove('non-finite bound');
        if (min !== undefined && max !== undefined && min > max) return remove('min is above max');
        // A date ("2026-10-15") or an id is not one number: the check would fail honest work (seen on mainnet).
        if (/\b(dates?|dated|year|version|ids?|phone)\b/i.test(c.spec.label)) return remove(`"${c.spec.label}" is a date or id, not a quantity`);
        // A "Word count: 412" line ended up in the user's CV, and a self-reported count proves nothing: a judge reads the
        // length instead, if a judge slot is left once the brief's own judges are in.
        const count = COUNT_LABEL.exec(c.spec.label);
        if (count) {
          const unit = /word/i.test(count[0]) ? 'words' : 'characters';
          remove(`"${c.spec.label}" is a ${unit.slice(0, -1)} count, which would have to be printed in the work`);
          const span = min !== undefined && max !== undefined ? `roughly ${min} to ${max} ${unit}` : min !== undefined ? `at least roughly ${min} ${unit}` : `at most roughly ${max} ${unit}`;
          length ??= { id: 'tmp', kind: 'llm_judge', description: `About the length asked for (${span})`, spec: { question: `Is the deliverable ${span} long?` } };
          return;
        }
        break;
      }
      case 'cross_check': {
        const ref = finalId.get(c.spec.other_subtask);
        if (!ref) return remove(`cross_check references ${c.spec.other_subtask}, which is not in the final plan`);
        if (Number(ref.slice(1)) - 1 >= pos) return remove(`cross_check references ${c.spec.other_subtask}, which is not an earlier subtask`);
        c.spec.other_subtask = ref;
        break;
      }
      case 'llm_judge':
        if (++judges > MAX_JUDGES) return remove(`more than ${MAX_JUDGES} llm_judge criteria`);
        break;
    }
    out.push(c);
  });
  if (length && judges < MAX_JUDGES) out.push(length);
  if (inputs.length && !out.some((c) => c.kind === 'files')) {
    out.push({ id: 'tmp', kind: 'files', description: `Returns ${inputs.length === 1 ? inputs[0] : 'each changed file'} whole`, spec: { paths: inputs } });
  }
  if (out.length === 0) {
    out.push({ id: 'c1', kind: 'llm_judge', description: 'Default quality check', spec: { question: DEFAULT_JUDGE } });
    notes.push(`${id}: no valid criteria left, default llm_judge added`);
  }
  return out.map((c, j) => ({ ...c, id: `c${j + 1}` }));
}
