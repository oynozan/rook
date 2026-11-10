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
