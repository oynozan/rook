// NEAR AI response verification (src/shared/attest.ts, llm.ts) and the rolling 24 h cost guard. Offline: the signatures
// were captured live on 2026-11-07, the attestation report and NRAS reply on 2026-11-09 (test/fixtures); fetch is stubbed.
process.env.ROOK_LLM = 'near';
process.env.NEARAI_API_KEY = 'test-key-not-real';
process.env.ROOK_LLM_MAX_USD = '0.01';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { recoverSigner, checkReport, verifyQuote, createAttestor, NRAS_URL } = await import('../src/shared/attest.ts');
const { chat, verifySignature, llmSpent24hUsd } = await import('../src/shared/llm.ts');

const fixture = (f: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', f), 'utf8'));
const REPORT = fixture('nearai-attestation-report.json');
const NRAS_OK = fixture('nras-response.json');
const NONCE = REPORT.gateway_attestation.request_nonce as string;
const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const GW_ADDR = '0xb98a789cdc4817275f5155593ba73ef2a957e779';
const TEE_ADDR = '0xfe0071895500a9755c18044948ab4f4e1a7f337e';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// Captured live 2026-11-07 from GET /v1/signature/<chat_id>?signing_algo=ecdsa.
const VEC = {
  gateway: {
    model: 'anthropic/claude-sonnet-5-5', req: '9381fb879596ccf6aef77fc90fc375f4a4684615fc9abb8a55e267ad7bd289f5', res: 'e632b59a387e6aa5c518465fd5275dc7693a2ef3d9849e8f02b1763d108c2bef',
    signature: '0x4961f720d761c20c8cc5332ad9760b0bf6f8941b74661cbf877e7fdfcb434ae178c8396da2aec0fe3f31dade23e76e4ae40dfd3b5960d0421f1da53ec909cae31c', address: GW_ADDR,
  },
  provider_tee: {
    model: MODEL, req: 'cb23322a4f6343927b832b46dbe23eddd81163426de14e23adff08060ff2e49a', res: '7904d354c249cb323d088e480d7cba25642996cc44120387388b499e9fdf364a',
    signature: '0xf2e178d8ff6a299eba052f6cadfe37f2c9e3fb696c003fd17da774808d28a78e4b8cf121b7e44e34eabbbf057b787473fffccce6bcb9ba7c1af48faec0bc8d931b', address: TEE_ADDR,
  },
};
const textOf = (k: keyof typeof VEC) => (k === 'gateway' ? '' : `${VEC[k].model}:`) + `${VEC[k].req}:${VEC[k].res}`;

test('recoverSigner: both live vectors recover to their signing_address (EIP-191 over the signed text)', () => {
  for (const k of ['gateway', 'provider_tee'] as const) assert.equal(recoverSigner(textOf(k), VEC[k].signature), VEC[k].address);
  // v as 0/1 instead of 27/28 is the same signature.
  const sig = VEC.gateway.signature, v = parseInt(sig.slice(-2), 16) - 27;
  assert.equal(recoverSigner(textOf('gateway'), sig.slice(0, -2) + v.toString(16).padStart(2, '0')), GW_ADDR);
  assert.notEqual(recoverSigner(textOf('gateway') + ' ', sig), GW_ADDR, 'other text, other signer');
  assert.equal(recoverSigner(textOf('gateway'), sig.slice(0, -2)), null, '64 bytes is not a recoverable signature');
  assert.equal(recoverSigner(textOf('gateway'), sig.slice(0, -2) + '1f'), null, 'v must be 27/28 or 0/1');
});

test('checkReport: the recorded gateway and model reports verify and bind their signers to our nonce', () => {
  checkReport(REPORT.gateway_attestation, NONCE);
  checkReport(REPORT.model_attestations[0], NONCE);
  assert.equal(REPORT.gateway_attestation.signing_address, GW_ADDR);
  assert.equal(REPORT.model_attestations[0].signing_address, TEE_ADDR);
});

test('checkReport: a replayed report, a tampered quote, config or event log is rejected', () => {
  const other = 'ab'.repeat(32);
  assert.throws(() => checkReport(REPORT.gateway_attestation, other), /does not bind the signer and our nonce/);

  const q = clone(REPORT.gateway_attestation); // flip one nibble of report_data inside the signed TD report
  const at = (48 + 520) * 2;
  q.intel_quote = q.intel_quote.slice(0, at) + (q.intel_quote[at] === '0' ? '1' : '0') + q.intel_quote.slice(at + 1);
  assert.throws(() => checkReport(q, NONCE), /quote signature invalid/);

  const c = clone(REPORT.gateway_attestation);
  c.info.tcb_info.app_compose += ' ';
  assert.throws(() => checkReport(c, NONCE), /MRCONFIGID/);

  const e = clone(REPORT.gateway_attestation);
  const log = JSON.parse(e.event_log);
  const ev = log.find((x: any) => x.imr === 3 && x.event === 'compose-hash');
  ev.event_payload = ev.event_payload.replace(/^./, (ch: string) => (ch === '0' ? '1' : '0'));
  delete ev.digest;
  e.event_log = JSON.stringify(log);
  assert.throws(() => checkReport(e, NONCE), /does not match RTMR3/);

  const s = clone(REPORT.gateway_attestation);
  s.signing_address = TEE_ADDR; // the other enclave's key is not what this quote binds
  assert.throws(() => checkReport(s, NONCE), /does not bind the signer/);
});

test('verifyQuote: the PCK chain must be valid now', () => {
  assert.equal(verifyQuote(REPORT.gateway_attestation.intel_quote).length, 584);
  assert.throws(() => verifyQuote(REPORT.gateway_attestation.intel_quote, new Date('2060-01-01')), /validity/);
  assert.throws(() => verifyQuote('0300' + REPORT.gateway_attestation.intel_quote.slice(4)), /not a TDX v4/);
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function stubFetch(over: { report?: Route; nras?: Route } = {}) {
  const seen: string[] = [];
  const f = (async (input: any, init?: RequestInit) => {
    const url = String(input); seen.push(url);
    if (url === NRAS_URL) return over.nras ? over.nras(url, init) : jsonRes(NRAS_OK);
    if (url.startsWith('https://cloud.test/v1/attestation/report?')) {
      if (over.report) return over.report(url, init);
      const qs = new URL(url).searchParams;
      assert.equal(qs.get('nonce'), NONCE); assert.equal(qs.get('signing_algo'), 'ecdsa');
      assert.equal((init?.headers as any)['x-no-aliasing'], 'true');
      return jsonRes(qs.get('model') ? REPORT : { gateway_attestation: REPORT.gateway_attestation });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { f, seen };
}
const attestorWith = (f: typeof fetch, nonce = NONCE) => createAttestor({ base: () => 'https://cloud.test/v1', key: () => '', fetch: f, nonce: () => nonce });

test('attest: signers match the report of their kind, once per process, with GPU evidence checked by NRAS', async () => {
  const { f, seen } = stubFetch();
  const a = attestorWith(f);
  a.prefetch(MODEL);
  const gw = await a.attest('gateway', MODEL, GW_ADDR.toUpperCase().replace('0X', '0x'));
  assert.equal(gw.attested, true);
  assert.match(String(gw.attestation_checked_at), /^\d{4}-\d\d-\d\dT/);
  assert.equal((await a.attest('provider_tee', MODEL, TEE_ADDR)).attested, true);
  assert.equal((await a.attest('provider_tee', MODEL, GW_ADDR)).attested, false, 'the gateway key is not the model enclave');
  assert.equal((await a.attest('gateway', MODEL, TEE_ADDR)).attested, false, 'the model key is not the gateway');
  assert.equal((await a.attest('something_else', MODEL, GW_ADDR)).attested, false);
  assert.equal(seen.filter((u) => u.includes('/attestation/report')).length, 2, 'gateway and model reports fetched once each');
  assert.equal(seen.filter((u) => u === NRAS_URL).length, 1);
  assert.match(seen.find((u) => u.includes('model='))!, /provider=near/);
});

test('attest: GPU evidence NRAS rejects means not attested; an unreachable check means unknown (null)', async () => {
  const [h, , s] = (NRAS_OK[0][1] as string).split('.');
  const claims = JSON.parse(Buffer.from((NRAS_OK[0][1] as string).split('.')[1], 'base64url').toString());
  const bad = [h, Buffer.from(JSON.stringify({ ...claims, 'x-nvidia-overall-att-result': false })).toString('base64url'), s].join('.');
  assert.equal((await attestorWith(stubFetch({ nras: () => jsonRes([['JWT', bad]]) }).f).attest('provider_tee', MODEL, TEE_ADDR)).attested, false);
  assert.equal((await attestorWith(stubFetch({ nras: () => jsonRes({}, 503) }).f).attest('provider_tee', MODEL, TEE_ADDR)).attested, null);
  const down = await attestorWith(stubFetch({ report: () => { throw new Error('ECONNRESET'); } }).f).attest('gateway', MODEL, GW_ADDR);
  assert.deepEqual(down, { attested: null, attestation_checked_at: null });
  assert.equal((await attestorWith(stubFetch({ report: () => jsonRes({ error: 'external provider' }, 503) }).f).attest('gateway', MODEL, GW_ADDR)).attested, null);
  // A report that does not echo and bind our nonce (a replay) is not evidence.
  assert.equal((await attestorWith(stubFetch({ report: () => jsonRes(REPORT) }).f, 'cd'.repeat(32)).attest('gateway', MODEL, GW_ADDR)).attested, false);
  // A provider_tee report with no GPU evidence is not accepted.
  const noGpu = clone(REPORT); delete noGpu.model_attestations[0].nvidia_payload;
  assert.equal((await attestorWith(stubFetch({ report: () => jsonRes(noGpu) }).f).attest('provider_tee', MODEL, TEE_ADDR)).attested, false);
});

test('attest: a failed refresh keeps the evidence held so far, so a signer found unattested never turns unknown', async (t) => {
  let down = false;
  const { f } = stubFetch({ report: () => { if (down) throw new Error('ECONNRESET'); return jsonRes({ gateway_attestation: REPORT.gateway_attestation }); } });
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const a = attestorWith(f);
  assert.equal((await a.attest('gateway', MODEL, GW_ADDR)).attested, true);
  t.mock.timers.setTime(start + 61_000); // the evidence is over a minute old: a signer missing from it triggers a refresh
  down = true;
  assert.equal((await a.attest('gateway', MODEL, TEE_ADDR)).attested, false); // that refresh fails
  assert.equal((await a.attest('gateway', MODEL, TEE_ADDR)).attested, false, 'still not attested, not null');
  const gw = await a.attest('gateway', MODEL, GW_ADDR);
  assert.equal(gw.attested, true, 'the gateway key keeps its evidence');
  assert.equal(gw.attestation_checked_at, new Date(start).toISOString());
});

test('attest: several verified reports naming one key (instances of a model share it) are one attested signer', async () => {
  const two = clone(REPORT);
  two.model_attestations.push(clone(REPORT.model_attestations[0]));
  assert.equal((await attestorWith(stubFetch({ report: () => jsonRes(two) }).f).attest('provider_tee', MODEL, TEE_ADDR)).attested, true);
});

const callFor = (k: keyof typeof VEC): any => ({
  purpose: 't', model: VEC[k].model, chat_id: 'chat-1', request_sha256: VEC[k].req, response_sha256: VEC[k].res, input_tokens: 0, output_tokens: 0, cost_usd: 0,
  signature: null, signing_address: null, signing_algo: null, signature_kind: null, signature_verified: false, signer_recovered: false, attested: null, attestation_checked_at: null,
});
const sigReply = (k: keyof typeof VEC, over: Record<string, unknown> = {}) => ({ text: textOf(k), signature: VEC[k].signature, signing_address: VEC[k].address, signing_algo: 'ecdsa', signature_kind: k, ...over });

test('verifySignature: verified only when the hashes match, the signer recovers and the signer is attested', async () => {
  const a = attestorWith(stubFetch().f);
  for (const k of ['gateway', 'provider_tee'] as const) {
    const call = callFor(k);
    await verifySignature(call, sigReply(k), a);
    assert.equal(call.signer_recovered, true); assert.equal(call.attested, true); assert.equal(call.signature_verified, true, k);
  }
  // Signed text built from other bytes than Rook sent and received.
  const other = callFor('gateway'); other.response_sha256 = '00'.repeat(32);
  await verifySignature(other, sigReply('gateway'), a);
  assert.equal(other.signer_recovered, true); assert.equal(other.signature_verified, false);
  // A signing_address the signature does not recover to: not recovered, attestation not consulted.
  const forged = callFor('gateway');
  await verifySignature(forged, sigReply('gateway', { signing_address: TEE_ADDR }), a);
  assert.equal(forged.signer_recovered, false); assert.equal(forged.attested, null); assert.equal(forged.signature_verified, false);
  // A valid signature from a key no attestation report binds.
  const unbound = callFor('gateway');
  await verifySignature(unbound, sigReply('gateway'), { attest: async () => ({ attested: false, attestation_checked_at: '2026-11-09T00:00:00.000Z' }) });
  assert.equal(unbound.signature_verified, false);
  // Evidence that could not be fetched does not contradict the signature.
  const unknown = callFor('gateway');
  await verifySignature(unknown, sigReply('gateway'), { attest: async () => ({ attested: null, attestation_checked_at: null }) });
  assert.equal(unknown.signature_verified, true);
});

test('cost guard: ROOK_LLM_MAX_USD is a rolling 24 h budget, and tripping it logs once', async (t) => {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input); urls.push(url);
    if (url.endsWith('/models')) return jsonRes({ data: [{ id: 'test/model', pricing: { prompt: 0.000001, completion: 0.000001 } }] });
    if (url.endsWith('/chat/completions')) return jsonRes({ id: 'c', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 6000, completion_tokens: 4000 } });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; });
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T00:00:00Z') });

  await chat('a', 'test/model', [{ role: 'user', content: 'hi' }], 10, { sign: false }); // costs 0.01
  assert.equal(Number(llmSpent24hUsd().toFixed(6)), 0.01);
  await assert.rejects(chat('b', 'test/model', [{ role: 'user', content: 'hi' }], 10, { sign: false }), /0\.0100 USD spent in the last 24 h.*per day/);
  await assert.rejects(chat('c', 'test/model', [{ role: 'user', content: 'hi' }], 10, { sign: false }), /cost guard/);
  const logs = warn.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.includes('cost guard'));
  assert.equal(logs.length, 1, 'one log line per trip');
  assert.match(logs[0], /until 2026-11-10T00:00:00\.000Z/);

  t.mock.timers.setTime(Date.parse('2026-11-10T00:00:00.001Z')); // the spend leaves the window
  assert.equal(llmSpent24hUsd(), 0);
  await chat('d', 'test/model', [{ role: 'user', content: 'hi' }], 10, { sign: false });
  assert.equal(urls.filter((u) => u.endsWith('/chat/completions')).length, 2);
  assert.ok(urls.every((u) => !u.includes('/signature/') && !u.includes('/attestation/')), 'sign: false fetches no evidence');
});
