// The project download: a ZIP archive that unzip tools read back, folders and UTF-8 names intact.
// Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import { crc32, zip } from '@/lib/zip';

/** A reader written from the ZIP spec, apart from the writer: the central directory first, as unzip tools do. */
function unzip(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50, 'end of central directory');
  const count = v.getUint16(end + 10, true), dirSize = v.getUint32(end + 12, true), dirAt = v.getUint32(end + 16, true);
  assert.equal(dirAt + dirSize, end, 'the directory ends where the end record starts');
  const dec = new TextDecoder('utf-8', { fatal: true });
  const out: { path: string; text: string; flags: number; method: number; crc: number; time: number; date: number }[] = [];
  for (let i = 0, p = dirAt; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50, 'central header');
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true);
    const time = v.getUint16(p + 12, true), date = v.getUint16(p + 14, true), crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 20, true), nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    const localAt = v.getUint32(p + 42, true);
    const path = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // The local header says the same, and the data follows it.
    assert.equal(v.getUint32(localAt, true), 0x04034b50, 'local header');
    assert.equal(v.getUint32(localAt + 14, true), crc);
    assert.equal(v.getUint32(localAt + 18, true), size);
    const localName = v.getUint16(localAt + 26, true), localExtra = v.getUint16(localAt + 28, true);
    assert.equal(dec.decode(bytes.subarray(localAt + 30, localAt + 30 + localName)), path);
    const data = bytes.subarray(localAt + 30 + localName + localExtra, localAt + 30 + localName + localExtra + size);
    assert.equal(zlib.crc32(data), crc, `CRC of ${path}`); // Node's own CRC-32, not the writer's
    out.push({ path, text: dec.decode(data), flags, method, crc, time, date });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

test('CRC-32 matches the standard check value and Node’s own', () => {
  const enc = new TextEncoder();
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
  const text = enc.encode('<!doctype html>\n<title>Ozan Andaç</title>\n'.repeat(50));
  assert.equal(crc32(text), zlib.crc32(text));
});

test('a project zips with its folders, real names and UTF-8 text, and reads back whole', () => {
  const enc = new TextEncoder();
  const files = [
    { path: 'app/page.tsx', text: 'export default function Page() { return <h1>Tidy</h1>; }\n' },
    { path: 'app/pricing/page.tsx', text: 'export default () => null;\n' },
    { path: 'postcss.config.mjs', text: 'export default {};\n' },
    { path: '.env.example', text: 'API_KEY=\n' },
    { path: 'Ozan Andaç/README.md', text: '# Çalışma\n' },
    { path: 'empty.txt', text: '' },
  ];
  const at = new Date(2026, 10, 10, 14, 5, 30);
  const back = unzip(zip(files.map((f) => ({ path: f.path, data: enc.encode(f.text) })), at));
  assert.deepEqual(back.map((f) => [f.path, f.text]), files.map((f) => [f.path, f.text]));
  for (const f of back) {
    assert.equal(f.method, 0, 'stored');
    assert.equal(f.flags & 0x0800, 0x0800, 'UTF-8 names');
    // DOS time: 2 s steps, local time, years from 1980.
    assert.deepEqual([f.time >> 11, (f.time >> 5) & 63, (f.time & 31) * 2], [14, 5, 30]);
    assert.deepEqual([(f.date >> 9) + 1980, (f.date >> 5) & 15, f.date & 31], [2026, 11, 10]);
  }
});

test('an empty archive is the 22-byte end record alone', () => {
  assert.deepEqual([...zip([])], [0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
});
