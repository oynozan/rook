// In-memory stand-in for the budget contract and the signer (docs/agentic-system.md section 8.5).
// Method names match the contract and signer so phase 2 swaps this for chain-gateway + signer calls.
import { createHash, randomUUID } from 'node:crypto';
import { share } from '../shared/money.ts';
import type { AcceptsRow, Receipt, X402Config } from '../shared/types.ts';

export class LedgerError extends Error {
  constructor(public reason: string) { super(`ledger refused: ${reason}`); this.name = 'LedgerError'; }
}

export type Recipient = X402Config['recipients'][number];

type SubAcct = {
  cap: bigint; balance: bigint; topped_up: bigint; spent: bigint;
  returned: bigint | null; // null until returnLeftover
  auth: { amount: bigint; payment_hash: string } | null;
};
type Acct = {
  funder: string; budget: bigint; reserve: bigint;
  unallocated: bigint; reserve_remaining: bigint; refunded: bigint; closed: boolean;
  subs: Map<number, SubAcct>;
};

type Awaitable<T> = T | Promise<T>;
/**
 * How an authorization ends unpaid. `terminal`: the agent reported REJECTED/FAILED/CANCELED (or the header never left
 * Rook); `wait`: it may still settle, so wait until it expires; `void`: Rook gives up on it (no task id came back, or the
 * run was stopped and the agent refused CancelTask), so the signer spends the delegate's nonce and it can never settle;
 * `now`: drop it from Rook's books immediately (kill, shutdown) while the signer keeps refusing a new one until it expires.
 * An agent's window is often a day (87 000 s): waiting it out held a sub-account's money that long (mainnet).
 */
export type ReleaseHow = 'terminal' | 'wait' | 'void' | 'now';
export type LedgerView = NonNullable<ReturnType<ReturnType<typeof createLedger>['view']>> & Record<string, unknown>;
export type ReceiptEvidence = { receipt_tx: string | null; evidence?: { account_id: string; ft_balance_atomic: string } };

/** What the runner talks to: the in-memory ledger below (`sim`) or chain-ledger.ts (`chain`). Methods may be async. */
export interface Ledger {
  createTask(task_id: string, funder: string, budget: bigint, reserve_share: number): Awaitable<object>;
  fundSubtask(task_id: string, n: number, cap: bigint): Awaitable<bigint>;
  topUp(task_id: string, n: number, amount: bigint): Awaitable<bigint>;
  authorize(task_id: string, n: number, row: AcceptsRow, allow: Recipient[]): Awaitable<{ header: string; payment_hash: string; amount: bigint }>;
  /**
   * `signal` (the run's, chain only): a kill or shutdown stops the wait for the chain and leaves the authorization
   * outstanding, for the unwind (or the restore) to clear on its own, so it holds back no other sub-account.
   */
  settle(task_id: string, n: number, signal?: AbortSignal): Awaitable<bigint>;
  /** `settled`: the chain shows the payment landed although the hire ended unpaid; booked as spent instead. `signal`: as settle. */
  release(task_id: string, n: number, how?: ReleaseHow, signal?: AbortSignal): Awaitable<bigint | { amount: bigint; settled: true }>;
  returnLeftover(task_id: string, n: number): Awaitable<bigint>;
  closeTask(task_id: string): Awaitable<bigint>;
  kill(task_id: string): void;
  holds(task_id: string): boolean;
  view(task_id: string): LedgerView | null;
  /** Chain only: writes the receipt on the contract. */
  recordReceipt?(task_id: string, n: number, receipt: Receipt): Promise<ReceiptEvidence>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function createLedger() {
  const accts = new Map<string, Acct>();
  const killed = new Set<string>();

  const refuse = (reason: string): never => { throw new LedgerError(reason); };
  const acct = (id: string) => accts.get(id) ?? refuse(`unknown task ${id}`);
  const sub = (a: Acct, n: number) => a.subs.get(n) ?? refuse(`subtask ${n} is not funded`);
  const open = (id: string) => {
    if (killed.has(id)) refuse('task is killed');
    const a = acct(id);
    if (a.closed) refuse('task is closed');
    return a;
  };

  function sums(a: Acct) {
    let balances = 0n, spent = 0n;
    for (const s of a.subs.values()) { balances += s.balance; spent += s.spent; }
    return { balances, spent };
  }

  /** budget = unallocated + reserve_remaining + Σ sub-balances + Σ spent + refunded. Returned leftovers go back into unallocated. */
  function holds(id: string) {
    const a = acct(id), { balances, spent } = sums(a);
    return a.budget === a.unallocated + a.reserve_remaining + balances + spent + a.refunded;
  }
  function mutate<T>(id: string, fn: () => T): T {
    const out = fn();
    if (!holds(id)) throw new Error(`ledger invariant broken for ${id}`);
    return out;
  }

  return {
    createTask(task_id: string, funder: string, budget: bigint, reserve_share: number) {
      if (killed.has(task_id)) refuse('task is killed');
      if (accts.has(task_id)) refuse('task already exists');
      if (budget < 0n) refuse('budget must not be negative'); // 0: a plan that hires no agent holds nothing
      const reserve = share(budget, reserve_share);
      return mutate(task_id, () => {
        accts.set(task_id, { funder, budget, reserve, unallocated: budget - reserve, reserve_remaining: reserve, refunded: 0n, closed: false, subs: new Map() });
        return { reserve_atomic: reserve, allocatable_atomic: budget - reserve };
      });
    },

    fundSubtask(task_id: string, n: number, cap: bigint) {
      const a = open(task_id);
      if (a.subs.has(n)) refuse(`subtask ${n} is already funded`);
      if (cap < 0n) refuse('cap must not be negative');
      if (cap > a.unallocated) refuse(`cap ${cap} exceeds unallocated budget ${a.unallocated}`);
      return mutate(task_id, () => {
        a.unallocated -= cap;
        a.subs.set(n, { cap, balance: cap, topped_up: 0n, spent: 0n, returned: null, auth: null });
        return cap;
      });
    },

    topUp(task_id: string, n: number, amount: bigint) {
      const a = open(task_id), s = sub(a, n);
      if (s.returned !== null) refuse(`subtask ${n} already returned its leftover`);
      if (amount <= 0n) refuse('top-up must be positive');
      if (amount > a.reserve_remaining) refuse(`top-up ${amount} exceeds remaining reserve ${a.reserve_remaining}`);
      return mutate(task_id, () => {
        a.reserve_remaining -= amount; s.balance += amount; s.topped_up += amount;
        return amount;
      });
    },

    /** Signer /sign stand-in. Returns the payment header (never stored) and its sha256. `signed`: a header the real signer built. */
    authorize(task_id: string, n: number, row: AcceptsRow, allow: Recipient[], signed?: { header: string; payment_hash: string }) {
      const a = open(task_id), s = sub(a, n);
      if (s.returned !== null) refuse(`subtask ${n} already returned its leftover`);
      if (s.auth) refuse(`subtask ${n} has an outstanding authorization`);
      if (!allow.some((r) => r.network === row.network && r.asset === row.asset)) refuse(`network ${row.network} / asset ${row.asset} not allowlisted`);
      if (!allow.some((r) => r.network === row.network && r.asset === row.asset && r.payTo === row.payTo)) refuse(`payTo ${row.payTo} not allowlisted`);
      const amount = BigInt(row.amount);
      if (amount <= 0n) refuse('amount must be positive');
      if (amount > s.balance) refuse(`amount ${amount} exceeds subtask balance ${s.balance}`);
      const header = signed?.header ?? Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { sim: { task_id, n, nonce: randomUUID() } } })).toString('base64');
      const payment_hash = signed?.payment_hash ?? sha256(header);
      return mutate(task_id, () => {
        s.auth = { amount, payment_hash };
        return { header, payment_hash, amount };
      });
    },

    settle(task_id: string, n: number) {
      const s = sub(acct(task_id), n);
      if (!s.auth) refuse(`subtask ${n} has no outstanding authorization`);
      return mutate(task_id, () => {
        const amount = s.auth!.amount;
        s.balance -= amount; s.spent += amount; s.auth = null;
        return amount;
      });
    },

    release(task_id: string, n: number) {
      const s = sub(acct(task_id), n);
      if (!s.auth) refuse(`subtask ${n} has no outstanding authorization`);
      return mutate(task_id, () => { const amount = s.auth!.amount; s.auth = null; return amount; });
    },

    returnLeftover(task_id: string, n: number) {
      const a = acct(task_id), s = sub(a, n);
      if (s.auth) refuse(`subtask ${n} has an outstanding authorization`);
      if (s.returned !== null) refuse(`subtask ${n} already returned its leftover`);
      return mutate(task_id, () => {
        const amount = s.balance;
        s.balance = 0n; s.returned = amount; a.unallocated += amount;
        return amount;
      });
    },

    closeTask(task_id: string) {
      const a = acct(task_id);
      if (a.closed) refuse('task is already closed');
      for (const [n, s] of a.subs) if (s.returned === null) refuse(`subtask ${n} has not returned its leftover`);
      return mutate(task_id, () => {
        const amount = a.unallocated + a.reserve_remaining;
        a.unallocated = 0n; a.reserve_remaining = 0n; a.refunded += amount; a.closed = true;
        return amount;
      });
    },

    kill(task_id: string) { killed.add(task_id); },

    /** Forgets a task's books. Only the chain mirror uses it: a rebuild from the contract that fails half-way. */
    drop(task_id: string) { accts.delete(task_id); },

    holds,

    /** Read-only view; bigints (serialised as strings by the HTTP layer). Null before createTask. */
    view(task_id: string) {
      const a = accts.get(task_id);
      if (!a) return null;
      const subs = [...a.subs].map(([n, s]) => ({
        n, cap_atomic: s.cap, balance_atomic: s.balance, topped_up_atomic: s.topped_up, spent_atomic: s.spent,
        returned_atomic: s.returned, authorized_atomic: s.auth?.amount ?? null, payment_hash: s.auth?.payment_hash ?? null,
      }));
      return {
        funder: a.funder, budget_atomic: a.budget, reserve_atomic: a.reserve,
        unallocated_atomic: a.unallocated, reserve_remaining_atomic: a.reserve_remaining,
        reserve_used_atomic: subs.reduce((x, s) => x + s.topped_up_atomic, 0n),
        spent_atomic: sums(a).spent, returned_atomic: subs.reduce((x, s) => x + (s.returned_atomic ?? 0n), 0n),
        refunded_atomic: a.refunded, killed: killed.has(task_id), closed: a.closed, invariant_holds: holds(task_id),
        subtasks: subs,
      };
    },
  };
}
