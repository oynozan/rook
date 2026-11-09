// Simulator + market gateway: search, quote, paid send, replay refusal, FAILED profile, cancel rules.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';
process.env.SIM_DELIVERY_MS = '200';
process.env.SIM_HOLD_MS = '100';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { start: startSim } = await import('../src/simulator/index.ts');
const { start: startGateway } = await import('../src/market-gateway/index.ts');
const { call } = await import('../src/shared/http.ts');
const { times7 } = await import('../src/simulator/agents.ts');

let sim: Awaited<ReturnType<typeof startSim>>, gw: Awaited<ReturnType<typeof startGateway>>;
before(async () => {
  sim = await startSim(0);
  process.env.SIMULATOR_URL = sim.url;
  gw = await startGateway(0);
});
after(async () => { await gw.close(); await sim.close(); });

const header = (row: unknown, nonce = 'x') =>
  Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { sim: { nonce } } })).toString('base64');
const quote = async (handle: string) => (await call(`${gw.url}/quote`, { handle })).row;
const send = (handle: string, payment: string) => call(`${gw.url}/send`, { handle, text: 'NEAR token holder distribution\nReport the holders.', payment });

async function waitFor(handle: string, id: string, states: string[]) {
  for (let i = 0; i < 100; i++) {
    const r = await call(`${gw.url}/task?handle=${handle}&id=${id}`);
    assert.equal(r.ok, true);
    if (states.includes(r.task.state)) return r.task;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`task ${id} never reached ${states}`);
}

test('search finds both holders agents; /x402 is the simulator config', async () => {
  const { agents } = await call(`${gw.url}/search?q=${encodeURIComponent('holder distribution')}`);
  assert.deepEqual(agents.map((a: any) => a.handle).sort(), ['sim-holders', 'sim-holders-lite']);
  assert.equal(agents[0].listing_status, 'live');
  assert.deepEqual((await call(`${gw.url}/x402`)).recipients, [{ network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim' }]);
});

test('live search reads pages of 50 until 20 agents are available now, skips offline ones, and reads at most 3 pages', async (t) => {
  const { serve, HttpError } = await import('../src/shared/http.ts');
  // The market's /v1/agents: limit at most 50, offset, and offline agents listed too. Availability per query:
  // 'half' every other agent, 'sparse' 1 in 5, 'rare' 1 in 25, 'few' all of only 30 rows, 'stuck' 1 in 5 and offset ignored.
  // 'flaky' fails after its first page, 'down' at once.
  const every: Record<string, number> = { half: 2, sparse: 5, rare: 25, few: 1, stuck: 5, flaky: 5, down: 1 };
  const rows = (q: string) => Array.from({ length: q === 'few' ? 30 : 200 }, (_, i) => ({
    handle: `${q}-${i}`, name: `${q} ${i}`, available_now: i % every[q] === 0, listing_status: 'live', payable_with: ['USDC'], sla_seconds: 60,
  }));
  const asked: string[] = [];
  const market = await serve('fake-market', {
    'GET /v1/agents': ({ query }) => {
      const q = query.get('q')!, limit = Math.min(50, Number(query.get('limit') ?? 20)), offset = q === 'stuck' ? 0 : Number(query.get('offset') ?? 0);
      asked.push(`${limit}@${query.get('offset')}`);
      if (q === 'down' || (q === 'flaky' && offset > 0)) throw new HttpError(503, 'busy');
      return { agents: rows(q).slice(offset, offset + limit) };
    },
    'GET /.well-known/x402': () => ({ x402Version: 2, recipients: [] }),
  }, 0);
  const saved = { ROOK_MARKET: process.env.ROOK_MARKET, MARKET_BASE_URL: process.env.MARKET_BASE_URL };
  process.env.ROOK_MARKET = 'live';
  process.env.MARKET_BASE_URL = market.url;
  const live = await startGateway(0);
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await live.close(); await market.close();
  });
  const search = async (q: string) => {
    asked.length = 0;
    const handles: string[] = (await call(`${live.url}/search?q=${q}`)).agents.map((a: any) => a.handle);
    return { pages: [...asked], available: handles.every((h) => Number(h.split('-')[1]) % every[q] === 0), count: handles.length };
  };

  assert.deepEqual(await search('half'), { pages: ['50@0'], available: true, count: 25 }); // one page is enough
  assert.deepEqual(await search('sparse'), { pages: ['50@0', '50@50'], available: true, count: 20 });
  assert.deepEqual(await search('rare'), { pages: ['50@0', '50@50', '50@100'], available: true, count: 6 }); // the bound
  assert.deepEqual(await search('few'), { pages: ['50@0'], available: true, count: 30 }); // a short page is the last
  assert.deepEqual(await search('stuck'), { pages: ['50@0', '50@50'], available: true, count: 10 }); // same rows again: stop
  assert.deepEqual(await search('flaky'), { pages: ['50@0', '50@50'], available: true, count: 10 }); // keeps page 1
  const down = await fetch(`${live.url}/search?q=down`);
  assert.equal(down.status, 502);
  assert.match((await down.json()).error, /market search: HTTP 503/);
});

test('quote, paid send to COMPLETED, replay and mismatched rows refused', async () => {
  const row = await quote('sim-holders-lite');
  assert.equal(row.amount, '150000');
  assert.equal(row.payTo, 'treasury.sim');

  const pay = header(row);
  const sent = await send('sim-holders-lite', pay);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const done = await waitFor('sim-holders-lite', sent.task.id, ['COMPLETED']);
  const text = done.artifacts[0].parts[0].text;
  assert.match(text, /SIMULATED deliverable from sim-holders-lite/);
  assert.match(text, /Top 10 holders share: 291\.2%/); // wrong_numbers fault

  const replay = await send('sim-holders-lite', pay);
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, 402);

  const cheaper = await send('sim-holders-lite', header({ ...row, amount: '1' }, 'y'));
  assert.equal(cheaper.ok, false);
  assert.equal(cheaper.error.code, 402);
});

test('fails profile reaches FAILED with no artifacts', async () => {
  const sent = await send('sim-tokencheck-fast', header(await quote('sim-tokencheck-fast')));
  const t = await waitFor('sim-tokencheck-fast', sent.task.id, ['COMPLETED', 'FAILED']);
  assert.equal(t.state, 'FAILED');
  assert.deepEqual(t.artifacts, []);
});

test('cancel works while SUBMITTED, refused once terminal', async () => {
  const slow = await send('sim-price-slow', header(await quote('sim-price-slow')));
  assert.equal(slow.task.state, 'SUBMITTED');
  assert.deepEqual(await call(`${gw.url}/cancel`, { handle: 'sim-price-slow', id: slow.task.id }), { ok: true });
  assert.equal((await waitFor('sim-price-slow', slow.task.id, ['CANCELED'])).state, 'CANCELED');

  const good = await send('sim-price', header(await quote('sim-price')));
  await waitFor('sim-price', good.task.id, ['COMPLETED']);
  const refused = await call(`${gw.url}/cancel`, { handle: 'sim-price', id: good.task.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, -32002);
});

test('times7 multiplies values, not the numbers inside labels', () => {
  assert.equal(times7('Top 10 holders share: 41.6%\nActive wallets (30d): 3,150,000\nPrice (USD): 3.12'),
    'Top 10 holders share: 291.2%\nActive wallets (30d): 22,050,000\nPrice (USD): 21.84');
});
