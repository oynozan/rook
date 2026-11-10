// Fake Agent Market: search, /.well-known/x402, and A2A JSON-RPC with x402 quotes and payment checks.
// docs/agentic-system.md section 10. Wire format follows market.near.ai (build-plan.md, market-gateway).
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { config } from '../shared/config.ts';
import { serve, sendJson, HttpError, type Running } from '../shared/http.ts';
import { llmSpentUsd } from '../shared/llm.ts';
import { TGAS, latestBlock, verifySignedDelegate, type DecodedDelegate } from '../shared/near.ts';
import { AGENTS, deliverable, type SimAgent } from './agents.ts';

// SIM_PAYMENT_NETWORK (e.g. near:testnet) switches to real NEP-366 payments: the row names a real token and payee,
// and a paid SendMessage must carry a signedDelegateAction that verifies. It is checked, never submitted.
const nearPay = () => process.env.SIM_PAYMENT_NETWORK || null;
const recipient = () => nearPay()
  ? { network: nearPay()!, asset: process.env.SIM_USDC_ID ?? '', payTo: process.env.SIM_PAY_TO ?? '' }
  : { network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim' };
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
  scheme: 'exact', ...recipient(), amount: agent.price_atomic, maxTimeoutSeconds: slaS() + config.paymentGraceS,
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
  // sender/key -> delegates accepted, with the task each paid for. Like the chain: a COMPLETED task settled its delegate,
  // which uses that nonce and every lower one; a FAILED or CANCELED one never settled, so its nonce is free again.
  const delegates = new Map<string, { nonce: bigint; task: SimTask }[]>();
  type Paid = { error: string } | { delegate: DecodedDelegate | null };

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

  /** An error, or the payment (with its delegate in NEAR mode) when the header pays exactly this agent's quote and is fresh. */
  async function checkPayment(header: string, agent: SimAgent): Promise<Paid> {
    if (usedPayments.has(header)) return { error: 'X-PAYMENT already used' };
    let p: any;
    try { p = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { return { error: 'X-PAYMENT is not base64 JSON' }; }
    if (p?.x402Version !== 2) return { error: 'unsupported x402Version' };
    if (canon(p.accepted) !== canon(quoteRow(agent))) return { error: 'X-PAYMENT accepted row does not match the quote' };
    if (!p.payload || typeof p.payload !== 'object') return { error: 'X-PAYMENT has no payload' };
    if (!nearPay()) return { delegate: null };
    const d = await checkDelegate(p.payload.signedDelegateAction, quoteRow(agent));
    return typeof d === 'string' ? { error: d } : { delegate: d };
  }

  /** What a NEAR x402 facilitator checks before submitting: signature, token, payee, amount, gas, deposit, expiry, nonce. */
  async function checkDelegate(b64: unknown, row: ReturnType<typeof quoteRow>): Promise<string | DecodedDelegate> {
    if (typeof b64 !== 'string' || !b64) return 'X-PAYMENT has no signedDelegateAction';
    let d;
    try { d = verifySignedDelegate(b64); } catch (e: any) { return `signedDelegateAction: ${e?.message ?? e}`; }
    if (!d.senderId) return 'delegate has no senderId';
    if (d.receiverId !== row.asset) return `delegate receiverId ${d.receiverId} is not the asset ${row.asset}`;
    const fc = d.actions.length === 1 ? d.actions[0].functionCall : undefined;
    if (!fc || fc.methodName !== 'ft_transfer') return 'delegate must hold exactly one ft_transfer function call';
    let args: any;
    try { args = JSON.parse(Buffer.from(fc.args).toString('utf8')); } catch { return 'ft_transfer args are not JSON'; }
    if (canon(args) !== canon({ receiver_id: row.payTo, amount: row.amount })) return 'ft_transfer args do not pay the quoted payTo and amount';
    if (BigInt(fc.deposit) !== 1n) return 'ft_transfer deposit must be 1 yoctoNEAR';
    if (BigInt(fc.gas) !== 30n * TGAS) return 'ft_transfer gas must be 30 Tgas';
    let height: number;
    try { height = (await latestBlock()).height; } catch (e: any) { return `cannot read the block height: ${e?.message ?? e}`; }
    if (d.maxBlockHeight <= BigInt(height)) return `delegate expired at block ${d.maxBlockHeight} (now ${height})`;
    return usedErr(d) ?? d;
  }

  /** Synchronous, so it is checked again right before a task is started for the delegate. */
  function usedErr(d: DecodedDelegate): string | undefined {
    for (const h of delegates.get(`${d.senderId}/${d.publicKey}`) ?? []) {
      if (h.task.state === 'COMPLETED' && d.nonce <= h.nonce) return 'delegate nonce already used';
      if (h.nonce === d.nonce && h.task.state !== 'FAILED' && h.task.state !== 'CANCELED') return 'delegate already used';
    }
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
      const category = query.get('category');
      return { agents: AGENTS.filter(hit).map(listing).filter((a) => !category || a.category === category) };
    },

    // NEAR AI spend of the simulated agents (process total), so the CLI can report the full cost of a run.
    'GET /llm-cost': () => ({ spent_usd: Number(llmSpentUsd().toFixed(6)) }),

    'GET /.well-known/x402': () => ({ x402Version: 2, recipients: [recipient()] }),

    'POST /a2a/:handle/v1': async ({ params, body, req, res }) => {
      const agent = AGENTS.find((a) => a.handle === params.handle);
      if (!agent) throw new HttpError(404, `unknown agent ${params.handle}`);
      const id = body?.id ?? null;
      const p = body?.params ?? {};

      switch (body?.method) {
        case 'SendMessage': {
          const header = req.headers['x-payment'];
          if (typeof header !== 'string' || !header) return payment402(res, agent, 'X-PAYMENT header is required');
          const paid = await checkPayment(header, agent);
          if ('error' in paid) return payment402(res, agent, paid.error);
          const parts: any[] = p.message?.parts ?? [];
          const brief = parts.map((x) => x?.text).filter((x) => typeof x === 'string').join('\n\n');
          if (!brief.trim()) return rpcErr(id, -32602, 'message needs at least one text part'); // nothing submitted
          // Re-checked with no await before launch: two concurrent sends of one payment must not both start.
          const again = usedPayments.has(header) ? 'X-PAYMENT already used' : paid.delegate && usedErr(paid.delegate);
          if (again) return payment402(res, agent, again);
          usedPayments.add(header);
          const t = launch(agent, brief, typeof p.message?.contextId === 'string' ? p.message.contextId : randomUUID());
          if (paid.delegate) {
            const k = `${paid.delegate.senderId}/${paid.delegate.publicKey}`;
            delegates.set(k, [...(delegates.get(k) ?? []), { nonce: paid.delegate.nonce, task: t }]);
          }
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
