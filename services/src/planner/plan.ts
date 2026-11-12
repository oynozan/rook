// Deterministic half of planning (docs/agentic-system.md 5.2 steps 2 and 4 to 9, section 7 rules).
// No I/O and no LLM here: index.ts gathers search results, selections and quotes, then calls buildPlan.
import { Ajv } from 'ajv';
import { z } from 'zod';
import { config } from '../shared/config.ts';
import { AcceptsRow, CONVERSATION_FILES, CONVERSATION_FILES_CHARS, Criterion, type AgentHistory, type AgentSummary, type Candidate, type Plan, type PlanPart, type PlanSubtask, type SelfDoReason, type WorkFile, type X402Config } from '../shared/types.ts';
import { formatUsdc, parseUsdc, share } from '../shared/money.ts';
import type { AgentListing } from '../market-gateway/index.ts';

// Draft as the LLM writes it. Criteria are loose here on purpose: an invalid one is removed with a note
// (step 8) instead of failing the whole draft. Cross-check `other_subtask` uses draft ids s1..sN by position.
export const DraftCriterion = z.object({
  id: z.string().optional(),
  kind: z.string(),
  description: z.string().default(''),
  spec: z.record(z.string(), z.unknown()),
});
export const DraftSubtask = z.object({
  title: z.string().min(1),
  brief: z.string().min(1),
  search_terms: z.array(z.string().min(1)).min(1).max(3),
  // The market category whose agents do this kind of work; one Rook does not know is ignored, never a failed draft.
  category: z.string().nullish(),
  self_do_ok: z.boolean(),
  criteria: z.array(DraftCriterion),
  // An edit of delivered work: the conversation's files (by path) it changes or builds on. buildPlan keeps known paths only.
  inputs: z.array(z.string().min(1)).max(CONVERSATION_FILES).nullish(),
  // A small mechanical edit of those files (a rename, a colour, a link) that Rook makes itself at once.
  rook_edit: z.boolean().nullish(),
  // An action in the world on the user's behalf (book, call, post, buy, deploy): it never runs on [placeholders].
  action: z.boolean().nullish(),
});
const hasRules = (v: unknown) => !!v && typeof v === 'object' && Object.values(v).some((x) => x != null);
const isUsdc = (v: number | string) => { try { parseUsdc(v); return true; } catch { return false; } };
export const MAX_QUESTIONS = 5;
export const MAX_ASSUMPTIONS = 5;
// The draft lists the most important first: past n the rest is left out, never a draft asked again for it.
const lines = (n: number) => z.array(z.string().trim().min(1).max(400)).transform((l) => l.slice(0, n)).nullish();
// No subtasks only with `not_a_task` (the message is not a task to plan: "go ahead", "hi"; that sentence says why) or
// with `questions` (facts only the user can give are missing), or with `spending` (a message that only states how Rook
// may spend: "from now on, ask me before every payment"). `budget_usdc`: the total budget the message itself
// names ("make it 1 USDC"), in USDC; absent when it names none. `action`: the task is an action in the world (Plan.action).
export const Draft = z.object({
  subtasks: z.array(DraftSubtask).max(5),
  not_a_task: z.string().optional(),
  questions: lines(MAX_QUESTIONS),
  assumptions: lines(MAX_ASSUMPTIONS),
  budget_usdc: z.union([z.number(), z.string()]).nullish()
    .refine((v) => v == null || isUsdc(v), 'budget_usdc must be an amount of USDC such as 1.5, with at most 6 decimals'),
  action: z.boolean().nullish(),
  // The spending rules the latest message states (Plan.spending), read field by field in spending.ts: a bad field is
  // left out with a note there, never a draft asked again for it.
  spending: z.unknown().optional(),
}).refine((d) => d.subtasks.length > 0 || !!d.not_a_task?.trim() || !!d.questions?.length || hasRules(d.spending),
  'return at least one subtask, or questions, or spending rules, or set not_a_task')
  .refine((d) => !(d.questions?.length && d.subtasks.length), 'return either questions with no subtasks, or subtasks with no questions')
  // A task marked an action whose parts don't say which of them act: every part Rook can't write is one (a booking
  // planned beside a thank-you note Rook can write marks only the booking).
  .transform((d) => (d.action && !d.subtasks.some((s) => s.action != null)
    ? { ...d, subtasks: d.subtasks.map((s) => (s.self_do_ok ? s : { ...s, action: true })) } : d));
export type DraftSubtask = z.infer<typeof DraftSubtask>;
export type Draft = z.infer<typeof Draft>;

/**
 * What a brief must never hold (QA: briefs leaked the planner's self-corrections, "Acceptance:" lines, the earlier
 * messages, a "Word count: N" line that ended up in the user's CV, and a way out: "if you don't receive the file, build
 * it yourself"). A brief goes verbatim to an agent that knows nothing else. Narrow on purpose: "do not invent", "what
 * users actually use" and "the first message of the sequence" are fine.
 */
const BRIEF_RULES: [RegExp, string][] = [
  [/(?:[—–]|--|[.;!?(]|^)\s*actually[,:]?\s+(?:use|make|write|keep|call|name|change|put|set|go with|no)\b|\bscratch that\b|\bon second thought\b|\bwait,\s+(?:no|actually)\b/im,
    'corrects itself: write only the final instruction'],
  [/\b(?:earlier|previous|prior) (?:messages?|requests?|plans?|briefs?|reports?|conversation|chat)\b|\b(?:this|our) (?:conversation|chat)\b|\bthe (?:report|plan|message) above\b/i,
    'mentions the conversation or an earlier message, plan or report, which the agent never sees: write out what it needs'],
  [/^\W*acceptance\b[^:\n]{0,20}:|\b(?:will|would) be (?:checked|evaluated|verified|graded|judged|scored) (?:automatically|by (?:rook|an? (?:llm|script|model|evaluator)))\b/im,
    'says how the work is checked: leave that out'],
  [/\b(?:word|character) count\s*:|\b(?:print|state|give|add|include|end with)\b[^.\n]{0,40}\b(?:word|character) count\b/i,
    'asks for a word or character count line, which would end up in the work: Rook judges length itself'],
  [/\bif you (?:do not|don't|did not|didn't|cannot|can't|could not|couldn't) (?:receive|get|find|have|access|open|see)\b[^.\n]{0,30}\bfiles?\b|\bif you (?:truly |really )?(?:cannot|can't|could not|couldn't|are unable to) deploy\b/i,
    'gives the agent a way out (build it yourself, report no link): ask for exactly the work'],
];
/** The rules a brief breaks, each with the words that break it. */
export function briefProblems(brief: string): string[] {
  return BRIEF_RULES.flatMap(([re, why]) => {
    const m = re.exec(brief);
    return m ? [`${why} ("${m[0].trim().slice(0, 60)}")`] : [];
  });
}
/**
 * Every rule the draft's briefs break, by subtask, worded for the model and for a plan note alike. An action brief that
 * holds a [placeholder] is one (QA: "Use placeholders" gave a fundable plan to book a real table under [Your name]):
 * the draft is asked again, and what it still holds becomes questions (index.ts).
 */
export const draftProblems = (subtasks: DraftSubtask[]) => [
  ...subtasks.flatMap((s) => briefProblems(s.brief).map((p) => `the brief of "${s.title}" ${p}`)),
  ...subtasks.flatMap((s) => {
    const held = actionPlaceholders(s);
    return held.length ? [`the brief of "${s.title}" is an action in the world but holds ${held.length === 1 ? 'a placeholder' : 'placeholders'} (${held.join(', ')}): an action never runs on placeholders, so return questions asking the user for ${held.length === 1 ? 'that fact' : 'those facts'} instead of this subtask`] : [];
  }),
];

/**
 * The [bracketed] placeholders a text holds: "[Your name]", "[Telefon numaranız]". Not a Markdown link's text, an index
 * such as a[0], a checkbox, or Rook's own "[file index.html, 12 lines ...]" marker.
 */
export function placeholdersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w\]])\[([^[\]\n]{2,60})\](?!\()/g)) {
    const inner = m[1].trim();
    if (!/\p{L}/u.test(inner) || /^file\s/i.test(inner) || /^[xX ]$/.test(inner)) continue;
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}
/** A part that acts in the world: the draft says so, or it must be put online (a live link is checked). */
export const isAction = (d: DraftSubtask) => !!d.action || isDeploy(d);
const isDeploy = (d: DraftSubtask) => d.criteria.some((c) => c.kind === 'live_url' || (c.kind === 'contains' && linkOnly(c.spec.pattern)));
/** The placeholders an action part's brief still holds: none may be left when it runs. */
export const actionPlaceholders = (d: DraftSubtask) => (isAction(d) ? placeholdersIn(d.brief) : []);

/**
 * The questions that take the place of a plan whose action parts still hold placeholders after the draft was asked
 * again: one per part, naming them. ponytail: English sentences; the placeholders keep the brief's own language.
 */
export function placeholderQuestions(draft: DraftSubtask[]): string[] {
  return draft.flatMap((d) => {
    const held = actionPlaceholders(d);
    if (!held.length) return [];
    const names = held.length === 1 ? held[0] : `${held.slice(0, -1).join(', ')} and ${held[held.length - 1]}`;
    return [`"${d.title}" is done in the world for you, so Rook can't run it on placeholders: what should go in place of ${names}?`];
  }).slice(0, MAX_QUESTIONS);
}

// A line that only says how the work is checked can go without asking the model again.
const CHECK_LINE = /^\W*acceptance\b[^:\n]{0,20}:/i;
/**
 * The brief as sent: lines about checking dropped, and the title on the first line, then a blank line (some briefs
 * opened with "NEAR token due diligence (part 1): overview and market data. Research ...").
 */
export function repairBrief(title: string, brief: string): string {
  const body = brief.replace(/\r\n/g, '\n').split('\n').filter((l) => !CHECK_LINE.test(l)).join('\n').trim();
  const [first, second] = body.split('\n');
  if (!body) return title.trim();
  return first.trim().length <= 100 && (second === undefined || !second.trim()) ? body : `${title.trim()}\n\n${body}`;
}

/** A path inside a project as Rook keeps it: relative, "/"-separated, no "." or ".." segment; undefined when it isn't one. */
export function cleanPath(p: string): string | undefined {
  const s = p.trim().replace(/^(?:\.?\/)+/, '');
  if (!s || s.includes('\\') || /^[a-z]:/i.test(s) || s.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return undefined;
  return s;
}
/**
 * A subtask's inputs that are files of this conversation, and those that are not. A bare name ("index.html") finds the
 * one file of that name in a folder ("public/index.html").
 */
export function inputsOf(d: DraftSubtask, files: string[]): { kept: string[]; unknown: string[] } {
  const kept: string[] = [], unknown: string[] = [];
  for (const raw of d.inputs ?? []) {
    const p = cleanPath(raw);
    const named = p && !p.includes('/') ? files.filter((f) => f.split('/').pop() === p) : [];
    const hit = p && files.includes(p) ? p : named.length === 1 ? named[0] : undefined;
    if (!hit) unknown.push(raw);
    else if (!kept.includes(hit)) kept.push(hit);
  }
  return { kept, unknown };
}
// A contains pattern that only asks for a link ("URL: https?://", "Live URL:"): any string passed it, a 404 included.
const LINK_ONLY = /^(live)?url(https?s?)?$/;
const linkOnly = (pattern: unknown) => typeof pattern === 'string' && LINK_ONLY.test(pattern.toLowerCase().replace(/[^a-z]/g, ''));
/** Rook can write a part itself unless it must be deployed: no model output can pass a live link check. */
const writable = (d: DraftSubtask) => d.self_do_ok && !isDeploy(d);
/**
 * The most characters the files of a Rook edit may hold, a sixth of CONVERSATION_FILES_CHARS. Rook's writer gives back
 * every file it changes whole, at about 3 characters a token, so an edit of more is neither small nor quick, and its reply
 * nears the writer's output limit (a rename over 115,418 characters was cut off and lost 62% of games.html). Past it the
 * part is hired, or self-done as any other part.
 */
export const ROOK_EDIT_MAX_CHARS = CONVERSATION_FILES_CHARS / 6;
/** The characters a part's input files hold, from `sizes` (characters by path; a path it lacks counts 0). */
const inputChars = (paths: string[], sizes: ReadonlyMap<string, number>) => paths.reduce((n, p) => n + (sizes.get(p) ?? 0), 0);
/**
 * A small edit Rook makes itself at once, with no agent fee and no wait: it needs files of this conversation to edit,
 * at most ROOK_EDIT_MAX_CHARS of them in all. `sizes`: the characters of each file, by path.
 */
export const isRookEdit = (d: DraftSubtask, files: string[], sizes: ReadonlyMap<string, number> = new Map()) => {
  if (!d.rook_edit || !writable(d)) return false;
  const kept = inputsOf(d, files).kept;
  return kept.length > 0 && inputChars(kept, sizes) <= ROOK_EDIT_MAX_CHARS;
};

export type QuoteResult = { ok: true; row: unknown } | { ok: false; error: { code: number | string; message: string } };

/**
 * The market's agent categories (GET /v1/agents?category=..., as listed on 2026-11-10). A subtask's category lists
 * that category's agents next to its keyword searches: keyword search finds only agents whose description names the
 * topic, so a "portfolio website" found 9 agents of five categories, while dev_tools lists 43 available ones.
 */
export const MARKET_CATEGORIES = ['research', 'data', 'finance', 'creative', 'marketing', 'dev_tools', 'automation',
  'legal_compliance', 'sales', 'operations', 'customer_support', 'travel', 'events', 'other'] as const;
export const marketCategory = (c: string | null | undefined) =>
  (MARKET_CATEGORIES as readonly string[]).includes(c ?? '') ? c! : undefined;

export const DEFAULT_JUDGE = 'Does the deliverable fully answer the brief with specific content rather than generic filler?';
const MAX_PER_SUBTASK = 12;
// ponytail: a category listing shown to the select step is cut at 60 agents to bound its prompt; the market lists 56 at most today.
export const MAX_CATEGORY_LISTED = 60;
const MAX_JUDGES = 2;

export const hireable = (a: AgentSummary) => a.available_now && a.listing_status === 'live' && !!a.payable_with?.includes('USDC');

/**
 * Step 2: keep agents that can be hired now with USDC, and merge the per-term results by handle, taking each term's
 * next unseen agent in turn. The first term is the generic skill and often fills every slot alone, which cut the
 * specialists the other terms found (a Solidity audit offered only generic code reviewers).
 */
export function filterSearch(resultLists: AgentSummary[][]): AgentSummary[] {
  const lists = resultLists.map((l) => l.filter(hireable));
  const byHandle = new Map<string, AgentSummary>();
  const next = lists.map(() => 0);
  for (let added = true; added && byHandle.size < MAX_PER_SUBTASK;) {
    added = false;
    lists.forEach((l, t) => {
      while (next[t] < l.length && byHandle.has(l[next[t]].handle)) next[t]++;
      if (next[t] < l.length && byHandle.size < MAX_PER_SUBTASK) { byHandle.set(l[next[t]].handle, l[next[t]]); added = true; }
    });
  }
  return [...byHandle.values()];
}

/**
 * Step 3 output hygiene: keep only handles that were in that subtask's search results, at most MAX_PICKS. Five, not
 * three: the best-described agents are often unpayable (a 14-day payment window, a 6 USDC price for a 3 USDC task),
 * and with three picks the cheap generalist behind them was never quoted, so the part fell to Rook. Quotes are free;
 * buildPlan drops whatever the budget cannot pay.
 */
export const MAX_PICKS = 5;
export function applySelection<A extends AgentSummary>(results: A[], handles: string[], max = MAX_PICKS): A[] {
  const picked = [...new Set(handles)].map((h) => results.find((a) => a.handle === h)).filter((a): a is A => !!a);
  return picked.slice(0, max);
}

/** The market signs a payment window of at least an agent's SLA plus this (config.maxPaymentTimeoutS). */
export const MARKET_WINDOW_PAD_S = 600;
const ownRecord = (history: Record<string, AgentHistory>, handle: string) => (Object.hasOwn(history, handle) ? history[handle] : undefined);

/**
 * Before the select step (QA: two of its five picks went, on every website plan, to agents Rook always drops, so cheaper
 * or proven ones were never quoted): agents Rook can never pay are left out, and those Rook hired that never delivered
 * anywhere while another agent is left. Unpayable: the payment window an earlier quote gave (`windows`), else at least the
 * SLA plus the market's 600 s, is over ROOK_MAX_PAYMENT_TIMEOUT_S. Never delivered: no market job, no verdict of Rook's,
 * and a hire of Rook's that failed to send or timed out. `what` names the list in notes.
 */
export function prefilter(what: string, agents: AgentListing[], history: Record<string, AgentHistory>, windows: Record<string, number>, notes: string[]): AgentListing[] {
  const max = config.maxPaymentTimeoutS;
  const window = (a: AgentListing) => (Object.hasOwn(windows, a.handle) ? windows[a.handle] : Number.isFinite(a.sla_seconds) ? a.sla_seconds + MARKET_WINDOW_PAD_S : 0);
  const unpayable = agents.filter((a) => window(a) > max);
  if (unpayable.length) notes.push(`${what}: ${unpayable.map((a) => `${a.handle} (${window(a)} s)`).join(', ')} left out before selection: a payment window over ${max} s (ROOK_MAX_PAYMENT_TIMEOUT_S), from an earlier quote or the SLA plus the market's ${MARKET_WINDOW_PAD_S} s`);
  const payable = agents.filter((a) => window(a) <= max);
  const never = (a: AgentListing) => {
    const h = ownRecord(history, a.handle);
    return !!h && (h.stalled ?? 0) > 0 && h.pass === 0 && h.fail === 0 && !(a.delivered_jobs > 0);
  };
  if (payable.every(never)) return payable; // nothing better: the select step and the ranking decide
  const out = payable.filter(never);
  if (out.length) notes.push(`${what}: ${out.map((a) => a.handle).join(', ')} left out before selection: no job delivered anywhere, and Rook's hires failed to send or timed out`);
  return payable.filter((a) => !never(a));
}

/**
 * Agents Rook's own verdicts show deliver: a pass, more passes than fails, and no hire since that failed to send or timed
 * out; most passes first. The planner adds them to every part's pool for the select step (QA: quill-writer, 3 passes,
 * was missing from a captions plan led by an agent whose last Rook job failed to send).
 */
export function goodRecord(history: Record<string, AgentHistory>, n = 5): string[] {
  return Object.entries(history).filter(([, h]) => h.pass > 0 && h.pass > h.fail && !h.stalled)
    .sort(([a, x], [b, y]) => y.pass - x.pass || (a < b ? -1 : 1)).slice(0, n).map(([h]) => h);
}

// What a part delivers, read from its title (a website brief names images too) and its media checks. A title that
// names written work ("Promo video script", "Logo ideas") is text, whatever else it names.
const TEXT_TITLE = /\b(?:scripts?|storyboards?|copy|captions?|descriptions?|outlines?|briefs?|plans?|ideas?|concepts?|articles?|posts?|transcripts?|subtitles?|names?|prompts?|texts?|research|reports?|analysis|guides?|translations?|letters?|emails?|bios?|cv|resumes?|essays?|tweets?|threads?|newsletters?|blog)\b/i;
const IMAGE_TITLE = /(?<![\p{L}\d])(?:logos?|logotype|icons?|illustrations?|artwork|posters?|banners?|mascots?|stickers?|thumbnails?|avatars?|images?|graphics?|logosu|görsel\p{L}*|afiş\p{L}*)(?![\p{L}\d])/iu;
const VIDEO_TITLE = /\b(?:videos?|animations?|animated|motion[- ]graphics|reels?|teasers?|trailers?|clips?|films?|movies?)\b/i;
const IMAGE_MAKER = /\b(?:images?|logos?|designs?|designers?|graphics?|illustrat\w*|art|artwork|svg|vectors?|icons?|visuals?|figma|branding|photos?|pictures?|drawings?|stills?|text[- ]to[- ]image|canva)\b/i;
const RASTER = /\b(?:png|jpe?g|webp|\d{3,4}\s*[x×]\s*\d{3,4}|stills?|photos?)\b/i;
const VIDEO_MAKER = /\b(?:videos?|mp4|animations?|animated|animat\w*|motion|films?|clips?|reels?|footage|render\w*)\b/i;
const SLIDESHOW = /ken[- ]?burns|slide ?shows?|from (?:the )?(?:frames|stills|still images)/i;
const MOTION = /\b(?:motion[- ]graphics|motion[- ]design|animat\w*|filmed|live[- ]action|footage)\b/i;
const SOURCE_VIDEO = /\blong(?:-form)? videos?\b|\b(?:send|attach|upload)\s+(?:a|an|your|one|up to)\b[^.]{0,30}\bvideos?\b|\bdubs?\s+(?:a|your)\b[^.]{0,15}\bvideos?\b|\byour (?:episode|video)\b|\bvideo in\b/i;
const WRITER = /\b(?:writ\w*|copy\w*|articles?|blog\w*|content|posts?|social media|marketing|texts?|translat\w*|seo|newsletters?|emails?|captions? (?:for|writing))\b/i;
const CONTRACT_TAKER = /\b(?:give me|send me|paste|provide|enter)\b[^.]{0,30}\b(?:token|contract)\b|\bcontract(?:[_ ](?:id|address))?\s*\(required\)/i;

/**
 * Why an agent the select step picked can't make what the part needs, from its listing; null when nothing says so.
 * Conservative keyword rules (QA: a blog writer for a logo, a stills slideshow for motion graphics, a still-image maker
 * for an SVG logo, contract-taking agents for native NEAR, which has no contract, video clippers for captions); the
 * select prompt asks the same, and its low-effort pick ignored it.
 */
export function unfit(d: DraftSubtask, a: AgentListing): string | null {
  const said = [a.name, a.description, a.tags.join(', '), a.bio, a.outputs].filter(Boolean).join(' \n ');
  const media = d.criteria.flatMap((c) => (c.kind === 'media' && Array.isArray(c.spec.kinds) ? c.spec.kinds as unknown[] : []));
  const text = TEXT_TITLE.test(d.title);
  const image = media.includes('image') || (!text && IMAGE_TITLE.test(d.title));
  const video = media.includes('video') || (!text && VIDEO_TITLE.test(d.title));
  const brief = `${d.title}\n${d.brief}`;
  if (image && !IMAGE_MAKER.test(said)) return 'its listing shows no image or design work';
  if (image && /\bsvg\b|\bvector\b/i.test(brief) && !/\bsvg\b|\bvectors?\b/i.test(said) && RASTER.test(said)) return 'it makes raster images, and the brief asks for SVG';
  if (video && !VIDEO_MAKER.test(said)) return 'its listing shows no video work';
  if (video && MOTION.test(brief) && SLIDESHOW.test(said)) return 'it makes a slideshow of still images, and the brief asks for motion';
  if (video && /\bvideo\s*\(boolean\)/i.test(a.inputs ?? '')) return 'it renders video only when a separate input is set, and Rook sends only the brief';
  if (video && SOURCE_VIDEO.test(`${said} ${a.inputs ?? ''}`) && !/https?:\/\//i.test(d.brief)) return 'it works from a video you send, and the brief gives none';
  if (!image && !video && text && VIDEO_MAKER.test(said) && !WRITER.test(said)) return 'its listing shows video work, and this part is writing';
  if (/\bnative near\b/i.test(brief) && CONTRACT_TAKER.test(`${said} ${a.inputs ?? ''}`)) return 'it works from a token contract, and native NEAR has none';
  return null;
}
/** The picked agents that can make what the part needs (unfit()), each one left out with a note. */
export function fitting(d: DraftSubtask, agents: AgentListing[], notes: string[]): AgentListing[] {
  return agents.filter((a) => {
    const why = unfit(d, a);
    if (why) notes.push(`"${d.title}": candidate ${a.handle} dropped: ${why}`);
    return !why;
  });
}

// ---- NEAR account ids in briefs and assumptions (index.ts checks them on chain) ----

/** What the chain says of an account id: it holds a contract, it exists with no code, or it doesn't exist. */
export type AccountState = 'contract' | 'empty' | 'missing';
/** Account ids a draft writes from memory, and the real one, said only once the chain shows it holds a contract. */
export const ACCOUNT_FIXES: Record<string, { to: string; what: string }> = {
  'wnear.near': { to: 'wrap.near', what: 'the wrapped NEAR (wNEAR) contract' },
  'wnear.testnet': { to: 'wrap.testnet', what: 'the wrapped NEAR (wNEAR) contract on testnet' },
};
const idPattern = (suffix: string) => String.raw`(?<![\w.@-])(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*\.${suffix}(?![\w-]|\.[a-z\d])`;
/** The account ids of one network the texts name ("wrap.near"; "usdc.fakes.testnet"): a domain such as app.near.ai is none. */
export function nearAccountIds(texts: string[], network: 'mainnet' | 'testnet'): string[] {
  const re = new RegExp(idPattern(network === 'mainnet' ? 'near' : 'testnet'), 'gi');
  return [...new Set(texts.flatMap((t) => [...t.matchAll(re)].map((m) => m[0].toLowerCase())))];
}
const idRe = (id: string, flags = 'gi') => new RegExp(String.raw`(?<![\w.@-])${escapeRegExp(id)}(?![\w-]|\.[a-z\d])`, flags);
/** The text with an account id replaced, or taken out with the brackets or the space around it. */
export function replaceAccount(text: string, id: string, to: string | null): string {
  if (to) return text.replace(idRe(id), to);
  const e = String.raw`\`?${escapeRegExp(id)}\`?(?![\w-]|\.[a-z\d])`;
  return text.replace(new RegExp(String.raw`[ \t]*\(\s*${e}\s*\)`, 'gi'), '')
    .replace(new RegExp(String.raw`[ \t]+${e}|(?<![\w.@-])${e}[ \t]?`, 'gi'), '');
}
/** Whether a text calls the account a contract or a token, within a few words of it: then it must hold code. */
const namedAsContract = (texts: string[], id: string) =>
  texts.some((t) => [...t.matchAll(idRe(id))].some((m) => /contract|token|wrapped|\bft\b|nep-?141|kontrat|sözleşme/i.test(t.slice(Math.max(0, m.index! - 40), m.index! + id.length + 40))));

/**
 * Account ids the chain shows are wrong (QA: three briefs and an assumption sent agents to "wnear.near", an account with
 * no contract; wNEAR is wrap.near): one that doesn't exist, or one named as a contract that holds none. The draft's own
 * is corrected when ACCOUNT_FIXES knows the real one and the chain shows it holds a contract, else taken out, with a note
 * either way. One the user's message names is the user's: only a note asks them to check it.
 */
export function fixAccounts(briefs: string[], assumptions: string[], states: Record<string, AccountState>, userText: string): { briefs: string[]; assumptions: string[]; notes: string[] } {
  const notes: string[] = [];
  const all = [...briefs, ...assumptions];
  let b = briefs, a = assumptions;
  for (const [id, state] of Object.entries(states)) {
    if (!all.some((t) => idRe(id, 'i').test(t))) continue; // a correction checked alongside
    const bad = state === 'missing' || (state === 'empty' && namedAsContract(all, id));
    if (!bad) continue;
    const what = state === 'missing' ? `no NEAR account named ${id}` : `no contract at ${id}`;
    if (idRe(id, 'i').test(userText)) { notes.push(`Rook found ${what}, which your message names: check the name before paying.`); continue; }
    const fix = Object.hasOwn(ACCOUNT_FIXES, id) && states[ACCOUNT_FIXES[id].to] === 'contract' ? ACCOUNT_FIXES[id] : undefined;
    b = b.map((t) => replaceAccount(t, id, fix?.to ?? null));
    a = a.map((t) => replaceAccount(t, id, fix?.to ?? null));
    notes.push(fix ? `Rook found ${what}, so the plan names ${fix.to}, ${fix.what}, instead.` : `Rook found ${what}, so the plan no longer names it.`);
  }
  return { briefs: b, assumptions: a, notes };
}

// ---- What a part sends, and the plan a message revises ----

/** The most a part's input files may come to (orchestrator/runner.ts sends no more with one part). */
export const INPUTS_MAX_BYTES = 300 * 1024;
/**
 * Why the plan can't be funded as it is (Plan.blocked): a part's input files are over what Rook sends with one part.
 * QA: the note was hidden, the plan stayed fundable, and the part failed after funding.
 */
export function inputsBlocked(subtasks: Pick<PlanSubtask, 'title' | 'inputs'>[], files: WorkFile[]): string | undefined {
  const text = new Map(files.map((f) => [f.path, f.text]));
  for (const s of subtasks) {
    const bytes = [...new Set(s.inputs ?? [])].reduce((n, p) => n + Buffer.byteLength(text.get(p) ?? ''), 0);
    if (bytes > INPUTS_MAX_BYTES) return `The files "${s.title}" works on come to ${Math.ceil(bytes / 1024)} KB, more than the ${INPUTS_MAX_BYTES / 1024} KB Rook can send with one part, so this plan can't run as it is. Ask for a change to fewer or smaller files.`;
  }
  return undefined;
}

const sameTitle = (a: string, b: string) => fold(a) === fold(b);
const sameBrief = (p: PlanPart, d: DraftSubtask) => fold(repairBrief(p.title, p.brief)) === fold(repairBrief(d.title, d.brief));

/**
 * A revision keeps the criteria of every part it leaves as it was (same title, same brief), when the plan's parts come
 * with them: re-drafted, they drifted (QA: a site part had 9 checks, then 6 with none for its links, its brief the same).
 */
export function keepCriteria(draft: DraftSubtask[], parts: PlanPart[], notes: string[]): DraftSubtask[] {
  return draft.map((d) => {
    const p = parts.find((x) => x.criteria?.length && sameTitle(x.title, d.title) && sameBrief(x, d));
    if (!p) return d;
    notes.push(`"${d.title}": the message leaves it as it was, so it keeps its criteria`);
    return { ...d, criteria: p.criteria!.map((c) => ({ ...c, spec: { ...c.spec } })) };
  });
}

/**
 * An answer to Rook's questions about new work, in a chat whose plan is still open, plans that work beside the plan:
 * each part of it the draft left out comes back first, as the user saw it (QA: answered, the questions about a CV would
 * have replaced the reviewed site plan with the CV alone). A part sent with only its title and brief is searched by its
 * title, and is one only an agent may do.
 */
export function carryParts(draft: DraftSubtask[], parts: PlanPart[], notes: string[]): DraftSubtask[] {
  const missing = parts.filter((p) => !draft.some((d) => sameTitle(d.title, p.title)));
  if (!missing.length) return draft;
  notes.push(`kept the open plan's ${missing.map((p) => `"${p.title}"`).join(', ')} beside the new work: the message answers questions, it changes no part`);
  return [...missing.map((p): DraftSubtask => ({
    title: p.title, brief: p.brief, search_terms: p.search_terms ?? [p.title.slice(0, 60)], category: p.category,
    self_do_ok: p.self_do_ok ?? false, criteria: p.criteria?.map((c) => ({ ...c, spec: { ...c.spec } })) ?? [],
    ...(p.inputs?.length ? { inputs: p.inputs } : {}), ...(p.self_do_reason === 'rook_edit' ? { rook_edit: true } : {}),
  })), ...draft];
}

export type PlanInput = {
  draft: DraftSubtask[];
  selected: AgentSummary[][]; // per draft subtask, the agents the select step picked
  quotes: Record<string, QuoteResult>; // by handle
  recipients: X402Config['recipients'];
  budget_atomic: bigint;
  reserve_share: number;
  history?: Record<string, AgentHistory>; // Rook's own verdicts by handle; without it, the market's record alone
  files?: string[]; // the paths of the conversation's current files: the only inputs a subtask may name
  sizes?: ReadonlyMap<string, number>; // the characters of each of those files, by path (a Rook edit's are capped)
};

/** The contract's ceiling on the reserve, in basis points of the budget (contract/budget/src/lib.rs MAX_RESERVE_BPS). */
export const MAX_RESERVE_BPS = 9_000;

export function buildPlan(input: PlanInput): Omit<Plan, 'llm_calls'> {
  const notes: string[] = [];
  const dropped: Plan['dropped'] = [];
  const allocatable = input.budget_atomic - share(input.budget_atomic, input.reserve_share);
  const files = input.files ?? [];
  const draft = input.draft.map((d) => {
    if (d.self_do_ok && !writable(d)) notes.push(`"${d.title}": Rook can't put work online, so it can't write this part itself`);
    return writable(d) === d.self_do_ok ? d : { ...d, self_do_ok: false };
  });
  const inputs = draft.map((d) => {
    const { kept: ok, unknown } = inputsOf(d, files);
    for (const p of unknown) notes.push(`"${d.title}": input ${p} dropped, it is not one of this conversation's files`);
    return ok;
  });
  const sizes = input.sizes ?? new Map<string, number>();
  const edits = draft.map((d) => isRookEdit(d, files, sizes));
  draft.forEach((d, i) => {
    if (!d.rook_edit || edits[i]) return;
    const why = !inputs[i].length ? 'it changes no file of this conversation' : !writable(d) ? 'Rook can\'t write it itself'
      : `its files come to ${inputChars(inputs[i], sizes)} characters, more than the ${ROOK_EDIT_MAX_CHARS} Rook edits itself at once`;
    notes.push(`"${d.title}" is not a Rook edit: ${why}`);
  });

  // Steps 4 to 7, in priority order. `draftIdx` keeps the draft position for cross-check rewriting.
  type Kept = { draftIdx: number; d: DraftSubtask; candidates: Candidate[]; ranked: Ranked[]; cap: bigint; self_do: boolean; self_do_reason?: SelfDoReason; need?: bigint };
  const kept: Kept[] = [];
  let allocated = 0n;
  // First pass: a subtask is hired when one of its agents fits what is left to allocate, at that agent's price. The
  // first hire must fit the cap, so the first-ranked agent that fits leads, and the agents ranked above it follow it
  // in rank order: the reserve may still pay one as a fallback (the prune pass drops those it never can). Fallback
  // cover comes in the second pass, so it never costs a later subtask its agent.
  // Subtasks only an agent can do (not self_do_ok) are funded first, in priority order, then the rest: a part Rook can
  // write itself must not take the money a later part needs and be dropped for.
  const order = draft.map((d, draftIdx) => ({ d, draftIdx })).sort((x, y) => Number(x.d.self_do_ok) - Number(y.d.self_do_ok));
  order.forEach(({ d, draftIdx }) => {
    // A rename or a colour is Rook's at once: no hire to wait 30 min for, no fee (QA: a colour change could cost 0.50).
    if (edits[draftIdx]) { kept.push({ draftIdx, d, candidates: [], ranked: [], cap: 0n, self_do: true, self_do_reason: 'rook_edit' }); return; }
    const ranked = quotedCandidates(input.selected[draftIdx] ?? [], input.quotes, input.recipients, input.history ?? {}, d.title, d.self_do_ok, notes);
    const quoted = ranked.map((r) => r.c);
    const left = allocatable - allocated;
    const fits = quoted.findIndex((c) => price(c) <= left);
    if (fits >= 0) {
      const lead = quoted[fits];
      for (const c of quoted.slice(0, fits)) notes.push(`"${d.title}": candidate ${c.handle} moved after ${lead.handle}, price ${c.price_atomic} exceeds the ${left} left to allocate`);
      let candidates = [lead, ...quoted.slice(0, fits), ...quoted.slice(fits + 1)];
      // A fallback priced far above the agent hired first is no fallback for a part Rook can write itself: if the
      // cheaper agents fail, Rook writes it, rather than the reserve paying 400 times the lead's price for the same text
      // (seen: a 0.02 USDC guide with fallbacks at 5.00 and 8.00). One only an agent can do keeps it, with a note below.
      if (d.self_do_ok) {
        for (const c of candidates) if (far(c, lead)) notes.push(`"${d.title}": candidate ${c.handle} dropped: its price, ${formatUsdc(c.price_atomic)} USDC, is more than ${FAR_PRICE} times the ${formatUsdc(lead.price_atomic)} USDC of the agent hired first, and Rook writes this part itself if the cheaper agents fail`);
        candidates = candidates.filter((c) => !far(c, lead));
      }
      allocated += price(lead);
      kept.push({ draftIdx, d, candidates, ranked, cap: price(lead), self_do: false });
      return;
    }
    const self_do_reason: SelfDoReason = quoted.length ? 'over_budget' : 'no_agent';
    // Over budget: the cheapest quote is what one hire would have cost, so a client can name the budget that hires one,
    // and the plan says what the agents that fit ask (QA: a deploy over budget said only "Rook couldn't draft a plan").
    const prices = quoted.map(price).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const need = prices.length ? prices[0] : undefined;
    if (need !== undefined) {
      const most = prices[prices.length - 1];
      notes.push(`Rook found no agent for "${d.title}" at this budget: ${prices.length === 1 ? `the one that fits asks ${formatUsdc(need)} USDC` : `the ${prices.length} that fit ask ${need === most ? formatUsdc(need) : `${formatUsdc(need)} to ${formatUsdc(most)}`} USDC`}.`);
    }
    if (!d.self_do_ok) { dropped.push({ title: d.title, reason: quoted.length ? 'over budget' : 'no fitting agent', ...(need !== undefined ? { need_atomic: need.toString() } : {}) }); return; }
    if (quoted.length) notes.push(`"${d.title}" is self_do: no candidate's price fits the ${left} left to allocate`);
    kept.push({ draftIdx, d, candidates: [], ranked, cap: 0n, self_do: true, self_do_reason, need });
  });
  kept.sort((x, y) => x.draftIdx - y.draftIdx); // back in priority order

  // Second pass, same order: raise each cap toward fallbackCap, as far as the allocatable budget allows.
  for (const k of kept) {
    if (k.self_do) continue;
    const want = fallbackCap(k.candidates), most = k.cap + allocatable - allocated;
    const cap = want < most ? want : most;
    if (cap > k.cap) { allocated += cap - k.cap; k.cap = cap; }
  }

  // Whatever the caps leave of the budget becomes the reserve for re-hires and top-ups, up to the contract's 90%: the
  // user's budget is what Rook may spend, so it must not sit idle while a subtask is abandoned for want of a top-up
  // (seen on mainnet: 0.90 USDC unallocated, a 0.50 re-hire refused). Whole percents, so the numbers read cleanly.
  // A fallback the part can't pay once the agents before it are paid is never hired: x402 pays up front, so in the worst
  // case each one tried was paid and failed, the lead from the cap, then each fallback from what is left of the cap
  // topped up from what is left of the reserve (QA: cap 12, reserve 8, agents at 6, 15 and 19: once 6 is paid, 15
  // needs a 9 top-up, and the card still said "up to 3 agents are tried"). One that can't be paid is skipped unpaid.
  // A cap raised to cover one shrinks back, which grows the reserve, until no cap changes (caps only shrink, so this ends).
  const payable = (k: Kept, reserve: bigint) => {
    let balance = k.cap, left = reserve;
    return k.candidates.filter((c) => {
      const p = price(c), short = p > balance ? p - balance : 0n;
      if (short > left) return false;
      left -= short;
      balance += short - p;
      return true;
    });
  };
  let { reserve_bps, reserve } = reserveOf(input.budget_atomic, allocated);
  for (let shrunk = true; shrunk;) {
    shrunk = false;
    for (const k of kept) {
      if (k.self_do) continue;
      const cap = fallbackCap(payable(k, reserve));
      if (cap < k.cap) { allocated -= k.cap - cap; k.cap = cap; shrunk = true; }
    }
    ({ reserve_bps, reserve } = reserveOf(input.budget_atomic, allocated));
  }
  // Listing an unpayable fallback would only stretch the deadline. Any fallback can be dropped (the order is not by
  // price), never the lead, whose price the cap always covers.
  for (const k of kept) {
    if (k.self_do) continue;
    const ok = payable(k, reserve);
    // The first wording is the one the web app reads to name the budget that would hire such an agent.
    for (const c of k.candidates) {
      if (ok.includes(c)) continue;
      notes.push(price(c) > k.cap + reserve
        ? `"${k.d.title}": candidate ${c.handle} dropped, price ${c.price_atomic} exceeds cap + reserve`
        : `"${k.d.title}": candidate ${c.handle} dropped: once the agents before it are paid, the cap and reserve left can't pay its ${formatUsdc(c.price_atomic)} USDC`);
    }
    k.candidates = ok;
    const lead = ok[0];
    for (const c of ok) if (far(c, lead)) notes.push(`"${k.d.title}": if the agents before it fail, ${c.handle} may be hired at ${formatUsdc(c.price_atomic)} USDC, more than ${FAR_PRICE} times the ${formatUsdc(lead.price_atomic)} USDC of the agent hired first, paid from the reserve: only an agent can do this part`);
    explain(k.candidates, k.ranked, k.d.self_do_ok);
  }

  // Step 9 ids: draft id (s<draftIdx+1>) -> final id, for cross-check references.
  const finalId = new Map(kept.map((k, i) => [`s${k.draftIdx + 1}`, `s${i + 1}`]));

  const subtasks: PlanSubtask[] = kept.map((k, i) => {
    const id = `s${i + 1}`;
    const ins = inputs[k.draftIdx];
    const category = marketCategory(k.d.category);
    return {
      id,
      title: k.d.title,
      brief: repairBrief(k.d.title, k.d.brief),
      search_terms: k.d.search_terms,
      ...(category ? { category } : {}),
      criteria: validateCriteria(id, i, k.d, finalId, notes, ins),
      cap_atomic: k.cap.toString(),
      // Rook waits for a hire at most ROOK_HIRE_PATIENCE_S, whatever SLA the agent advertises.
      deadline_s: k.self_do ? 0 : Math.min(Math.max(...k.candidates.map((c) => c.sla_seconds)), config.hirePatienceS),
      self_do: k.self_do,
      self_do_ok: k.d.self_do_ok,
      ...(k.self_do ? { self_do_reason: k.self_do_reason } : {}),
      ...(k.need !== undefined ? { self_do_need_atomic: k.need.toString() } : {}),
      ...(ins.length ? { inputs: ins } : {}),
      candidates: k.candidates,
    };
  });

  // A plan of Rook's own edits only hires no one and holds nothing: no budget figures at all (QA: a rename carried a
  // 0.90 USDC reserve that any client rendering the budget would show).
  const edits0 = kept.length > 0 && kept.every((k) => k.self_do_reason === 'rook_edit');
  return {
    subtasks,
    dropped,
    budget: edits0
      ? { budget_atomic: '0', reserve_atomic: '0', reserve_bps: 0, allocatable_atomic: '0', allocated_atomic: '0' }
      : {
        budget_atomic: input.budget_atomic.toString(),
        reserve_atomic: reserve.toString(),
        reserve_bps,
        allocatable_atomic: (input.budget_atomic - reserve).toString(),
        allocated_atomic: allocated.toString(),
      },
    notes,
  };
}
/** A plan of Rook's own edits only: it takes no money (its budget figures are 0). */
export const editsOnly = (p: Pick<Plan, 'subtasks'>) => p.subtasks.length > 0 && p.subtasks.every((s) => s.self_do_reason === 'rook_edit');

const price = (c: Candidate) => BigInt(c.price_atomic);

/**
 * The cap that covers a subtask's fallback, over its first two listed prices: min(max(first, second), 2 x first).
 * Ranked by expected cost, so the first hire is not always the cheapest: never below the first hire's price, it also
 * covers the next-listed fallback (when the first fails without charge) unless that one costs more than twice the
 * first, so one expensive candidate cannot inflate what the user locks per subtask; a pricier fallback is paid by a
 * reserve top-up. With candidates cheapest first it is min(second, 2 x first).
 */
function fallbackCap(candidates: Candidate[]): bigint {
  const first = price(candidates[0]), second = price(candidates[Math.min(1, candidates.length - 1)]);
  const both = second > first ? second : first;
  return both < first * 2n ? both : first * 2n;
}

/** The reserve: every budget unit no cap takes, in whole percents of the budget, at most MAX_RESERVE_BPS. */
function reserveOf(budget: bigint, allocated: bigint): { reserve_bps: number; reserve: bigint } {
  const reserve_bps = budget > 0n ? Math.min(MAX_RESERVE_BPS, Math.floor(Number(((budget - allocated) * 10_000n) / budget) / 100) * 100) : 0;
  return { reserve_bps, reserve: (budget * BigInt(reserve_bps)) / 10_000n };
}

/**
 * An agent with this many recent stalls (AgentHistory.stalled: Rook's hires of it since its last delivery that failed to
 * send or timed out) is dropped while another candidate is left. On mainnet dev-tools-agent stalled 5 times running and
 * still led every website plan: the user funded it and waited through failed sends before Rook wrote the page itself.
 */
export const STALL_LIMIT = 2;
/** A fallback priced above this many times the lead's price is kept only for a part Rook cannot write itself. */
export const FAR_PRICE = 10n;
// ponytail: waiting is priced at one flat rate for every user and part, 1 USDC an hour; a per-user value of time, or a
// "cheapest first" choice, is the ceiling.
const WAIT_ATOMIC_PER_HOUR = 1_000_000n;
/** Failures counted before any record: p_pass = 1 / (1 + 9) = 0.1 for an agent no one has seen deliver (rank). */
const NO_RECORD_FAILS = 9;

const far = (c: Candidate, lead: Candidate) => price(c) > FAR_PRICE * price(lead);

/** A candidate as ranked: `wait_s` is what one failed try of it holds the part, `score` the money plus that waiting. */
type Ranked = { c: Candidate; stalls: number; proven: boolean; wait_s: number; score: bigint };

/**
 * Step 4: keep agents whose quote succeeded with a row matching a /x402 recipient, ranked by score (rank(): expected
 * cost plus the waiting a failed try costs, lowest first), then expected cost, higher p_pass, more delivered jobs,
 * handle. Agents with recent stalls go after the rest, and those with STALL_LIMIT or more are dropped unless no other
 * agent is left.
 */
function quotedCandidates(agents: AgentListing[], quotes: Record<string, QuoteResult>, recipients: X402Config['recipients'], history: Record<string, AgentHistory>, title: string, selfDoOk: boolean, notes: string[]): Ranked[] {
  const out: Ranked[] = [];
  for (const a of agents) {
    const q = quotes[a.handle];
    if (!q) { notes.push(`"${title}": no quote from ${a.handle}`); continue; }
    if (!q.ok) { notes.push(`"${title}": quote from ${a.handle} failed (${q.error.code}: ${q.error.message})`); continue; }
    const row = AcceptsRow.safeParse(q.row);
    const r = row.success ? row.data : undefined;
    if (!r || r.scheme !== 'exact' || !recipients.some((x) => x.network === r.network && x.asset === r.asset && x.payTo === r.payTo)) {
      notes.push(`"${title}": quote from ${a.handle} dropped: row does not match the /x402 recipients`);
      continue;
    }
    // Same rule as the orchestrator's checkQuote: x402 cannot pay 0, and the contract refuses a cap of 0.
    if (BigInt(r.amount) <= 0n) {
      notes.push(`"${title}": quote from ${a.handle} dropped: amount ${r.amount} is not a payable price`);
      continue;
    }
    // The orchestrator and the signer refuse a longer payment window at hire time, so the plan never lists such an agent.
    const max = config.maxPaymentTimeoutS;
    if (!Number.isInteger(r.maxTimeoutSeconds) || r.maxTimeoutSeconds < 1 || r.maxTimeoutSeconds > max) {
      notes.push(`"${title}": quote from ${a.handle} dropped: payment window ${r.maxTimeoutSeconds} s is not from 1 to ${max} s (ROOK_MAX_PAYMENT_TIMEOUT_S)`);
      continue;
    }
    const own = Object.hasOwn(history, a.handle) ? history[a.handle] : undefined;
    const { p_pass, expected_cost_atomic, rank_reason, ...meta } = rank(a, r.amount, own);
    out.push({
      c: {
        handle: a.handle, name: a.name, description: a.description, sla_seconds: a.sla_seconds,
        success_rate: a.success_rate, delivered_jobs: a.delivered_jobs, price_atomic: r.amount, quote: r,
        p_pass, expected_cost_atomic, rank_reason,
      },
      stalls: own?.stalled ?? 0, ...meta,
    });
  }
  // Agents that keep failing to receive work are skipped while another agent is left; when none is, they stay, last
  // resort before Rook writes the part (explain() says so on their line).
  const failing = out.filter((x) => x.stalls >= STALL_LIMIT);
  const left = failing.length < out.length ? out.filter((x) => x.stalls < STALL_LIMIT) : out;
  if (left !== out) for (const x of failing) notes.push(`"${title}": candidate ${x.c.handle} dropped: Rook's last ${x.stalls} jobs to it failed to send or timed out`);
  else if (failing.length) notes.push(`"${title}": ${failing.map((x) => x.c.handle).join(', ')} failed to send or timed out on Rook's last jobs and ${failing.length === 1 ? 'is the only agent' : 'are the only agents'} found, so ${selfDoOk ? 'Rook will likely write this part itself' : 'this part may not be delivered'}`);
  const cmp = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
  return left.sort((x, y) =>
    // An agent whose recent hire never reached work goes after those that did: a fallback, not banned.
    (Number(x.stalls > 0) - Number(y.stalls > 0)) || cmp(x.score, y.score)
    || cmp(BigInt(x.c.expected_cost_atomic), BigInt(y.c.expected_cost_atomic))
    || (y.c.p_pass - x.c.p_pass) || (y.c.delivered_jobs - x.c.delivered_jobs) || (x.c.handle < y.c.handle ? -1 : x.c.handle > y.c.handle ? 1 : 0));
}

/**
 * p_pass = (successes + 1) / (jobs + 2) (Laplace) over the market's record plus Rook's own verdicts on this agent, and
 * expected cost = price / p_pass: what Rook pays per passing deliverable on average. With no record at all p_pass is
 * 0.1, the rate measured on mainnet (2026-11-11): agents with no market record delivered 2 of 23 paid hires, agents
 * with one 14 of 17. Laplace's 0.5 had such an agent lead a proven one to save cents, then hold the part to the end of
 * Rook's patience. ponytail: a fixed rate from one day's hires; learn it from Rook's own history as it grows.
 * The rank also counts time: each failed try holds the part `wait_s`, priced at WAIT_ATOMIC_PER_HOUR, and Rook expects
 * (1 - p) / p failed tries per pass. An agent that has delivered somewhere (market jobs or Rook's verdicts) fails in its
 * usual time (the market's median, else its SLA); one that never delivered anywhere may never show, so a try waits out
 * Rook's whole patience for it (SLA + grace, at most ROOK_HIRE_PATIENCE_S). So an unknown 0.05 USDC agent with a 2 h SLA
 * no longer leads one with 18 passes of 20 at 0.15 (seen live): a no-show costs 30 min to save 0.10 USDC.
 */
function rank(a: AgentListing, price: string, own: AgentHistory | undefined) {
  // success_rate is the market's percentage (0 to 100; the simulator's too). With none, the market's jobs say nothing
  // about passing, so they count as 0 of 0. Market numbers are untrusted: clamped, and non-finite ones ignored.
  const known = a.success_rate !== null && Number.isFinite(a.success_rate) && Number.isFinite(a.delivered_jobs);
  const jobs = Number.isFinite(a.delivered_jobs) ? Math.max(0, Math.floor(a.delivered_jobs)) : 0;
  const mJobs = known ? jobs : 0;
  // Multiply before dividing so a half rounds up exactly: 29% of 50 is 14.5 -> 15 (0.29 * 50 is 14.4999... -> 14).
  const mPass = known ? Math.min(mJobs, Math.round((Math.min(100, Math.max(0, a.success_rate!)) * mJobs) / 100)) : 0;
  const rPass = own?.pass ?? 0, rJobs = rPass + (own?.fail ?? 0);
  const s = mPass + rPass, n = mJobs + rJobs;
  // Never delivered anywhere: the measured base rate (NO_RECORD_FAILS), not Laplace's 0.5: p = (s + 1) / (n + 1 + b).
  // Market jobs with no pass rate still count as a record: such an agent delivers, at an unknown rate.
  const b = jobs === 0 && rJobs === 0 ? NO_RECORD_FAILS : 1;
  // price / p = price * (n + 1 + b) / (s + 1), rounded up in integers: money never goes through a float.
  const expected = (BigInt(price) * BigInt(n + 1 + b) + BigInt(s)) / BigInt(s + 1);
  const p_pass = Math.min(1, Math.round(((s + 1) * 1000) / (n + 1 + b)) / 1000); // 201 / 400 = 0.5025 -> 0.503, same reason
  const proven = jobs > 0 || rJobs > 0;
  const sla = Number.isFinite(a.sla_seconds) ? Math.max(0, a.sla_seconds) : config.hirePatienceS;
  const patience = Math.min(sla + config.paymentGraceS, config.hirePatienceS); // the orchestrator's slaEnd
  const usual = a.response_s !== undefined && Number.isFinite(a.response_s) && a.response_s > 0 ? a.response_s : sla;
  const wait_s = Math.ceil(proven ? Math.min(usual, patience) : patience);
  // (1 - p) / p = (n - s + b) / (s + 1) failed tries per pass, each holding the part wait_s; rounded up, as above.
  const den = 3600n * BigInt(s + 1);
  const waiting = (WAIT_ATOMIC_PER_HOUR * BigInt(wait_s) * BigInt(n - s + b) + den - 1n) / den;
  const counted = [mJobs > 0 && `market ${mPass} of ${mJobs}`, !known && jobs > 0 && `${jobs} market ${jobs === 1 ? 'job' : 'jobs'} with no pass rate`, rJobs > 0 && `Rook ${rPass} of ${rJobs}`];
  // "No record yet" beside "5 recent hires failed" read as a contradiction: stalls are jobs that never finished.
  const record = counted.filter(Boolean).join(', ') || ((own?.stalled ?? 0) > 0 ? 'no finished job yet' : 'no record yet');
  return {
    p_pass, expected_cost_atomic: expected.toString(),
    rank_reason: `${formatUsdc(price)} USDC / ${p_pass} pass chance (${record}) = ${formatUsdc(expected)} USDC expected`,
    proven, wait_s, score: expected + waiting,
  };
}

/**
 * Ends each listed candidate's rank_reason with why it sits where it does, against the final list (after the budget
 * moved or dropped agents), so a line never claims others that are not there ("ranked after the others" on the only
 * candidate, seen live): its stalls, or the waiting that put it after an agent of higher expected cost.
 */
function explain(list: Candidate[], ranked: Ranked[], selfDoOk: boolean) {
  const at = new Map(ranked.map((r, i) => [r.c, { r, i }]));
  const min = (s: number) => Math.max(1, Math.round(s / 60));
  list.forEach((c, i) => {
    const { r, i: rankIdx } = at.get(c)!;
    const before = list.slice(0, i);
    if (r.stalls >= STALL_LIMIT) {
      c.rank_reason += `; Rook's last ${r.stalls} jobs to this agent failed to send or timed out, so ${selfDoOk ? 'Rook will likely write this part itself' : 'this part may not be delivered'}`;
    } else if (r.stalls > 0) {
      const one = r.stalls === 1;
      c.rank_reason += before.some((b) => at.get(b)!.r.stalls === 0)
        ? `; ranked after the others: ${r.stalls} recent ${one ? 'hire' : 'hires'} by Rook failed to send or timed out`
        : `; Rook's last ${one ? 'job' : `${r.stalls} jobs`} to this agent failed to send or timed out`;
    } else {
      // Ranked above it and dearer per pass: only the waiting can have put that agent first (the lead moved for the
      // budget is not ranked above it, and its plan note says why).
      const dearer = before.filter((b) => at.get(b)!.i < rankIdx && BigInt(b.expected_cost_atomic) > BigInt(c.expected_cost_atomic)).map((b) => b.handle);
      if (!dearer.length) return;
      const names = dearer.length <= 2 ? dearer.join(' and ') : `${dearer.slice(0, 2).join(', ')} and ${dearer.length - 2} more`;
      c.rank_reason += r.proven
        ? `; ranked after ${names}: a failed try of this agent holds the part about ${min(r.wait_s)} min`
        : `; ranked after ${names}: it has delivered no job yet, and a no-show holds the part up to ${min(r.wait_s)} min`;
    }
  });
}

// ponytail: compile-only Ajv, lenient about unknown keywords and formats; the evaluator does the real validation.
const ajv = new Ajv({ strict: false, logger: false });

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Word count", "Total words", "Number of characters", "Characters"; not "Words per minute" or "Keywords found".
const COUNT_LABEL = /\b(?:word|character|char)s?\s*(?:count|total|length)\b|\b(?:number|count|total) of (?:words|characters|chars)\b|^\W*(?:total\s+)?(?:words|characters|chars)\W*$/i;


/** Text as compared for "the brief asks for it": lower case, accents and marks off ("İ" is "i"), quotes and spaces folded. */
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[“”«»„‘’`']/g, '"').replace(/\s+/g, ' ').trim();

/**
 * A contains pattern written as a regex on purpose: /like this/, or with syntax only a regex has (\s, \d, \b, an escaped
 * character, .* or .+, (?, a|b, a range such as [a-z], {2,4}, a leading ^). Its body; undefined for a literal: "[Startup
 * name]", "Price (USD)" and "$29/mo" are text to find as written (QA: "[Startup name]" read as a character class passed a
 * page with invented names).
 */
const REGEX_ONLY = /\\[dDwWsSbB.()[\]{}|*+?^$/\\-]|\.[*+?]|\(\?|\[\^?[^\]\s\\]-[^\]\s\\]|\{\d+(?:,\d*)?\}|[\w)]\|[\w(]|^\^/;
function deliberateRegex(p: string): string | undefined {
  const slashed = /^\/(.+)\/$/s.exec(p);
  if (slashed) return slashed[1];
  return REGEX_ONLY.test(p) ? p : undefined;
}
/** A brief that changes from, replaces or removes `text`: "from Ozan Andaç to Jordan Çelik", "remove the Skills section". */
const oldText = (text: string) =>
  new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:from|remove|delete|drop|replace|rename|kaldır|çıkar)\s+(?:the\s+)?["“'‘]?${escapeRegExp(text)}`, 'iu');

// A numeric label's kind, for its sanity range (section 7): a change or growth rate can't fall below -100 % and has no
// top; a net figure or a difference has no bound known without the data; a share of a whole is 0 to 100; any other
// quantity is at least 0 (a count at least 1).
const RATE_LABEL = /\b(?:cagr|growth|change|returns?|roi|apy|apr|yields?|inflation|interest|büyüme|artış|değişim|getiri|enflasyon)\b/i;
const SIGNED_LABEL = /\b(?:net|flows?|inflows?|outflows?|profit|loss|p&l|pnl|delta|difference|kâr|zarar|fark)\b/i;
const SHARE_LABEL = /%|\b(?:share|percent|percentage|pct|ratio|proportion|portion|dominance|concentration|pay[ıi]|oran[ıi]?|yüzde\w*)\b/i;
const COUNTED = /\b(?:count|number|holders?|wallets?|accounts?|users?|transactions?|txs?|supply|addresses|validators?|sayı\w*)\b/i;
/**
 * The bounds a numeric check may keep: only what is known without the data, never a guess of the answer (QA: a CAGR
 * capped at 50 failed honest nominal lira growth; a total supply of 1e9 to 2e9 guessed it). null: no bound is known.
 */
function saneBounds(label: string, min?: number, max?: number): { min?: number; max?: number } | null {
  if (RATE_LABEL.test(label)) return { min: min !== undefined && min <= -100 ? min : -100 };
  if (SIGNED_LABEL.test(label)) return null;
  if (SHARE_LABEL.test(label)) return { min: min !== undefined && min <= 0 ? min : 0, max: max !== undefined && max >= 100 ? max : 100 };
  return { min: min !== undefined && min <= (COUNTED.test(label) ? 1 : 0) ? min : 0 };
}
const span = (b: { min?: number; max?: number }) => (b.max === undefined ? `at least ${b.min}` : `${b.min} to ${b.max}`);

// A part that translates a text the brief gives: its phrases are in the brief whatever the agent writes. Its title says
// so, or its brief asks to translate into a language ("translate the mockup into HTML" is no translation).
const TRANSLATION = /\b(?:translat\w*|çevir\w*|tercüme\w*|tradu\w*|übersetz\w*|перев\w*)/i;
// Turkish "İ" folds to no "i" in a JavaScript regex, and \b sees no edge before it: both are written out.
const LANGUAGE = String.raw`(?:english|turkish|spanish|french|german|italian|portuguese|dutch|russian|arabic|chinese|japanese|korean|türkçe\p{L}*|[iİ]ngilizce\p{L}*|almanca\p{L}*|fransızca\p{L}*|[iİ]spanyolca\p{L}*|[iİ]talyanca\p{L}*|español|inglés|français|anglais|deutsch|englisch)`;
const TRANSLATE_INTO = new RegExp(String.raw`(?<!\p{L})(?:translat\p{L}*|tradu\p{L}*|übersetz\p{L}*)[^.\n]{0,80}(?<!\p{L})(?:into|to|al|en|ins|in)\s+${LANGUAGE}|(?<!\p{L})${LANGUAGE}\s+(?:çevir\p{L}*|tercüme\p{L}*)|(?<!\p{L})(?:çevir\p{L}*|tercüme\p{L}*)[^.\n]{0,40}(?<!\p{L})${LANGUAGE}`, 'iu');
const isTranslation = (d: DraftSubtask) => TRANSLATION.test(d.title) || TRANSLATE_INTO.test(d.brief.slice(0, 400));
const WORDS_ONLY = /^[\p{L}\p{N}\s'’-]+$/u;
const TRANSLATION_JUDGE = 'Is the deliverable a complete and faithful translation of the text the brief gives, into the language the brief asks for?';
// Files Rook can't take back as text: a files check on one could never pass.
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|avif|heic|mp4|mov|webm|avi|mkv|mp3|wav|ogg|m4a|flac|pdf|zip|gz|tar|woff2?|ttf|otf|eot|psd|ai|fig|sketch|docx?|xlsx?|pptx?)$/i;

/**
 * Step 8 + section 7 rules. `pos` is the subtask's final index; cross-checks must point strictly earlier. `inputs`: the
 * files an edit changes; it must return them whole, so an edit with no files check gets one, unless it acts in the world
 * (a deploy is checked by its live link: QA, a files check failed every honest deploy after it was paid). Every contains
 * pattern and files path must be something the brief asks for, since the agent sees only the brief (QA: honest work
 * failed on "YETENEKLERİM", "NEAR Foundation" and rgb(30, 58, 138), none of them in the brief).
 */
function validateCriteria(id: string, pos: number, d: DraftSubtask, finalId: Map<string, string>, notes: string[], inputs: string[] = []): Criterion[] {
  const out: Criterion[] = [];
  const where = fold(`${d.title}\n${d.brief}`);
  const deploy = isAction(d);
  const translation = isTranslation(d);
  let judges = 0, length: Criterion | undefined;
  d.criteria.forEach((rc, j) => {
    const at = `criterion ${id}.c${j + 1}`;
    const remove = (why: string) => notes.push(`${at} removed: ${why}`);
    const parsed = Criterion.safeParse({ ...rc, id: 'tmp' });
    if (!parsed.success) return remove(`invalid ${rc.kind} criterion (${parsed.error.issues[0]?.message ?? 'bad shape'})`);
    let c = parsed.data;
    switch (c.kind) {
      case 'contains': {
        if (linkOnly(c.spec.pattern)) {
          c = { id: c.id, kind: 'live_url', description: c.description, spec: { label: /live/i.test(c.spec.pattern) ? 'Live URL' : 'URL' } };
          notes.push(`${at}: a link check by pattern became a live_url check, which loads the link`);
          break;
        }
        // Text is found as written by default; a regex only on purpose, marked /like this/ for the evaluator.
        const p = c.spec.pattern, body = deliberateRegex(p);
        let re: RegExp | undefined;
        if (body !== undefined) {
          try { re = new RegExp(body, 'i'); } catch { notes.push(`${at}: invalid regex, matched as written instead`); }
        }
        if (re) {
          // ponytail: a model-written regex runs unguarded against the brief, as in the evaluator.
          if (re.test('')) return remove(`the regex ${p} matches empty text, so it passes anything (a lookahead such as (?!...) checks nothing)`);
          if (!new RegExp(body!, 'im').test(`${d.title}\n${d.brief}`)) return remove(`the regex ${p} matches nothing the brief asks for`);
          c.spec.pattern = `/${body}/`;
          break;
        }
        const lit = /^\/.+\/$/s.test(p) ? p.slice(1, -1) : p;
        if (!lit.trim()) return remove('an empty pattern checks nothing');
        if (translation && WORDS_ONLY.test(lit)) return remove(`"${lit}" is a phrase of the text to translate or a guess of its translation: a judge reads the translation instead`);
        if (!where.includes(fold(lit))) return remove(`"${lit}" is not in the brief, so an agent that follows the brief need not write it`);
        // Text the brief changes from or removes can only be checked as gone: "Old name is gone" written as a check for
        // the old name failed every correct rename (t_095f2819).
        if (!c.spec.absent && oldText(lit).test(d.brief)) {
          c.spec.absent = true;
          notes.push(`${at}: "${lit}" is text the brief replaces or removes, so it is checked as gone`);
        }
        c.spec.pattern = lit;
        break;
      }
      case 'files': {
        if (deploy) return remove('a part that acts in the world, such as a deploy, is checked by its live link, not by files sent back');
        const clean = [...new Set(c.spec.paths.map(cleanPath).filter((p): p is string => !!p))];
        if (!clean.length) return remove('no file path inside the project');
        const binary = clean.filter((p) => BINARY.test(p));
        if (binary.length) notes.push(`${at}: ${binary.join(', ')} left out: Rook can't take ${binary.length === 1 ? 'it' : 'them'} back as a text file`);
        const named = (p: string) => inputs.includes(p) || where.includes(fold(p)) || where.includes(fold(p.split('/').pop()!));
        const unnamed = clean.filter((p) => !BINARY.test(p) && !named(p));
        if (unnamed.length) notes.push(`${at}: ${unnamed.join(', ')} left out: the brief doesn't ask for ${unnamed.length === 1 ? 'it' : 'them'}`);
        const paths = clean.filter((p) => !BINARY.test(p) && named(p));
        if (!paths.length) return remove('no file it checks is one the brief asks for as text');
        c.spec.paths = paths;
        break;
      }
      case 'schema':
        try { ajv.compile(c.spec.json_schema); } catch (e: any) { return remove(`invalid JSON schema (${e?.message ?? e})`); }
        break;
      case 'numeric_match': {
        const { min, max } = c.spec;
        if ([min, max].some((b) => b !== undefined && !Number.isFinite(b))) return remove('non-finite bound');
        if (min !== undefined && max !== undefined && min > max) return remove('min is above max');
        // A date ("2026-10-15") or an id is not one number: the check would fail honest work (seen on mainnet).
        if (/\b(dates?|dated|year|version|ids?|phone)\b/i.test(c.spec.label)) return remove(`"${c.spec.label}" is a date or id, not a quantity`);
        // A "Word count: 412" line ended up in the user's CV, and a self-reported count proves nothing: a judge reads the
        // length instead, if a judge slot is left once the brief's own judges are in.
        const count = COUNT_LABEL.exec(c.spec.label);
        if (count) {
          const unit = /word/i.test(count[0]) ? 'words' : 'characters';
          remove(`"${c.spec.label}" is a ${unit.slice(0, -1)} count, which would have to be printed in the work`);
          const range = min !== undefined && max !== undefined ? `roughly ${min} to ${max} ${unit}` : min !== undefined ? `at least roughly ${min} ${unit}` : `at most roughly ${max} ${unit}`;
          length ??= { id: 'tmp', kind: 'llm_judge', description: `About the length asked for (${range})`, spec: { question: `Is the deliverable ${range} long?` } };
          return;
        }
        const sane = saneBounds(c.spec.label, min, max);
        if (!sane) return remove(`"${c.spec.label}" can be below or above 0, so no bound on it is known without the data`);
        if (sane.min !== min || sane.max !== max) {
          notes.push(`${at}: the bounds on "${c.spec.label}" (${min ?? '-inf'} to ${max ?? 'inf'}) guessed the answer: it checks ${span(sane)} instead`);
          c.spec = { label: c.spec.label, ...sane };
        }
        break;
      }
      case 'cross_check': {
        const ref = finalId.get(c.spec.other_subtask);
        if (!ref) return remove(`cross_check references ${c.spec.other_subtask}, which is not in the final plan`);
        if (Number(ref.slice(1)) - 1 >= pos) return remove(`cross_check references ${c.spec.other_subtask}, which is not an earlier subtask`);
        c.spec.other_subtask = ref;
        break;
      }
      case 'llm_judge':
        if (++judges > MAX_JUDGES) return remove(`more than ${MAX_JUDGES} llm_judge criteria`);
        break;
    }
    out.push(c);
  });
  if (length && judges < MAX_JUDGES) { out.push(length); judges++; }
  if (translation && judges < MAX_JUDGES && !out.some((c) => c.kind === 'llm_judge' && /translat/i.test(c.spec.question))) {
    out.push({ id: 'tmp', kind: 'llm_judge', description: 'A complete, faithful translation', spec: { question: TRANSLATION_JUDGE } });
  }
  if (inputs.length && !deploy && !out.some((c) => c.kind === 'files')) {
    out.push({ id: 'tmp', kind: 'files', description: `Returns ${inputs.length === 1 ? inputs[0] : 'each changed file'} whole`, spec: { paths: inputs } });
  }
  if (out.length === 0) {
    out.push({ id: 'c1', kind: 'llm_judge', description: 'Default quality check', spec: { question: DEFAULT_JUDGE } });
    notes.push(`${id}: no valid criteria left, default llm_judge added`);
  }
  return out.map((c, j) => ({ ...c, id: `c${j + 1}` }));
}
