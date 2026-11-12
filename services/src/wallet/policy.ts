// The Agent API policy a user's spending rules from the chat become (docs/agent-wallet-plan.md, "Spending rules from
// the chat" and "Setup"). Every field the API requires is sent: a policy is always complete, never a diff
// (references/policy.md). Field names and shapes are the API's /openapi.json Policy schema.
import type { SpendingRules } from '../shared/types.ts';
import { USDC_ASSET, USDC_CONTRACT, WNEAR_ASSET } from './api.ts';

/** A USD amount as the policy's budget takes it: a decimal string with at most 2 decimals, cut down (never above the rule). */
export function usdString(n: number): string {
  const cents = Math.floor(Math.round(n * 1_000_000) / 10_000); // via micro-dollars, so 0.29 is not read as 0.28999...
  return cents % 100 === 0 ? String(cents / 100) : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0').replace(/0$/, '')}`;
}

/** USD as atomic USDC (6 decimals): the policy's per-asset limits are atomic strings. */
export const usdcAtomic = (usd: number) => BigInt(Math.round(usd * 1_000_000));

/**
 * Whether a budget window's `remaining_usd` (the API's decimal string; null: no window) covers `amount` atomic USDC.
 * Compared in atomic units: as a float, "1.15" times 1e6 is 1149999.99... and refused a 1.15 USDC task.
 */
export function budgetCovers(remainingUsd: string | null, amount: bigint): boolean {
  const m = remainingUsd?.match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) return true; // no window, or a shape Rook can't read: the API's own budget check still applies
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0')) >= amount;
}

/**
 * The wallet's policy for `rules`. `nearAccountId`: the wallet's own account, once `agent_create` made it known; until
 * then no withdrawal destination exists for it.
 *
 * - `actions: [withdraw]`: the only money action Rook needs, the move of a task's budget to the wallet's native account.
 *   That withdrawal is where the budget, the per-task limit and the owner's approval apply.
 * - `assets`: USDC, and wNEAR only because the provider counts the 1 yoctoNEAR an `ft_transfer_call` attaches as wNEAR.
 * - `destinations: only`: the wallet's own native account, and the USDC contract. The NEAR a native call attaches must
 *   land where `destinations` allows, judged as a `withdraw` on chain `near` to the called contract (policy.md, native
 *   accounts): without the USDC contract listed, the 1 yoctoNEAR of each `ft_transfer_call` would be refused. A grant
 *   could then also withdraw USDC to the USDC contract, which strands it there; the budget bounds that as any spend.
 * - `native.near.call`: the USDC contract only, for `ft_transfer_call` to Rook's contract and back to NEAR Intents.
 *   Every other native method is off.
 */
export function policyFor(rules: SpendingRules, nearAccountId: string | null, usdc = USDC_CONTRACT) {
  const asset = usdc === USDC_CONTRACT ? USDC_ASSET : `nep141:${usdc}`;
  const budget = { daily_usd: null as string | null, weekly_usd: null as string | null, monthly_usd: null as string | null };
  // "Only spend $1000" names no period: the API has no lifetime cap, so it is a monthly one.
  if (rules.budget_usd !== undefined) budget[`${({ day: 'daily', week: 'weekly', month: 'monthly' } as const)[rules.period ?? 'month']}_usd`] = usdString(rules.budget_usd);
  const withdrawTo = (address: string) => ({ action: 'withdraw' as const, chain: 'near', address, memo: null });
  return {
    frozen: false,
    actions: ['withdraw'],
    confidential: false,
    owner_approval: rules.approval === 'every',
    assets: [asset, WNEAR_ASSET],
    limits: rules.per_task_max_usd === undefined ? {} : { per_transaction: { [asset]: usdcAtomic(rules.per_task_max_usd).toString() } },
    max_actions_per_hour: null,
    destinations: { mode: 'only', list: [...(nearAccountId ? [withdrawTo(nearAccountId)] : []), withdrawTo(usdc)] },
    budget,
    timelock_ms: 0,
    native: {
      near: { sign_message: [], transfer: false, call: [usdc] },
      evm: { sign_typed_data: [], sign_message: false, sign_transaction: false },
      solana: { sign_message: false, sign_transaction: false },
    },
  };
}
export type Policy = ReturnType<typeof policyFor>;
