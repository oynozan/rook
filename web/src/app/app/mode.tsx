'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { NETWORK } from './network';
import type { Mode } from './orchestrator';

const ModeContext = createContext<Mode | null>(null);

/** Which market and ledger the services run with, read once by the layout. Null when the services aren't reachable. */
export function ModeProvider({ mode, children }: { mode: Mode | null; children: ReactNode }) {
  return <ModeContext.Provider value={mode}>{children}</ModeContext.Provider>;
}

export function useMode() {
  const mode = useContext(ModeContext);
  return {
    mode,
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
