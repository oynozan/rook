// A delivery's files as a project: its tree, its zip paths, what can be previewed, how to run it, and a preview of a
// multi-page site that uses its own delivered CSS, scripts and images. Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileTree, isSvg, navRequest, navTarget, NAV_SCRIPT, previewDoc, projectOf, readmeSteps, resolveRef, zipName, zipPaths, type TreeNode } from '@/lib/project';

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

test('a page previews with its delivered stylesheet, script and images inline, and the nav script first in its head', () => {
  const doc = previewDoc(site, 'index.html')!;
  // The doctype stays first, so the page keeps standards mode; the nav script opens the head.
  assert.ok(doc.startsWith('<!DOCTYPE html>\n<html><head>' + NAV_SCRIPT + '<title>Home</title>'), doc.slice(0, 200));
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
  // A page with no head gets the script first; a page not delivered gives nothing.
  assert.equal(previewDoc(site, 'blog/index.html'), NAV_SCRIPT + '<p>Blog</p>');
  assert.equal(previewDoc(site, 'missing.html'), null);
  assert.ok(previewDoc(site, 'about.html')!.includes('<style>body {'));
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
