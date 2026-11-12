'use client';

// The signed-in account's agent wallet (docs/agent-wallet-plan.md), shared by the plan card, the run and the wallet
// panel: one reading of GET /api/wallet, and the one way an owner intent gets signed (prepare, show, sign, submit).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { nep366Request, nep413Request, signedNep366, signedNep413 } from '@/lib/agent-wallet';
import type { AgentWalletView, OwnerIntentView, SpendingRules } from '@/lib/server/orchestrator';
import { useWallet } from '@/hooks/wallet';

/** A route's refusal, in the sentence it gave. `retry`: asking again may work. */
export class WalletStepError extends Error {
  retry: boolean;
  constructor(message: string, retry = false) { super(message); this.retry = retry; }
}

/** The plan a wallet is being set up from: its spending rules become the wallet's policy. */
export type SetupFrom = { task_id: string; rules: SpendingRules };

type Ask =
  | { type: 'agent_create'; task_id: string }
  | { type: 'policy_update' | 'grant_issue' }
  | { type: 'approval_vote'; approval_id: string; verdict: 'approve' | 'reject' };

export type AgentWallet = {
  /** null while it loads, or signed out. configured false: the page shows nothing of the wallet. */
  view: AgentWalletView | null;
  refresh: () => Promise<void>;
  panel: { open: boolean; from: SetupFrom | null };
  openPanel: (from?: SetupFrom) => void;
  closePanel: () => void;
  /** Asks Rook for one owner intent; nothing is signed yet. Throws WalletStepError. */
  prepare: (ask: Ask) => Promise<OwnerIntentView>;
  /** Opens the wallet on the intent, and passes the signature on. Answers with the wallet as it is now. */
  sign: (intent: OwnerIntentView) => Promise<AgentWalletView>;
  /** A vote on a pending spend, signed in place: the button that asks it is what the owner reviewed. */
  vote: (approval_id: string, verdict: 'approve' | 'reject') => Promise<void>;
};

const AgentWalletContext = createContext<AgentWallet | null>(null);

export function useAgentWallet() {
  const w = useContext(AgentWalletContext);
  if (!w) throw new Error('useAgentWallet needs an AgentWalletProvider');
  return w;
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new WalletStepError(typeof data?.error === 'string' ? data.error : `Rook's web server answered HTTP ${r.status}; its log says why.`, data?.retry === true);
  return data as T;
}

const POLL_MS = 8_000;

export function AgentWalletProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const account = wallet.account;
  const [view, setView] = useState<AgentWalletView | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; from: SetupFrom | null }>({ open: false, from: null });
  const asked = useRef(0); // only the latest reading counts

  const refresh = useCallback(async () => {
    const n = ++asked.current;
    if (!account) { setView(null); return; }
    // A reading that fails keeps the last one: the panel says why on its own actions, and the next poll tries again.
    const v = await call<AgentWalletView>('/api/wallet').catch(() => null);
    if (v && n === asked.current && v.owner === account) setView(v);
  }, [account]);

  useEffect(() => { setView(null); void refresh(); }, [refresh]);

  // Watched while something can change without this page: the panel is open, the wallet is being created on NEAR, a
  // spend waits for a vote. Otherwise read again when the tab comes back.
  const watch = panel.open || view?.status === 'pending' || !!view?.pending_approvals.length;
  useEffect(() => {
    if (!watch) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [watch, refresh]);
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [refresh]);

  const value = useMemo<AgentWallet>(() => {
    async function prepare(ask: Ask): Promise<OwnerIntentView> {
      if (ask.type !== 'agent_create') return call<OwnerIntentView>('/api/wallet/intents', ask);
      // The agent wallet names the owner's key; the route checks it is a full-access key of the signed-in account.
      // A wallet that doesn't tell its key shows it by signing a message, which moves nothing.
      let key = await wallet.publicKey();
      if (!key) {
        const nonce = crypto.getRandomValues(new Uint8Array(32));
        key = (await wallet.signMessage({ message: 'Show Rook the key that will own your agent wallet', recipient: 'rook.agent-wallet', nonce })).publicKey;
      }
      return call<OwnerIntentView>('/api/wallet/intents', { ...ask, public_key: key });
    }
    async function sign(intent: OwnerIntentView): Promise<AgentWalletView> {
      const i = intent.intent;
      let signed_data: object;
      if (i.standard === 'nep413') signed_data = signedNep413(i, await wallet.signMessage(nep413Request(i.payload)));
      else if (i.standard === 'nep366') signed_data = signedNep366(i, await wallet.signDelegateActions([nep366Request(i.payload)]));
      else throw new WalletStepError(`Rook can't sign a ${String(i.standard)} intent with a NEAR wallet.`);
      const v = await call<AgentWalletView>(`/api/wallet/intents/${encodeURIComponent(intent.correlation_id)}/submit`, { signed_data });
      setView(v);
      return v;
    }
    return {
      view, refresh, panel,
      openPanel: (from) => setPanel({ open: true, from: from ?? null }),
      closePanel: () => setPanel((p) => ({ ...p, open: false })),
      prepare, sign,
      async vote(approval_id, verdict) {
        await sign(await prepare({ type: 'approval_vote', approval_id, verdict }));
        await refresh();
      },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, refresh, panel, account]);

  return <AgentWalletContext.Provider value={value}>{children}</AgentWalletContext.Provider>;
}

