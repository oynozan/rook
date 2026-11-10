'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { NETWORK } from '@/lib/network';
import type { Mode } from '@/lib/server/orchestrator';

const ModeContext = createContext<{ mode: Mode | null; down: string | null }>({ mode: null, down: null });

/**
 * Which market and ledger the services run with, read once by the layout. Null when the services aren't reachable;
 * `down` then says why, as a clause (orchestrator.ts whyUnreachable).
 */
export function ModeProvider({ mode, down, children }: { mode: Mode | null; down: string | null; children: ReactNode }) {
  return <ModeContext.Provider value={{ mode, down }}>{children}</ModeContext.Provider>;
}

export function useMode() {
  const { mode, down } = useContext(ModeContext);
  return {
    mode,
    /** Why the layout couldn't read the task list or the mode, or null. */
    down,
    live: mode?.market === 'live',
    // On the live market Rook can only pay agents through the budget contract (ROOK_LEDGER=chain).
    paymentsOff: mode?.market === 'live' && !mode.paying,
    // Any simulated part (market, ledger or model) makes the whole run a simulation (SHARED API DECISION 2).
    simulated: !!mode && (mode.simulated ?? (mode.market === 'sim' || mode.ledger === 'sim' || mode.llm === 'canned')),
    // No money moves at all: the in-memory ledger stands in for the contract.
    noMoney: mode?.ledger === 'sim',
    // Chain mode: approving returns a funding transfer for the wallet instead of starting the run.
    chain: mode?.ledger === 'chain',
    // The chain's network; 'sim' (no chain) and older orchestrators fall back to the wallet's network.
    network: mode?.network === 'mainnet' || mode?.network === 'testnet' ? mode.network : NETWORK,
  };
}
