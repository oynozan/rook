// Funding a task from the browser (SHARED API DECISION 4): the human's USDC ft_transfer_call to the budget contract,
// then reading the contract's NEP-297 "task_created" event from the outcome. Pure functions, no Next.js or Node imports,
// so the browser and the tests both use them.
import type { Network } from './network';

/** What POST /tasks/:id/approve returns in chain mode. Older orchestrators name the owner `funder`. */
export type Funding = {
  contract_id: string; usdc: string; network: Network; amount_atomic: string; msg: string;
  owner?: string; funder?: string;
};

export const fundingOwner = (f: Funding) => f.owner ?? f.funder ?? null;

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
  | { kind: 'created'; task_id: string; funder: string | null; budget: string | null }
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

/** Reads what the funding transfer did. Only logs from receipts the contract itself executed count. */
export function readFundingOutcome(outcome: unknown, contractId: string): FundingResult {
  const o = outcome as Outcome | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.receipts_outcome)) return { kind: 'unknown' };
  let refund: string | null = null;
  for (const r of o.receipts_outcome) {
    if (r.outcome?.executor_id !== contractId) continue;
    for (const log of r.outcome.logs ?? []) {
      if (log.startsWith('EVENT_JSON:')) {
        let ev: any;
        try { ev = JSON.parse(log.slice('EVENT_JSON:'.length)); } catch { continue; }
        const d = ev?.standard === 'rook' && ev.event === 'task_created' && Array.isArray(ev.data) ? ev.data[0] : null;
        if (d && typeof d.task_id === 'string' && /^[0-9a-z]+$/.test(d.task_id)) {
          return { kind: 'created', task_id: d.task_id, funder: typeof d.funder === 'string' ? d.funder : null, budget: typeof d.budget === 'string' ? d.budget : null };
        }
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

/** Closing the wallet or declining is a choice, not a failure. */
export const isWalletCancel = (message: string) => /clos|cancel|reject|denied|declin/i.test(message);
