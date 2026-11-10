// A ZIP archive of a delivery's files, so a project downloads whole, with its folders. Pure, so the tests read it back.
// Run: npx tsx --test test/*.test.ts (from web/)
// ponytail: STORE only (no compression) and no ZIP64, so at most 65,535 files and 4 GB: delivered text is far smaller,
// and a writer with no deflate stays a few dozen lines.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, the one ZIP uses) of `data`. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date, in the local time zone as unzip tools read them; before 1980 it is 1980. */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getFullYear());
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

export type ZipEntry = { path: string; data: Uint8Array };

const UTF8_NAMES = 0x0800; // general purpose flag bit 11: names are UTF-8, so "Ozan Andaç/index.html" survives
const VERSION = 20; // 2.0: the least a STORE archive with folders needs

/** A ZIP archive of `entries`, stored as they are, each named by its path ("app/page.tsx"). */
export function zip(entries: ZipEntry[], at = new Date()): Uint8Array<ArrayBuffer> {
  if (entries.length > 0xffff) throw new Error(`a zip holds at most 65535 files without ZIP64, not ${entries.length}`);
  const enc = new TextEncoder();
  const { time, date } = dosTime(at);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.data), size = e.data.length;
    if (offset + 30 + name.length + size > 0xffffffff) throw new Error('a zip holds at most 4 GB without ZIP64');

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); // local file header
    l.setUint16(4, VERSION, true);
    l.setUint16(6, UTF8_NAMES, true);
    l.setUint16(8, 0, true); // method 0: stored
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, size, true); // compressed size: the same, stored
    l.setUint32(22, size, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true); // no extra field
    local.set(name, 30);

    const dir = new Uint8Array(46 + name.length);
    const d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true); // central directory header
    d.setUint16(4, VERSION, true); // made by: MS-DOS attributes, so no Unix modes are claimed
    d.setUint16(6, VERSION, true);
    d.setUint16(8, UTF8_NAMES, true);
    d.setUint16(10, 0, true);
    d.setUint16(12, time, true);
    d.setUint16(14, date, true);
    d.setUint32(16, crc, true);
    d.setUint32(20, size, true);
    d.setUint32(24, size, true);
    d.setUint16(28, name.length, true);
    // extra and comment lengths, disk number, internal and external attributes: all 0
    d.setUint32(42, offset, true);
    dir.set(name, 46);

    parts.push(local, e.data);
    central.push(dir);
    offset += local.length + size;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true); // end of central directory
  v.setUint16(8, entries.length, true); // entries on this disk
  v.setUint16(10, entries.length, true); // entries in all
  v.setUint32(12, dirSize, true);
  v.setUint32(16, offset, true);

  const out = new Uint8Array(offset + dirSize + end.length);
  let pos = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, pos); pos += p.length; }
  return out;
}
