// NEAR AI Cloud client: chat, JSON-with-zod, signed-call records, per-process cost guard.
// docs/agentic-system.md sections 6.5 and 11.
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { config } from './config.ts';
import type { LlmCall } from './types.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let spentUsd = 0, reservedUsd = 0;
export const llmSpentUsd = () => spentUsd;

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

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * One chat completion. `sign: false` skips the signature fetch (simulated agents: not Rook's evidence, and the
 * fetch retries for about 3 s when a model is not verifiable).
 */
export async function chat(purpose: string, model: string, messages: Msg[], maxTokens = 4000, opts: { sign?: boolean } = {}): Promise<{ text: string; call: LlmCall }> {
  if (config.llm !== 'near') throw new Error(`LLM call "${purpose}" attempted in canned mode`);
  if (!config.nearAiKey) throw new Error('NEARAI_API_KEY is not set');

  // The exact bytes sent and received are hashed: the gateway signs sha256(request):sha256(response).
  const body = JSON.stringify({ model, max_tokens: maxTokens, messages });
  const price = await priceOf(model);
  // Calls in flight count at their worst case, so concurrent calls cannot all slip under the limit together.
  if (spentUsd + reservedUsd >= config.llmMaxUsd) {
    throw new Error(`LLM cost guard: ${spentUsd.toFixed(4)} USD spent (${reservedUsd.toFixed(4)} in flight), limit ROOK_LLM_MAX_USD=${config.llmMaxUsd}`);
  }
  const worst = (body.length / 3) * price.prompt + maxTokens * price.completion;
  reservedUsd += worst;
  let raw = '', status = 0;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${config.nearAiBase}/chat/completions`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body });
      raw = await r.text(); status = r.status;
      if (status !== 429 && status < 500) break;
      await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
    }
  } finally { reservedUsd -= worst; }
  if (status !== 200) throw new Error(`NEAR AI ${status} for ${purpose}: ${raw.slice(0, 300)}`);
  const j = JSON.parse(raw);
  // Some open models put their reasoning in <think> tags ahead of the answer.
  const text: string = String(j.choices?.[0]?.message?.content ?? '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
  const inTok = j.usage?.prompt_tokens ?? 0, outTok = j.usage?.completion_tokens ?? 0;
  const cost = inTok * price.prompt + outTok * price.completion;
  spentUsd += cost;

  const call: LlmCall = {
    purpose, model, chat_id: j.id, request_sha256: sha256(body), response_sha256: sha256(raw),
    input_tokens: inTok, output_tokens: outTok, cost_usd: Number(cost.toFixed(6)),
    signature: null, signing_address: null, signing_algo: null, signature_verified: false,
  };
  if (opts.sign !== false) await attachSignature(call);
  return { text, call };
}

async function attachSignature(call: LlmCall) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${config.nearAiBase}/signature/${encodeURIComponent(call.chat_id)}?model=${encodeURIComponent(call.model)}&signing_algo=ecdsa`, { headers: auth() });
      if (r.ok) {
        const s: any = await r.json();
        call.signature = s.signature ?? null;
        call.signing_address = s.signing_address ?? null;
        call.signing_algo = s.signing_algo ?? null;
        call.signature_verified = s.text === `${call.request_sha256}:${call.response_sha256}`;
        return;
      }
    } catch { /* retry */ }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  // ponytail: signature is best-effort; signature_verified stays false and is visible in the evaluation.
}

/** Extract one JSON object from model text: strip code fences, take first "{" to last "}". */
export function parseJsonObject(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in model output');
  return JSON.parse(t.slice(a, b + 1));
}

/** Ask for one JSON object, validate with zod, retry once with the error. */
export async function json<T>(purpose: string, model: string, schema: z.ZodType<T>, system: string, user: string, maxTokens = 4000): Promise<{ data: T; calls: LlmCall[] }> {
  const sys = `${system}\n\nReply with one JSON object only: no prose, no code fences.`;
  const messages: Msg[] = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  const calls: LlmCall[] = [];
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      const r = await chat(attempt ? `${purpose}:repair` : purpose, model, messages, maxTokens);
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

/** Neutralise any <deliverable ...> or </deliverable> tag (any case or spacing) in untrusted text quoted inside one. */
export const escapeDelimiters = (text: string) => text.replace(/<(?=\s*\/?\s*deliverable\b)/gi, '&lt;');
