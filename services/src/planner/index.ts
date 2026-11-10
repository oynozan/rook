// Planner service: POST /plan, POST /self-do, POST /aggregate. docs/agentic-system.md sections 5, 7, 11.
// Reaches the market only through the market gateway (section 9).
import { config, MAX_PROMPT_CHARS } from '../shared/config.ts';
import { HttpError, bigintReplacer, call, serve, type Running } from '../shared/http.ts';
import { AggregateRequest, PlanRequest, SelfDoRequest, type AgentSummary, type AggregateResult, type LlmCall, type Plan, type X402Config } from '../shared/types.ts';
import { budgetBacked, formatUsdc, namedBudgetProblem, share } from '../shared/money.ts';
import { MAX_CATEGORY_LISTED, applySelection, buildPlan, filterSearch, hireable, marketCategory, type QuoteResult } from './plan.ts';
import { aggregate, draft, select, selfDo } from './prompts.ts';
import { agentOf, isMerged } from './canned.ts';

const gw = () => config.urls.marketGateway;

/** What the planner reports while it works, so the app can show agents before the plan is done. */
export type PlanProgress =
  | { stage: 'searching'; subtasks: { index: number; title: string }[] }
  | { stage: 'found'; index: number; title: string; agents: { handle: string; name: string }[] }
  | { stage: 'quoting'; agents: number };
const FOUND_SHOWN = 8; // agents reported per subtask; the search can return more, the plan keeps at most 5

async function plan(body: unknown, progress: (p: PlanProgress) => void = () => {}): Promise<Plan> {
  const req = PlanRequest.parse(body);
  const sent = BigInt(req.budget_atomic);
  // Same limits as the orchestrator, checked again before any paid LLM call.
  if (req.prompt.length > MAX_PROMPT_CHARS) throw new HttpError(400, `prompt is ${req.prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}`);
  if (sent > config.maxBudgetAtomic) throw new HttpError(400, `budget is above ROOK_MAX_BUDGET_USDC (${formatUsdc(config.maxBudgetAtomic)} USDC)`);
  if (req.conversation?.earlier.some((m) => m.length > MAX_PROMPT_CHARS)) throw new HttpError(400, `an earlier message is over ${MAX_PROMPT_CHARS} characters`);
  const calls: LlmCall[] = [];

  const { draft: d, notATask, budgetAtomic: drafted } = await llmStep(calls, () => draft(req.prompt, sent, sent - share(sent, req.reserve_share), req.conversation));
  if (!d.length) throw new HttpError(422, notATask || 'This does not read as a task Rook can plan: say what you want done.', { llm_calls: calls });
  // A total the message names ("make it 1 USDC") replaces the budget sent with it, within the same limits, refused
  // before the market is searched; the orchestrator checks it again. One the model read into a message that names no
  // such total is its mistake: the plan is made at the budget sent.
  const named = drafted !== undefined && budgetBacked(req.prompt, drafted) ? drafted : undefined;
  // The budget sent, echoed back by the draft, is no mistake worth a note.
  const ignored = drafted !== undefined && named === undefined && drafted !== sent
    ? [`the draft set a budget of ${formatUsdc(drafted)} USDC, but the message names no such budget: planned at the budget sent`] : [];
  const problem = named === undefined ? null : namedBudgetProblem(named, BigInt(req.min_budget_atomic ?? '0'), config.maxBudgetAtomic);
  if (problem) throw new HttpError(422, problem, { llm_calls: calls });
  const budget = named ?? sent;
  progress({ stage: 'searching', subtasks: d.map((s, index) => ({ index, title: s.title })) });

  // Step 2: supply check, every search term of every subtask in parallel, and each category the draft names, listed
  // once for all its subtasks. A listing is a broadening only: if the market refuses it, the keyword results still plan.
  const search = (q: string, category?: string) =>
    call<{ agents: AgentSummary[] }>(`${gw()}/search?q=${encodeURIComponent(q)}${category ? `&category=${category}` : ''}`).then((r) => r.agents);
  const cats = d.map((s) => marketCategory(s.category));
  const listings: Record<string, AgentSummary[]> = Object.fromEntries(await Promise.all([...new Set(cats.filter((c): c is string => !!c))].map(async (c) =>
    [c, (await search('', c).catch(() => [])).filter(hireable).slice(0, MAX_CATEGORY_LISTED)] as const)));
  const results = await gateway('search', () => Promise.all(d.map(async (s, index) => {
    const found = filterSearch(await Promise.all(s.search_terms.map((q) => search(q))));
    progress({ stage: 'found', index, title: s.title, agents: found.slice(0, FOUND_SHOWN).map((a) => ({ handle: a.handle, name: a.name })) });
    return found;
  })));

  const listed = cats.map((c) => (c ? listings[c] ?? [] : []));
  const { handles: picks } = await llmStep(calls, () => select(d, results, listings, cats));
  const selected = d.map((_, i) => applySelection([...results[i], ...listed[i]], picks[i] ?? []));

  // Step 4: one quote per distinct handle; any failure becomes a dropped candidate, not a failed plan.
  const x402 = await gateway('x402', () => call<X402Config>(`${gw()}/x402`));
  const handles = [...new Set(selected.flat().map((a) => a.handle))];
  progress({ stage: 'quoting', agents: handles.length });
  const quotes: Record<string, QuoteResult> = Object.fromEntries(await Promise.all(handles.map(async (handle) => {
    const q = await call<QuoteResult>(`${gw()}/quote`, { handle })
      .catch((e: any): QuoteResult => ({ ok: false, error: { code: 'network', message: e?.message ?? String(e) } }));
    return [handle, q] as const;
  })));

  const out = buildPlan({ draft: d, selected, quotes, recipients: x402.recipients ?? [], budget_atomic: budget, reserve_share: req.reserve_share, history: req.history });
  return { ...out, notes: [...ignored, ...out.notes], ...(named !== undefined ? { budget: { ...out.budget, from_message: true } } : {}), llm_calls: calls };
}

/** An LLM failure is a 502 carrying the calls already paid for, so the orchestrator can fail the task with a trace. */
async function llmStep<R extends { calls: LlmCall[] }>(calls: LlmCall[], f: () => Promise<R>): Promise<R> {
  try {
    const r = await f();
    calls.push(...r.calls);
    return r;
  } catch (e: any) {
    calls.push(...(e?.calls ?? []));
    throw new HttpError(502, `planner LLM failed: ${e?.message ?? e}`, { llm_calls: calls });
  }
}

async function gateway<T>(what: string, f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e: any) { throw new HttpError(502, `market gateway ${what} failed: ${e?.message ?? e}`); }
}

export function start(port = config.ports.planner): Promise<Running> {
  return serve('planner', {
    // Asked for application/x-ndjson, it streams progress lines, then { type: 'plan' } or { type: 'error' }.
    // Otherwise it answers once with the plan as JSON, as before.
    'POST /plan': async ({ body, req, res }) => {
      if (!String(req.headers.accept ?? '').includes('application/x-ndjson')) return plan(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
      const line = (o: unknown) => res.write(JSON.stringify(o, bigintReplacer) + '\n');
      try {
        line({ type: 'plan', plan: await plan(body, (p) => line({ type: 'progress', ...p })) });
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : e?.name === 'ZodError' ? 400 : 500;
        line({ type: 'error', status, error: e?.message ?? String(e), ...(e?.body ? { details: e.body } : {}) });
      }
      res.end();
      return undefined;
    },
    'POST /self-do': async ({ body }) => {
      const req = SelfDoRequest.parse(body);
      const calls: LlmCall[] = [];
      const { text } = await llmStep(calls, () => selfDo(req.brief, req.criteria));
      return { text, llm_calls: calls };
    },
    'POST /aggregate': async ({ body }): Promise<AggregateResult> => {
      const req = AggregateRequest.parse(body);
      const calls: LlmCall[] = [];
      const { final_markdown } = await llmStep(calls, () => aggregate(req));
      const attribution = req.subtasks.filter(isMerged).map((s) => ({ subtask_id: s.id, agent_handle: agentOf(s) }));
      return { final_markdown, attribution, llm_calls: calls };
    },
  }, port);
}
