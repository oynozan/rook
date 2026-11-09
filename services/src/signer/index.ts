// Signer: holds the sub-account keys, registers them on the budget contract, signs x402 payments (NEP-366 delegates)
// and returns leftovers. docs/x402-payments-plan.md 4.2 and 4.6; build-plan.md "signer".
// Never logs or stores a secret key or a payment header (only sha256 of the header).
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { KeyPair, type KeyPairString } from 'near-api-js';
import { config } from '../shared/config.ts';
import { call, HttpError, serve, type Running } from '../shared/http.ts';
import { ftBalance, functionCall, latestBlock, sendTx, signDelegate, viewAccessKey, viewCall } from '../shared/near.ts';
import { AcceptsRow, type X402Config } from '../shared/types.ts';

const REPO = resolve(import.meta.dirname, '../../..');
function refuse(reason: string): never { throw new HttpError(409, reason); }
function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
}

/** Key directory: ROOK_SIGNER_KEY_DIR or ~/.rook/keys, never inside the repo. */
export function keyDir() {
  const dir = resolve(process.env.ROOK_SIGNER_KEY_DIR || join(homedir(), '.rook', 'keys'));
  const rel = relative(REPO, dir);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error(`ROOK_SIGNER_KEY_DIR ${dir} is inside the repo; keys must live outside it`);
  return dir;
}

/** t<task>-<n>[-<k>].<contract> -> k (0 when absent). */
const attemptOf = (account: string, task: string, n: number, contract: string) => {
  const m = account.match(/^t([0-9a-z]+)-(\d+)(?:-(\d+))?\.(.+)$/);
  if (!m || m[1] !== task || Number(m[2]) !== n || m[4] !== contract) refuse(`${account} is not subtask ${n} of task ${task} on ${contract}`);
  return Number(m[3] ?? 0);
};

export async function start(port = config.ports.signer): Promise<Running> {
  const account = need('ROOK_SIGNER_ACCOUNT'), contract = need('ROOK_CONTRACT_ID');
  const signerKey = KeyPair.fromString(need('ROOK_SIGNER_KEY') as KeyPairString);
  const dir = join(keyDir(), contract);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const keyFile = (task: string, n: number, attempt: number) => join(dir, `${task}-${n}-${attempt}.key`);
  const readKey = (f: string) => KeyPair.fromString(readFileSync(f, 'utf8').trim() as KeyPairString);
  const loadKey = (task: string, n: number, attempt: number) => {
    const f = keyFile(task, n, attempt);
    if (!existsSync(f)) refuse(`no key for subtask ${n} attempt ${attempt} of task ${task}`);
    return readKey(f);
  };

  // (task, n) -> outstanding authorization. One per sub-account at a time, so delegate nonces never race.
  // Kept on disk with the kill state, so a restarted signer still refuses what it refused before.
  type Auth = { payment_hash: string; expires_at_block: number; account_id: string; public_key: string; nonce: string };
  const stateFile = join(dir, 'signer-state.json');
  const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const auths = new Map<string, Auth>(Object.entries(saved.auths ?? {}));
  const killedTasks = new Set<string>(saved.killed_tasks ?? []);
  let killed = saved.killed === true;
  const save = () => {
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ auths: Object.fromEntries(auths), killed, killed_tasks: [...killedTasks] }), { mode: 0o600 });
    renameSync(tmp, stateFile);
  };
  const busy = new Set<string>();

  /** Contract checks shared by /sign and /return: the subtask exists, account_id is its current account. */
  async function subtask(task_id: string, n: number, account_id: string) {
    const [cfg, task, subs] = await Promise.all([
      viewCall(contract, 'get_config'), viewCall(contract, 'get_task', { task_id }), viewCall<any[]>(contract, 'get_subtasks', { task_id }),
    ]);
    if (!task) refuse(`unknown contract task ${task_id}`);
    const sub = subs.find((s) => s.n === n);
    if (!sub || sub.account_id !== account_id) refuse(`${account_id} is not the current account of subtask ${n}`);
    const key = loadKey(task_id, n, attemptOf(account_id, task_id, n, contract));
    if (key.getPublicKey().toString() !== sub.public_key) refuse(`the key on file is not the one registered for ${account_id}`);
    return { cfg, task, sub, key };
  }

  return serve('signer', {
    /** New key pair for subtask n's next funding attempt, saved outside the repo, registered on the contract. */
    'POST /keys': async ({ body }) => {
      const task_id = String(body?.task_id ?? ''), n = Number(body?.n);
      if (!/^[0-9a-z]+$/.test(task_id) || !Number.isInteger(n) || n < 1) throw new HttpError(400, 'task_id (base-36) and n are required');
      const prev = (await viewCall<any[]>(contract, 'get_subtasks', { task_id })).find((s) => s.n === n);
      const attempt = prev ? prev.attempt + 1 : 0;
      const f = keyFile(task_id, n, attempt);
      // A key file is never overwritten: its key may already be registered (a registration reported as failed can
      // still land), and then the file is the only copy of the secret. A retry registers the same key again.
      let kp: KeyPair;
      try {
        kp = KeyPair.fromRandom('ed25519');
        writeFileSync(f, kp.toString(), { mode: 0o600, flag: 'wx' });
        chmodSync(f, 0o600);
      } catch (e: any) {
        if (e?.code !== 'EEXIST') throw e;
        kp = readKey(f);
      }
      const public_key = kp.getPublicKey().toString();
      const r = await sendTx(account, signerKey, contract, [functionCall('register_subtask_key', { task_id, n, public_key }, 30)]);
      // ponytail: no view shows a registered key, so 'already registered' is taken as this file's key (no other is ever written).
      if (!r.success && JSON.stringify(r.failure ?? '').includes('key already registered')) return { public_key, tx_hash: r.hash, already_registered: true };
      if (!r.success) throw new HttpError(502, `register_subtask_key failed: ${JSON.stringify(r.failure)}`, { tx_hash: r.hash });
      return { public_key, tx_hash: r.hash };
    },

    /** x402 payment for one accepts row: refuses unless every check of plan 4.2 holds. */
    'POST /sign': async ({ body }) => {
      const task_id = String(body?.task_id ?? ''), n = Number(body?.n), account_id = String(body?.account_id ?? '');
      if (killed || killedTasks.has(task_id)) refuse('signer is killed for this task');
      const row = body?.row;
      const parsed = AcceptsRow.safeParse(row);
      if (!parsed.success) throw new HttpError(400, 'row is not an x402 accepts row');
      const ttl = row.maxTimeoutSeconds;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > config.maxPaymentTimeoutS) refuse(`maxTimeoutSeconds ${ttl} is not an integer from 1 to ${config.maxPaymentTimeoutS}`);
      const slot = `${task_id}/${n}`;
      if (busy.has(slot)) refuse(`subtask ${n} is already being signed`);
      busy.add(slot);
      try {
        if (row.scheme !== 'exact') refuse(`scheme ${row.scheme} is not exact`);
        if (row.network !== `near:${config.nearNetwork}`) refuse(`network ${row.network} is not near:${config.nearNetwork}`);
        const x402 = await call<X402Config>(config.urls.marketGateway + '/x402');
        if (!x402.recipients?.some((r) => r.network === row.network && r.asset === row.asset && r.payTo === row.payTo)) {
          refuse(`asset ${row.asset} / payTo ${row.payTo} is not a marketplace recipient`);
        }
        const { cfg, task, sub, key } = await subtask(task_id, n, account_id);
        if (cfg.killed || task.killed) refuse('contract or task is killed');
        if (sub.status !== 'Funded') refuse(`subtask ${n} is ${sub.status}`);
        const block = await latestBlock();
        const out = auths.get(slot);
        if (out && block.height <= out.expires_at_block) refuse(`subtask ${n} has an outstanding authorization until block ${out.expires_at_block}`);
        const amount = BigInt(row.amount);
        if (amount <= 0n) refuse('amount must be positive');
        const balance = await ftBalance(row.asset, account_id);
        if (amount > balance) refuse(`amount ${amount} exceeds the sub-account balance ${balance}`);
        // Spending to exactly 0 is fine: the contract's mark_empty closes out an empty sub-account (no 0 `return`).

        const public_key = key.getPublicKey().toString();
        const nonce = (await viewAccessKey(account_id, public_key)).nonce + 1n;
        const expires_at_block = block.height + ttl;
        const transfer = functionCall('ft_transfer', { receiver_id: row.payTo, amount: row.amount }, 30, 1n);
        const signedDelegateAction = await signDelegate(key, account_id, row.asset, [transfer], nonce, BigInt(expires_at_block));
        const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { signedDelegateAction } })).toString('base64');
        const payment_hash = createHash('sha256').update(header).digest('hex');
        auths.set(slot, { payment_hash, expires_at_block, account_id, public_key, nonce: nonce.toString() });
        save(); // on disk before the header leaves
        return { header, payment_hash, expires_at_block, nonce: nonce.toString() };
      } finally {
        busy.delete(slot);
      }
    },

    /**
     * Clears the outstanding authorization once it can no longer settle: it landed (the sub-account key's nonce reached
     * the delegate's), the A2A task ended unpaid (terminal_unpaid), or it expired. `landed` tells Rook it was paid.
     */
    'POST /expire': async ({ body }) => {
      const slot = `${body?.task_id}/${Number(body?.n)}`;
      const out = auths.get(slot);
      if (!out) return { cleared: false, outstanding: false };
      // The nonce shows the delegate ran, not that its ft_transfer succeeded: the orchestrator books by the balance.
      const landed = (await viewAccessKey(out.account_id, out.public_key)).nonce >= BigInt(out.nonce);
      if (!landed && body?.terminal_unpaid !== true) {
        const { height } = await latestBlock();
        if (height <= out.expires_at_block) refuse(`authorization still valid until block ${out.expires_at_block} (now ${height})`);
      }
      auths.delete(slot);
      save();
      return { cleared: true, payment_hash: out.payment_hash, landed };
    },

    /** {task_id}: refuse every further /sign for that contract task. Without task_id: for every task. */
    'POST /kill': ({ body }) => {
      if (body?.task_id !== undefined) killedTasks.add(String(body.task_id));
      else killed = true;
      save();
      return { killed: true, task_id: body?.task_id ?? null };
    },

    /** Sends the sub-account's whole USDC balance back to the contract with msg {"return":{task_id,n}}. */
    'POST /return': async ({ body }) => {
      const task_id = String(body?.task_id ?? ''), n = Number(body?.n), account_id = String(body?.account_id ?? '');
      const out = auths.get(`${task_id}/${n}`);
      if (out && (await latestBlock()).height <= out.expires_at_block) refuse(`subtask ${n} has an outstanding authorization`);
      const { cfg, key } = await subtask(task_id, n, account_id);
      const amount = await ftBalance(cfg.usdc, account_id);
      // NEP-141 refuses a 0 transfer: an empty sub-account is closed out with the contract's mark_empty (chain-gateway).
      if (amount === 0n) refuse(`${account_id} is empty: nothing to return; chain-gateway /mark-empty marks it returned`);
      const msg = JSON.stringify({ return: { task_id, n } });
      // ponytail: 50 Tgas (0.005 NEAR at 100 Mgas/gas price) fits the sub-account's 0.01 NEAR; measure on testnet (plan step 2).
      const r = await sendTx(account_id, key, cfg.usdc, [functionCall('ft_transfer_call', { receiver_id: contract, amount: amount.toString(), msg }, 50, 1n)]);
      if (!r.success) throw new HttpError(502, `return failed: ${JSON.stringify(r.failure)}`, { tx_hash: r.hash });
      // ft_transfer_call returns the amount the receiver kept; the contract refunds (keeps 0) on a refused return.
      if (String(r.value) !== amount.toString()) throw new HttpError(502, `contract kept ${String(r.value)} of ${amount}`, { tx_hash: r.hash });
      return { tx_hash: r.hash, amount: amount.toString() };
    },
  }, port);
}
