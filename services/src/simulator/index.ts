// Fake Agent Market: search, /.well-known/x402, and A2A JSON-RPC with x402 quotes and payment checks.
// docs/agentic-system.md section 10. Wire format follows market.near.ai (build-plan.md, market-gateway).
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { config } from '../shared/config.ts';
import { serve, sendJson, HttpError, type Running } from '../shared/http.ts';
import { llmSpentUsd } from '../shared/llm.ts';
import { AGENTS, deliverable, type SimAgent } from './agents.ts';

const NETWORK = 'near:mainnet', ASSET = 'usdc.sim', PAY_TO = 'treasury.sim';
const SLOW_MS = 120_000;

// Read at call time so tests can tune them.
const slaS = () => Number(process.env.SIM_SLA_S ?? 20);
const deliveryMs = () => Number(process.env.SIM_DELIVERY_MS ?? 3000);
const holdMs = () => Number(process.env.SIM_HOLD_MS ?? 2000);

type State = 'SUBMITTED' | 'WORKING' | 'COMPLETED' | 'FAILED' | 'CANCELED';
type SimTask = { id: string; contextId: string; handle: string; state: State; text?: string; timers: NodeJS.Timeout[] };

// The payment authorization is valid for the SLA plus Rook's payment grace: the window Rook waits on a hire before
// it gives up and releases the authorization. A task still running when it expires cannot be charged: it FAILS.
const quoteRow = (agent: SimAgent) => ({
  scheme: 'exact', network: NETWORK, asset: ASSET, amount: agent.price_atomic, payTo: PAY_TO, maxTimeoutSeconds: slaS() + config.paymentGraceS,
});

const listing = (agent: SimAgent) => ({
  agent_id: `sim-${agent.handle}`, handle: agent.handle, name: agent.name, description: agent.description,
  category: 'research', tags: agent.tags, available_now: true, listing_status: 'live', payable_with: ['USDC'],
  sla_seconds: slaS(), success_rate: agent.success_rate, delivered_jobs: agent.delivered_jobs,
});

/** Key-sorted JSON, so the payment's `accepted` row compares by value, not key order. */
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
  : JSON.stringify(v);

/** Deterministic per-handle spread of -33%..+33% around the base delivery time (2 to 4 s by default). */
function deliverAfter(agent: SimAgent): number {
  if (agent.profile === 'slow') return SLOW_MS;
  const h = [...agent.handle].reduce((s, c) => s + c.charCodeAt(0), 0);
  return Math.round(deliveryMs() * (1 + ((h % 21) - 10) / 30));
}

const wire = (t: SimTask) => ({
  id: t.id, contextId: t.contextId, status: { state: `TASK_STATE_${t.state}` },
  artifacts: t.text === undefined ? [] : [{ artifactId: `${t.id}-1`, name: 'deliverable.md', parts: [{ text: t.text }] }],
});

const isTerminal = (s: State) => s === 'COMPLETED' || s === 'FAILED' || s === 'CANCELED';
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export function start(port = config.ports.simulator): Promise<Running> {
  const tasks = new Map<string, SimTask>();
  const usedPayments = new Set<string>();

  function launch(agent: SimAgent, brief: string, contextId: string): SimTask {
    const t: SimTask = { id: randomUUID(), contextId, handle: agent.handle, state: 'SUBMITTED', timers: [] };
    tasks.set(t.id, t);
    const total = deliverAfter(agent), expiry = quoteRow(agent).maxTimeoutSeconds * 1000;
    // Start writing now (an LLM call in near mode) so the writing time overlaps the scripted delay.
    const text = agent.profile === 'fails' || total > expiry ? null : deliverable(agent, brief);
    t.timers.push(setTimeout(() => { if (t.state === 'SUBMITTED') t.state = 'WORKING'; }, Math.round(Math.min(total, expiry) / 2)));
    if (!text) { // `fails`, or delivery after the authorization expired: settlement fails when the agent finishes
      t.timers.push(setTimeout(() => { if (t.state === 'WORKING') t.state = 'FAILED'; }, total));
      return t;
    }
    const started = Date.now();
    t.timers.push(setTimeout(async () => {
      const body = await text;
      if (t.state !== 'WORKING') return;
      if (Date.now() - started > expiry) t.state = 'FAILED'; // writing outlived the authorization: nothing to charge
      else { t.text = body; t.state = 'COMPLETED'; }
    }, total));
    return t;
  }

  function payment402(res: ServerResponse, agent: SimAgent, error: string) {
    sendJson(res, 402, { x402Version: 2, error, accepts: [quoteRow(agent)] });
  }

  /** Returns an error message, or undefined when the header pays exactly this agent's quote and is fresh. */
  function checkPayment(header: string, agent: SimAgent): string | undefined {
    if (usedPayments.has(header)) return 'X-PAYMENT already used';
    let p: any;
    try { p = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { return 'X-PAYMENT is not base64 JSON'; }
    if (p?.x402Version !== 2) return 'unsupported x402Version';
    if (canon(p.accepted) !== canon(quoteRow(agent))) return 'X-PAYMENT accepted row does not match the quote';
    if (!p.payload || typeof p.payload !== 'object') return 'X-PAYMENT has no payload';
    return undefined;
  }

  const rpcOk = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
  const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  const running = serve('simulator', {
    'GET /v1/agents': ({ query }) => {
      const words = (query.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const hit = (a: SimAgent) => {
        const hay = [a.handle, a.name, a.description, ...a.tags].join(' ').toLowerCase();
        return words.length === 0 || words.some((w) => hay.includes(w));
      };
      return { agents: AGENTS.filter(hit).map(listing) };
    },

    // NEAR AI spend of the simulated agents (process total), so the CLI can report the full cost of a run.
    'GET /llm-cost': () => ({ spent_usd: Number(llmSpentUsd().toFixed(6)) }),

    'GET /.well-known/x402': () => ({ x402Version: 2, recipients: [{ network: NETWORK, asset: ASSET, payTo: PAY_TO }] }),

    'POST /a2a/:handle/v1': async ({ params, body, req, res }) => {
      const agent = AGENTS.find((a) => a.handle === params.handle);
      if (!agent) throw new HttpError(404, `unknown agent ${params.handle}`);
      const id = body?.id ?? null;
      const p = body?.params ?? {};

      switch (body?.method) {
        case 'SendMessage': {
          const header = req.headers['x-payment'];
          if (typeof header !== 'string' || !header) return payment402(res, agent, 'X-PAYMENT header is required');
          const err = checkPayment(header, agent);
          if (err) return payment402(res, agent, err);
          const parts: any[] = p.message?.parts ?? [];
          const brief = parts.map((x) => x?.text).filter((x) => typeof x === 'string').join('\n\n');
          if (!brief.trim()) return rpcErr(id, -32602, 'message needs at least one text part');
          usedPayments.add(header);
          const t = launch(agent, brief, typeof p.message?.contextId === 'string' ? p.message.contextId : randomUUID());
          // Hold the connection like the real market, up to SIM_HOLD_MS, waiting for a terminal state.
          for (const until = Date.now() + holdMs(); !isTerminal(t.state) && Date.now() < until;) await sleep(Math.min(50, holdMs()));
          return rpcOk(id, { task: wire(t) });
        }
        case 'GetTask': {
          const t = tasks.get(p.id);
          return t && t.handle === agent.handle ? rpcOk(id, wire(t)) : rpcErr(id, -32001, 'Task not found');
        }
        case 'CancelTask': {
          const t = tasks.get(p.id);
          if (!t || t.handle !== agent.handle) return rpcErr(id, -32001, 'Task not found');
          if (t.state !== 'SUBMITTED') return rpcErr(id, -32002, `Task cannot be canceled in state ${t.state}`);
          t.timers.forEach(clearTimeout);
          t.state = 'CANCELED';
          return rpcOk(id, wire(t));
        }
        default:
          return rpcErr(id, -32601, `Method not found: ${body?.method}`);
      }
    },
  }, port);

  // Clear pending timers on close so the slow agent's 120 s timer does not keep the process alive.
  return running.then((r) => ({ ...r, close: () => { for (const t of tasks.values()) t.timers.forEach(clearTimeout); return r.close(); } }));
}
