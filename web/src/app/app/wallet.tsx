'use client';

import type { NearConnector } from '@hot-labs/near-connect';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export const NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK === 'testnet' ? 'testnet' : 'mainnet';

export type Wallet = {
  account: string | null;
  checking: boolean; // looking for a wallet connected on an earlier visit
  connecting: boolean;
  failed: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};

export const WalletContext = createContext<Wallet | null>(null);

export function useWallet() {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error('useWallet needs a WalletProvider');
  return wallet;
}

/** Sign-in only shares the account id: no on-chain transaction, no key added, nothing signed. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const connector = useRef<NearConnector | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [failed, setFailed] = useState(false);

  // Imported in the browser only: the connector touches window and loads its wallet list when it is created.
  async function getConnector() {
    if (connector.current) return connector.current;
    const { NearConnector } = await import('@hot-labs/near-connect');
    const c = new NearConnector({ network: NETWORK, footerBranding: null });
    c.on('wallet:signIn', (e) => setAccount(e.accounts[0]?.accountId ?? null));
    c.on('wallet:signOut', () => setAccount(null));
    connector.current = c;
    return c;
  }

  // Bring back a wallet connected on an earlier visit. None connected is the normal case, so it stays quiet.
  useEffect(() => {
    let live = true;
    getConnector()
      .then((c) => c.getConnectedWallet())
      .then(({ accounts }) => { if (live && accounts[0]) setAccount(accounts[0].accountId); })
      .catch(() => {})
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, []);

  const value = useMemo<Wallet>(() => ({
    account, checking, connecting, failed,
    async connect() {
      setFailed(false);
      setConnecting(true);
      try {
        const c = await getConnector();
        await c.whenManifestLoaded;
        if (!c.availableWallets.length) throw new Error('no wallets available');
        await c.connect();
      } catch (e) {
        // Closing the wallet list rejects too, and that is a choice rather than a failure.
        const message = e instanceof Error ? e.message : String(e);
        if (!/clos|cancel|reject/i.test(message)) setFailed(true);
      } finally {
        setConnecting(false);
      }
    },
    async disconnect() {
      try {
        await connector.current?.disconnect();
      } catch {
        // The wallet may already be gone. Either way, this page should stop treating it as connected.
      }
      setAccount(null);
    },
  }), [account, checking, connecting, failed]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
