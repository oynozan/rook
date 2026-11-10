// Code files out of the deliveries (docs/agentic-system.md 5.4). Asked for a website, the user wants a file they can
// open: the aggregator rewrote every delivery into one Markdown report (8000 tokens), which cut a full page short, and the
// web app drew the page's code line by line. Each file is taken out of its delivery as written and a short marker takes
// its place, so the aggregator names the file instead of rewriting it.
import type { DeliveredFile } from '../shared/types.ts';

/** One merged delivery: the part it answers and who wrote it (as in the attribution). */
export type Delivery = { subtask_id: string; agent_handle: string; title: string; text: string };
/** A file found but not attached, for the report's gaps. */
export type Unattached = { name: string; title: string; why: string };
/** `texts`: each delivery's text by subtask id, with every file replaced by its marker. */
export type Attached = { texts: Map<string, string>; files: DeliveredFile[]; unattached: Unattached[] };

export const FILE_MAX_BYTES = 1024 * 1024;
export const FILES_MAX_BYTES = 3 * 1024 * 1024;
/**
 * ponytail: a fenced block under MIN_LINES lines and SNIPPET_CHARS characters, with no file name stated and no HTML
 * document in it, is a snippet (an install command, a sample response) and stays in the text. A one-line file the
 * delivery names, or a minified page, is still attached.
 */
const MIN_LINES = 3;
const SNIPPET_CHARS = 300;

// Fence languages (and file extensions) Rook attaches, by canonical extension.
const KIND: Record<string, string> = {
  html: 'html', htm: 'html', css: 'css', js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', json: 'json',
  py: 'py', python: 'py', sh: 'sh', bash: 'sh', svg: 'svg', xml: 'xml', yaml: 'yaml', yml: 'yaml', sql: 'sql',
  // A web build in a framework ("a React landing page" gives App.jsx) is kept out of the text like a plain page.
  jsx: 'jsx', tsx: 'tsx', vue: 'vue', svelte: 'svelte', scss: 'scss', sass: 'sass', less: 'less', php: 'php',
};
const kindOf = (w: string) => (Object.hasOwn(KIND, w) ? KIND[w] : undefined); // a fence named 'constructor' is no kind
const MIME: Record<string, string> = {
  html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/typescript', json: 'application/json',
  py: 'text/x-python', sh: 'text/x-shellscript', svg: 'image/svg+xml', xml: 'application/xml', yaml: 'application/yaml', sql: 'application/sql',
  jsx: 'text/javascript', tsx: 'text/typescript', vue: 'text/x-vue', svelte: 'text/x-svelte', scss: 'text/x-scss', sass: 'text/x-sass',
  less: 'text/x-less', php: 'application/x-httpd-php',
};

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const DOC_START = /^\s*(<!doctype\s+html|<html[\s>])/i;
const NAME = /[A-Za-z0-9_][\w.-]*\.([A-Za-z0-9]+)/g; // a path's last part: "src/index.html" gives "index.html"
const COMMENT_NAME = /^\s*(?:<!--|\/\/|\/\*|#)\s*(?:file(?:name)?:\s*)?([A-Za-z0-9_][\w.-]*\.\w+)\s*(?:-->|\*\/)?\s*$/i;

/** The last file name in `line` whose extension is of `kind`, if any. */
function nameIn(line: string | undefined, kind: string): string | undefined {
  if (!line) return undefined;
  const found = [...line.matchAll(NAME)].filter((m) => kindOf(m[1].toLowerCase()) === kind).at(-1)?.[0];
  return found?.slice(0, 80);
}

/** `weak`: a short block named only by the line before it, which may name the file it edits ("add this to your index.html:"). */
type Found = { kind: string; name?: string; text: string; from: number; to: number; weak?: boolean }; // lines [from, to)

/** The files in one text: fenced blocks of a known language, and an unfenced HTML document. */
function scan(lines: string[]): Found[] {
  const out: Found[] = [];
  let prose: string | undefined; // the nearest non-empty line before here outside a file
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(OPEN);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      // Unclosed, it runs to the end of the text (as in CommonMark): a delivery cut short still has its file.
      const close = new RegExp(`^ {0,3}${open[1][0] === '`' ? '`' : '~'}{${open[1].length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      const body = lines.slice(i + 1, j);
      const info = open[2].trim().split(/\s+/).filter(Boolean);
      const first = info[0]?.toLowerCase() ?? '';
      // An untagged fence holding an HTML document is that document.
      const kind = kindOf(first) ?? kindOf(first.split('.').at(-1)!) ?? (!first && DOC_START.test(body[0] ?? '') ? 'html' : undefined);
      const own = kind ? info.map((w) => nameIn(w, kind)).find(Boolean) : undefined;
      const comment = kind ? nameIn(body[0]?.match(COMMENT_NAME)?.[1], kind) : undefined;
      const stated = kind ? own ?? nameIn(prose, kind) ?? comment : undefined;
      const short = body.length < MIN_LINES && body.join('\n').length < SNIPPET_CHARS && !DOC_START.test(body[0] ?? '');
      if (kind && !(short && !stated)) out.push({ kind, name: stated, text: body.join('\n'), from: i, to: Math.min(j + 1, lines.length), weak: short && !own && !comment });
      prose = undefined; // the line before a block names that block, never the next one
      i = j;
      continue;
    }
    if (DOC_START.test(lines[i])) {
      let j = i;
      while (j < lines.length && !/<\/html\s*>/i.test(lines[j])) j++;
      const to = Math.min(j + 1, lines.length);
      out.push({ kind: 'html', name: nameIn(prose, 'html'), text: lines.slice(i, to).join('\n').trim(), from: i, to });
      i = to - 1;
      prose = undefined;
      continue;
    }
    if (lines[i].trim()) prose = lines[i].length <= 300 ? lines[i] : undefined;
  }
  return out;
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-+|-+$/g, '');
const lineCount = (text: string) => text.split('\n').length;

/**
 * Takes the code files out of the merged deliveries, in order. A file is named from a file name the delivery states next
 * to it (the fence's info string, the line before it, or a comment on its first line), else from its part's title; names
 * are unique across the result. A file over FILE_MAX_BYTES, or past FILES_MAX_BYTES in all, is left out and listed.
 */
export function attachFiles(deliveries: Delivery[]): Attached {
  const texts = new Map<string, string>();
  const files: DeliveredFile[] = [];
  const unattached: Unattached[] = [];
  const taken = new Set<string>();
  let total = 0;
  const unique = (want: string) => {
    const dot = want.lastIndexOf('.');
    const [base, ext] = [want.slice(0, dot), want.slice(dot)];
    let name = want;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}${ext}`;
    taken.add(name.toLowerCase());
    return name;
  };
  // CRLF too: in an agent's \r\n reply every fence line ended in \r, so no file was found.
  const scanned = deliveries.map((d) => { const lines = d.text.split(/\r?\n/); return { d, lines, found: scan(lines) }; });
  // A short block named only by its prose line yields that name to any other block with it, anywhere in the result, and
  // stays in the text as a snippet: "add this line to your index.html:" took index.html and pushed the page to index-2.html.
  const named = new Map<string, number>();
  for (const f of scanned.flatMap((x) => x.found)) if (f.name) named.set(f.name.toLowerCase(), (named.get(f.name.toLowerCase()) ?? 0) + 1);
  for (const { d, lines, found: all } of scanned) {
    const found = all.filter((f) => !(f.weak && named.get(f.name!.toLowerCase())! > 1));
    const out: string[] = [];
    let at = 0;
    for (const f of found) {
      const name = unique(f.name ?? `${slug(d.title) || d.subtask_id}.${f.kind}`);
      const bytes = Buffer.byteLength(f.text, 'utf8');
      const why = bytes > FILE_MAX_BYTES ? 'larger than 1 MB' : total + bytes > FILES_MAX_BYTES ? 'the files together pass 3 MB' : null;
      const n = lineCount(f.text);
      const size = `${n} line${n === 1 ? '' : 's'}`;
      if (why) unattached.push({ name, title: d.title, why });
      else {
        total += bytes;
        files.push({ subtask_id: d.subtask_id, agent_handle: d.agent_handle, name, mime: MIME[f.kind], text: f.text });
      }
      out.push(...lines.slice(at, f.from), why ? `[file ${name}, ${size}, not attached: ${why}]` : `[file ${name}, ${size}, attached below the report]`);
      at = f.to;
    }
    out.push(...lines.slice(at));
    texts.set(d.subtask_id, found.length ? out.join('\n').trim() : d.text);
  }
  return { texts, files, unattached };
}

/** A gap line for a file left out, in the report's words. */
export const unattachedLine = (u: Unattached) => `File ${u.name} from "${u.title}": not attached, ${u.why}`;
