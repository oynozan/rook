// Links the evaluator opens (docs/agentic-system.md 6.2, 7): media a delivery gives, the sources it cites with the figures
// on them, a deployed site against the page it was given, and what the judge is told. QA round 2, 2026-11-11: a logo plan
// could never pass, a report on five dead domains passed its source check, and a Bing search for the bakery's name
// passed as its deployed site. Local servers only, through the readers' test seams.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Criterion, EvaluateRequest } from '../src/shared/types.ts';

const { evaluate } = await import('../src/evaluator/index.ts');
const { useFetchSeam } = await import('../src/evaluator/fetch.ts');
const { useReferenceSeam } = await import('../src/planner/reference.ts');
const { pageShows } = await import('../src/evaluator/checks.ts');

const c = (id: string, kind: string, spec: object) => ({ id, kind, description: id, spec }) as Criterion;
const result = (ev: { results: { criterion_id: string; passed: boolean; skipped: boolean; detail: string }[] }, id: string) => ev.results.find((r) => r.criterion_id === id)!;
const run = (text: string, criteria: Criterion[], extra: Partial<EvaluateRequest> = {}) =>
  evaluate({ task_id: 't', subtask_id: 's1', brief: 'b', criteria, deliverable: { text, parts: [{ text }] }, peers: [], ...extra } as EvaluateRequest);

// A PNG's signature and IHDR (its size), padded: enough for the sniffer.
const png = (w: number, h: number) => {
  const b = Buffer.alloc(200);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(3000)]);
const SITE = '<!doctype html><html><head><title>Maple &amp; Rye Bakery</title></head><body><h1>Maple &amp; Rye Bakery</h1><p>Sourdough baked every morning in Leeds.</p><h2>Opening hours</h2><p>Tuesday to Sunday, 7am to 3pm.</p></body></html>';

let port = 0;
const server = http.createServer((q, s) => {
  const send = (type: string, body: Buffer | string, status = 200) => { s.writeHead(status, { 'content-type': type }); s.end(body); };
  const html = (body: string) => send('text/html; charset=utf-8', body);
  const path = (q.url ?? '').split('?')[0];
  switch (path) {
    case '/logo.png': return send('image/png', png(64, 64));
    case '/assets/x': return send('image/png', png(256, 128));
    case '/pixel.png': return send('image/png', png(1, 1));
    case '/fake.png': return send('image/png', '<!doctype html><html><body>Not found, but 200</body></html>');
    case '/clip.mp4': return send('video/mp4', mp4);
    // 64 KB of tags that never close: the Open Graph regexes this replaced took 160 s on it.
    case '/metas': return html('<meta content="video.x" '.repeat(2700));
    case '/watch': return html('<html><head><meta property="og:type" content="video.other"><meta property="og:video" content="https://player.test/v/1"><title>Launch video</title></head><body>Video</body></html>');
    case '/big.mp4': {
      // 50 MB declared, never finished: the reader takes its head and hangs up.
      s.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(50 * 1024 * 1024) });
      s.on('error', () => {});
      s.write(Buffer.concat([mp4, Buffer.alloc(256 * 1024)]));
      return;
    }
    case '/stats': return html('<html><head><title>NEAR supply</title></head><body><h1>NEAR supply</h1><p>Total supply: 1,311,369,660 NEAR</p></body></html>');
    case '/holders': return html('<html><head><title>NEAR holders</title></head><body><p>Top 10 holders share 38.17%</p></body></html>');
    case '/data.json': return send('application/json', JSON.stringify({ total_supply: '1311369660' }));
    case '/site': return html(SITE);
    case '/other': return html('<html><head><title>Rye Bakery Leeds</title></head><body><h1>Maple &amp; Rye Bakery</h1><p>A page somebody else made.</p></body></html>');
    case '/search': return html('<html><head><title>Maple &amp; Rye Bakery - Search</title></head><body><p>Results for Maple &amp; Rye Bakery</p></body></html>');
    case '/ent': return html('<html><head><title>Studio</title></head><body><footer>Made by Selin Ka&ccedil;ar and Ba&scedil;ak &amp; friends</footer></body></html>');
  }
  s.writeHead(404); s.end();
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
port = (server.address() as any).port;
// Sources are served under a name that is no placeholder (*.test is one, as example.com is), resolved by the seam.
const hosts: Record<string, string> = { 'cdn.test': '127.0.0.1', 'data.rookqa.net': '127.0.0.1', 'site.test': '127.0.0.1', 'search.test': '127.0.0.1', 'intranet.test': '10.0.0.5' };
const seam = { resolve: async (h: string) => (hosts[h] ? [{ address: hosts[h], family: 4 as const }] : []), allow: (a: string, p: number) => a === '127.0.0.1' && p === port, timeoutMs: 2000 };
useFetchSeam(seam);
useReferenceSeam(seam);
process.on('exit', () => { useFetchSeam(null); useReferenceSeam(null); });
test.after(() => { server.closeAllConnections(); server.close(); });
const cdn = `http://cdn.test:${port}`, stats = `http://data.rookqa.net:${port}`;

test('media: an image, video or audio the delivery gives loads as that kind, from a link, a "File:" line, raw bytes or a data URL', async () => {
  const image = [c('c1', 'media', { kinds: ['image'] })];
  assert.equal(result(await run(`Here is your logo: ${cdn}/logo.png`, image), 'c1').detail, `1 image file load: cdn.test:${port}/logo.png (PNG, 64×64, 200 bytes)`);
  // How the runner writes a url part: "File: <name> <link>", the link with no file extension.
  assert.equal(result(await run(`File: brand.webp ${cdn}/assets/x`, image), 'c1').passed, true);
  // Bytes in the reply: a raw part (base64, or a file part as JSON) and a data URL; nothing is fetched.
  const raw = await run('Logo attached.', image, { deliverable: { text: 'Logo attached.', parts: [{ raw: JSON.stringify({ file: { bytes: png(32, 32).toString('base64'), mimeType: 'image/png', name: 'logo.png' } }) }] } });
  assert.equal(result(raw, 'c1').detail, '1 image file load: logo.png (PNG, 32×32, 200 bytes)');
  const data = await run('Logo attached.', image, { deliverable: { text: 'Logo attached.', parts: [{ url: `data:image/png;base64,${png(48, 48).toString('base64')}` }] } });
  assert.equal(result(data, 'c1').passed, true);

  // A dead link, an HTML page served as image/png, a tracking pixel and a private address are no logo.
  const bad = await run(`Logo: ${cdn}/gone.png\nAlt: ${cdn}/fake.png\nIcon: ${cdn}/pixel.png\nCopy: http://intranet.test/logo.png`, image);
  assert.equal(result(bad, 'c1').detail, `needs 1 image file, 0 load: cdn.test:${port}/gone.png: it answered HTTP 404; cdn.test:${port}/fake.png: it is a web page, not media; cdn.test:${port}/pixel.png: it is only 1×1 pixels; intranet.test/logo.png: it points to a private or local network address`);
  assert.equal(result(await run('I designed a lovely logo for you.', image), 'c1').detail, 'no image in the delivery: no file, "File:" line or link to one');

  // Video: a file by its first bytes, a video page by its Open Graph tags; an image is not a video.
  const video = [c('c1', 'media', { kinds: ['video'] })];
  assert.equal(result(await run(`Your video: ${cdn}/clip.mp4`, video), 'c1').passed, true);
  assert.equal(result(await run(`Watch it here (video): ${cdn}/watch`, video), 'c1').detail, `1 video file load: cdn.test:${port}/watch (a video page)`);
  assert.equal(result(await run(`Your video: ${cdn}/logo.png`, video), 'c1').detail, `needs 1 video file, 0 load: cdn.test:${port}/logo.png: it is an image, not a video`);
  // A big video is sniffed by its head, never downloaded whole.
  const t0 = Date.now();
  assert.equal(result(await run(`Final cut: ${cdn}/big.mp4`, video), 'c1').detail, `1 video file load: cdn.test:${port}/big.mp4 (MP4, 50.0 MB)`);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  // A page of tags that never close is read in linear time, and is no video.
  const t1 = Date.now();
  assert.equal(result(await run(`Your video: ${cdn}/metas`, video), 'c1').detail, `needs 1 video file, 0 load: cdn.test:${port}/metas: it is a web page, not media`);
  assert.ok(Date.now() - t1 < 1000, `took ${Date.now() - t1} ms`);
});

test('files: a path of a media kind is met by a delivered image or video, by name, format or kind', async () => {
  // QA's logo plan: files ['rook-roasters-logo.svg', 'rook-roasters-logo.png'] failed every delivery, a perfect one included.
  const svg = 'logo.svg\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  <circle cx="32" cy="32" r="30" fill="#7a3"/>\n</svg>\n```';
  const ev = await run(`${svg}\n\nThe PNG: ${cdn}/logo.png`, [c('c1', 'files', { paths: ['logo.svg', 'brand/rook-roasters-logo.png'] })]);
  assert.deepEqual([ev.verdict, result(ev, 'c1').detail], ['pass', `1 file delivered whole; brand/rook-roasters-logo.png arrives as cdn.test:${port}/logo.png (PNG, 64×64, 200 bytes)`]);
  const none = await run(`The logo: ${cdn}/logo.png`, [c('c1', 'files', { paths: ['intro.mp4'] })]);
  assert.equal(result(none, 'c1').detail, `intro.mp4 is not delivered: no video in the delivery loads (cdn.test:${port}/logo.png: it is an image, not a video)`);
});

test('sources: cited links must load as public pages, and each labelled figure must be on a page cited for it', async () => {
  const crit = [c('c1', 'numeric_match', { label: 'Total supply', min: 1 }), c('c2', 'numeric_match', { label: 'Top 10 holders share', min: 0, max: 100 }), c('c3', 'sources', { min: 2, figures: true })];
  const good = `# NEAR supply\nTotal supply: 1311369660 (source: ${stats}/stats)\nTop 10 holders share: 38.2%\n\nSources:\n- NEAR holders: ${stats}/holders\n- Example Domain: https://example.com/`;
  const ok = await run(good, crit);
  assert.equal(ok.verdict, 'pass', JSON.stringify(ok.results));
  assert.equal(result(ok, 'c3').detail, `2 of 2 cited links load as public pages (data.rookqa.net:${port}/stats, data.rookqa.net:${port}/holders); Total supply 1311369660 is on data.rookqa.net:${port}/stats; Top 10 holders share 38.2 is on data.rookqa.net:${port}/holders; example.com is a placeholder address, not a source`);

  // QA's fake2.md: invented domains that don't resolve and an invented total supply.
  const fake = await run('Total supply: 1450000000 (source: https://nearstats-pro.io/supply)\nTop 10 holders share: 41%\n\nSources:\n- https://chainmetrics.network/near', crit);
  assert.equal(result(fake, 'c3').detail, 'needs 2 source links that load as a public page; 0 of the 2 cited links Rook opened load: nearstats-pro.io/supply (its name does not resolve); chainmetrics.network/near (its name does not resolve)');
  // A real page that doesn't hold the figure cited for it.
  const wrong = await run(good.replace('1311369660', '1450000000'), crit);
  assert.equal(result(wrong, 'c3').detail, `Total supply 1450000000 is on no page cited for it (data.rookqa.net:${port}/stats loads but does not show it); example.com is a placeholder address, not a source`);
  // A figure with no link of its own is looked for on the sources list's pages; data counts as a page.
  const listed = await run(`Total supply: 1311369660\n\nSources: ${stats}/data.json, ${stats}/holders`, [crit[0], crit[2]]);
  assert.equal(result(listed, 'c3').passed, true, result(listed, 'c3').detail);
  assert.equal(result(await run('Sources: https://example.com/', [c('c1', 'sources', { min: 1 })]), 'c1').detail, 'needs 1 source link that loads as a public page; cites no source link; example.com is a placeholder address, not a source');
});

test("live_url: the deployed page must be the page it was given, not a search page or one that echoes its own query", async () => {
  const inputs = [{ path: 'index.html', text: SITE }];
  const deploy = (url: string) => run(`Deployed.\n\nLive URL: ${url}`, [c('c1', 'live_url', { must_contain: 'Maple & Rye Bakery' })], { inputs });
  assert.equal(result(await deploy(`http://site.test:${port}/site`), 'c1').detail, `Live URL http://site.test:${port}/site loaded site.test:${port}/site ("Maple & Rye Bakery"), which shows "Maple & Rye Bakery", with the title of the page it was given`);
  assert.match(result(await deploy(`http://site.test:${port}/other`), 'c1').detail, /, which is not the site it was given: it shows neither the title "Maple & Rye Bakery" nor its text \(1 of 4 phrases, such as "Maple & Rye Bakery"\)$/);
  // QA's case: a search for the name answers with the name.
  assert.match(result(await deploy(`http://search.test:${port}/search?q=Maple+%26+Rye+Bakery`), 'c1').detail, /which shows "Maple & Rye Bakery" only because its own address asks for it \(a search or redirect link\), not a deployed site$/);
  assert.equal(result(await deploy('https://www.bing.com/search?q=%22Maple+%26+Rye+Bakery%22'), 'c1').detail, 'Live URL https://www.bing.com/search?q=%22Maple+%26+Rye+Bakery%22 is a search engine\'s page, not a deployed site');
  // A deploy is no edit of its input files.
  assert.equal((await deploy(`http://site.test:${port}/site`)).results.some((r) => r.criterion_id === 'edit_scope'), false);
});

test('must_contain reads every HTML entity: a page that writes ç as &ccedil; shows "Kaçar"', async () => {
  const ev = await run(`Live URL: http://site.test:${port}/ent`, [c('c1', 'live_url', { must_contain: 'Selin Kaçar' }), c('c2', 'live_url', { must_contain: 'Başak & friends' })]);
  assert.deepEqual([result(ev, 'c1').passed, result(ev, 'c2').passed], [true, true], JSON.stringify(ev.results));
  const html = '<p>Anda&ccedil; &mdash; &#x15F;ehir &Idot;zmir &euro;5</p>';
  for (const want of ['Andaç — şehir İzmir €5']) assert.equal(pageShows({ title: '', description: '', headings: [], text: '' }, html, want), true, want);
});

/** Runs `f` with ROOK_LLM=near against a fake NEAR AI that answers `content` and records each chat request body. */
async function withNearAi<T>(content: unknown, f: (bodies: any[]) => Promise<T>): Promise<T> {
  const { config } = await import('../src/shared/config.ts');
  const keys = ['ROOK_LLM', 'NEARAI_API_KEY', 'NEARAI_BASE_URL'] as const;
  const saved = keys.map((k) => process.env[k]);
  Object.assign(process.env, { ROOK_LLM: 'near', NEARAI_API_KEY: 'test-key', NEARAI_BASE_URL: 'https://nearai.test/v1' });
  const real = globalThis.fetch, bodies: any[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith('/models')) return reply({ data: [{ id: config.evaluatorModel, pricing: { prompt: 0, completion: 0 } }] });
    if (url.includes('/signature/')) return reply({});
    if (!url.endsWith('/chat/completions')) return reply({}, 404);
    bodies.push(JSON.parse(String(init?.body)));
    return reply({ id: 'c1', choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }) as typeof fetch;
  try { return await f(bodies); } finally {
    globalThis.fetch = real;
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
}

test("the judge is told today's date and the deliverable's sources, that cited facts count as sourced, and gets room for a big deliverable", async () => {
  // QA: the judge rejected Rook's sourced facts about a November 2026 match as unverifiable, and a 14k-token site used
  // its 4000 tokens before answering.
  const text = `# The title match\n\nThe match ends on 2026-11-28 (source: ${stats}/stats).\nPrize fund (USD): 2500000\n\n${'Background paragraph about the players. '.repeat(1500)}`;
  const reply = { 'Prize fund (USD)': { value: 2500000, quote: 'Prize fund (USD): 2500000' }, answers: [{ id: 'c2', answer: 'yes', reason: 'sourced' }] };
  await withNearAi(reply, async (bodies) => {
    const ev = await run(text, [c('c1', 'sources', { min: 1 }), c('c2', 'llm_judge', { question: 'Are the facts current?' }), c('c3', 'numeric_match', { label: 'Prize fund (USD)', min: 0 })]);
    assert.equal(ev.verdict, 'pass', JSON.stringify(ev.results));
    const [extract, judge] = bodies;
    assert.ok(extract.max_tokens > 10_000, `extraction room ${extract.max_tokens}`);
    const system = judge.messages[0].content as string, user = judge.messages[1].content as string;
    assert.match(system, new RegExp(`Today is ${new Date().toISOString().slice(0, 10)} \\(UTC\\)`));
    assert.match(system, /counts as sourced even when it is newer than what you know/);
    assert.match(user, new RegExp(`<sources>\\n- data\\.rookqa\\.net:${port}/stats: loaded \\("NEAR supply"\\)\\n</sources>`));
    assert.equal(judge.max_tokens, 4000 + Math.ceil(user.length / 8));
    assert.ok(judge.max_tokens > 10_000, String(judge.max_tokens));
  });
});
