// Tiny NEAR helper over JSON-RPC fetch: contract views, access keys, blocks, signed function calls, NEP-366 delegates.
// Endpoint NEAR_RPC_URL (no default: nothing reaches a real network unless the human sets it), network NEAR_NETWORK.
// docs/x402-payments-plan.md sections 2 and 4.
import { createHash } from 'node:crypto';
import {
  DelegateAction, KeyPairSigner, PublicKey, actions, baseDecode, baseEncode, createTransaction, decodeTransaction,
  encodeSignedDelegate, encodeTransaction, type Action, type KeyPair,
} from 'near-api-js';
import { config } from './config.ts';

export const TGAS = 10n ** 12n;
export class NearRpcError extends Error {
  constructor(message: string, public data?: unknown) { super(message); this.name = 'NearRpcError'; }
}

let rpcId = 0;
export async function rpc<T = any>(method: string, params: unknown): Promise<T> {
  const r = await fetch(config.nearRpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(60_000),
  });
  const j: any = await r.json().catch(() => null);
  if (!j) throw new NearRpcError(`NEAR RPC ${method}: HTTP ${r.status}`);
  if (j.error) {
    const why = j.error.cause?.info ?? j.error.data ?? j.error.message;
    throw new NearRpcError(`NEAR RPC ${method}: ${j.error.cause?.name ?? j.error.name ?? 'error'} ${typeof why === 'string' ? why : JSON.stringify(why)}`, j.error);
  }
  return j.result as T;
}

const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

/** JSON view call; returns the parsed JSON result. */
export async function viewCall<T = any>(contract: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: b64json(args) });
  if (r.error) throw new NearRpcError(`view ${contract}.${method}: ${r.error}`);
  const text = Buffer.from(r.result).toString('utf8');
  return (text ? JSON.parse(text) : null) as T;
}

export const ftBalance = async (token: string, account: string) => BigInt(await viewCall<string>(token, 'ft_balance_of', { account_id: account }) ?? 0);

export async function viewAccessKey(account: string, publicKey: string): Promise<{ nonce: bigint; block_hash: string }> {
  const r = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: publicKey });
  return { nonce: BigInt(r.nonce), block_hash: r.block_hash };
}

export async function latestBlock(): Promise<{ height: number; hash: string }> {
  const r = await rpc('block', { finality: 'final' });
  return { height: r.header.height, hash: r.header.hash };
}

/** FunctionCall action with JSON args, gas in Tgas, deposit in yoctoNEAR. */
export const functionCall = (method: string, args: object, gasTgas: number, deposit = 0n): Action =>
  actions.functionCall(method, args, BigInt(gasTgas) * TGAS, deposit);

export type TxResult = { hash: string; success: boolean; value?: unknown; failure?: unknown };

// One send at a time per key: each tx reads the access key nonce fresh, so parallel sends from one key would collide.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, p.catch(() => {}));
  return p;
}

/** RPC failures after which the tx may still land: send_tx timed out, or the connection dropped. */
const mayHaveLanded = (e: any) =>
  (e instanceof NearRpcError && /TIMEOUT_ERROR/.test(e.message)) || e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError;

function outcome(hash: string, r: any): TxResult {
  const st = r?.status ?? {};
  if (st.Failure !== undefined) return { hash, success: false, failure: st.Failure };
  if (typeof st.SuccessValue !== 'string') return { hash, success: false, failure: { unexpected_status: st } };
  const text = Buffer.from(st.SuccessValue, 'base64').toString('utf8');
  let value: unknown = text;
  try { value = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { hash, success: true, value };
}

/**
 * Signs and sends one transaction, waits for the FINAL outcome. `success` is the top-level status; a contract whose
 * callback rolled back returns JSON `false` as `value`, which callers check. When send_tx times out or the connection
 * drops, the tx may still land: its outcome is re-queried by hash (`tx`) before anything is reported as failed.
 */
export function sendTx(signerId: string, key: KeyPair, receiverId: string, acts: Action[], retries = 5): Promise<TxResult> {
  const pk = key.getPublicKey();
  return serial(`${signerId}/${pk}`, async () => {
    const ak = await viewAccessKey(signerId, pk.toString());
    const tx = createTransaction(signerId, pk, receiverId, ak.nonce + 1n, acts, baseDecode(ak.block_hash));
    const { txHash, signedTransaction } = await new KeyPairSigner(key).signTransaction(tx);
    const hash = baseEncode(txHash);
    let first: unknown;
    try {
      const r = await rpc('send_tx', { signed_tx_base64: Buffer.from(signedTransaction.encode()).toString('base64'), wait_until: 'FINAL' });
      return outcome(r?.transaction?.hash ?? hash, r);
    } catch (e) {
      if (!mayHaveLanded(e)) throw e;
      first = e;
    }
    for (let i = 0; i < retries; i++) {
      try {
        return outcome(hash, await rpc('tx', { tx_hash: hash, sender_account_id: signerId, wait_until: 'FINAL' }));
      } catch (e) {
        if (!mayHaveLanded(e) && !(e instanceof NearRpcError && /UNKNOWN_TRANSACTION/.test(e.message))) throw e;
      }
      await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
    }
    throw new NearRpcError(`tx ${hash}: outcome unknown after ${(first as any)?.message ?? first}; check it before retrying`, { tx_hash: hash });
  });
}

export const explorerTx = (hash: string) => `https://${config.nearNetwork === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${hash}`;
export const explorerAccount = (id: string) => `https://${config.nearNetwork === 'mainnet' ? '' : 'testnet.'}nearblocks.io/address/${id}`;

// ---- NEP-366 delegate actions (x402 payments) ----

/** u32 little-endian 2^30 + 366: the NEP-366 prefix that makes a delegate hash differ from any transaction hash. */
const NEP366_PREFIX = Buffer.from([0x6e, 0x01, 0x00, 0x40]);

/** Builds and signs a DelegateAction; returns base64(borsh(SignedDelegate)). */
export async function signDelegate(key: KeyPair, senderId: string, receiverId: string, acts: Action[], nonce: bigint, maxBlockHeight: bigint) {
  const da = new DelegateAction({ senderId, receiverId, actions: acts, nonce, maxBlockHeight, publicKey: key.getPublicKey() });
  const { signedDelegate } = await new KeyPairSigner(key).signDelegateAction(da);
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64');
}

export type DecodedDelegate = {
  senderId: string; receiverId: string; nonce: bigint; maxBlockHeight: bigint; publicKey: string;
  actions: { functionCall?: { methodName: string; args: Uint8Array | number[]; gas: bigint | string; deposit: bigint | string } }[];
};

/**
 * Borsh-decodes base64(SignedDelegate) and verifies its ed25519 signature over sha256(prefix || borsh(DelegateAction)).
 * Throws on anything malformed, non-canonical or wrongly signed.
 */
export function verifySignedDelegate(b64: string): DecodedDelegate {
  const bytes = Buffer.from(b64, 'base64');
  // near-api-js exports no SignedDelegate decoder: decode it as the single action (enum index 8) of an empty tx shell.
  const shell = encodeTransaction(createTransaction('', new PublicKey({ keyType: 0, data: new Uint8Array(32) }), '', 0n, [], new Uint8Array(32)));
  const sd: any = (decodeTransaction(Buffer.concat([shell.subarray(0, -4), Buffer.from([1, 0, 0, 0, 8]), bytes])).actions[0] as any)?.signedDelegate;
  if (!sd || !Buffer.from(encodeSignedDelegate(sd)).equals(bytes)) throw new Error('not a canonical SignedDelegate');
  const key = sd.delegateAction.publicKey?.ed25519Key, sig = sd.signature?.ed25519Signature;
  if (!key || !sig || bytes[bytes.length - 65] !== 0) throw new Error('only ed25519 delegates are accepted');
  // SignedDelegate = borsh(DelegateAction) || borsh(Signature); an ed25519 Signature is 1 + 64 bytes.
  const hash = createHash('sha256').update(NEP366_PREFIX).update(bytes.subarray(0, bytes.length - 65)).digest();
  const pk = new PublicKey({ keyType: 0, data: Uint8Array.from(key.data) });
  if (!pk.verify(hash, Uint8Array.from(sig.data))) throw new Error('delegate signature does not verify');
  const da = sd.delegateAction;
  return { senderId: da.senderId, receiverId: da.receiverId, nonce: BigInt(da.nonce), maxBlockHeight: BigInt(da.maxBlockHeight), publicKey: pk.toString(), actions: da.actions };
}
