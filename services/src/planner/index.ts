// Planner service: POST /plan, POST /self-do, POST /aggregate. docs/agentic-system.md sections 5, 7, 11.
// Reaches the market only through the market gateway (section 9).
import { config } from '../shared/config.ts';
import { HttpError, call, serve, type Running } from '../shared/http.ts';
import { AggregateRequest, PlanRequest, SelfDoRequest, type AgentSummary, type AggregateResult, type LlmCall, type Plan, type X402Config } from '../shared/types.ts';
import { share } from '../shared/money.ts';
import { applySelection, buildPlan, filterSearch, type QuoteResult } from './plan.ts';
import { aggregate, draft, select, selfDo } from './prompts.ts';
import { agentOf, isMerged } from './canned.ts';

const gw = () => config.urls.marketGateway;

async function plan(body: unknown): Promise<Plan> {
  const req = PlanRequest.parse(body);
  const budget = BigInt(req.budget_atomic);
  const calls: LlmCall[] = [];

  const { draft: d } = await llmStep(calls, () => draft(req.prompt, budget, budget - share(budget, req.reserve_share)));

  // Step 2: supply check, every search term of every subtask in parallel.
  const search = (q: string) => call<{ agents: AgentSummary[] }>(`${gw()}/search?q=${encodeURIComponent(q)}`).then((r) => r.agents);
  const results = await gateway('search', () => Promise.all(d.map(async (s) => filterSearch(await Promise.all(s.search_terms.map(search))))));

  const { handles: picks } = await llmStep(calls, () => select(d, results));
  const selected = d.map((_, i) => applySelection(results[i], picks[i] ?? []));

  // Step 4: one quote per distinct handle; any failure becomes a dropped candidate, not a failed plan.
  const x402 = await gateway('x402', () => call<X402Config>(`${gw()}/x402`));
  const handles = [...new Set(selected.flat().map((a) => a.handle))];
  const quotes: Record<string, QuoteResult> = Object.fromEntries(await Promise.all(handles.map(async (handle) => {
    const q = await call<QuoteResult>(`${gw()}/quote`, { handle })
      .catch((e: any): QuoteResult => ({ ok: false, error: { code: 'network', message: e?.message ?? String(e) } }));
    return [handle, q] as const;
  })));

  const out = buildPlan({ draft: d, selected, quotes, recipients: x402.recipients ?? [], budget_atomic: budget, reserve_share: req.reserve_share });
  return { ...out, llm_calls: calls };
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
    'POST /plan': ({ body }) => plan(body),
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
