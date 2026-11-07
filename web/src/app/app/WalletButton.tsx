'use client';

import { useEffect, useRef, useState } from 'react';
import { NETWORK, useWallet } from './wallet';

/** Named accounts read as they are; 64-character implicit ones keep their ends. */
const shortAccount = (id: string) => (id.length > 20 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id);

export function AccountMenu({ account, onDisconnect }: { account: string; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-13 max-w-[60vw] cursor-pointer items-center gap-2.5 rounded-full border border-ink/25 px-5 text-[1.0625rem] font-medium transition-colors duration-200 hover:border-ink hover:bg-ink/5 focus-visible:border-ink active:translate-y-px motion-reduce:transition-none md:min-h-14 md:px-6.5 md:text-lg"
      >
        <span className="size-2.5 shrink-0 bg-accent" aria-hidden="true" />
        <span className="sr-only">Connected wallet: </span>
        <span className="truncate">{shortAccount(account)}</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-10 mt-2 w-72 max-w-[calc(100vw-2.5rem)] rounded-2xl border border-ink/15 bg-white p-4 shadow-lg shadow-ink/10">
          <p className="text-sm text-ink/65">Connected on NEAR {NETWORK}</p>
          <p className="mt-1 font-mono text-sm break-all">{account}</p>
          <button
            type="button"
            onClick={() => { setOpen(false); onDisconnect(); }}
            className="mt-3 min-h-10 w-full cursor-pointer rounded-full border border-ink/25 px-4 font-medium transition-colors hover:border-ink hover:bg-ink/5 focus-visible:border-ink active:translate-y-px motion-reduce:transition-none"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export function WalletButton() {
  const { account, connecting, failed, connect, disconnect } = useWallet();

  if (account) return <AccountMenu account={account} onDisconnect={disconnect} />;

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={connect}
        disabled={connecting}
        className="inline-flex min-h-13 cursor-pointer items-center gap-[0.25em] rounded-full bg-accent px-5 text-[1.0625rem] max-[399px]:px-4 font-medium whitespace-nowrap text-on-accent transition-colors duration-200 hover:bg-accent-hover focus-visible:bg-accent-hover active:translate-y-px disabled:cursor-wait disabled:bg-accent-hover motion-reduce:transition-none md:min-h-14 md:px-6.5 md:text-lg"
      >
        {connecting ? 'Connecting…' : <>Connect <span className="max-[399px]:sr-only">NEAR</span> wallet</>}
      </button>
      {failed && <p role="alert" className="absolute top-full mt-1 text-sm text-red-700">Couldn&apos;t load wallets. Try again.</p>}
    </div>
  );
}
