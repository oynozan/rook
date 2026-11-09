// Who is signed in. A NEP-413 signature (nep413.ts) proves an account once; then a signed, httpOnly cookie remembers
// it for SESSION_DAYS. Server code reads the account from here, never from anything the browser sends.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { NETWORK } from './network';
import { DEFAULT_RPC, isAccountId, isFullAccessKey, signatureValid, SIGN_IN_MESSAGE } from './nep413';

const SESSION = 'rook_session';
const CHALLENGE = 'rook_challenge';
const SESSION_DAYS = 7;
const CHALLENGE_S = 300;

// Set ROOK_SESSION_SECRET (32+ random bytes) in production. In development a per-process secret is fine: restarting
// the web server just signs everyone out. It lives on globalThis because Next bundles route handlers and pages
// separately, each with its own copy of this module; two random secrets would make every page read you as signed out.
const shared = globalThis as typeof globalThis & { __rookSession?: { secret?: Buffer; used: Map<string, number> } };
const state: { secret?: Buffer; used: Map<string, number> } = (shared.__rookSession ??= { used: new Map<string, number>() });
function secret(): Buffer {
  const s = process.env.ROOK_SESSION_SECRET;
  if (s && s.length >= 32) return Buffer.from(s);
  if (process.env.NODE_ENV === 'production') throw new Error('ROOK_SESSION_SECRET must be set (32+ characters) in production');
  if (!state.secret) {
    state.secret = randomBytes(32);
    console.warn('[session] ROOK_SESSION_SECRET is not set; using a per-process secret, so restarting the web server signs everyone out');
  }
  return state.secret;
}

const mac = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url');
const seal = (value: object) => { const data = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${data}.${mac(data)}`; };
function open<T>(token: string | undefined): T | null {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const want = Buffer.from(mac(data)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
}

const secure = process.env.NODE_ENV === 'production';
const used = state.used; // nonces already spent, until they would have expired anyway (shared for the same reason)

/** The site the signature is bound to, so a signature made for another app can't sign in here. */
async function recipient() {
  return (await headers()).get('host') ?? 'rook';
}

/** A fresh one-time nonce for the wallet to sign, remembered in a short-lived signed cookie. */
export async function issueChallenge() {
  const nonce = randomBytes(32).toString('base64');
  (await cookies()).set(CHALLENGE, seal({ nonce, exp: Date.now() + CHALLENGE_S * 1000 }), {
    httpOnly: true, sameSite: 'strict', secure, path: '/api/auth', maxAge: CHALLENGE_S,
  });
  return { message: SIGN_IN_MESSAGE, recipient: await recipient(), nonce };
}

export type SignInResult = { ok: true; account: string } | { ok: false; reason: string };

/** Checks the wallet's signature against the challenge, the account's key on NEAR, then starts a session. */
export async function verifySignIn(input: { accountId?: unknown; publicKey?: unknown; signature?: unknown }): Promise<SignInResult> {
  const jar = await cookies();
  const challenge = open<{ nonce: string; exp: number }>(jar.get(CHALLENGE)?.value);
  jar.delete({ name: CHALLENGE, path: '/api/auth' }); // one attempt per challenge
  if (!challenge || challenge.exp < Date.now()) return { ok: false, reason: 'The sign-in request expired. Try again.' };
  for (const [n, exp] of used) if (exp < Date.now()) used.delete(n);
  if (used.has(challenge.nonce)) return { ok: false, reason: 'This sign-in was already used. Try again.' };
  used.set(challenge.nonce, challenge.exp);

  const { accountId, publicKey, signature } = input;
  if (!isAccountId(accountId) || typeof publicKey !== 'string' || typeof signature !== 'string') return { ok: false, reason: 'The wallet sent an incomplete signature.' };
  const nonce = Buffer.from(challenge.nonce, 'base64');
  if (!signatureValid({ publicKey, signature, message: SIGN_IN_MESSAGE, nonce, recipient: await recipient() })) {
    return { ok: false, reason: 'The signature did not match. Try again.' };
  }
  try {
    const rpc = process.env.WEB_NEAR_RPC_URL ?? DEFAULT_RPC[NETWORK];
    if (!(await isFullAccessKey(accountId, publicKey, rpc))) return { ok: false, reason: `That key isn't a full-access key of ${accountId} on NEAR ${NETWORK}.` };
  } catch {
    return { ok: false, reason: "Couldn't reach NEAR to check your key. Try again in a moment." };
  }

  jar.set(SESSION, seal({ account: accountId, exp: Date.now() + SESSION_DAYS * 86_400_000 }), {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_DAYS * 86_400,
  });
  return { ok: true, account: accountId };
}

/** The signed-in account, or null. */
export async function currentAccount(): Promise<string | null> {
  const s = open<{ account: string; exp: number }>((await cookies()).get(SESSION)?.value);
  return s && s.exp > Date.now() && isAccountId(s.account) ? s.account : null;
}

export async function signOut() {
  (await cookies()).delete(SESSION);
}
