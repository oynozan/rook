// Pure, deterministic pieces of the evaluator: injection scanner, number extraction and
// quote verification, canonical hashing. docs/agentic-system.md sections 6.2 to 6.4.
import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---- Injection scanner (6.2 step 2) ----

const ACCOUNT = String.raw`\b[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:near|testnet)\b|\b[0-9a-f]{64}\b|\b0x[0-9a-f]{40}\b`;
const AMOUNT = String.raw`\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s*(?:usdc|usdt|usd|near|eth|tokens?)\b`;
// An instruction starts a clause: line start (after list or quote markers), after . ! ? ; : > ] ) or after "and"/"then".
// Third-person prose ("Users pay $0.001 per transaction", "Holders send tokens to x.near") has a subject first.
const CLAUSE = String.raw`(?:^|[.!?;:>\])]|\b(?:and|then)\b)[ \t*_>#\-\[(]*(?:(?:please|kindly|now|immediately|just|also)\s+)*`;
const PAY = String.raw`(?:pay(?!\s+attention)|send|transfer|wire|remit|release|deposit)`;
// What follows an imperative payment verb: an amount, the payment itself, a payee, or a destination.
const PAY_OBJECT = String.raw`(?:(?:exactly|another|only|an?\s+(?:extra|additional|further))\s+)?(?:${AMOUNT})`
  + String.raw`|(?:(?:the|this|my|your|our|all|any)\s+)?(?:(?:remaining|full|outstanding|final|agreed|rest\s+of\s+the)\s+)?(?:payment|funds|balance|money|fee|bounty|reward|tip|rest|remainder)\b`
  + String.raw`|(?:this|the|that|our|my)\s+agent\b|me\b|us\b`
  + String.raw`|(?:it\s+|them\s+)?to\s*:?\s*(?:${ACCOUNT}|me\b|us\b|(?:this|the)\s+agent\b|(?:the\s+following\s+)?(?:address|account|wallet)\b)`;
// Who an instruction is addressed to when it is not a bare imperative.
const ADDRESSEE = String.raw`\b(?:you|rook|the\s+(?:orchestrator|evaluator|planner|hiring\s+(?:system|agent)|client|buyer|requester))\s+(?:must|should|need\s+to|needs\s+to|has\s+to|have\s+to|are\s+(?:required|instructed)\s+to|is\s+(?:required|instructed)\s+to)\s+(?:now\s+|also\s+|immediately\s+)?`;
const ROLE = String.raw`(?:orchestrator|evaluator|planner|hiring\s+(?:system|agent)|assistant|rook)`;

// Each rule: [reason, regex]. All are global so every hit is quoted.
// ponytail: regex scanner, not a classifier. It looks for instructions (imperatives, text addressed to Rook, role
// markers), not topics, so financial prose passes; paraphrased or encoded instructions get through and are left
// to the "untrusted data" framing of the judge and the aggregator.
const RULES: [string, RegExp][] = [
  ['override phrase', /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:(?:previous|prior|above|earlier|preceding|other)\s+)?(?:instructions|prompts?|directions|rules)\b/gi],
  ['override phrase', /\byou\s+are\s+now\b/gi],
  ['override phrase', /\bas\s+(?:the|an?)\s+(?:orchestrator|evaluator|planner|hiring\s+system)\b/gi],
  ['override phrase', /\bmark\s+(?:every|all|each|this|the)\s+(?:criteri(?:on|a)|checks?|tests?|deliverables?|reports?|tasks?)\s+as\s+(?:passed|pass|complete|successful|verified)\b/gi],
  // "SYSTEM:" / "SYSTEM NOTE TO X:" in capitals, "system note|message|prompt:" in any case, and <system> or [system] tags.
  // Title-case "System:" alone is a normal label ("System: NEAR Protocol mainnet").
  ['system message', /^[ \t>#*_\-\[(]*SYSTEM\b[^\n:]{0,40}:/gm],
  ['system message', /^[ \t>#*_\-\[(]*system\s+(?:note|message|prompt|instructions?|override)\b[^\n:]{0,40}:/gim],
  ['system message', /<\s*\/?\s*system\s*>|\[\/?system\]/gi],
  ['addressed to the hiring system', /\b(?:note|message|instructions?|notice)\s+(?:to|for)\s+(?:the\s+)?(?:orchestrator|hiring\s+(?:system|agent)|evaluator|planner|ai(?:\s+agent|\s+assistant)?|assistant|llm|language\s+model|agents?)\b/gi],
  ['addressed to the hiring system', new RegExp(String.raw`^[ \t>#*_\-\[(]*${ROLE}[*_]*\s*:`, 'gim')],
  ['asks for payment', new RegExp(String.raw`${CLAUSE}\b${PAY}\s+(?:again\s+)?(?:${PAY_OBJECT})`, 'gim')],
  ['asks for payment', new RegExp(String.raw`${ADDRESSEE}${PAY}\b`, 'gi')],
  ['asks for payment', /\b(?:must|should|needs?\s+to|has\s+to|have\s+to)\s+be\s+(?:paid|compensated|funded)\b|\b(?:pay|paid)\s+(?:\S+\s+){0,3}?again\b/gi],
  ['asks to hire', new RegExp(String.raw`\bre-?hire\b|${CLAUSE}\bhire\b|\bhire\s+(?:me|us)\b|\bhire\s+[\w.-]+\s+again\b|${ADDRESSEE}hire\b|\bmust\s+be\s+(?:re-?)?hired\b`, 'gim')],
  ['asks for approval', new RegExp(String.raw`(?:${CLAUSE}|${ADDRESSEE})\bapprove\s+(?:the\s+|this\s+|my\s+|a\s+|another\s+|our\s+)?(?:payment|budget|task|request|transaction|transfer|invoice|plan|hire|spend)\b`, 'gim')],
  ['asks to raise the budget', new RegExp(String.raw`(?:${CLAUSE}|${ADDRESSEE})\b(?:raise|increase|top[\s-]?up|extend|double)\s+(?:the\s+|your\s+|my\s+|its\s+)?(?:budget|cap|spending\s+limit|reserve|payment|price)\b`, 'gim')],
  ['payment header', /\bx-payment\b/gi],
];

/** Quote the line around a hit, at most ~160 chars, centred on the hit when the line is long. */
function quoteAround(text: string, index: number, length: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const nl = text.indexOf('\n', index + length);
  const line = text.slice(start, nl < 0 ? text.length : nl);
  const at = index - start;
  if (line.trim().length <= 160) return line.trim();
  const from = Math.max(0, Math.min(at - 40, line.length - 160));
  return line.slice(from, from + 160).trim();
}

export function scanInjection(text: string): string[] {
  const flags = new Set<string>();
  for (const [reason, re] of RULES) {
    for (const m of text.matchAll(re)) flags.add(`${reason}: '${quoteAround(text, m.index!, m[0].length)}'`);
  }
  return [...flags];
}

// ---- Numbers, extraction, verification (6.3) ----

const SUFFIX = String.raw`(?:\s?(k|m|b|bn|mn|thousand|million|billion)\b)?`;
// A leading minus counts only when it is not a hyphen inside a range or word ("10-20", "24h-volume"). The first form
// is '.' grouping thousands, as Turkish, German and many others write ("1.234.567", "1.234,5"); the second, English.
const NUMBER = String.raw`((?:(?<![\w.,])[-−])?(?:\d{1,3}(?:\.\d{3})+(?!\d)(?:,\d+)?|\d[\d,]*(?:\.\d+)?|\.\d+))` + SUFFIX + String.raw`(\s?%)?`;
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

/**
 * What a number as written can mean, the English reading first. With both separators the last one is the decimal
 * point ("1,234.5", "1.234,5"); several of one separator group thousands ("1,234,567", "1.234.567"); a single one
 * before exactly 3 digits is ambiguous ("85.000" is 85 in English and 85000 in Turkish or German; "3,125" is 3125 or
 * 3.125), so both readings are returned; a single ',' before any other count of digits is a decimal comma ("41,6").
 */
export function readings(num: string): number[] {
  const neg = /^[-−]/.test(num), s = num.replace(/^[-−]/, '').replace(/,+$/, '');
  const en = () => Number(s.replace(/,/g, '')), eu = () => Number(s.replace(/\./g, '').replace(',', '.'));
  const dots = s.split('.').length - 1, commas = s.split(',').length - 1;
  let out: number[];
  if (dots && commas) out = [s.lastIndexOf('.') > s.lastIndexOf(',') ? en() : eu()];
  else if (dots > 1) out = [eu()];
  else if (/^[1-9]\d{0,2}[.,]\d{3}$/.test(s)) out = [en(), eu()];
  else if (commas === 1) out = [eu()];
  else out = [en()];
  return out.map((n) => (neg ? -n : n));
}

/** "3,680,000,000" -> 3.68e9, "1.234,5" -> 1234.5, "2.1" + "b" -> 2.1e9, "41.6" + "%" -> 41.6; the English reading. */
export function parseNumber(num: string, suffix?: string): number {
  const n = readings(num)[0];
  return suffix ? n * MULT[suffix.toLowerCase()] : n;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whitespace and Markdown emphasis are normalised: models often quote "**Total supply:** 1,250" without the asterisks.
const norm = (s: string) => s.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

/** canned extraction: "<label>" then ':', '=' or 'is', optional '$', then a number. First hit wins. */
export function extractCanned(text: string, label: string): { value: number; quote: string } | null {
  const re = new RegExp(escapeRe(label) + String.raw`[*_]*\s*(?::|=|\bis\b)\s*[*_]*\s*\$?\s?` + NUMBER, 'i');
  const m = text.match(re);
  if (!m) return null;
  return verifyQuote(text, m[0], parseNumber(m[1], m[2]), label);
}

/**
 * Accept an extraction only if the quote appears verbatim in the text (whitespace and emphasis normalised) and
 * one of the numbers in the quote equals the value (as written or with its k/m/b suffix expanded; the sign may be
 * dropped by the extractor). A number with an ambiguous separator ("85.000") may be read either way (readings): the
 * extractor sees the report's language. The stored value is the one parsed from the quote, sign included, so an
 * extractor cannot invent or rescale a number beyond that. Digits inside the label ("Top 10 holders share") do not count.
 */
export function verifyQuote(text: string, quote: string, value: number, label = ''): { value: number; quote: string } | null {
  if (!quote || !Number.isFinite(value) || !norm(text).includes(norm(quote))) return null;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const numbersPart = label ? quote.replace(new RegExp(escapeRe(label), 'gi'), ' ') : quote;
  for (const m of numbersPart.matchAll(new RegExp(NUMBER, 'gi'))) {
    for (const raw of readings(m[1])) {
      const full = m[2] ? raw * MULT[m[2].toLowerCase()] : raw;
      if ([raw, full].some((n) => close(n, value) || close(Math.abs(n), Math.abs(value)))) return { value: full, quote };
    }
  }
  return null;
}

// ---- Schema criterion ----

/** The whole text, or any fenced ```json block, parses and validates. */
export function checkSchema(text: string, jsonSchema: object): { passed: boolean; detail: string } {
  let validate;
  try { validate = new Ajv({ strict: false, allErrors: true }).compile(jsonSchema); } // fresh instance: no cache growth
  catch (e: any) { return { passed: false, detail: `invalid json_schema: ${e.message}` }; }
  const candidates = [text.trim(), ...[...text.matchAll(/```json[^\n]*\n([\s\S]*?)```/gi)].map((m) => m[1])];
  let lastErr = 'no JSON found (whole text or a ```json block)';
  for (const c of candidates) {
    let data: unknown;
    try { data = JSON.parse(c); } catch { continue; }
    if (validate(data)) return { passed: true, detail: 'JSON valid against schema' };
    lastErr = `schema errors: ${(validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ').slice(0, 300)}`;
  }
  return { passed: false, detail: lastErr };
}

// ---- Links the delivery gives (live_url criterion) ----

/**
 * The link on the delivery's "<label>: <url>" line ("**Live URL:** https://x.netlify.app", a Markdown link or <url>
 * too): the first such line that holds one. '' when the label is there with no link ("Live URL: none"), null when no
 * line has the label.
 */
export function linkOn(text: string, label: string): string | null {
  const re = new RegExp(String.raw`^[ \t>*_#-]*${escapeRe(label)}[*_]*[ \t]*:[ \t]*(.*)$`, 'gim');
  let labelled: string | null = null;
  for (const m of text.matchAll(re)) {
    const url = m[1].match(/https?:\/\/[^\s<>"'`)\]]+/i)?.[0].replace(/[.,;:!?]+$/, '');
    if (url) return url;
    labelled = '';
  }
  return labelled;
}

const flatLower = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
/**
 * Whether a loaded page shows `want`: in what the reader extracted (title, description, headings, the first 4000
 * characters of text), else anywhere in the page's text with its tags taken out (linear: no tag pattern runs past the
 * last ">").
 */
export function pageShows(p: { title: string; description: string; headings: string[]; text: string }, html: string, want: string): boolean {
  const w = flatLower(want);
  if (flatLower([p.title, p.description, ...p.headings, p.text].join(' ')).includes(w)) return true;
  const end = html.lastIndexOf('>') + 1;
  return flatLower(html.slice(0, end).replace(/<[^>]*>/g, ' ') + html.slice(end)).includes(w);
}

// ---- Hash (6.4) ----

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

