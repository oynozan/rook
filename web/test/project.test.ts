// A delivery's files as a project: its tree, its zip paths, what can be previewed, how to run it, and a preview of a
// multi-page site that uses its own delivered CSS, scripts and images. Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changedFiles, fileTree, frameLoad, isSvg, navRequest, navScript, navTarget, PREVIEW_CSP, previewDoc, previewHead, previewNonce, previewReady, projectOf, readmeSteps, resolveRef, zipName, zipPaths, type TreeNode,
} from '@/lib/project';
import appConfig from '../next.config';

const f = (name: string, text = '', mime = 'text/plain') => ({ name, mime, text });
const shape = (nodes: TreeNode[]): unknown[] => nodes.map((n) => (n.kind === 'folder' ? { [n.name + '/']: shape(n.children) } : n.name));

test('files show as a folder tree: folders first, then files in the order delivered', () => {
  const tree = fileTree(['package.json', 'app/page.tsx', 'README.md', 'app/pricing/page.tsx', 'components/Hero.tsx', 'app/layout.tsx']);
  assert.deepEqual(shape(tree), [
    { 'app/': [{ 'pricing/': ['page.tsx'] }, 'page.tsx', 'layout.tsx'] },
    { 'components/': ['Hero.tsx'] },
    'package.json', 'README.md',
  ]);
  // Each file keeps its full path and its place in the list, for its row's buttons.
  const app = tree[0] as Extract<TreeNode, { kind: 'folder' }>;
  assert.deepEqual(app.children[1], { kind: 'file', name: 'page.tsx', path: 'app/page.tsx', index: 1 });
  assert.equal((app.children[0] as Extract<TreeNode, { kind: 'folder' }>).path, 'app/pricing');
  // A flat site is a flat list; a stray "./" or "../" adds no folder.
  assert.deepEqual(shape(fileTree(['index.html', './about.html', '../style.css'])), ['index.html', 'about.html', 'style.css']);
});

test('the zip keeps folders, real names and dotfiles, never a path above the project, and never two files at one path', () => {
  assert.deepEqual(zipPaths(['app/pricing/page.tsx', 'postcss.config.mjs', '.env.example', '../../etc/passwd', '/abs/x.js', 'C:\\x\\a<b>.html', 'App/Page.tsx', 'app/page.tsx', 'app/page.tsx']),
    ['app/pricing/page.tsx', 'postcss.config.mjs', '.env.example', 'etc/passwd', 'abs/x.js', 'C_/x/a_b_.html', 'App/Page.tsx', 'app/page-2.tsx', 'app/page-3.tsx']);
  assert.deepEqual(zipPaths(['...', 'Makefile', 'Makefile']), ['file.txt', 'Makefile', 'Makefile-2']);
  assert.equal(zipName('Make me a portfolio website, Ozan Andaç!'), 'make-me-a-portfolio-website-ozan-andac.zip');
  assert.equal(zipName('∑∑∑'), 'project.zip');
  assert.equal(zipName(undefined), 'project.zip');
});

test('a Node project says what it is and how to run it: from its README first, else from its scripts', () => {
  const pkg = (o: object) => f('package.json', JSON.stringify(o));
  // Static files are no project: they preview here.
  assert.equal(projectOf([f('index.html'), f('style.css')]), null);
  const next = projectOf([pkg({ scripts: { dev: 'next dev', build: 'next build' }, dependencies: { next: '16', react: '19' } }), f('app/page.tsx')]);
  assert.deepEqual(next, { kind: 'next', words: 'a Next.js app', steps: { from: 'scripts', commands: ['npm install', 'npm run dev'] } });
  // An Express server with only a start script, a pnpm lockfile, in a folder of its own.
  assert.deepEqual(projectOf([f('api/package.json', JSON.stringify({ scripts: { start: 'node server.js' }, dependencies: { express: '5' } })), f('api/pnpm-lock.yaml')]),
    { kind: 'express', words: 'an Express server', steps: { from: 'scripts', commands: ['cd api', 'pnpm install', 'pnpm start'] } });
  assert.deepEqual(projectOf([pkg({ scripts: { build: 'tsc', start: 'node dist' } })])?.steps, { from: 'scripts', commands: ['npm install', 'npm run build', 'npm start'] });
  // A Next.js config alone is enough, and a broken package.json still marks a project; nothing says how to run it.
  assert.deepEqual(projectOf([f('next.config.mjs', 'export default {}')]), { kind: 'next', words: 'a Next.js app', steps: null });
  assert.deepEqual(projectOf([f('package.json', '{oops')]), { kind: 'node', words: 'a Node.js project', steps: null });
  // The README's run section wins, kept as written with its commands.
  const readme = '# Tidy\n\nA landing page.\n\n## Getting started\n\n```bash\nnpm install\nnpm run dev\n```\n\nOpen http://localhost:3000.\n\n## Deploy\n\nPush to Vercel.';
  assert.deepEqual(projectOf([pkg({ dependencies: { next: '16' } }), f('README.md', readme)])?.steps,
    { from: 'readme', markdown: '```bash\nnpm install\nnpm run dev\n```\n\nOpen http://localhost:3000.' });
  // A heading inside a code block is no heading; a README with no run section gives none.
  assert.equal(readmeSteps('# App\n```\n# Run\nnpm start\n```\nMore.'), null);
  assert.equal(readmeSteps('## Install\n### From source\nmake\n## Licence\nMIT'), '### From source\nmake');
});

test("a README's run sections one after another are one set of steps, and steps that never start the project give way to its scripts", () => {
  // QA: the Express API's README has "## Install" (npm install) then "## Start" (npm start); only npm install showed.
  const readme = '# Todos API\n\n## Requirements\n\n- Node.js 18\n\n## Install\n\n```bash\nnpm install\n```\n\n## Start\n\n```bash\nnpm start\n```\n\nThe server listens on port 3000.\n\n## Endpoints\n\n| GET | /todos |';
  assert.equal(readmeSteps(readme), '```bash\nnpm install\n```\n\nStart:\n\n```bash\nnpm start\n```\n\nThe server listens on port 3000.');
  const pkg = f('package.json', JSON.stringify({ scripts: { start: 'node server.js' }, dependencies: { express: '5' } }));
  assert.deepEqual(projectOf([pkg, f('README.md', readme)])?.steps, { from: 'readme', markdown: readmeSteps(readme) });
  // A README that only installs: the package.json scripts say how to start it.
  const installOnly = '# API\n\n## Install\n\n```bash\nnpm install\n```\n\n## Endpoints\n\nGET /todos';
  assert.deepEqual(projectOf([pkg, f('README.md', installOnly)])?.steps, { from: 'scripts', commands: ['npm install', 'npm start'] });
  // With no scripts to start it either, the README's steps are still all there is.
  assert.deepEqual(projectOf([f('package.json', '{}'), f('README.md', installOnly)])?.steps, { from: 'readme', markdown: '```bash\nnpm install\n```' });
});

test("the files a message changed are marked; a first build's are not, every one being new", () => {
  const names = ['index.html', 'about.html', 'css/style.css', 'blog.html'];
  // QA: after an edit every file looked the same, so the user couldn't see which of 5 files it touched.
  assert.deepEqual(changedFiles(names, ['index.html', 'blog.html'], true), { marked: new Set(['index.html', 'blog.html']), line: 'This message changed or added 2 files, marked “Changed”; the other 2 are as they were.' });
  assert.deepEqual(changedFiles(names, ['css/style.css'], false), { marked: new Set(['css/style.css']), line: 'This message changed or added one file, marked “Changed”; the other 3 are as they were.' });
  assert.deepEqual(changedFiles(['index.html', 'a.css'], ['index.html'], true).line, 'This message changed or added one file, marked “Changed”; the other file is as it was.');
  // An edit of the chat's only file still says it changed it; an edit that changed nothing says that.
  assert.deepEqual(changedFiles(['index.html'], ['index.html'], true), { marked: new Set(['index.html']), line: 'This message changed or added one file, marked “Changed”.' });
  assert.deepEqual(changedFiles(names, [], true), { marked: new Set(), line: "This message didn't change any of these files." });
  // A first build (every file new), or an older report that doesn't say: nothing marked.
  assert.deepEqual(changedFiles(names, names, false), { marked: new Set(), line: null });
  assert.deepEqual(changedFiles(names, undefined, true), { marked: new Set(), line: null });
});

test('an SVG is an image to show, never a page', () => {
  assert.ok(isSvg(f('logo.svg')));
  assert.ok(isSvg(f('mark', '', 'image/svg+xml')));
  assert.ok(!isSvg(f('index.html', '', 'text/html')));
});

test('references in a page resolve from its folder; links elsewhere resolve to nothing', () => {
  assert.equal(resolveRef('site/index.html', 'css/style.css'), 'site/css/style.css');
  assert.equal(resolveRef('site/blog/post.html', '../img/a.svg?v=2#x'), 'site/img/a.svg');
  assert.equal(resolveRef('site/index.html', './about%20us.html'), 'site/about us.html');
  assert.equal(resolveRef('site/index.html', '/about.html'), 'about.html');
  for (const ref of ['https://x.com/a.css', '//cdn.x.com/a.js', 'mailto:me@x.com', 'data:image/png;base64,AA', '#team', '', 'tel:+1']) {
    assert.equal(resolveRef('index.html', ref), null, ref);
  }
});

const N = '0123456789abcdef0123456789abcdef';
const HEAD = previewHead(N);

const site = [
  f('index.html', '<!DOCTYPE html>\n<html><head><title>Home</title><link rel="stylesheet" href="css/style.css"><script src="js/app.js" defer></script></head>'
    + '<body><img src="img/logo.svg" alt="logo"><a href="about.html">About</a><a href="https://elsewhere.com">x</a><script src="https://cdn.example/lib.js"></script></body></html>', 'text/html'),
  f('about.html', '<html><head><link rel=stylesheet href="./css/style.css"></head><body><a href="index.html#top">Home</a></body></html>', 'text/html'),
  f('css/style.css', 'body { background: url("../img/bg.svg"); }\n/* </style><script>alert(1)</script> */'),
  f('js/app.js', 'document.querySelector("a").dataset.ok = "</script>";'),
  f('img/logo.svg', `<svg xmlns="http://www.w3.org/2000/svg"><text>it's</text></svg>`),
  f('img/bg.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
  f('blog/index.html', '<p>Blog</p>', 'text/html'),
];

test('a page previews with its delivered stylesheet, script and images inline, and its policy and the nav script first', () => {
  const doc = previewDoc(site, 'index.html', N)!;
  // The doctype stays first, so the page keeps standards mode; the policy, then the nav script, come before the page.
  assert.ok(HEAD.startsWith(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`) && HEAD.endsWith(navScript(N)));
  assert.ok(doc.startsWith('<!DOCTYPE html>' + HEAD + '\n<html><head><title>Home</title>'), doc.slice(0, 200));
  // The stylesheet is inline, its url() to a delivered SVG too, and text that would close the style can't.
  assert.match(doc, /<style>body \{ background: url\("data:image\/svg\+xml;charset=utf-8,%3Csvg[^"]*"\); \}/);
  assert.ok(!doc.includes('</style><script>alert(1)'), 'the CSS cannot close its style element');
  assert.ok(!doc.includes('href="css/style.css"'));
  // The deferred script runs where a deferred one would, at the end of the body, and can't close its script element.
  assert.match(doc, /<\/script><\/body><\/html>$/);
  assert.ok(doc.includes('<script>document.querySelector("a").dataset.ok = "<\\/script>";</script></body>'));
  assert.ok(!/<script[^>]*src="js\/app\.js"/.test(doc));
  // The image is the delivered SVG, its quote escaped for the attribute; scripts from other sites are left as they were.
  assert.match(doc, /<img src="data:image\/svg\+xml;charset=utf-8,[^"']*%27s[^"']*" alt="logo">/);
  assert.ok(doc.includes('<script src="https://cdn.example/lib.js"></script>'));
  // A page with no head gets them first; a page not delivered gives nothing.
  assert.equal(previewDoc(site, 'blog/index.html', N), HEAD + '<p>Blog</p>');
  assert.equal(previewDoc(site, 'missing.html', N), null);
  assert.ok(previewDoc(site, 'about.html', N)!.includes('<style>body {'));
});

test('links between delivered pages switch the preview; anything else stays put', () => {
  assert.equal(navTarget(site, 'index.html', 'about.html'), 'about.html');
  assert.equal(navTarget(site, 'about.html', 'index.html#top'), 'index.html');
  assert.equal(navTarget(site, 'about.html', '/'), 'index.html');
  assert.equal(navTarget(site, 'index.html', 'blog/'), 'blog/index.html');
  assert.equal(navTarget(site, 'index.html', 'blog'), 'blog/index.html');
  assert.equal(navTarget(site, 'index.html', 'about'), 'about.html');
  assert.equal(navTarget(site, 'blog/index.html', '../about.html'), 'about.html');
  for (const href of ['https://elsewhere.com', 'css/style.css', 'contact.html', '#top', '?page=2', 'javascript:alert(1)']) {
    assert.equal(navTarget(site, 'index.html', href), null, href);
  }
  // Root links from a site in a folder look in that folder too.
  const nested = [f('public/index.html', '', 'text/html'), f('public/about.html', '', 'text/html')];
  assert.equal(navTarget(nested, 'public/index.html', '/about.html'), 'public/about.html');
  // Only the nav message's own shape is accepted.
  assert.equal(navRequest({ type: 'rook-preview-nav', path: 'about.html' }), 'about.html');
  for (const bad of [null, 'about.html', { type: 'other', path: 'x' }, { type: 'rook-preview-nav', path: 3 }, { type: 'rook-preview-nav', path: 'x'.repeat(2001) }]) {
    assert.equal(navRequest(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
});

// Just enough of Content Security Policy for these checks: directives with their sources, a fetch directive falling back
// to default-src, scheme sources ("https:", "data:"), 'none', 'self' (the app's origin) and keywords.
type Policy = Map<string, string[]>;
const parse = (csp: string): Policy => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...sources]) => [name.toLowerCase(), sources]));
const FETCH = new Set(['script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'frame-src', 'media-src', 'object-src', 'worker-src']);
const APP = 'https://rook.example';
function allows(policy: Policy, directive: string, source: string): boolean {
  const list = policy.get(directive) ?? (FETCH.has(directive) ? policy.get('default-src') : undefined);
  if (!list) return true;
  if (source.startsWith("'")) return list.includes(source);
  const url = new URL(source);
  return list.some((s) => s === url.protocol || s === url.origin || (s === "'self'" && url.origin === APP));
}

test("the preview's own policy keeps what a page needs and blocks what the app's policy lets through", async () => {
  // A srcdoc frame inherits the app's policy (next.config.ts) and adds the one in the page: a load must pass both.
  const rules = await appConfig.headers!();
  const app = parse(rules.flatMap((r) => r.headers).find((h) => h.key === 'Content-Security-Policy')!.value);
  const preview = parse(PREVIEW_CSP);
  const both = (d: string, s: string) => allows(app, d, s) && allows(preview, d, s);
  // What a delivered page needs still works under both: its own inline scripts and styles, the SVGs put inline,
  // images and fonts from other sites (the page's note says those still load).
  for (const [d, s] of [['script-src', "'unsafe-inline'"], ['style-src', "'unsafe-inline'"], ['img-src', 'data:x'], ['img-src', 'https://images.example/a.png'], ['font-src', 'https://fonts.example/a.woff2']]) {
    assert.ok(both(d, s), `${d} ${s}`);
  }
  // QA's attack page: a no-cors POST, fetch then eval of a remote script, and an outside page in a frame. The app's
  // policy lets each through (the wallet connector needs it loose); the preview's own blocks it.
  for (const [d, s] of [['connect-src', 'https://evil.example/exfil'], ['script-src', "'unsafe-eval'"], ['frame-src', 'https://evil.example/phish']]) {
    assert.ok(allows(app, d, s), `the app's policy allows ${d} ${s}`);
    assert.ok(!both(d, s), `the preview blocks ${d} ${s}`);
  }
  // Nor does any script, stylesheet, form post, worker, plugin or <base> from elsewhere get through (the note says so).
  for (const [d, s] of [['script-src', 'https://cdn.example/lib.js'], ['style-src', 'https://fonts.example/css'], ['form-action', 'https://evil.example/'],
    ['worker-src', 'https://evil.example/w.js'], ['object-src', 'https://evil.example/x.swf'], ['base-uri', 'https://evil.example/'], ['media-src', 'https://evil.example/a.mp4']]) {
    assert.ok(!both(d, s), `${d} ${s}`);
  }
  // A policy in a <meta> can't carry these: one there would be ignored, so none is.
  for (const d of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) assert.ok(!preview.has(d), d);
});

test('the policy comes before anything of the page can run, and the page cannot send its frame elsewhere by a meta refresh', () => {
  const page = (text: string) => previewDoc([f('index.html', text, 'text/html')], 'index.html', N)!;
  // A script ahead of the page's <head> tag would run before a policy put in the head.
  assert.equal(page('<!doctype html><script>fetch("https://evil.example")</script><html><head></head></html>'),
    '<!doctype html>' + HEAD + '<script>fetch("https://evil.example")</script><html><head></head></html>');
  // Only a doctype, after whitespace or comments, stays ahead; anything else before it comes after the policy.
  assert.ok(page('\n<!-- made by an agent -->\n<!DOCTYPE html><p>x</p>').startsWith('\n<!-- made by an agent -->\n<!DOCTYPE html>' + HEAD));
  assert.ok(page('<script>1</script><!doctype html>').startsWith(HEAD + '<script>1</script>'));
  assert.equal(page('<html><head><meta http-equiv="refresh" content="0;url=https://evil.example/phish"><META HTTP-EQUIV=Refresh CONTENT=1></head></html>'),
    HEAD + '<html><head></head></html>');
});

test("a load of the preview frame is its page only with that page's word, and only once", () => {
  const none = { nonce: '', loads: 0 };
  // The page said it loaded: shown. A second load of it is the frame gone elsewhere (a script set location).
  const first = frameLoad(none, 'a', true);
  assert.deepEqual(first, { seen: { nonce: 'a', loads: 1 }, verdict: 'shown' });
  assert.equal(frameLoad(first.seen, 'a', true).verdict, 'left');
  // QA's page went to its phishing page before its own load: the first load the holder sees has no word from it. It
  // waits a moment for the word (it may come after the load event), and puts the frame back if none comes.
  assert.equal(frameLoad(none, 'a', false).verdict, 'wait');
  // A link to another delivered page gives the frame a new page, with a new nonce: its first load is a first again.
  assert.deepEqual(frameLoad(first.seen, 'b', true), { seen: { nonce: 'b', loads: 1 }, verdict: 'shown' });
  // The word counts only with this preview's nonce, so another page (or another preview) can't give it.
  assert.equal(previewReady({ type: 'rook-preview-ready', nonce: 'a' }, 'a'), true);
  for (const bad of [{ type: 'rook-preview-ready', nonce: 'b' }, { type: 'rook-preview-ready' }, { type: 'rook-preview-nav', nonce: 'a' }, null, 'a']) {
    assert.equal(previewReady(bad, 'a'), false, JSON.stringify(bad));
  }
  assert.equal(previewReady({ type: 'rook-preview-ready', nonce: '' }, ''), false);
  // Fresh and unguessable each time; the script keeps it to itself (it removes itself before the page's scripts run) and
  // says it only on the page's own trusted load event, once.
  const n = previewNonce();
  assert.match(n, /^[0-9a-f]{32}$/);
  assert.notEqual(previewNonce(), n);
  const script = navScript(n);
  assert.ok(script.includes(`N='${n}'`) && script.includes('removeChild(me)') && /if\(done\|\|!e\.isTrusted\|\|e\.target!==D\)return;done=true;/.test(script), script);
  assert.ok(navScript("x'</script><script>alert(1)").includes("N='xscriptscriptalert1'"), 'a nonce is letters and digits only');
});
