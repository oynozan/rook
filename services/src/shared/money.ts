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

/** floor(amount * share) for a share like 0.2, without floats on the amount. */
export function share(amount: bigint, s: number): bigint {
  return (amount * BigInt(Math.round(s * 1_000_000))) / 1_000_000n;
}
