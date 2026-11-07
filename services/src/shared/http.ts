// Minimal JSON-over-HTTP server and client on node:http + fetch.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

export type Ctx = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  req: IncomingMessage;
  res: ServerResponse;
};
/** Return a value to send it as JSON (200), or return undefined after writing to ctx.res yourself (SSE). */
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
export type Routes = Record<string, Handler>; // key: "GET /tasks/:id"

export type Running = { url: string; port: number; close: () => Promise<void> };

export function serve(name: string, routes: Routes, port: number): Promise<Running> {
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(' ');
    const names: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$');
    return { method, re, names, handler };
  });

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    try {
      const route = table.find((r) => r.method === req.method && r.re.test(u.pathname));
      if (!route) throw new HttpError(404, `no route ${req.method} ${u.pathname}`);
      const m = u.pathname.match(route.re)!;
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      let body: any = undefined;
      if (req.method !== 'GET') {
        const raw = await readBody(req);
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'invalid JSON body'); }
      }
      const out = await route.handler({ params, query: u.searchParams, body, req, res });
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : e?.name === 'ZodError' ? 400 : 500;
      if (status === 500) console.error(`[${name}]`, e);
      if (!res.headersSent) sendJson(res, status, { error: e?.message ?? String(e), ...(e?.body ? { details: e.body } : {}) });
      else res.end();
    }
  });

  return new Promise((ok) => server.listen(port, '127.0.0.1', () => {
    const p = (server.address() as AddressInfo).port;
    ok({ url: `http://127.0.0.1:${p}`, port: p, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) });
  }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let s = '';
    req.setEncoding('utf8').on('data', (d) => (s += d)).on('end', () => ok(s)).on('error', fail);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body, bigintReplacer));
}

export const bigintReplacer = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** JSON call to another service. Throws HttpError on non-2xx. */
export async function call<T = any>(url: string, body?: unknown, opts: { method?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (body === undefined ? 'GET' : 'POST');
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body, bigintReplacer),
    signal: opts.signal,
  });
  const text = await r.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!r.ok) throw new HttpError(r.status, data?.error ?? `${method} ${url} -> ${r.status}`, data);
  return data as T;
}
