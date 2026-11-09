// Orchestrator HTTP API (docs/agentic-system.md section 8.1). No side effects on import.
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config, MAX_PROMPT_CHARS } from '../shared/config.ts';
import { bigintReplacer, call, HttpError, serve, type Ctx, type Routes, type Running } from '../shared/http.ts';
import { formatUsdc, parseUsdc } from '../shared/money.ts';
import { CONVERSATION_MESSAGES, CONVERSATION_REPORT_CHARS, type AgentHistory, type Conversation, type Plan, type RookEvent, type X402Config } from '../shared/types.ts';
import { attack } from './attack.ts';
import { createChainLedger } from './chain-ledger.ts';
import { createLedger, type Ledger } from './ledger.ts';
import { kill, restoreTask, runTask, SHUTDOWN } from './runner.ts';
import { openStore } from './db.ts';
import {
  ancestors, emit, fromDoc, isFree, isTerminal, newTask, openPlan, persistWith, saveTask, setPlan, setStatus, snapshot, taskView, toDoc, verdictHistory, type Task,
} from './store.ts';

const CreateBody = z.object({
  prompt: z.string().trim().min(1),
  budget_usdc: z.union([z.string(), z.number()]),
  reserve_share: z.number().min(0).max(0.9).optional(),
  owner: z.string().min(2).max(64).optional(), // set by the web app from a verified wallet sign-in
  wait: z.boolean().optional(), // false: answer at once with the draft task and plan in the background (progress as events)
  parent_id: z.string().min(1).max(64).optional(), // the conversation's newest task: this message follows it
});

/**
 * What the planner gets with a follow-up: the earlier messages (the first and the newest when there are too many) and
 * the newest report in the conversation, cut to size. `revises`: the plan this message changes, if any.
 */
export function conversationFor(chain: Task[], revises: Task | null): Conversation {
  const prompts = chain.map((x) => x.prompt).reverse();
  const earlier = prompts.length > CONVERSATION_MESSAGES ? [prompts[0], ...prompts.slice(-(CONVERSATION_MESSAGES - 1))] : prompts;
  const report = chain.find((x) => x.final_result?.final_markdown.trim())?.final_result!.final_markdown.trim();
  const CUT = '\n\n[The rest of the report is left out here.]';
  return {
    earlier, revising: revises !== null,
    ...(report ? { report: report.length > CONVERSATION_REPORT_CHARS ? report.slice(0, CONVERSATION_REPORT_CHARS - CUT.length) + CUT : report } : {}),
  };
}

/**
 * Asks the planner for a plan, relaying its progress lines as `planning` events. A planner that answers with plain
 * JSON (an older one, or a test double) still works: there is just no progress to relay. `history`: Rook's own
 * verdicts per agent, which the planner ranks candidates with.
 */
async function planWithProgress(t: Task, history: Record<string, AgentHistory>, conversation?: Conversation): Promise<Plan> {
  emit(t, 'planning', { stage: 'drafting' });
  const r = await fetch(config.urls.planner + '/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
    body: JSON.stringify({ task_id: t.id, prompt: t.prompt, budget_atomic: t.budget_atomic, reserve_share: t.reserve_share, history, conversation }),
    signal: t.abort.signal,
  });
  if (!(r.headers.get('content-type') ?? '').includes('ndjson')) {
    const j: any = await r.json().catch(() => null);
    if (!r.ok) throw new HttpError(r.status, j?.error ?? `planner answered HTTP ${r.status}`, j?.details);
    return j as Plan;
  }
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += value ?? '';
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type === 'progress') { const { type: _, ...p } = m; if (!isTerminal(t.status)) emit(t, 'planning', p); }
      else if (m.type === 'plan') return m.plan as Plan;
      else if (m.type === 'error') throw new HttpError(m.status ?? 502, m.error ?? 'planner failed', m.details);
    }
    if (done) throw new HttpError(502, 'planner ended without a plan');
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();
/** With ROOK_SERVICE_TOKEN set, every route needs `x-rook-token` (constant-time compare); 401 otherwise. */
function guard(routes: Routes): Routes {
  const token = config.serviceToken;
  if (!token) return routes;
  const want = digest(token);
  return Object.fromEntries(Object.entries(routes).map(([k, h]) => [k, (ctx: Ctx) => {
    const got = ctx.req.headers['x-rook-token'];
    if (typeof got !== 'string' || !timingSafeEqual(digest(got), want)) throw new HttpError(401, 'missing or wrong x-rook-token');
    return h(ctx);
  }]));
}

export async function start(port = config.ports.orchestrator): Promise<Running> {
  const tasks = new Map<string, Task>();
  const chain = config.ledger === 'chain' ? createChainLedger() : null;
  const ledger: Ledger = chain ?? createLedger();
  const claims = new Set<string>(); // task ids and `cid:<contract task>` with a /funded check in flight
  const get = (id: string) => {
    const t = tasks.get(id);
    if (!t) throw new HttpError(404, `no task ${id}`);
    return t;
  };
  // The web app passes the signed-in account as `owner` (body, or ?owner= on a GET); someone else's task looks like no
  // task at all. Callers that pass no owner (the CLI) act on any task: the orchestrator listens on localhost only, and
  // with ROOK_SERVICE_TOKEN set only callers holding the token (the web server, the CLI) reach it.
  const owned = (id: string, owner: unknown) => {
    const t = get(id);
    if (typeof owner === 'string' && t.owner !== owner) throw new HttpError(404, `no task ${id}`);
    return t;
  };

  // With ROOK_DB set, tasks survive restarts. A plan waiting for approval carries on, and so does a chain-mode task
  // waiting for its funding transaction. A chain-mode task bound to a contract task is rebuilt from the contract before
  // the API listens, then resumed (or, killed or failed with money still on chain, unwound). Any other task that was
  // mid-run is marked failed: a sim-ledger task's balances lived in memory only.
  const db = config.dbPath ? openStore(config.dbPath) : null;
  if (db) {
    for (const doc of db.load()) tasks.set(doc.id, fromDoc(doc));
    persistWith((t) => {
      if (!tasks.has(t.id)) return;
      if (chain) t.chain = chain.binding(t.id) ?? t.chain ?? null; // contract task, sub-accounts, outstanding authorizations
      db.save({ ...toDoc(t), ledger_saved: ledger.view(t.id) ?? t.ledger_saved ?? null });
    });
    const resume: (() => Promise<void>)[] = [];
    for (const t of tasks.values()) {
      const waiting = t.status === 'planned' || (chain !== null && t.status === 'approved' && !t.chain && !isFree(t));
      if (waiting || t.status === 'closed' || t.status === 'cancelled') continue;
      if (chain && t.chain && !(t.ledger_saved as { closed?: boolean } | undefined)?.closed) {
        const next = await restoreTask(chain, t);
        if (next) resume.push(next);
        continue;
      }
      if (isTerminal(t.status)) continue;
      t.error = `Rook's services restarted while this task was ${t.status}, so it stopped there. ${isFree(t)
        ? 'It hired no agent, so nothing was paid.'
        : chain
        ? 'It has no contract task on record, so nothing of it is on chain to resume.'
        : 'Its simulated ledger lived in memory only, so the run cannot resume; no real money was involved.'}`;
      emit(t, 'error', { kind: 'restart', message: t.error });
      setStatus(t, 'failed');
    }
    for (const go of resume) void go().catch((e) => console.error('[orchestrator] resume after restart', e));
    console.log(`[orchestrator] ${tasks.size} task${tasks.size === 1 ? '' : 's'} loaded from ${config.dbPath}${resume.length ? `, ${resume.length} resumed from the chain` : ''}`);
  }

  // A killed or failed task returns its money after the terminal status; its stream stays open until then. In chain
  // mode only a task bound to a contract task holds money (a plan that hires no agent has books of 0, never on chain).
  // ponytail: a closeTask that keeps failing leaves the stream open until the client goes; the errors still stream.
  const moving = (t: Task) => ledger.view(t.id)?.closed === false && (chain === null || chain.contractTaskOf(t.id) !== null);
  /** The contract's settings, read once from the chain-gateway (null until it answers). */
  let chainCfg: ChainCfg | null = null;
  const contractCfg = async (): Promise<ChainCfg | null> => {
    if (chain && !chainCfg) {
      chainCfg = await call(`${config.urls.chainGateway}/config`).then((c: any) => ({
        contract_id: c.contract_id ?? null, usdc: c.usdc ?? null, owner: c.owner ?? null,
        min_budget: /^\d+$/.test(String(c.min_budget ?? '')) ? BigInt(c.min_budget) : 0n,
        max_open_tasks: Number.isInteger(c.max_open_tasks) ? c.max_open_tasks : null,
      }), () => null);
    }
    return chainCfg;
  };
  const running = await serve('orchestrator', guard({
    'POST /tasks': async ({ body }) => {
      const b = CreateBody.parse(body ?? {});
      if (b.prompt.length > MAX_PROMPT_CHARS) throw new HttpError(400, `prompt is ${b.prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}`);
      let budget: bigint;
      try { budget = parseUsdc(b.budget_usdc); } catch (e: any) { throw new HttpError(400, e.message); }
      if (budget <= 0n) throw new HttpError(400, 'budget_usdc must be positive');
      const max = config.maxBudgetAtomic;
      if (budget > max) throw new HttpError(400, `budget ${formatUsdc(budget)} USDC is above this Rook's limit of ${formatUsdc(max)} USDC (ROOK_MAX_BUDGET_USDC)`);
      const min = (await contractCfg())?.min_budget ?? 0n;
      if (budget < min) throw new HttpError(400, `budget ${formatUsdc(budget)} USDC is below the contract's minimum of ${formatUsdc(min)} USDC`);
      // A message in a conversation follows its newest task. Checked after the last await, so two messages sent at once
      // cannot both follow the same task.
      const parent = b.parent_id === undefined ? null : owned(b.parent_id, b.owner);
      if (parent) {
        if (parent.owner !== (b.owner ?? null)) throw new HttpError(409, `task ${parent.id} has another owner: a follow-up keeps its owner`);
        if (parent.status === 'draft') throw new HttpError(409, 'Wait for the plan to be ready before sending more.');
        if (parent.status !== 'planned' && !isTerminal(parent.status)) throw new HttpError(409, 'Wait for this run to finish, or stop it, before sending more.');
        if ([...tasks.values()].some((x) => x.parent_id === parent.id)) throw new HttpError(409, 'This conversation has a newer message: reload the page and send from there.');
      }
      const chain = parent ? ancestors(parent, tasks) : [];
      const revises = openPlan(chain);
      const conversation = parent ? conversationFor(chain, revises) : undefined;
      const t = newTask(b.prompt, budget, b.reserve_share ?? 0.2, b.owner ?? null, parent?.id ?? null);
      if (conversation) t.earlier_prompts = conversation.earlier;
      tasks.set(t.id, t);
      saveTask(t);
      const planning = (async () => {
        try {
          // A kill during planning aborts the wait. ponytail: the planner does not watch the disconnect, so its LLM
          // calls for this plan still finish (and are not in this task's cost).
          const plan = await planWithProgress(t, verdictHistory(tasks.values()), conversation);
          if (isTerminal(t.status)) return;
          setPlan(t, plan);
          emit(t, 'plan', plan);
          if (!plan.subtasks.length) {
            // Every part was dropped: nothing can be approved, so the task ends here, keeping the plan for its drop list.
            t.error = emptyPlanReason(plan.dropped);
            emit(t, 'error', { kind: 'no_plan', message: t.error });
            setStatus(t, 'failed');
            return;
          }
          setStatus(t, 'planned');
          // The revised plan replaces the one it changes, unless that one was approved or cancelled meanwhile. A
          // revision that fails leaves it as it was.
          if (revises?.status === 'planned') {
            revises.replaced_by = t.id;
            setStatus(revises, 'cancelled');
          }
        } catch (e: any) {
          if (isTerminal(t.status)) return; // killed while planning: stays killed
          // A 422 is the planner's sentence for a message that isn't a task: kept as is, for the user. The rest is internal.
          t.error = e instanceof HttpError && e.status === 422 ? e.message : `planner: ${e?.message ?? e}`;
          emit(t, 'error', { kind: 'planner', message: t.error });
          setStatus(t, 'failed');
        }
      })();
      if (b.wait === false) return taskView(t); // the caller follows along on /tasks/:id/events
      await planning;
      return taskView(t);
    },

    /**
     * Which market, model and ledger this orchestrator runs with, so a client can label things honestly. No secrets.
     * `network` is 'sim' unless the ledger is the chain; `simulated`: any part is (with the sim ledger, show "simulation,
     * no money moves"; with the chain ledger, a test run on `network` where funding still moves tokens).
     */
    'GET /mode': async () => {
      const c = await contractCfg();
      return {
        market: config.market, llm: config.llm, ledger: config.ledger, network: chain ? config.nearNetwork : 'sim',
        contract_id: chain ? c?.contract_id ?? (config.contractId || null) : null, usdc: chain ? c?.usdc ?? null : null,
        paying: chain !== null, simulated: config.simulated,
        // Any signed-in account funds its own task; the contract's limits on that (null without the chain).
        min_budget_atomic: chain && c ? c.min_budget.toString() : null, max_open_tasks: chain ? c?.max_open_tasks ?? null : null,
        max_budget_atomic: config.maxBudgetAtomic.toString(), // POST /tasks refuses more (ROOK_MAX_BUDGET_USDC)
        contract_owner: chain ? c?.owner ?? null : null,
      };
    },

    // An owner sees only their own tasks; a caller naming no owner (the CLI) sees every task.
    'GET /tasks': ({ query }) => ({
      tasks: [...tasks.values()]
        .filter((t) => !query.has('owner') || t.owner === query.get('owner'))
        .map(({ id, status, prompt, budget_atomic, created_at, parent_id }) => ({ id, status, prompt, budget_atomic, created_at, parent_id })),
    }),

    'GET /tasks/:id': ({ params, query }) => snapshot(owned(params.id, query.get('owner')), ledger),

    'POST /tasks/:id/approve': async ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      const reprint = chain && !isFree(t) && t.status === 'approved' && !chain.contractTaskOf(t.id); // funding instructions again
      if (t.status !== 'planned' && !reprint) throw new HttpError(409, `task is ${t.status}, approve needs planned`);
      if (!t.subtasks.length) throw new HttpError(409, 'the plan has no subtasks');
      if (config.market === 'live' && !chain) {
        throw new HttpError(409, 'live market: paying agents needs ROOK_LEDGER=chain (signer, chain-gateway, budget contract); see docs/x402-payments-plan.md');
      }
      if (chain && !isFree(t)) {
        // Rook never creates the task on chain: the human funds it with the caps they approve, then calls /funded.
        const funding = await fundingInstructions(t, await contractCfg(), !!reprint);
        setStatus(t, 'approved');
        return { ...taskView(t), funding };
      }
      // A plan that hires no agent (every subtask self_do) costs its funder nothing, so it starts at once in chain mode too.
      t.funder = chain ? t.owner : typeof body?.funder_account === 'string' && body.funder_account ? body.funder_account : 'funder.sim';
      setStatus(t, 'approved');
      void runTask(ledger, t).catch((e) => console.error('[orchestrator] runTask', e));
      return taskView(t);
    },

    /** Chain mode: the human's ft_transfer_call created contract task `contract_task_id`; check it matches the plan, then run. */
    'POST /tasks/:id/funded': async ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      // The web app binds a funding transfer for the signed-in account only, so a task with an owner needs it named.
      if (t.owner !== null && body?.owner !== t.owner) throw new HttpError(403, `task ${t.id} belongs to a signed-in account: /funded must name it as owner`);
      if (!chain) throw new HttpError(409, 'only with ROOK_LEDGER=chain');
      if (t.status !== 'approved') throw new HttpError(409, `task is ${t.status}, funded needs approved`);
      const cid = typeof body?.contract_task_id === 'string' ? body.contract_task_id : '';
      if (!/^[0-9a-z]+$/.test(cid)) throw new HttpError(400, 'contract_task_id is required');
      const bound = chain.contractTaskOf(t.id);
      if (bound !== null) throw new HttpError(409, `task is already funded by contract task ${bound}`);
      for (const other of tasks.values()) if (chain.contractTaskOf(other.id) === cid) throw new HttpError(409, `contract task ${cid} already funds ${other.id}`);
      // Claimed before the await, so two overlapping /funded calls cannot both bind and run.
      if (claims.has(t.id) || claims.has(`cid:${cid}`)) throw new HttpError(409, `task ${t.id} or contract task ${cid} is already being checked`);
      claims.add(t.id).add(`cid:${cid}`);
      try {
        const { task: ct, subtasks } = await call(`${config.urls.chainGateway}/task/${cid}`);
        const want = expected(t);
        const bad = [
          ct.budget !== t.budget_atomic && `budget ${ct.budget} is not ${t.budget_atomic}`,
          ct.reserve !== want.reserve && `reserve ${ct.reserve} is not ${want.reserve}`,
          JSON.stringify(ct.caps) !== JSON.stringify(want.caps) && `caps ${JSON.stringify(ct.caps)} are not the plan's ${JSON.stringify(want.caps)}`,
          (ct.status !== 'Open' || ct.killed) && `contract task is ${ct.killed ? 'killed' : ct.status}`,
          // A signed-in owner binds only a contract task their own wallet funded, never someone else's matching one.
          t.owner !== null && ct.funder !== t.owner && `it was funded by ${ct.funder}, not by the task owner ${t.owner}`,
          subtasks.length > 0 && 'contract task already has funded subtasks',
        ].filter(Boolean);
        if (bad.length) throw new HttpError(409, `contract task ${cid} does not match the approved plan: ${bad.join('; ')}`);
        if (t.status !== 'approved') throw new HttpError(409, `task is ${t.status}, funded needs approved`); // killed meanwhile
        chain.bind(t.id, cid, want.nmap);
        t.funder = ct.funder;
        void runTask(ledger, t).catch((e) => console.error('[orchestrator] runTask', e));
        return { ...taskView(t), contract_task_id: cid };
      } finally {
        claims.delete(t.id); claims.delete(`cid:${cid}`);
      }
    },

    'POST /tasks/:id/cancel': ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      if (t.status !== 'planned') throw new HttpError(409, `task is ${t.status}, cancel needs planned`);
      setStatus(t, 'cancelled');
      return taskView(t);
    },

    'POST /tasks/:id/kill': ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      if (isTerminal(t.status)) throw new HttpError(409, `task is already ${t.status}`);
      kill(ledger, t);
      if (!chain) return taskView(t);
      const cmd = chain.killCommand(t.id, t.funder);
      return { ...taskView(t), human_action: cmd ? `The signer refuses new payments and Rook returns what the sub-accounts hold. To stop the task on the contract too, its funder (or the contract owner) calls kill_task: ${cmd}` : null };
    },

    /**
     * Security demo (`rook attack`): replays the injected deliverable's demands against the ledger's refusal paths on a
     * sandbox copy of this task's books (attack.ts). Enabled in every mode: it only reaches refusals, never money.
     */
    'POST /tasks/:id/attack': async ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      const allow = t.allow.length ? t.allow : (await call<X402Config>(`${config.urls.marketGateway}/x402`)).recipients ?? [];
      return { task_id: t.id, status: t.status, ledger: config.ledger, ...attack(t, allow) };
    },

    'GET /tasks/:id/events': (ctx) => events(ctx, owned(ctx.params.id, ctx.query.get('owner')), moving),
  }), port);

  return {
    ...running,
    close: async () => {
      for (const t of tasks.values()) if (!isTerminal(t.status)) t.abort.abort(new Error(SHUTDOWN)); // restore depends on it
      await running.close();
      persistWith(null);
      db?.close();
    },
  };
}

/** Why a plan with no subtasks can't run, in plain words, from its drop reasons (plan.ts buildPlan). */
export function emptyPlanReason(dropped: Plan['dropped']): string {
  const over = dropped.some((d) => d.reason === 'over budget');
  const none = dropped.some((d) => d.reason !== 'over budget');
  if (over && none) return 'No agent on the market can do some parts of this task, and the others cost more than this budget allows.';
  if (over) return 'Every part costs more than this budget allows; try a larger budget.';
  return 'No agent on the market can do any part of this task.';
}

/** Contract caps in plan order (self_do subtasks have none), Rook n -> contract n, and the reserve the contract will compute. */
function expected(t: Task) {
  const hired = t.subtasks.filter((s) => !s.self_do);
  const reserve_bps = Math.round(t.reserve_share * 10_000);
  return {
    reserve_bps, caps: hired.map((s) => s.cap_atomic), nmap: new Map(hired.map((s, i) => [s.n, i + 1])),
    reserve: ((BigInt(t.budget_atomic) * BigInt(reserve_bps)) / 10_000n).toString(),
  };
}

type ChainCfg = { contract_id: string | null; usdc: string | null; owner: string | null; min_budget: bigint; max_open_tasks: number | null };

/**
 * What the funder sends: USDC ft_transfer_call to the contract with the plan's caps in msg. Any account funds its own
 * task; `funder` is the signed-in owner who must send it (null for a CLI task: whoever sends it becomes the funder).
 * `reprint`: the task was approved before, so the funder's transfer may already have been sent and count toward the
 * open-task limit; the instructions must still come back (the web app asks again after a reload).
 */
async function fundingInstructions(t: Task, c: ChainCfg | null, reprint = false) {
  const want = expected(t);
  if (!want.caps.length) throw new HttpError(409, 'every subtask is self_do: nothing to fund on chain');
  if (want.reserve !== t.plan?.budget.reserve_atomic) {
    throw new HttpError(409, `reserve_share ${t.reserve_share} gives ${want.reserve} on chain but ${t.plan?.budget.reserve_atomic} in the plan; use a share with at most 4 decimals`);
  }
  if (c && BigInt(t.budget_atomic) < c.min_budget) {
    throw new HttpError(409, `budget ${formatUsdc(BigInt(t.budget_atomic))} USDC is below the contract's minimum of ${formatUsdc(c.min_budget)} USDC`);
  }
  const cfg = await call(`${config.urls.chainGateway}/config`);
  if (t.owner && c?.max_open_tasks && !reprint) {
    // The contract refunds a transfer over the limit: say so before the wallet opens.
    const open = await call<{ open: number }>(`${config.urls.chainGateway}/open-tasks?account=${encodeURIComponent(t.owner)}`).then((r) => r.open, () => 0);
    if (open >= c.max_open_tasks) throw new HttpError(409, `${t.owner} already has ${open} open tasks on the contract (the limit is ${c.max_open_tasks}); wait for one to close`);
  }
  return {
    network: cfg.network, contract_id: cfg.contract_id, usdc: cfg.usdc, funder: t.owner, contract_owner: cfg.owner ?? null,
    amount_atomic: t.budget_atomic,
    msg: JSON.stringify({ create_task: { reserve_bps: want.reserve_bps, caps: want.caps } }),
  };
}

/**
 * SSE: replay after Last-Event-ID (or ?after=), then stream; end after the terminal task_status event, or in chain
 * mode once the money a killed or failed task held is back (`moving` false). A payment_tx the indexer finds after that
 * is in the snapshot, not the stream.
 */
function events(ctx: Ctx, t: Task, moving: (t: Task) => boolean) {
  const after = Number(ctx.req.headers['last-event-id'] ?? ctx.query.get('after') ?? 0) || 0;
  const res = ctx.res;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const write = (e: RookEvent) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e, bigintReplacer)}\n\n`);
  for (const e of t.events) if (e.seq > after) write(e);
  if (isTerminal(t.status) && !moving(t)) { res.end(); return; }
  const fn = (e: RookEvent) => {
    write(e);
    // setStatus emits before it sets t.status, so the terminal event itself is read from the event.
    if ((isTerminal(t.status) || (e.type === 'task_status' && isTerminal(e.data.to))) && !moving(t)) { t.listeners.delete(fn); res.end(); }
  };
  t.listeners.add(fn);
  res.on('close', () => t.listeners.delete(fn));
}
