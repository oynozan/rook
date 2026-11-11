// The media criterion (docs/agentic-system.md 7): an image, video or audio the delivery gives is checked as media,
// not by the reply's prose. A logo plan could never pass its files check on logo.png, a real video failed text checks
// written for its covering note, and a stills manifest that echoed the brief passed them.
import type { EvaluateRequest } from '../shared/types.ts';
import { Refused, shown } from '../planner/reference.ts';
import { load, textOf } from './fetch.ts';

export type MediaKind = 'image' | 'video' | 'audio';
/** One piece of media the delivery gives: a link, or bytes sent in the reply (`name`), and what it is or why not. */
export type Media = { from: string; name?: string; kind?: MediaKind; format?: string; bytes?: number; width?: number; height?: number; why?: string };

const MEDIA_HEAD = 64 * 1024; // bytes read of a media link: enough for its format and size, never the whole video
const MAX_LINKS = 10; // media links opened per delivery
const MIN_BYTES = 100; // an empty or broken file
const MIN_PIXELS = 16; // a tracking pixel is no logo

// A file name's media kind, and the formats each extension is ("logo.png" is an image, a PNG).
const EXT: Record<string, [MediaKind, string]> = {
  png: ['image', 'PNG'], jpg: ['image', 'JPEG'], jpeg: ['image', 'JPEG'], gif: ['image', 'GIF'], webp: ['image', 'WebP'], avif: ['image', 'AVIF'],
  heic: ['image', 'HEIC'], heif: ['image', 'HEIC'], ico: ['image', 'ICO'], svg: ['image', 'SVG'], bmp: ['image', 'BMP'], tif: ['image', 'TIFF'], tiff: ['image', 'TIFF'],
  mp4: ['video', 'MP4'], m4v: ['video', 'MP4'], mov: ['video', 'MOV'], webm: ['video', 'WebM'], mkv: ['video', 'WebM'], avi: ['video', 'AVI'], ogv: ['video', 'OGG'],
  mp3: ['audio', 'MP3'], wav: ['audio', 'WAV'], ogg: ['audio', 'OGG'], oga: ['audio', 'OGG'], opus: ['audio', 'OGG'], m4a: ['audio', 'M4A'], flac: ['audio', 'FLAC'], aac: ['audio', 'AAC'],
};
const extOf = (p: string) => /\.([a-z0-9]{2,5})$/i.exec(p.split(/[?#]/)[0])?.[1].toLowerCase() ?? '';
/** The media kind and format a path names by its extension ("brand/logo.png": image, PNG), if it names one. */
export const mediaOfPath = (p: string): [MediaKind, string] | undefined => EXT[extOf(p)];

/** A format by its first bytes; SVG by its first tag. */
export function sniff(b: Buffer): { kind: MediaKind; format: string } | null {
  const at = (i: number, s: string) => b.length >= i + s.length && b.subarray(i, i + s.length).toString('latin1') === s;
  if (at(0, '\x89PNG\r\n\x1a\n')) return { kind: 'image', format: 'PNG' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', format: 'JPEG' };
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { kind: 'image', format: 'GIF' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { kind: 'image', format: 'WebP' };
  if (at(0, 'RIFF') && at(8, 'WAVE')) return { kind: 'audio', format: 'WAV' };
  if (at(0, 'RIFF') && at(8, 'AVI ')) return { kind: 'video', format: 'AVI' };
  if (at(0, '\x00\x00\x01\x00')) return { kind: 'image', format: 'ICO' };
  if (at(0, 'II*\x00') || at(0, 'MM\x00*')) return { kind: 'image', format: 'TIFF' };
  if (at(4, 'ftyp')) {
    const brand = b.subarray(8, 12).toString('latin1');
    if (/^avi[fs]/.test(brand)) return { kind: 'image', format: 'AVIF' };
    if (/^(?:hei[cx]|mif1|msf1|hevc)/.test(brand)) return { kind: 'image', format: 'HEIC' };
    if (/^M4[AB] /.test(brand)) return { kind: 'audio', format: 'M4A' };
    return { kind: 'video', format: brand === 'qt  ' ? 'MOV' : 'MP4' };
  }
  if (at(0, '\x1a\x45\xdf\xa3')) return { kind: 'video', format: 'WebM' };
  if (at(0, 'OggS')) return { kind: 'audio', format: 'OGG' };
  if (at(0, 'fLaC')) return { kind: 'audio', format: 'FLAC' };
  if (at(0, 'ID3') || (b[0] === 0xff && b.length > 1 && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', format: b[1] === 0xf1 || b[1] === 0xf9 ? 'AAC' : 'MP3' };
  const head = b.subarray(0, 2048).toString('utf8').replace(/^\ufeff?(?:\s+|<\?xml[^>]*>|<!--[\s\S]*?-->|<!doctype[^>]*>)*/i, '');
  if (/^<svg[\s>/]/i.test(head)) return { kind: 'image', format: 'SVG' };
  return null;
}

/** Width and height of a PNG, GIF, JPEG or WebP from its first bytes, when they say. */
export function dimensions(b: Buffer, format: string): { width: number; height: number } | null {
  try {
    if (format === 'PNG' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (format === 'GIF' && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (format === 'WebP' && b.length >= 30) {
      const chunk = b.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    }
    if (format === 'JPEG') {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* cut short: no size */ }
  return null;
}

/** An item checked by its bytes: its format and size, or why it is no media. */
function judgeBytes(item: Media, b: Buffer, total: number | null, declared?: string): Media {
  const s = sniff(b);
  const typeKind = /^(image|video|audio)\//.exec(declared ?? '')?.[1] as MediaKind | undefined;
  if (!s && /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(b.subarray(0, 512).toString('utf8'))) return { ...item, why: 'it is a web page, not media' };
  const kind = s?.kind ?? typeKind, format = s?.format ?? (typeKind ? declared!.split('/')[1].toUpperCase() : undefined);
  if (!kind) return { ...item, why: `it is not an image, video or audio file${declared ? ` (${declared})` : ''}` };
  const out: Media = { ...item, kind, format, ...(total !== null ? { bytes: total } : {}) };
  if (total !== null && total < MIN_BYTES) return { ...out, why: `it is only ${total} bytes` };
  const dims = format ? dimensions(b, format) : null;
  if (dims) {
    Object.assign(out, dims);
    if (dims.width < MIN_PIXELS || dims.height < MIN_PIXELS) return { ...out, why: `it is only ${dims.width}×${dims.height} pixels` };
  }
  return out;
}

/**
 * A page that is a video or a track (a YouTube, Vimeo or SoundCloud link) says so in its Open Graph tags: og:video or
 * twitter:player, og:audio, or og:type video.* or music.*. Each <meta> tag is found with a forward scan and read on its
 * own, so a page of unclosed tags is read in linear time.
 */
function pageKind(html: string): MediaKind | undefined {
  const lower = html.toLowerCase();
  for (let i = 0; (i = lower.indexOf('<meta', i)) >= 0;) {
    const end = lower.indexOf('>', i);
    if (end < 0) break;
    const tag = lower.slice(i, Math.min(end, i + 2000));
    i = end + 1;
    const prop = /\b(?:property|name)\s*=\s*["']([^"']{1,60})["']/.exec(tag)?.[1], content = /\bcontent\s*=\s*["']([^"']{0,200})["']/.exec(tag)?.[1] ?? '';
    if (prop && /^(?:og:video(?::url|:secure_url)?|twitter:player)$/.test(prop)) return 'video';
    if (prop && /^og:audio(?::url|:secure_url)?$/.test(prop)) return 'audio';
    if (prop === 'og:type' && content.startsWith('video.')) return 'video';
    if (prop === 'og:type' && content.startsWith('music.')) return 'audio';
  }
  return undefined;
}

async function judgeLink(item: Media): Promise<Media> {
  let l;
  try { l = await load(item.from, { accept: 'image/*,video/*,audio/*;q=0.9,*/*;q=0.5', maxBytes: MEDIA_HEAD }); } catch (e) {
    return { ...item, why: e instanceof Refused ? e.message : 'it could not be read' };
  }
  const total = l.length ?? (l.complete ? l.body.length : null);
  if (l.type === 'text/html' || l.type === 'application/xhtml+xml') {
    const kind = pageKind(textOf(l));
    if (kind) return { ...item, kind, format: kind === 'video' ? 'a video page' : 'an audio page' };
    return { ...item, why: 'it is a web page, not media' };
  }
  const declared = /^(image|video|audio)\//.test(l.type) ? l.type : undefined;
  if (!declared && !/^(?:application\/octet-stream|binary\/octet-stream|application\/x-download|)$/.test(l.type)) {
    return { ...item, why: `it is ${l.type}, not media` };
  }
  return judgeBytes(item, l.body, total, declared);
}

const LINK = /https?:\/\/[^\s<>"'`)\]]+/gi;
const trim = (u: string) => u.replace(/[.,;:!?]+$/, '');
// Words on a line that offers media: "Here is your video: <link>" with no file extension in the link.
const MEDIA_WORDS = /\b(?:image|images|logo|picture|photo|illustration|icon|banner|video|clip|animation|audio|track|song|voice|recording|podcast|mp4|png|jpe?g|svg|gif|mp3|wav)\b/i;

/**
 * The media a delivery gives, each loaded or read once: url parts (a link, or a data: URL), raw parts (bytes), and in
 * the text "File: <name> <link>" lines (how the runner names a url part), Markdown images, links to a media file, and
 * links on a line that names media. At most MAX_LINKS links are opened, in that order.
 */
export async function mediaIn(req: Pick<EvaluateRequest, 'deliverable'>): Promise<Media[]> {
  const items: Media[] = [], links = new Map<string, Media>();
  const addLink = (url: string, name?: string) => { const u = trim(url); if (!links.has(u)) links.set(u, { from: u, ...(name ? { name } : {}) }); };
  for (const p of req.deliverable.parts) {
    const data = typeof p.url === 'string' ? /^data:([^,;]*)((?:;[^,;]*)*),/i.exec(p.url) : null;
    if (data) {
      const body = p.url!.slice(data[0].length);
      let buf: Buffer;
      try { buf = /;base64/i.test(data[2]) ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body)); } catch { buf = Buffer.from(body); }
      items.push(judgeBytes({ from: 'a data link in the reply', name: 'a file sent in the reply' }, buf, buf.length, data[1] || undefined));
    } else if (typeof p.url === 'string' && /^https?:\/\//i.test(p.url)) addLink(p.url);
    else if (typeof p.raw === 'string') {
      const r = rawBytes(p.raw);
      if (r) items.push(judgeBytes({ from: r.name ?? 'a file sent in the reply', name: r.name ?? 'a file sent in the reply' }, r.buf, r.buf.length, r.mime));
    }
  }
  const lines = req.deliverable.text.split('\n'), later: string[] = [];
  for (const line of lines) {
    const file = /^\s*File:\s+(?:(\S+)\s+)?(https?:\/\/\S+)\s*$/.exec(line);
    if (file) { addLink(file[2], file[1]); continue; }
    for (const m of line.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) addLink(m[1]);
    for (const m of line.matchAll(LINK)) {
      const u = trim(m[0]);
      if (mediaOfPath(u)) addLink(u);
      else if (MEDIA_WORDS.test(line)) later.push(u);
    }
  }
  for (const u of later) addLink(u);
  const opened = await Promise.all([...links.values()].slice(0, MAX_LINKS).map(judgeLink));
  return [...items, ...opened];
}

/** A raw part's bytes: the market gateway passes A2A raw bytes as base64, and a file part with its bytes inline as JSON. */
function rawBytes(raw: string): { buf: Buffer; mime?: string; name?: string } | null {
  try {
    const file = JSON.parse(raw)?.file;
    if (typeof file?.bytes === 'string') return { buf: Buffer.from(file.bytes, 'base64'), mime: file.mimeType, name: file.name };
    return null;
  } catch { /* not JSON */ }
  return /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(raw.trim()) && raw.trim().length >= 16 ? { buf: Buffer.from(raw, 'base64') } : null;
}

const size = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const label = (m: Media) => m.name && !m.from.startsWith('http') ? m.name : shown(m.from);
/** "logo.png (PNG, 512×512, 34 KB)" */
export const describe = (m: Media) => `${label(m)} (${[m.format, m.width ? `${m.width}×${m.height}` : '', m.bytes !== undefined ? size(m.bytes) : ''].filter(Boolean).join(', ')})`;
/** Why an item doesn't count for the kinds asked: its own failure, or the wrong kind. */
export const whyNot = (m: Media, kinds: MediaKind[]) => `${label(m)}: ${m.why ?? `it is ${m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'an image' : 'a video'}, not ${kinds.map((k) => (k === 'image' ? 'an image' : k === 'video' ? 'a video' : 'audio')).join(' or ')}`}`;

/** media: at least `min` of the items load as one of `kinds`. */
export function mediaCheck(items: Media[], kinds: MediaKind[], min = 1): { passed: boolean; detail: string } {
  const good = items.filter((m) => !m.why && m.kind && kinds.includes(m.kind));
  const what = kinds.join(' or ');
  if (good.length >= min) return { passed: true, detail: `${good.length} ${what} file${good.length === 1 ? '' : 's'} load: ${good.slice(0, 6).map(describe).join('; ')}` };
  if (!items.length) return { passed: false, detail: `no ${what} in the delivery: no file, "File:" line or link to one` };
  const bad = items.filter((m) => !good.includes(m));
  return { passed: false, detail: `needs ${min} ${what} file${min === 1 ? '' : 's'}, ${good.length} load${bad.length ? `: ${bad.slice(0, 6).map((m) => whyNot(m, kinds)).join('; ')}` : ''}` };
}
