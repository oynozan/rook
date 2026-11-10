// NEAR AI Cloud client: chat, JSON-with-zod, signed and attested call records, rolling 24 h cost guard.
// docs/agentic-system.md sections 6.5 and 11; verification: docs/model-choice.md.
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
let spentUsd = 0, reservedUsd = 0, tripped = false;
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

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * One chat completion. `sign: false` skips the signature fetch (simulated agents: not Rook's evidence, and the
 * fetch retries for about 3 s when a model is not verifiable).
 */
export async function chat(purpose: string, model: string, messages: Msg[], maxTokens = 4000, opts: { sign?: boolean; effort?: Effort } = {}): Promise<{ text: string; call: SignedLlmCall }> {
  if (config.llm !== 'near') throw new Error(`LLM call "${purpose}" attempted in canned mode`);
  if (!config.nearAiKey) throw new Error('NEARAI_API_KEY is not set');
  // Attestation evidence is requested before the completion, so it predates the response it vouches for.
  if (opts.sign !== false) attestor.prefetch(model);

  // The exact bytes sent and received are hashed: the gateway signs sha256(request):sha256(response).
  // reasoning_effort is a hint: Anthropic models reject the field and DeepSeek V4.1 rejects "medium", so a 400 that
  // names it is retried once without it. The hashes below cover whichever body was actually sent.
  let body = JSON.stringify({ model, max_tokens: maxTokens, messages, ...(opts.effort ? { reasoning_effort: opts.effort } : {}) });
  const price = await priceOf(model);
  // ROOK_LLM_MAX_USD is a rolling 24 h budget. Calls in flight count at their worst case, so concurrent calls cannot
  // all slip under the limit together.
  // ponytail: the window lives in this process (each service has its own, and a restart clears it). Upgrade: keep the
  // spend rows in the orchestrator's SQLite (ROOK_DB) and sum them across services.
  const today = llmSpent24hUsd();
  if (today + reservedUsd >= config.llmMaxUsd) {
    const msg = `LLM cost guard: ${today.toFixed(4)} USD spent in the last 24 h (${reservedUsd.toFixed(4)} in flight), limit ROOK_LLM_MAX_USD=${config.llmMaxUsd} per day`;
    if (!tripped) console.warn(`[llm] ${msg}; refusing calls${spends.length ? ` until ${new Date(spends[0].at + DAY_MS).toISOString()} at the earliest` : ' until calls in flight finish'}`);
    tripped = true;
    throw new Error(msg);
  }
  tripped = false;
  const worst = (body.length / 3) * price.prompt + maxTokens * price.completion;
  reservedUsd += worst;
  let raw = '', status = 0;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${config.nearAiBase}/chat/completions`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body });
      raw = await r.text(); status = r.status;
      if (status === 400 && opts.effort && /reasoning_effort/.test(raw) && body.includes('"reasoning_effort"')) {
        body = JSON.stringify({ model, max_tokens: maxTokens, messages });
        attempt--; continue;
      }
      if (status !== 429 && status < 500) break;
      await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
    }
  } finally { reservedUsd -= worst; }
  if (status !== 200) throw new Error(`NEAR AI ${status} for ${purpose}: ${raw.slice(0, 300)}`);
  const j = JSON.parse(raw);
  // Some open models put their reasoning in <think> tags ahead of the answer.
  const text: string = String(j.choices?.[0]?.message?.content ?? '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
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
  return { text, call };
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
