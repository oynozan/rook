// Who is signed in. A NEP-413 signature (nep413.ts) proves an account once; then a signed, httpOnly cookie names a
// server-side session (db.ts) for SESSION_DAYS. Signing out deletes the session, so a copied cookie stops working too.
// Server code reads the account from here, never from anything the browser sends.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { createSession, revokeSession, sessionAccount, spendNonce } from './db';
import { DEFAULT_RPC, NETWORK } from './network';
import { isAccountId, isFullAccessKey, signatureValid, SIGN_IN_MESSAGE } from './nep413';

const SESSION = 'rook_session';
const CHALLENGE = 'rook_challenge';
const SESSION_DAYS = 7;
const CHALLENGE_S = 300;

// Set ROOK_SESSION_SECRET (32+ random bytes) in production. In development a per-process secret is fine: restarting
// the web server just signs everyone out. It lives on globalThis because Next bundles route handlers and pages
// separately, each with its own copy of this module; two random secrets would make every page read you as signed out.
const shared = globalThis as typeof globalThis & { __rookSession?: { secret?: Buffer } };
const state: { secret?: Buffer } = (shared.__rookSession ??= {});
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

/**
 * The NEP-413 recipient: who the signature is for, so a signature made for another app can't sign in here. A fixed
 * value from the environment (the app's domain in production), never the request's Host header, which the caller picks.
 */
export function signInRecipient(): string {
  const r = process.env.ROOK_SIGNIN_RECIPIENT?.trim();
  if (r) return r;
  if (process.env.NODE_ENV === 'production') throw new Error('ROOK_SIGNIN_RECIPIENT must be set in production (the app\'s domain, e.g. rook.example.com)');
  return 'rook.local';
}

// One key per purpose, so a challenge token can never be replayed as a session token or the other way round.
type Purpose = 'challenge' | 'session';
const key = (purpose: Purpose) => createHmac('sha256', secret()).update(`rook-web/${purpose}/v1`).digest();
const mac = (purpose: Purpose, data: string) => createHmac('sha256', key(purpose)).update(data).digest('base64url');
const seal = (purpose: Purpose, value: object) => { const data = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${data}.${mac(purpose, data)}`; };
function open<T>(purpose: Purpose, token: string | undefined): T | null {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const want = Buffer.from(mac(purpose, data)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
}

const secure = process.env.NODE_ENV === 'production';

/** A fresh one-time nonce for the wallet to sign, sealed with the recipient into a short-lived cookie. */
export async function issueChallenge() {
  const nonce = randomBytes(32).toString('base64');
  const recipient = signInRecipient();
  (await cookies()).set(CHALLENGE, seal('challenge', { nonce, recipient, exp: Date.now() + CHALLENGE_S * 1000 }), {
    httpOnly: true, sameSite: 'strict', secure, path: '/api/auth', maxAge: CHALLENGE_S,
  });
  return { message: SIGN_IN_MESSAGE, recipient, nonce };
}

export type SignInResult = { ok: true; account: string } | { ok: false; reason: string };

/** Checks the wallet's signature against the challenge, the account's key on NEAR, then starts a session. */
export async function verifySignIn(input: { accountId?: unknown; publicKey?: unknown; signature?: unknown }): Promise<SignInResult> {
  const jar = await cookies();
  const challenge = open<{ nonce: string; recipient: string; exp: number }>('challenge', jar.get(CHALLENGE)?.value);
  jar.delete({ name: CHALLENGE, path: '/api/auth' }); // one attempt per challenge
  if (!challenge || challenge.exp < Date.now() || challenge.recipient !== signInRecipient()) return { ok: false, reason: 'The sign-in request expired. Try again.' };
  if (!spendNonce(challenge.nonce, challenge.exp)) return { ok: false, reason: 'This sign-in was already used. Try again.' };

  const { accountId, publicKey, signature } = input;
  if (!isAccountId(accountId) || typeof publicKey !== 'string' || typeof signature !== 'string') return { ok: false, reason: 'The wallet sent an incomplete signature.' };
  const nonce = Buffer.from(challenge.nonce, 'base64');
  if (!signatureValid({ publicKey, signature, message: SIGN_IN_MESSAGE, nonce, recipient: challenge.recipient })) {
    return { ok: false, reason: 'The signature did not match. Try again.' };
  }
  try {
    const rpc = process.env.WEB_NEAR_RPC_URL ?? DEFAULT_RPC[NETWORK];
    if (!(await isFullAccessKey(accountId, publicKey, rpc))) return { ok: false, reason: `That key isn't a full-access key of ${accountId} on NEAR ${NETWORK}.` };
  } catch {
    return { ok: false, reason: "Couldn't reach NEAR to check your key. Try again in a moment." };
  }

  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const sid = createSession(accountId, exp);
  jar.set(SESSION, seal('session', { sid, account: accountId, exp }), {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_DAYS * 86_400,
  });
  return { ok: true, account: accountId };
}

/** The signed-in account, or null. The cookie must be ours and its session still open on the server. */
export async function currentAccount(): Promise<string | null> {
  const s = open<{ sid: string; account: string; exp: number }>('session', (await cookies()).get(SESSION)?.value);
  if (!s || s.exp <= Date.now() || !isAccountId(s.account) || typeof s.sid !== 'string') return null;
  return sessionAccount(s.sid) === s.account ? s.account : null;
}

/** Sign out: the session ends on the server, not just in this browser. */
export async function signOut() {
  const jar = await cookies();
  const s = open<{ sid: string }>('session', jar.get(SESSION)?.value);
  if (s && typeof s.sid === 'string') revokeSession(s.sid);
  jar.delete(SESSION);
}
