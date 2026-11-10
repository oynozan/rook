// The report as the page shows it: its Markdown as blocks (headings, lists, quotes, rules, tables, fenced code) and
// inline parts, the services' file markers in plain words, the same as one line of plain words for a preview, and the
// files agents delivered beside it (named, counted, ready to download). Report text comes from agents, so nothing here
// is ever markup: the page renders it as plain React text. Pure functions, so the page and the tests both use them.

export type Block = { kind: 'line'; text: string } | { kind: 'code'; lang: string; text: string };

/**
 * The report's lines, with each fenced code block (``` or ~~~, three or more) as one block, kept as it was written. A
 * fence never closed runs to the end, as Markdown has it.
 */
export function reportBlocks(markdown: string): Block[] {
  const out: Block[] = [];
  let fence: { mark: string; lang: string; lines: string[] } | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    if (fence) {
      // Closed by the same character, at least as many times, and nothing else on the line.
      const close = raw.trim(), mark = fence.mark;
      if (close.length >= mark.length && [...close].every((c) => c === mark[0])) {
        out.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') });
        fence = null;
      } else fence.lines.push(raw);
      continue;
    }
    const open = raw.match(/^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/);
    if (open) fence = { mark: open[1], lang: open[2], lines: [] };
    else out.push({ kind: 'line', text: raw });
  }
  if (fence) out.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') });
  return out;
}

/**
 * The services' marker for a file taken out of the report ("[file index.html, 407 lines, attached below the report]",
 * or "..., not attached: <why>]"), in plain words; null for any other line.
 */
export function fileMarker(line: string): string | null {
  const m = line.trim().match(/^\[file (.+?), (\d+) lines?, (?:attached below the report|not attached: (.+))\]$/);
  if (!m) return null;
  const [, name, n, why] = m, lines = `${n} line${n === '1' ? '' : 's'}`;
  return why ? `${name} (${lines}) wasn't attached: ${why}.` : `${name} (${lines}) is under Files below.`;
}

const MARKER = /\[file (.+?), (\d+) lines?, (?:attached below the report|not attached: ([^\]]+))\]/g;

/** The services' file markers inside a line ("- **next.config.mjs** [file ..., 6 lines, attached ...]"), in plain words. */
export function inlineMarkers(text: string): string {
  return text.replace(MARKER, (_, name: string, n: string, why?: string) => {
    const lines = `${n} line${n === '1' ? '' : 's'}`;
    return why ? `${name} (${lines}, not attached: ${why})` : `${name} (${lines}), under Files`;
  });
}

export type MdBlock =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'bullet'; depth: number; text: string }
  | { kind: 'number'; n: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'note'; text: string } // a file marker on a line of its own, in plain words
  | { kind: 'para'; text: string };

const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** A table row's cells: the pipes at its ends dropped, split at each pipe that isn't escaped. */
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/**
 * The report's Markdown as blocks to show: headings, lists, quotes, rules, tables (a header row, a rule row of dashes,
 * then rows), fenced code as written, file markers, and paragraphs. Blank lines separate and are dropped.
 */
export function markdownBlocks(markdown: string): MdBlock[] {
  const out: MdBlock[] = [];
  const blocks = reportBlocks(markdown);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === 'code') { out.push(b); continue; }
    const line = b.text, trimmed = line.trim();
    if (!trimmed) continue;
    const next = blocks[i + 1];
    if (trimmed.includes('|') && next?.kind === 'line' && next.text.includes('-') && TABLE_RULE.test(next.text) && cells(next.text).length === cells(line).length) {
      const head = cells(line), rows: string[][] = [];
      for (i += 2; i < blocks.length; i++) {
        const r = blocks[i];
        if (r.kind !== 'line' || !r.text.trim() || !r.text.includes('|')) { i--; break; }
        const row = cells(r.text);
        rows.push(head.map((_, j) => row[j] ?? ''));
      }
      out.push({ kind: 'table', head, rows });
      continue;
    }
    const note = fileMarker(trimmed);
    if (note) { out.push({ kind: 'note', text: note }); continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^ {0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/))) out.push({ kind: 'heading', level: m[1].length, text: m[2] });
    else if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) out.push({ kind: 'rule' });
    else if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) out.push({ kind: 'bullet', depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), text: m[2] });
    else if ((m = line.match(/^\s*(\d{1,4})[.)]\s+(.*)$/))) out.push({ kind: 'number', n: m[1], text: m[2] });
    else if ((m = line.match(/^\s*>\s?(.*)$/))) out.push({ kind: 'quote', text: m[1] });
    else out.push({ kind: 'para', text: trimmed });
  }
  return out;
}

export type Inline = { kind: 'text' | 'code' | 'strong' | 'em'; text: string } | { kind: 'link'; text: string; href: string };

/**
 * A line's inline Markdown: `code`, **bold**, _emphasis_ and *emphasis*, and [links](https://...), with file markers in
 * plain words. Only an http(s) link stays a link; any other is its words. Never markup: the page renders these as text.
 */
export function inlineParts(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)\s]+\)|(?<![\w*])\*[^*\s](?:[^*]*[^*\s])?\*(?![\w*])|\b_[^_]+_\b)/g;
  const s = inlineMarkers(text);
  let at = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > at) out.push({ kind: 'text', text: s.slice(at, m.index) });
    const t = m[0];
    const link = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) out.push(/^https?:\/\//i.test(link[2]) ? { kind: 'link', text: link[1], href: link[2] } : { kind: 'text', text: link[1] });
    else if (t.startsWith('`')) out.push({ kind: 'code', text: t.slice(1, -1) });
    else if (t.startsWith('**') || t.startsWith('__')) out.push({ kind: 'strong', text: t.slice(2, -2) });
    else out.push({ kind: 'em', text: t.slice(1, -1) });
    at = m.index! + t.length;
  }
  if (at < s.length) out.push({ kind: 'text', text: s.slice(at) });
  return out;
}

const words = (text: string) => inlineParts(text).map((p) => p.text).join('');

/** Markdown as one line of plain words, for a short preview: no marks, a table's cells "a · b", code as "(html, 12 lines)". */
export function plainText(markdown: string): string {
  return markdownBlocks(markdown).map((b) => {
    switch (b.kind) {
      case 'code': return `(${b.lang || 'code'}, ${lineCount(b.text)} lines)`;
      case 'rule': return '';
      case 'table': return [b.head, ...b.rows].map((r) => r.map(words).join(' · ')).join('; ');
      case 'number': return `${b.n}. ${words(b.text)}`;
      default: return words(b.text);
    }
  }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Who made a file, in plain words: Rook's own work shows as Rook, an agent by its handle. */
export const madeBy = (handle: string) => (handle.startsWith('rook:') ? 'Rook' : handle);

/** Lines in a file's text; a final newline ends the last line rather than starting another. */
export const lineCount = (text: string) => (text ? text.replace(/\r?\n$/, '').split(/\r?\n/).length : 0);

/**
 * A delivered file's name as a single download uses it: its base name, no characters a file system refuses, and no
 * trailing dot or space. A leading dot stays: ".env.example" is a real name. The zip keeps the folders (project.ts).
 */
export function downloadName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\s+|[\s.]+$/g, '');
  return base.slice(0, 120) || 'file.txt';
}

/** The Blob type for a delivered file: its own MIME type when it is a plain one, else text. Always text in UTF-8. */
export function blobType(mime: string): string {
  const m = mime.trim().toLowerCase().split(';')[0];
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(m) ? `${m};charset=utf-8` : 'text/plain;charset=utf-8';
}

/** A web page the page can preview (in a sandboxed frame): an HTML type, or a .html name. */
export const isHtml = (f: { name: string; mime: string }) => /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(f.mime) || /\.x?html?$/i.test(f.name);
