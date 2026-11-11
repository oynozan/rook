// Code files out of the deliveries (docs/agentic-system.md 5.4). Asked for a website, the user wants a file they can
// open: the aggregator rewrote every delivery into one Markdown report (8000 tokens), which cut a full page short, and the
// web app drew the page's code line by line. Each file is taken out of its delivery as written and a short marker takes
// its place, so the aggregator names the file instead of rewriting it. A file keeps its path in the project: cut to its
// last part, a Next.js project lost app/ and components/ (page.tsx, page-2.tsx) and could not run.
import type { DeliveredFile } from '../shared/types.ts';

/**
 * One merged delivery: the part it answers and who wrote it (as in the attribution). `inputs`: the chat's files the part
 * edits (PlanSubtask.inputs); `paths`: the files it is asked for (its files criterion, or the ones its brief names).
 * Both name what an unnamed or misplaced file of the delivery is (attachFiles).
 */
export type Delivery = { subtask_id: string; agent_handle: string; title: string; text: string; inputs?: string[]; paths?: string[] };
/** A file found but not attached, for the report's gaps. */
export type Unattached = { name: string; title: string; why: string };
/** Bracketed placeholders a part left for the user to fill in ("[Your email]"), in one of its files or (no `name`) its text. */
export type Placeholders = { title: string; name?: string; found: string[] };
/** `texts`: each delivery's text by subtask id, with every file replaced by its marker. */
export type Attached = { texts: Map<string, string>; files: DeliveredFile[]; unattached: Unattached[]; placeholders: Placeholders[] };

export const FILE_MAX_BYTES = 1024 * 1024;
export const FILES_MAX_BYTES = 3 * 1024 * 1024;
/**
 * ponytail: a fenced block under MIN_LINES lines and SNIPPET_CHARS characters, with no file name stated and no HTML
 * document in it, is a snippet (an install command, a sample response) and stays in the text. A one-line file the
 * delivery names, or a minified page, is still attached.
 */
const MIN_LINES = 3;
const SNIPPET_CHARS = 300;

// Fence languages and file extensions Rook attaches, by kind (the extension a file without a name gets).
const KIND: Record<string, string> = {
  html: 'html', htm: 'html', css: 'css', js: 'js', javascript: 'js', mjs: 'mjs', cjs: 'cjs', ts: 'ts', typescript: 'ts', mts: 'mts', cts: 'cts',
  json: 'json', jsonc: 'json', py: 'py', python: 'py', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', svg: 'svg', xml: 'xml', yaml: 'yaml', yml: 'yaml', sql: 'sql',
  // A web build in a framework ("a React landing page" gives App.jsx) is kept out of the text like a plain page.
  jsx: 'jsx', tsx: 'tsx', vue: 'vue', svelte: 'svelte', scss: 'scss', sass: 'sass', less: 'less', php: 'php',
  // The rest of a project: its README, configs, env example, container, schema and ignore files.
  md: 'md', markdown: 'md', mdx: 'mdx', toml: 'toml', env: 'env', dotenv: 'env', dockerfile: 'dockerfile', docker: 'dockerfile',
  prisma: 'prisma', gitignore: 'gitignore', txt: 'txt', text: 'txt', plaintext: 'txt', ini: 'ini', cfg: 'ini', conf: 'conf', nginx: 'conf', graphql: 'graphql', gql: 'graphql',
};
const kindOf = (w: string) => (Object.hasOwn(KIND, w) ? KIND[w] : undefined); // a fence named 'constructor' is no kind
// A name of one family fits a block of another in it: a ```js block can be next.config.mjs, a ```typescript one page.tsx.
const FAMILY: Record<string, string> = { mjs: 'js', cjs: 'js', jsx: 'js', mts: 'ts', cts: 'ts', tsx: 'ts', mdx: 'md' };
const family = (k: string) => FAMILY[k] ?? k;
// Prose formats: a ```markdown block with no name is a post written in the reply, not a file, and stays in the text.
const NAMED_ONLY = new Set(['md', 'mdx', 'txt']);
const MIME: Record<string, string> = {
  html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript',
  ts: 'text/typescript', mts: 'text/typescript', cts: 'text/typescript', tsx: 'text/typescript', json: 'application/json',
  py: 'text/x-python', sh: 'text/x-shellscript', svg: 'image/svg+xml', xml: 'application/xml', yaml: 'application/yaml', sql: 'application/sql',
  vue: 'text/x-vue', svelte: 'text/x-svelte', scss: 'text/x-scss', sass: 'text/x-sass', less: 'text/x-less', php: 'application/x-httpd-php',
  md: 'text/markdown', mdx: 'text/markdown', toml: 'application/toml', graphql: 'application/graphql',
}; // env, dockerfile, prisma, gitignore, txt, ini and conf files are text/plain

const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The kind of a file by its name ("page.tsx", "Dockerfile", ".env.example"), when Rook attaches that kind. */
function kindOfName(base: string): string | undefined {
  const b = base.toLowerCase();
  if (/^dockerfile(?:\.[\w-]+)?$/.test(b) || b.endsWith('.dockerfile')) return 'dockerfile';
  if (/^\.env(?:\.[\w-]+)*$/.test(b)) return 'env';
  if (/^\.\w+ignore$/.test(b)) return 'gitignore';
  if (/^\.(?:prettierrc|eslintrc|babelrc|swcrc)$/.test(b)) return 'json';
  if (/^\.(?:editorconfig|npmrc|nvmrc|yarnrc)$/.test(b)) return 'conf';
  if (/^(?:license|procfile|makefile)$/.test(b)) return 'txt';
  const dot = b.lastIndexOf('.');
  return dot > 0 ? kindOf(b.slice(dot + 1)) : undefined; // ".js" alone is an extension, not a file
}
/** The kind of the file at `path`, if Rook attaches that kind. */
export const kindOfPath = (path: string) => kindOfName(baseOf(path));
/** The fence language for the file at `path` ("tsx", "markdown", "" when Rook has none for it). */
export function fenceLang(path: string): string {
  const k = kindOfPath(path);
  return k === 'md' ? 'markdown' : k === 'txt' ? 'text' : k ?? '';
}
/** A fence of backticks longer than any run in `text`, so a file with fences of its own (a README) stays one block. */
export const fenceFor = (text: string) => '`'.repeat([...text.matchAll(/`{3,}/g)].reduce((n, m) => Math.max(n, m[0].length + 1), 3));

/**
 * A path as a project file name: "/" separators, no drive letter, no absolute, "." or ".." part; undefined when nothing
 * is left or a part holds a character no file system takes.
 */
export function safePath(raw: string): string | undefined {
  const parts = raw.trim().replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/|$)/, '').split('/').filter((s) => s && s !== '.' && s !== '..' && s !== '~');
  if (!parts.length || parts.some((s) => /[\x00-\x1f<>:"|?*]/.test(s))) return undefined;
  const p = parts.join('/');
  return p.length <= 300 ? p : undefined;
}

/** A token cut to the path in it: "(index.html):" gives index.html; "app/(site)/[slug].tsx" stays whole. */
function trimToken(t: string): string {
  const n = (s: string, c: string) => s.split(c).length - 1;
  for (let s = t; ;) {
    const before = s;
    s = s.replace(/[.:!?]+$/, '');
    if ((s.startsWith('(') && s.endsWith(')')) || (s.startsWith('[') && s.endsWith(']'))) s = s.slice(1, -1);
    if (s.startsWith('(') && n(s, '(') > n(s, ')')) s = s.slice(1);
    if (s.endsWith(')') && n(s, ')') > n(s, '(')) s = s.slice(0, -1);
    if (s.startsWith('[') && n(s, '[') > n(s, ']')) s = s.slice(1);
    if (s.endsWith(']') && n(s, ']') > n(s, '[')) s = s.slice(0, -1);
    if (s === before) return s;
  }
}

/** The file paths a line names, in order: "Create `app/(site)/page.tsx` and styles.css:" names both. */
function pathsIn(line: string): string[] {
  const out: string[] = [];
  for (const raw of line.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, ' $1 ').split(/[\s`*'"<>|,;]+/)) {
    if (!raw || raw.includes('://')) continue;
    const p = safePath(trimToken(raw));
    if (p && kindOfName(baseOf(p))) out.push(p);
  }
  return out;
}

/** The path a line names when it says nothing else: "package.json", "**app/page.tsx**", "### `README.md`", "File: .env.example". */
function pathLine(line: string | undefined): string | undefined {
  if (!line) return undefined;
  const s = line.replace(/[*`"']/g, '').trim().replace(/^(?:[>#+-]+\s*|\d+[.)]\s+)+/, '').replace(/^(?:file(?:name)?|path)\s*:\s*/i, '').replace(/\s*:$/, '');
  if (!s || /\s/.test(s)) return undefined;
  const p = pathsIn(s);
  return p.length === 1 ? p[0] : undefined;
}

// A first line that is only a comment naming the file: "// app/page.tsx", "<!-- index.html -->", "# Dockerfile".
const COMMENT = /^\s*(?:<!--|\/\/+|\/\*+|#|--|;)\s*(?:(?:file(?:name)?|path)\s*:\s*)?(\S+?)\s*(?:-->|\*\/)?\s*$/i;
function commentPath(line: string | undefined): string | undefined {
  const m = line && line.length <= 300 ? line.match(COMMENT) : null; // a minified first line names nothing
  const p = m ? pathsIn(m[1]) : [];
  return p.length === 1 ? p[0] : undefined;
}

// Products named like files: "Built with Next.js:" before a ```js block names no file.
const PRODUCT = /^(?:node|next|nuxt|vue|react|express|nest|three|d3|chart|alpine|ember|angular|solid|preact|gatsby|moment|day|anime|p5|pixi|leaflet)\.js$/i;

/** The file paths a text (a brief) names, each once, in order; products named like files ("Next.js") are not files. */
export function namedPaths(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).flatMap(pathsIn).filter((p) => !PRODUCT.test(baseOf(p))))];
}

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const DOC_START = /^\s*(<!doctype\s+html|<html[\s>])/i;
const DOC_END = /<\/html\s*>/i;

/**
 * A file that is an HTML document with no </html>: cut off before its end. A reply cut at the model's max_tokens
 * ended mid-tag ("<td>20</td></tr>\n      <"), and its games.html, 62% short, was attached and passed as whole.
 */
export function cutShort(name: string, text: string): boolean {
  return kindOfPath(name) === 'html' && DOC_START.test(text.slice(0, 2000).trimStart().split('\n', 1)[0] ?? '') && !DOC_END.test(text);
}

// What opens an inner fence: a language word (```bash, ```json:package.json), never code that starts with a run of
// backticks ("```</pre>" in a page that shows a fence).
const LANG_WORD = /^[A-Za-z][\w+#.:/-]*$/;

/**
 * The line that closes the fence opened at line `i` (lines.length when none does: the delivery was cut short there, so
 * the block is cut off, scan). A fence closes only on a run of its own character at least as long, alone on its line;
 * an inner fence of that character opened with a language is closed first, so a ```markdown README keeps its own
 * ```bash blocks.
 */
function closing(lines: string[], i: number, fence: string): number {
  const ch = fence[0], inner: number[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const m = lines[j].match(OPEN);
    if (!m || m[1][0] !== ch) continue;
    if (m[2].trim()) {
      if (LANG_WORD.test(m[2].trim().split(/\s+/)[0]) && !(ch === '`' && m[2].includes('`'))) inner.push(m[1].length);
    } else if (m[1].length >= (inner.at(-1) ?? fence.length)) {
      if (!inner.length) return j;
      inner.pop();
    }
  }
  return lines.length;
}

/**
 * `strong`: named by the block's own fence words, its first line, or a line before it that is only the path. Otherwise
 * a name comes from a mention in the line before ("the full page, index.html:"); `weak`: such a block is also short, so
 * it may be a piece of the file it names ("add this to your index.html:"). `cut`: the block or page never ends (its
 * fence never closes, or a page has no </html>): the reply was cut off, so it is never attached as a whole file.
 */
type Found = { kind: string; name?: string; text: string; from: number; to: number; short: boolean; strong: boolean; weak: boolean; cut: boolean }; // lines [from, to)

/** What a fenced block is: its kind and name, or undefined when it is no file. */
function fileOf(info: string, body: string[], prose: string | undefined): Omit<Found, 'text' | 'from' | 'to' | 'cut'> | undefined {
  const words = info.trim().slice(0, 300); // an info string is a language and a name; the rest is no name
  const lang = (words.split(/\s+/)[0] ?? '').toLowerCase().split(':')[0];
  const langKind = kindOf(lang);
  // The fence's own words after its language: ```tsx app/page.tsx, ```js title="next.config.mjs", ```json:package.json,
  // or a name in its place: ```index.html. A language that is also a file name (```dockerfile) names no file.
  const rest = langKind ? words.slice(lang.length) : words;
  const own = pathsIn(rest.replace(/\b(?:title|file(?:name)?|name|path)=/gi, ' ').replace(/:/g, ' '))[0];
  if (lang && !langKind && !own) return undefined; // ```diff, ```console: no file
  const strong = own ?? commentPath(body[0]) ?? pathLine(prose);
  const doc = DOC_START.test(body[0] ?? '');
  // An untagged fence is a file only when a path names it or it holds an HTML document.
  const kind = langKind ?? (strong ? kindOfName(baseOf(strong)) : undefined) ?? (doc ? 'html' : undefined);
  if (!kind) return undefined;
  const loose = strong ? undefined : pathsIn(prose ?? '').filter((p) => family(kindOfName(baseOf(p))!) === family(kind) && !PRODUCT.test(baseOf(p))).at(-1);
  const name = strong ?? loose;
  if (!name && NAMED_ONLY.has(kind)) return undefined;
  const short = body.length < MIN_LINES && body.join('\n').length < SNIPPET_CHARS && !doc;
  if (short && !name) return undefined;
  return { kind, name, short, strong: !!strong, weak: short && !strong };
}

/** The files in one text: fenced blocks of a known kind, and an unfenced HTML document. */
function scan(lines: string[]): Found[] {
  const out: Found[] = [];
  let prose: string | undefined; // the nearest non-empty line before here outside a file
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(OPEN);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      let j = closing(lines, i, open[1]);
      let body = lines.slice(i + 1, j);
      const f = fileOf(open[2], body, prose);
      let cut = j === lines.length;
      if (f && DOC_START.test(body[0] ?? '')) {
        // A page whose fence never closes but which ends (</html>) is whole: only its closing fence is missing, and
        // what follows the page is the reply's text again. A page with no </html> is cut off, fence or not.
        const end = cut ? body.findLastIndex((l) => DOC_END.test(l)) : -1;
        if (end >= 0) { body = body.slice(0, end + 1); j = i + end + 1; cut = false; }
        else cut ||= !body.some((l) => DOC_END.test(l));
      }
      if (f) out.push({ ...f, text: body.join('\n'), from: i, to: Math.min(j + 1, lines.length), cut });
      prose = undefined; // the line before a block names that block, never the next one
      i = j;
      continue;
    }
    if (DOC_START.test(lines[i])) {
      let j = i;
      while (j < lines.length && !DOC_END.test(lines[j])) j++;
      const to = Math.min(j + 1, lines.length);
      const strong = pathLine(prose);
      const name = strong ?? pathsIn(prose ?? '').filter((p) => kindOfName(baseOf(p)) === 'html').at(-1);
      out.push({ kind: 'html', name, text: lines.slice(i, to).join('\n').trim(), from: i, to, short: false, strong: !!strong, weak: false, cut: j === lines.length });
      i = to - 1;
      prose = undefined;
      continue;
    }
    if (lines[i].trim()) prose = lines[i].length <= 300 ? lines[i] : undefined;
  }
  return out;
}

/**
 * A name for a nameless block when its content makes it plain which file it is (package.json, next.config.mjs). The
 * text is an agent's: no pattern here rescans to the end from every place it could start.
 */
function contentName(kind: string, text: string): string | undefined {
  if (kind === 'json' && /^\s*\{/.test(text)) {
    if (/"name"\s*:/.test(text) && /"(?:dependencies|devDependencies|scripts)"\s*:/.test(text)) return 'package.json';
    if (/"compilerOptions"\s*:/.test(text)) return 'tsconfig.json';
  }
  if (['js', 'mjs', 'cjs', 'ts'].includes(kind)) {
    const ext = kind !== 'js' ? kind : /^[ \t]*(?:import|export)\s/m.test(text) ? 'mjs' : 'js';
    if (/import\(\s*['"]next['"]\s*\)\.NextConfig|\bnextConfig\b/.test(text)) return `next.config.${ext}`;
    if (/postcss-load-config|plugins\s*:\s*\{[^}]{0,500}\b(?:tailwindcss|autoprefixer)\b/.test(text)) return `postcss.config.${ext}`;
    if (/['"]tailwindcss['"]/.test(text) && /\bcontent\s*:/.test(text)) return `tailwind.config.${ext}`;
    if (/from\s+['"]vite['"]/.test(text) && /\bdefineConfig\b/.test(text)) return `vite.config.${ext}`;
  }
  if (kind === 'dockerfile') return 'Dockerfile';
  if (kind === 'gitignore') return '.gitignore';
  if (kind === 'env') return '.env.example'; // Rook never delivers secrets: an env file is the example to copy
  if (kind === 'prisma' && /\b(?:datasource|generator)\s+\w+\s*\{/.test(text)) return 'prisma/schema.prisma';
  return undefined;
}

// What a page links that it needs to look right or work: its stylesheets, scripts and frames.
const RESOURCE_TAG = /^<(?:link|script|iframe)\b/i;
/**
 * The project files a page loads by a relative href or src ("styles.css", "../js/app.js"), resolved from the page's
 * own folder; links to other sites, anchors and templated values are left out.
 * ponytail: page links (<a href>) and media are not counted: a footer link to a privacy.html nobody asked for would
 * fail a whole site, and an agent can't send an image as text.
 */
export function localLinks(html: string, from: string): string[] {
  const dir = from.slice(0, from.lastIndexOf('/') + 1).split('/').filter(Boolean);
  const out = new Set<string>();
  // One forward scan from "<" to ">": linear on any input, as reference.ts's patterns.
  for (let i = 0; (i = html.indexOf('<', i)) >= 0;) {
    const end = html.indexOf('>', i);
    if (end < 0) break;
    const tag = html.slice(html.lastIndexOf('<', end), end + 1); // "<<script ...>" is a script tag, as in a browser
    i = end + 1;
    if (!RESOURCE_TAG.test(tag)) continue;
    for (const m of tag.matchAll(/\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      const ref = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(ref) || /\{\{|\{%|\$\{|<%/.test(ref)) continue; // templated: {{ url }}, ${base}
      let path = ref.split(/[?#]/)[0];
      try { path = decodeURIComponent(path); } catch { /* kept as written */ }
      const parts = path.startsWith('/') ? [] : [...dir];
      let inside = true;
      for (const s of path.split('/')) {
        if (s === '..') inside = parts.pop() !== undefined && inside;
        else if (s && s !== '.') parts.push(s);
      }
      if (inside && parts.length) out.add(parts.join('/'));
    }
  }
  return [...out];
}

// ---- Placeholders, code left out, install scripts ----

// "[Your email]", "[Startup name]", "[Feature 1]", "[Photo of simit]", "[Tagline: ...]", "[Price]", "[TBD]": in prose
// or markup, a bracketed span is a placeholder the user must replace, unless it is something else in brackets. QA found
// 4 of 28 listed: "[Startup name]" and "[Contact email]" were missed for not capitalising every word, "[Feature 1]"
// for its digit. Not a placeholder: a link ("[text](url)"), a reference ("[text][ref]", "[1]: url"), an index or a path
// segment ("tiers[0]", "app/[slug]"), an image ("![alt]"), a wiki link ("[[Page]]"), a quoted list, Rook's own
// "[file ...]" marker, an editor's note ("[sic]"), or code ("[a, b]", "[A-Z]", "[ -f .env ]", "[...items]").
const BRACKETED = /(?<![\w\])!\\/[])\[([^\[\]\n"'`]{2,80})\](?![(\[:])/g;
const ASKS = /^(?:your|my|our|insert|add|replace|enter|put|placeholder|todo|tbd|tbc|e\.g\.)\b/i;
const MARKS = /\b(?:placeholder|goes here|here|tbd|to be confirmed|lorem)\b/i;
const FACT = /\b(?:name|e-?mail|phone|address|company|business|city|country|date|year|url|link|price|logo|photo|image|picture|title|number|testimonial|quote|client|customer|role|position|project|brand|product|amount|username|handle|website|location)s?\b/i;
const NOTE = /^(?:(?:sic|citation needed|emphasis added|info|warn|warning|error|debug|ok)$|(?:sources?|via|see|ref|cf|note)\b)/i;
// Who the work is for and how to reach them: listed first, so the 8 shown never leave out "[Startup name]".
const IDENTITY = /\b(?:e-?mail|phone|tel|telephone|address|contact|website|domain|url|handle|username|logo|city|location)s?\b|\b(?:your|my|our|full|first|last|company|business|startup|brand|shop|store|restaurant|caf[eé]|owner|founder)\s+name\b|^(?:name|company|business|startup|brand)$/i;
const PROSE_KINDS = new Set(['md', 'mdx', 'txt']);
const MARKUP_KINDS = new Set(['html', 'svg', 'xml', 'vue', 'svelte', 'php']);
type Context = 'prose' | 'markup' | 'code';

/** Prose without its fenced blocks and inline code: a README's `[ -f .env ]` is shell, not a placeholder. */
function proseOnly(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(OPEN);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null; continue; }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) { fence = m[1]; continue; }
    out.push(line.replace(/`[^`\n]*`/g, ' '));
  }
  return out.join('\n');
}

/** Markup without what its <script> and <style> elements hold: a page's script arrays and attribute selectors are code. */
function markupOnly(text: string): string {
  const open = /<(script|style)\b/gi;
  let out = '', at = 0;
  for (let m; (m = open.exec(text));) {
    out += text.slice(at, m.index);
    const close = new RegExp(`</${m[1]}`, 'gi');
    close.lastIndex = open.lastIndex;
    const c = close.exec(text);
    if (!c) return out;
    at = open.lastIndex = c.index;
  }
  return out + text.slice(at);
}

/**
 * Whether bracketed `raw` is a placeholder. In code (scripts, styles, configs) only a capitalised phrase, or a fact
 * word ("[Price]"), counts: `[name]`, `[Item]` and a "[Unit]" section line are code there. `alone`: the span is its line.
 */
function placeholder(raw: string, context: Context, alone: boolean): boolean {
  const c = raw.trim().replace(/^[*_]+|[*_]+$/g, '').trim(); // "[**Your name**]"
  if (c.length < 2 || /^file\s/i.test(c)) return false;
  if (ASKS.test(c) || MARKS.test(c)) return true;
  if (NOTE.test(c) || !/\p{L}/u.test(c)) return false; // "[sic]", "[1]", "[2026-11-10]"
  if (/[=;{}<>\\|^~*]|\.\.\.|^[-.:/]/.test(c)) return false; // "[a=b]", "[...xs]", "[^\d]", "[ -f x ]"
  if (/(?:^|[^\p{L}\p{N}])[\p{L}\p{N}]-[\p{L}\p{N}](?![\p{L}\p{N}])/u.test(c)) return false; // a range: "[A-Z]"
  const multi = /\s/.test(c);
  const names = c.includes(',') && c.split(',').every((p) => /^\s*[A-Za-z_$][\w$.]*\s*$/.test(p)); // "[a, b]"
  const word = /^[\p{L}\p{N}][\p{L}\p{N}'’/-]*$/u.test(c); // one plain word: not "[Symbol.iterator]" or "[key:value]"
  if (context === 'code') {
    if (alone || names) return false;
    return multi ? /^\p{Lu}/u.test(c) && !/[()]/.test(c) : word && /^\p{Lu}/u.test(c) && FACT.test(c);
  }
  if (names && c.split(',').every((p) => /^\s*[a-z_$]/.test(p))) return false; // "[count, setCount]"
  return multi || (word && (/^\p{Lu}/u.test(c) || FACT.test(c))); // "[Startup name]", "[Price]", "[email]"
}

/** The span from `i` to `end` is all its line holds (looked at within 200 characters each way: a long line never is). */
function aloneOnLine(s: string, i: number, end: number): boolean {
  const back = s.slice(Math.max(0, i - 200), i), nl = back.lastIndexOf('\n');
  const head = nl >= 0 ? back.slice(nl + 1) : i <= 200 ? back : 'x';
  return !head.trim() && /^[ \t]*(?:\r?\n|$)/.test(s.slice(end, end + 200));
}

/**
 * The placeholders the user must replace in a text, each once: who it is for and how to reach them first, then the
 * rest in order; "lorem ipsum" filler counts too. `name`: the file it is (its kind decides what is code); none for a
 * delivery's own text, read as prose.
 */
export function placeholdersIn(text: string, name?: string): string[] {
  const k = (name === undefined ? undefined : kindOfPath(name)) ?? 'txt';
  const context: Context = PROSE_KINDS.has(k) ? 'prose' : MARKUP_KINDS.has(k) ? 'markup' : 'code';
  const read = context === 'prose' ? proseOnly(text) : context === 'markup' ? markupOnly(text) : text;
  const out = new Set<string>();
  for (const m of read.matchAll(BRACKETED)) {
    const c = m[1].trim();
    if (placeholder(c, context, context === 'code' && aloneOnLine(read, m.index, m.index + m[0].length))) out.add(`[${c}]`);
  }
  const found = [...out], who = (p: string) => IDENTITY.test(p.slice(1, -1));
  const sorted = [...found.filter(who), ...found.filter((p) => !who(p))];
  if (/\blorem ipsum\b/i.test(text)) sorted.push('lorem ipsum filler text');
  return sorted;
}

// Words a model writes where it left code out: a file holding one is not whole.
const LEFT_OUT: [RegExp, boolean][] = [ // [pattern, also in a prose file (README, notes)]
  [/\brest of (?:the |this |your )?(?:code|file|page|markup|styles?|component|implementation|functions?|content|logic)\b/i, false],
  [/(?:\.{3}|…)[ \t]*(?:existing|unchanged|previous|same|other|remaining)\b/i, true],
  [/\b(?:existing|unchanged|remaining|previous) (?:code|content|styles?|markup|logic|sections?)[ \t]*(?:here|\.{3}|…|stays|remains|unchanged|as before|omitted)/i, true],
  [/\b(?:code|content|styles?|markup|logic|sections?|functions?|components?)[ \t]+(?:unchanged|stay the same|stays the same|remain the same|remains the same|as before)\b/i, false],
  [/\bTODO:?[ \t]*implement\b/i, true],
  [/\b(?:omitted|truncated|elided|shortened) for (?:brevity|length|space|clarity)\b/i, true],
  [/\b(?:code|content|implementation|markup) (?:omitted|truncated|elided)\b/i, true],
  [/\b(?:same|unchanged) as (?:before|above|the original|in the original)\b/i, false],
];
// A line that is only an ellipsis, bare or in a comment ("// ...", "<!-- ... -->", "{/* ... */}"). Python stubs use
// "..." as code, and prose uses it as punctuation.
const ELLIPSIS_LINE = /^[ \t]*(?:(?:\/\/|#|\/\*|<!--|\{\/\*)[ \t]*)?(?:\.{3}|…)[ \t]*(?:(?:\*\/\}?|-->)[ \t]*)?$/m; // no two space runs side by side
const PROSE = /\.(?:md|mdx|markdown|txt)$/i;

/** Where the file at `name` says code was left out (the line, cut short), or undefined when it reads as whole. */
export function leftOut(text: string, name: string): string | undefined {
  const prose = PROSE.test(name);
  for (const [re, inProse] of LEFT_OUT) {
    if (prose && !inProse) continue;
    const m = re.exec(text);
    if (m) return lineAt(text, m.index);
  }
  if (prose || /\.pyi?$/i.test(name)) return undefined;
  const m = ELLIPSIS_LINE.exec(text);
  return m ? m[0].trim() : undefined;
}
const lineAt = (text: string, i: number) => text.slice(text.lastIndexOf('\n', i) + 1, (text.indexOf('\n', i) + 1 || text.length + 1) - 1).trim().slice(0, 120);

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
/** The scripts a delivered package.json runs on `npm install` (preinstall, install, postinstall, prepare). */
export function installScripts(files: { name: string; text: string }[]): { name: string; script: string; command: string }[] {
  const out: { name: string; script: string; command: string }[] = [];
  for (const f of files) {
    if (baseOf(f.name).toLowerCase() !== 'package.json') continue;
    let scripts: any;
    try { scripts = JSON.parse(f.text)?.scripts; } catch {
      // Not valid JSON (comments, a trailing comma): npm refuses it, but the user may fix it and run it.
      scripts = Object.fromEntries([...f.text.matchAll(/"(preinstall|install|postinstall|prepare)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]));
    }
    for (const s of INSTALL_SCRIPTS) if (typeof scripts?.[s] === 'string') out.push({ name: f.name, script: s, command: scripts[s].slice(0, 120) });
  }
  return out;
}

// ---- Attaching ----

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-+|-+$/g, '');
const lineCount = (text: string) => text.split('\n').length;

/**
 * The input path a delivered file stands for: the one it names (in any case), else the only one with its base name
 * ("portfolio/index.html" for index.html). An agent that put the page in a folder left the chat with two index.html
 * files, and the next edit worked on the old one.
 */
export function onInputs(name: string, inputs: string[]): string | undefined {
  const lc = name.toLowerCase(), base = baseOf(lc);
  const same = inputs.filter((p) => p.toLowerCase() === lc);
  if (same.length) return same[0];
  const by = [...new Set(inputs.filter((p) => baseOf(p).toLowerCase() === base))];
  return by.length === 1 ? by[0] : undefined;
}

const CUT_OFF = 'cut off before its end';

/**
 * Takes the code files out of the merged deliveries, in order. A file is named by the path the delivery states next to
 * it (the fence's info string, its first-line comment, or the line before it: the path alone, or a mention of a file
 * of its kind), else from its content when that is plain (package.json), else by the one file a page in the part
 * loads that nothing else is named (styles.css), else by the one file of its kind the part edits or is asked for that
 * the delivery doesn't name (index.html for a page in a bare ```html block), else from its part's title. A file named
 * like one the part edits but in another folder is that file (onInputs). Within one part a path written twice is one
 * file: its last whole version is attached and an earlier one gets a note. A file the part edits that a later part
 * edits again (the runner applies them in order) is that later part's: only its version is attached. Paths are unique
 * across the result (index-2.html for a second part's index.html). A block cut off before its end (its fence never
 * closes, or a page has no </html>) is never attached, nor is a file over FILE_MAX_BYTES or past FILES_MAX_BYTES in
 * all: each is left out and listed.
 */
export function attachFiles(deliveries: Delivery[]): Attached {
  const texts = new Map<string, string>();
  const files: DeliveredFile[] = [];
  const unattached: Unattached[] = [];
  const placeholders: Placeholders[] = [];
  const taken = new Set<string>();
  let total = 0;
  const unique = (want: string) => {
    const slash = want.lastIndexOf('/'), dot = want.lastIndexOf('.');
    const cut = dot > slash + 1 ? dot : want.length; // "Dockerfile" and ".env" have no extension to keep at the end
    let name = want;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${want.slice(0, cut)}-${n}${want.slice(cut)}`;
    taken.add(name.toLowerCase());
    return name;
  };
  // CRLF too: in an agent's \r\n reply every fence line ended in \r, so no file was found.
  const scanned = deliveries.map((d) => { const lines = d.text.split(/\r?\n/); return { d, lines, found: scan(lines) }; });
  // A short block named only by a mention yields that name to any other block with it (by its last part, anywhere in
  // the result) and stays in the text as a snippet: "add this line to your index.html:" pushed the page to index-2.html.
  const named = new Map<string, number>();
  for (const f of scanned.flatMap((x) => x.found)) if (f.name) named.set(baseOf(f.name).toLowerCase(), (named.get(baseOf(f.name).toLowerCase()) ?? 0) + 1);
  const parts = scanned.map(({ d, lines, found: all }) => {
    let found = all.filter((f) => !(f.weak && named.get(baseOf(f.name!).toLowerCase())! > 1));
    // The same path twice in one part: the last whole version is the file. A short piece of it (a line to add) stays in
    // the text, and an earlier whole version is noted where it was.
    const last = new Map<string, Found>();
    for (const f of found) if (f.name && (!f.short || !last.get(f.name.toLowerCase()) || last.get(f.name.toLowerCase())!.short)) last.set(f.name.toLowerCase(), f);
    found = found.filter((f) => !f.name || last.get(f.name.toLowerCase()) === f || !f.short);
    const earlier = new Map(found.filter((f) => f.name && last.get(f.name.toLowerCase()) !== f).map((f) => [f, last.get(f.name!.toLowerCase())!]));
    for (const f of found) f.name ??= contentName(f.kind, f.text);
    const has = (p: string) => found.some((f) => f.name?.toLowerCase() === p.toLowerCase());
    // A file the part edits, given back in another folder, is that file; never when the delivery also gives it by name.
    const inputs = d.inputs ?? [];
    for (const f of found) {
      const p = f.name && !f.short && !earlier.has(f) ? onInputs(f.name, inputs) : undefined;
      if (p && p !== f.name && !has(p)) f.name = p;
    }
    // A nameless stylesheet or script takes the name of the one file of its kind a page here loads that no block is
    // named. Then a nameless file takes the name of the one file of its kind the part edits or is asked for that the
    // delivery doesn't give (the page's own links first: they are what it needs).
    const expected = [...new Set([...inputs, ...(d.paths ?? [])])];
    const paths = new Set(found.filter((f) => f.name).map((f) => f.name!));
    const wanted = found.filter((f) => f.kind === 'html').flatMap((f) => localLinks(f.text, f.name ?? '')).filter((p) => !paths.has(p));
    for (const from of [wanted, expected]) {
      for (const fam of new Set(found.filter((f) => !f.name).map((f) => family(f.kind)))) {
        const blocks = found.filter((f) => !f.name && family(f.kind) === fam);
        const open = [...new Set(from.filter((p) => family(kindOfPath(p) ?? '') === fam && !has(p)))];
        if (blocks.length === 1 && open.length === 1) blocks[0].name = open[0];
      }
    }
    return { d, lines, found, earlier };
  });
  // A file a part edits that a later part edits again: the later version is the file (it started from this one).
  const lastEdit = new Map<string, number>();
  parts.forEach(({ d, found, earlier }, k) => {
    for (const f of found) if (f.name && !f.cut && !earlier.has(f) && onInputs(f.name, d.inputs ?? []) === f.name) lastEdit.set(f.name.toLowerCase(), k);
  });
  parts.forEach(({ d, lines, found, earlier }, k) => {
    const out: string[] = [], inFiles: Placeholders[] = [];
    let at = 0;
    for (const f of found) {
      const n = lineCount(f.text);
      const size = `${n} line${n === 1 ? '' : 's'}`;
      out.push(...lines.slice(at, f.from));
      at = f.to;
      const later = earlier.get(f);
      if (later) { out.push(`[file ${f.name}, ${size}, not attached: a later version of it in this part ${later.cut ? 'replaces it' : 'is attached'}]`); continue; }
      if (f.name && (lastEdit.get(f.name.toLowerCase()) ?? k) > k && onInputs(f.name, d.inputs ?? []) === f.name) {
        out.push(`[file ${f.name}, ${size}, not attached: a later part changes it again, and that version is attached]`);
        continue;
      }
      const want = f.name ?? `${slug(d.title) || d.subtask_id}.${f.kind}`;
      // Cut off: listed, never attached, and its path stays free for a whole version.
      const bytes = Buffer.byteLength(f.text, 'utf8');
      const why = f.cut ? CUT_OFF : bytes > FILE_MAX_BYTES ? 'larger than 1 MB' : total + bytes > FILES_MAX_BYTES ? 'the files together pass 3 MB' : null;
      const name = f.cut ? want : unique(want);
      if (why) unattached.push({ name, title: d.title, why });
      else {
        total += bytes;
        files.push({ subtask_id: d.subtask_id, agent_handle: d.agent_handle, name, mime: MIME[kindOfName(baseOf(name)) ?? f.kind] ?? MIME[f.kind] ?? 'text/plain', text: f.text });
        const p = placeholdersIn(f.text, name);
        if (p.length) inFiles.push({ title: d.title, name, found: p });
      }
      out.push(why ? `[file ${name}, ${size}, not attached: ${why}]` : `[file ${name}, ${size}, attached below the report]`);
    }
    out.push(...lines.slice(at));
    const text = found.length ? out.join('\n').trim() : d.text;
    texts.set(d.subtask_id, text);
    const p = placeholdersIn(text);
    placeholders.push(...(p.length ? [{ title: d.title, found: p }] : []), ...inFiles);
  });
  return { texts, files, unattached, placeholders };
}

/** A gap line for a file left out, in the report's words. */
export const unattachedLine = (u: Unattached) => `File ${u.name} from "${u.title}": not attached, ${u.why}`;

const PLACEHOLDERS_SHOWN = 8;
/**
 * What the report's Gaps must name besides the parts not delivered: each file left out, the placeholders the user must
 * replace (an agent told to use placeholders, or one that made do without a fact), and each script a package.json runs
 * on npm install, to review before running it.
 */
export function fileGaps(a: Attached): string[] {
  const where = (p: Placeholders) => (p.name ? `in ${p.name} from "${p.title}"` : `in "${p.title}"`);
  const more = (n: number) => (n > PLACEHOLDERS_SHOWN ? ` and ${n - PLACEHOLDERS_SHOWN} more` : '');
  return [
    ...a.unattached.map(unattachedLine),
    ...a.placeholders.map((p) => `Placeholders to replace ${where(p)}: ${p.found.slice(0, PLACEHOLDERS_SHOWN).join(', ')}${more(p.found.length)}`),
    ...installScripts(a.files).map((s) => `${s.name} runs a script on npm install ("${s.script}": "${s.command}"): review it before running npm install`),
  ];
}
