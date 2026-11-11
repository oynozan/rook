'use client';

import { useEffect, useState } from 'react';
import { readUsdcBalance } from '@/lib/funding';
import { rpcFor } from '@/lib/network';
import { useMode } from '@/hooks/mode';

const EVERY_MS = 20_000;

/**
 * What the signed-in account holds of the USDC token Rook's contract takes, read from NEAR. Null while unknown, or when
 * no money moves (no chain ledger). It reads again every 20 s and when the tab comes back, so a funding transfer or a
 * refund shows without a reload; a failed read keeps the last amount rather than blanking it.
 */
export function useUsdcBalance(account: string | null): bigint | null {
  const { mode, chain, network } = useMode();
  const token = chain ? mode?.usdc ?? null : null;
  const [balance, setBalance] = useState<bigint | null>(null);

  useEffect(() => {
    setBalance(null);
    if (!account || !token) return;
    let live = true;
    const read = () => readUsdcBalance(rpcFor(network), token, account).then((b) => { if (live) setBalance(b.balance); }, () => {});
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') read(); }, EVERY_MS);
    const onShow = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
    };
  }, [account, token, network]);

  return balance;
}
