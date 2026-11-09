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

/** floor(amount * share) for a share like 0.2, without floats on the amount. */
export function share(amount: bigint, s: number): bigint {
  return (amount * BigInt(Math.round(s * 1_000_000))) / 1_000_000n;
}
