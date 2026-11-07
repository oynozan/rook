// ROOK_LEDGER=chain: the ledger as calls to the signer and the chain-gateway (docs/x402-payments-plan.md section 1).
// An in-memory mirror (the sim ledger) keeps Rook's own books, so the runner reads balances and authorizations
// synchronously; each mutation first succeeds on chain, then is applied to the mirror.
// ponytail: the mirror is Rook's view, the contract is the truth; a payment that settles after a 'now' release (kill,
// shutdown) shows up only as a smaller return. A reconciliation from contract events replaces this when it matters.
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../shared/config.ts';
import { call, HttpError } from '../shared/http.ts';
import type { AcceptsRow, Receipt } from '../shared/types.ts';
import { createLedger, LedgerError, type Ledger, type ReleaseHow, type Recipient } from './ledger.ts';

const signer = <T = any>(path: string, body?: unknown) => call<T>(config.urls.signer + path, body);
const gateway = <T = any>(path: string, body?: unknown) => call<T>(config.urls.chainGateway + path, body);

/** Service refusals (409) and failed chain calls (502) become ledger refusals, so the runner skips or abandons as in sim. */
async function svc<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    if (e instanceof HttpError && (e.status === 409 || e.status === 502)) throw new LedgerError(e.message);
    throw e;
  }
}

type Bound = { cid: string; nmap: Map<number, number>; accounts: Map<number, string> };
export type ChainLedger = Ledger & { bind(task_id: string, contract_task_id: string, nmap: Map<number, number>): void; contractTaskOf(task_id: string): string | null };

export function createChainLedger(): ChainLedger {
  const m = createLedger();
  const bound = new Map<string, Bound>();
  const b = (id: string) => bound.get(id) ?? (() => { throw new LedgerError(`task ${id} is not funded on chain`); })();
  /** Rook subtask n -> contract subtask n (self_do subtasks have no cap on chain), its contract task and account. */
  const at = (id: string, n: number) => {
    const x = b(id), k = x.nmap.get(n);
    if (k === undefined) throw new LedgerError(`subtask ${n} has no cap on chain`);
    return { task_id: x.cid, n: k, account_id: x.accounts.get(n) ?? '' };
  };
  const notKilled = (id: string) => { if (m.view(id)?.killed) throw new LedgerError('task is killed'); };
  const sub = (id: string, n: number) => m.view(id)?.subtasks.find((s) => s.n === n);

  /**
   * Clears the signer's outstanding authorization: at once when terminal_unpaid, else once the delegate landed (its
   * nonce is used) or expired; until then the signer answers 409 and this waits. `landed` says whether it was paid.
   */
  async function clearAuth(c: { task_id: string; n: number }, terminal_unpaid: boolean) {
    for (;;) {
      try {
        return await signer<{ cleared: boolean; landed?: boolean }>('/expire', { task_id: c.task_id, n: c.n, terminal_unpaid });
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409)) throw e;
        await sleep(Math.max(config.pollMs, 200));
      }
    }
  }

  return {
    bind(task_id, cid, nmap) { bound.set(task_id, { cid, nmap, accounts: new Map() }); },
    contractTaskOf: (task_id) => bound.get(task_id)?.cid ?? null,

    /** The human funded the task with ft_transfer_call; POST /tasks/:id/funded checked it. Only the mirror opens here. */
    createTask(task_id, funder, budget, reserve_share) { b(task_id); return m.createTask(task_id, funder, budget, reserve_share); },

    async fundSubtask(task_id, n, cap) {
      notKilled(task_id);
      const c = at(task_id, n);
      await svc(signer('/keys', { task_id: c.task_id, n: c.n }));
      // A failed or timed-out fund_subtask may still have landed: the contract's subtask decides, not the error.
      const funding = await svc(gateway('/fund', { task_id: c.task_id, n: c.n })).then(() => null, (e) => e);
      const { subtasks } = await gateway(`/task/${encodeURIComponent(c.task_id)}`);
      const s = subtasks.find((x: any) => x.n === c.n);
      if (s?.status !== 'Funded' || BigInt(s.cap) !== cap) {
        throw funding ?? new LedgerError(`subtask ${c.n} is ${s?.status ?? 'missing'} on chain (cap ${s?.cap})`);
      }
      if (funding) console.warn(`[orchestrator] ${task_id} subtask ${n}: /fund reported ${funding.message}, but the subtask is Funded on chain`);
      b(task_id).accounts.set(n, s.account_id);
      return m.fundSubtask(task_id, n, cap);
    },

    async topUp(task_id, n, amount) {
      notKilled(task_id);
      const c = at(task_id, n);
      await svc(gateway('/top-up', { task_id: c.task_id, n: c.n, amount_atomic: amount.toString() }));
      return m.topUp(task_id, n, amount);
    },

    async authorize(task_id: string, n: number, row: AcceptsRow, allow: Recipient[]) {
      notKilled(task_id);
      const c = at(task_id, n);
      const signed = await svc(signer<{ header: string; payment_hash: string }>('/sign', { ...c, row }));
      try {
        return m.authorize(task_id, n, row, allow, signed);
      } catch (e) { // refused by Rook's own books (for example killed meanwhile): the header never leaves Rook
        await signer('/expire', { task_id: c.task_id, n: c.n, terminal_unpaid: true }).catch(() => {});
        throw e;
      }
    },

    /** The agent's facilitator submits the delegate; the signer's authorization clears once it landed (or expired). */
    async settle(task_id, n) {
      const r = await clearAuth(at(task_id, n), false);
      if (r.landed === false) console.warn(`[orchestrator] ${task_id} subtask ${n}: the payment expired without landing; counted as spent in Rook's books`);
      return m.settle(task_id, n);
    },

    /** `now` drops it from Rook's books only. Otherwise waits as clearAuth; a payment that landed anyway is settled. */
    release(task_id, n, how: ReleaseHow = 'wait') {
      if (how === 'now') return m.release(task_id, n);
      const c = at(task_id, n);
      return (async () => {
        const r = await clearAuth(c, how === 'terminal');
        if (r.landed) return { amount: m.settle(task_id, n), settled: true as const };
        return m.release(task_id, n);
      })();
    },

    async returnLeftover(task_id, n) {
      if (sub(task_id, n)?.authorized_atomic != null) throw new LedgerError(`subtask ${n} has an outstanding authorization`);
      const c = at(task_id, n);
      const r = await svc(signer<{ amount: string }>('/return', c));
      const amount = m.returnLeftover(task_id, n);
      if (BigInt(r.amount) !== amount) console.warn(`[orchestrator] ${task_id} subtask ${n}: returned ${r.amount} on chain, ${amount} in Rook's books`);
      return amount;
    },

    async closeTask(task_id) {
      for (const s of m.view(task_id)?.subtasks ?? []) if (s.returned_atomic === null) throw new LedgerError(`subtask ${s.n} has not returned its leftover`);
      await svc(gateway('/close', { task_id: b(task_id).cid }));
      return m.closeTask(task_id);
    },

    /** Minimum a payment must leave in a sub-account: NEP-141 cannot return 0, so an empty one blocks close_task. */
    minLeft: 1n,

    kill(task_id) {
      m.kill(task_id);
      // The signer refuses every further /sign for this contract task. The contract's kill_task needs the owner's key.
      const cid = bound.get(task_id)?.cid;
      if (cid !== undefined) signer('/kill', { task_id: cid }).catch((e) => console.error('[orchestrator] signer /kill failed:', e?.message ?? e));
    },

    holds: (task_id) => m.holds(task_id),

    view(task_id) {
      const v = m.view(task_id), x = bound.get(task_id);
      return v && x ? { ...v, contract_id: config.contractId || null, contract_task_id: x.cid, accounts: Object.fromEntries(x.accounts) } : v;
    },

    async recordReceipt(task_id: string, n: number, r: Receipt) {
      const c = at(task_id, n);
      const bal = await gateway<{ balance: string }>(`/balance?account=${encodeURIComponent(c.account_id)}`);
      const receipt = {
        a2a_task_id: r.a2a_task_id ?? '', agent_handle: r.agent_handle, amount: r.amount_atomic,
        verdict: r.verdict, attestation_hash: r.attestation_hash, payment_hash: r.payment_hash,
      };
      const out = await gateway<{ tx_hash: string }>('/receipt', { task_id: c.task_id, n: c.n, receipt });
      return { receipt_tx: out.tx_hash, evidence: { account_id: c.account_id, ft_balance_atomic: bal.balance } };
    },
  };
}
