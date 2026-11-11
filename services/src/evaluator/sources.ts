// The sources criterion (docs/agentic-system.md 7): the links a delivery cites are opened, and a figure it states must
// be on a page cited for it. An LLM looking for URLs passed a report built on five domains that don't resolve and a
// wrong total supply, and failed honest work over where its links stood.
import { Refused, extract as readPage, shown } from '../planner/reference.ts';
import { numbersIn, pageText } from './checks.ts';
import { load, textOf } from './fetch.ts';

export const MAX_SOURCES = 8; // links opened per delivery
const PAGE_BYTES = 500_000;
const TOLERANCE = 0.01; // a figure and the page's own differ by at most 1% (rounding: "1.31B" for 1,311,369,660)

const LINK = /https?:\/\/[^\s<>"'`)\]]+/gi;
// Addresses for examples, never a source: example.com, *.test, localhost.
const PLACEHOLDER = /^(?:(?:www\.)?example\.(?:com|org|net)|[^/]*\.(?:example|test|invalid|localhost)|localhost)$/i;
// A line that heads the delivery's list of sources ("Sources:", "## References", "**Kaynaklar**").
const SOURCES_HEAD = /^\s*(?:#{1,6}\s*)?[*_]*(?:sources?|references?|citations?|bibliography|works\s+cited|kaynaklar|kaynakça|referanslar|quellen|fuentes)[*_]*\s*:?[*_]*\s*(.*)$/i;
// A line that cites the line above it: "Source: <link>", "(source: <link>)", "via <link>".
const CITES_ABOVE = /^\s*[-*>]?\s*[(\[]?\s*(?:sources?|kaynak|via|per|from|see)\b/i;

export type Cited = { url: string; lines: number[]; listed: boolean; placeholder: boolean };

/** The http(s) links a text cites, once each, in order: where each stands, and whether it is in a sources list. */
export function citedLinks(text: string): Cited[] {
  const out = new Map<string, Cited>();
  let listing = false;
  text.split('\n').forEach((line, i) => {
    // A heading starts the list, up to the next heading or rule; "Sources: <link>, <link>" is a list on one line.
    const head = SOURCES_HEAD.exec(line), inline = !!head?.[1] && /https?:\/\//i.test(head[1]);
    if (head && !head[1]) listing = true;
    else if (/^\s*#{1,6}\s|^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) listing = false;
    for (const m of line.matchAll(LINK)) {
      const url = m[0].replace(/[.,;:!?]+$/, '');
      let host = '';
      try { host = new URL(url).hostname; } catch { continue; }
      const c = out.get(url) ?? { url, lines: [], listed: false, placeholder: PLACEHOLDER.test(host) };
      c.lines.push(i);
      c.listed ||= listing || inline;
      out.set(url, c);
    }
  });
  return [...out.values()];
}

/** A cited link as Rook read it: whether it loads as a public page, its title, and its text for figures. */
export type SourcePage = { url: string; ok: boolean; why?: string; title?: string; text?: string };

async function open(url: string): Promise<SourcePage> {
  try {
    const l = await load(url, { accept: 'text/html,application/xhtml+xml,text/plain,application/json,application/pdf;q=0.9,*/*;q=0.5', maxBytes: PAGE_BYTES });
    if (l.type === 'text/html' || l.type === 'application/xhtml+xml') {
      const html = textOf(l), text = pageText(html).replace(/\s+/g, ' ').trim();
      if (!/\p{L}/u.test(text)) return { url, ok: false, why: 'it loads but shows no text' };
      return { url, ok: true, title: readPage(l.url, html).title, text };
    }
    if (/^(?:text\/|application\/(?:json|xml|[\w.+-]+\+(?:json|xml))$)/.test(l.type)) return { url, ok: true, text: textOf(l) };
    if (l.type === 'application/pdf') return { url, ok: true, title: 'a PDF' }; // loads; its figures are not read
    return { url, ok: false, why: `it is ${l.type || 'no page'}, not a page` };
  } catch (e) {
    return { url, ok: false, why: e instanceof Refused ? e.message : 'it could not be read' };
  }
}

/** A figure the delivery states for a numeric_match label, with the quote that holds it. */
export type Figure = { label: string; value: number; quote: string };

const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE * Math.max(Math.abs(a), Math.abs(b));

/**
 * sources: at least `min` cited links (default 2) load as public pages, placeholders aside; with `figures`, each figure
 * is on a loaded page cited next to it (its line, or a "Source:" line under it), else on one in the sources list,
 * else on any cited page. `pages`: every link opened, for the judge.
 * ponytail: a figure is matched as a number on the page within 1%, so a small one ("7") can be found by chance.
 */
export async function sourcesCheck(text: string, spec: { min?: number; figures?: boolean }, figures: Figure[]): Promise<{ passed: boolean; detail: string; pages: SourcePage[] }> {
  const min = spec.min ?? 2, all = citedLinks(text), real = all.filter((c) => !c.placeholder), fake = all.filter((c) => c.placeholder);
  const lines = text.split('\n');
  const lineOf = (quote: string) => {
    const q = quote.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return lines.findIndex((l) => l.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').includes(q));
  };
  // Each figure's own links: on its line, or a "Source:" line right under it; else the sources list; else every link.
  const forFigure = new Map<Figure, Cited[]>();
  for (const f of spec.figures ? figures : []) {
    const at = lineOf(f.quote);
    const own = real.filter((c) => c.lines.includes(at) || (at >= 0 && CITES_ABOVE.test(lines[at + 1] ?? '') && c.lines.includes(at + 1)));
    forFigure.set(f, own.length ? own : real.some((c) => c.listed) ? real.filter((c) => c.listed) : real);
  }
  const order = [...new Set([...[...forFigure.values()].flat(), ...real.filter((c) => c.listed), ...real])].slice(0, MAX_SOURCES);
  const pages = await Promise.all(order.map((c) => open(c.url)));
  const page = new Map(pages.map((p) => [p.url, p]));
  const ok = pages.filter((p) => p.ok);
  const named = (p: SourcePage) => shown(p.url);
  const placeholders = fake.length ? `; ${fake.slice(0, 3).map((c) => shown(c.url)).join(', ')} ${fake.length === 1 ? 'is a placeholder address' : 'are placeholder addresses'}, not ${fake.length === 1 ? 'a source' : 'sources'}` : '';

  if (ok.length < min) {
    const dead = pages.filter((p) => !p.ok).slice(0, 5).map((p) => `${named(p)} (${p.why})`).join('; ');
    const why = !real.length ? 'cites no source link' : `${ok.length} of the ${pages.length} cited link${pages.length === 1 ? '' : 's'} Rook opened load${dead ? `: ${dead}` : ''}`;
    return { passed: false, detail: `needs ${min} source link${min === 1 ? ' that loads' : 's that load'} as a public page; ${why}${placeholders}`, pages };
  }
  const unseen: string[] = [], seen: string[] = [];
  for (const [f, cited] of forFigure) {
    const loaded = cited.map((c) => page.get(c.url)).filter((p): p is SourcePage => !!p);
    const hit = loaded.find((p) => p.ok && p.text && numbersIn(p.text).some((n) => near(n, f.value)));
    if (hit) { seen.push(`${f.label} ${f.value} is on ${named(hit)}`); continue; }
    const tried = loaded.slice(0, 3).map((p) => (p.ok ? `${named(p)} loads but does not show it` : `${named(p)} did not load: ${p.why}`)).join('; ');
    unseen.push(`${f.label} ${f.value} is on no page cited for it${tried ? ` (${tried})` : ''}`);
  }
  if (unseen.length) return { passed: false, detail: `${unseen.slice(0, 4).join('; ')}${placeholders}`, pages };
  return { passed: true, detail: `${ok.length} of ${pages.length} cited links load as public pages (${ok.slice(0, 4).map(named).join(', ')})${seen.length ? `; ${seen.slice(0, 4).join('; ')}` : ''}${placeholders}`, pages };
}
