// Deterministic half of planning (docs/agentic-system.md 5.2 steps 2 and 4 to 9, section 7 rules).
// No I/O and no LLM here: index.ts gathers search results, selections and quotes, then calls buildPlan.
import { Ajv } from 'ajv';
import { z } from 'zod';
import { config } from '../shared/config.ts';
import { AcceptsRow, Criterion, type AgentHistory, type AgentSummary, type Candidate, type Plan, type PlanSubtask, type SelfDoReason, type X402Config } from '../shared/types.ts';
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
  self_do_ok: z.boolean(),
  criteria: z.array(DraftCriterion),
});
const isUsdc = (v: number | string) => { try { parseUsdc(v); return true; } catch { return false; } };
// No subtasks only with `not_a_task`: the message is not a task to plan ("go ahead", "hi"), and that sentence says why.
// `budget_usdc`: the total budget the message itself names ("make it 1 USDC"), in USDC; absent when it names none.
export const Draft = z.object({
  subtasks: z.array(DraftSubtask).max(5),
  not_a_task: z.string().optional(),
  budget_usdc: z.union([z.number(), z.string()]).nullish()
    .refine((v) => v == null || isUsdc(v), 'budget_usdc must be an amount of USDC such as 1.5, with at most 6 decimals'),
}).refine((d) => d.subtasks.length > 0 || !!d.not_a_task?.trim(), 'return at least one subtask, or set not_a_task');
export type DraftSubtask = z.infer<typeof DraftSubtask>;
export type Draft = z.infer<typeof Draft>;

export type QuoteResult = { ok: true; row: unknown } | { ok: false; error: { code: number | string; message: string } };

export const DEFAULT_JUDGE = 'Does the deliverable fully answer the brief with specific content rather than generic filler?';
const MAX_PER_SUBTASK = 10;
const MAX_JUDGES = 2;

/**
 * Step 2: keep agents that can be hired now with USDC, and merge the per-term results by handle, taking each term's
 * next unseen agent in turn. The first term is the generic skill and often fills every slot alone, which cut the
 * specialists the other terms found (a Solidity audit offered only generic code reviewers).
 */
export function filterSearch(resultLists: AgentSummary[][]): AgentSummary[] {
  const lists = resultLists.map((l) => l.filter((a) => a.available_now && a.listing_status === 'live' && a.payable_with?.includes('USDC')));
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

/** Step 3 output hygiene: keep only handles that were in that subtask's search results, at most 3. */
export function applySelection(results: AgentSummary[], handles: string[]): AgentSummary[] {
  const picked = [...new Set(handles)].map((h) => results.find((a) => a.handle === h)).filter((a): a is AgentSummary => !!a);
  return picked.slice(0, 3);
}

export type PlanInput = {
  draft: DraftSubtask[];
  selected: AgentSummary[][]; // per draft subtask, the agents the select step picked
  quotes: Record<string, QuoteResult>; // by handle
  recipients: X402Config['recipients'];
  budget_atomic: bigint;
  reserve_share: number;
  history?: Record<string, AgentHistory>; // Rook's own verdicts by handle; without it, the market's record alone
};

/** The contract's ceiling on the reserve, in basis points of the budget (contract/budget/src/lib.rs MAX_RESERVE_BPS). */
export const MAX_RESERVE_BPS = 9_000;

export function buildPlan(input: PlanInput): Omit<Plan, 'llm_calls'> {
  const notes: string[] = [];
  const dropped: Plan['dropped'] = [];
  const allocatable = input.budget_atomic - share(input.budget_atomic, input.reserve_share);

  // Steps 4 to 7, in priority order. `draftIdx` keeps the draft position for cross-check rewriting.
  type Kept = { draftIdx: number; d: DraftSubtask; candidates: Candidate[]; cap: bigint; self_do: boolean; self_do_reason?: SelfDoReason; need?: bigint };
  const kept: Kept[] = [];
  let allocated = 0n;
  // First pass: a subtask is hired when one of its agents fits what is left to allocate, at that agent's price. The
  // first hire must fit the cap, so the first-ranked agent that fits leads, and the agents ranked above it follow it
  // in rank order: the reserve may still pay one as a fallback (the prune pass drops those it never can). Fallback
  // cover comes in the second pass, so it never costs a later subtask its agent.
  input.draft.forEach((d, draftIdx) => {
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
    return {
      id,
      title: k.d.title,
      brief: k.d.brief,
      search_terms: k.d.search_terms,
      criteria: validateCriteria(id, i, k.d.criteria, finalId, notes),
      cap_atomic: k.cap.toString(),
      // Rook waits for a hire at most ROOK_HIRE_PATIENCE_S, whatever SLA the agent advertises.
      deadline_s: k.self_do ? 0 : Math.min(Math.max(...k.candidates.map((c) => c.sla_seconds)), config.hirePatienceS),
      self_do: k.self_do,
      ...(k.self_do ? { self_do_reason: k.self_do_reason } : {}),
      ...(k.need !== undefined ? { self_do_need_atomic: k.need.toString() } : {}),
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
 * first), then higher p_pass, more delivered jobs, handle.
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
  return out.sort((x, y) => {
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
  return {
    p_pass, expected_cost_atomic: expected.toString(),
    rank_reason: `${formatUsdc(price)} USDC / ${p_pass} pass chance (${record}) = ${formatUsdc(expected)} USDC expected`,
  };
}

// ponytail: compile-only Ajv, lenient about unknown keywords and formats; the evaluator does the real validation.
const ajv = new Ajv({ strict: false, logger: false });

/** Step 8 + section 7 rules. `pos` is the subtask's final index; cross-checks must point strictly earlier. */
function validateCriteria(id: string, pos: number, raw: DraftSubtask['criteria'], finalId: Map<string, string>, notes: string[]): Criterion[] {
  const out: Criterion[] = [];
  let judges = 0;
  raw.forEach((rc, j) => {
    const remove = (why: string) => notes.push(`criterion ${id}.c${j + 1} removed: ${why}`);
    const parsed = Criterion.safeParse({ ...rc, id: 'tmp' });
    if (!parsed.success) return remove(`invalid ${rc.kind} criterion (${parsed.error.issues[0]?.message ?? 'bad shape'})`);
    const c = parsed.data;
    switch (c.kind) {
      case 'contains':
        try { new RegExp(c.spec.pattern, 'i'); } catch { return remove('invalid regex'); }
        break;
      case 'schema':
        try { ajv.compile(c.spec.json_schema); } catch (e: any) { return remove(`invalid JSON schema (${e?.message ?? e})`); }
        break;
      case 'numeric_match': {
        const { min, max } = c.spec;
        if ([min, max].some((b) => b !== undefined && !Number.isFinite(b))) return remove('non-finite bound');
        if (min !== undefined && max !== undefined && min > max) return remove('min is above max');
        // A date ("2026-10-15") or an id is not one number: the check would fail honest work (seen on mainnet).
        if (/\b(dates?|dated|year|version|ids?|phone)\b/i.test(c.spec.label)) return remove(`"${c.spec.label}" is a date or id, not a quantity`);
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
  if (out.length === 0) {
    out.push({ id: 'c1', kind: 'llm_judge', description: 'Default quality check', spec: { question: DEFAULT_JUDGE } });
    notes.push(`${id}: no valid criteria left, default llm_judge added`);
  }
  return out.map((c, j) => ({ ...c, id: `c${j + 1}` }));
}
