// A delivery's files as a project: its folder tree, its paths in a zip, whether its pages can be previewed here, how
// to run it when they can't, and a web page's preview with the delivered files it uses put inline. Pure functions, so
// the page and the tests both use them. Run: npx tsx --test test/*.test.ts (from web/)
import { isHtml, reportBlocks } from '@/lib/report';

export type ProjectFile = { name: string; mime: string; text: string };

/** A delivered path's folders and name: "/" or "\" separated, with no empty, "." or ".." part (a stray one is dropped). */
export const segments = (path: string) => path.split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..');
const norm = (path: string) => segments(path).join('/');
const baseName = (path: string) => segments(path).at(-1) ?? path;

export type TreeNode =
  | { kind: 'folder'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string; index: number }; // index: the file's place in the delivered list

/**
 * The folder tree of the delivered paths. In each folder its folders come first, in the order they first appear, then
 * its files in the order they were delivered (an agent tends to list index.html or README.md first).
 */
export function fileTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  paths.forEach((p, index) => {
    const parts = segments(p);
    const name = parts.pop() ?? p;
    let level = root, at = '';
    for (const s of parts) {
      at = at ? `${at}/${s}` : s;
      let folder = level.find((n) => n.kind === 'folder' && n.name === s) as Extract<TreeNode, { kind: 'folder' }> | undefined;
      if (!folder) level.push(folder = { kind: 'folder', name: s, path: at, children: [] });
      level = folder.children;
    }
    level.push({ kind: 'file', name, path: p, index });
  });
  const order = (nodes: TreeNode[]): TreeNode[] => [
    ...nodes.filter((n) => n.kind === 'folder').map((n) => ({ ...n, children: order((n as Extract<TreeNode, { kind: 'folder' }>).children) })),
    ...nodes.filter((n) => n.kind === 'file'),
  ];
  return order(root);
}

/** One folder or file name as every file system takes it: no control or reserved characters, no trailing dot or space. */
// eslint-disable-next-line no-control-regex
const safeSegment = (s: string) => s.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[\s.]+$/, '').slice(0, 120);

/**
 * Each file's path inside the project zip: its folders kept ("app/pricing/page.tsx") and a leading dot too
 * (".env.example"), never absolute or above the project. Two files with one path (any case, as Windows sees them):
 * the later one is "page-2.tsx".
 */
export function zipPaths(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((n) => {
    const path = segments(n).map(safeSegment).filter(Boolean).join('/') || 'file.txt';
    let out = path;
    for (let i = 2; taken.has(out.toLowerCase()); i++) out = path.replace(/(\.[^./]+)?$/, (ext) => `-${i}${ext}`);
    taken.add(out.toLowerCase());
    return out;
  });
}

/** The zip's own name: the task's words, cut short, as a file name ("make-me-a-portfolio-website.zip"). */
export function zipName(title: string | undefined): string {
  const slug = (title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return `${slug || 'project'}.zip`;
}

/** An SVG image: shown as an image, never as a page, so its scripts never run. */
export const isSvg = (f: { name: string; mime: string }) => /^\s*image\/svg\+xml\b/i.test(f.mime) || /\.svg$/i.test(f.name);

/**
 * A project that only runs on a computer with its own tools (it has a package.json, or a Next.js config): its pages
 * can't be previewed here. `steps`: how to run it, from its README's run section, else from its package.json scripts;
 * null when neither says.
 */
export type Project = {
  kind: 'next' | 'express' | 'vite' | 'node';
  words: string; // "a Next.js app"
  steps: { from: 'readme'; markdown: string } | { from: 'scripts'; commands: string[] } | null;
};

const depth = (p: string) => segments(p).length;
const shallowest = (files: ProjectFile[], test: (base: string) => boolean) =>
  files.filter((f) => test(baseName(f.name))).sort((a, b) => depth(a.name) - depth(b.name))[0];

type PackageJson = { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };

export function projectOf(files: ProjectFile[]): Project | null {
  const pkgFile = shallowest(files, (b) => b === 'package.json');
  const nextConfig = shallowest(files, (b) => /^next\.config\.(js|mjs|cjs|ts)$/.test(b));
  if (!pkgFile && !nextConfig) return null;
  let pkg: PackageJson = {};
  try { const p = pkgFile ? JSON.parse(pkgFile.text) : {}; if (p && typeof p === 'object') pkg = p; } catch { /* a broken package.json still marks a project */ }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const kind: Project['kind'] = 'next' in deps || nextConfig ? 'next' : 'express' in deps ? 'express' : 'vite' in deps ? 'vite' : 'node';
  const words = { next: 'a Next.js app', express: 'an Express server', vite: 'a Vite app', node: 'a Node.js project' }[kind];
  const readme = shallowest(files, (b) => /^readme(\.md|\.markdown|\.txt)?$/i.test(b));
  const fromReadme = readme ? readmeSteps(readme.text) : null;
  const commands = pkgFile ? scriptSteps(pkg, files, pkgFile.name) : null;
  // A README whose steps never start the project (QA: an Express API's run steps were only "npm install") gives way to
  // the package.json scripts, which do.
  const readmeWins = !!fromReadme && (STARTS.test(fromReadme) || !commands);
  return { kind, words, steps: readmeWins ? { from: 'readme', markdown: fromReadme! } : commands ? { from: 'scripts', commands } : null };
}

/** A heading that starts the part of a README about running the project. */
const RUN_HEADING = /\b(getting started|quick ?start|run(ning)?|start(ing)?|set ?up|install(ation|ing)?|usage|develop(ment)?|local(ly)?)\b/i;
/** A command that starts the project, not only installs it. */
const STARTS = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\bnode\s+\S|\bnpx\s+\S|\b(?:next|vite)\s+(?:dev|start|preview)\b/;

/**
 * The README's section on running the project, as written, up to its next heading of the same level or above; a run
 * section right after it at the same level ("## Install", then "## Start") is part of it, under its own name. Null when
 * the README has none.
 */
export function readmeSteps(markdown: string): string | null {
  const blocks = reportBlocks(markdown);
  let level = 0;
  const out: string[] = [];
  for (const b of blocks) {
    const h = b.kind === 'line' ? b.text.match(/^ {0,3}(#{1,6})\s+(.*)$/) : null;
    if (level) {
      if (h && h[1].length <= level) {
        if (h[1].length === level && RUN_HEADING.test(h[2])) { out.push(`${h[2].replace(/\s+#+\s*$/, '').trim()}:`); continue; }
        break;
      }
      out.push(b.kind === 'code' ? `\`\`\`${b.lang}\n${b.text}\n\`\`\`` : b.text);
    } else if (h && RUN_HEADING.test(h[2])) level = h[1].length;
  }
  const text = out.join('\n').trim();
  return text ? text.split('\n').slice(0, 60).join('\n') : null;
}

/**
 * The files a report marks as changed by its message (final_result.changed, the paths it delivered new or changed), and
 * a line that says so. None for a report that doesn't say (older ones), nor for a first build, where every file is new
 * and there is nothing to tell apart. `edit`: a part of this message edits the chat's files (its plan's inputs).
 */
export function changedFiles(names: string[], changed: string[] | undefined, edit: boolean): { marked: Set<string>; line: string | null } {
  if (changed === undefined) return { marked: new Set(), line: null };
  const marked = new Set(changed.filter((c) => names.includes(c)));
  if (!edit && marked.size === names.length) return { marked: new Set(), line: null };
  if (!marked.size) return { marked, line: "This message didn't change any of these files." };
  const rest = names.length - marked.size;
  const others = rest === 0 ? '' : rest === 1 ? '; the other file is as it was' : `; the other ${rest} are as they were`;
  return { marked, line: `This message changed or added ${marked.size === 1 ? 'one file' : `${marked.size} files`}, marked “Changed”${others}.` };
}

/**
 * The commands that run the project, from its package.json scripts: install, then dev (or build and start, or start),
 * with the package manager its lockfile names, from the package's own folder. Null when it has no script to run.
 */
export function scriptSteps(pkg: PackageJson, files: ProjectFile[], pkgPath: string): string[] | null {
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const has = (s: string) => typeof scripts[s] === 'string';
  const lock = (b: string) => files.some((f) => baseName(f.name) === b);
  const pm = lock('pnpm-lock.yaml') ? 'pnpm' : lock('yarn.lock') ? 'yarn' : lock('bun.lockb') || lock('bun.lock') ? 'bun' : 'npm';
  const run = (s: string) => (pm === 'npm' ? (s === 'start' ? 'npm start' : `npm run ${s}`) : `${pm} ${s}`);
  const go = has('dev') ? [run('dev')] : has('start') ? (has('build') ? [run('build'), run('start')] : [run('start')]) : null;
  if (!go) return null;
  const folder = segments(pkgPath).slice(0, -1).join('/');
  return [...(folder ? [`cd ${folder}`] : []), `${pm} install`, ...go];
}

/**
 * A reference in a page ("css/style.css", "../img/logo.svg", "/about.html") as a delivered path, from the folder the
 * page is in; null for a link elsewhere (another site, mailto:, data:) or to the page itself ("#team").
 */
export function resolveRef(from: string, ref: string): string | null {
  const bare = ref.trim().replace(/[?#].*$/s, '');
  if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith('//')) return null;
  let path: string;
  try { path = decodeURIComponent(bare); } catch { path = bare; }
  const out = path.startsWith('/') ? [] : segments(from).slice(0, -1);
  for (const s of path.split('/')) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return out.join('/') || null;
}

/** Delivered files by path, as references look them up (case aside, as most hosts serve them). */
type Index = Map<string, ProjectFile>;
const indexOf = (files: ProjectFile[]): Index => new Map(files.map((f) => [norm(f.name).toLowerCase(), f]));

/** The delivered file a reference names: from the page's folder, or for "/x" from the project's top or the page's folder. */
function lookup(index: Index, from: string, ref: string): ProjectFile | undefined {
  const at = resolveRef(from, ref);
  if (at === null) return undefined;
  const site = segments(from).slice(0, -1).join('/');
  const tries = ref.trim().startsWith('/') && site ? [at, `${site}/${at}`] : [at];
  for (const t of tries) { const f = index.get(t.toLowerCase()); if (f) return f; }
  return undefined;
}

/**
 * The delivered page a link in the preview leads to (`from`: the page shown), or null when it leads elsewhere. A folder
 * link ("blog/", "/") leads to its index.html, and "about" to about.html.
 */
export function navTarget(files: ProjectFile[], from: string, href: string): string | null {
  const bare = href.trim().replace(/[?#].*$/s, '');
  if (!bare) return null;
  const index = indexOf(files);
  const tries = bare.endsWith('/') ? [`${bare}index.html`] : [bare, `${bare}/index.html`, `${bare}.html`];
  for (const t of tries) {
    const f = lookup(index, from, t);
    if (f && isHtml(f)) return f.name;
  }
  return null;
}

/** A message from the preview frame asking to show another page, or null for anything else it may post. */
export function navRequest(data: unknown): string | null {
  const d = data as { type?: unknown; path?: unknown } | null;
  return d && typeof d === 'object' && d.type === 'rook-preview-nav' && typeof d.path === 'string' && d.path.length <= 2000 ? d.path : null;
}

const svgUri = (text: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text).replace(/'/g, '%27')}`;
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, 'i'));
  return m ? m[1] ?? m[2] ?? m[3] ?? '' : null;
};
const hasAttr = (attrs: string, name: string) => new RegExp(String.raw`\s${name}(\s|=|$)`, 'i').test(` ${attrs}`);
// Inline text can't end the element it is put in: "</script" inside a script, "</style" inside a style. A backslash
// before the slash changes nothing in JavaScript strings or CSS, and "<\!--" nothing in a JavaScript string.
const scriptText = (s: string) => s.replace(/<\/(script)/gi, String.raw`<\/$1`).replace(/<!--/g, String.raw`<\!--`);
const styleText = (s: string) => s.replace(/<\/(style)/gi, String.raw`<\/$1`);

/** url(...) in CSS that names a delivered SVG, as that image inline; `from`: the CSS file's path (or the page's). */
function inlineCssUrls(css: string, index: Index, from: string): string {
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, (whole, d, s, u) => {
    const f = lookup(index, from, d ?? s ?? u ?? '');
    return f && isSvg(f) ? `url("${svgUri(f.text)}")` : whole;
  });
}

/**
 * Runs first in the preview frame. Links don't navigate it: a link to another delivered page asks the page that holds
 * the frame to show that one ({type: 'rook-preview-nav', path}: the href as written), which accepts it only from this
 * frame; a link to a #section scrolls as usual; forms don't send. Once the page has loaded (its own trusted load event,
 * once), it says so with `nonce` ({type: 'rook-preview-ready', nonce}): the holder takes a load of the frame with no
 * such word as the page having gone elsewhere (frameLoad). The script removes itself before the page's own scripts
 * run, so they can't read the nonce and hand it to the page they go to; it keeps what it needs (parent, the document)
 * from before they can touch them.
 */
export function navScript(nonce: string): string {
  const n = nonce.replace(/[^0-9a-z]/gi, '');
  return `<script>(function(){var P=parent,D=document,N='${n}',done=false,me=D.currentScript;if(me&&me.parentNode)me.parentNode.removeChild(me);`
    + `window.addEventListener('load',function(e){if(done||!e.isTrusted||e.target!==D)return;done=true;P.postMessage({type:'rook-preview-ready',nonce:N},'*')});`
    + `D.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';if(h.charAt(0)==='#')return;e.preventDefault();P.postMessage({type:'rook-preview-nav',path:h},'*')},true);`
    + `D.addEventListener('submit',function(e){e.preventDefault()},true)})();</script>`;
}

/** A fresh nonce for one preview of one page: 128 random bits, in hex. */
export const previewNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** The preview frame's word that its page loaded, for the preview whose nonce is `nonce`. */
export function previewReady(data: unknown, nonce: string): boolean {
  const d = data as { type?: unknown; nonce?: unknown } | null;
  return !!nonce && !!d && typeof d === 'object' && d.type === 'rook-preview-ready' && d.nonce === nonce;
}

/**
 * What a load event of the preview frame means, and the watch after it. `seen`: the nonce of the page the frame was
 * given and how many loads it had; `nonce`: the page it holds now; `ready`: that page said it loaded. A page loads
 * once: a second load of it is the frame gone elsewhere ('left'). A first load with the page's word is it ('shown');
 * without it, the holder waits a moment for the word ('wait'), which arrives on its own message: still none, and the
 * page went elsewhere before its own load (QA's phishing page did both), so that load is another site's ('left').
 */
export function frameLoad(seen: { nonce: string; loads: number }, nonce: string, ready: boolean): { seen: { nonce: string; loads: number }; verdict: 'shown' | 'wait' | 'left' } {
  const loads = seen.nonce === nonce ? seen.loads : 0;
  const next = { nonce, loads: loads + 1 };
  return { seen: next, verdict: loads > 0 ? 'left' : ready ? 'shown' : 'wait' };
}

/**
 * The preview's own content policy. A srcdoc frame inherits this app's policy (next.config.ts), which the wallet
 * connector needs loose: any https connection, frames, eval. A policy in the page adds to it, and both must allow a
 * load, so a delivered page runs only its own inline scripts and styles: it can't connect anywhere, load a script,
 * stylesheet or frame from another site, eval, post a form or set a <base>. Images and fonts from other sites still
 * load. QA had a delivered page fetch and eval a remote script and post data out under the app's policy alone.
 */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
/** What every preview starts with, before anything of the page: its policy, then the nav script. */
export const previewHead = (nonce: string) => `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${navScript(nonce)}`;

/**
 * `html` with previewHead first, before anything of it, so no script of it runs (and nothing loads) before the policy:
 * a <script> ahead of the <head> tag still runs first. The parser puts both into the head it opens for them; the
 * page's own <html> tag then only adds its attributes (lang stays), and its <head> tag is dropped. Only a doctype (and
 * comments) may stay ahead, so the page keeps its rendering mode.
 */
export function withPreviewHead(html: string, nonce: string): string {
  const lead = html.match(/^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i);
  const at = lead ? lead[0].length : 0;
  return html.slice(0, at) + previewHead(nonce) + html.slice(at);
}

/**
 * The page `path` of the delivered files, ready for a sandboxed srcdoc frame (which can't load anything by path): its
 * stylesheets, scripts and SVG images that are delivered files go inline, and previewHead(nonce) goes first
 * (withPreviewHead). A deferred script moves to the end of the body, where an inline one runs at the same point. A
 * <meta> refresh is dropped: it would take the frame to another address. Null when no such page was delivered.
 * ponytail: by pattern, not a parser; a reference it can't match loads nothing, as before, and nothing here widens the
 * frame's sandbox. Images other than SVG arrive as no file (deliveries are text).
 */
export function previewDoc(files: ProjectFile[], path: string, nonce: string): string | null {
  const index = indexOf(files);
  const page = lookup(index, '', path);
  if (!page) return null;
  const from = page.name;
  let html = page.text;
  // The page's own styles first, so the stylesheets put inline below are rewritten from their own folder only.
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, css, close) => `${open}${inlineCssUrls(css, index, from)}${close}`);
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase(), href = attr(tag, 'href');
    const f = href ? lookup(index, from, href) : undefined;
    if (!f) return tag;
    if (/\bstylesheet\b/.test(rel)) return `<style>${styleText(inlineCssUrls(f.text, index, f.name))}</style>`;
    if (/\bicon\b/.test(rel) && isSvg(f)) return tag.replace(/\shref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` href="${svgUri(f.text)}"`);
    return tag;
  });
  const deferred: string[] = [];
  html = html.replace(/<script\b([^>]*)>\s*<\/script\s*>/gi, (tag, attrs: string) => {
    const src = attr(` ${attrs}`, 'src');
    const f = src ? lookup(index, from, src) : undefined;
    if (!f) return tag;
    const kept = attrs.replace(/\s(src|integrity|crossorigin|defer|async)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/gi, '');
    const inline = `<script${kept}>${scriptText(f.text)}</script>`;
    // A module waits for the page on its own; a classic deferred script would run before the elements it looks for.
    if (hasAttr(attrs, 'defer') && !/\stype\s*=\s*["']?module/i.test(` ${attrs}`)) { deferred.push(inline); return ''; }
    return inline;
  });
  if (deferred.length) {
    const end = html.search(/<\/body\s*>/i);
    html = end >= 0 ? html.slice(0, end) + deferred.join('') + html.slice(end) : html + deferred.join('');
  }
  html = html.replace(/<(img|source|image|use)\b[^>]*>/gi, (tag) => tag.replace(/(\s(?:src|href|xlink:href)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (whole, lead: string, d, s, u) => {
    const f = lookup(index, from, d ?? s ?? u ?? '');
    return f && isSvg(f) ? `${lead}"${svgUri(f.text)}"` : whole;
  }));
  html = html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi, '');
  return withPreviewHead(html, nonce);
}
