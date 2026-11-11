// The report as the page shows it: fenced code kept whole, and the files agents delivered named and counted for a
// download. Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blobType, downloadName, isHtml, lineCount, reportBlocks } from '@/lib/report';

test('fenced code blocks stay whole, as written; the lines around them stay lines', () => {
  const md = '# Site\n\nHere it is:\n```html\n<!doctype html>\n  <p>Hi</p>\n```\nDone.';
  assert.deepEqual(reportBlocks(md), [
    { kind: 'line', text: '# Site' }, { kind: 'line', text: '' }, { kind: 'line', text: 'Here it is:' },
    { kind: 'code', lang: 'html', text: '<!doctype html>\n  <p>Hi</p>' },
    { kind: 'line', text: 'Done.' },
  ]);
  // Tildes, a longer fence that a shorter one inside doesn't close, CRLF line ends.
  assert.deepEqual(reportBlocks('~~~\na\n~~~'), [{ kind: 'code', lang: '', text: 'a' }]);
  assert.deepEqual(reportBlocks('````md\n```js\nx\n```\n````'), [{ kind: 'code', lang: 'md', text: '```js\nx\n```' }]);
  assert.deepEqual(reportBlocks('```\r\nx\r\n```\r\ny'), [{ kind: 'code', lang: '', text: 'x' }, { kind: 'line', text: 'y' }]);
  // Never closed: it runs to the end.
  assert.deepEqual(reportBlocks('a\n```css\nbody {}'), [{ kind: 'line', text: 'a' }, { kind: 'code', lang: 'css', text: 'body {}' }]);
  // Inline code is not a fence.
  assert.deepEqual(reportBlocks('use `x` here'), [{ kind: 'line', text: 'use `x` here' }]);
});

test('a delivered file: its lines counted, a name a download can use, a Blob type, and whether it can be previewed', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('one'), 1);
  assert.equal(lineCount('one\ntwo\n'), 2);
  assert.equal(lineCount('one\r\ntwo\r\nthree'), 3);
  assert.equal(downloadName('index.html'), 'index.html');
  assert.equal(downloadName('../../etc/passwd'), 'passwd');
  assert.equal(downloadName('C:\\x\\a<b>.html'), 'a_b_.html');
  assert.equal(downloadName('...'), 'file.txt');
  assert.equal(blobType('text/html'), 'text/html;charset=utf-8');
  assert.equal(blobType('Text/CSS; charset=latin1'), 'text/css;charset=utf-8');
  assert.equal(blobType('not a type'), 'text/plain;charset=utf-8');
  assert.equal(isHtml({ name: 'index.html', mime: 'text/plain' }), true);
  assert.equal(isHtml({ name: 'site', mime: 'text/html; charset=utf-8' }), true);
  assert.equal(isHtml({ name: 'style.css', mime: 'text/css' }), false);
});

test("the services' file marker reads as plain words; Rook's own work is from Rook", async () => {
  const { fileMarker, madeBy } = await import('@/lib/report');
  assert.equal(fileMarker('[file index.html, 407 lines, attached below the report]'), 'index.html (407 lines) is under Files below.');
  assert.equal(fileMarker('[file big.js, 1 line, not attached: larger than 1 MB]'), "big.js (1 line) wasn't attached: larger than 1 MB.");
  assert.equal(fileMarker('See [file index.html, 4 lines, attached below the report]'), null); // only a line of its own
  assert.equal(fileMarker('A paragraph.'), null);
  assert.deepEqual([madeBy('rook:self-do'), madeBy('quill-writer')], ['Rook', 'quill-writer']);
});

test('a file marker inside a line reads as plain words, and a dotfile keeps its name for a download', async () => {
  const { inlineMarkers } = await import('@/lib/report');
  // The words just before already name the file: only the count follows (QA: "The file is index.html index.html (160 lines)").
  assert.equal(inlineMarkers('- **next.config.mjs** [file next.config.mjs, 6 lines, attached below the report]'), '- **next.config.mjs** (6 lines, under Files)');
  assert.equal(inlineMarkers('The file is index.html [file index.html, 160 lines, attached below the report], the complete portfolio page.'),
    'The file is index.html (160 lines, under Files), the complete portfolio page.');
  assert.equal(inlineMarkers('The file `index.html` [file index.html, 160 lines, attached below the report] is the full page.'), 'The file `index.html` (160 lines, under Files) is the full page.');
  assert.equal(inlineMarkers('Styles: style.css [file css/style.css, 9 lines, attached below the report]'), 'Styles: style.css (9 lines, under Files)');
  // Otherwise the name stays: nothing before, another word, or a name that only ends the same way.
  assert.equal(inlineMarkers('See [file a.js, 1 line, not attached: too big] and [file b.css, 2 lines, attached below the report].'),
    'See a.js (1 line, not attached: too big) and b.css (2 lines, under Files).');
  assert.equal(inlineMarkers('myindex.html [file index.html, 9 lines, attached below the report]'), 'myindex.html index.html (9 lines, under Files)');
  assert.equal(inlineMarkers('[file] is a word'), '[file] is a word');
  assert.equal(downloadName('.env.example'), '.env.example');
  assert.equal(downloadName('app/.gitignore'), '.gitignore');
});

test('the report renders tables, rules, numbered lists, quotes and headings, not raw marks', async () => {
  const { markdownBlocks } = await import('@/lib/report');
  const md = [
    '## Routes', '', '| Method | Path | Does |', '|---|:---:|---:|', '| GET | `/todos` | lists them |', '| POST | /todos | adds one \\| two |', '| DELETE |', '',
    'Not | a table', '---', '1. Install', '2) Run', '> Quoted', '  - nested', '* star', '***',
    '[file index.html, 4 lines, attached below the report]', '```sh', 'npm start', '```',
  ].join('\n');
  assert.deepEqual(markdownBlocks(md), [
    { kind: 'heading', level: 2, text: 'Routes' },
    { kind: 'table', head: ['Method', 'Path', 'Does'], rows: [['GET', '`/todos`', 'lists them'], ['POST', '/todos', 'adds one | two'], ['DELETE', '', '']] },
    { kind: 'para', text: 'Not | a table' }, // a rule of one cell under two is no table
    { kind: 'rule' },
    { kind: 'number', n: '1', text: 'Install' }, { kind: 'number', n: '2', text: 'Run' },
    { kind: 'quote', text: 'Quoted' },
    { kind: 'bullet', depth: 1, text: 'nested' }, { kind: 'bullet', depth: 0, text: 'star' },
    { kind: 'rule' },
    { kind: 'note', text: 'index.html (4 lines) is under Files below.' },
    { kind: 'code', lang: 'sh', text: 'npm start' },
  ]);
});

test('inline Markdown splits into plain parts; only an http(s) link stays a link', async () => {
  const { inlineParts } = await import('@/lib/report');
  assert.deepEqual(inlineParts('As of **9 November 2026**, `NEAR` is *up*, per [CoinGecko](https://coingecko.com/x) and [this](javascript:alert(1)).'), [
    { kind: 'text', text: 'As of ' }, { kind: 'strong', text: '9 November 2026' }, { kind: 'text', text: ', ' }, { kind: 'code', text: 'NEAR' },
    { kind: 'text', text: ' is ' }, { kind: 'em', text: 'up' }, { kind: 'text', text: ', per ' },
    { kind: 'link', text: 'CoinGecko', href: 'https://coingecko.com/x' }, { kind: 'text', text: ' and ' }, { kind: 'text', text: 'this' },
    { kind: 'text', text: ').' },
  ]);
  // A star in arithmetic or a snake_case name is no emphasis.
  assert.deepEqual(inlineParts('2 * 3 * 4 and my_var_name'), [{ kind: 'text', text: '2 * 3 * 4 and my_var_name' }]);
  assert.deepEqual(inlineParts('see [file a.js, 3 lines, attached below the report]'), [{ kind: 'text', text: 'see a.js (3 lines, under Files)' }]);
});

test('a bare web address in a report is a link; what ends the sentence after it is not part of it', async () => {
  const { inlineParts } = await import('@/lib/report');
  // QA: the "- Title: https://..." source lines Rook's writer lists were plain text.
  assert.deepEqual(inlineParts('- CoinGecko: https://www.coingecko.com/en/coins/near. Also (https://en.wikipedia.org/wiki/Near_(protocol)) and https://x.io/a_b_c, done'), [
    { kind: 'text', text: '- CoinGecko: ' }, { kind: 'link', text: 'https://www.coingecko.com/en/coins/near', href: 'https://www.coingecko.com/en/coins/near' },
    { kind: 'text', text: '. Also (' }, { kind: 'link', text: 'https://en.wikipedia.org/wiki/Near_(protocol)', href: 'https://en.wikipedia.org/wiki/Near_(protocol)' },
    { kind: 'text', text: ') and ' }, { kind: 'link', text: 'https://x.io/a_b_c', href: 'https://x.io/a_b_c' }, { kind: 'text', text: ', done' },
  ]);
  // Only http(s); code stays code; a [link](url) stays one link; no address, no link.
  assert.deepEqual(inlineParts('javascript:alert(1) `https://code.example` [docs](https://a.com/x) http://.'), [
    { kind: 'text', text: 'javascript:alert(1) ' }, { kind: 'code', text: 'https://code.example' }, { kind: 'text', text: ' ' },
    { kind: 'link', text: 'docs', href: 'https://a.com/x' }, { kind: 'text', text: ' ' }, { kind: 'text', text: 'http://.' },
  ]);
});

test("a part's preview is plain words: no marks, rules or pipes", async () => {
  const { plainText } = await import('@/lib/report');
  const { preview } = await import('@/lib/run-view');
  assert.equal(plainText('As of **9 November 2026** the [price](https://x.io) is `1.2`.\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |'), 'As of 9 November 2026 the price is 1.2. A · B; 1 · 2');
  assert.equal(preview('# Report\n\n- **One** thing\n1. Two\n> three\n***'), 'Report One thing 1. Two three');
});
