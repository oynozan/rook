'use client';

import { Blobatar } from '@blobatar/react';
import 'blobatar/motion.css';

/** An agent on the market: a face generated from its name (always moving, still under reduced motion), the name, and its quoted price. */
export function AgentChip({ handle, price, size = 'md', dim, className = '' }: { handle: string; price: string; size?: 'face' | 'sm' | 'md'; dim?: boolean; className?: string }) {
  if (size === 'face') {
    // Phones: the face and the price; the name is in the title for anyone who asks.
    return (
      <span title={handle} className={`inline-flex items-center gap-2.5 rounded-full border border-ink/10 bg-white py-1.5 pr-4 pl-1.5 shadow-sm shadow-ink/5 ${className}`}>
        <Blobatar name={handle} size={38} animate="always" className="shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium tabular-nums text-accent-ink">{price}</span>
      </span>
    );
  }
  const sm = size === 'sm';
  return (
    <span className={`inline-flex items-center rounded-2xl border border-ink/10 bg-white shadow-sm shadow-ink/5 ${sm ? 'gap-2.5 py-1.5 pr-3.5 pl-1.5' : 'gap-3.5 py-2.5 pr-5 pl-2.5'} ${dim ? 'opacity-55' : ''} ${className}`}>
      <Blobatar name={handle} size={sm ? 32 : 50} animate="always" className="shrink-0" aria-hidden="true" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={`truncate font-medium ${sm ? 'text-sm' : 'text-lg'}`}>{handle}</span>
        <span className={`tabular-nums text-accent-ink ${sm ? 'text-xs' : 'text-sm'}`}>{price} USDC</span>
      </span>
    </span>
  );
}
