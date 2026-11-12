// Planner service: POST /plan, POST /self-do, POST /aggregate. docs/agentic-system.md sections 5, 7, 11.
// Reaches the market only through the market gateway (section 9).
import { config, MAX_PROMPT_CHARS } from '../shared/config.ts';
import { HttpError, bigintReplacer, call, serve, type Running } from '../shared/http.ts';
import { PlanRequest, SelfDoRequest, type AgentSummary, type AggregateResult, type LlmCall, type Plan, type X402Config } from '../shared/types.ts';
import { budgetBacked, formatUsdc, namedBudgetProblem, share } from '../shared/money.ts';
import { NearRpcError, rpc } from '../shared/near.ts';
import type { AgentListing } from '../market-gateway/index.ts';
import {
  ACCOUNT_FIXES, MAX_CATEGORY_LISTED, MAX_PICKS, applySelection, buildPlan, carryParts, editsOnly, filterSearch, fitting, fixAccounts, goodRecord,
  hireable, inputsBlocked, isAction, isRookEdit, keepCriteria, marketCategory, nearAccountIds, placeholderQuestions, prefilter,
  type AccountState, type QuoteResult,
} from './plan.ts';
import { BUDGET_HOW, aggregate, draft, select, selfDo } from './prompts.ts';
import { AggregateIn, agentOf, isMerged } from './canned.ts';
import { readReferences } from './reference.ts';
import { describeSpending, readSpending } from './spending.ts';

const gw = () => config.urls.marketGateway;

/**
 * Payment windows the market's quotes gave, by handle: a later plan leaves an agent Rook can't pay out before the select
 * step (plan.ts prefilter) instead of spending a pick on it. ponytail: this process only, for a day; a restart learns
 * them again from the first plan's quotes.
 */
const WINDOW_TTL_MS = 86_400_000;
const windows = new Map<string, { s: number; at: number }>();
const knownWindows = (now = Date.now()) => Object.fromEntries([...windows].filter(([, w]) => now - w.at < WINDOW_TTL_MS).map(([h, w]) => [h, w.s]));

/** An account with no contract deployed has this code hash. */
const NO_CODE = '11111111111111111111111111111111';
const ACCOUNT_CHECK_MS = 5_000;
const MAX_ACCOUNT_CHECKS = 12;
async function accountState(id: string): Promise<AccountState> {
  try {
    const r = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
    if (typeof r?.error === 'string') { if (/does not exist/i.test(r.error)) return 'missing'; throw new Error(r.error); }
    return r?.code_hash === NO_CODE ? 'empty' : 'contract';
  } catch (e) {
    if (e instanceof NearRpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(e.message)) return 'missing';
    throw e;
  }
}
/**
 * The chain's view of each account id, and of the real id ACCOUNT_FIXES knows for it, through NEAR RPC (NEAR_RPC_URL,
 * the client the chain gateway uses), each within 5 s. `unchecked`: the ids it could not read (none checked when
 * NEAR_RPC_URL is not set): a note, never a failed plan.
 */
async function accountStates(ids: string[]): Promise<{ states: Record<string, AccountState>; unchecked: string[]; unset: boolean }> {
  try { void config.nearRpcUrl; } catch { return { states: {}, unchecked: ids, unset: true }; }
  const want = [...new Set([...ids, ...ids.flatMap((id) => (Object.hasOwn(ACCOUNT_FIXES, id) ? [ACCOUNT_FIXES[id].to] : []))])].slice(0, MAX_ACCOUNT_CHECKS);
  const read = await Promise.all(want.map(async (id): Promise<AccountState | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('timed out')), ACCOUNT_CHECK_MS); });
    try { return await Promise.race([accountState(id), late]); } catch { return undefined; } finally { clearTimeout(timer); }
  }));
  // In the order the plan names them, so its notes read the same on every run.
  const states: Record<string, AccountState> = Object.fromEntries(want.flatMap((id, i) => (read[i] ? [[id, read[i]]] : [])));
  return { states, unchecked: ids.filter((id) => !Object.hasOwn(states, id)), unset: false };
}

/** A plan that asks instead of planning: nothing is searched, quoted or funded, at the budget the answer is planned at. */
function asking(questions: string[], budget: bigint, reserveShare: number, named: boolean): Pick<Plan, 'subtasks' | 'dropped' | 'questions' | 'budget'> {
  const reserve = share(budget, reserveShare);
  return {
    subtasks: [], dropped: [], questions,
    budget: { budget_atomic: budget.toString(), reserve_atomic: reserve.toString(), allocatable_atomic: (budget - reserve).toString(), allocated_atomic: '0', ...(named ? { from_message: true } : {}) },
  };
}

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

  // Pages the message names, read first so the draft describes what they show. A page that can't be read is a note,
  // never a failed plan. A follow-up reads only the latest message's pages: an edit works from the delivered files, and
  // a page re-read from an earlier message turned a rename into a clone of it. A revision keeps its reference: the
  // plan it revises carries what the page showed, else the earlier messages' pages are read again.
  const conv = req.conversation;
  // The parts of the plan being revised, with their criteria and the rest of each part as the orchestrator sends it.
  const parts = conv?.plan ?? [];
  const refs = await readReferences(conv?.revising && !conv.plan?.length ? [req.prompt, ...[...conv.earlier].reverse()] : [req.prompt]);
  const { draft: drafted0, notATask, questions, assumptions, notes: draftNotes, budgetAtomic: drafted, action: draftAction, spending: rawSpending } = await llmStep(calls, () => draft(req.prompt, sent, sent - share(sent, req.reserve_share), conv, refs));
  // The conversation's spending rules, with the ones this message states on top: every amount from the user's own
  // messages, never the model's (spending.ts). Every plan carries them, so the next message keeps them.
  const spendNotes: string[] = [];
  const { rules: spending, stated } = readSpending(rawSpending, [req.prompt, ...(conv?.earlier ?? [])], conv?.spending, spendNotes);
  const rules = spending ? { spending } : {};
  if (!drafted0.length && !questions?.length) {
    // A message that only states how Rook may spend ("from now on, ask me before every payment") is answered with the
    // rules, repeated back: nothing is searched, quoted or funded. The orchestrator keeps them for the conversation.
    if (stated && spending) {
      const { questions: _none, ...nothing } = asking([], sent, req.reserve_share, false);
      return { ...nothing, notes: [...refs.notes, ...spendNotes, ...draftNotes], assumptions: assumptions?.length ? assumptions : [describeSpending(spending)], spending, llm_calls: calls };
    }
    const unread = rawSpending != null ? "Rook couldn't keep the spending rules in your message: write each amount in digits, like 'only spend 1000 USDC a month'." : undefined;
    throw new HttpError(422, notATask || unread || 'This does not read as a task Rook can plan: say what you want done.', { llm_calls: calls });
  }
  // A total the message names ("make it 1 USDC", in any language) replaces the budget sent with it, within the same
  // limits, refused before the market is searched; the orchestrator checks it again. One the model read into a message
  // that names no such total is its mistake: the plan is made at the budget sent, and the user is told so.
  const named = drafted !== undefined && budgetBacked(req.prompt, drafted) ? drafted : undefined;
  // A spending limit the model also read as this task's total ("only spend $1000") is said as what it is.
  const limit = drafted !== undefined && [spending?.budget_usd, spending?.per_task_max_usd].some((u) => u !== undefined && BigInt(Math.round(u * 1_000_000)) === drafted);
  // The budget sent, echoed back by the draft, is no mistake worth a note.
  const ignored = drafted !== undefined && named === undefined && drafted !== sent
    ? [limit
      ? `Rook kept this task's budget at ${formatUsdc(sent)} USDC: ${formatUsdc(drafted)} is your spending limit, not what this task may cost. ${BUDGET_HOW}`
      : `Rook kept the budget at ${formatUsdc(sent)} USDC: your message doesn't name a total of ${formatUsdc(drafted)} USDC. ${BUDGET_HOW}`] : [];
  const problem = named === undefined ? null : namedBudgetProblem(named, BigInt(req.min_budget_atomic ?? '0'), config.maxBudgetAtomic);
  if (problem) throw new HttpError(422, problem, { llm_calls: calls });
  const budget = named ?? sent;
  const notes = [...refs.notes, ...ignored, ...spendNotes, ...draftNotes];
  // An action in the world (book, post, buy, deploy): the web app offers no placeholders for it.
  const acting = draftAction || drafted0.some(isAction) ? { action: true as const } : {};
  // Facts only the user can give are missing: Rook asks, and nothing is searched, quoted or funded. A 200, not a 422:
  // a question is Rook's reply, not a failure. The budget is the one the answer will be planned at.
  if (questions?.length) {
    return { ...asking(questions, budget, req.reserve_share, named !== undefined), notes, ...(assumptions?.length ? { assumptions } : {}), ...acting, ...rules, llm_calls: calls };
  }
  // An action whose brief still holds placeholders once the draft was asked again (plan.ts draftProblems) never runs:
  // Rook asks for those facts instead (QA: "Use placeholders" gave a fundable booking under [Your name]).
  const held = placeholderQuestions(drafted0);
  if (held.length) {
    notes.push('an action brief still held placeholders after the draft was asked again: Rook asks for those facts instead of planning');
    return { ...asking(held, budget, req.reserve_share, named !== undefined), notes, ...(assumptions?.length ? { assumptions } : {}), action: true, ...rules, llm_calls: calls };
  }
  // A revision keeps the criteria of the parts it leaves as they were, and an answer to questions about new work keeps
  // every part of the open plan beside it.
  let d = parts.length && conv?.revising ? keepCriteria(drafted0, parts, notes) : drafted0;
  if (parts.length && conv?.questions?.length) d = carryParts(d, parts, notes);
  let shownAssumptions = assumptions;

  // NEAR account ids the briefs and assumptions name are checked on chain while the market is searched (QA: briefs sent
  // agents to wnear.near, an account with no contract).
  const ids = nearAccountIds([...d.map((s) => s.brief), ...(assumptions ?? [])], config.nearNetwork);
  const accounts = ids.length ? accountStates(ids) : null;

  // A small edit Rook makes itself at once needs no agent: it is never searched for, picked or quoted.
  const files = conv?.files?.map((f) => f.path) ?? [];
  const sizes = new Map(conv?.files?.map((f) => [f.path, f.text.length]));
  const edits = d.map((s) => isRookEdit(s, files, sizes));
  const hire = d.flatMap((_, i) => (edits[i] ? [] : [i]));
  progress({ stage: 'searching', subtasks: hire.map((index) => ({ index, title: d[index].title })) });

  // Step 2: supply check, every search term of every subtask in parallel, and each category the draft names, listed
  // once for all its subtasks. A listing is a broadening only: if the market refuses it, the keyword results still plan.
  const search = (q: string, category?: string) =>
    call<{ agents: AgentListing[] }>(`${gw()}/search?q=${encodeURIComponent(q)}${category ? `&category=${category}` : ''}`).then((r) => r.agents);
  const cats = d.map((s, i) => (edits[i] ? undefined : marketCategory(s.category)));
  const listings: Record<string, AgentListing[]> = Object.fromEntries(await Promise.all([...new Set(cats.filter((c): c is string => !!c))].map(async (c) =>
    [c, (await search('', c).catch(() => [])).filter(hireable).slice(0, MAX_CATEGORY_LISTED)] as const)));
  const results = await gateway('search', () => Promise.all(d.map(async (s, index) => {
    if (edits[index]) return [];
    const found = filterSearch(await Promise.all(s.search_terms.map((q) => search(q)))) as AgentListing[];
    progress({ stage: 'found', index, title: s.title, agents: found.slice(0, FOUND_SHOWN).map((a) => ({ handle: a.handle, name: a.name })) });
    return found;
  })));

  // Agents Rook's own verdicts show deliver are offered to every part, once, looked up by handle when no search found
  // them; the select step and the fit check decide where they fit. A lookup that fails leaves them out.
  const history = req.history ?? {};
  const seen = [...results.flat(), ...Object.values(listings).flat()];
  const good = hire.length ? goodRecord(history) : [];
  const looked = await Promise.all(good.filter((h) => !seen.some((a) => a.handle === h)).map((h) =>
    search(h).then((r) => r.filter((a) => a.handle === h && hireable(a)), () => [] as AgentListing[])));
  // Agents Rook can never pay, or that never delivered while others did, never reach the select step.
  const known = knownWindows();
  const proven = prefilter('agents with a good Rook record', good.flatMap((h) => [...seen, ...looked.flat()].find((a) => a.handle === h && hireable(a)) ?? []), history, known, notes);
  const pools = d.map((s, i) => (edits[i] ? [] : prefilter(`"${s.title}"`, results[i], history, known, notes)));
  const lists: Record<string, AgentListing[]> = Object.fromEntries(Object.entries(listings).map(([c, l]) => [c, prefilter(`category listing "${c}"`, l, history, known, notes)]));

  if (accounts) {
    const { states, unchecked, unset } = await accounts;
    const fixed = fixAccounts(d.map((s) => s.brief), assumptions ?? [], states, [req.prompt, ...(conv?.earlier ?? [])].join('\n'));
    d = d.map((s, i) => (fixed.briefs[i] === s.brief ? s : { ...s, brief: fixed.briefs[i] }));
    if (assumptions?.length) shownAssumptions = fixed.assumptions;
    notes.push(...fixed.notes);
    if (unset) notes.push(`NEAR account names not checked (NEAR_RPC_URL is not set): ${unchecked.join(', ')}`);
    else if (unchecked.length) notes.push(`Rook could not check the NEAR account ${unchecked.length === 1 ? 'name' : 'names'} ${unchecked.join(', ')} on chain: check ${unchecked.length === 1 ? 'it' : 'them'} before paying.`);
  }

  const listed = cats.map((c) => (c ? lists[c] ?? [] : []));
  const { handles: chosen } = await llmStep(calls, () => select(hire.map((i) => d[i]), hire.map((i) => pools[i]), lists, hire.map((i) => cats[i]), history, proven));
  const picks = d.map((_, i) => (hire.includes(i) ? chosen[hire.indexOf(i)] ?? [] : []));
  // What the select step picked, less the agents whose listing shows they can't make what the part needs (plan.ts unfit).
  const selected = d.map((s, i) => fitting(s, applySelection([...pools[i], ...listed[i], ...proven], picks[i], Infinity), notes).slice(0, MAX_PICKS));

  // Step 4: one quote per distinct handle; any failure becomes a dropped candidate, not a failed plan.
  const handles = [...new Set(selected.flat().map((a) => a.handle))];
  const x402 = handles.length ? await gateway('x402', () => call<X402Config>(`${gw()}/x402`)) : { recipients: [] };
  progress({ stage: 'quoting', agents: handles.length });
  const quotes: Record<string, QuoteResult> = Object.fromEntries(await Promise.all(handles.map(async (handle) => {
    const q = await call<QuoteResult>(`${gw()}/quote`, { handle })
      .catch((e: any): QuoteResult => ({ ok: false, error: { code: 'network', message: e?.message ?? String(e) } }));
    return [handle, q] as const;
  })));
  for (const [h, q] of Object.entries(quotes)) {
    const w = q.ok ? (q.row as { maxTimeoutSeconds?: unknown })?.maxTimeoutSeconds : undefined;
    if (typeof w === 'number' && Number.isFinite(w)) windows.set(h, { s: w, at: Date.now() });
  }

  const out = buildPlan({ draft: d, selected, quotes, recipients: x402.recipients ?? [], budget_atomic: budget, reserve_share: req.reserve_share, history, files, sizes });
  // A part whose files are over what Rook sends with one part: the plan is shown, never funded.
  const blocked = inputsBlocked(out.subtasks, conv?.files ?? []);
  // Rook's own edits only take no money: no total the message names is adopted for them (their budget figures are 0).
  const fromMessage = named !== undefined && !editsOnly(out);
  return {
    ...out, notes: [...notes, ...out.notes], ...(shownAssumptions?.length ? { assumptions: shownAssumptions } : {}), ...acting,
    ...(blocked ? { blocked } : {}), ...(fromMessage ? { budget: { ...out.budget, from_message: true } } : {}), ...rules, llm_calls: calls,
  };
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
    // `files`: an edit's inputs, whole. `sources`: the pages Rook's model read or cited (also listed after the text).
    // `truncated`: the reply was cut at the model's max_tokens, so its last file lacks its end: the runner never uses it.
    'POST /self-do': async ({ body }) => {
      const req = SelfDoRequest.parse(body);
      const calls: LlmCall[] = [];
      const { text, sources, truncated } = await llmStep(calls, () => selfDo(req.brief, req.criteria, req.files));
      return { text, sources, llm_calls: calls, truncated };
    },
    // A part may name the files it edits (`inputs`) and the ones it is asked for (`paths`): they name its delivery's files.
    'POST /aggregate': async ({ body }): Promise<AggregateResult> => {
      const req = AggregateIn.parse(body);
      const calls: LlmCall[] = [];
      const { final_markdown, files } = await llmStep(calls, () => aggregate(req));
      const attribution = req.subtasks.filter(isMerged).map((s) => ({ subtask_id: s.id, agent_handle: agentOf(s) }));
      return { final_markdown, attribution, files, llm_calls: calls };
    },
  }, port);
}
