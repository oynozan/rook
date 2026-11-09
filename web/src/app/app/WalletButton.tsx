'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useEase } from './useEase';
import { UserAvatar } from './UserAvatar';
import { NETWORK, useWallet } from './wallet';

/** Named accounts read as they are; 64-character implicit ones keep their ends. */
const shortAccount = (id: string) => (id.length > 20 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id);

export function AccountMenu({ account, onDisconnect }: { account: string; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const ease = useEase();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    // Escape closes one thing at a time: this runs first and stops it reaching the sidebar around the menu.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
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
        className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.25 text-left font-medium transition-colors duration-200 hover:bg-ink/5 active:translate-y-px motion-reduce:transition-none"
      >
        <UserAvatar account={account} size={26} />
        <span className="sr-only">Connected wallet: </span>
        <span className="min-w-0 truncate">{shortAccount(account)}</span>
      </button>
      <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={ease}
          className="absolute inset-x-0 bottom-full z-10 mb-2 rounded-2xl border border-ink/15 bg-surface p-4 shadow-lg shadow-ink/10">
          <p className="text-sm text-ink/65">Connected on NEAR {NETWORK}</p>
          <p className="mt-1 font-mono text-sm break-all">{account}</p>
          <button
            type="button"
            onClick={() => { setOpen(false); onDisconnect(); }}
            className="mt-3 min-h-10 w-full cursor-pointer rounded-full border border-ink/25 px-4 font-medium transition-colors hover:border-ink hover:bg-ink/5 focus-visible:border-ink active:translate-y-px motion-reduce:transition-none"
          >
            Disconnect
          </button>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

export function WalletButton() {
  const { connecting, error, connect } = useWallet();

  return (
    <div className="relative flex flex-col items-end">
      <button
        type="button"
        onClick={connect}
        disabled={connecting}
        className="inline-flex min-h-11 cursor-pointer items-center gap-[0.25em] rounded-full bg-accent px-4 text-base font-medium sm:min-h-13 sm:px-5 sm:text-[1.0625rem] whitespace-nowrap text-on-accent transition-colors duration-200 hover:bg-accent-hover focus-visible:bg-accent-hover active:translate-y-px disabled:cursor-wait disabled:bg-accent-hover motion-reduce:transition-none md:min-h-14 md:px-6.5 md:text-lg"
      >
        {connecting ? 'Check your wallet…' : <>Connect <span className="max-[399px]:sr-only">NEAR</span> wallet</>}
      </button>
      {error && <p role="alert" className="absolute top-full right-0 mt-1 w-max max-w-72 text-right text-sm text-alert">{error}</p>}
    </div>
  );
}
