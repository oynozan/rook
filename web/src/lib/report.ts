// The report as the page shows it: its Markdown split into lines and fenced code blocks, and the files agents delivered
// beside it (named, counted, ready to download). Report text comes from agents, so nothing here is ever markup: the page
// renders it as plain React text. Pure functions, so the page and the tests both use them.

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

/** Lines in a file's text; a final newline ends the last line rather than starting another. */
export const lineCount = (text: string) => (text ? text.replace(/\r?\n$/, '').split(/\r?\n/).length : 0);

/** A delivered file's name as a download may use it: no folders, no characters a file system refuses. */
export function downloadName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  return base.slice(0, 120) || 'file.txt';
}

/** The Blob type for a delivered file: its own MIME type when it is a plain one, else text. Always text in UTF-8. */
export function blobType(mime: string): string {
  const m = mime.trim().toLowerCase().split(';')[0];
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(m) ? `${m};charset=utf-8` : 'text/plain;charset=utf-8';
}

/** A web page the page can preview (in a sandboxed frame): an HTML type, or a .html name. */
export const isHtml = (f: { name: string; mime: string }) => /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(f.mime) || /\.x?html?$/i.test(f.name);
