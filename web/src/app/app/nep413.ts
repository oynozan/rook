// NEP-413 sign-in check: did the holder of `accountId`'s full-access key sign our message, for us, with our nonce?
// Pure functions with no Next.js imports, so they can be tested directly. Uses Node's built-in ed25519; no dependency.
// Spec: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
import { createHash, createPublicKey, verify } from 'node:crypto';

export const SIGN_IN_MESSAGE = 'Sign in to Rook';

// 2^31 + 413: the prefix that makes a NEP-413 payload impossible to confuse with a transaction.
const NEP413_TAG = 2147484061;
// DER header that wraps a raw 32-byte ed25519 public key as SPKI, the form node:crypto accepts.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('not base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== '1') break; bytes.unshift(0); } // leading 1s are leading zero bytes
  return Buffer.from(bytes);
}

const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const str = (s: string) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };

/** The bytes a wallet signs: sha256 of the borsh-encoded tag and payload { message, nonce, recipient, callbackUrl: None }. */
export function payloadHash(message: string, nonce: Buffer, recipient: string): Buffer {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const borsh = Buffer.concat([u32(NEP413_TAG), str(message), nonce, str(recipient), Buffer.from([0])]);
  return createHash('sha256').update(borsh).digest();
}

/** "ed25519:<base58>" to raw bytes. Only ed25519 keys can sign NEP-413 messages. */
export function parsePublicKey(publicKey: string): Buffer {
  const [curve, data] = publicKey.split(':');
  if (curve !== 'ed25519' || !data) throw new Error('only ed25519 keys are supported');
  const raw = base58Decode(data);
  if (raw.length !== 32) throw new Error('an ed25519 public key is 32 bytes');
  return raw;
}

/** Wallets return the signature in base64 (as NEP-413 says); a few use base58. Either way it is 64 bytes. */
function parseSignature(signature: string): Buffer {
  const b64 = Buffer.from(signature, 'base64');
  if (b64.length === 64) return b64;
  const b58 = base58Decode(signature.replace(/^ed25519:/, ''));
  if (b58.length === 64) return b58;
  throw new Error('signature is not 64 bytes');
}

export function signatureValid(input: { publicKey: string; signature: string; message: string; nonce: Buffer; recipient: string }): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, parsePublicKey(input.publicKey)]), format: 'der', type: 'spki' });
    return verify(null, payloadHash(input.message, input.nonce, input.recipient), key, parseSignature(input.signature));
  } catch {
    return false;
  }
}

export const DEFAULT_RPC = { mainnet: 'https://rpc.mainnet.fastnear.com', testnet: 'https://rpc.testnet.fastnear.com' } as const;

/**
 * Asks NEAR whether `publicKey` is a full-access key of `accountId`. A valid signature alone only proves someone holds
 * some key; this is what proves it is this account's key. Function-call keys can't sign in (NEP-413 requires full access).
 */
export async function isFullAccessKey(accountId: string, publicKey: string, rpcUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const r = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'rook-signin', method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`NEAR RPC answered HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) return false; // unknown account or key
  return j.result?.permission === 'FullAccess';
}

/** NEAR account ids: 2 to 64 chars of lowercase letters, digits and - _ . separators, or a 64-hex implicit account. */
export const isAccountId = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
