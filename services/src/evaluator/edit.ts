// Files cut off, and edits checked against the files they start from (EvaluateRequest.inputs). docs/agentic-system.md
// 6.2. A rename cut off at max_tokens lost 62% of games.html and passed; a lossy edit (two projects, the contact section
// and the script gone), a partial one (the name changed in <title> only) and an unchanged file with "Done: the header
// is now blue." all passed, and each replaced the chat's current file.
import type { DeliveredFile, WorkFile } from '../shared/types.ts';
import { kindOfPath } from '../planner/files.ts';

export type Check = { passed: boolean; detail: string };

const lines = (t: string) => t.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
const short = (s: string, n = 60) => { const t = s.trim().replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Why a delivered file is cut off, in plain words, or undefined: its code block opens and the reply ends inside it (a
 * reply stopped at its length limit), or an HTML page opens <html> and never closes it. A block left open around a
 * complete page (it ends with </html>) or valid JSON is only untidy.
 */
export function cutOff(f: { name: string; text: string }, raw: string): string | undefined {
  const kind = kindOfPath(f.name);
  const whole = (kind === 'html' && /<\/html\s*>\s*$/i.test(f.text)) || (kind === 'json' && parses(f.text));
  if (kind === 'html' && /<html[\s>]/i.test(f.text) && !/<\/html\s*>/i.test(f.text)) return `opens <html> but never closes it: the file stops at "${short(lastLine(f.text))}"`;
  const t = raw.replace(/\r\n?/g, '\n'), at = f.text ? t.lastIndexOf(f.text) : -1;
  if (at > 0 && !whole) {
    const before = t.slice(0, at), opener = before.slice(before.lastIndexOf('\n', before.length - 2) + 1);
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(opener) && !t.slice(at + f.text.length).trim()) return `its code block never closes: the reply ends inside the file, at "${short(lastLine(f.text))}"`;
  }
  return undefined;
}
const parses = (s: string) => { try { JSON.parse(s); return true; } catch { return false; } };
const lastLine = (s: string) => s.trimEnd().split('\n').at(-1) ?? '';

// A brief that asks for the whole file to change: a translation, a restyle or a rewrite changes most of its lines.
const WHOLE = /\b(?:translat(?:e|es|ed|ing|ion)|restyl(?:e|es|ed|ing)|redesign(?:s|ed|ing)?|redo(?:ne)?|rebuil[dt]|rewrit(?:e|es|ten|ing)|refactor(?:s|ed|ing)?|reformat(?:s|ted|ting)?|overhaul(?:s|ed|ing)?|moderni[sz](?:e|es|ed|ing)|from\s+scratch|(?:whole|entire|complete)\s+(?:file|page|site|design|look|style|layout)|(?:new|different|fresh)\s+(?:look|design|style|theme|layout)|(?:change|update|switch|make)\s+(?:the|its)\s+(?:site'?s?\s+|page'?s?\s+)?(?:look|style|design|theme|layout))\b|(?<!\p{L})(?:çevir|tercüme|yeniden|baştan|tasarım)/iu;
// A brief that asks to take something out: an edit may then end shorter.
const CUTS = /\b(?:remov(?:e|es|ed|ing|al)|delet(?:e|es|ed|ing)|drop(?:s|ped|ping)?|cut|shorten(?:s|ed|ing)?|trim(?:s|med|ming)?|condens(?:e|es|ed|ing)|simplif(?:y|ies|ied|ying)|reduc(?:e|es|ed|ing)|strip(?:s|ped|ping)?|get\s+rid|take\s+out|leave\s+out|merg(?:e|es|ed|ing)|from\s+scratch|rebuil[dt]|rewrit(?:e|es|ten|ing))\b|(?<!\p{L})(?:kaldır|çıkar|kısalt)/iu;
// A brief that asks for every occurrence: a replaced phrase left elsewhere is a change half done.
const EVERY = /\b(?:everywhere|wherever|throughout|every\s+(?:place|occurrence|instance|mention|time)|all\s+(?:occurrences|instances|mentions|places)|each\s+(?:occurrence|instance|mention))\b|her\s+yerde|geçtiği\s+her/i;

/** The delivered file an input comes back as: the same path, the path inside a folder, or the one file of its kind. */
function returned(inputs: WorkFile[], files: DeliveredFile[]): { input: WorkFile; file: DeliveredFile }[] {
  const out: { input: WorkFile; file: DeliveredFile }[] = [], used = new Set<DeliveredFile>();
  const lc = (s: string) => s.toLowerCase();
  const same = (a: string, b: string) => lc(a) === lc(b) || lc(a).endsWith(`/${lc(b)}`) || lc(b).endsWith(`/${lc(a)}`);
  for (const input of inputs) {
    const f = files.find((x) => !used.has(x) && lc(x.name) === lc(input.path)) ?? files.find((x) => !used.has(x) && same(x.name, input.path));
    if (f) { used.add(f); out.push({ input, file: f }); }
  }
  // A lone page delivered under another name ("rename-to-x.html" from a bare block) is the one page the edit was given.
  for (const input of inputs.filter((i) => !out.some((o) => o.input === i))) {
    const kind = kindOfPath(input.path);
    const left = files.filter((x) => !used.has(x) && kindOfPath(x.name) === kind);
    if (kind && left.length === 1 && inputs.filter((i) => kindOfPath(i.path) === kind).length === 1) { used.add(left[0]); out.push({ input, file: left[0] }); }
  }
  return out;
}

type Diff = { n: number; removed: string[]; added: string[]; same: boolean; tailLost: boolean };
/**
 * What changed in a file, by its non-blank lines as a multiset (order aside, so a moved block is no change): the input
 * lines it no longer has and the lines it adds. `tailLost`: the input's last lines are all gone, as in a file cut off.
 */
function diff(before: string, after: string): Diff {
  const a = lines(before).filter((l) => l.trim()), b = lines(after).filter((l) => l.trim());
  const left = new Map<string, number>();
  for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
  const removed: string[] = [];
  for (const l of a) { const n = left.get(l) ?? 0; if (n) left.set(l, n - 1); else removed.push(l); }
  const have = new Map<string, number>();
  for (const l of a) have.set(l, (have.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of b) { const n = have.get(l) ?? 0; if (n) have.set(l, n - 1); else added.push(l); }
  const tail = a.slice(-3), inB = new Set(b);
  return { n: a.length, removed, added, same: lines(before).join('\n').trimEnd() === lines(after).join('\n').trimEnd(), tailLost: a.length > 6 && tail.every((l) => !inB.has(l)) };
}

/** A removed line paired with the added line most like it, and the span that changed between them, at word edges. */
type Pair = { r: string; a: string; from: string; to: string };
/**
 * Removed lines paired with the added lines that replaced them ("<title>Alex Doe — ..." with "<title>Jordan Lee — ..."):
 * the added line sharing the most of its start and end, at least half of the shorter line. A removed line with no pair
 * was lost, not changed.
 */
function pairUp(removed: string[], added: string[]): Pair[] {
  // ponytail: at most 200 by 200 lines, each under 2000 characters (a minified line is left unpaired): the pairing is
  // for naming what changed, and a bounded one stays fast on any delivery.
  if (removed.length * added.length > 40_000) return [];
  const out: Pair[] = [], used = new Set<number>(), long = (l: string) => l.length > 2000;
  const ends = (r: string, x: string) => {
    const p = common(r, x);
    let s = 0;
    while (s < r.length - p && s < x.length - p && r[r.length - 1 - s] === x[x.length - 1 - s]) s++;
    return [p, s];
  };
  for (const r of removed) {
    if (long(r)) continue;
    let best = -1, score = 0;
    added.forEach((x, i) => {
      if (used.has(i) || long(x)) return;
      const [p, s] = ends(r, x), sc = (p + s) / Math.min(r.length, x.length);
      if (sc > score) { score = sc; best = i; }
    });
    if (best < 0 || score < 0.5) continue;
    used.add(best);
    const x = added[best], word = /[\p{L}\p{N}]/u;
    let [p, s] = ends(r, x);
    while (p > 0 && word.test(r[p - 1])) p--;
    while (s > 0 && word.test(r[r.length - s])) s--;
    out.push({ r, a: x, from: r.slice(p, r.length - s).trim(), to: x.slice(p, x.length - s).trim() });
  }
  return out;
}
const example = (p: Pair) => (!p.from ? `"${short(p.to, 40)}" added to a line` : !p.to ? `"${short(p.from, 40)}" taken out of a line` : `"${short(p.from, 40)}" became "${short(p.to, 40)}"`);
const common = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const count = (text: string, s: string) => text.split(s).length - 1;
// A line worth naming: a section, heading, script or form opening before any other line.
const LANDMARK = /<(?:section|article|h[1-6]|script|form|nav|header|footer|main|table)\b|^\s*#{1,6}\s|^\s*(?:export\s+)?(?:function|class|def)\s/i;
const sample = (ls: string[]) => short(ls.find((l) => LANDMARK.test(l)) ?? ls.find((l) => l.trim().length >= 8) ?? ls[0] ?? '');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * edit_scope, with no criterion needed when a part has input files: it changes something, and only what the brief
 * asks. Each input it sends back keeps most of its lines (more than half, unless the brief asks for the whole file to
 * change, as a translation or a restyle does), loses at most a few (5% or 5 lines, unless the brief asks to remove or
 * shorten something), and, when the brief asks for every occurrence, no phrase it replaced is left elsewhere. The
 * detail says what changed.
 * ponytail: lines compared as a multiset, not a positional diff, so a moved block counts as unchanged.
 */
export function editScope(inputs: WorkFile[], files: DeliveredFile[], brief: string): Check {
  const pairs = returned(inputs, files), added = files.filter((f) => !pairs.some((p) => p.file === f));
  const whole = WHOLE.test(brief), cuts = CUTS.test(brief), every = EVERY.test(brief);
  const problems: string[] = [], changes: string[] = [];
  let changedAny = false;
  for (const { input, file } of pairs) {
    const d = diff(input.text, file.text), name = input.path;
    if (d.same) { changes.push(`${name} unchanged`); continue; }
    changedAny = true;
    const swapped = Math.min(d.removed.length, d.added.length), lost = d.removed.length - swapped, gained = d.added.length - swapped;
    const what = [swapped && `${plural(swapped, 'line')} changed`, gained && `${plural(gained, 'line')} added`, lost && `${plural(lost, 'line')} removed`].filter(Boolean).join(', ') || 'only spacing changed';
    const paired = pairUp(d.removed, d.added), gone = d.removed.filter((r) => !paired.some((p) => p.r === r));
    changes.push(`${name}: ${what}${paired.length ? ` (e.g. ${example(paired[0])})` : ''}`);
    if (lost > Math.max(5, 0.05 * d.n) && !cuts && !(whole && lost <= 0.5 * d.n)) {
      problems.push(d.tailLost && d.added.length < d.removed.length
        ? `${name} is cut off: it ends before the last ${plural(lost, 'line')} of the file it was given (it stops at "${short(lastLine(file.text))}")`
        : `${name} loses ${lost} of its ${d.n} lines, though the brief doesn't ask to remove anything (among them "${sample(gone.length ? gone : d.removed)}")`);
    } else if (swapped > Math.max(10, 0.5 * d.n) && !whole) {
      problems.push(`${name} rewrites ${swapped} of its ${d.n} lines, though the brief asks for a change, not a rewrite`);
    }
    if (every && !problems.some((p) => p.startsWith(`${name} `))) {
      const left = paired.filter((p) => p.from.length >= 3 && /\p{L}/u.test(p.from) && p.from !== p.to && count(file.text, p.from) > 0);
      if (left.length) problems.push(`${name} replaces "${short(left[0].from, 40)}" with "${short(left[0].to, 40)}" but still has "${short(left[0].from, 40)}" in ${plural(count(file.text, left[0].from), 'other place')}, though the brief asks to change every one`);
    }
  }
  const gave = inputs.map((i) => i.path).join(', ');
  if (!changedAny && !added.length) {
    return { passed: false, detail: pairs.length ? `changes nothing: ${pairs.map((p) => p.input.path).join(', ')} come${pairs.length === 1 ? 's' : ''} back as ${pairs.length === 1 ? 'it was' : 'they were'}` : `sends back none of the files it edits (${gave})` };
  }
  if (added.length) changes.push(`adds ${added.slice(0, 4).map((f) => f.name).join(', ')}${added.length > 4 ? ` and ${added.length - 4} more` : ''}`);
  return problems.length ? { passed: false, detail: problems.slice(0, 4).join('; ') } : { passed: true, detail: changes.slice(0, 6).join('; ') };
}
