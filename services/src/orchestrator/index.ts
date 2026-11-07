// Orchestrator HTTP API (docs/agentic-system.md section 8.1). No side effects on import.
import { z } from 'zod';
import { config } from '../shared/config.ts';
import { bigintReplacer, call, HttpError, serve, type Ctx, type Running } from '../shared/http.ts';
import { parseUsdc } from '../shared/money.ts';
import type { Plan, RookEvent } from '../shared/types.ts';
import { createLedger } from './ledger.ts';
import { kill, runTask } from './runner.ts';
import { emit, isTerminal, newTask, setPlan, setStatus, snapshot, taskView, type Task } from './store.ts';

const CreateBody = z.object({
  prompt: z.string().trim().min(1),
  budget_usdc: z.union([z.string(), z.number()]),
  reserve_share: z.number().min(0).max(0.9).optional(),
});

export async function start(port = config.ports.orchestrator): Promise<Running> {
  const tasks = new Map<string, Task>();
  const ledger = createLedger();
  const get = (id: string) => {
    const t = tasks.get(id);
    if (!t) throw new HttpError(404, `no task ${id}`);
    return t;
  };

  const running = await serve('orchestrator', {
    'POST /tasks': async ({ body }) => {
      const b = CreateBody.parse(body ?? {});
      let budget: bigint;
      try { budget = parseUsdc(b.budget_usdc); } catch (e: any) { throw new HttpError(400, e.message); }
      if (budget <= 0n) throw new HttpError(400, 'budget_usdc must be positive');
      const t = newTask(b.prompt, budget, b.reserve_share ?? 0.2);
      tasks.set(t.id, t);
      try {
        // A kill during planning aborts the wait. ponytail: the planner does not watch the disconnect, so its LLM
        // calls for this plan still finish (and are not in this task's cost).
        const plan = await call<Plan>(config.urls.planner + '/plan', {
          task_id: t.id, prompt: t.prompt, budget_atomic: t.budget_atomic, reserve_share: t.reserve_share,
        }, { signal: t.abort.signal });
        if (isTerminal(t.status)) return taskView(t);
        setPlan(t, plan);
        emit(t, 'plan', plan);
        setStatus(t, 'planned');
      } catch (e: any) {
        if (isTerminal(t.status)) return taskView(t); // killed while planning: stays killed
        t.error = `planner: ${e?.message ?? e}`;
        emit(t, 'error', { message: t.error });
        setStatus(t, 'failed');
      }
      return taskView(t);
    },

    'GET /tasks': () => ({
      tasks: [...tasks.values()].map(({ id, status, prompt, created_at }) => ({ id, status, prompt, created_at })),
    }),

    'GET /tasks/:id': ({ params }) => snapshot(get(params.id), ledger),

    'POST /tasks/:id/approve': ({ params, body }) => {
      const t = get(params.id);
      if (t.status !== 'planned') throw new HttpError(409, `task is ${t.status}, approve needs planned`);
      if (!t.subtasks.length) throw new HttpError(409, 'the plan has no subtasks');
      if (config.market === 'live') {
        throw new HttpError(409, 'live market: paying agents needs x402 signing, which is phase 2; see docs/x402-payments-plan.md');
      }
      t.funder = typeof body?.funder_account === 'string' && body.funder_account ? body.funder_account : 'funder.sim';
      setStatus(t, 'approved');
      void runTask(ledger, t).catch((e) => console.error('[orchestrator] runTask', e));
      return taskView(t);
    },

    'POST /tasks/:id/cancel': ({ params }) => {
      const t = get(params.id);
      if (t.status !== 'planned') throw new HttpError(409, `task is ${t.status}, cancel needs planned`);
      setStatus(t, 'cancelled');
      return taskView(t);
    },

    'POST /tasks/:id/kill': ({ params }) => {
      const t = get(params.id);
      if (isTerminal(t.status)) throw new HttpError(409, `task is already ${t.status}`);
      kill(ledger, t);
      return taskView(t);
    },

    'GET /tasks/:id/events': (ctx) => events(ctx, get(ctx.params.id)),
  }, port);

  return {
    ...running,
    close: async () => {
      for (const t of tasks.values()) if (!isTerminal(t.status)) t.abort.abort(new Error('orchestrator shutting down'));
      await running.close();
    },
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
