// Atomic USDC (6 decimals) as bigint. Never floats. docs/agentic-system.md section 4.

export function parseUsdc(s: string | number): bigint {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error(`invalid USDC amount: ${s}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

export function formatUsdc(atomic: bigint | string): string {
  const a = BigInt(atomic);
  const neg = a < 0n, v = neg ? -a : a;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0{1,4}$/, '');
  return `${neg ? '-' : ''}${v / 1_000_000n}.${frac.padEnd(2, '0')}`;
}

/**
 * Why a total budget a message names can't be planned at, in plain words for the user; null when it can. `min`: the
 * contract's smallest budget (0 without the chain); `max`: ROOK_MAX_BUDGET_USDC.
 */
export function namedBudgetProblem(atomic: bigint, min: bigint, max: bigint): string | null {
  const asked = `Your message asks for a budget of ${formatUsdc(atomic)} USDC`;
  if (atomic <= 0n) return `${asked}. Name an amount above 0.`;
  if (atomic > max) return `${asked}, but the most Rook takes is ${formatUsdc(max)} USDC.`;
  if (atomic < min) return `${asked}, but the smallest the Rook contract takes is ${formatUsdc(min)} USDC.`;
  return null;
}

const WORD_NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', fifteen: '15', twenty: '20', thirty: '30', forty: '40', fifty: '50',
};
// A whole number (never part of one: "12k", "10 items" and "2.5 pages" are not money), or a number word.
const NUM = String.raw`(\d+(?:[.,]\d+)?(?![.,]?\d)|\b(?:${Object.keys(WORD_NUMBERS).join('|')})\b)`;
const CURRENCY = String.raw`(?:usdc|usd|dollars?|bucks?)\b`;
/** "$2", or a number no other unit follows: "2 USDC" and "2" are money, "1 week" and "20 pages" are not. */
const AMOUNT = String.raw`(?:\$\s*${NUM}|${NUM}(?!\s*(?!${CURRENCY})[a-z]))`;
const MONEY = String.raw`(?:\$\s*${NUM}|${NUM}\s*${CURRENCY})`;
const NAMED = new RegExp([
  String.raw`\bbudget\b(?:\s+(?:of|to|is|at))?[\s:=]*${AMOUNT}`, // "budget 5 USDC", "budget: 5", "a budget of $2", "the budget to 1.5"
  String.raw`\bmake\s+it\s+${AMOUNT}`, // "make it 1 USDC", "make it five USDC"
  String.raw`\b(?:reduce|lower|cut|raise|increase|drop|bring)\b[^\d\n]{0,30}?\bto\s+${AMOUNT}`, // "cut it to two dollars"
  String.raw`\bfor\s+${MONEY}`, // "do it for 2 USDC", "for $1.5"
].join('|'), 'gi');
/** A change of the budget by a share or a difference ("halve it", "double the budget", "1 USDC less", "cut it by 20%"). */
const RELATIVE = new RegExp([
  String.raw`\b(?:half|halve[sd]?|double[sd]?|twice|triple[sd]?|a\s+third|a\s+quarter)\b`,
  String.raw`${MONEY}\s+(?:more|less|cheaper|extra)\b`,
  String.raw`\bby\s+(?:${MONEY}|\d+(?:[.,]\d+)?\s*%)`,
].join('|'), 'i');

/**
 * Any language: a number next to a currency word ("1,5 USDC", "2 dolar", "$3", "5 dólares", "1,5 USDC'ye") in a message
 * that names the budget in a word of its language ("Bütçeyi 1,5 USDC yap.", "bütçe 2 USDC olsun", "presupuesto de 2
 * USD"). QA: a Turkish budget change was silently ignored, and the report later said it was applied.
 * ponytail: a list of budget words, not language understanding; a language missing from it still has "make it 1 USDC".
 */
// \b sees no edge before a letter outside ASCII (Cyrillic), so the start is "no letter before".
const BUDGET_WORD = /(?<![\p{L}\d])(?:budget|bütçe|butce|presupuest|orçamento|orcamento|budżet|бюджет|anggaran|ngân sách|bajet)|预算|予算|예산|ميزانية|बजट|งบประมาณ/iu;
const DIGITS = String.raw`(\d+(?:[.,]\d+)?)(?![.,]?\d)`;
const CURRENCY_ANY = String.raw`(?:usdc|usd|dollars?|dolar\p{L}*|dólar\p{L}*|dolares|bucks?|долл\p{L}*|ドル|美元|달러)`;
const MONEY_ANY = new RegExp(String.raw`\$\s*${DIGITS}|(?<![\p{L}\d.,])${DIGITS}\s*${CURRENCY_ANY}(?![\p{L}\d])(?:['’]\p{L}*)?`, 'giu');

/** The totals a message names in a budget phrase ("make it 1 USDC", "budget of $2", "cut it to two dollars"), in atomic USDC. */
export function budgetAmounts(message: string): bigint[] {
  const out: bigint[] = [];
  const add = (raw: string) => {
    const n = (WORD_NUMBERS[raw.toLowerCase()] ?? raw).replace(',', '.');
    try { const v = parseUsdc(n); if (!out.includes(v)) out.push(v); } catch { /* more than 6 decimals: not a USDC amount */ }
  };
  for (const m of message.matchAll(NAMED)) {
    const raw = m.slice(1).find((g) => g !== undefined);
    if (raw) add(raw);
  }
  if (BUDGET_WORD.test(message)) for (const m of message.matchAll(MONEY_ANY)) add(m[1] ?? m[2]);
  return out;
}

/**
 * Whether a total the planner's model read into a message is really there: the message names exactly that total in a
 * budget phrase, or changes the budget by a share or a difference (the model works the total out from the budget sent).
 * A number elsewhere ("Top 10 holders", "the 3 biggest DEXs") never counts, so a model mistake never re-budgets a task.
 */
export function budgetBacked(message: string, total: bigint): boolean {
  return RELATIVE.test(message) || budgetAmounts(message).includes(total);
}

/** floor(amount * share) for a share like 0.2, without floats on the amount. */
export function share(amount: bigint, s: number): bigint {
  return (amount * BigInt(Math.round(s * 1_000_000))) / 1_000_000n;
}
