// ROOK_LEDGER=chain pieces, all offline: a mock NEAR RPC (no real network), the real signer, chain-gateway and
// simulator (verifying real NEP-366 delegates), then the orchestrator in chain mode against mock signer/chain-gateway.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { KeyPair, PublicKey, baseEncode, decodeSignedTransaction, encodeTransaction, type KeyPairString } from 'near-api-js';

const CONTRACT = 'rook.test', USDC = 'usdc.test', PAY_TO = 'treasury.test', TGAS = 10n ** 12n;
const signerKp = KeyPair.fromRandom('ed25519'), orchKp = KeyPair.fromRandom('ed25519'); // generated per run, never stored
const keyDir = mkdtempSync(join(tmpdir(), 'rook-keys-'));
Object.assign(process.env, {
  ROOK_LLM: 'canned', ROOK_MARKET: 'sim', NEAR_NETWORK: 'testnet', ROOK_CONTRACT_ID: CONTRACT,
  ROOK_SIGNER_ACCOUNT: 'signer.test', ROOK_SIGNER_KEY: signerKp.toString(), ROOK_SIGNER_KEY_DIR: keyDir,
  ROOK_ORCHESTRATOR_ACCOUNT: 'orch.test', ROOK_ORCHESTRATOR_KEY: orchKp.toString(),
  SIM_PAYMENT_NETWORK: 'near:testnet', SIM_USDC_ID: USDC, SIM_PAY_TO: PAY_TO,
  SIM_SLA_S: '2', SIM_DELIVERY_MS: '100', SIM_HOLD_MS: '50', ROOK_PAYMENT_GRACE_S: '1', ROOK_POLL_MS: '20', ROOK_RATE_PER_MIN: '6000',
});

const { serve, call, HttpError } = await import('../src/shared/http.ts');
const { functionCall, signDelegate, verifySignedDelegate } = await import('../src/shared/near.ts');
type Running = Awaited<ReturnType<typeof serve>>;

// ---- mock NEAR RPC: views, access keys, blocks, and send_tx that verifies the signature and records the call ----
const chain = {
  height: 1000,
  keys: new Map<string, bigint>(), // `${account}/${public key}` -> nonce
  balances: new Map<string, bigint>(),
  pending: new Map<string, string>(), // `${task}/${n}` -> registered public key
  subtasks: [] as any[],
  txs: [] as { signer: string; key: string; receiver: string; method: string; args: any; gas: bigint; deposit: bigint }[],
  outcomes: new Map<string, unknown>(), // tx hash -> final outcome, for the `tx` status query
  timeoutNext: false, // the next send_tx lands but answers TIMEOUT_ERROR, as a slow RPC does
};
chain.keys.set(`signer.test/${signerKp.getPublicKey()}`, 5n);
chain.keys.set(`orch.test/${orchKp.getPublicKey()}`, 7n);
const TASK = { funder: 'owner.test', budget: '1000000', reserve: '200000', caps: ['300000', '200000'], status: 'Open', killed: false };
const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(7));
const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
const rpcErr = (id: unknown, name: string) => ({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name }, code: -32000, message: name } });

function view(method: string, a: any): unknown {
  switch (method) {
    case 'get_config': return { owner: 'owner.test', orchestrator: 'orch.test', signer: 'signer.test', usdc: USDC, killed: false, tasks: 1 };
    case 'get_task': return a.task_id === '0' ? TASK : null;
    case 'get_subtasks': return a.task_id === '0' ? chain.subtasks : [];
    case 'ft_balance_of': return String(chain.balances.get(a.account_id) ?? 0n);
    case 'storage_balance_of': return { total: '1250000000000000000000', available: '0' };
    default: throw new Error(`no view ${method}`);
  }
}

function sendTx(id: unknown, b64: string) {
  const signed: any = decodeSignedTransaction(Buffer.from(b64, 'base64'));
  const tx = signed.transaction;
  const pk = new PublicKey({ keyType: 0, data: Uint8Array.from(tx.publicKey.ed25519Key.data) });
  const hash = createHash('sha256').update(encodeTransaction(tx)).digest();
  if (!pk.verify(hash, Uint8Array.from(signed.signature.ed25519Signature.data))) return rpcErr(id, 'INVALID_SIGNATURE');
  const ak = `${tx.signerId}/${pk}`;
  if (!chain.keys.has(ak)) return rpcErr(id, 'INVALID_ACCESS_KEY');
  if (BigInt(tx.nonce) <= chain.keys.get(ak)!) return rpcErr(id, 'INVALID_NONCE');
  chain.keys.set(ak, BigInt(tx.nonce));
  let value: unknown = null, failure: unknown;
  for (const a of tx.actions) {
    const fc = a.functionCall;
    const args = JSON.parse(Buffer.from(fc.args).toString('utf8'));
    chain.txs.push({ signer: tx.signerId, key: pk.toString(), receiver: tx.receiverId, method: fc.methodName, args, gas: BigInt(fc.gas), deposit: BigInt(fc.deposit) });
    if (fc.methodName === 'register_subtask_key') { // like the contract: one key per (task, n) until fund_subtask takes it
      if (chain.pending.has(`${args.task_id}/${args.n}`)) failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: key already registered' } } } };
      else chain.pending.set(`${args.task_id}/${args.n}`, args.public_key);
    }
    if (fc.methodName === 'top_up') chain.balances.set(`t${args.task_id}-${args.n}.${CONTRACT}`, (chain.balances.get(`t${args.task_id}-${args.n}.${CONTRACT}`) ?? 0n) + BigInt(args.amount));
    if (fc.methodName === 'fund_subtask') {
      const account_id = `t${args.task_id}-${args.n}.${CONTRACT}`, public_key = chain.pending.get(`${args.task_id}/${args.n}`)!;
      chain.pending.delete(`${args.task_id}/${args.n}`);
      chain.subtasks.push({ n: args.n, account_id, public_key, cap: TASK.caps[args.n - 1], status: 'Funded', attempt: 0 });
      chain.keys.set(`${account_id}/${public_key}`, BigInt(chain.height) * 1_000_000n);
      chain.balances.set(account_id, BigInt(TASK.caps[args.n - 1]));
      value = true;
    }
    if (fc.methodName === 'ft_transfer_call') { chain.balances.set(tx.signerId, 0n); value = args.amount; }
    if (fc.methodName === 'mark_empty') { // like the contract's callback: Returned only when the sub-account holds exactly 0
      const s = chain.subtasks.find((x) => x.n === args.n);
      value = s?.status === 'Funded' && (chain.balances.get(s.account_id) ?? 0n) === 0n;
      if (value) s.status = 'Returned';
    }
  }
  const result = {
    final_execution_status: 'FINAL', status: failure ? { Failure: failure } : { SuccessValue: Buffer.from(JSON.stringify(value)).toString('base64') },
    transaction: { hash: baseEncode(hash) }, transaction_outcome: {}, receipts_outcome: [],
  };
  chain.outcomes.set(baseEncode(hash), result);
  if (chain.timeoutNext) { chain.timeoutNext = false; return rpcErr(id, 'TIMEOUT_ERROR'); }
  return { jsonrpc: '2.0', id, result };
}

const servers: Running[] = [];
let signer: Running, gw: Running, mgw: Running;
const lastTx = () => chain.txs.at(-1)!;
const refused = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: any) => e instanceof HttpError && e.status === 409 && re.test(e.message));

before(async () => {
  const rpc = await serve('mock-near-rpc', {
    'POST /': ({ body: { id, method, params: p } }) => {
      if (method === 'block') return { jsonrpc: '2.0', id, result: { header: { height: chain.height, hash: BLOCK_HASH } } };
      if (method === 'send_tx' || method === 'broadcast_tx_commit') return sendTx(id, p.signed_tx_base64 ?? p[0]);
      if (method === 'tx') return chain.outcomes.has(p.tx_hash) ? { jsonrpc: '2.0', id, result: chain.outcomes.get(p.tx_hash) } : rpcErr(id, 'UNKNOWN_TRANSACTION');
      if (method === 'query' && p.request_type === 'view_access_key') {
        const nonce = chain.keys.get(`${p.account_id}/${p.public_key}`);
        if (nonce === undefined) return rpcErr(id, 'UNKNOWN_ACCESS_KEY');
        return { jsonrpc: '2.0', id, result: { nonce: Number(nonce), permission: 'FullAccess', block_height: chain.height, block_hash: BLOCK_HASH } };
      }
      if (method === 'query' && p.request_type === 'call_function') {
        const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8'));
        return { jsonrpc: '2.0', id, result: { result: bytes(view(p.method_name, args)), logs: [], block_height: chain.height, block_hash: BLOCK_HASH } };
      }
      return rpcErr(id, `unsupported ${method}`);
    },
  }, 0);
  process.env.NEAR_RPC_URL = rpc.url;
  const sim = await (await import('../src/simulator/index.ts')).start(0);
  process.env.SIMULATOR_URL = sim.url;
  mgw = await (await import('../src/market-gateway/index.ts')).start(0);
  process.env.MARKET_GATEWAY_URL = mgw.url;
  signer = await (await import('../src/signer/index.ts')).start(0);
  gw = await (await import('../src/chain-gateway/index.ts')).start(0);
  servers.push(gw, signer, mgw, sim, rpc);
});
after(async () => {
  for (const s of servers) await s.close();
  rmSync(keyDir, { recursive: true, force: true });
});

test('the signer refuses a key directory inside the repo', async () => {
  const { keyDir: dirOf } = await import('../src/signer/index.ts');
  const saved = process.env.ROOK_SIGNER_KEY_DIR;
  process.env.ROOK_SIGNER_KEY_DIR = resolve(import.meta.dirname, '..', 'keys');
  try { assert.throws(() => dirOf(), /inside the repo/); } finally { process.env.ROOK_SIGNER_KEY_DIR = saved; }
});

let subKey = '';
test('/keys writes a 0600 key file outside the repo and registers the key from the signer account', async () => {
  const r = await call(`${signer.url}/keys`, { task_id: '0', n: 1 });
  const file = join(keyDir, CONTRACT, '0-1-0.key');
  assert.ok(existsSync(file));
  const secret = readFileSync(file, 'utf8').trim();
  assert.equal(KeyPair.fromString(secret as KeyPairString).getPublicKey().toString(), r.public_key);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600); // Windows has no POSIX modes
  assert.ok(!JSON.stringify(r).includes(secret.slice(8)));
  assert.deepEqual(lastTx(), {
    signer: 'signer.test', key: signerKp.getPublicKey().toString(), receiver: CONTRACT, method: 'register_subtask_key',
    args: { task_id: '0', n: 1, public_key: r.public_key }, gas: 30n * TGAS, deposit: 0n,
  });
  subKey = r.public_key;
});

test('chain-gateway sends fund_subtask and top_up with deposit 0 and the README gas, signed by the orchestrator key', async () => {
  const r = await call(`${gw.url}/fund`, { task_id: '0', n: 1 });
  assert.equal(r.success, true);
  assert.match(r.explorer_url, /^https:\/\/testnet\.nearblocks\.io\/txns\/\w+$/);
  assert.deepEqual(lastTx(), {
    signer: 'orch.test', key: orchKp.getPublicKey().toString(), receiver: CONTRACT, method: 'fund_subtask',
    args: { task_id: '0', n: 1 }, gas: 100n * TGAS, deposit: 0n,
  });
  await call(`${gw.url}/top-up`, { task_id: '0', n: 1, amount_atomic: '5' });
  assert.deepEqual([lastTx().method, lastTx().gas, lastTx().deposit, lastTx().args.amount], ['top_up', 50n * TGAS, 0n, '5']);
  const t = await call(`${gw.url}/task/0`);
  assert.deepEqual(t.subtasks.map((s: any) => [s.account_id, s.public_key, s.status]), [[`t0-1.${CONTRACT}`, subKey, 'Funded']]);
  assert.equal((await call(`${gw.url}/balance?account=t0-1.${CONTRACT}`)).balance, '300005');
});

test('/keys never overwrites a key file: a retry registers the same key, and an already registered key is ours', async () => {
  const first = await call(`${signer.url}/keys`, { task_id: '0', n: 2 });
  const file = join(keyDir, CONTRACT, '0-2-0.key'), secret = readFileSync(file, 'utf8');
  const again = await call(`${signer.url}/keys`, { task_id: '0', n: 2 }); // e.g. the first reply was lost
  assert.deepEqual([again.public_key, again.already_registered], [first.public_key, true]);
  assert.equal(readFileSync(file, 'utf8'), secret);
  assert.equal(chain.pending.get('0/2'), first.public_key);
});

test('a send_tx that times out but lands is found by its hash, not reported as failed', async () => {
  const before = chain.txs.length, bal = chain.balances.get(`t0-1.${CONTRACT}`)!;
  chain.timeoutNext = true;
  const r = await call(`${gw.url}/top-up`, { task_id: '0', n: 1, amount_atomic: '7' });
  assert.equal(r.success, true);
  assert.equal(chain.txs.length, before + 1); // sent once, not re-sent
  assert.equal(chain.balances.get(`t0-1.${CONTRACT}`), bal + 7n);
  chain.balances.set(`t0-1.${CONTRACT}`, bal);
});

const ACCOUNT = `t0-1.${CONTRACT}`;
let row: any;
test('/sign builds a NEP-366 header the simulator verifies and accepts once', async () => {
  row = (await call(`${mgw.url}/quote`, { handle: 'sim-holders' })).row;
  assert.deepEqual([row.network, row.asset, row.payTo, row.amount], ['near:testnet', USDC, PAY_TO, '300000']);
  const s = await call(`${signer.url}/sign`, { task_id: '0', n: 1, account_id: ACCOUNT, row });
  assert.equal(s.payment_hash, createHash('sha256').update(s.header).digest('hex'));
  assert.equal(s.expires_at_block, chain.height + row.maxTimeoutSeconds);
  const h = JSON.parse(Buffer.from(s.header, 'base64').toString());
  assert.equal(h.x402Version, 2);
  assert.deepEqual(h.accepted, row);
  const d = verifySignedDelegate(h.payload.signedDelegateAction);
  assert.deepEqual([d.senderId, d.receiverId, d.publicKey, d.nonce, d.maxBlockHeight], [ACCOUNT, USDC, subKey, BigInt(chain.height) * 1_000_000n + 1n, BigInt(s.expires_at_block)]);

  const sent = await call(`${mgw.url}/send`, { handle: 'sim-holders', text: 'Holder report please', payment: s.header });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const again = await call(`${mgw.url}/send`, { handle: 'sim-holders', text: 'Holder report please', payment: s.header });
  assert.deepEqual([again.ok, again.error.code], [false, 402]);

  // A tampered signature, and a payment to someone else, fail the simulator's own verification.
  const raw = Buffer.from(h.payload.signedDelegateAction, 'base64');
  raw[raw.length - 1] ^= 1;
  const forged = Buffer.from(JSON.stringify({ ...h, payload: { signedDelegateAction: raw.toString('base64') } })).toString('base64');
  const bad = await call(`${mgw.url}/send`, { handle: 'sim-holders', text: 'x', payment: forged });
  assert.deepEqual([bad.ok, bad.error.code], [false, 402]);
  assert.match(bad.error.message, /signature/);
});

test('/sign refusals, /expire, /kill', async () => {
  const sign = (r: any, url = signer.url) => call(`${url}/sign`, { task_id: '0', n: 1, account_id: ACCOUNT, row: r });
  await refused(sign({ ...row, payTo: 'evil-collector.near' }), /not a marketplace recipient/);
  await refused(sign({ ...row, network: 'near:mainnet' }), /not near:testnet/);
  await refused(sign(row), /outstanding authorization/);
  await refused(call(`${signer.url}/return`, { task_id: '0', n: 1, account_id: ACCOUNT }), /outstanding/);
  await refused(call(`${signer.url}/expire`, { task_id: '0', n: 1, terminal_unpaid: false }), /still valid/);

  // A restarted signer still holds the outstanding authorization (kept on disk with the key files).
  const restarted = await (await import('../src/signer/index.ts')).start(0);
  try {
    await refused(sign(row, restarted.url), /outstanding authorization/);
    await refused(call(`${restarted.url}/expire`, { task_id: '0', n: 1, terminal_unpaid: false }), /still valid/);
  } finally { await restarted.close(); }

  assert.equal((await call(`${signer.url}/expire`, { task_id: '0', n: 1, terminal_unpaid: true })).cleared, true);
  await refused(sign({ ...row, amount: '300006' }), /exceeds the sub-account balance 300005/);
  await refused(sign({ ...row, maxTimeoutSeconds: 1e9 }), /maxTimeoutSeconds/);
  await refused(sign({ ...row, maxTimeoutSeconds: 1200.5 }), /maxTimeoutSeconds/);
  const s = await sign(row); // allowed again after the terminal release
  chain.height = s.expires_at_block + 1; // ...and an expired one clears without a terminal state
  assert.deepEqual(await call(`${signer.url}/expire`, { task_id: '0', n: 1, terminal_unpaid: false }), { cleared: true, payment_hash: s.payment_hash, landed: false });

  // A payment that lands (the sub-account key's nonce reaches the delegate's) clears at once, and says it was paid.
  const p = await sign(row);
  assert.match(p.nonce, /^\d+$/); // stored by the orchestrator with the task, so a restart can follow the payment
  const d = verifySignedDelegate(JSON.parse(Buffer.from(p.header, 'base64').toString()).payload.signedDelegateAction);
  assert.equal(BigInt(p.nonce), d.nonce);
  await refused(call(`${signer.url}/expire`, { task_id: '0', n: 1, terminal_unpaid: false }), /still valid/);
  chain.keys.set(`${ACCOUNT}/${subKey}`, d.nonce);
  chain.balances.set(ACCOUNT, chain.balances.get(ACCOUNT)! - BigInt(row.amount));
  assert.deepEqual(await call(`${signer.url}/expire`, { task_id: '0', n: 1, terminal_unpaid: false }), { cleared: true, payment_hash: p.payment_hash, landed: true });

  // Kill is per contract task, and survives a restart.
  await call(`${signer.url}/kill`, { task_id: '7' });
  // Another task's kill leaves task 0 signing; and the whole balance may be spent (mark_empty closes out an empty account).
  assert.ok((await sign({ ...row, amount: String(chain.balances.get(ACCOUNT)) })).header);
  await call(`${signer.url}/expire`, { task_id: '0', n: 1, terminal_unpaid: true });
  await call(`${signer.url}/kill`, { task_id: '0' });
  await refused(sign({ ...row, amount: '1' }), /killed/);
  const again = await (await import('../src/signer/index.ts')).start(0);
  try { await refused(sign({ ...row, amount: '1' }, again.url), /killed/); } finally { await again.close(); }
});

test('/return sends the whole balance back with ft_transfer_call and the return msg, signed by the sub-account key', async () => {
  const r = await call(`${signer.url}/return`, { task_id: '0', n: 1, account_id: ACCOUNT });
  assert.equal(r.amount, '5');
  assert.deepEqual(lastTx(), {
    signer: ACCOUNT, key: subKey, receiver: USDC, method: 'ft_transfer_call',
    args: { receiver_id: CONTRACT, amount: '5', msg: '{"return":{"task_id":"0","n":1}}' }, gas: 50n * TGAS, deposit: 1n,
  });
  // An empty sub-account cannot return (NEP-141 refuses 0), so it is refused rather than reported as returned.
  await refused(call(`${signer.url}/return`, { task_id: '0', n: 1, account_id: ACCOUNT }), /mark-empty/);
});

test('chain-gateway /mark-empty: mark_empty with 50 Tgas from the orchestrator key; marked only at a 0 balance', async () => {
  chain.balances.set(ACCOUNT, 3n);
  const no = await call(`${gw.url}/mark-empty`, { task_id: '0', n: 1 });
  assert.deepEqual([no.success, no.marked], [true, false]); // the callback's false is an answer here, not a failure
  assert.deepEqual(lastTx(), {
    signer: 'orch.test', key: orchKp.getPublicKey().toString(), receiver: CONTRACT, method: 'mark_empty',
    args: { task_id: '0', n: 1 }, gas: 50n * TGAS, deposit: 0n,
  });
  chain.balances.set(ACCOUNT, 0n);
  const yes = await call(`${gw.url}/mark-empty`, { task_id: '0', n: 1 });
  assert.equal(yes.marked, true);
  assert.equal(chain.subtasks.find((s) => s.n === 1).status, 'Returned');
  assert.match(yes.explorer_url, /^https:\/\/testnet\.nearblocks\.io\/txns\//);
  chain.subtasks.find((s) => s.n === 1).status = 'Funded';
});

test('simulator: a delegate nonce is used only once its task settles; expired delegates and empty briefs use nothing', async () => {
  const kp = KeyPair.fromRandom('ed25519');
  const pay = async (handle: string, nonce: bigint, maxBlockHeight = BigInt(chain.height + 100)) => {
    const q = (await call(`${mgw.url}/quote`, { handle })).row;
    const transfer = functionCall('ft_transfer', { receiver_id: q.payTo, amount: q.amount }, 30, 1n);
    const signedDelegateAction = await signDelegate(kp, 'payer.test', q.asset, [transfer], nonce, maxBlockHeight);
    return Buffer.from(JSON.stringify({ x402Version: 2, accepted: q, payload: { signedDelegateAction } })).toString('base64');
  };
  const rpc = async (handle: string, method: string, params: object, header?: string) => {
    const r = await fetch(`${process.env.SIMULATOR_URL}/a2a/${handle}/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { 'x-payment': header } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: r.status, body: await r.json() as any };
  };
  const send = (handle: string, header: string, text = 'Contract check please') => rpc(handle, 'SendMessage', { message: { parts: [{ text }] } }, header);
  const until = async (handle: string, id: string, state: string) => {
    for (const end = Date.now() + 5000; Date.now() < end; await new Promise((ok) => setTimeout(ok, 25))) {
      if ((await rpc(handle, 'GetTask', { id })).body.result?.status.state === `TASK_STATE_${state}`) return;
    }
    assert.fail(`${handle} task ${id} never reached ${state}`);
  };

  let r = await send('sim-tokencheck-fast', await pay('sim-tokencheck-fast', 5n, BigInt(chain.height)));
  assert.deepEqual([r.status, r.body.error], [402, `delegate expired at block ${chain.height} (now ${chain.height})`]);
  const h = await pay('sim-tokencheck-fast', 5n);
  assert.equal((await send('sim-tokencheck-fast', h, ' ')).body.error.code, -32602);
  r = await send('sim-tokencheck-fast', h); // the empty-brief call used nothing
  assert.ok(r.body.result, JSON.stringify(r.body));
  assert.match((await send('sim-tokencheck', await pay('sim-tokencheck', 5n))).body.error, /already used/); // held while it runs

  await until('sim-tokencheck-fast', r.body.result.task.id, 'FAILED'); // unpaid: nonce 5 is free again
  r = await send('sim-tokencheck', await pay('sim-tokencheck', 5n));
  assert.ok(r.body.result, JSON.stringify(r.body));
  await until('sim-tokencheck', r.body.result.task.id, 'COMPLETED'); // settled: nonce 5 and below are used
  assert.match((await send('sim-price', await pay('sim-price', 5n))).body.error, /nonce already used/);
  assert.ok((await send('sim-price', await pay('sim-price', 6n))).body.result);
});

test('chain ledger: a fund_subtask that errors but is Funded on chain counts; a payment is booked only once the balance shows it', async () => {
  let expires = 0, balance = '600'; // what the sub-account holds on chain: 1000 funded, 400 paid
  const sg = await serve('mock-signer-2', {
    'POST /keys': () => ({ public_key: 'ed25519:x' }),
    'POST /sign': ({ body }) => ({ header: 'h', payment_hash: `ph-${body.row.amount}`, expires_at_block: 1, nonce: '9', row: body.row }),
    // 'wait': still redeemable on the first poll, then the delegate has run
    'POST /expire': () => { if (expires++ === 0) throw new HttpError(409, 'still valid'); return { cleared: true, landed: true }; },
  }, 0);
  const g = await serve('mock-gateway-2', {
    'POST /fund': () => { throw new Error('NEAR RPC send_tx: TIMEOUT_ERROR'); }, // a 500, but the tx landed
    'GET /task/:id': () => ({ task: {}, subtasks: [{ n: 1, account_id: `t5-1.${CONTRACT}`, cap: '1000', status: 'Funded' }] }),
    'GET /balance': () => ({ balance }),
  }, 0);
  servers.unshift(sg, g);
  Object.assign(process.env, { SIGNER_URL: sg.url, CHAIN_GATEWAY_URL: g.url });
  const { createChainLedger } = await import('../src/orchestrator/chain-ledger.ts');
  const l = createChainLedger();
  l.bind('T', '5', new Map([[1, 1]]));
  l.createTask('T', 'owner.test', 2000n, 0.2);
  assert.equal(await l.fundSubtask('T', 1, 1000n), 1000n);
  const allow = [{ network: 'near:testnet', asset: USDC, payTo: PAY_TO }];
  const pay = (amount: string) => l.authorize('T', 1, { scheme: 'exact', ...allow[0], amount, maxTimeoutSeconds: 60 }, allow);
  await pay('400');
  assert.deepEqual(l.binding('T')!.auths, { 1: { payment_hash: 'ph-400', amount: '400', expires_at_block: 1, nonce: '9' } }); // stored with the task
  assert.deepEqual(await l.release('T', 1, 'wait'), { amount: 400n, settled: true });
  assert.deepEqual([l.view('T')!.spent_atomic, l.view('T')!.subtasks[0].balance_atomic, expires], [400n, 600n, 2]);
  // COMPLETED, but the payment never moved the balance (it expired unsettled, or its transfer failed): booked unpaid.
  await pay('100');
  assert.equal(await l.settle('T', 1), 0n);
  assert.deepEqual([l.view('T')!.spent_atomic, l.view('T')!.subtasks[0].authorized_atomic, l.binding('T')!.auths], [400n, null, {}]);
  // And one that did: 500 left of 600.
  await pay('100');
  balance = '500';
  assert.equal(await l.settle('T', 1), 100n);
  assert.deepEqual([l.view('T')!.spent_atomic, l.view('T')!.subtasks[0].balance_atomic], [500n, 500n]);
  // The delegate ran (the signer saw its nonce), but its ft_transfer lands a block later: the balance is read again.
  await pay('100');
  setTimeout(() => { balance = '400'; }, 150);
  assert.equal(await l.settle('T', 1), 100n);
  await pay('100');
  setTimeout(() => { balance = '300'; }, 150);
  assert.deepEqual(await l.release('T', 1, 'terminal'), { amount: 100n, settled: true });
  assert.deepEqual([l.view('T')!.spent_atomic, l.view('T')!.subtasks[0].balance_atomic], [700n, 300n]);
});

test('orchestrator, ROOK_LEDGER=chain: approve gives funding instructions, /funded checks the contract task, run, close', async () => {
  process.env.ROOK_LEDGER = 'chain';
  const calls: string[] = [];
  const rec = (name: string, body?: any) => { calls.push(`${name} ${JSON.stringify(body ?? {})}`); };
  const subs: any[] = [], left = new Map<string, bigint>();
  const auths = new Set<string>(), returned = new Set<number>(); // like the real signer and contract
  const caps = ['300000', '200000'];
  const contractTask = (caps: string[]) => ({ funder: 'owner.test', budget: '1000000', reserve: '200000', caps, status: 'Open', killed: false });
  const mockSigner = await serve('mock-signer', {
    'POST /keys': ({ body }) => (rec('keys', body), { public_key: 'ed25519:x', tx_hash: 'k' }),
    'POST /sign': ({ body }) => {
      rec('sign', { n: body.n, account_id: body.account_id, amount: body.row.amount });
      if (auths.has(body.account_id)) throw new HttpError(409, 'outstanding authorization');
      if (BigInt(body.row.amount) > left.get(body.account_id)!) throw new HttpError(409, 'exceeds the sub-account balance');
      auths.add(body.account_id);
      left.set(body.account_id, left.get(body.account_id)! - BigInt(body.row.amount)); // every hire below completes
      const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: body.row, payload: { signedDelegateAction: 'AA==' } })).toString('base64');
      return { header, payment_hash: createHash('sha256').update(header).digest('hex'), expires_at_block: 1, nonce: '1' };
    },
    'POST /expire': ({ body }) => { // the payment landed at once: settle clears the authorization
      rec('expire', body);
      const account = `t${body.task_id}-${body.n}.${CONTRACT}`;
      return auths.delete(account) ? { cleared: true, landed: true } : { cleared: false, outstanding: false };
    },
    'POST /return': ({ body }) => {
      rec('return', body);
      if (auths.has(body.account_id)) throw new HttpError(409, 'outstanding authorization');
      if (!left.get(body.account_id)) throw new HttpError(409, 'empty: nothing to return');
      returned.add(body.n);
      return { tx_hash: 'r', amount: String(left.get(body.account_id)) };
    },
    'POST /kill': () => (rec('kill'), { killed: true }),
  }, 0);
  const mockGw = await serve('mock-chain-gateway', {
    'GET /config': () => ({ network: 'testnet', contract_id: CONTRACT, owner: 'owner.test', usdc: USDC }),
    'GET /task/:id': ({ params }) => ({ task: contractTask(params.id === 'bad' ? ['300000', '250000'] : caps), subtasks: params.id === 'ok' ? subs : [] }),
    'POST /fund': ({ body }) => {
      rec('fund', body);
      const account_id = `t${body.task_id}-${body.n}.${CONTRACT}`;
      subs.push({ n: body.n, account_id, cap: caps[body.n - 1], status: 'Funded' });
      left.set(account_id, BigInt(caps[body.n - 1]));
      return { tx_hash: 'f', success: true };
    },
    'POST /top-up': ({ body }) => {
      rec('top-up', body);
      const account_id = `t${body.task_id}-${body.n}.${CONTRACT}`;
      left.set(account_id, left.get(account_id)! + BigInt(body.amount_atomic));
      return { tx_hash: 'u', success: true };
    },
    'POST /receipt': ({ body }) => (rec('receipt', { n: body.n, amount: body.receipt.amount, verdict: body.receipt.verdict }), { tx_hash: `rtx-${body.n}`, explorer_url: `https://testnet.nearblocks.io/txns/rtx-${body.n}` }),
    'POST /mark-empty': ({ body }) => {
      rec('mark-empty', body);
      const marked = !left.get(`t${body.task_id}-${body.n}.${CONTRACT}`);
      if (marked) returned.add(body.n);
      return { tx_hash: 'm', success: true, marked };
    },
    'POST /close': ({ body }) => {
      rec('close', body);
      const open = subs.filter((x) => !returned.has(x.n)).map((x) => x.n);
      if (open.length) throw new HttpError(502, `close_task failed: subtask ${open[0]} has not returned its leftover`);
      return { tx_hash: 'c', success: true };
    },
    'GET /balance': ({ query }) => ({ balance: String(left.get(query.get('account')!) ?? 0n) }),
    'GET /payment': ({ query }) => ({ found: true, tx_hash: `pay-${query.get('account')}-${query.get('amount')}`, explorer_url: `https://testnet.nearblocks.io/txns/pay-${query.get('amount')}` }),
  }, 0);
  const X402 = { network: 'near:testnet', asset: USDC, payTo: PAY_TO };
  const r = (amount: string) => ({ scheme: 'exact', ...X402, amount, maxTimeoutSeconds: 60 });
  const fakeMarket = await serve('fake-market-gateway', {
    'GET /x402': () => ({ x402Version: 2, recipients: [X402] }),
    'POST /quote': ({ body }) => ({ ok: true, row: r(body.handle === 'holders' ? '300000' : '150000') }),
    'POST /send': () => ({ ok: true, task: { id: `a2a-${calls.length}`, context_id: null, state: 'COMPLETED', artifacts: [{ parts: [{ text: 'report' }] }] } }),
    'GET /task': ({ query }) => ({ ok: true, task: { id: query.get('id'), context_id: null, state: 'COMPLETED', artifacts: [{ parts: [{ text: 'report' }] }] } }),
    'POST /cancel': () => ({ ok: true }),
  }, 0);
  const cand = (handle: string, price: string) => ({ handle, name: handle, description: handle, sla_seconds: 5, success_rate: null, delivered_jobs: 0, price_atomic: price, quote: r(price) });
  const sub = (id: string, cap: string, candidates: any[], self_do = false) => ({
    id, title: id, brief: `${id}\nPlease report.`, search_terms: [id], cap_atomic: cap, deadline_s: 5, self_do, candidates,
    criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: '.' } }],
  });
  const plan = {
    subtasks: [sub('s1', '300000', [cand('holders', '300000')]), sub('s2', '0', [], true), sub('s3', '200000', [cand('check', '150000')])],
    dropped: [], notes: [], llm_calls: [],
    budget: { budget_atomic: '1000000', reserve_atomic: '200000', allocatable_atomic: '800000', allocated_atomic: '500000' },
  };
  const planner = await serve('fake-planner', {
    'POST /plan': () => plan,
    'POST /self-do': () => ({ text: 'self report', llm_calls: [] }),
    'POST /aggregate': () => ({ final_markdown: 'final', attribution: [], llm_calls: [] }),
  }, 0);
  const evaluator = await serve('fake-evaluator', {
    'POST /evaluate': () => ({ verdict: 'pass', results: [], failed_criteria: [], security_flags: [], extracted: {}, llm_calls: [], engine: 'local', attestation_hash: 'att' }),
  }, 0);
  Object.assign(process.env, {
    SIGNER_URL: mockSigner.url, CHAIN_GATEWAY_URL: mockGw.url, MARKET_GATEWAY_URL: fakeMarket.url, PLANNER_URL: planner.url, EVALUATOR_URL: evaluator.url,
  });
  const orch = await (await import('../src/orchestrator/index.ts')).start(0);
  servers.unshift(orch, mockSigner, mockGw, fakeMarket, planner, evaluator);

  const t = await call(`${orch.url}/tasks`, { prompt: 'p', budget_usdc: '1' });
  const a = await call(`${orch.url}/tasks/${t.id}/approve`, {});
  assert.equal(a.status, 'approved');
  const { network, contract_id, usdc, amount_atomic, msg } = a.funding;
  assert.deepEqual({ network, contract_id, usdc, amount_atomic, msg }, {
    network: 'testnet', contract_id: CONTRACT, usdc: USDC, amount_atomic: '1000000',
    msg: '{"create_task":{"reserve_bps":2000,"caps":["300000","200000"]}}',
  });
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal((await call(`${orch.url}/tasks/${t.id}`)).task.status, 'approved'); // waits for the human's transfer
  assert.equal(calls.length, 0);

  // Killing a task that never reached the chain does not touch the signer (its kill would stop other tasks).
  const other = await call(`${orch.url}/tasks`, { prompt: 'p2', budget_usdc: '1' });
  await call(`${orch.url}/tasks/${other.id}/approve`, {});
  await call(`${orch.url}/tasks/${other.id}/kill`, {});
  assert.equal(calls.length, 0);

  await refused(call(`${orch.url}/tasks/${t.id}/funded`, { contract_task_id: 'bad' }), /caps/);
  assert.equal(a.funding.funder, null); // a CLI task: whoever sends the transfer funds it
  assert.equal(a.funding.contract_owner, 'owner.test'); // informative only: any account funds its own task
  // A signed-in owner binds only a contract task their own wallet funded, never someone else's matching one.
  const alice = await call(`${orch.url}/tasks`, { prompt: 'p3', budget_usdc: '1', owner: 'alice.near' });
  await call(`${orch.url}/tasks/${alice.id}/approve`, { owner: 'alice.near' });
  await refused(call(`${orch.url}/tasks/${alice.id}/funded`, { contract_task_id: 'other', owner: 'alice.near' }), /funded by owner\.test, not by the task owner alice\.near/);
  const both = await Promise.allSettled([1, 2].map(() => call(`${orch.url}/tasks/${t.id}/funded`, { contract_task_id: 'ok' })));
  assert.deepEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected']); // overlapping /funded: one binds and runs
  assert.equal((both.find((x) => x.status === 'fulfilled') as any).value.contract_task_id, 'ok');
  let s: any;
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((ok) => setTimeout(ok, 25))) {
    s = await call(`${orch.url}/tasks/${t.id}`);
    if (['closed', 'failed'].includes(s.task.status)) break;
  }
  assert.equal(s.task.status, 'closed', s.task.error);
  const ok = 'tok';
  // Contract n: s1 -> 1, s3 -> 2 (the self_do s2 has no cap on chain).
  assert.deepEqual(calls.filter((c) => !c.startsWith('receipt') && !c.startsWith('return')).slice(0, 4), [
    'keys {"task_id":"ok","n":1}', 'fund {"task_id":"ok","n":1}', 'keys {"task_id":"ok","n":2}', 'fund {"task_id":"ok","n":2}',
  ]);
  assert.deepEqual(calls.filter((c) => /^(sign|receipt|return|mark-empty)/.test(c)).sort(), [
    'mark-empty {"task_id":"ok","n":1}', // s1's price equals its cap: spent to 0, so the contract marks it empty
    'receipt {"n":1,"amount":"300000","verdict":"pass"}', 'receipt {"n":2,"amount":"150000","verdict":"pass"}',
    `return {"task_id":"ok","n":2,"account_id":"${ok}-2.${CONTRACT}"}`,
    `sign {"n":1,"account_id":"${ok}-1.${CONTRACT}","amount":"300000"}`, `sign {"n":2,"account_id":"${ok}-2.${CONTRACT}","amount":"150000"}`,
  ]);
  assert.equal(calls.at(-1), 'close {"task_id":"ok"}');
  assert.ok(!calls.some((c) => c.startsWith('top-up'))); // no unit kept back in the sub-account any more
  assert.deepEqual(s.receipts.map((x: any) => [x.agent_handle, x.receipt_tx, x.evidence.ft_balance_atomic]).sort(), [['check', 'rtx-2', '50000'], ['holders', 'rtx-1', '0']]);
  assert.equal(s.ledger.contract_task_id, 'ok');
  assert.equal(s.ledger.refunded_atomic, String(1_000_000 - 450_000));
  // Receipts carry the A2A task, the verdict's hash and both transactions with explorer links; payment_tx comes from
  // the indexer lookup in the background, so it may land just after the task closed.
  for (const end = Date.now() + 5000; s.receipts.some((x: any) => !x.payment_tx) && Date.now() < end; await new Promise((ok) => setTimeout(ok, 25))) {
    s = await call(`${orch.url}/tasks/${t.id}`);
  }
  const holders = s.receipts.find((x: any) => x.agent_handle === 'holders');
  assert.match(holders.a2a_task_id, /^a2a-/);
  assert.deepEqual([holders.attestation_hash, holders.receipt_explorer_url, holders.payment_tx, holders.payment_explorer_url], [
    'att', 'https://testnet.nearblocks.io/txns/rtx-1', `pay-${ok}-1.${CONTRACT}-300000`, 'https://testnet.nearblocks.io/txns/pay-300000',
  ]);
  const evs = (await fetch(`${orch.url}/tasks/${t.id}/events`).then((x) => x.text())).split('\n\n').filter(Boolean);
  assert.ok(evs.some((e) => e.includes('"op":"payment_found"')));
  // The binding to the contract task is in the snapshot's ledger view; the stored task keeps it for a restart.
  assert.deepEqual(s.ledger.accounts, { 1: `${ok}-1.${CONTRACT}`, 3: `${ok}-2.${CONTRACT}` });
  await refused(call(`${orch.url}/tasks/${t.id}/funded`, { contract_task_id: 'ok' }), /closed/);
});
