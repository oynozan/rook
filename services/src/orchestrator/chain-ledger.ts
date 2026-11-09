// ROOK_LEDGER=chain: the ledger as calls to the signer and the chain-gateway (docs/x402-payments-plan.md section 1).
// An in-memory mirror (the sim ledger) keeps Rook's own books, so the runner reads balances and authorizations
// synchronously; each mutation first succeeds on chain, then is applied to the mirror. A payment is booked only when
// the chain shows it: the sub-account's USDC is lower by its amount. binding() goes into the task document, and
// restore() rebuilds the mirror from the contract and the sub-accounts' balances after a restart.
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../shared/config.ts';
import { call, HttpError } from '../shared/http.ts';
import type { AcceptsRow, Receipt } from '../shared/types.ts';
import { createLedger, LedgerError, type Ledger, type ReceiptEvidence, type ReleaseHow, type Recipient } from './ledger.ts';

const signer = <T = any>(path: string, body?: unknown) => call<T>(config.urls.signer + path, body);
const gateway = <T = any>(path: string, body?: unknown) => call<T>(config.urls.chainGateway + path, body);

/** Service refusals (409) and failed chain calls (502) become ledger refusals, so the runner skips or abandons as in sim. */
async function svc<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    if (e instanceof HttpError && (e.status === 409 || e.status === 502)) throw new LedgerError(e.message);
    throw e;
  }
}
/** Reads are retried: a flaky RPC must not turn into a wrong booking. */
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(300 * i); }
  }
}

/** An authorization the signer handed out, minus the header: enough to settle or clear it after a restart. */
export type AuthMeta = { payment_hash: string; amount: string; expires_at_block: number | null; nonce: string | null };
/**
 * Stored in the task document: the contract task and the contract and network it is on, Rook n -> contract n,
 * sub-accounts, outstanding authorizations. Bindings stored before contract_id existed have neither field.
 */
export type ChainBinding = {
  contract_task_id: string; contract_id?: string; network?: string;
  nmap: Record<string, number>; accounts: Record<string, string>; auths: Record<string, AuthMeta>;
};
type Bound = { cid: string; contract_id: string; network: string; nmap: Map<number, number>; accounts: Map<number, string>; auths: Map<number, AuthMeta> };
const toMap = <V>(o: Record<string, V> | undefined) => new Map(Object.entries(o ?? {}).map(([k, v]) => [Number(k), v] as [number, V]));
/** A stored binding made on another contract or network: restore leaves its task alone and binds nothing. */
export class OtherContract extends Error { override name = 'OtherContract'; }
/** What a contract task still holds for its funder (a late return after a close lands in unallocated). */
const owed = (ct: any) => BigInt(ct.unallocated ?? 0) + BigInt(ct.reserve_remaining ?? 0);
/** Balance reads after a landed delegate before its payment is booked unpaid (about a second apart live). */
const LANDED_READS = 15;

export type ChainLedger = Ledger & {
  bind(task_id: string, contract_task_id: string, nmap: Map<number, number>): void;
  contractTaskOf(task_id: string): string | null;
  binding(task_id: string): ChainBinding | null;
  /**
   * Rebuilds the books from the contract; `saved` is the ledger view stored with the task (to tell landed payments).
   * Throws OtherContract for a binding made on another contract; binds only once the contract task was read.
   * `deleted`: the contract deleted the task (refunded before any subtask was funded), so the books are closed.
   */
  restore(task_id: string, b: ChainBinding, t: { funder: string; budget: bigint; reserve_share: number; saved: any }): Promise<{ status: string; killed: boolean; deleted?: boolean; notes: string[] }>;
  /**
   * The hire's settled transfer as an indexer shows it (chain-gateway /payment, retried there); null when not found.
   * `index`: how many of the sub-account's payments to pay_to came before this one.
   */
  paymentTx(task_id: string, n: number, p: { amount_atomic: string; pay_to: string; after: string; index?: number }): Promise<{ payment_tx: string; payment_explorer_url: string } | null>;
  /** The near-cli call that stops the task on the contract; its funder (or the contract owner) signs it. */
  killCommand(task_id: string, funder: string | null): string | null;
  recordReceipt(task_id: string, n: number, receipt: Receipt): Promise<ReceiptEvidence & { receipt_explorer_url: string | null }>;
};

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
  const killed = new Set<string>(), moving = new Map<string, number>();
  const notKilled = (id: string) => { if (killed.has(id)) throw new LedgerError('task is killed'); };
  /** A funding or top-up that started before a kill may land on chain, so it still goes into the books; the kill reaches the mirror after. */
  async function transfer<T>(id: string, fn: () => Promise<T>): Promise<T> {
    notKilled(id);
    moving.set(id, (moving.get(id) ?? 0) + 1);
    try { return await fn(); } finally {
      moving.set(id, moving.get(id)! - 1);
      if (killed.has(id) && !moving.get(id)) m.kill(id);
    }
  }
  const sub = (id: string, n: number) => m.view(id)?.subtasks.find((s) => s.n === n);
  const balanceOf = async (account: string) => BigInt((await retry(() => gateway<{ balance: string }>(`/balance?account=${encodeURIComponent(account)}`))).balance);
  /**
   * Subtask n's outstanding authorization was paid: its sub-account holds at least that much less than the books say.
   * `landed`: the signer saw the delegate run (its key's nonce). Its ft_transfer runs on the token's shard a block or
   * more later, so the balance is read again for a few seconds before the payment is booked unpaid.
   */
  const paidOnChain = async (id: string, n: number, account: string, landed = false) => {
    for (let i = 1; ; i++) {
      const v = sub(id, n)!;
      if ((await balanceOf(account)) <= v.balance_atomic - (v.authorized_atomic ?? 0n)) return true;
      if (!landed || i >= LANDED_READS) return false;
      await sleep(Math.min(Math.max(config.pollMs, 100), 1000));
    }
  };

  /**
   * Deletes a sub-account through the signer, its NEAR back to the contract: one Returned, or a failed funding attempt
   * whose account was created. The signer refuses one that holds USDC or an authorization; a failure only leaves NEAR behind.
   */
  const reclaim = (task_id: string, n: number, c: { task_id: string; n: number; account_id: string }) =>
    signer('/reclaim', c).catch((e) => console.warn(`[orchestrator] ${task_id} subtask ${n}: reclaim ${c.account_id} failed: ${e?.message ?? e}`));

  /**
   * Clears the signer's authorization: at once when terminal_unpaid, else once the delegate ran or expired (409 until then).
   * `signal` aborts only the wait between 409s: the authorization stays outstanding, in the signer and in the books.
   */
  async function clearAuth(c: { task_id: string; n: number }, terminal_unpaid: boolean, signal?: AbortSignal) {
    for (;;) {
      try {
        return await signer<{ cleared: boolean; landed?: boolean }>('/expire', { task_id: c.task_id, n: c.n, terminal_unpaid });
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409)) throw e;
        await sleep(Math.max(config.pollMs, 200), undefined, { signal });
      }
    }
  }

  return {
    bind(task_id, cid, nmap) { bound.set(task_id, { cid, contract_id: config.contractId, network: config.nearNetwork, nmap, accounts: new Map(), auths: new Map() }); },
    contractTaskOf: (task_id) => bound.get(task_id)?.cid ?? null,
    binding(task_id) {
      const x = bound.get(task_id);
      return x ? {
        contract_task_id: x.cid, contract_id: x.contract_id, network: x.network,
        nmap: Object.fromEntries(x.nmap), accounts: Object.fromEntries(x.accounts), auths: Object.fromEntries(x.auths),
      } : null;
    },

    /** The human funded the task with ft_transfer_call; POST /tasks/:id/funded checked it. Only the mirror opens here. */
    createTask(task_id, funder, budget, reserve_share) {
      if (budget !== 0n) b(task_id); // 0: a plan that hires no agent has no contract task, only these local books
      return m.createTask(task_id, funder, budget, reserve_share);
    },

    fundSubtask: (task_id, n, cap) => transfer(task_id, async () => {
      const c = at(task_id, n);
      await svc(signer('/keys', { task_id: c.task_id, n: c.n }));
      // A failed or timed-out fund_subtask may still have landed: the contract's subtask decides, not the error.
      const funding = await svc(gateway('/fund', { task_id: c.task_id, n: c.n })).then(() => null, (e) => e);
      const { subtasks } = await gateway(`/task/${encodeURIComponent(c.task_id)}`);
      const s = subtasks.find((x: any) => x.n === c.n);
      if (s?.status !== 'Funded' || BigInt(s.cap) !== cap) {
        // A failed attempt whose account was created keeps its 0.06 NEAR and holds no USDC: deleted now, while it is
        // still the subtask's current account (a retry makes another one current, and the signer checks that).
        if (s?.status === 'Failed' && s.account_exists) await reclaim(task_id, n, { task_id: c.task_id, n: c.n, account_id: s.account_id });
        throw funding ?? new LedgerError(`subtask ${c.n} is ${s?.status ?? 'missing'} on chain (cap ${s?.cap})`);
      }
      if (funding) console.warn(`[orchestrator] ${task_id} subtask ${n}: /fund reported ${funding.message}, but the subtask is Funded on chain`);
      b(task_id).accounts.set(n, s.account_id);
      return m.fundSubtask(task_id, n, cap);
    }),

    topUp: (task_id, n, amount) => transfer(task_id, async () => {
      const c = at(task_id, n);
      await svc(gateway('/top-up', { task_id: c.task_id, n: c.n, amount_atomic: amount.toString() }));
      return m.topUp(task_id, n, amount);
    }),

    async authorize(task_id: string, n: number, row: AcceptsRow, allow: Recipient[]) {
      notKilled(task_id);
      const c = at(task_id, n);
      const signed = await svc(signer<{ header: string; payment_hash: string; expires_at_block?: number; nonce?: string }>('/sign', { ...c, row }));
      try {
        const out = m.authorize(task_id, n, row, allow, signed);
        b(task_id).auths.set(n, { payment_hash: signed.payment_hash, amount: row.amount, expires_at_block: signed.expires_at_block ?? null, nonce: signed.nonce ?? null });
        return out;
      } catch (e) { // refused by Rook's own books (for example killed meanwhile): the header never leaves Rook
        await signer('/expire', { task_id: c.task_id, n: c.n, terminal_unpaid: true }).catch(() => {});
        throw e;
      }
    },

    /**
     * A2A COMPLETED: waits until the delegate ran or expired, then books the payment only if the sub-account's USDC
     * dropped by its amount. Returns 0n (booked unpaid) when it never did: the facilitator did not settle it.
     */
    async settle(task_id, n, signal) {
      const c = at(task_id, n);
      const cleared = await clearAuth(c, false, signal);
      const paid = await paidOnChain(task_id, n, c.account_id, cleared.landed === true);
      b(task_id).auths.delete(n);
      if (paid) return m.settle(task_id, n);
      m.release(task_id, n);
      return 0n;
    },

    /** `now` drops it from Rook's books only. Otherwise waits as clearAuth; a payment that landed anyway is settled. */
    release(task_id, n, how: ReleaseHow = 'wait', signal?: AbortSignal) {
      if (how === 'now') { bound.get(task_id)?.auths.delete(n); return m.release(task_id, n); }
      const c = at(task_id, n);
      return (async () => {
        const cleared = await clearAuth(c, how === 'terminal', signal);
        const paid = await paidOnChain(task_id, n, c.account_id, cleared.landed === true);
        b(task_id).auths.delete(n);
        if (paid) return { amount: m.settle(task_id, n), settled: true as const };
        return m.release(task_id, n);
      })();
    },

    /** Sends the sub-account's USDC back (signer /return), or has the contract mark it empty when it holds exactly 0. */
    async returnLeftover(task_id, n) {
      if (sub(task_id, n)?.authorized_atomic != null) throw new LedgerError(`subtask ${n} has an outstanding authorization`);
      const c = at(task_id, n);
      let onChain = 0n;
      if ((await balanceOf(c.account_id)) === 0n) {
        const r = await svc(gateway<{ marked: boolean }>('/mark-empty', { task_id: c.task_id, n: c.n }));
        if (!r.marked) throw new LedgerError(`mark_empty left subtask ${c.n} Funded: the contract read a balance above 0`);
      } else {
        onChain = BigInt((await svc(signer<{ amount: string }>('/return', c))).amount);
      }
      const amount = m.returnLeftover(task_id, n);
      if (onChain !== amount) console.warn(`[orchestrator] ${task_id} subtask ${n}: returned ${onChain} on chain, ${amount} in Rook's books`);
      await reclaim(task_id, n, c); // the emptied sub-account is deleted, its NEAR back to the contract
      return amount;
    },

    async closeTask(task_id) {
      for (const s of m.view(task_id)?.subtasks ?? []) if (s.returned_atomic === null) throw new LedgerError(`subtask ${s.n} has not returned its leftover`);
      if (!bound.has(task_id) && m.view(task_id)?.budget_atomic === 0n) return m.closeTask(task_id); // nothing on chain
      const cid = b(task_id).cid;
      const refused = await svc(gateway('/close', { task_id: cid })).then(() => null, (e) => e);
      if (refused) {
        // The funder may close a killed task first. Returns still reach it and this close refunds them, but with nothing
        // left to refund the contract answers "task is already closed": closed for good, as its own view confirms.
        const got = refused instanceof LedgerError ? await retry(() => gateway(`/task/${encodeURIComponent(cid)}`)).catch(() => null) : null;
        const done = got?.task?.status === 'Closed' && owed(got.task) === 0n && got.subtasks.every((s: any) => s.status === 'Returned' || s.status === 'Failed');
        if (!done) throw refused;
      }
      return m.closeTask(task_id);
    },

    kill(task_id) {
      killed.add(task_id);
      if (!moving.get(task_id)) m.kill(task_id);
      // The signer refuses every further /sign for this contract task. The contract's kill_task needs the funder's key.
      const cid = bound.get(task_id)?.cid;
      if (cid !== undefined) signer('/kill', { task_id: cid }).catch((e) => console.error('[orchestrator] signer /kill failed:', e?.message ?? e));
    },

    killCommand(task_id, funder) {
      const cid = bound.get(task_id)?.cid;
      return cid === undefined ? null
        : `near contract call-function as-transaction ${config.contractId || '<contract>'} kill_task json-args '{"task_id":"${cid}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${funder || '<funder>'} network-config ${config.nearNetwork} sign-with-keychain send`;
    },

    holds: (task_id) => m.holds(task_id),

    view(task_id) {
      const v = m.view(task_id), x = bound.get(task_id);
      if (!v) return v;
      const out = { ...v, killed: v.killed || killed.has(task_id) };
      return x ? { ...out, network: config.nearNetwork, contract_id: config.contractId || null, contract_task_id: x.cid, accounts: Object.fromEntries(x.accounts) } : out;
    },

    async recordReceipt(task_id: string, n: number, r: Receipt) {
      const c = at(task_id, n);
      const bal = await gateway<{ balance: string }>(`/balance?account=${encodeURIComponent(c.account_id)}`);
      const receipt = {
        a2a_task_id: r.a2a_task_id ?? '', agent_handle: r.agent_handle, amount: r.amount_atomic,
        verdict: r.verdict, attestation_hash: r.attestation_hash, payment_hash: r.payment_hash,
      };
      const out = await gateway<{ tx_hash: string; explorer_url?: string }>('/receipt', { task_id: c.task_id, n: c.n, receipt });
      return { receipt_tx: out.tx_hash, receipt_explorer_url: out.explorer_url ?? null, evidence: { account_id: c.account_id, ft_balance_atomic: bal.balance } };
    },

    async paymentTx(task_id, n, p) {
      const c = at(task_id, n);
      const q = new URLSearchParams({ account: c.account_id, to: p.pay_to, amount: p.amount_atomic, after: p.after, ...(p.index === undefined ? {} : { index: String(p.index) }) });
      const r = await gateway<{ found: boolean; tx_hash?: string; explorer_url?: string }>(`/payment?${q}`);
      return r.found && r.tx_hash ? { payment_tx: r.tx_hash, payment_explorer_url: r.explorer_url ?? '' } : null;
    },

    async restore(task_id, bd, t) {
      // Contract task ids are counters that start at 0 on every contract (testnet and mainnet runs may share one
      // database), so a binding holds only on the contract and network it was made on. An older binding does not say;
      // the ledger view stored with its task does, and so do its sub-account ids (t<task>-<n>.<contract>).
      const made = bd.contract_id ? { contract_id: bd.contract_id, network: bd.network } : { contract_id: t.saved?.contract_id, network: t.saved?.network };
      const here = `${config.contractId} (${config.nearNetwork})`;
      if ((made.contract_id && made.contract_id !== config.contractId) || (made.network && made.network !== config.nearNetwork)) {
        throw new OtherContract(`it was funded on ${made.contract_id ?? 'another contract'} (${made.network ?? 'another network'}), and this Rook runs ${here}`);
      }
      const stray = Object.values(bd.accounts ?? {}).find((a) => !a.endsWith(`.${config.contractId}`));
      if (stray) throw new OtherContract(`its sub-account ${stray} is not one of ${config.contractId}'s`);
      const x: Bound = { cid: bd.contract_task_id, contract_id: config.contractId, network: config.nearNetwork, nmap: toMap(bd.nmap), accounts: toMap(bd.accounts), auths: toMap(bd.auths) };
      // A funding, top-up or refund in flight resolves within a few blocks: wait for it rather than guess.
      let ct: any, subs: any[] = [];
      for (let i = 0; ; i++) {
        const got = await retry(() => gateway(`/task/${encodeURIComponent(x.cid)}`)).catch((e) => {
          if (e instanceof HttpError && e.status === 404) return null;
          throw e;
        });
        if (got === null) {
          if (x.accounts.size) throw new Error(`contract task ${x.cid} is gone but Rook funded sub-accounts for it`);
          if (!made.contract_id) throw new OtherContract(`contract task ${x.cid} is not on ${here}, and this older binding does not say which contract it was funded on`);
          // The contract deletes a task closed with no subtask ever funded: its whole budget went back to the funder.
          // Its id is never handed out again, so nothing is bound.
          m.createTask(task_id, t.funder, t.budget, t.reserve_share);
          m.closeTask(task_id);
          return { status: 'Closed', killed: false, deleted: true, notes: [`contract task ${x.cid} was closed with nothing funded and deleted; its budget went back to the funder`] };
        }
        ({ task: ct, subtasks: subs } = got);
        if (ct.status !== 'Closing' && !subs.some((s) => s.status === 'Funding' || s.status === 'ToppingUp')) break;
        // ponytail: 30 polls; a transfer stuck longer needs the owner's resolve_stuck, then another restart.
        if (i >= 30) throw new Error(`contract task ${x.cid} still has a transfer in flight; the owner may need resolve_stuck`);
        await sleep(Math.max(200, Math.min(config.pollMs, 2000)));
      }
      if (BigInt(ct.budget) !== t.budget || (t.funder && ct.funder !== t.funder)) {
        throw new OtherContract(`contract task ${x.cid} on ${here} holds ${ct.budget} from ${ct.funder}, not this task's ${t.budget} from ${t.funder || 'its funder'}`);
      }
      const notes: string[] = [];
      m.createTask(task_id, t.funder, t.budget, t.reserve_share);
      if (m.view(task_id)!.reserve_atomic !== BigInt(ct.reserve)) notes.push(`reserve ${ct.reserve} on chain, ${m.view(task_id)!.reserve_atomic} in Rook's books`);
      // Replays go through the mirror's own methods, so its invariant holds by construction.
      const R = 'restored', allow = [{ network: R, asset: R, payTo: R }];
      const book = (n: number, amount: bigint, payment_hash: string) =>
        m.authorize(task_id, n, { scheme: 'exact', network: R, asset: R, payTo: R, amount: amount.toString(), maxTimeoutSeconds: 1 }, allow, { header: '', payment_hash });
      for (const [n, k] of x.nmap) {
        const cs = subs.find((s) => s.n === k);
        if (!cs || cs.status === 'Failed') { // the run funds it (again)
          x.accounts.delete(n); x.auths.delete(n);
          // A failed attempt whose account was created keeps its NEAR: deleted before a retry makes another account current.
          if (cs?.account_exists) await reclaim(task_id, n, { task_id: x.cid, n: k, account_id: cs.account_id });
          continue;
        }
        x.accounts.set(n, cs.account_id);
        const cap = BigInt(cs.cap), funded = cap + BigInt(cs.topped_up);
        m.fundSubtask(task_id, n, cap);
        if (funded > cap) m.topUp(task_id, n, funded - cap);
        const left = cs.status === 'Returned' ? BigInt(cs.returned) : await balanceOf(cs.account_id);
        const auth = cs.status === 'Funded' ? x.auths.get(n) : undefined;
        if (!auth) x.auths.delete(n);
        // An outstanding authorization already paid shows as a balance below the one stored before the restart.
        const was = (t.saved?.subtasks ?? []).find((s: any) => s.n === n);
        const held = auth ? BigInt(auth.amount) : 0n;
        const landed = auth !== undefined && was !== undefined && left <= BigInt(was.balance_atomic) - held;
        let spent = funded - left - (landed ? held : 0n);
        if (spent < 0n) { notes.push(`subtask ${n}: ${cs.account_id} holds ${-spent} more than it was funded with, not counted`); spent = 0n; }
        if (spent > 0n) { book(n, spent, R); m.settle(task_id, n); }
        if (auth) {
          try { book(n, held, auth.payment_hash); } catch (e: any) { notes.push(`subtask ${n}: authorization ${auth.payment_hash} not restored: ${e.message}`); x.auths.delete(n); }
        }
        if (cs.status === 'Returned') m.returnLeftover(task_id, n);
      }
      // A return that reached the task after its close sits in it until another close_task: Rook's books stay open for it.
      if (ct.status === 'Closed' && owed(ct) > 0n) notes.push(`closed on chain, but ${owed(ct)} returned after the close is still in the contract task; Rook's close_task refunds it`);
      else if (ct.status === 'Closed') { try { m.closeTask(task_id); } catch (e: any) { notes.push(`closed on chain, not in Rook's books: ${e.message}`); } }
      bound.set(task_id, x);
      return { status: ct.status, killed: ct.killed === true, notes };
    },
  };
}
