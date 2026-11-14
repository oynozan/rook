// Agent wallets per owner (the signed-in NEAR account), with their setup step, Rook's grant and the owner intents Rook
// issued (docs/agent-wallet-plan.md). In memory; with ROOK_DB set, every change is also written to the orchestrator's
// SQLite file (db.ts) and reloaded on start, like tasks. The grant token is a secret: viewOf never returns it.
import type { SpendingRules, WalletSetupStep } from '../shared/types.ts';
import type { Intent, IntentType } from './api.ts';

/**
 * An owner intent Rook generated for `owner`. A submit is accepted only for one of these, by its owner, and the signed
 * data is rebuilt from the stored `intent` (the browser sends only the wallet's output). `grant_token`: the token whose
 * hash a grant_issue commits to, kept from before the owner signs (references/grants.md). `rules`: what an
 * agent_create or policy_update sets once it succeeds. `pending_agent_id`: the agent an agent_create reserved.
 */
export type IssuedIntent = {
  correlation_id: string; type: IntentType; owner: string; created_at: string; expires_at: string;
  agent_id: string; intent: Intent; state: 'issued' | 'submitted' | 'done' | 'failed'; error?: string;
  rules?: SpendingRules; grant_token?: string; grant_expires_at?: string; approval_id?: string;
};

export type WalletRecord = {
  owner: string;
  agent_id: string | null; // set once agent_create succeeded
  near_account_id: string | null;
  rules: SpendingRules | null;
  step: WalletSetupStep | null; // null: no wallet yet
  grant: { grant_id: string; token: string; expires_at: string } | null; // token: secret, server side only
  intents: IssuedIntent[]; // newest last
  updated_at: string;
  /** Wallets the API stopped knowing (another API key, or deleted), kept for the record; their grant tokens dropped. */
  previous?: { agent_id: string; near_account_id: string | null; grant_id: string | null; set_aside_at: string }[];
};

/** Persistence for wallet records (db.ts): the whole record as one document per owner. */
export type WalletPersist = { loadWallets(): WalletRecord[]; saveWallet(r: WalletRecord): void };

/** Intents kept per owner: enough for a setup and a few approvals; older settled ones are dropped. */
const KEEP_INTENTS = 20;

export type WalletStore = ReturnType<typeof createWalletStore>;

export function createWalletStore(persist: WalletPersist | null = null) {
  const byOwner = new Map<string, WalletRecord>();
  for (const r of persist?.loadWallets() ?? []) byOwner.set(r.owner, r);
  const save = (r: WalletRecord) => {
    r.updated_at = new Date().toISOString();
    if (r.intents.length > KEEP_INTENTS) {
      const open = (i: IssuedIntent) => i.state === 'issued' || i.state === 'submitted';
      const settled = r.intents.filter((i) => !open(i));
      const drop = new Set(settled.slice(0, Math.max(0, r.intents.length - KEEP_INTENTS)));
      r.intents = r.intents.filter((i) => !drop.has(i));
    }
    persist?.saveWallet(r);
  };
  return {
    get: (owner: string): WalletRecord | null => byOwner.get(owner) ?? null,
    all: () => [...byOwner.values()],
    /** The owner's record, made empty when there is none yet, changed by `fn` and saved. */
    update<T>(owner: string, fn: (r: WalletRecord) => T): T {
      let r = byOwner.get(owner);
      if (!r) byOwner.set(owner, (r = { owner, agent_id: null, near_account_id: null, rules: null, step: null, grant: null, intents: [], updated_at: '' }));
      const out = fn(r);
      save(r);
      return out;
    },
    /** The intent `cid` if Rook issued it to `owner`; null for an unknown one and for another owner's alike. */
    intent(owner: string, cid: string): IssuedIntent | null {
      return byOwner.get(owner)?.intents.find((i) => i.correlation_id === cid) ?? null;
    },
  };
}
