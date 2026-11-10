// Deterministic half of planning (docs/agentic-system.md 5.2 steps 2 and 4 to 9, section 7 rules).
// No I/O and no LLM here: index.ts gathers search results, selections and quotes, then calls buildPlan.
import { Ajv } from 'ajv';
import { z } from 'zod';
import { config } from '../shared/config.ts';
import { AcceptsRow, Criterion, type AgentHistory, type AgentSummary, type Candidate, type Plan, type PlanSubtask, type SelfDoReason, type X402Config } from '../shared/types.ts';
import { formatUsdc, parseUsdc, share } from '../shared/money.ts';
import type { AgentListing } from '../market-gateway/index.ts';

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
};

/** The contract's ceiling on the reserve, in basis points of the budget (contract/budget/src/lib.rs MAX_RESERVE_BPS). */
export const MAX_RESERVE_BPS = 9_000;

export function buildPlan(input: PlanInput): Omit<Plan, 'llm_calls'> {
  const notes: string[] = [];
  const dropped: Plan['dropped'] = [];
  const allocatable = input.budget_atomic - share(input.budget_atomic, input.reserve_share);

  // Steps 4 to 7, in priority order. `draftIdx` keeps the draft position for cross-check rewriting.
  type Kept = { draftIdx: number; d: DraftSubtask; candidates: Candidate[]; ranked: Ranked[]; cap: bigint; self_do: boolean; self_do_reason?: SelfDoReason; need?: bigint };
  const kept: Kept[] = [];
  let allocated = 0n;
  // First pass: a subtask is hired when one of its agents fits what is left to allocate, at that agent's price. The
  // first hire must fit the cap, so the first-ranked agent that fits leads, and the agents ranked above it follow it
  // in rank order: the reserve may still pay one as a fallback (the prune pass drops those it never can). Fallback
  // cover comes in the second pass, so it never costs a later subtask its agent.
  // Subtasks only an agent can do (not self_do_ok) are funded first, in priority order, then the rest: a part Rook can
  // write itself must not take the money a later part needs and be dropped for.
  const order = input.draft.map((d, draftIdx) => ({ d, draftIdx })).sort((x, y) => Number(x.d.self_do_ok) - Number(y.d.self_do_ok));
  order.forEach(({ d, draftIdx }) => {
    const ranked = quotedCandidates(input.selected[draftIdx] ?? [], input.quotes, input.recipients, input.history ?? {}, d.title, d.self_do_ok, notes);
    const quoted = ranked.map((r) => r.c);
    const left = allocatable - allocated;
    const fits = quoted.findIndex((c) => price(c) <= left);
    if (fits >= 0) {
      const lead = quoted[fits];
      for (const c of quoted.slice(0, fits)) notes.push(`"${d.title}": candidate ${c.handle} moved after ${lead.handle}, price ${c.price_atomic} exceeds the ${left} left to allocate`);
      let candidates = [lead, ...quoted.slice(0, fits), ...quoted.slice(fits + 1)];
      // A fallback priced far above the agent hired first is no fallback for a part Rook can write itself: if the
      // cheaper agents fail, Rook writes it, rather than the reserve paying 400 times the lead's price for the same text
      // (seen: a 0.02 USDC guide with fallbacks at 5.00 and 8.00). One only an agent can do keeps it, with a note below.
      if (d.self_do_ok) {
        for (const c of candidates) if (far(c, lead)) notes.push(`"${d.title}": candidate ${c.handle} dropped: its price, ${formatUsdc(c.price_atomic)} USDC, is more than ${FAR_PRICE} times the ${formatUsdc(lead.price_atomic)} USDC of the agent hired first, and Rook writes this part itself if the cheaper agents fail`);
        candidates = candidates.filter((c) => !far(c, lead));
      }
      allocated += price(lead);
      kept.push({ draftIdx, d, candidates, ranked, cap: price(lead), self_do: false });
      return;
    }
    const self_do_reason: SelfDoReason = quoted.length ? 'over_budget' : 'no_agent';
    if (!d.self_do_ok) { dropped.push({ title: d.title, reason: quoted.length ? 'over budget' : 'no fitting agent' }); return; }
    if (quoted.length) notes.push(`"${d.title}" is self_do: no candidate's price fits the ${left} left to allocate`);
    // Over budget: the cheapest quote is what one hire would have cost, so a client can name the budget that hires one.
    const need = quoted.length ? quoted.map(price).reduce((a, b) => (b < a ? b : a)) : undefined;
    kept.push({ draftIdx, d, candidates: [], ranked, cap: 0n, self_do: true, self_do_reason, need });
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
    const lead = ok[0];
    for (const c of ok) if (far(c, lead)) notes.push(`"${k.d.title}": if the agents before it fail, ${c.handle} may be hired at ${formatUsdc(c.price_atomic)} USDC, more than ${FAR_PRICE} times the ${formatUsdc(lead.price_atomic)} USDC of the agent hired first, paid from the reserve: only an agent can do this part`);
    explain(k.candidates, k.ranked, k.d.self_do_ok);
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
      self_do_ok: k.d.self_do_ok,
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
 * An agent with this many recent stalls (AgentHistory.stalled: Rook's hires of it since its last delivery that failed to
 * send or timed out) is dropped while another candidate is left. On mainnet dev-tools-agent stalled 5 times running and
 * still led every website plan: the user funded it and waited through failed sends before Rook wrote the page itself.
 */
export const STALL_LIMIT = 2;
/** A fallback priced above this many times the lead's price is kept only for a part Rook cannot write itself. */
export const FAR_PRICE = 10n;
// ponytail: waiting is priced at one flat rate for every user and part, 1 USDC an hour; a per-user value of time, or a
// "cheapest first" choice, is the ceiling.
const WAIT_ATOMIC_PER_HOUR = 1_000_000n;

const far = (c: Candidate, lead: Candidate) => price(c) > FAR_PRICE * price(lead);

/** A candidate as ranked: `wait_s` is what one failed try of it holds the part, `score` the money plus that waiting. */
type Ranked = { c: Candidate; stalls: number; proven: boolean; wait_s: number; score: bigint };

/**
 * Step 4: keep agents whose quote succeeded with a row matching a /x402 recipient, ranked by score (rank(): expected
 * cost plus the waiting a failed try costs, lowest first), then expected cost, higher p_pass, more delivered jobs,
 * handle. Agents with recent stalls go after the rest, and those with STALL_LIMIT or more are dropped unless no other
 * agent is left.
 */
function quotedCandidates(agents: AgentListing[], quotes: Record<string, QuoteResult>, recipients: X402Config['recipients'], history: Record<string, AgentHistory>, title: string, selfDoOk: boolean, notes: string[]): Ranked[] {
  const out: Ranked[] = [];
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
    const own = Object.hasOwn(history, a.handle) ? history[a.handle] : undefined;
    const { p_pass, expected_cost_atomic, rank_reason, ...meta } = rank(a, r.amount, own);
    out.push({
      c: {
        handle: a.handle, name: a.name, description: a.description, sla_seconds: a.sla_seconds,
        success_rate: a.success_rate, delivered_jobs: a.delivered_jobs, price_atomic: r.amount, quote: r,
        p_pass, expected_cost_atomic, rank_reason,
      },
      stalls: own?.stalled ?? 0, ...meta,
    });
  }
  // Agents that keep failing to receive work are skipped while another agent is left; when none is, they stay, last
  // resort before Rook writes the part (explain() says so on their line).
  const failing = out.filter((x) => x.stalls >= STALL_LIMIT);
  const left = failing.length < out.length ? out.filter((x) => x.stalls < STALL_LIMIT) : out;
  if (left !== out) for (const x of failing) notes.push(`"${title}": candidate ${x.c.handle} dropped: Rook's last ${x.stalls} jobs to it failed to send or timed out`);
  else if (failing.length) notes.push(`"${title}": ${failing.map((x) => x.c.handle).join(', ')} failed to send or timed out on Rook's last jobs and ${failing.length === 1 ? 'is the only agent' : 'are the only agents'} found, so ${selfDoOk ? 'Rook will likely write this part itself' : 'this part may not be delivered'}`);
  const cmp = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
  return left.sort((x, y) =>
    // An agent whose recent hire never reached work goes after those that did: a fallback, not banned.
    (Number(x.stalls > 0) - Number(y.stalls > 0)) || cmp(x.score, y.score)
    || cmp(BigInt(x.c.expected_cost_atomic), BigInt(y.c.expected_cost_atomic))
    || (y.c.p_pass - x.c.p_pass) || (y.c.delivered_jobs - x.c.delivered_jobs) || (x.c.handle < y.c.handle ? -1 : x.c.handle > y.c.handle ? 1 : 0));
}

/**
 * p_pass = (successes + 1) / (jobs + 2) (Laplace) over the market's record plus Rook's own verdicts on this agent, and
 * expected cost = price / p_pass: what Rook pays per passing deliverable on average. With no record at all p_pass is 0.5.
 * The rank also counts time: each failed try holds the part `wait_s`, priced at WAIT_ATOMIC_PER_HOUR, and Rook expects
 * (1 - p) / p failed tries per pass. An agent that has delivered somewhere (market jobs or Rook's verdicts) fails in its
 * usual time (the market's median, else its SLA); one that never delivered anywhere may never show, so a try waits out
 * Rook's whole patience for it (SLA + grace, at most ROOK_HIRE_PATIENCE_S). So an unknown 0.05 USDC agent with a 2 h SLA
 * no longer leads one with 18 passes of 20 at 0.15 (seen live): a no-show costs 30 min to save 0.10 USDC.
 */
function rank(a: AgentListing, price: string, own: AgentHistory | undefined) {
  // success_rate is the market's percentage (0 to 100; the simulator's too). With none, the market's jobs say nothing
  // about passing, so they count as 0 of 0. Market numbers are untrusted: clamped, and non-finite ones ignored.
  const known = a.success_rate !== null && Number.isFinite(a.success_rate) && Number.isFinite(a.delivered_jobs);
  const jobs = Number.isFinite(a.delivered_jobs) ? Math.max(0, Math.floor(a.delivered_jobs)) : 0;
  const mJobs = known ? jobs : 0;
  // Multiply before dividing so a half rounds up exactly: 29% of 50 is 14.5 -> 15 (0.29 * 50 is 14.4999... -> 14).
  const mPass = known ? Math.min(mJobs, Math.round((Math.min(100, Math.max(0, a.success_rate!)) * mJobs) / 100)) : 0;
  const rPass = own?.pass ?? 0, rJobs = rPass + (own?.fail ?? 0);
  const s = mPass + rPass, n = mJobs + rJobs;
  // price / p = price * (n + 2) / (s + 1), rounded up in integers: money never goes through a float.
  const expected = (BigInt(price) * BigInt(n + 2) + BigInt(s)) / BigInt(s + 1);
  const p_pass = Math.min(1, Math.round(((s + 1) * 1000) / (n + 2)) / 1000); // 201 / 400 = 0.5025 -> 0.503, same reason
  const proven = jobs > 0 || rJobs > 0;
  const sla = Number.isFinite(a.sla_seconds) ? Math.max(0, a.sla_seconds) : config.hirePatienceS;
  const patience = Math.min(sla + config.paymentGraceS, config.hirePatienceS); // the orchestrator's slaEnd
  const usual = a.response_s !== undefined && Number.isFinite(a.response_s) && a.response_s > 0 ? a.response_s : sla;
  const wait_s = Math.ceil(proven ? Math.min(usual, patience) : patience);
  // (1 - p) / p = (n - s + 1) / (s + 1) failed tries per pass, each holding the part wait_s; rounded up, as above.
  const den = 3600n * BigInt(s + 1);
  const waiting = (WAIT_ATOMIC_PER_HOUR * BigInt(wait_s) * BigInt(n - s + 1) + den - 1n) / den;
  const counted = [mJobs > 0 && `market ${mPass} of ${mJobs}`, !known && jobs > 0 && `${jobs} market ${jobs === 1 ? 'job' : 'jobs'} with no pass rate`, rJobs > 0 && `Rook ${rPass} of ${rJobs}`];
  // "No record yet" beside "5 recent hires failed" read as a contradiction: stalls are jobs that never finished.
  const record = counted.filter(Boolean).join(', ') || ((own?.stalled ?? 0) > 0 ? 'no finished job yet' : 'no record yet');
  return {
    p_pass, expected_cost_atomic: expected.toString(),
    rank_reason: `${formatUsdc(price)} USDC / ${p_pass} pass chance (${record}) = ${formatUsdc(expected)} USDC expected`,
    proven, wait_s, score: expected + waiting,
  };
}

/**
 * Ends each listed candidate's rank_reason with why it sits where it does, against the final list (after the budget
 * moved or dropped agents), so a line never claims others that are not there ("ranked after the others" on the only
 * candidate, seen live): its stalls, or the waiting that put it after an agent of higher expected cost.
 */
function explain(list: Candidate[], ranked: Ranked[], selfDoOk: boolean) {
  const at = new Map(ranked.map((r, i) => [r.c, { r, i }]));
  const min = (s: number) => Math.max(1, Math.round(s / 60));
  list.forEach((c, i) => {
    const { r, i: rankIdx } = at.get(c)!;
    const before = list.slice(0, i);
    if (r.stalls >= STALL_LIMIT) {
      c.rank_reason += `; Rook's last ${r.stalls} jobs to this agent failed to send or timed out, so ${selfDoOk ? 'Rook will likely write this part itself' : 'this part may not be delivered'}`;
    } else if (r.stalls > 0) {
      const one = r.stalls === 1;
      c.rank_reason += before.some((b) => at.get(b)!.r.stalls === 0)
        ? `; ranked after the others: ${r.stalls} recent ${one ? 'hire' : 'hires'} by Rook failed to send or timed out`
        : `; Rook's last ${one ? 'job' : `${r.stalls} jobs`} to this agent failed to send or timed out`;
    } else {
      // Ranked above it and dearer per pass: only the waiting can have put that agent first (the lead moved for the
      // budget is not ranked above it, and its plan note says why).
      const dearer = before.filter((b) => at.get(b)!.i < rankIdx && BigInt(b.expected_cost_atomic) > BigInt(c.expected_cost_atomic)).map((b) => b.handle);
      if (!dearer.length) return;
      const names = dearer.length <= 2 ? dearer.join(' and ') : `${dearer.slice(0, 2).join(', ')} and ${dearer.length - 2} more`;
      c.rank_reason += r.proven
        ? `; ranked after ${names}: a failed try of this agent holds the part about ${min(r.wait_s)} min`
        : `; ranked after ${names}: it has delivered no job yet, and a no-show holds the part up to ${min(r.wait_s)} min`;
    }
  });
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
