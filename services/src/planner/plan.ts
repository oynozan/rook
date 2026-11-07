// Deterministic half of planning (docs/agentic-system.md 5.2 steps 2 and 4 to 9, section 7 rules).
// No I/O and no LLM here: index.ts gathers search results, selections and quotes, then calls buildPlan.
import { Ajv } from 'ajv';
import { z } from 'zod';
import { AcceptsRow, Criterion, type AgentSummary, type Candidate, type Plan, type PlanSubtask, type X402Config } from '../shared/types.ts';
import { share } from '../shared/money.ts';

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
export const Draft = z.object({ subtasks: z.array(DraftSubtask).min(1).max(5) });
export type DraftSubtask = z.infer<typeof DraftSubtask>;
export type Draft = z.infer<typeof Draft>;

export type QuoteResult = { ok: true; row: unknown } | { ok: false; error: { code: number | string; message: string } };

export const DEFAULT_JUDGE = 'Does the deliverable fully answer the brief with specific content rather than generic filler?';
const MAX_PER_SUBTASK = 10;
const MAX_JUDGES = 2;

/** Step 2: merge the per-term search results by handle and keep agents that can be hired now with USDC. */
export function filterSearch(resultLists: AgentSummary[][]): AgentSummary[] {
  const byHandle = new Map<string, AgentSummary>();
  for (const a of resultLists.flat()) {
    if (byHandle.has(a.handle)) continue;
    if (a.available_now && a.listing_status === 'live' && a.payable_with?.includes('USDC')) byHandle.set(a.handle, a);
  }
  return [...byHandle.values()].slice(0, MAX_PER_SUBTASK);
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
};

export function buildPlan(input: PlanInput): Omit<Plan, 'llm_calls'> {
  const notes: string[] = [];
  const dropped: Plan['dropped'] = [];
  const reserve = share(input.budget_atomic, input.reserve_share);
  const allocatable = input.budget_atomic - reserve;

  // Steps 4 to 7, in priority order. `draftIdx` keeps the draft position for cross-check rewriting.
  type Kept = { draftIdx: number; d: DraftSubtask; candidates: Candidate[]; cap: bigint; self_do: boolean };
  const kept: Kept[] = [];
  let allocated = 0n;
  input.draft.forEach((d, draftIdx) => {
    const candidates = quotedCandidates(input.selected[draftIdx] ?? [], input.quotes, input.recipients, d.title, notes);
    if (candidates.length === 0) {
      if (d.self_do_ok) kept.push({ draftIdx, d, candidates: [], cap: 0n, self_do: true });
      else dropped.push({ title: d.title, reason: 'no fitting agent' });
      return;
    }
    // Sorted cheapest first. The cap covers one nearby fallback (a first agent that fails without charge) but never
    // more than twice the cheapest price, so one expensive candidate cannot inflate what the user locks per subtask;
    // a pricier fallback is paid by a reserve top-up, and one the reserve cannot cover is dropped below.
    const cheapest = BigInt(candidates[0].price_atomic);
    const second = BigInt(candidates[Math.min(1, candidates.length - 1)].price_atomic);
    const cap = second < cheapest * 2n ? second : cheapest * 2n;
    if (allocated + cap > allocatable) {
      if (d.self_do_ok) {
        notes.push(`"${d.title}" is self_do: cap ${cap} would exceed the allocatable budget`);
        kept.push({ draftIdx, d, candidates: [], cap: 0n, self_do: true });
      } else dropped.push({ title: d.title, reason: 'over budget' });
      return;
    }
    allocated += cap;
    // A fallback priced above cap + the whole reserve can never be paid; listing it would only stretch the deadline.
    const payable = candidates.filter((c) => BigInt(c.price_atomic) <= cap + reserve);
    for (const c of candidates.slice(payable.length)) notes.push(`"${d.title}": candidate ${c.handle} dropped, price ${c.price_atomic} exceeds cap + reserve`);
    kept.push({ draftIdx, d, candidates: payable, cap, self_do: false });
  });

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
      deadline_s: k.self_do ? 0 : Math.max(...k.candidates.map((c) => c.sla_seconds)),
      self_do: k.self_do,
      candidates: k.candidates,
    };
  });

  return {
    subtasks,
    dropped,
    budget: {
      budget_atomic: input.budget_atomic.toString(),
      reserve_atomic: reserve.toString(),
      allocatable_atomic: allocatable.toString(),
      allocated_atomic: allocated.toString(),
    },
    notes,
  };
}

/** Step 4: keep agents whose quote succeeded with a row matching a /x402 recipient, cheapest first. */
function quotedCandidates(agents: AgentSummary[], quotes: Record<string, QuoteResult>, recipients: X402Config['recipients'], title: string, notes: string[]): Candidate[] {
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
    out.push({
      handle: a.handle, name: a.name, description: a.description, sla_seconds: a.sla_seconds,
      success_rate: a.success_rate, delivered_jobs: a.delivered_jobs, price_atomic: r.amount, quote: r,
    });
  }
  return out.sort((x, y) => {
    const dp = BigInt(x.price_atomic) - BigInt(y.price_atomic);
    if (dp !== 0n) return dp < 0n ? -1 : 1;
    const ds = (y.success_rate ?? -1) - (x.success_rate ?? -1);
    return ds !== 0 ? ds : y.delivered_jobs - x.delivered_jobs;
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
