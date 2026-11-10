'use client';

import type { ConnectorAction, NearConnector, SignedMessage, SignMessageParams } from '@hot-labs/near-connect';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { detail } from '@/lib/errors';
import { NETWORK } from '@/lib/network';

export { NETWORK };

export type Wallet = {
  account: string | null; // the signed-in account: proven by a wallet signature the server checked
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Signs and sends one transaction as the signed-in account, and returns the wallet's outcome (some wallets return none). */
  sendTransaction: (tx: { receiverId: string; actions: ConnectorAction[] }) => Promise<unknown>;
};

/** The wallet is connected as a different account than the one signed in to Rook. */
export class WalletAccountMismatch extends Error {}

export const WalletContext = createContext<Wallet | null>(null);

export function useWallet() {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error('useWallet needs a WalletProvider');
  return wallet;
}

const post = async <T,>(url: string, body?: unknown): Promise<{ status: number; data: T }> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  // A crash shows as an HTML error page: say which call failed, rather than "Unexpected token '<'".
  const data = await r.json().catch(() => { throw new Error(`Rook's web server answered ${url} with HTTP ${r.status} and no data; its log says why`); });
  return { status: r.status, data };
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const pause = (ms: number) => new Promise<null>((ok) => setTimeout(() => ok(null), ms));

/**
 * Signing in means the wallet signs "Sign in to Rook" with a one-time nonce (NEP-413). That is a message, not a
 * transaction: no gas, no key added, no funds touched. The server checks it and sets a session; until then the
 * account is unknown, whatever the wallet extension says.
 *
 * `account` is the layout's reading of the session cookie. It comes again with every refresh and with every action
 * that revalidates the layout, so a session that ended elsewhere (another tab, or it lapsed) shows here as signed out.
 */
export function WalletProvider({ account: signedIn, children }: { account: string | null; children: ReactNode }) {
  const router = useRouter();
  const connector = useRef<NearConnector | null>(null);
  const signingOut = useRef<Promise<void> | null>(null); // Disconnect signing the wallet out
  const [account, setAccount] = useState<string | null>(signedIn);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setAccount(signedIn); }, [signedIn]);

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

  // Back on this tab: another tab may have signed out, or signed in as someone else.
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState !== 'visible') return;
      fetch('/api/auth/session', { cache: 'no-store' })
        .then((r) => r.json())
        .then((s: { account: string | null }) => {
          if (s.account === account) return;
          setAccount(s.account);
          router.refresh(); // the sidebar lists only the signed-in account's tasks
        })
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [account, router]);

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
    account, connecting, error,
    async connect() {
      setError(null);
      setConnecting(true);
      try {
        await signingOut.current; // a Disconnect still signing the wallet out: the wallet list comes after it
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
        if (/no wallets/.test(message)) setError(`The list of NEAR wallets didn't load (${detail(message)}). Check your connection, or turn off a blocker that stops it, then try again.`);
        else if (!/clos|cancel|reject|denied|declin/i.test(message)) setError(`Signing in with your wallet failed: ${detail(message) || 'the wallet gave no reason'}. Try again, or use another wallet.`);
      } finally {
        setConnecting(false);
      }
    },
    async disconnect() {
      // The wallet signs out too, or the next Connect signs straight back in as this account. After a reload there is no
      // connector yet, so one is made for it. The wallet may already be gone; either way the session ends.
      const walletSignOut = getConnector().then((c) => c.disconnect()).catch(() => {});
      signingOut.current = walletSignOut;
      await endSession();
      await walletSignOut;
    },
    async sendTransaction(tx) {
      if (!account) throw new Error('Sign in with your NEAR wallet first.');
      const c = await getConnector();
      // Signed in on an earlier visit, the wallet may not be connected in this browser any more: connect it first.
      let connected = await c.getConnectedWallet().catch(() => null);
      if (!connected?.accounts[0]) {
        await c.connect();
        connected = await c.getConnectedWallet();
      }
      const signer = connected.accounts[0]?.accountId;
      if (signer !== account) {
        throw new WalletAccountMismatch(`Your wallet is connected as ${signer ?? 'no account'}, but you're signed in to Rook as ${account}. Switch to ${account} in your wallet and try again.`);
      }
      return connected.wallet.signAndSendTransaction({ ...tx, network: NETWORK, signerId: account });
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [account, connecting, error]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
