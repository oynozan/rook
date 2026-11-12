// Chain gateway: the orchestrator's function-call key on the budget contract, plus contract and token views, and the
// payment lookup that ties a hire to its on-chain USDC transfer. docs/x402-payments-plan.md 4.3; gas per
// contract/README.md. Writes attach no deposit (a function-call key cannot).
import { setTimeout as sleep } from 'node:timers/promises';
import { KeyPair, type KeyPairString } from 'near-api-js';
import { config } from '../shared/config.ts';
import { HttpError, serve, type Running } from '../shared/http.ts';
import { explorerTx, ftBalance, functionCall, rpc, sendTx, viewCall } from '../shared/near.ts';

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
}
const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${name} is required`);
  return v;
};
const int = (v: unknown, name: string) => {
  if (!Number.isInteger(v) || (v as number) < 1) throw new HttpError(400, `${name} must be a positive integer`);
  return v as number;
};
const envNum = (k: string, d: number) => Number(process.env[k] ?? d);

// ---- payment lookup: NearBlocks API v3, keyless (NEARBLOCKS_API_KEY is sent as a Bearer token when set) ----
// One request at a time, at least ROOK_INDEXER_GAP_MS (1 s) apart, and a 429 waits for Retry-After. The keyless
// limit is not published in its responses, so Rook stays far below it: a few lookups per paid hire.
const indexerBase = () => process.env.NEARBLOCKS_API_URL || `https://api${config.nearNetwork === 'mainnet' ? '' : '-testnet'}.nearblocks.io`;
let lane: Promise<unknown> = Promise.resolve(), lastAt = 0;
function indexerGet(path: string): Promise<any> {
  const run = async () => {
    for (let i = 0; ; i++) {
      const gap = lastAt + envNum('ROOK_INDEXER_GAP_MS', 1000) - Date.now();
      if (gap > 0) await sleep(gap);
      lastAt = Date.now();
      const key = process.env.NEARBLOCKS_API_KEY;
      const r = await fetch(indexerBase() + path, {
        headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 429 && i < 2) { await sleep((Number(r.headers.get('retry-after')) || 10) * 1000); continue; }
      if (!r.ok) throw new Error(`NearBlocks ${path.split('?')[0]}: HTTP ${r.status}`);
      return r.json();
    }
  };
  const p = lane.then(run, run);
  lane = p.catch(() => {});
  return p;
}

/** A receipt that ran to the end. NEAR keeps a failed receipt's logs, though its state changes were rolled back. */
const succeeded = (status: unknown) => !!status && typeof status === 'object' && ('SuccessValue' in status || 'SuccessReceiptId' in status);

/**
 * What a funding transfer's final outcome says: the task_created event of `contract` (NEP-297, standard "rook"), or
 * the reason the contract refused the msg (its "refunding N: why" log, or the panic), when the token refunded it.
 */
export function createdTask(outcome: any, contract: string):
  | { found: true; task_id: string; funder: string | null; budget: string | null; reserve: string | null; caps: string[] | null }
  | { found: false; refunded: string | null } {
  let refund: string | null = null;
  for (const r of Array.isArray(outcome?.receipts_outcome) ? outcome.receipts_outcome : []) {
    if (r?.outcome?.executor_id !== contract) continue;
    for (const log of r.outcome.logs ?? []) {
      if (typeof log !== 'string') continue;
      if (log.startsWith('EVENT_JSON:') && succeeded(r.outcome.status)) {
        let ev: any = null;
        try { ev = JSON.parse(log.slice('EVENT_JSON:'.length)); } catch { /* not an event */ }
        const d = ev?.standard === 'rook' && ev.event === 'task_created' && Array.isArray(ev.data) ? ev.data[0] : null;
        if (d && typeof d.task_id === 'string' && /^[0-9a-z]+$/.test(d.task_id)) {
          const s = (v: unknown) => (typeof v === 'string' ? v : null);
          const caps = Array.isArray(d.caps) && d.caps.every((c: unknown) => typeof c === 'string') ? d.caps : null;
          return { found: true, task_id: d.task_id, funder: s(d.funder), budget: s(d.budget), reserve: s(d.reserve), caps };
        }
      }
      const m = log.match(/^refunding \d+: (.+)$/);
      if (m) refund = m[1];
    }
    const failure = r.outcome.status?.Failure;
    if (failure && !refund) refund = JSON.stringify(failure).slice(0, 300); // ft_on_transfer panicked: refunded in full
  }
  return { found: false, refunded: refund };
}

const LIMIT = 25;
/**
 * `account`'s transfer of exactly `amount` of `token` to `to`, as NearBlocks indexed it. With `index`: the account's
 * index-th transfer of `token` to `to` (any amount, oldest first), which must be of `amount`; one sub-account pays one
 * treasury once per paid hire, so a re-hire at the same price is never matched with another hire's transfer. Without
 * it: the newest such transfer at or after `afterNs`.
 */
async function findTransfer(account: string, to: string, amount: string, token: string, afterNs: bigint, index: number | null) {
  const j = await indexerGet(`/v3/accounts/${encodeURIComponent(account)}/ft-txns?limit=${LIMIT}`);
  const rows: any[] = Array.isArray(j?.data) ? j.data : [];
  const sent = rows.filter((x) => x.affected_account_id === account && x.involved_account_id === to && x.contract_account_id === token && String(x.delta_amount).startsWith('-'));
  let hit: any;
  if (index === null) hit = sent.find((x) => x.delta_amount === `-${amount}` && BigInt(x.block_timestamp ?? 0) >= afterNs);
  else if (rows.length < LIMIT) { // ponytail: a full page may have cut older transfers, so it is not counted
    const nth = sent.sort((a, b) => (BigInt(a.block_timestamp ?? 0) < BigInt(b.block_timestamp ?? 0) ? -1 : 1))[index];
    hit = nth?.delta_amount === `-${amount}` ? nth : undefined;
  }
  return hit ? { tx_hash: String(hit.transaction_hash), receipt_id: hit.receipt_id ?? null, block_timestamp: String(hit.block_timestamp) } : null;
}

export async function start(port = config.ports.chainGateway): Promise<Running> {
  const account = need('ROOK_ORCHESTRATOR_ACCOUNT'), contract = need('ROOK_CONTRACT_ID');
  const key = KeyPair.fromString(need('ROOK_ORCHESTRATOR_KEY') as KeyPairString);

  /** One contract call; 502 with the failure when it fails or (unless falseOk) its callback reports `false` (rolled back). */
  async function write(method: string, args: object, gasTgas: number, falseOk = false) {
    const r = await sendTx(account, key, contract, [functionCall(method, args, gasTgas, 0n)]);
    const out = { tx_hash: r.hash, success: r.success && (falseOk || r.value !== false), explorer_url: explorerTx(r.hash), value: r.value };
    if (!out.success) {
      throw new HttpError(502, `${method} failed: ${r.success ? 'callback returned false (rolled back)' : JSON.stringify(r.failure)}`, out);
    }
    return out;
  }
  const usdc = async () => (await viewCall(contract, 'get_config')).usdc as string;

  return serve('chain-gateway', {
    'POST /fund': ({ body }) => write('fund_subtask', { task_id: str(body?.task_id, 'task_id'), n: int(body?.n, 'n') }, 100),
    'POST /top-up': ({ body }) => {
      const amount = str(body?.amount_atomic, 'amount_atomic');
      if (!/^\d+$/.test(amount)) throw new HttpError(400, 'amount_atomic must be an integer string');
      return write('top_up', { task_id: str(body?.task_id, 'task_id'), n: int(body?.n, 'n'), amount }, 50);
    },
    'POST /receipt': ({ body }) => write('record_receipt', { task_id: str(body?.task_id, 'task_id'), n: int(body?.n, 'n'), receipt: body?.receipt }, 30),
    'POST /close': ({ body }) => write('close_task', { task_id: str(body?.task_id, 'task_id') }, 50),
    /** An emptied sub-account cannot send a 0 `return` (NEP-141): the contract marks it Returned when its USDC is 0. */
    'POST /mark-empty': async ({ body }) => {
      const out = await write('mark_empty', { task_id: str(body?.task_id, 'task_id'), n: int(body?.n, 'n') }, 50, true);
      return { ...out, marked: out.value === true };
    },

    'GET /config': async () => ({ contract_id: contract, network: config.nearNetwork, ...(await viewCall(contract, 'get_config')) }),
    /** Tasks `account` funded that the contract has not closed yet (it refunds a create_task over max_open_tasks). */
    'GET /open-tasks': async ({ query }) => ({ open: Number(await viewCall(contract, 'get_open_tasks', { account_id: str(query.get('account'), 'account') })) }),
    'GET /task/:id': async ({ params }) => {
      const [task, subtasks] = await Promise.all([
        viewCall(contract, 'get_task', { task_id: params.id }), viewCall(contract, 'get_subtasks', { task_id: params.id }),
      ]);
      if (!task) throw new HttpError(404, `no contract task ${params.id}`);
      return { task, subtasks };
    },
    /** Whether `account` is registered (NEP-145 storage) on `token` (default: the contract's USDC), so it can receive it. */
    'GET /registered': async ({ query }) => {
      const acct = str(query.get('account'), 'account');
      const token = query.get('token') || await usdc();
      return { account: acct, token, registered: (await viewCall(token, 'storage_balance_of', { account_id: acct })) != null };
    },
    /**
     * The contract task a funding transfer created: transaction `tx` sent by `sender` (an agent wallet's ft_transfer_call,
     * docs/agent-wallet-plan.md), read from its final outcome as the web app reads the user's own (web/src/lib/funding.ts
     * readFundingOutcome): the contract's task_created event, only from a receipt the contract ran to the end.
     */
    'GET /created-task': async ({ query }) => {
      const tx = str(query.get('tx'), 'tx'), sender = str(query.get('sender'), 'sender');
      return createdTask(await rpc('tx', { tx_hash: tx, sender_account_id: sender, wait_until: 'FINAL' }), contract);
    },
    'GET /balance': async ({ query }) => {
      const acct = str(query.get('account'), 'account');
      const token = query.get('token') || await usdc();
      return { account: acct, token, balance: (await ftBalance(token, acct)).toString() };
    },
    /**
     * A hire's settled x402 payment: `account`'s USDC transfer of `amount` to `to` (payTo), the `index`-th such transfer
     * from the account (the orchestrator counts its earlier paid hires), or without `index` the newest at or after
     * `after` (ISO time or epoch ms). Indexers lag, so it looks ROOK_PAYMENT_LOOKUP_TRIES times (6),
     * ROOK_PAYMENT_LOOKUP_MS (10 s) apart.
     */
    'GET /payment': async ({ query }) => {
      const acct = str(query.get('account'), 'account'), to = str(query.get('to'), 'to'), amount = str(query.get('amount'), 'amount');
      if (!/^\d+$/.test(amount)) throw new HttpError(400, 'amount must be an integer string');
      const ix = query.get('index');
      if (ix !== null && !/^\d+$/.test(ix)) throw new HttpError(400, 'index must be a non-negative integer');
      const index = ix === null ? null : Number(ix);
      const a = query.get('after') ?? '0', ms = /^\d+$/.test(a) ? Number(a) : Date.parse(a);
      if (!Number.isFinite(ms)) throw new HttpError(400, 'after must be an ISO time or epoch milliseconds');
      const afterNs = BigInt(Math.max(0, ms - 120_000)) * 1_000_000n; // allows 2 minutes of clock skew between Rook and the chain
      const token = query.get('token') || await usdc();
      const tries = Math.max(1, envNum('ROOK_PAYMENT_LOOKUP_TRIES', 6));
      let error: string | null = null;
      for (let i = 1; ; i++) {
        try {
          const hit = await findTransfer(acct, to, amount, token, afterNs, index);
          if (hit) return { found: true, ...hit, explorer_url: explorerTx(hit.tx_hash), source: 'nearblocks-v3' };
          error = null;
        } catch (e: any) { error = e?.message ?? String(e); }
        if (i >= tries) return { found: false, tries: i, error };
        await sleep(envNum('ROOK_PAYMENT_LOOKUP_MS', 10_000));
      }
    },
  }, port);
}
