// Code files out of the deliveries (docs/agentic-system.md 5.4): taken out as written, named, capped, and replaced by a
// marker in what the aggregator and the deterministic merge see.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { attachFiles, FILE_MAX_BYTES } = await import('../src/planner/files.ts');
const d = (subtask_id: string, title: string, text: string, agent_handle = 'web-dev') => ({ subtask_id, agent_handle, title, text });
const PAGE = '<!doctype html>\n<html>\n<head><title>Ozan</title></head>\n<body><h1>Ozan</h1></body>\n</html>';

test('a fenced html block becomes a file named from the line before it; the text keeps a marker in its place', () => {
  const r = attachFiles([d('s2', 'Build one-page portfolio website', `Here is the site.\n\n**portfolio.html**\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\nOpen it in a browser.`)]);
  assert.deepEqual(r.files, [{ subtask_id: 's2', agent_handle: 'web-dev', name: 'portfolio.html', mime: 'text/html', text: PAGE }]);
  assert.equal(r.texts.get('s2'), 'Here is the site.\n\n**portfolio.html**\n\n[file portfolio.html, 5 lines, attached below the report]\n\nOpen it in a browser.');
  assert.deepEqual(r.unattached, []);
});

test('a delivery that is a whole HTML document is one file named from its part; an untagged fence holding one is too', () => {
  const r = attachFiles([
    d('s2', 'Build one-page portfolio website', `\n  ${PAGE}\n`),
    d('s3', 'Landing page', `Done:\n\n\`\`\`\n${PAGE}\n\`\`\``),
    d('s4', 'Intro page', `Here it is.\n\n${PAGE}\n\nI kept it short.`), // after a short note, unfenced
  ]);
  assert.deepEqual(r.files.map((f) => [f.subtask_id, f.name, f.text]), [
    ['s2', 'build-one-page-portfolio-website.html', PAGE], ['s3', 'landing-page.html', PAGE], ['s4', 'intro-page.html', PAGE],
  ]);
  assert.equal(r.texts.get('s2'), '[file build-one-page-portfolio-website.html, 5 lines, attached below the report]');
  assert.equal(r.texts.get('s4'), 'Here it is.\n\n[file intro-page.html, 5 lines, attached below the report]\n\nI kept it short.');
});

test('file names: from the fence, the line before, a first-line comment, else the part title; unique across the result', () => {
  const css = 'body {\n  margin: 0;\n}';
  const r = attachFiles([
    d('s1', 'Site', [
      '### `index.html`', '```html', PAGE, '```',
      '```css styles.css', css, '```',
      '```js', '// app.js', 'const a = 1;', 'console.log(a);', '```',
      'Uses `src/helpers.js`:', '```javascript', 'export const b = 2;', '```', // one line, but named: a file
      '```json', '{"a": 1,', '"b": 2,', '"c": 3}', '```', // no name: from the title
    ].join('\n')),
    d('s2', 'Site', ['index.html', '```html', PAGE, '```', '```css', css, '```'].join('\n'), 'other-dev'),
  ]);
  assert.deepEqual(r.files.map((f) => [f.subtask_id, f.agent_handle, f.name, f.mime]), [
    ['s1', 'web-dev', 'index.html', 'text/html'], ['s1', 'web-dev', 'styles.css', 'text/css'], ['s1', 'web-dev', 'app.js', 'text/javascript'],
    ['s1', 'web-dev', 'helpers.js', 'text/javascript'], ['s1', 'web-dev', 'site.json', 'application/json'],
    ['s2', 'other-dev', 'index-2.html', 'text/html'], ['s2', 'other-dev', 'site.css', 'text/css'],
  ]);
  assert.equal(r.files[2].text, '// app.js\nconst a = 1;\nconsole.log(a);'); // the file as written
  assert.match(r.texts.get('s1')!, /\[file helpers\.js, 1 line, attached below the report\]/);
});

test('known languages only; a short unnamed snippet and prose stay in the text, as does a delivery without code', () => {
  const text = ['Install it:', '```sh', 'npm i near-api-js', '```', '```text', 'a', 'b', 'c', '```', '```constructor', 'a', 'b', 'c', '```', 'More prose.'].join('\n');
  const r = attachFiles([d('s1', 'Notes', text), d('s2', 'Copy', 'Just prose.\n\nNo code here.')]);
  assert.deepEqual(r.files, []);
  assert.equal(r.texts.get('s1'), text);
  assert.equal(r.texts.get('s2'), 'Just prose.\n\nNo code here.');
  // A one-line block is no snippet when it is a page or long: minified code is still a file.
  const mini = attachFiles([d('s1', 'Page', '```html\n<!doctype html><html><body>x</body></html>\n```\n```js\n' + 'a();'.repeat(100) + '\n```')]);
  assert.deepEqual(mini.files.map((f) => f.name), ['page.html', 'page.js']);
});

test('every listed language is attached with its mime type; a fence cut short still gives its file', () => {
  const langs = [['html', 'text/html'], ['css', 'text/css'], ['js', 'text/javascript'], ['javascript', 'text/javascript'], ['ts', 'text/typescript'],
    ['typescript', 'text/typescript'], ['json', 'application/json'], ['py', 'text/x-python'], ['python', 'text/x-python'], ['sh', 'text/x-shellscript'],
    ['bash', 'text/x-shellscript'], ['svg', 'image/svg+xml'], ['xml', 'application/xml'], ['yaml', 'application/yaml'], ['sql', 'application/sql']];
  const r = attachFiles([d('s1', 'Code', langs.map(([l]) => `\`\`\`${l}\n1\n2\n3\n\`\`\``).join('\n\n'))]);
  assert.deepEqual(r.files.map((f) => f.mime), langs.map(([, m]) => m));
  const cut = attachFiles([d('s1', 'Page', `\`\`\`html\n${PAGE.slice(0, 40)}`)]);
  assert.deepEqual(cut.files.map((f) => f.text), [PAGE.slice(0, 40)]);
});

test('a file over 1 MB, or past 3 MB in all, is not attached: its marker and the gaps say so, and its code is still out of the text', () => {
  const big = 'x'.repeat(FILE_MAX_BYTES + 1);
  const mb = 'y'.repeat(900 * 1024); // four of these pass 3 MB
  const fence = (name: string, body: string) => `${name}\n\`\`\`html\n${body}\n\`\`\``;
  const r = attachFiles([
    d('s1', 'Big', fence('big.html', big)),
    d('s2', 'Many', [1, 2, 3, 4].map((n) => fence(`p${n}.html`, mb)).join('\n\n')),
  ]);
  assert.deepEqual(r.files.map((f) => f.name), ['p1.html', 'p2.html', 'p3.html']);
  assert.deepEqual(r.unattached, [
    { name: 'big.html', title: 'Big', why: 'larger than 1 MB' }, { name: 'p4.html', title: 'Many', why: 'the files together pass 3 MB' },
  ]);
  assert.ok(r.texts.get('s1') === 'big.html\n[file big.html, 1 line, not attached: larger than 1 MB]', r.texts.get('s1')!.slice(0, 500));
  assert.ok(![...r.texts.values()].some((t) => t.includes('xxxx') || t.includes('yyyy')));
});

test('the deterministic merge shows markers, not code, and lists a file not attached under Gaps; /aggregate (canned) returns the files', async (t) => {
  const { cannedAggregate } = await import('../src/planner/canned.ts');
  const subtasks = [
    { id: 's1', title: 'Design brief', status: 'passed', agent_handle: 'taifoon-creative', deliverable_text: 'Clean type, lots of white space.' },
    { id: 's2', title: 'Build one-page portfolio website', status: 'passed', agent_handle: 'codex-engineer-01', deliverable_text: `index.html\n\`\`\`html\n${PAGE}\n\`\`\`` },
    { id: 's3', title: 'Big page', status: 'passed', agent_handle: 'dev-tools-agent', deliverable_text: `\`\`\`html\n${'z'.repeat(FILE_MAX_BYTES + 1)}\n\`\`\`` },
    { id: 's4', title: 'Copy', status: 'abandoned', agent_handle: 'quill-writer', deliverable_text: `\`\`\`html\n${PAGE}\n\`\`\`` }, // not merged: no file
  ];
  const md = cannedAggregate({ task_id: 't', prompt: 'make me a portfolio website like oynozan.com', subtasks });
  // assert.ok, not assert.match: a failure would print the 1 MB page
  assert.ok(md.includes('## Build one-page portfolio website\n\n_Source: `codex-engineer-01`._\n\nindex.html\n[file index.html, 5 lines, attached below the report]'), md.slice(0, 2000));
  assert.ok(md.includes('## Big page\n\n_Source: `dev-tools-agent`._\n\n[file big-page.html, 1 line, not attached: larger than 1 MB]'), md.slice(0, 2000));
  assert.ok(md.includes('## Gaps\n\n- Copy: not delivered\n- File big-page.html from "Big page": not attached, larger than 1 MB'), md.slice(0, 2000));
  assert.ok(!/<!doctype|zzzz/.test(md), md.slice(0, 2000));

  const { serve, call } = await import('../src/shared/http.ts');
  const gw = await serve('fake-gateway', {}, 0);
  process.env.MARKET_GATEWAY_URL = gw.url;
  const { start } = await import('../src/planner/index.ts');
  const planner = await start(0);
  t.after(async () => { await planner.close(); await gw.close(); });
  const agg = await call(`${planner.url}/aggregate`, { task_id: 't', prompt: 'portfolio', subtasks });
  assert.deepEqual(agg.files, [{ subtask_id: 's2', agent_handle: 'codex-engineer-01', name: 'index.html', mime: 'text/html', text: PAGE }]);
  assert.ok(agg.final_markdown === md.replace('make me a portfolio website like oynozan.com', 'portfolio'));
  const none = await call(`${planner.url}/aggregate`, { task_id: 't', prompt: 'p', subtasks: [subtasks[0]] });
  assert.deepEqual(none.files, []); // always present
});
