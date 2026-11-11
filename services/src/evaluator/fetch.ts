// Links the evaluator opens itself besides a live_url (a delivered image or video, a cited source), with the guards of
// the planner's reference reader (planner/reference.ts): public addresses only, pinned for the connection (DNS rebinding
// can't swap them), ports 80 and 443, every redirect checked again, a time and size limit, and no credentials. That
// reader takes web pages only; these links are media, PDFs and data too, and a video is never downloaded whole.
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { pipeline, type Readable } from 'node:stream';
import zlib from 'node:zlib';
import { isPublicAddress, Refused, type Addr } from '../planner/reference.ts';

const TIMEOUT_MS = 8000; // one link, its redirects included
const MAX_REDIRECTS = 3;

/** Tests only, as reference.ts's seam: a resolver, address:port pairs allowed besides public ones, a shorter timeout. */
export type FetchSeam = { resolve?: (host: string) => Promise<Addr[]>; allow?: (address: string, port: number) => boolean; timeoutMs?: number };
let seam: FetchSeam | null = null;
export function useFetchSeam(s: FetchSeam | null) { seam = s; }

const webPort = (p: number) => p === 80 || p === 443;
const resolveDns = async (host: string): Promise<Addr[]> =>
  (await lookup(host, { all: true, verbatim: true })).map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));

async function checked(url: URL): Promise<Addr> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refused('only http and https links are read');
  if (url.username || url.password) throw new Refused('its address carries a user name or password');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const ok = (a: string) => (webPort(port) && isPublicAddress(a)) || !!seam?.allow?.(a, port);
  if (!webPort(port) && !seam?.allow) throw new Refused('only links on ports 80 and 443 are read');
  let addrs: Addr[];
  try { addrs = await (seam?.resolve ?? resolveDns)(url.hostname.replace(/^\[|\]$/g, '')); } catch { throw new Refused('its name does not resolve'); }
  if (!addrs.length) throw new Refused('its name does not resolve');
  if (addrs.some((a) => !ok(a.address))) throw new Refused(webPort(port) ? 'it points to a private or local network address' : 'only links on ports 80 and 443 are read');
  return addrs[0];
}

function get(url: URL, addr: Addr, signal: AbortSignal, accept: string): Promise<http.IncomingMessage> {
  const mod = url.protocol === 'https:' ? https : http;
  const pinned = (_h: string, o: { all?: boolean }, cb: (...a: any[]) => void) => (o?.all ? cb(null, [addr]) : cb(null, addr.address, addr.family));
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'GET', agent: false, signal, lookup: pinned as any,
      headers: { accept, 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'Rook evaluator (checks a link a delivery gives)' },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

/** What a link answered: its final address, media type, declared size, and its first `maxBytes` bytes (decoded). */
export type Loaded = { url: string; type: string; charset?: string; length: number | null; body: Buffer; complete: boolean };

/**
 * GET `raw` with the guards above, following redirects. Reads at most `maxBytes` of the body (a longer one is cut there,
 * `complete` false), so a video is sniffed by its first bytes, never downloaded. Throws Refused with why, in plain words.
 */
export async function load(raw: string, opts: { accept: string; maxBytes: number }): Promise<Loaded> {
  const ms = seam?.timeoutMs ?? TIMEOUT_MS;
  const signal = AbortSignal.timeout(ms);
  try {
    let url = new URL(raw);
    for (let hop = 0; ; hop++) {
      const res = await get(url, await checked(url), signal, opts.accept);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new Refused(`it redirected more than ${MAX_REDIRECTS} times`);
        url = new URL(res.headers.location, url);
        continue;
      }
      if (status < 200 || status >= 300) { res.resume(); throw new Refused(`it answered HTTP ${status}`); }
      const length = Number(res.headers['content-length']), type = String(res.headers['content-type'] ?? '');
      const { body, complete } = await readHead(res, opts.maxBytes);
      return {
        url: url.href, type: type.split(';')[0].trim().toLowerCase(), charset: /charset\s*=\s*"?([\w-]+)/i.exec(type)?.[1],
        length: Number.isFinite(length) && res.headers['content-length'] !== undefined ? length : null, body, complete,
      };
    }
  } catch (e: any) {
    if (e instanceof Refused) throw e;
    if (signal.aborted) throw new Refused(`it did not answer within ${ms / 1000} seconds`);
    throw new Refused(`the connection failed (${e?.code ?? e?.message ?? e})`);
  }
}

async function readHead(res: http.IncomingMessage, max: number): Promise<{ body: Buffer; complete: boolean }> {
  const enc = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  const unzip = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
  if (!unzip && enc !== 'identity') { res.destroy(); throw new Refused('it sent its content in an encoding Rook does not read'); }
  // The cap counts decoded bytes, so a small compressed body cannot unpack into a huge one.
  const stream: Readable = unzip ? pipeline(res, unzip, () => {}) : res;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    chunks.push(c);
    n += c.length;
    if (n >= max) { stream.destroy(); res.destroy(); return { body: Buffer.concat(chunks).subarray(0, max), complete: false }; }
  }
  return { body: Buffer.concat(chunks), complete: true };
}

/** A body as text, in the charset its type names or UTF-8. */
export function textOf(l: Loaded): string {
  try { return new TextDecoder(l.charset ?? 'utf-8').decode(l.body); } catch { return new TextDecoder('utf-8').decode(l.body); }
}
