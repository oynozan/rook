// The owner's side of the agent wallet (docs/agent-wallet-plan.md, "Setup"): Rook generates each owner intent, the
// user's wallet signs it in the browser, Rook submits it and follows its status; GET /wallet shows where the wallet is.
// The browser never sees the API key or the grant token (references/owner-intents.md, BFF split).
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../shared/config.ts';
import { HttpError } from '../shared/http.ts';
import { SpendingRules, type AgentWalletView, type OwnerIntentView, type WalletFunding } from '../shared/types.ts';
import { AgentApiError, settle, USDC_ASSET, type AgentApi, type IntentType, type StatusResponse } from './api.ts';
import { policyFor } from './policy.ts';
import type { IssuedIntent, WalletRecord, WalletStore } from './store.ts';

export const IntentBody = z.object({
  owner: z.string().min(2).max(64),
  type: z.enum(['agent_create', 'policy_update', 'grant_issue', 'approval_vote']),
  rules: SpendingRules.optional(),
  public_key: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'public_key must be an ed25519 key of your NEAR account').optional(),
  approval_id: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/).optional(),
  verdict: z.enum(['approve', 'reject']).optional(),
});

/** What a task's funding needs to know of the owner's tasks (index.ts passes its task map). */
type TaskLike = { id: string; owner: string | null; wallet_funding?: WalletFunding | null; events: { ts: string; type: string; data: any }[] };

/** Rook's grant lasts this many days unless the rules say otherwise. */
const GRANT_DAYS = 30;

/**
 * An Agent API refusal in words the web app shows as they are, with the code for the record. A refusal of Rook's own
 * key or an outage is Rook's problem (502); anything else is about this wallet or request (409).
 */
export function refusal(e: unknown): HttpError {
  if (!(e instanceof AgentApiError)) return e instanceof HttpError ? e : new HttpError(502, `agent wallet: ${(e as any)?.message ?? e}`);
  const after = e.available_at ? ` Try again after ${e.available_at}.` : '';
  const said: Record<string, string> = {
    intent_expired: 'This signature request expired. Start this step again.',
    owner_nonce_invalid: 'This signature request was already used or expired. Start this step again.',
    owner_command_stale: 'Your wallet changed since this was prepared. Start this step again.',
    signer_mismatch: 'This was signed by another account or key. Sign with the account you are signed in with.',
    signature_invalid: "Your wallet's signature could not be read. Try signing again.",
    owner_key_not_full_access: 'Your wallet signed with a key that can only call contracts. Sign with a full-access key.',
    policy_change_throttled: `Your agent wallet's rules changed a moment ago.${after || ' Try again in a few minutes.'}`,
    policy_reconciliation_required: 'Another change to your agent wallet is still being applied. Try again in a minute.',
    policy_revision_conflict: "Your agent wallet's rules changed since this was prepared. Start this step again.",
    agent_not_bound: 'Your agent wallet is still being created. Try again in a minute.',
    approval_closed: 'This spend was already decided or expired.',
    authorization_stale: "This spend can't be approved any more: Rook's permission or your wallet's rules changed since. Fund the task again if you still want it.",
    agent_creation_quota_exceeded: `Too many agent wallets were created today.${after}`,
    wallet_frozen: 'Your agent wallet is frozen, so it spends nothing.',
    spend_budget_exceeded: "This spend would go over your agent wallet's budget.",
    policy_transaction_limit_exceeded: "This spend is above your agent wallet's limit per task.",
    policy_limit_exceeded: "This spend would go over one of your agent wallet's limits.",
    insufficient_balance: "Your agent wallet doesn't hold enough USDC for this.",
    agent_grant_required: "Rook's permission to spend from your agent wallet expired or was revoked. Give it again in the wallet setup.",
    policy_not_ready: "Your agent wallet's rules are still being applied. Try again in a minute.",
    policy_destination_denied: "Your agent wallet's rules don't allow this destination yet. Finish the wallet setup first.",
  };
  const message = said[e.code] ?? `The agent wallet service refused this: ${e.detail ?? e.title} (${e.code}).`;
  const ours = e.layer === 'auth' || e.code === 'not_configured' || e.code === 'unreachable' || e.status >= 500;
  return new HttpError(ours ? 502 : 409, message, { code: e.code, ...(e.request_id ? { request_id: e.request_id } : {}) });
}

export type Wallets = ReturnType<typeof createWallets>;

/**
 * `nativeBalance`: the USDC on a NEAR account (the chain-gateway's /balance), or null when it can't be read. `settleMs`:
 * how long a submit waits for its intent to settle before answering (the view checks again later); `gapMs`: the
 * pause between status reads that return at once.
 */
export function createWallets(d: {
  api: AgentApi; store: WalletStore; tasks: () => Iterable<TaskLike>; nativeBalance: (account: string) => Promise<string | null>;
  settleMs: number; gapMs: number;
}) {
  const configured = () => !!config.agentApiKey;

  /** Applies a settled status of `i` to its owner's record: the setup moves one step on each success. */
  async function apply(i: IssuedIntent, s: StatusResponse) {
    if (s.status === 'SUCCESS') {
      let near: string | null = null;
      const agentId = i.type === 'agent_create' ? String(s.details?.agent_id ?? i.agent_id) : i.agent_id;
      if (i.type === 'agent_create') near = (await d.api.wallet(agentId)).near_account_id; // read before the record changes
      d.store.update(i.owner, (r) => {
        const x = r.intents.find((y) => y.correlation_id === i.correlation_id)!;
        x.state = 'done';
        if (i.type === 'agent_create') Object.assign(r, { agent_id: agentId, near_account_id: near, rules: i.rules ?? {}, step: 'allow_destination' });
        if (i.type === 'policy_update') {
          if (i.rules) r.rules = i.rules;
          if (r.step === 'allow_destination') r.step = 'issue_grant';
        }
        if (i.type === 'grant_issue') {
          const grant_id = s.details?.grant?.grant_id;
          if (typeof grant_id === 'string' && x.grant_token) r.grant = { grant_id, token: x.grant_token, expires_at: x.grant_expires_at! };
          if (r.step === 'issue_grant' || r.step === 'ready') r.step = r.grant ? 'ready' : r.step;
          delete x.grant_token; // kept only in r.grant from here
        }
      });
    } else if (['FAILED', 'REFUNDED', 'NEEDS_REVIEW'].includes(s.status)) {
      d.store.update(i.owner, (r) => {
        const x = r.intents.find((y) => y.correlation_id === i.correlation_id)!;
        Object.assign(x, { state: 'failed', error: s.failure_code ?? s.details?.reason ?? s.status });
        delete x.grant_token; // a grant never issued needs no token
      });
    }
  }

  /** Checks the owner's submitted intents once more (a submit answers before a slow one settles). */
  async function catchUp(owner: string) {
    for (const i of d.store.get(owner)?.intents.filter((x) => x.state === 'submitted') ?? []) {
      try { await apply(i, await d.api.status(i.correlation_id)); } catch (e) { console.error('[wallet] status of an owner intent', (e as Error).message); }
    }
  }

  const ownTasks = (owner: string) => [...d.tasks()].filter((t) => t.owner === owner && t.wallet_funding);

  /** GET /wallet: what the web app shows. Reads the API live; a read that fails leaves its part empty. */
  async function view(owner: string): Promise<AgentWalletView> {
    const empty: AgentWalletView = {
      configured: configured(), owner, agent_id: null, near_account_id: null, status: 'none', next_step: null, rules: null, policy: null,
      balance_atomic: null, native_balance_atomic: null, budget: null, grant: null, pending_approvals: [],
    };
    if (!configured()) return empty;
    await catchUp(owner);
    const r = d.store.get(owner);
    if (!r?.agent_id) return { ...empty, rules: r?.rules ?? null };
    const id = r.agent_id;
    const [agent, policy, balances, approvals, native] = await Promise.allSettled([
      d.api.agent(id), d.api.policy(id), d.api.balances(id, USDC_ASSET), d.api.approvals(id),
      r.near_account_id ? d.nativeBalance(r.near_account_id) : Promise.resolve(null),
    ]);
    const ok = <T>(x: PromiseSettledResult<T>) => (x.status === 'fulfilled' ? x.value : null);
    for (const x of [agent, policy, balances, approvals, native]) if (x.status === 'rejected') console.error('[wallet] read', (x.reason as Error)?.message);
    const a = ok(agent), p = ok(policy);
    // An unreadable agent was created (agent_create succeeded), so it shows as active; archived or deleted as none.
    const status = a?.status === 'PENDING' ? 'pending' : !a || a.status === 'ACTIVE' ? (p?.policy?.frozen ? 'frozen' : 'active') : 'none';
    const usdc = ok(balances)?.balances.find((b) => b.asset_id === USDC_ASSET);
    const period = r.rules?.budget_usd !== undefined ? r.rules.period ?? 'month' : null;
    const w = period && p ? p.usage.budget[({ day: 'daily', week: 'weekly', month: 'monthly' } as const)[period]] : null;
    const tasks = ownTasks(owner);
    return {
      ...empty, agent_id: id, near_account_id: r.near_account_id, status, next_step: r.step, rules: r.rules, policy: p?.policy ?? null,
      balance_atomic: usdc ? usdc.available_raw : ok(balances) ? '0' : null,
      native_balance_atomic: ok(native),
      budget: period && w?.limit_usd != null
        ? { period, limit_usd: Number(w.limit_usd), spent_usd: Number(w.spent_usd ?? 0), remaining_usd: Number(w.remaining_usd ?? w.limit_usd), resets_at: w.resets_at }
        : null,
      grant: r.grant && { grant_id: r.grant.grant_id, expires_at: r.grant.expires_at },
      pending_approvals: (ok(approvals)?.data ?? []).filter((x) => x.status === 'PENDING').map((x) => {
        const t = tasks.find((y) => y.wallet_funding?.approval_id === x.approval_id);
        const asked = t?.events.find((e) => e.type === 'ledger' && e.data?.op === 'wallet_approval_needed' && e.data.approval_id === x.approval_id);
        const amount = typeof x.request_data?.amount === 'string' && /^\d+$/.test(x.request_data.amount) ? x.request_data.amount : t?.wallet_funding?.amount_atomic ?? '0';
        return { approval_id: x.approval_id, task_id: t?.id ?? null, amount_atomic: amount, created_at: asked?.ts ?? '', expires_at: x.expires_at ?? null };
      }),
    };
  }

  /** POST /wallet/intents: generates one owner intent, keeps it, and answers what the user's wallet signs. */
  async function generate(b: z.infer<typeof IntentBody>): Promise<OwnerIntentView> {
    if (!configured()) throw new HttpError(409, "Rook's agent wallet isn't set up on this server.");
    const r = d.store.get(b.owner);
    const need = (ok: unknown, message: string) => { if (!ok) throw new HttpError(409, message); };
    let body: Record<string, unknown>;
    const extra: Partial<IssuedIntent> = {};
    if (b.type === 'agent_create') {
      need(!r?.agent_id, 'You already have an agent wallet.');
      if (!b.public_key) throw new HttpError(400, 'public_key is required: the full-access key your wallet signs with');
      const rules = b.rules ?? {};
      extra.rules = rules;
      body = {
        type: 'agent_create', name: `Rook wallet of ${b.owner}`.slice(0, 100), external_user_id: b.owner,
        owner: { type: 'near', account_id: b.owner, public_key: b.public_key }, policy: policyFor(rules, null),
      };
    } else {
      need(r?.agent_id, 'Create your agent wallet first.');
      const agent_id = r!.agent_id!;
      if (b.type === 'policy_update') {
        need(r!.near_account_id, 'Your agent wallet has no NEAR account yet. Try again in a minute.');
        const view = await d.api.policy(agent_id).catch((e) => { throw refusal(e); });
        need(view.status === 'APPLIED', "Your agent wallet's current rules are still being applied. Try again in a minute.");
        const rules = b.rules ?? r!.rules ?? {};
        if (b.rules) extra.rules = b.rules;
        body = { type: 'policy_update', agent_id, policy: policyFor(rules, r!.near_account_id), expected_revision: view.revision ?? 0 };
      } else if (b.type === 'grant_issue') {
        need(r!.step === 'issue_grant' || r!.step === 'ready', 'Allow the withdrawal to your agent wallet\'s own account first.');
        // The token is Rook's; the owner signs only its SHA-256 (references/grants.md). Kept before the owner signs.
        const token = `ngt_${randomBytes(32).toString('base64url')}`;
        const days = r!.rules?.expires_days ?? GRANT_DAYS;
        extra.grant_token = token;
        extra.grant_expires_at = new Date(Date.now() + days * 86_400_000).toISOString();
        body = { type: 'grant_issue', agent_id, label: 'Rook', credential: createHash('sha256').update(token).digest('hex'), expires_at: extra.grant_expires_at };
      } else {
        if (!b.approval_id || !b.verdict) throw new HttpError(400, 'approval_id and verdict are required');
        extra.approval_id = b.approval_id;
        body = { type: 'approval_vote', agent_id, approval_id: b.approval_id, verdict: b.verdict };
      }
    }
    const g = await d.api.generateIntent(body).catch((e) => { throw refusal(e); });
    // The API names who must sign: never anyone but the signed-in account.
    if (g.signer?.type !== 'near' || g.signer.account_id !== b.owner) throw new HttpError(409, `This wallet is owned by another account, not ${b.owner}.`);
    d.store.update(b.owner, (rec) => rec.intents.push({
      correlation_id: g.correlation_id, type: b.type as IntentType, owner: b.owner, created_at: new Date().toISOString(), expires_at: g.expires_at,
      agent_id: g.agent_id, intent: g.intent, state: 'issued', ...extra,
    }));
    return {
      correlation_id: g.correlation_id, type: b.type, intent: { standard: g.intent.standard as 'nep366' | 'nep413', payload: g.intent.payload },
      summary: g.preview?.summary ?? '', ...(g.preview?.policy !== undefined ? { policy: g.preview.policy } : {}), expires_at: g.expires_at,
    };
  }

  /**
   * POST /wallet/intents/:cid/submit: only an intent Rook issued to this owner. The signed data is the stored intent
   * with the wallet's output fields only, so the browser cannot swap the payload.
   */
  async function submit(owner: string, cid: string, signed: any): Promise<AgentWalletView> {
    const i = d.store.intent(owner, cid);
    if (!i) throw new HttpError(404, `no signature request ${cid}`);
    if (i.state === 'done' || i.state === 'failed') throw new HttpError(409, i.state === 'done' ? 'This was signed and applied already.' : 'This request failed. Start this step again.');
    const s = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 50_000 ? v : null);
    let output: Record<string, string>;
    if (i.intent.standard === 'nep366' && s(signed?.signed_delegate)) output = { signed_delegate: signed.signed_delegate };
    else if (i.intent.standard === 'nep413' && s(signed?.public_key) && s(signed?.signature)) output = { public_key: signed.public_key, signature: signed.signature };
    else throw new HttpError(400, `signed_data must carry your wallet's ${i.intent.standard === 'nep366' ? 'signed_delegate' : 'public_key and signature'}`);
    try {
      await d.api.submitIntent({ type: i.type, correlation_id: cid, signed_data: { ...i.intent, ...output } });
    } catch (e) {
      if (e instanceof AgentApiError && ['intent_expired', 'owner_nonce_invalid'].includes(e.code)) {
        d.store.update(owner, (r) => { const x = r.intents.find((y) => y.correlation_id === cid)!; Object.assign(x, { state: 'failed', error: e.code }); delete x.grant_token; });
      }
      throw refusal(e);
    }
    d.store.update(owner, (r) => { r.intents.find((y) => y.correlation_id === cid)!.state = 'submitted'; });
    const st = await settle(d.api, cid, { deadlineMs: d.settleMs, gapMs: d.gapMs }).catch((e) => { throw refusal(e); });
    await apply(i, st);
    if (['FAILED', 'REFUNDED', 'NEEDS_REVIEW'].includes(st.status)) {
      throw new HttpError(409, `Your agent wallet didn't apply this (${st.failure_code ?? st.status}). Start this step again.`, { code: st.failure_code });
    }
    return view(owner);
  }

  /** The owner's wallet when it can fund a task: set up, with a live grant. */
  function ready(owner: string): (WalletRecord & { agent_id: string; near_account_id: string; grant: NonNullable<WalletRecord['grant']> }) | null {
    const r = d.store.get(owner);
    if (!r || r.step !== 'ready' || !r.agent_id || !r.near_account_id || !r.grant || Date.parse(r.grant.expires_at) <= Date.now()) return null;
    return r as any;
  }

  /** Owners whose wallet is set up: the sweep looks at these. */
  const owners = () => d.store.all().filter((r) => r.step === 'ready').map((r) => r.owner);

  return { configured, view, generate, submit, ready, owners };
}
