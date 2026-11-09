// Orchestrator HTTP API (docs/agentic-system.md section 8.1). No side effects on import.
import { z } from 'zod';
import { config } from '../shared/config.ts';
import { bigintReplacer, call, HttpError, serve, type Ctx, type Running } from '../shared/http.ts';
import { parseUsdc } from '../shared/money.ts';
import type { Plan, RookEvent } from '../shared/types.ts';
import { createChainLedger } from './chain-ledger.ts';
import { createLedger, type Ledger } from './ledger.ts';
import { kill, runTask } from './runner.ts';
import { openStore } from './db.ts';
import { emit, fromDoc, isTerminal, newTask, persistWith, saveTask, setPlan, setStatus, snapshot, taskView, toDoc, type Task } from './store.ts';

const CreateBody = z.object({
  prompt: z.string().trim().min(1),
  budget_usdc: z.union([z.string(), z.number()]),
  reserve_share: z.number().min(0).max(0.9).optional(),
  owner: z.string().min(2).max(64).optional(), // set by the web app from a verified wallet sign-in
  wait: z.boolean().optional(), // false: answer at once with the draft task and plan in the background (progress as events)
});

/**
 * Asks the planner for a plan, relaying its progress lines as `planning` events. A planner that answers with plain
 * JSON (an older one, or a test double) still works: there is just no progress to relay.
 */
async function planWithProgress(t: Task): Promise<Plan> {
  emit(t, 'planning', { stage: 'drafting' });
  const r = await fetch(config.urls.planner + '/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
    body: JSON.stringify({ task_id: t.id, prompt: t.prompt, budget_atomic: t.budget_atomic, reserve_share: t.reserve_share }),
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
  // The web app passes the signed-in account as `owner`; someone else's task looks like no task at all. Callers that
  // pass no owner (the CLI, on this machine) act on any task: the orchestrator only listens on localhost.
  const owned = (id: string, owner: unknown) => {
    const t = get(id);
    if (typeof owner === 'string' && t.owner !== owner) throw new HttpError(404, `no task ${id}`);
    return t;
  };

  // With ROOK_DB set, tasks survive restarts. A task that was mid-run cannot pick up where it left off (its in-flight
  // hires and payment authorizations lived in memory), so it is marked failed with the reason. A plan waiting for
  // approval carries on, and so does a chain-mode task waiting for its funding transaction.
  const db = config.dbPath ? openStore(config.dbPath) : null;
  if (db) {
    for (const doc of db.load()) tasks.set(doc.id, fromDoc(doc));
    persistWith((t) => { if (tasks.has(t.id)) db.save({ ...toDoc(t), ledger_saved: ledger.view(t.id) ?? t.ledger_saved ?? null }); });
    for (const t of tasks.values()) {
      const waiting = t.status === 'planned' || (chain !== null && t.status === 'approved');
      if (isTerminal(t.status) || waiting) continue;
      const was = t.status;
      t.error = `Rook's services restarted while this task was ${was}, so it stopped there. Nothing more will be spent on it.`;
      emit(t, 'error', { message: t.error });
      setStatus(t, 'failed');
    }
    console.log(`[orchestrator] ${tasks.size} task${tasks.size === 1 ? '' : 's'} loaded from ${config.dbPath}`);
  }

  const running = await serve('orchestrator', {
    'POST /tasks': async ({ body }) => {
      const b = CreateBody.parse(body ?? {});
      let budget: bigint;
      try { budget = parseUsdc(b.budget_usdc); } catch (e: any) { throw new HttpError(400, e.message); }
      if (budget <= 0n) throw new HttpError(400, 'budget_usdc must be positive');
      const t = newTask(b.prompt, budget, b.reserve_share ?? 0.2, b.owner ?? null);
      tasks.set(t.id, t);
      saveTask(t);
      const planning = (async () => {
        try {
          // A kill during planning aborts the wait. ponytail: the planner does not watch the disconnect, so its LLM
          // calls for this plan still finish (and are not in this task's cost).
          const plan = await planWithProgress(t);
          if (isTerminal(t.status)) return;
          setPlan(t, plan);
          emit(t, 'plan', plan);
          setStatus(t, 'planned');
        } catch (e: any) {
          if (isTerminal(t.status)) return; // killed while planning: stays killed
          t.error = `planner: ${e?.message ?? e}`;
          emit(t, 'error', { message: t.error });
          setStatus(t, 'failed');
        }
      })();
      if (b.wait === false) return taskView(t); // the caller follows along on /tasks/:id/events
      await planning;
      return taskView(t);
    },

    /** Which market, model and ledger this orchestrator runs with, so a client can label things honestly. No secrets. */
    'GET /mode': () => ({ market: config.market, llm: config.llm, ledger: config.ledger, paying: config.ledger === 'chain' }),

    'GET /tasks': ({ query }) => ({
      tasks: [...tasks.values()]
        .filter((t) => !query.has('owner') || t.owner === query.get('owner'))
        .map(({ id, status, prompt, created_at }) => ({ id, status, prompt, created_at })),
    }),

    'GET /tasks/:id': ({ params }) => snapshot(get(params.id), ledger),

    'POST /tasks/:id/approve': async ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      const reprint = chain && t.status === 'approved' && !chain.contractTaskOf(t.id); // funding instructions again
      if (t.status !== 'planned' && !reprint) throw new HttpError(409, `task is ${t.status}, approve needs planned`);
      if (!t.subtasks.length) throw new HttpError(409, 'the plan has no subtasks');
      if (config.market === 'live' && !chain) {
        throw new HttpError(409, 'live market: paying agents needs ROOK_LEDGER=chain (signer, chain-gateway, budget contract); see docs/x402-payments-plan.md');
      }
      if (chain) {
        // Rook never creates the task on chain: the human funds it with the caps they approve, then calls /funded.
        const funding = await fundingInstructions(t);
        setStatus(t, 'approved');
        return { ...taskView(t), funding };
      }
      t.funder = typeof body?.funder_account === 'string' && body.funder_account ? body.funder_account : 'funder.sim';
      setStatus(t, 'approved');
      void runTask(ledger, t).catch((e) => console.error('[orchestrator] runTask', e));
      return taskView(t);
    },

    /** Chain mode: the human's ft_transfer_call created contract task `contract_task_id`; check it matches the plan, then run. */
    'POST /tasks/:id/funded': async ({ params, body }) => {
      const t = get(params.id);
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
      const cid = chain.contractTaskOf(t.id);
      return { ...taskView(t), human_action: cid ? `The signer refuses new payments. To stop funding on chain too, the contract owner calls kill_task: near contract call-function as-transaction ${config.contractId || '<contract>'} kill_task json-args '{"task_id":"${cid}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <owner> network-config ${config.nearNetwork} sign-with-keychain send` : null };
    },

    'GET /tasks/:id/events': (ctx) => events(ctx, get(ctx.params.id)),
  }, port);

  return {
    ...running,
    close: async () => {
      for (const t of tasks.values()) if (!isTerminal(t.status)) t.abort.abort(new Error('orchestrator shutting down'));
      await running.close();
      persistWith(null);
      db?.close();
    },
  };
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

/** What the human sends: USDC ft_transfer_call to the contract with the plan's caps in msg. */
async function fundingInstructions(t: Task) {
  const want = expected(t);
  if (!want.caps.length) throw new HttpError(409, 'every subtask is self_do: nothing to fund on chain');
  if (want.reserve !== t.plan?.budget.reserve_atomic) {
    throw new HttpError(409, `reserve_share ${t.reserve_share} gives ${want.reserve} on chain but ${t.plan?.budget.reserve_atomic} in the plan; use a share with at most 4 decimals`);
  }
  const cfg = await call(`${config.urls.chainGateway}/config`);
  return {
    network: cfg.network, contract_id: cfg.contract_id, usdc: cfg.usdc, funder: cfg.owner, amount_atomic: t.budget_atomic,
    msg: JSON.stringify({ create_task: { reserve_bps: want.reserve_bps, caps: want.caps } }),
  };
}

/** SSE: replay after Last-Event-ID (or ?after=), then stream; end after the terminal task_status event. */
function events(ctx: Ctx, t: Task) {
  const after = Number(ctx.req.headers['last-event-id'] ?? ctx.query.get('after') ?? 0) || 0;
  const res = ctx.res;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const write = (e: RookEvent) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e, bigintReplacer)}\n\n`);
  for (const e of t.events) if (e.seq > after) write(e);
  if (isTerminal(t.status)) { res.end(); return; }
  const fn = (e: RookEvent) => {
    write(e);
    if (e.type === 'task_status' && isTerminal(e.data.to)) { t.listeners.delete(fn); res.end(); }
  };
  t.listeners.add(fn);
  res.on('close', () => t.listeners.delete(fn));
}
