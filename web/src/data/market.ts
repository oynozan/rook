// The agents and prices from the recorded run in demo-run.ts (sim market, 2026-11-07). Two candidates per subtask,
// cheapest first: Rook hired the first, and the second only when the first didn't pass.
// The landing page shows them under illustrative, task-related names, the way agents are named on the NEAR AI market.
// Prices, order and outcomes are the recorded ones; only the names differ from the simulator's handles.
import { FILES, RUN, SUBTASKS } from './demo-run';

const NAME: Record<string, string> = {
  'sim-holders-lite': 'holderscope', 'sim-holders': 'tokenholders',
  'sim-wallets-express': 'walletwatch', 'sim-wallets': 'chainpulse',
  'sim-tokencheck-fast': 'auditlite', 'sim-tokencheck': 'contractlens',
  'sim-price-slow': 'pricefeed', 'sim-price': 'marketdesk',
};

export type MarketAgent = { handle: string; price: string; subtask: string; hired: 'first' | 'rehire' };

const QUOTED: Record<string, string> = {
  'sim-holders-lite': '0.15', 'sim-holders': '0.30',
  'sim-wallets-express': '0.10', 'sim-wallets': '0.20',
  'sim-tokencheck-fast': '0.12', 'sim-tokencheck': '0.25',
  'sim-price-slow': '0.08', 'sim-price': '0.20',
};

export const MARKET: MarketAgent[] = FILES.flatMap((f, i) => [
  { handle: NAME[f.first.agent], price: QUOTED[f.first.agent], subtask: SUBTASKS[i].title, hired: 'first' as const },
  { handle: NAME[f.second.agent], price: QUOTED[f.second.agent], subtask: SUBTASKS[i].title, hired: 'rehire' as const },
]);

// Receipts in the order they were paid. Their sum is what the run spent.
export const RECEIPTS = FILES.flatMap((f) => [f.first, f.second])
  .filter((h) => h.receipt)
  .sort((a, b) => a.receipt! - b.receipt!)
  .map((h) => ({ n: h.receipt!, agent: NAME[h.agent], amount: h.detail.replace('Paid ', ''), passed: h.end === 'passed' }));

export const SPENT = RECEIPTS.reduce((sum, r) => sum + Number(r.amount), 0).toFixed(2);
export { FILES, RUN, SUBTASKS };
