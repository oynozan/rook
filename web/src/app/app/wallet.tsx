'use client';

import type { NearConnector, SignedMessage, SignMessageParams } from '@hot-labs/near-connect';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NETWORK } from './network';

export { NETWORK };

export type Wallet = {
  account: string | null; // the signed-in account: proven by a wallet signature the server checked
  checking: boolean; // asking the server whether this browser is already signed in
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};

export const WalletContext = createContext<Wallet | null>(null);

export function useWallet() {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error('useWallet needs a WalletProvider');
  return wallet;
}

const post = async <T,>(url: string, body?: unknown): Promise<{ status: number; data: T }> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const pause = (ms: number) => new Promise<null>((ok) => setTimeout(() => ok(null), ms));

/**
 * Signing in means the wallet signs "Sign in to Rook" with a one-time nonce (NEP-413). That is a message, not a
 * transaction: no gas, no key added, no funds touched. The server checks it and sets a session; until then the
 * account is unknown, whatever the wallet extension says.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const connector = useRef<NearConnector | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endSession = async () => {
    await fetch('/api/auth/session', { method: 'DELETE' }).catch(() => {});
    setAccount(null);
    router.refresh(); // the sidebar lists only the signed-in account's tasks
  };

  // Imported in the browser only: the connector touches window and loads its wallet list when it is created.
  async function getConnector() {
    if (connector.current) return connector.current;
    const { NearConnector } = await import('@hot-labs/near-connect');
    const c = new NearConnector({ network: NETWORK, footerBranding: null, features: { signMessage: true } });
    c.on('wallet:signOut', () => { void endSession(); });
    connector.current = c;
    return c;
  }

  // Signed in on an earlier visit? The session cookie answers; the wallet extension's own state doesn't count.
  useEffect(() => {
    let live = true;
    fetch('/api/auth/session', { cache: 'no-store' })
      .then((r) => r.json())
      .then((s: { account: string | null }) => { if (live) setAccount(s.account); })
      .catch(() => {})
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, []);

  /** Gets the wallet to sign the challenge: in one step while connecting, or directly if it is already connected. */
  async function sign(c: NearConnector, params: SignMessageParams): Promise<SignedMessage> {
    const connected = await c.getConnectedWallet().catch(() => null);
    if (connected?.accounts[0]) return connected.wallet.signMessage({ ...params, signerId: connected.accounts[0].accountId, network: NETWORK });

    await c.whenManifestLoaded;
    if (!c.availableWallets.length) throw new Error('no wallets available');
    let resolve: (m: SignedMessage | null) => void = () => {};
    const signedDuringConnect = new Promise<SignedMessage | null>((ok) => (resolve = ok));
    const onSigned = (e: { accounts: { signedMessage?: SignedMessage }[] }) => resolve(e.accounts[0]?.signedMessage ?? null);
    c.on('wallet:signInAndSignMessage', onSigned);
    try {
      await c.connect({ signMessageParams: params });
      // Most wallets sign as they connect. One that only connected gets asked to sign on its own.
      const m = await Promise.race([signedDuringConnect, pause(3000)]);
      if (m) return m;
      const now = await c.getConnectedWallet();
      return now.wallet.signMessage({ ...params, signerId: now.accounts[0]?.accountId, network: NETWORK });
    } finally {
      c.off('wallet:signInAndSignMessage', onSigned);
    }
  }

  const value = useMemo<Wallet>(() => ({
    account, checking, connecting, error,
    async connect() {
      setError(null);
      setConnecting(true);
      try {
        const { data: challenge } = await post<{ message: string; recipient: string; nonce: string }>('/api/auth/challenge');
        const c = await getConnector();
        const signed = await sign(c, { message: challenge.message, recipient: challenge.recipient, nonce: fromBase64(challenge.nonce) });
        const { data: out } = await post<{ ok: true; account: string } | { ok: false; reason: string }>('/api/auth/verify', signed);
        if (!out.ok) { setError(out.reason); return; }
        setAccount(out.account);
        router.refresh();
      } catch (e) {
        // Closing the wallet list or declining to sign rejects too, and that is a choice rather than a failure.
        const message = e instanceof Error ? e.message : String(e);
        if (/no wallets/.test(message)) setError("Couldn't load wallets. Try again.");
        else if (!/clos|cancel|reject|denied|declin/i.test(message)) setError("Couldn't sign in with your wallet. Try again.");
      } finally {
        setConnecting(false);
      }
    },
    async disconnect() {
      try {
        await connector.current?.disconnect();
      } catch {
        // The wallet may already be gone. Either way, the session ends.
      }
      await endSession();
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [account, checking, connecting, error]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
