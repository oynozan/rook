// NEAR AI Cloud client: chat, JSON-with-zod, signed-call records, per-process cost guard.
// docs/agentic-system.md sections 6.5 and 11.
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { config } from './config.ts';
import type { LlmCall } from './types.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let spentUsd = 0;
export const llmSpentUsd = () => spentUsd;

let prices: Promise<Map<string, { prompt: number; completion: number }>> | undefined;
function priceList() {
  prices ??= fetch(`${config.nearAiBase}/models`, { headers: auth() })
    .then((r) => r.json())
    .then((j: any) => new Map(j.data.map((m: any) => [m.id, { prompt: Number(m.pricing?.prompt ?? 0), completion: Number(m.pricing?.completion ?? 0) }])))
    .catch(() => new Map()) as any;
  return prices!;
}

const auth = () => ({ authorization: `Bearer ${config.nearAiKey}` });

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export async function chat(purpose: string, model: string, messages: Msg[], maxTokens = 4000): Promise<{ text: string; call: LlmCall }> {
  if (config.llm !== 'near') throw new Error(`LLM call "${purpose}" attempted in canned mode`);
  if (!config.nearAiKey) throw new Error('NEARAI_API_KEY is not set');
  if (spentUsd >= config.llmMaxUsd) throw new Error(`LLM cost guard: ${spentUsd.toFixed(4)} USD spent, limit ROOK_LLM_MAX_USD=${config.llmMaxUsd}`);

  // The exact bytes sent and received are hashed: the gateway signs sha256(request):sha256(response).
  const body = JSON.stringify({ model, max_tokens: maxTokens, messages });
  let raw = '', status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${config.nearAiBase}/chat/completions`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body });
    raw = await r.text(); status = r.status;
    if (status !== 429 && status < 500) break;
    await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
  }
  if (status !== 200) throw new Error(`NEAR AI ${status} for ${purpose}: ${raw.slice(0, 300)}`);
  const j = JSON.parse(raw);
  const text: string = j.choices?.[0]?.message?.content ?? '';
  const p = (await priceList()).get(model) ?? { prompt: 0, completion: 0 };
  const inTok = j.usage?.prompt_tokens ?? 0, outTok = j.usage?.completion_tokens ?? 0;
  const cost = inTok * p.prompt + outTok * p.completion;
  spentUsd += cost;

  const call: LlmCall = {
    purpose, model, chat_id: j.id, request_sha256: sha256(body), response_sha256: sha256(raw),
    input_tokens: inTok, output_tokens: outTok, cost_usd: Number(cost.toFixed(6)),
    signature: null, signing_address: null, signing_algo: null, signature_verified: false,
  };
  await attachSignature(call);
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
    const { text, call } = await chat(attempt ? `${purpose}:repair` : purpose, model, messages, maxTokens);
    calls.push(call);
    try {
      return { data: schema.parse(parseJsonObject(text)), calls };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That reply was invalid: ${lastErr.slice(0, 1500)}\nReply again with one corrected JSON object only.` });
    }
  }
  throw Object.assign(new Error(`LLM ${purpose} returned invalid JSON twice: ${lastErr.slice(0, 500)}`), { calls });
}
