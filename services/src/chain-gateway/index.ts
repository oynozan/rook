// Chain gateway: the orchestrator's function-call key on the budget contract, plus contract and token views.
// docs/x402-payments-plan.md 4.3; gas per contract/README.md. Writes attach no deposit (a function-call key cannot).
// ponytail: settlement detection is not here yet. The orchestrator treats an A2A COMPLETED as settled and records
// the sub-account's ft_balance_of as evidence; finding the payment tx needs an indexer (plan step 4).
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

export async function start(port = config.ports.chainGateway): Promise<Running> {
  const account = need('ROOK_ORCHESTRATOR_ACCOUNT'), contract = need('ROOK_CONTRACT_ID');
  const key = KeyPair.fromString(need('ROOK_ORCHESTRATOR_KEY') as KeyPairString);

  /** One contract call; 502 with the failure when it fails or its callback reports `false` (rolled back). */
  async function write(method: string, args: object, gasTgas: number) {
    const r = await sendTx(account, key, contract, [functionCall(method, args, gasTgas, 0n)]);
    const out = { tx_hash: r.hash, success: r.success && r.value !== false, explorer_url: explorerTx(r.hash), value: r.value };
    if (!out.success) {
      throw new HttpError(502, `${method} failed: ${r.success ? 'callback returned false (rolled back)' : JSON.stringify(r.failure)}`, out);
    }
    return out;
  }

  return serve('chain-gateway', {
    'POST /fund': ({ body }) => write('fund_subtask', { task_id: str(body?.task_id, 'task_id'), n: int(body?.n, 'n') }, 100),
    'POST /top-up': ({ body }) => {
      const amount = str(body?.amount_atomic, 'amount_atomic');
      if (!/^\d+$/.test(amount)) throw new HttpError(400, 'amount_atomic must be an integer string');
      return write('top_up', { task_id: str(body?.task_id, 'task_id'), n: int(body?.n, 'n'), amount }, 50);
    },
    'POST /receipt': ({ body }) => write('record_receipt', { task_id: str(body?.task_id, 'task_id'), n: int(body?.n, 'n'), receipt: body?.receipt }, 30),
    'POST /close': ({ body }) => write('close_task', { task_id: str(body?.task_id, 'task_id') }, 50),

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
      const token = query.get('token') || (await viewCall(contract, 'get_config')).usdc;
      return { account: acct, token, balance: (await ftBalance(token, acct)).toString() };
    },
  }, port);
}
