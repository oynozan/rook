// NEAR AI Cloud client: chat, chat with tools (web search, functions), JSON-with-zod, signed and attested call
// records, rolling 24 h cost guard. docs/agentic-system.md sections 6.5 and 11; verification: docs/model-choice.md.
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { createAttestor, recoverSigner } from './attest.ts';
import { config } from './config.ts';
import type { LlmCall } from './types.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Verification fields on every call record (part of LlmCall, docs/agentic-system.md 6.5). */
export type LlmVerification = Pick<LlmCall, 'signer_recovered' | 'attested' | 'attestation_checked_at'>;
export type SignedLlmCall = LlmCall;

const DAY_MS = 86_400_000;
let spentUsd = 0, reservedUsd = 0, tripped = false, busy = false;
const spends: { at: number; usd: number }[] = [];
/** USD spent by this process since it started (reporting). */
export const llmSpentUsd = () => spentUsd;
/** USD spent by this process in the last 24 h: what ROOK_LLM_MAX_USD limits. */
export function llmSpent24hUsd(now = Date.now()) {
  while (spends.length && spends[0].at <= now - DAY_MS) spends.shift();
  return spends.reduce((s, e) => s + e.usd, 0);
}

const attestor = createAttestor({ base: () => config.nearAiBase, key: () => config.nearAiKey });

type Price = { prompt: number; completion: number };
// ponytail: when the price list cannot be read, or lacks the model, a call is costed at this high per-token price
// (USD), so the cost guard over-counts (fails closed) instead of counting 0.
const FALLBACK_PRICE: Price = { prompt: 0.00001, completion: 0.00005 };
let prices: Promise<Map<string, Price>> | undefined;
async function priceOf(model: string): Promise<Price> {
  prices ??= fetch(`${config.nearAiBase}/models`, { headers: auth() })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((j: any) => new Map<string, Price>((j.data as any[]).map((m) => [m.id, { prompt: Number(m.pricing?.prompt), completion: Number(m.pricing?.completion) }])));
  // A failed fetch is not cached: the next call tries again.
  const map = await prices.catch(() => { prices = undefined; return new Map<string, Price>(); });
  const p = map.get(model);
  return p && [p.prompt, p.completion].every((x) => Number.isFinite(x) && x >= 0) ? p : FALLBACK_PRICE;
}

const auth = () => ({ authorization: `Bearer ${config.nearAiKey}` });

/** reasoning_effort for reasoning models (NEAR AI honours it for z-ai/glm-5.3: "low" skips thinking). */
export type Effort = 'low' | 'medium' | 'high';

/** A function the model asked to run (OpenAI-style tool_calls), as it sent it. */
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Msg =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: ToolCall[] } // a turn in which the model asks for tools
  | { role: 'tool'; tool_call_id: string; content: string }; // Rook's answer to one of them

/**
 * The output tokens a call is expected to write, for the cost guard's reservation: max_tokens for every call in
 * flight (16000 for a draft, 24000 for self-do) made two or three plans at once look like the day's limit.
 * ponytail: a quarter of max_tokens, at least 1000 (a draft at low effort writes about 2000 of its 16000). A burst of
 * calls that all write far past that passes the limit by the difference, and the calls after it are refused.
 */
export const expectedOutputTokens = (maxTokens: number) => Math.min(maxTokens, Math.max(1000, Math.round(maxTokens / 4)));

/**
 * Refuse a call before it is sent when the 24 h window is spent (the daily limit) or when the calls in flight would
 * spend it (Rook is busy: they finish within a minute, and most cost less than reserved).
 */
function guard() {
  const today = llmSpent24hUsd(), limit = config.llmMaxUsd;
  if (today >= limit) {
    const msg = `LLM cost guard: ${today.toFixed(4)} USD spent in the last 24 h (${reservedUsd.toFixed(4)} in flight), limit ROOK_LLM_MAX_USD=${limit} per day`;
    if (!tripped) console.warn(`[llm] ${msg}; refusing calls${spends.length ? ` until ${new Date(spends[0].at + DAY_MS).toISOString()} at the earliest` : ' until calls in flight finish'}`);
    tripped = true;
    throw new Error(msg);
  }
  tripped = false;
  // Never "cost guard" here: the web app reads that as the daily limit, which this is not.
  if (today + reservedUsd >= limit) {
    const msg = `Rook is busy, try again in a minute: the LLM calls in flight hold ${reservedUsd.toFixed(4)} USD, and ${today.toFixed(4)} USD is spent in the last 24 h of the ${limit} USD a day ROOK_LLM_MAX_USD allows`;
    if (!busy) console.warn(`[llm] ${msg}`);
    busy = true;
    throw new Error(msg);
  }
  busy = false;
}

// Request fields a model may refuse with a 400 that names them: the call is sent again without that field. NEAR AI
// passes reasoning_effort on, which Anthropic models reject (and DeepSeek V4.1 rejects "medium"); a model without
// web search or function calling refuses those.
const OPTIONAL: [string, RegExp][] = [['reasoning_effort', /reasoning_effort/], ['web_search_options', /web_search/], ['tool_choice', /tool_choice/], ['tools', /\btools?\b|function[ _]?call/i]];

type Completion = { text: string; message: any; call: SignedLlmCall };

/** One completion: guarded, sent (the optional fields a model refuses dropped), costed, recorded and signed. */
async function complete(purpose: string, model: string, messages: Msg[], maxTokens: number, opts: { sign?: boolean; effort?: Effort; extra?: Record<string, unknown> }): Promise<Completion> {
  if (config.llm !== 'near') throw new Error(`LLM call "${purpose}" attempted in canned mode`);
  if (!config.nearAiKey) throw new Error('NEARAI_API_KEY is not set');
  // Attestation evidence is requested before the completion, so it predates the response it vouches for.
  if (opts.sign !== false) attestor.prefetch(model);

  // The exact bytes sent and received are hashed: the gateway signs sha256(request):sha256(response). The hashes below
  // cover whichever body was actually sent.
  const req: Record<string, unknown> = { model, max_tokens: maxTokens, messages, ...(opts.effort ? { reasoning_effort: opts.effort } : {}), ...opts.extra };
  let body = JSON.stringify(req);
  const price = await priceOf(model);
  // ROOK_LLM_MAX_USD is a rolling 24 h budget. Calls in flight count at what they are expected to cost, so concurrent
  // calls cannot all slip under the limit together.
  // ponytail: the window lives in this process (each service has its own, and a restart clears it). Upgrade: keep the
  // spend rows in the orchestrator's SQLite (ROOK_DB) and sum them across services.
  guard();
  const expected = (body.length / 3) * price.prompt + expectedOutputTokens(maxTokens) * price.completion;
  reservedUsd += expected;
  let raw = '', status = 0;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${config.nearAiBase}/chat/completions`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body });
      raw = await r.text(); status = r.status;
      const refused = status === 400 ? OPTIONAL.find(([k, re]) => k in req && re.test(raw)) : undefined;
      if (refused) {
        delete req[refused[0]];
        if (refused[0] === 'tools') delete req.tool_choice;
        body = JSON.stringify(req);
        attempt--; continue;
      }
      if (status !== 429 && status < 500) break;
      await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
    }
  } finally { reservedUsd -= expected; }
  if (status !== 200) throw new Error(`NEAR AI ${status} for ${purpose}: ${raw.slice(0, 300)}`);
  const j = JSON.parse(raw);
  const message = j.choices?.[0]?.message;
  // Some open models put their reasoning in <think> tags ahead of the answer.
  const text: string = String(message?.content ?? '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
  // Reasoning models spend hidden tokens; a cut-off reply is otherwise silent (truncated deliverables, invalid JSON).
  if (j.choices?.[0]?.finish_reason === 'length') console.warn(`[llm] ${purpose}: reply cut off at max_tokens=${maxTokens} (${model})`);
  const inTok = j.usage?.prompt_tokens ?? 0, outTok = j.usage?.completion_tokens ?? 0;
  const cost = inTok * price.prompt + outTok * price.completion;
  spentUsd += cost;
  spends.push({ at: Date.now(), usd: cost });

  const call: SignedLlmCall = {
    purpose, model, chat_id: j.id, request_sha256: sha256(body), response_sha256: sha256(raw),
    input_tokens: inTok, output_tokens: outTok, cost_usd: Number(cost.toFixed(6)),
    signature: null, signing_address: null, signing_algo: null, signature_kind: null, signature_verified: false,
    signer_recovered: false, attested: null, attestation_checked_at: null,
  };
  if (opts.sign !== false) await attachSignature(call);
  return { text, message, call };
}

/**
 * One chat completion. `sign: false` skips the signature fetch (simulated agents: not Rook's evidence, and the
 * fetch retries for about 3 s when a model is not verifiable).
 */
export async function chat(purpose: string, model: string, messages: Msg[], maxTokens = 4000, opts: { sign?: boolean; effort?: Effort } = {}): Promise<{ text: string; call: SignedLlmCall }> {
  const { text, call } = await complete(purpose, model, messages, maxTokens, opts);
  return { text, call };
}

/** Whether Rook's own writer may search the web and open pages: ROOK_LLM_TOOLS (on unless "0"), never in canned mode. */
export const llmTools = () => config.llm === 'near' && (process.env.ROOK_LLM_TOOLS ?? '1') !== '0';

/** A page the model read or cited. */
export type Source = { url: string; title: string };
/** A function the model may call: `run` gets its parsed arguments and answers with text, and the page it read if any. */
export type ToolFn = { description: string; parameters: object; run: (args: any) => Promise<string | { content: string; source?: Source }> };
export const MAX_TOOL_ROUNDS = 6;
const MAX_CALLS_PER_ROUND = 4;
const TOOL_ANSWER_CHARS = 12_000;

/**
 * A chat in which the model may look things up: NEAR AI's built-in web search (`search`; its citations come back as
 * message.annotations url_citation) and Rook's own `functions` (OpenAI-style tool_calls). At most MAX_TOOL_ROUNDS
 * rounds of tool calls, then one completion that must answer (tool_choice "none"). Every completion is guarded,
 * costed, recorded and signed like a plain chat. On failure the error carries the calls already paid for.
 * ponytail: the guard counts tokens only; a fee NEAR AI may bill for a web search on top is not counted.
 */
export async function chatTools(purpose: string, model: string, messages: Msg[], maxTokens: number, opts: { effort?: Effort; search?: boolean; functions?: Record<string, ToolFn> }): Promise<{ text: string; calls: LlmCall[]; sources: Source[] }> {
  const calls: LlmCall[] = [], sources = new Map<string, string>();
  const source = (url: unknown, title: unknown) => { if (typeof url === 'string' && /^https?:\/\//i.test(url) && !sources.has(url)) sources.set(url, String(title ?? '').slice(0, 200)); };
  const fns = opts.functions ?? {};
  const tools = Object.entries(fns).map(([name, f]) => ({ type: 'function', function: { name, description: f.description, parameters: f.parameters } }));
  const msgs = [...messages];
  try {
    for (let round = 0; ; round++) {
      const last = round === MAX_TOOL_ROUNDS;
      const extra = { ...(opts.search && !last ? { web_search_options: {} } : {}), ...(tools.length ? { tools, ...(last ? { tool_choice: 'none' } : {}) } : {}) };
      const r = await complete(round ? `${purpose}:round${round + 1}` : purpose, model, msgs, maxTokens, { effort: opts.effort, extra });
      calls.push(r.call);
      for (const a of Array.isArray(r.message?.annotations) ? r.message.annotations : []) if (a?.type === 'url_citation') source(a.url_citation?.url, a.url_citation?.title);
      const asked: ToolCall[] = Array.isArray(r.message?.tool_calls) ? r.message.tool_calls : [];
      if (!asked.length || last) return { text: r.text, calls, sources: [...sources].map(([url, title]) => ({ url, title })) };
      msgs.push({ role: 'assistant', content: r.message.content ?? null, tool_calls: asked });
      // Every call the model made gets an answer, or the next completion is refused.
      const answers = await Promise.all(asked.map(async (tc, i): Promise<string> => {
        if (i >= MAX_CALLS_PER_ROUND) return `Not run: at most ${MAX_CALLS_PER_ROUND} tool calls are answered per turn.`;
        const f = Object.hasOwn(fns, tc.function?.name) ? fns[tc.function.name] : undefined;
        if (!f) return `There is no tool named ${String(tc.function?.name).slice(0, 60)}.`;
        let args: unknown;
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { return 'The arguments were not valid JSON.'; }
        try {
          const out = await f.run(args);
          if (typeof out === 'string') return out;
          if (out.source) source(out.source.url, out.source.title);
          return out.content;
        } catch (e: any) { return `The tool failed: ${String(e?.message ?? e).slice(0, 300)}`; }
      }));
      asked.forEach((tc, i) => msgs.push({ role: 'tool', tool_call_id: tc.id, content: answers[i].slice(0, TOOL_ANSWER_CHARS) }));
    }
  } catch (e: any) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { calls });
  }
}

async function attachSignature(call: SignedLlmCall) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${config.nearAiBase}/signature/${encodeURIComponent(call.chat_id)}?model=${encodeURIComponent(call.model)}&signing_algo=ecdsa`, { headers: auth() });
      if (r.ok) return await verifySignature(call, await r.json());
    } catch { /* retry */ }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  // ponytail: signature is best-effort; signature_verified stays false and is visible in the evaluation.
}

/**
 * Fill a call's signature fields from NEAR AI's /signature reply. signature_verified needs all three: the signed text
 * is built from the hashes of the exact bytes Rook sent and received; the EIP-191 signature recovers to the stated
 * signing_address; and that address is not contradicted by an attestation report (attested true, or null when the
 * report could not be fetched).
 */
export async function verifySignature(call: SignedLlmCall, s: any, att: Pick<ReturnType<typeof createAttestor>, 'attest'> = attestor): Promise<void> {
  call.signature = s?.signature ?? null;
  call.signing_address = s?.signing_address ?? null;
  call.signing_algo = s?.signing_algo ?? null;
  call.signature_kind = s?.signature_kind ?? null;
  // Gateway signatures cover "req:res"; provider_tee (model runs in a TEE) prefixes the model id: "model:req:res".
  const hashes = `${call.request_sha256}:${call.response_sha256}`;
  const textOk = s?.text === hashes || s?.text === `${call.model}:${hashes}`;
  call.signer_recovered = call.signing_algo === 'ecdsa' && !!call.signature && !!call.signing_address
    && recoverSigner(String(s.text), call.signature) === call.signing_address.toLowerCase();
  if (call.signer_recovered) Object.assign(call, await att.attest(call.signature_kind, call.model, call.signing_address!));
  call.signature_verified = textOk && call.signer_recovered && call.attested !== false;
}

/** Extract one JSON object from model text: strip code fences, take first "{" to last "}". */
export function parseJsonObject(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in model output');
  return JSON.parse(t.slice(a, b + 1));
}

/** Ask for one JSON object, validate with zod, retry once with the error. */
export async function json<T>(purpose: string, model: string, schema: z.ZodType<T>, system: string, user: string, maxTokens = 4000, effort?: Effort): Promise<{ data: T; calls: LlmCall[] }> {
  const sys = `${system}\n\nReply with one JSON object only: no prose, no code fences.`;
  const messages: Msg[] = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  const calls: LlmCall[] = [];
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      const r = await chat(attempt ? `${purpose}:repair` : purpose, model, messages, maxTokens, { effort });
      text = r.text; calls.push(r.call);
    } catch (e: any) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { calls }); // keep the calls already paid for
    }
    try {
      return { data: schema.parse(parseJsonObject(text)), calls };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That reply was invalid: ${lastErr.slice(0, 1500)}\nReply again with one corrected JSON object only.` });
    }
  }
  throw Object.assign(new Error(`LLM ${purpose} returned invalid JSON twice: ${lastErr.slice(0, 500)}`), { calls });
}

/**
 * Neutralise any <deliverable ...> or </deliverable> tag (any case or spacing) in untrusted text quoted inside one.
 * `tag`: another delimiter of that shape (letters, digits and _ only), such as the planner's reference_page.
 */
export const escapeDelimiters = (text: string, tag = 'deliverable') =>
  text.replace(new RegExp(`<(?=\\s*\\/?\\s*${tag}\\b)`, 'gi'), '&lt;');
