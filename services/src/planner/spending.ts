// Spending rules the user states in the chat (Plan.spending, docs/agent-wallet-plan.md): read from the draft leniently,
// each field on its own, and every number only from the user's own words. They become the policy of the user's agent
// wallet, so a model's mistake must never set or loosen one: a field that fails is left out with a note, never a failed
// plan, and the rules already in force stay as they were.
import { SpendingRules } from '../shared/types.ts';

type Field = keyof SpendingRules;
const FIELDS = Object.keys(SpendingRules.shape) as Field[];
/** Each rule in the user's words, for the notes. */
const LABEL: Record<Field, string> = {
  budget_usd: 'spending limit', period: 'period of the spending limit', per_task_max_usd: 'per-task limit',
  approval: 'approval rule', expires_days: 'time limit',
};

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
  // Turkish, the language Rook is most often written to in after English ("on", ten, is left out: it is English too).
  bir: 1, iki: 2, 'üç': 3, 'dört': 4, 'beş': 5, 'altı': 6, yedi: 7, sekiz: 8, dokuz: 9, yirmi: 20, otuz: 30, elli: 50, 'yüz': 100,
};
const WORD = Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|');
const value = (x: string) => (/^\d+$/.test(x) ? Number(x) : x === 'a' || x === 'an' ? 1 : WORDS[x] ?? NaN);

/**
 * Every number a text states, read every way it can be: "1,000" is 1000 and 1.0, "1.000,50" is 1000.5, "1k" is 1000,
 * "a thousand" and "two hundred" too. Reading too many ways only ever accepts an amount the text does hold.
 * ponytail: digits in any language, number words in English and Turkish only; the draft prompt asks for digits.
 */
export function numbersSaid(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d+(?:[.,']\d+)*)(\s*(?:k|bin|thousand)(?![\p{L}\d]))?/giu)) {
    const raw = m[1].replace(/'/g, '');
    // A mark groups thousands only before groups of exactly 3 digits: "2.5" is 2.5, never 25 (a limit loosened tenfold).
    for (const [group, dec] of [[',', '.'], ['.', ',']]) {
      const g = `\\${group}`, d = `\\${dec}`;
      if (!new RegExp(`^(?:\\d{1,3}(?:${g}\\d{3})+|\\d+)(?:${d}\\d+)?$`).test(raw)) continue;
      const n = Number(raw.split(group).join('').replace(dec, '.'));
      if (Number.isFinite(n)) out.add(m[2] ? n * 1000 : n);
    }
  }
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\p{L}\d])(?:(\d+|a|an|${WORD})\s+(hundred|thousand|yüz|bin)|(${WORD}))(?![\p{L}\d])`, 'giu'))) {
    // The multiple first: read word by word, "two hundred" was 2 and 100.
    const [, head, times, word] = m.map((x) => x?.toLowerCase());
    out.add(word !== undefined ? value(word) : value(head) * (times === 'hundred' || times === 'yüz' ? 100 : 1000)); // "two hundred", "5 bin"
  }
  out.delete(NaN);
  return [...out];
}

const UNIT_DAYS: [RegExp, number][] = [
  [/^(?:days?|gün\p{L}*|gun\p{L}*|días?|dias?|tage?|jours?)$/iu, 1],
  [/^(?:weeks?|hafta\p{L}*|semanas?|wochen?|semaines?)$/iu, 7],
  [/^(?:months?|ay|ayl\p{L}*|mes|meses|monate?|mois)$/iu, 30],
  [/^(?:years?|yıl\p{L}*|yil\p{L}*|años?|anos?|jahre?)$/iu, 365],
];
/** The durations a text states, in days: "two weeks" is 14, "30 days" 30, "a month" 30, "1 yıl" 365. */
export function daysSaid(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\p{L}\d])(\d+|a|an|${WORD})[\s-]*(\p{L}+)`, 'giu'))) {
    const n = value(m[1].toLowerCase());
    const unit = UNIT_DAYS.find(([re]) => re.test(m[2]));
    if (n && unit) out.add(n * unit[1]);
  }
  return [...out];
}

const same = (a: number, b: number) => Math.round(a * 1e6) === Math.round(b * 1e6);

/**
 * The spending rules after this message: the rules in force (`carried`, the conversation's) with the ones the draft read
 * into the latest message applied on top, field by field. `raw` is the draft's `spending` as the model wrote it. A rule
 * only changes what the message states: one it doesn't touch stays as it was. Each field is checked on its own: one of
 * the wrong type, or an amount or duration no message of the user's (`said`: the latest message and the earlier ones)
 * states, is left out with a note, so a model never sets a limit the user didn't give. `stated`: this message changed or
 * restated at least one rule, which a message that is only rules needs to be a reply at all.
 */
export function readSpending(raw: unknown, said: string[], carried: SpendingRules | undefined, notes: string[]): { rules?: SpendingRules; stated: boolean } {
  const keep = carried && Object.keys(carried).length ? { ...carried } : undefined;
  if (raw == null) return { rules: keep, stated: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    notes.push('the draft gave spending rules Rook could not read: the rules in force stay as they were');
    return { rules: keep, stated: false };
  }
  const amounts = said.flatMap(numbersSaid), days = said.flatMap(daysSaid);
  const stated: SpendingRules = {};
  for (const [k, v0] of Object.entries(raw)) {
    if (v0 == null) continue; // the model's way of saying "none"
    if (!FIELDS.includes(k as Field)) { notes.push(`the draft gave a spending rule Rook doesn't know (${k.slice(0, 40)}): left out`); continue; }
    const f = k as Field;
    // A number written as a string ("1000") is still the number.
    const v = typeof v0 === 'string' && f !== 'period' && f !== 'approval' && /^\d+(?:\.\d+)?$/.test(v0.trim()) ? Number(v0) : v0;
    const ok = SpendingRules.shape[f].safeParse(v);
    if (!ok.success || ok.data === undefined) { notes.push(`Rook left out the ${LABEL[f]}: ${JSON.stringify(v0).slice(0, 40)} is not one Rook can keep.`); continue; }
    const value = ok.data;
    if (typeof value === 'number' && !(carried?.[f] === value)) {
      const backed = f === 'expires_days' ? days.includes(value) : amounts.some((n) => same(n, value));
      if (!backed) {
        notes.push(f === 'expires_days'
          ? `Rook left out the ${LABEL[f]} of ${value} days: no message of yours states it. Say it in days, weeks or months, like 'for the next 2 weeks'.`
          : `Rook left out the ${LABEL[f]} of ${value} USD: no message of yours states that amount. Write it in digits, like 'only spend 1000 USDC a month'.`);
        continue;
      }
    }
    (stated as Record<Field, unknown>)[f] = value;
  }
  const rules: SpendingRules = { ...keep, ...stated };
  if (rules.period && rules.budget_usd === undefined) {
    delete rules.period;
    notes.push('Rook left out the period of the spending limit: there is no spending limit for it to apply to.');
  }
  // The wallet's USD budget is per day, week or month, never a lifetime total: a limit with no period is a monthly one.
  if (rules.budget_usd !== undefined && !rules.period) {
    rules.period = 'month';
    notes.push(`Rook reads the spending limit of ${rules.budget_usd} USD as a monthly one: the wallet's limits renew each day, week or month.`);
  }
  const any = Object.keys(stated).length > 0;
  return { rules: Object.keys(rules).length ? rules : undefined, stated: any };
}

const PER = { day: 'a day', week: 'a week', month: 'a month' } as const;
const usd = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)} USD`;

/** The rules as one plain sentence, Rook's confirmation when the draft gave none: "Rook spends at most 1000 USD a month ...". */
export function describeSpending(r: SpendingRules): string {
  const parts = [
    ...(r.budget_usd !== undefined ? [`at most ${usd(r.budget_usd)} ${PER[r.period ?? 'month']}`] : []),
    ...(r.per_task_max_usd !== undefined ? [`at most ${usd(r.per_task_max_usd)} on one task`] : []),
  ];
  const lead = parts.length ? `Rook spends ${parts.join(' and ')}` : '';
  const ask = r.approval === 'every' ? 'every payment waits for your approval' : r.approval === 'none' ? 'payments within these rules go ahead without asking you' : '';
  const until = r.expires_days !== undefined ? `for the next ${r.expires_days} ${r.expires_days === 1 ? 'day' : 'days'}` : '';
  const head = [lead, ask].filter(Boolean).join(', and ');
  if (!head) return until ? `Rook may spend ${until}.` : '';
  const s = `${head}${until ? `, ${until}` : ''}.`;
  return s[0].toUpperCase() + s.slice(1);
}
