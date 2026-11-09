// Offline: chain-gateway's payment lookup against a mock NearBlocks API v3, and the market-gateway's paid SendMessage
// (returnImmediately for long windows, a Message answer, 502 retried with the same header) against a fake A2A agent.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { KeyPair } from 'near-api-js';

Object.assign(process.env, {
  ROOK_LLM: 'canned', ROOK_MARKET: 'sim', NEAR_NETWORK: 'testnet', ROOK_CONTRACT_ID: 'rook.test',
  ROOK_ORCHESTRATOR_ACCOUNT: 'orch.test', ROOK_ORCHESTRATOR_KEY: KeyPair.fromRandom('ed25519').toString(), // generated per run
  ROOK_PAYMENT_LOOKUP_TRIES: '3', ROOK_PAYMENT_LOOKUP_MS: '10', ROOK_INDEXER_GAP_MS: '0', ROOK_RATE_PER_MIN: '6000',
});
const { serve, call } = await import('../src/shared/http.ts');
type Running = Awaited<ReturnType<typeof serve>>;

const SUB = 't0-1.rook.test', PAY_TO = 'treasury.test', USDC = 'usdc.test';
const T0 = Date.parse('2026-11-09T10:00:00Z');
const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const ftRow = (o: object) => ({ affected_account_id: SUB, involved_account_id: PAY_TO, contract_account_id: USDC, delta_amount: '-300000', cause: 'TRANSFER', event_index: 0, ...o });
let indexed: any[] = [];
const indexerHits: { path: string; auth: string | undefined }[] = [];
const a2aCalls: { handle: string; params: any; payment: string | undefined }[] = [];
let flaky = 0;
const servers: Running[] = [];
let gw: Running, mgw: Running;

before(async () => {
  const rpc = await serve('mock-near-rpc', { // only get_config, for the default token
    'POST /': ({ body: { id } }) => ({ jsonrpc: '2.0', id, result: { result: [...Buffer.from(JSON.stringify({ usdc: USDC }))], logs: [] } }),
  }, 0);
  const nearblocks = await serve('mock-nearblocks', {
    'GET /v3/accounts/:account/ft-txns': ({ params, req, query }) => {
      indexerHits.push({ path: `${params.account}?${query}`, auth: req.headers.authorization });
      return { data: indexed.filter((x) => x.affected_account_id === params.account), meta: {} };
    },
  }, 0);
  const agent = await serve('fake-a2a', {
    'GET /.well-known/x402': () => ({ x402Version: 2, recipients: [{ network: 'near:mainnet', asset: USDC, payTo: PAY_TO }] }),
    'POST /a2a/:handle/v1': ({ params, body, req, res }) => {
      a2aCalls.push({ handle: params.handle, params: body.params, payment: req.headers['x-payment'] as string | undefined });
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: body.id, result });
      if (params.handle === 'flaky' && flaky++ === 0) { res.writeHead(502).end('facilitator down'); return; }
      if (params.handle === 'answers') return ok({ message: { messageId: 'm1', role: 'ROLE_AGENT', parts: [{ text: 'direct answer' }] } });
      if (params.handle === 'answers-v03') return ok({ kind: 'message', messageId: 'm2', taskId: 'tk-2', parts: [{ kind: 'text', text: 'hi' }] });
      return ok({ task: { id: `task-${params.handle}`, contextId: 'ctx', status: { state: 'TASK_STATE_SUBMITTED' } } });
    },
  }, 0);
  Object.assign(process.env, { NEAR_RPC_URL: rpc.url, NEARBLOCKS_API_URL: nearblocks.url, SIMULATOR_URL: agent.url });
  gw = await (await import('../src/chain-gateway/index.ts')).start(0);
  mgw = await (await import('../src/market-gateway/index.ts')).start(0);
  servers.push(mgw, gw, agent, nearblocks, rpc);
});
after(async () => { for (const s of servers) await s.close(); });

test('/payment finds the sub-account\'s transfer to payTo once the lagging indexer shows it, with an explorer link', async () => {
  indexed = [];
  const q = (o: Record<string, string>) => call(`${gw.url}/payment?${new URLSearchParams({ account: SUB, to: PAY_TO, amount: '300000', after: new Date(T0).toISOString(), ...o })}`);
  // Nothing indexed yet: it looks ROOK_PAYMENT_LOOKUP_TRIES times, then says so.
  assert.deepEqual(await q({}), { found: false, tries: 3, error: null });
  assert.equal(indexerHits.length, 3);
  assert.ok(indexerHits.every((h) => h.path.startsWith(`${SUB}?limit=`) && h.auth === undefined)); // keyless by default

  indexed = [
    ftRow({ delta_amount: '-150000', transaction_hash: 'wrong-amount', block_timestamp: ns(T0 + 5000) }),
    ftRow({ involved_account_id: 'evil.test', transaction_hash: 'wrong-payee', block_timestamp: ns(T0 + 5000) }),
    ftRow({ contract_account_id: 'other-token.test', transaction_hash: 'wrong-token', block_timestamp: ns(T0 + 5000) }),
    ftRow({ transaction_hash: 'too-early', block_timestamp: ns(T0 - 10 * 60_000) }),
    ftRow({ delta_amount: '300000', transaction_hash: 'incoming', block_timestamp: ns(T0 + 5000) }),
    ftRow({ transaction_hash: 'PayTx1', receipt_id: 'R1', block_timestamp: ns(T0 + 4000) }),
  ];
  process.env.NEARBLOCKS_API_KEY = 'nb-key';
  try {
    assert.deepEqual(await q({}), {
      found: true, tx_hash: 'PayTx1', receipt_id: 'R1', block_timestamp: ns(T0 + 4000),
      explorer_url: 'https://testnet.nearblocks.io/txns/PayTx1', source: 'nearblocks-v3',
    });
    assert.equal(indexerHits.at(-1)!.auth, 'Bearer nb-key');
  } finally { delete process.env.NEARBLOCKS_API_KEY; }
  await assert.rejects(q({ amount: '1.5' }), /amount must be an integer/);
});

const header = (maxTimeoutSeconds: number) =>
  Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: 'exact', network: 'near:mainnet', asset: USDC, amount: '1', payTo: PAY_TO, maxTimeoutSeconds }, payload: {} })).toString('base64');
const send = (handle: string, maxTimeoutSeconds: number) => call(`${mgw.url}/send`, { handle, text: 'Holders\nReport them.', payment: header(maxTimeoutSeconds) });

test('paid SendMessage: returnImmediately when the window is over 60 s; a Message answer counts as COMPLETED', async () => {
  const long = await send('long', 1200); // window 600 s
  assert.deepEqual([long.ok, long.task.id, long.task.state], [true, 'task-long', 'SUBMITTED']);
  assert.deepEqual(a2aCalls.at(-1)!.params.configuration, { historyLength: 0, returnImmediately: true });

  const quick = await send('answers', 650); // window 50 s: the call's 60 s hold covers it
  assert.deepEqual(a2aCalls.at(-1)!.params.configuration, { historyLength: 0 });
  assert.deepEqual(quick.task, { id: 'm1', context_id: null, state: 'COMPLETED', artifacts: [{ name: 'message', parts: [{ text: 'direct answer' }] }] });
  const v03 = await send('answers-v03', 650);
  assert.deepEqual([v03.task.id, v03.task.state, v03.task.artifacts[0].parts], ['tk-2', 'COMPLETED', [{ text: 'hi' }]]);
});

test('paid SendMessage: a 502 is retried with the same payment header, never a new one', async () => {
  const r = await send('flaky', 1200);
  assert.equal(r.ok, true, JSON.stringify(r));
  const tries = a2aCalls.filter((c) => c.handle === 'flaky');
  assert.equal(tries.length, 2);
  assert.equal(tries[0].payment, tries[1].payment);
});
