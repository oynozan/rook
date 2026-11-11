// Market gateway: search, x402 config, 402 quotes, A2A SendMessage/GetTask/CancelTask, one shared rate limit.
// docs/agentic-system.md section 9. `sim` talks to the simulator, `live` to market.near.ai.
import { randomUUID } from 'node:crypto';
import { config } from '../shared/config.ts';
import { serve, HttpError, type Running } from '../shared/http.ts';
import { AcceptsRow, type A2AState, type A2ATask, type AgentSummary, type GatewayError, type Part, type X402Config } from '../shared/types.ts';

const HANDLE = /^[a-z0-9-]+$/;
// Search paging: the market's largest page, how many pages one search may read, and how many available agents are
// enough (the planner keeps 12 per subtask, merged over up to 3 terms and a category).
const SEARCH_PAGE = 50, SEARCH_PAGES = 3, SEARCH_WANT = 20;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// Endpoints are resolved at call time so tests can point SIMULATOR_URL at a port-0 simulator.
function endpoints() {
  if (config.market === 'live') {
    const base = config.marketBase;
    return { search: `${base}/v1/agents`, x402: `${base}/.well-known/x402`, a2a: (h: string) => `https://${h}.market.near.ai/a2a/v1` };
  }
  const sim = config.urls.simulator;
  return { search: `${sim}/v1/agents`, x402: `${sim}/.well-known/x402`, a2a: (h: string) => `${sim}/a2a/${h}/v1` };
}

/** One token bucket for every outbound call (single instance, single egress IP). */
function tokenBucket(perMin: number) {
  let tokens = perMin, last = Date.now(), queue: Promise<void> = Promise.resolve();
  return () => (queue = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(perMin, tokens + ((now - last) * perMin) / 60_000);
      last = now;
      if (tokens >= 1) { tokens -= 1; return; }
      await sleep(((1 - tokens) * 60_000) / perMin);
    }
  }));
}

type Reply = { status: number; body: any };

const fail = (code: GatewayError['code'], message: string) => ({ ok: false as const, error: { code, message } });

/** Strip TASK_STATE_, accept v0.3 spellings ("completed", "canceled", "input-required"). */
function normState(s: unknown): A2AState {
  const v = String(s ?? '').toUpperCase().replace(/^TASK_STATE_/, '').replace(/-/g, '_');
  if (v === 'CANCELLED') return 'CANCELED';
  if (['SUBMITTED', 'WORKING', 'COMPLETED', 'REJECTED', 'FAILED', 'CANCELED'].includes(v)) return v as A2AState;
  // ponytail: x402 is one payment per task with no follow-up turns, so an agent asking for input cannot finish.
  if (v === 'INPUT_REQUIRED' || v === 'AUTH_REQUIRED') return 'REJECTED';
  return 'WORKING';
}

function normPart(p: any): Part {
  if (typeof p?.text === 'string') return { text: p.text };
  if (typeof p?.url === 'string') return { url: p.url };
  if (typeof p?.file?.uri === 'string') return { url: p.file.uri };
  if (typeof p?.raw === 'string') return { raw: p.raw };
  return { raw: JSON.stringify(p?.data ?? p) };
}

/**
 * SendMessage's result: a Task, or a Message, which A2A allows as a direct answer. A Message is a finished answer, so it
 * becomes a COMPLETED task carrying its parts (id: its taskId, else its messageId). Null when it is neither.
 */
export function sendResult(res: any): A2ATask | null {
  const m = res?.message ?? (res?.kind === 'message' || (Array.isArray(res?.parts) && !res?.status && !res?.artifacts) ? res : null);
  if (m && !res?.task) {
    return { id: String(m.taskId ?? m.messageId ?? `msg-${randomUUID()}`), context_id: m.contextId ?? null, state: 'COMPLETED', artifacts: [{ name: 'message', parts: (m.parts ?? []).map(normPart) }] };
  }
  const t = res?.task ?? res;
  return t?.id ? normTask(t) : null;
}

/** A paid call's window: the payment's maxTimeoutSeconds minus the marketplace's 10 minutes (x402 caller skill). */
function windowS(payment: string) {
  try { return Number(JSON.parse(Buffer.from(payment, 'base64').toString('utf8'))?.accepted?.maxTimeoutSeconds) - 600 || 0; } catch { return 0; }
}

export function normTask(t: any): A2ATask {
  return {
    id: String(t.id),
    context_id: t.contextId ?? t.context_id ?? null,
    state: normState(t.status?.state ?? t.state),
    artifacts: (t.artifacts ?? []).map((a: any) => ({ ...(a.name ? { name: a.name } : {}), parts: (a.parts ?? []).map(normPart) })),
    agent_message: agentMessage(t),
  };
}

const AGENT_MESSAGE_CHARS = 2000;
/**
 * The newest message the agent itself wrote: its status message when the agent wrote it, else the last agent turn in
 * the history. A finished task's status message is often Rook's own request echoed back (role user), never counted.
 * On mainnet an agent hired for a logo said at once that it only edits attached images, and Rook, not reading it,
 * waited out its patience.
 */
export function agentMessage(t: any): string | null {
  const isAgent = (m: any) => /agent/i.test(String(m?.role ?? ''));
  const textOf = (m: any) => (m?.parts ?? []).map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n').trim();
  const fromStatus = isAgent(t?.status?.message) ? textOf(t.status.message) : '';
  const fromHistory = [...(Array.isArray(t?.history) ? t.history : [])].reverse().find((m: any) => isAgent(m) && textOf(m));
  const text = fromStatus || (fromHistory ? textOf(fromHistory) : '');
  return text ? text.slice(0, AGENT_MESSAGE_CHARS) : null;
}

/**
 * What else a market listing says about an agent, when its row carries it: `bio` (bio_markdown, as plain text), the
 * `inputs` it takes and the `outputs` it returns (its input_schema and output_schema, one line each), and its median
 * `response_s`. The select step reads the first three: a description alone made a blog writer fit a logo and a stills
 * slideshow fit a motion-graphics video. The ranking reads `response_s`. All of it is the owner's untrusted text, flat
 * and capped here; a row without them (the simulator's) leaves them out.
 */
export type ListingDetail = { bio?: string; inputs?: string; outputs?: string; response_s?: number };
export type AgentListing = AgentSummary & ListingDetail;
const BIO_CHARS = 1200, SCHEMA_CHARS = 400;

/**
 * Markdown as one line of plain text: no headings, emphasis, tables, quotes or link targets. The text is cut before the
 * patterns run, so a crafted bio of a million "[" costs no more than a long one.
 */
const plain = (s: string, n: number) => s.slice(0, n * 3)
  .replace(/```[^\n]*\n?/g, ' ').replace(/!?\[([^\]\n]{0,200})\]\([^)\s]{0,500}\)/g, '$1').replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '')
  .replace(/[*_`|]+|-{3,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * A JSON Schema's top-level fields as "brief (required): What to make. · count (integer): 1-8 images", or ''. Tolerant:
 * a schema sent as JSON text is parsed, and anything that is not an object with `properties` says nothing.
 */
function fields(schema: unknown, n: number): string {
  let s: any = schema;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { return ''; } }
  const props = s && typeof s === 'object' && !Array.isArray(s) && s.properties && typeof s.properties === 'object' ? s.properties : null;
  if (!props) return '';
  const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
  const line = Object.entries(props).slice(0, 15).map(([k, v]: [string, any]) => {
    const kind = [required.has(k) && 'required', typeof v?.type === 'string' && v.type !== 'string' && v.type].filter(Boolean).join(', ');
    const what = typeof v?.description === 'string' ? `: ${v.description}` : Array.isArray(v?.enum) ? `: one of ${v.enum.slice(0, 8).join(', ')}` : '';
    return `${k}${kind ? ` (${kind})` : ''}${what}`;
  }).join(' · ');
  return plain(line, n);
}

function summary(x: any): AgentListing {
  const bio = typeof x.bio_markdown === 'string' ? plain(x.bio_markdown, BIO_CHARS) : typeof x.bio === 'string' ? plain(x.bio, BIO_CHARS) : '';
  const inputs = fields(x.input_schema, SCHEMA_CHARS), outputs = fields(x.output_schema, SCHEMA_CHARS);
  const response = Number(x.response_time_seconds_median);
  return {
    handle: String(x.handle ?? ''),
    name: String(x.name ?? x.handle ?? ''),
    description: String(x.description ?? ''),
    category: x.category ?? null,
    tags: Array.isArray(x.tags) ? x.tags.map((t: any) => String(t?.name ?? t)) : [],
    available_now: Boolean(x.available_now),
    listing_status: String(x.listing_status ?? ''),
    payable_with: Array.isArray(x.payable_with) ? x.payable_with.map(String) : [],
    // ponytail: a row without sla_seconds gets 600 s; the real market lists it on every agent.
    sla_seconds: Number(x.sla_seconds) || 600,
    success_rate: typeof x.success_rate === 'number' ? x.success_rate : null,
    delivered_jobs: Number(x.delivered_jobs ?? 0) || 0,
    ...(bio ? { bio } : {}), ...(inputs ? { inputs } : {}), ...(outputs ? { outputs } : {}),
    // A median of 0 or less is no measurement (a listing with no jobs yet).
    ...(x.response_time_seconds_median != null && Number.isFinite(response) && response > 0 ? { response_s: response } : {}),
  };
}

export async function start(port = config.ports.marketGateway): Promise<Running> {
  const take = tokenBucket(config.ratePerMin);

  /** Rate-limited fetch; 429 backs off and retries up to 3 times. Throws on network errors. */
  async function out(url: string, init: RequestInit = {}): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      await take();
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
      const text = await r.text();
      if (r.status === 429 && attempt < 3) {
        const after = Number(r.headers.get('retry-after'));
        await sleep(after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      let body: any = text;
      try { body = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
      return { status: r.status, body };
    }
  }

  function rpc(handle: string, method: string, params: unknown, payment?: string): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (payment) headers['X-PAYMENT'] = payment;
    return out(endpoints().a2a(handle), { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
  }

  /** Maps a non-success reply to a gateway error: JSON-RPC errors keep their code, other HTTP statuses use theirs. */
  function replyError(r: Reply) {
    if (r.body?.error?.code !== undefined) return fail(r.body.error.code, String(r.body.error.message ?? ''));
    const msg = typeof r.body?.error === 'string' ? r.body.error : typeof r.body === 'string' ? r.body.slice(0, 300) : `HTTP ${r.status}`;
    return fail(r.status, msg);
  }

  const checkHandle = (h: unknown) => {
    if (typeof h !== 'string' || !HANDLE.test(h)) throw new HttpError(400, `invalid handle: ${String(h)}`);
    return h;
  };

  let x402: X402Config | undefined;
  async function loadX402(): Promise<X402Config> {
    const r = await out(endpoints().x402);
    if (r.status !== 200 || !Array.isArray(r.body?.recipients)) throw new Error(`x402 config: HTTP ${r.status}`);
    return (x402 = r.body as X402Config);
  }
  try { await loadX402(); } catch (e: any) { console.warn(`[market-gateway] /.well-known/x402 not loaded at startup, will retry: ${e?.message ?? e}`); }

  return serve('market-gateway', {
    // The market pages its search (limit at most 50, then offset) and lists offline agents too, often half a page:
    // read pages until SEARCH_WANT agents are available now, the results end, or SEARCH_PAGES pages were read.
    'GET /search': async ({ query }) => {
      const q = encodeURIComponent(query.get('q') ?? '');
      // A category alone lists that category's agents (the planner's broad search for a kind of work).
      const category = query.get('category') ?? '';
      if (category && !/^[a-z_]{1,40}$/.test(category)) throw new HttpError(400, 'category must be lowercase letters and _');
      const filter = category ? `&category=${category}` : '';
      // A bare category listing is read whole (up to SEARCH_PAGES): the planner picks from it by fit, not by its order.
      const want = category && !query.get('q') ? Infinity : SEARCH_WANT;
      const agents: AgentListing[] = [], seen = new Set<string>();
      for (let page = 0; page < SEARCH_PAGES && agents.length < want; page++) {
        let r: Reply | undefined, err = '';
        try { r = await out(`${endpoints().search}?q=${q}${filter}&limit=${SEARCH_PAGE}&offset=${page * SEARCH_PAGE}`); } catch (e: any) { err = `market search unreachable: ${e?.message ?? e}`; }
        if (r && r.status !== 200) err = `market search: HTTP ${r.status}`;
        if (err || !r) {
          if (page > 0) break; // a later page failing still leaves the agents already found
          throw new HttpError(502, err);
        }
        const rows: any[] = Array.isArray(r.body) ? r.body : r.body?.agents ?? r.body?.data ?? r.body?.items ?? [];
        let fresh = 0;
        for (const a of rows.map(summary)) {
          if (!a.handle || seen.has(a.handle)) continue;
          seen.add(a.handle); fresh++;
          if (a.available_now) agents.push(a);
        }
        if (rows.length < SEARCH_PAGE || !fresh) break; // the last page, or a search that ignores offset
      }
      return { agents };
    },

    'GET /x402': async () => {
      if (x402) return x402;
      try { return await loadX402(); } catch (e: any) { throw new HttpError(502, e?.message ?? String(e)); }
    },

    'POST /quote': async ({ body }) => {
      const handle = checkHandle(body?.handle);
      let r: Reply;
      try {
        r = await rpc(handle, 'SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Price quote request.' }] } });
      } catch (e: any) { return fail('unreachable', e?.message ?? String(e)); }
      if (r.status === 402) {
        const accepts: any[] = Array.isArray(r.body?.accepts) ? r.body.accepts : [];
        if (accepts.length === 0) return fail('no_payments', 'agent accepts no payment method');
        const row = accepts.find((x) => typeof x?.network === 'string' && x.network.startsWith('near:'));
        if (!row) return fail('no_payments', 'agent accepts no NEAR payment');
        const v = AcceptsRow.safeParse(row);
        if (!v.success) return fail('bad_quote', `malformed accepts row: ${v.error.message.slice(0, 300)}`);
        return { ok: true, row }; // verbatim: the payment must echo it exactly
      }
      if (r.status === 200 && r.body?.result) return fail('no_quote', 'agent accepted the message without payment');
      return replyError(r);
    },

    'POST /send': async ({ body }) => {
      const handle = checkHandle(body?.handle);
      if (typeof body?.payment !== 'string' || !body.payment) throw new HttpError(400, 'payment is required: /send without it would only return a quote');
      if (typeof body?.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'text is required');
      const message: Record<string, unknown> = { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: body.text }] };
      if (body.context_id) message.contextId = body.context_id;
      // Over 60 s the agent would not finish inside the call's 60 s hold: take the task id at once and poll from the start.
      const configuration = { historyLength: 0, ...(windowS(body.payment) > 60 ? { returnImmediately: true } : {}) };
      let r: Reply | undefined, saw502 = false;
      try {
        // 502 means the facilitator was unreachable: retry with the SAME header, never re-sign.
        for (let attempt = 0; attempt <= 3; attempt++) {
          if (attempt) await sleep(1000 * 2 ** (attempt - 1));
          r = await rpc(handle, 'SendMessage', { message, configuration }, body.payment);
          if (r.status !== 502) break;
          saw502 = true;
        }
      } catch (e: any) {
        // A paid send that fails holds its payment until Rook voids it: say why, for whoever runs Rook.
        console.warn(`[market-gateway] paid send to ${handle} failed${saw502 ? ' after a 502' : ''}: ${e?.message ?? e}`);
        if (saw502) return fail('outcome_unknown', `after a 502: ${e?.message ?? e}`);
        return fail('unreachable', e?.message ?? String(e));
      }
      const ok = r!.status === 200 && r!.body?.result;
      if (!ok) console.warn(`[market-gateway] paid send to ${handle}: HTTP ${r!.status} ${JSON.stringify(r!.body ?? null).slice(0, 300)}`);
      // A 502 may have settled the payment before failing, so a later 402 ("already used") or a final 502 does not
      // prove the header is unspent: the orchestrator must count it as possibly charged, not release it.
      if (saw502 && !ok) return fail('outcome_unknown', `after a 502 the agent answered HTTP ${r!.status}: payment may have settled`);
      if (r!.status === 402) return fail(402, typeof r!.body?.error === 'string' ? r!.body.error : 'payment refused');
      if (r!.status === 200 && r!.body?.result) {
        const task = sendResult(r!.body.result);
        if (!task) return fail('no_task', 'agent replied without a task or a message');
        return { ok: true, task };
      }
      return replyError(r!);
    },

    'GET /task': async ({ query }) => {
      const handle = checkHandle(query.get('handle'));
      const id = query.get('id');
      if (!id) throw new HttpError(400, 'id is required');
      let r: Reply;
      try { r = await rpc(handle, 'GetTask', { id }); } catch (e: any) { return fail('unreachable', e?.message ?? String(e)); }
      if (r.status === 200 && r.body?.result) {
        const t = r.body.result.task ?? r.body.result;
        return { ok: true, task: normTask(t) };
      }
      return replyError(r);
    },

    'POST /cancel': async ({ body }) => {
      const handle = checkHandle(body?.handle);
      if (typeof body?.id !== 'string' || !body.id) throw new HttpError(400, 'id is required');
      let r: Reply;
      try { r = await rpc(handle, 'CancelTask', { id: body.id }); } catch (e: any) { return fail('unreachable', e?.message ?? String(e)); }
      if (r.status === 200 && r.body?.result) return { ok: true };
      return replyError(r);
    },
  }, port);
}
