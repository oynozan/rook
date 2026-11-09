// Funding a task from the browser (SHARED API DECISION 4): the human's USDC ft_transfer_call to the budget contract,
// then reading the contract's NEP-297 "task_created" event from the outcome. Pure functions, no Next.js or Node imports,
// so the browser and the tests both use them.
import type { Network } from './network';
import type { PlanView } from './orchestrator';

/**
 * What POST /tasks/:id/approve returns in chain mode. Any account funds its own task: `funder` is the signed-in account
 * that must send the transfer (null for a CLI task). Orchestrators from before open funding sent the contract owner as
 * both `owner` and `funder`, so `funder` is right for both.
 */
export type Funding = {
  contract_id: string; usdc: string; network: Network; amount_atomic: string; msg: string;
  funder?: string | null; contract_owner?: string | null; owner?: string;
};

/**
 * Atomic USDC (6 decimals) as the amount that really moves: at least 2 decimals, up to 6 (3000000 -> "3.00",
 * 2999000 -> "2.999", 5000 -> "0.005"). No floats, like the services' formatUsdc.
 */
export function usdc(atomic: string | number | bigint): string {
  let a: bigint;
  try { a = BigInt(typeof atomic === 'number' ? Math.round(atomic) : atomic); } catch { return '?'; }
  const neg = a < 0n, v = neg ? -a : a;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0{1,4}$/, '');
  return `${neg ? '-' : ''}${v / 1_000_000n}.${frac}`;
}

/** A budget as typed ("2.999", "3") shown the same way; anything that isn't an amount, as typed. */
export function typedUsdc(s: string): string {
  const m = s.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  return m ? usdc(BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))) : s.trim();
}

/** The account whose wallet must send the funding, or null if any account may. */
export const fundingFrom = (f: Funding) => f.funder ?? f.owner ?? null;

/** The caps and reserve the transfer's msg carries: what the contract will enforce. Null if the msg isn't a create_task. */
export function fundingTerms(f: Funding): { reserve_bps: number; caps: string[]; reserve_atomic: string } | null {
  try {
    const { reserve_bps, caps } = JSON.parse(f.msg).create_task;
    if (!Number.isInteger(reserve_bps) || !Array.isArray(caps) || !caps.every((c) => typeof c === 'string' && /^\d+$/.test(c))) return null;
    return { reserve_bps, caps, reserve_atomic: ((BigInt(f.amount_atomic) * BigInt(reserve_bps)) / 10_000n).toString() };
  } catch {
    return null;
  }
}

export const GAS_100_TGAS = '100000000000000';
export const GAS_50_TGAS = '50000000000000';

/**
 * The funder's own close_task on the contract: refunds what the contract holds for the task. The contract allows it
 * once no subtask holds money (always so for a task stopped before Rook funded any subtask).
 */
export const closeTaskTransaction = (contract_id: string, task_id: string) => ({
  receiverId: contract_id,
  actions: [{ type: 'FunctionCall' as const, params: { methodName: 'close_task', args: { task_id }, gas: GAS_50_TGAS, deposit: '0' } }],
});

/** The one transaction the human signs: USDC ft_transfer_call to the contract, 1 yoctoNEAR, 100 Tgas. */
export const fundingTransaction = (f: Funding) => ({
  receiverId: f.usdc,
  actions: [{
    type: 'FunctionCall' as const,
    params: { methodName: 'ft_transfer_call', args: { receiver_id: f.contract_id, amount: f.amount_atomic, msg: f.msg }, gas: GAS_100_TGAS, deposit: '1' },
  }],
});

type Outcome = {
  status?: unknown;
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
  receipts_outcome?: { outcome?: { logs?: string[]; executor_id?: string; status?: unknown } }[];
};

export type FundingResult =
  | { kind: 'created'; task_id: string; funder: string | null; budget: string | null; reserve: string | null; caps: string[] | null }
  | { kind: 'refunded'; reason: string } // the contract refused the msg and the token sent the USDC back
  | { kind: 'failed'; reason: string } // the transaction failed: no USDC left the wallet
  | { kind: 'unknown' }; // no outcome to read (some wallets return none)

export const txHashOf = (o: unknown): string | null => {
  const x = o as Outcome | null;
  const h = x?.transaction?.hash ?? x?.transaction_outcome?.id;
  return typeof h === 'string' && h ? h : null;
};

/** The innermost error text NEAR reports, e.g. "Smart contract panicked: The account doesn't have enough balance". */
function failureText(status: unknown): string | null {
  const f = (status as { Failure?: unknown } | null)?.Failure;
  if (!f) return null;
  const exec = (f as any)?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  return typeof exec === 'string' ? exec : JSON.stringify(f).slice(0, 300);
}

/** A receipt that ran to the end. NEAR keeps a failed receipt's logs, though its state changes were rolled back. */
const succeeded = (status: unknown) => !!status && typeof status === 'object' && ('SuccessValue' in status || 'SuccessReceiptId' in status);

/** The data of a budget contract event (NEP-297, standard "rook") named `name`, or null for any other log. */
function rookEvent(log: string, name: string): Record<string, unknown> | null {
  if (!log.startsWith('EVENT_JSON:')) return null;
  try {
    const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
    const d = ev?.standard === 'rook' && ev.event === name && Array.isArray(ev.data) ? ev.data[0] : null;
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * Reads what the funding transfer did. Only logs from receipts the contract itself executed count, and task_created
 * only from one that succeeded: create_task logs it before storing the task, so a receipt that failed after the log
 * (out of storage NEAR, say) created nothing, and the token refunded the USDC.
 */
export function readFundingOutcome(outcome: unknown, contractId: string): FundingResult {
  const o = outcome as Outcome | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.receipts_outcome)) return { kind: 'unknown' };
  let refund: string | null = null;
  for (const r of o.receipts_outcome) {
    if (r.outcome?.executor_id !== contractId) continue;
    for (const log of r.outcome.logs ?? []) {
      const d = succeeded(r.outcome.status) ? rookEvent(log, 'task_created') : null;
      if (d && typeof d.task_id === 'string' && /^[0-9a-z]+$/.test(d.task_id)) {
        const caps = Array.isArray(d.caps) && d.caps.every((c) => typeof c === 'string') ? (d.caps as string[]) : null;
        return { kind: 'created', task_id: d.task_id, funder: str(d.funder), budget: str(d.budget), reserve: str(d.reserve), caps };
      }
      const m = log.match(/^refunding \d+: (.+)$/);
      if (m) refund = m[1];
    }
    refund ??= failureText(r.outcome.status); // ft_on_transfer panicked: the token refunds everything
  }
  if (refund) return { kind: 'refunded', reason: refund };
  const failed = failureText(o.status);
  return failed ? { kind: 'failed', reason: failed } : { kind: 'unknown' };
}

/** What a task_created event must carry to be one plan's funding: the budget, the reserve and the caps, in order. */
export type Terms = { budget: string; reserve: string; caps: string[] };

/** The terms the approved transfer asks the contract for. */
export function termsOf(f: Funding): Terms | null {
  const t = fundingTerms(f);
  return t && { budget: f.amount_atomic, reserve: t.reserve_atomic, caps: t.caps };
}

/**
 * The same terms from the plan, for when the funding instructions aren't in (Rook couldn't repeat them). The contract's
 * caps are the hired subtasks' caps in plan order, and the orchestrator gives instructions only when the reserve the
 * contract computes is the plan's.
 */
export const planTerms = (budget_atomic: string, plan: Pick<PlanView, 'subtasks' | 'budget'>): Terms => ({
  budget: budget_atomic,
  reserve: plan.budget.reserve_atomic || '0',
  caps: plan.subtasks.filter((s) => !s.self_do).map((s) => s.cap_atomic),
});

const usd = (atomic: string | null) => (atomic !== null && /^\d+$/.test(atomic) ? `${usdc(atomic)} USDC` : 'missing');

/**
 * Why a contract task isn't this plan's funding from `funder`, or null when it is. A transaction hash proves only that
 * some transfer created some contract task: one made for another task (or by another account) must never be confirmed
 * or refunded from this one. The orchestrator checks the same before it runs.
 */
export function fundingMismatch(c: Extract<FundingResult, { kind: 'created' }>, want: Terms, funder: string): string | null {
  const caps = (cs: string[] | null) => (cs ? cs.map(usd).join(', ') : 'missing');
  const bad = [
    c.funder !== funder && `it was sent by ${c.funder ?? 'an unnamed account'}, not ${funder}`,
    c.budget !== want.budget && `its budget is ${usd(c.budget)}, not ${usd(want.budget)}`,
    c.reserve !== want.reserve && `its reserve is ${usd(c.reserve)}, not ${usd(want.reserve)}`,
    JSON.stringify(c.caps) !== JSON.stringify(want.caps) && `its caps are ${caps(c.caps)}, not ${caps(want.caps)}`,
  ].filter((x): x is string => !!x);
  return bad.length ? bad.join('; ') : null;
}

/**
 * Whose transfer a looked-up hash is. 'own': the one this page waits on (its wallet returned that hash). 'other': any
 * other hash while it waits, which never stands in for that transfer (it would be forgotten, and a second one offered).
 * 'unsure': the page knows no hash of its own (the wallet errored or returned none), so a paste is all it has.
 */
export const whoseTransfer = (tx: string, pending: string | null): 'own' | 'other' | 'unsure' =>
  !pending ? 'unsure' : tx === pending ? 'own' : 'other';

/**
 * What a failed confirm means for the USDC in the contract task. 'refund': Rook will never run this contract task for
 * this task (it doesn't match the plan, or the task was stopped). 'refetch': the task moved on, or another confirm is
 * binding it or has bound it, so the page catches up rather than offer a refund that could cut a starting run short.
 * The web server's own refusal (this task's funding is already another contract task) is a 'refetch' too.
 * 'retry': anything else (services down, the contract task not final yet).
 */
export function confirmFailure(message: string): 'refund' | 'refetch' | 'retry' {
  if (/does not match the approved plan|^task is (killed|cancelled), funded needs approved/.test(message)) return 'refund';
  if (/already being checked|already funded by|already funds|funded needs approved|won't confirm contract task/.test(message)) return 'refetch';
  return 'retry';
}

export type CloseResult =
  | { kind: 'refunded'; amount: string } // the contract sent what it held for the task back to the funder
  | { kind: 'refused'; reason: string } // nothing came back: the contract refused, or the refund transfer failed
  | { kind: 'unknown' }; // no evidence either way (no outcome, or one without the contract's event)

/** A receipt's or transaction's return value, decoded from base64, or null when it has none. */
function successValue(status: unknown): string | null {
  const v = (status as { SuccessValue?: unknown } | null)?.SuccessValue;
  if (typeof v !== 'string') return null;
  try { return atob(v); } catch { return null; }
}

/**
 * Reads what the funder's close_task did. A refund counts only with evidence: the transaction didn't fail, its final
 * value isn't false (on_task_closed returns false when the USDC transfer to the funder failed, and the contract put the
 * money back in the task), and the contract logged task_closed for this task with ok true.
 */
export function readCloseOutcome(outcome: unknown, contractId: string, taskId: string): CloseResult {
  const o = outcome as Outcome | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.receipts_outcome)) return { kind: 'unknown' };
  const failed = failureText(o.status);
  if (failed) return { kind: 'refused', reason: failed };
  let closed: { ok: boolean; refund: string } | null = null;
  for (const r of o.receipts_outcome) {
    if (r.outcome?.executor_id !== contractId || !succeeded(r.outcome.status)) continue;
    for (const log of r.outcome.logs ?? []) {
      const d = rookEvent(log, 'task_closed');
      if (d?.task_id === taskId) closed = { ok: d.ok === true, refund: str(d.refund) ?? '0' };
    }
  }
  if (successValue(o.status) === 'false' || closed?.ok === false) {
    return { kind: 'refused', reason: 'the USDC transfer to your wallet failed, so the contract kept the USDC in the task' };
  }
  return closed?.ok ? { kind: 'refunded', amount: closed.refund } : { kind: 'unknown' };
}

/** The final outcome of a transaction by hash, from a NEAR RPC. Retries while the node hasn't seen it yet. */
export async function fetchTxOutcome(rpc: string, txHash: string, sender: string, fetchImpl: typeof fetch = fetch, tries = 5): Promise<unknown> {
  let last = 'no answer';
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((ok) => setTimeout(ok, 2000));
    const r = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'rook-funding', method: 'tx', params: { tx_hash: txHash, sender_account_id: sender, wait_until: 'EXECUTED_OPTIMISTIC' } }),
    });
    const j = await r.json().catch(() => null);
    if (j?.result) return j.result;
    last = j?.error?.cause?.name ?? j?.error?.message ?? `HTTP ${r.status}`;
    if (!/UNKNOWN_TRANSACTION|TIMEOUT_ERROR|HTTP 5/.test(last)) break;
  }
  throw new Error(`NEAR RPC could not find transaction ${txHash}: ${last}`);
}

/**
 * The browser reads the transfer at EXECUTED_OPTIMISTIC; the orchestrator reads the contract at final, a block or two
 * behind, so a contract task the transfer just created can look missing for a few seconds. Only that is retried.
 */
export async function untilFinal<T extends { ok: boolean; message?: string }>(run: () => Promise<T>, tries = 5, gapMs = 1500): Promise<T> {
  for (let i = 1; ; i++) {
    const out = await run();
    if (out.ok || i >= tries || !/no contract task/.test(out.message ?? '')) return out;
    await new Promise((ok) => setTimeout(ok, gapMs));
  }
}

/**
 * Whether a task's money ever moved, so its run started: a ledger snapshot, a receipt, a hire, or a ledger event. The
 * kill's own ledger line doesn't count: runner.ts kill() adds it even to a task stopped before its funding was bound.
 */
export const moneyMoved = (snap: { ledger: unknown; receipts: unknown[] }, events: { type: string; data?: { op?: string } }[]) =>
  !!snap.ledger || snap.receipts.length > 0
  || events.some((e) => e.type === 'hire_sent' || e.type === 'receipt' || (e.type === 'ledger' && e.data?.op !== 'kill'));

/** Closing the wallet or declining is a choice, not a failure. */
export const isWalletCancel = (message: string) => /clos|cancel|reject|denied|declin/i.test(message);
