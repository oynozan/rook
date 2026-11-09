// Chain gateway: the orchestrator's function-call key on the budget contract, plus contract and token views, and the
// payment lookup that ties a hire to its on-chain USDC transfer. docs/x402-payments-plan.md 4.3; gas per
// contract/README.md. Writes attach no deposit (a function-call key cannot).
import { setTimeout as sleep } from 'node:timers/promises';
import { KeyPair, type KeyPairString } from 'near-api-js';
import { config } from '../shared/config.ts';
import { HttpError, serve, type Running } from '../shared/http.ts';
import { explorerTx, ftBalance, functionCall, sendTx, viewCall } from '../shared/near.ts';

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

/** `account`'s transfer of exactly `amount` of `token` to `to`, at or after `afterNs`, as NearBlocks indexed it. */
async function findTransfer(account: string, to: string, amount: string, token: string, afterNs: bigint) {
  const j = await indexerGet(`/v3/accounts/${encodeURIComponent(account)}/ft-txns?limit=25`);
  const hit = (Array.isArray(j?.data) ? j.data : []).find((x: any) => x.affected_account_id === account && x.involved_account_id === to
    && x.delta_amount === `-${amount}` && x.contract_account_id === token && BigInt(x.block_timestamp ?? 0) >= afterNs);
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
    'GET /task/:id': async ({ params }) => {
      const [task, subtasks] = await Promise.all([
        viewCall(contract, 'get_task', { task_id: params.id }), viewCall(contract, 'get_subtasks', { task_id: params.id }),
      ]);
      if (!task) throw new HttpError(404, `no contract task ${params.id}`);
      return { task, subtasks };
    },
    'GET /balance': async ({ query }) => {
      const acct = str(query.get('account'), 'account');
      const token = query.get('token') || await usdc();
      return { account: acct, token, balance: (await ftBalance(token, acct)).toString() };
    },
    /**
     * A hire's settled x402 payment: `account`'s USDC transfer of `amount` to `to` (payTo) at or after `after` (ISO
     * time or epoch ms). Indexers lag, so it looks ROOK_PAYMENT_LOOKUP_TRIES times (6), ROOK_PAYMENT_LOOKUP_MS (10 s) apart.
     */
    'GET /payment': async ({ query }) => {
      const acct = str(query.get('account'), 'account'), to = str(query.get('to'), 'to'), amount = str(query.get('amount'), 'amount');
      if (!/^\d+$/.test(amount)) throw new HttpError(400, 'amount must be an integer string');
      const a = query.get('after') ?? '0', ms = /^\d+$/.test(a) ? Number(a) : Date.parse(a);
      if (!Number.isFinite(ms)) throw new HttpError(400, 'after must be an ISO time or epoch milliseconds');
      const afterNs = BigInt(Math.max(0, ms - 120_000)) * 1_000_000n; // allows 2 minutes of clock skew between Rook and the chain
      const token = query.get('token') || await usdc();
      const tries = Math.max(1, envNum('ROOK_PAYMENT_LOOKUP_TRIES', 6));
      let error: string | null = null;
      for (let i = 1; ; i++) {
        try {
          const hit = await findTransfer(acct, to, amount, token, afterNs);
          if (hit) return { found: true, ...hit, explorer_url: explorerTx(hit.tx_hash), source: 'nearblocks-v3' };
          error = null;
        } catch (e: any) { error = e?.message ?? String(e); }
        if (i >= tries) return { found: false, tries: i, error };
        await sleep(envNum('ROOK_PAYMENT_LOOKUP_MS', 10_000));
      }
    },
  }, port);
}
