'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Mode } from './orchestrator';

const ModeContext = createContext<Mode | null>(null);

/** Which market and ledger the services run with, read once by the layout. Null when the services aren't reachable. */
export function ModeProvider({ mode, children }: { mode: Mode | null; children: ReactNode }) {
  return <ModeContext.Provider value={mode}>{children}</ModeContext.Provider>;
}

export function useMode() {
  const mode = useContext(ModeContext);
  return {
    live: mode?.market === 'live',
    // On the live market Rook can only pay agents through the budget contract (ROOK_LEDGER=chain).
    paymentsOff: mode?.market === 'live' && !mode.paying,
  };
}
