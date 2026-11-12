// The agent wallet (docs/agent-wallet-plan.md) as the page shows it: spending rules from the chat in plain words, the
// policy they become, where the one-time setup is, a task's funding from the wallet, and the signatures the owner's
// NEAR wallet makes for it. Pure functions with no Next.js or Node imports, so the browser, the routes and the tests
// all use them.
import { detail } from '@/lib/errors';
import { parseBudget } from '@/lib/draft';
import { GAS_100_TGAS, plainReason, usdc } from '@/lib/funding';
import type {
  AgentWalletView, OwnerIntentType, OwnerIntentView, PendingApproval, PlanView, SpendingRules, WalletFunding, WalletSetupStep,
} from '@/lib/server/orchestrator';

/** NEAR Intents: a deposit is an ft_transfer_call to it, with the account to credit as the msg. */
export const INTENTS_CONTRACT = 'intents.near';
/** Native USDC on NEAR mainnet (the Agent API is mainnet only): nep141:<this> in its token list. */
export const USDC_MAINNET = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

const PER = { day: 'a day', week: 'a week', month: 'a month' } as const;
const THIS = { day: 'today', week: 'this week', month: 'this month' } as const;
const FIELD = { day: 'daily_usd', week: 'weekly_usd', month: 'monthly_usd' } as const;
/** 1000 -> "1,000", 2.5 -> "2.50": whole amounts plain, cents with both digits. */
const money = (n: number) => n.toLocaleString('en-US', Number.isInteger(n) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const daysText = (n: number) => (n === 1 ? '1 day' : `${n} days`);
/** USD (two decimals at most) to atomic USDC: the page counts 1 USDC as 1 USD, as the plan does. */
const atomicOf = (usd: number) => BigInt(Math.round(usd * 100)) * 10_000n;

// ---- spending rules ----

const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : undefined);

/**
 * The rules as the services' SpendingRules schema allows them (services/src/shared/types.ts), anything else dropped;
 * null when none is left. A plan's `spending` passes through here before the page words it or a route sends it on.
 */
export function cleanRules(raw: unknown): SpendingRules | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: SpendingRules = {};
  const budget = num(r.budget_usd, 1_000_000);
  if (budget) out.budget_usd = budget;
  if (r.period === 'day' || r.period === 'week' || r.period === 'month') out.period = r.period;
  const perTask = num(r.per_task_max_usd, 1_000_000);
  if (perTask) out.per_task_max_usd = perTask;
  if (r.approval === 'every' || r.approval === 'none') out.approval = r.approval;
  const days = num(r.expires_days, 365);
  if (days && Number.isInteger(days)) out.expires_days = days;
  return Object.keys(out).length ? out : null;
}

/** "Only spend $1000" is a monthly budget: the Agent API's USD budget has no lifetime total. */
const periodOf = (r: SpendingRules) => r.period ?? 'month';

/**
 * The rules in Rook's words, as the plan card and the wallet panel say them: "Rook may spend up to 1,000 USDC a month
 * from your agent wallet. Every spend waits for your approval."
 */
export function rulesSentence(r: SpendingRules): string {
  const out = [r.budget_usd
    ? `Rook may spend up to ${money(r.budget_usd)} USDC ${PER[periodOf(r)]} from your agent wallet.`
    : 'Rook may spend what your agent wallet holds, with no budget per period.'];
  if (r.per_task_max_usd) out.push(`No task gets more than ${money(r.per_task_max_usd)} USDC.`);
  if (r.approval === 'every') out.push('Every spend waits for your approval.');
  else out.push('Spends within these limits go ahead without asking you.');
  if (r.expires_days) out.push(`Rook's permission to spend ends after ${daysText(r.expires_days)}.`);
  return out.join(' ');
}

export type PolicyLine = { text: string; field: string };

/**
 * What each rule becomes in the wallet's policy (docs/agent-wallet-plan.md, "Spending rules from the chat"): a plain
 * line, and the policy field it sets. The policy as the wallet gets it is shown again, whole, before the owner signs.
 */
export function policyLines(r: SpendingRules): PolicyLine[] {
  const lines: PolicyLine[] = [
    { text: "Only USDC, only withdrawn to the wallet's own NEAR account, which funds Rook's contract", field: 'actions [withdraw], destinations only its own account' },
  ];
  if (r.budget_usd) lines.push({ text: `At most ${money(r.budget_usd)} USD ${PER[periodOf(r)]}`, field: `budget.${FIELD[periodOf(r)]} ${r.budget_usd}` });
  if (r.per_task_max_usd) lines.push({ text: `At most ${money(r.per_task_max_usd)} USDC per task`, field: `limits.per_transaction ${usdc(atomicOf(r.per_task_max_usd))} USDC` });
  lines.push(r.approval === 'every'
    ? { text: 'Your vote on every spend', field: 'owner_approval true' }
    : { text: 'No vote within these limits', field: 'owner_approval false' });
  if (r.expires_days) lines.push({ text: `Rook's spending key ends after ${daysText(r.expires_days)}`, field: 'grant expires_at' });
  return lines;
}

const RULE_KEYS = ['budget_usd', 'period', 'per_task_max_usd', 'approval', 'expires_days'] as const;

/** The same rules, with a missing period read as a month and a missing approval as none, as the policy reads them. */
export function sameRules(a: SpendingRules | null, b: SpendingRules | null): boolean {
  const norm = (r: SpendingRules | null) => r && { ...r, period: r.budget_usd ? periodOf(r) : undefined, approval: r.approval ?? 'none' };
  const x = norm(a), y = norm(b);
  if (!x || !y) return !x && !y;
  return RULE_KEYS.every((k) => x[k] === y[k]);
}

/** A plan's spending rules, checked, or null when it states none. */
export const planRules = (plan: Pick<PlanView, 'spending'> | null | undefined) => cleanRules(plan?.spending);

// ---- the wallet ----

/** The setup, in order: each step is one signature by the owner. */
export const SETUP: { step: Exclude<WalletSetupStep, 'ready'>; type: OwnerIntentType; label: string }[] = [
  { step: 'create', type: 'agent_create', label: 'Create your agent wallet' },
  { step: 'allow_destination', type: 'policy_update', label: 'Allow Rook to fund tasks from it' },
  { step: 'issue_grant', type: 'grant_issue', label: 'Give Rook its spending key' },
];

export type SetupStepView = (typeof SETUP)[number] & { state: 'done' | 'current' | 'todo' };

/** Where each setup step is. No wallet yet (next_step null) starts at 'create'; 'ready' has every step done. */
export function setupSteps(view: Pick<AgentWalletView, 'next_step'>): SetupStepView[] {
  const next = view.next_step ?? 'create';
  const at = next === 'ready' ? SETUP.length : SETUP.findIndex((s) => s.step === next);
  return SETUP.map((s, i) => ({ ...s, state: i < at ? 'done' : i === at ? 'current' : 'todo' }));
}

/** The wallet is set up and Rook holds its key: tasks can be funded from it. */
export const walletReady = (v: AgentWalletView | null) => !!v?.configured && v.status === 'active' && v.next_step === 'ready';

const atomic = (s: string | null | undefined) => (typeof s === 'string' && /^\d+$/.test(s) ? BigInt(s) : 0n);

/**
 * Whether a plan of `budget_atomic` can be funded from the agent wallet now. `why`: a sentence for a wallet that is set
 * up but can't cover it (shown in place of the button, never a dead button); null when the wallet isn't set up, or the
 * services have none, so the page shows nothing of it.
 */
export function walletFundable(v: AgentWalletView | null, budget_atomic: string): { ok: true } | { ok: false; why: string | null } {
  if (!walletReady(v)) {
    return { ok: false, why: v?.configured && v.status === 'frozen' ? 'Your agent wallet is frozen, so Rook can\'t fund tasks from it.' : null };
  }
  const need = atomic(budget_atomic);
  const rules = v!.rules ?? {};
  if (rules.per_task_max_usd && need > atomicOf(rules.per_task_max_usd)) {
    return { ok: false, why: `This plan's ${usdc(need)} USDC is more than the ${money(rules.per_task_max_usd)} USDC your rules allow per task.` };
  }
  const b = v!.budget;
  if (b && atomicOf(Math.max(0, b.remaining_usd)) < need) {
    return { ok: false, why: `Your agent wallet has ${money(Math.max(0, b.remaining_usd))} USD of its budget left ${THIS[b.period]}; this plan needs ${usdc(need)} USDC.` };
  }
  const have = atomic(v!.balance_atomic);
  if (have < need) return { ok: false, why: `Your agent wallet holds ${usdc(have)} USDC; this plan needs ${usdc(need)} USDC. Deposit USDC to it first.` };
  return { ok: true };
}

/** "988.50 of 1,000 USD left this month." */
export const budgetLeftLine = (b: NonNullable<AgentWalletView['budget']>) =>
  `${money(Math.max(0, b.remaining_usd))} of ${money(b.limit_usd)} USD left ${THIS[b.period]}.`;

/** A pending approval in a line: what it spends, and the task it funds when the services name one. */
export const approvalLine = (a: PendingApproval) => `Spend ${usdc(a.amount_atomic)} USDC${a.task_id ? ' to fund a task' : ''}.`;

/**
 * The owner's deposit: USDC ft_transfer_call to NEAR Intents, crediting the agent wallet's account (the msg), 1 yocto.
 * NEAR Intents is registered on the USDC contract already, so no storage deposit comes first.
 */
export const depositTransaction = (token: string, wallet_account: string, amount_atomic: string) => ({
  receiverId: token,
  actions: [{
    type: 'FunctionCall' as const,
    params: { methodName: 'ft_transfer_call', args: { receiver_id: INTENTS_CONTRACT, amount: amount_atomic, msg: wallet_account }, gas: GAS_100_TGAS, deposit: '1' },
  }],
});

/** The amount typed for a deposit, in atomic USDC, or what to fix. */
export function parseDeposit(input: string): { ok: true; atomic: string } | { ok: false; error: string } {
  const b = parseBudget(input);
  if (b.ok) return { ok: true, atomic: b.atomic.toString() };
  return { ok: false, error: /decimals/.test(b.error) ? b.error : 'Enter an amount of USDC above 0, like 25.00.' };
}

/**
 * Why a deposit moved nothing, read from the wallet's outcome, or null when nothing says it failed (the wallet's
 * balance shows it within a minute). NEAR Intents refusing it sends the USDC back to the sender.
 */
export function depositProblem(outcome: unknown): string | null {
  const o = outcome as { status?: unknown; receipts_outcome?: { outcome?: { executor_id?: string; status?: unknown } }[] } | null;
  const failure = (status: unknown) => {
    const f = (status as { Failure?: unknown } | null)?.Failure;
    if (!f) return null;
    const exec = (f as any)?.ActionError?.kind?.FunctionCallError?.ExecutionError;
    return typeof exec === 'string' ? exec : JSON.stringify(f).slice(0, 300);
  };
  const top = failure(o?.status);
  if (top) return plainReason(top);
  for (const r of o?.receipts_outcome ?? []) {
    if (r.outcome?.executor_id === INTENTS_CONTRACT && failure(r.outcome.status)) return 'NEAR Intents turned the deposit down, so the USDC went back to your wallet';
  }
  return null;
}

// ---- a task funded from the wallet ----

export type WalletFundingLine = { text: string; tone: 'normal' | 'alert'; working: boolean; approval_id: string | null };

/** A task's funding from the agent wallet, in a line for the run's header. */
export function walletFundingLine(f: WalletFunding): WalletFundingLine {
  const a = `${usdc(f.amount_atomic)} USDC`;
  const line = (text: string, working: boolean, approval_id: string | null = null, tone: 'normal' | 'alert' = 'normal') => ({ text, tone, working, approval_id });
  switch (f.state) {
    case 'withdrawing': return line(`Withdrawing ${a} from your agent wallet.`, true);
    case 'awaiting_approval': return line(`Waiting for your approval to spend ${a} from your agent wallet.`, false, f.approval_id ?? null);
    case 'transferring': return line(`Sending the ${a} budget to Rook.`, true);
    case 'bound': return line(`Funded with ${a} from your agent wallet.`, false);
    default: return line(`Funding from your agent wallet stopped: ${walletReason(f.error ?? '')}.`, false, null, 'alert');
  }
}

/** Under way: the page waits on it, and offers no other funding meanwhile. */
export const walletFundingLive = (f: WalletFunding | null | undefined) => !!f && f.state !== 'bound' && f.state !== 'failed';

/**
 * Why the Agent API (or the services' funding step) refused, as a clause, from the error code its message carries
 * (references/errors.md). Anything else as it was said, made safe to show.
 */
export function walletReason(message: string): string {
  return knownWalletReason(message) ?? (detail(message) || 'no reason was given');
}

/** walletReason for a message that names a code (or a rejected or expired vote), else null. */
export function knownWalletReason(message: string): string | null {
  const m = String(message ?? '');
  if (/spend_budget_exceeded/.test(m)) return "your agent wallet's budget for this period is used up";
  if (/policy_transaction_limit_exceeded|policy_limit_exceeded/.test(m)) return 'it is more than your spending rules allow';
  if (/insufficient_balance/.test(m)) return "your agent wallet doesn't hold enough USDC";
  if (/wallet_frozen/.test(m)) return 'your agent wallet is frozen';
  if (/agent_grant_required|authorization_stale/.test(m)) return "Rook's spending key has ended or was revoked, or the wallet's rules changed since";
  if (/approval_closed|approval_already_voted/.test(m)) return 'this approval is already closed';
  if (/intent_expired|owner_nonce_invalid|owner_command_stale/.test(m)) return 'the signing window closed before the signature came back';
  if (/signer_mismatch|owner_proof_invalid|policy_delegate_signature_invalid|approval_signature_invalid/.test(m)) return "the signature isn't from the account's own key";
  if (/owner_key_not_full_access/.test(m)) return "your wallet signed with a limited key; the agent wallet needs one of the account's full-access keys";
  if (/policy_change_throttled|policy_reconciliation_required/.test(m)) return "the wallet's rules changed a few minutes ago, and the Agent API allows one change every few minutes";
  if (/sponsor_busy|sponsor_balance_insufficient|transaction_unconfirmed|provider_unavailable|rate_limited|database_busy/.test(m)) return 'the Agent API is busy right now';
  if (/agent_creation_quota_exceeded/.test(m)) return 'Rook has created as many agent wallets today as the Agent API allows';
  if (/\brejected\b|verdict reject/i.test(m)) return 'you turned the spend down';
  if (/\bexpired\b/.test(m)) return 'the approval expired before a vote came';
  return null;
}

/** Asking the same thing again may work: the API was busy, or the signing window closed. */
export const walletRetryable = (message: string) =>
  /sponsor_busy|sponsor_balance_insufficient|transaction_unconfirmed|provider_unavailable|rate_limited|database_busy|intent_expired|owner_nonce_invalid|owner_command_stale|approval_not_recorded/.test(message);

// ---- the run's activity feed ----

/** One of the services' wallet_* events as a line for the run's activity (null: not a wallet event). */
export function walletEventLine(type: string, data: { amount_atomic?: string; error?: string; message?: string } | null | undefined):
  { text: string; tone: 'normal' | 'muted' | 'alert'; label: string } | null {
  const amt = /^\d+$/.test(data?.amount_atomic ?? '') ? `${usdc(data!.amount_atomic!)} USDC` : null;
  switch (type) {
    case 'wallet_withdraw': return { text: `Withdrew ${amt ?? 'the budget'} from your agent wallet.`, tone: 'muted', label: 'Agent wallet' };
    // The feed is the run's history, read after the vote too: "asked", not "waiting".
    case 'wallet_approval_needed': return { text: `Asked for your approval to spend ${amt ?? 'the budget'} from your agent wallet.`, tone: 'muted', label: 'Needs your approval' };
    case 'wallet_transfer': return { text: `Sent ${amt ?? 'the budget'} from your agent wallet to the Rook contract.`, tone: 'muted', label: 'Agent wallet' };
    case 'wallet_bound': return { text: `Rook checked the ${amt ? `${amt} ` : ''}funding from your agent wallet against the plan, so the run starts.`, tone: 'muted', label: 'Funded' };
    case 'wallet_failed': return { text: `Funding from your agent wallet stopped: ${walletReason(data?.error ?? data?.message ?? '')}.`, tone: 'alert', label: 'Problem' };
    case 'wallet_swept': return { text: amt ? `${amt} unspent went back into your agent wallet.` : 'The unspent USDC went back into your agent wallet.', tone: 'muted', label: 'Returned' };
    default: return null;
  }
}

// ---- signing ----

export type OwnerIntent = OwnerIntentView['intent'];

/**
 * What the wallet's signMessage gets for a nep413 intent: the payload as generated, its base64 nonce as the 32 bytes
 * NEP-413 signs (references/owner-intents.md, "Browser signing"). Throws on a payload that isn't one.
 */
export function nep413Request(payload: unknown): { message: string; recipient: string; nonce: Uint8Array } & Record<string, unknown> {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p.message !== 'string' || typeof p.recipient !== 'string' || typeof p.nonce !== 'string') throw new Error('the intent to sign is not a NEP-413 message');
  let nonce: Uint8Array;
  try { nonce = Uint8Array.from(atob(p.nonce), (c) => c.charCodeAt(0)); } catch { throw new Error("the intent's nonce is not base64"); }
  if (nonce.length !== 32) throw new Error("the intent's nonce is not 32 bytes");
  return { ...p, message: p.message, recipient: p.recipient, nonce };
}

/** The signed_data for submit: the intent as generated, plus the wallet's NEP-413 public key and signature. */
export function signedNep413(intent: OwnerIntent, signed: { publicKey?: unknown; signature?: unknown }) {
  if (typeof signed?.publicKey !== 'string' || typeof signed.signature !== 'string') throw new Error('your wallet returned no signature');
  return { ...intent, public_key: signed.publicKey, signature: signed.signature };
}

/** The signed_data for submit: the intent as generated, plus the wallet's signed delegate (base64 borsh SignedDelegate). */
export function signedNep366(intent: OwnerIntent, signed: { signedDelegateActions?: unknown }) {
  const d = Array.isArray(signed?.signedDelegateActions) ? signed.signedDelegateActions[0] : null;
  if (typeof d !== 'string' || !d) throw new Error('your wallet returned no signed delegate action');
  return { ...intent, signed_delegate: d };
}

/** The delegate action a nep366 intent asks the wallet to sign, as near-connect's signDelegateActions takes it. */
export function nep366Request(payload: unknown): { receiverId: string; actions: any[] } {
  const p = payload as { receiverId?: unknown; actions?: unknown } | null;
  if (!p || typeof p.receiverId !== 'string' || !Array.isArray(p.actions) || !p.actions.length) throw new Error('the intent to sign is not a NEAR delegate action');
  return p as { receiverId: string; actions: any[] };
}

// ---- what the routes take and pass on ----

export const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ID = /^[\w:.-]{1,128}$/;
const TYPES: OwnerIntentType[] = ['agent_create', 'policy_update', 'grant_issue', 'approval_vote'];

export type IntentAsk =
  | { type: 'agent_create'; task_id: string; public_key: string }
  | { type: 'policy_update' | 'grant_issue' }
  | { type: 'approval_vote'; approval_id: string; verdict: 'approve' | 'reject' };

/**
 * What the browser may ask POST /api/wallet/intents for. Never an owner (the session names it) and never rules: an
 * agent_create names the task whose plan holds them, and the route reads that plan as the signed-in account.
 */
export function parseIntentAsk(body: unknown): IntentAsk | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const type = b.type as OwnerIntentType;
  if (!TYPES.includes(type)) return { error: 'Rook can only prepare an agent wallet step or an approval vote.' };
  if (type === 'agent_create') {
    if (typeof b.task_id !== 'string' || !ID.test(b.task_id)) return { error: 'Creating an agent wallet needs the plan whose spending rules it gets.' };
    if (typeof b.public_key !== 'string' || !PUBLIC_KEY.test(b.public_key)) return { error: "Your wallet didn't share its public key, which the agent wallet names as its owner. Try another wallet." };
    return { type, task_id: b.task_id, public_key: b.public_key };
  }
  if (type === 'approval_vote') {
    if (typeof b.approval_id !== 'string' || !ID.test(b.approval_id)) return { error: 'This vote names no approval.' };
    if (b.verdict !== 'approve' && b.verdict !== 'reject') return { error: 'A vote is approve or reject.' };
    return { type, approval_id: b.approval_id, verdict: b.verdict };
  }
  return { type };
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The wallet as the page gets it: only the fields AgentWalletView names, so nothing else the services hold (a grant's
 * token, say) can ever reach the browser through this route.
 */
export function walletViewOf(raw: unknown, owner: string): AgentWalletView {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const status = ['none', 'pending', 'active', 'frozen'].includes(r.status) ? r.status : 'none';
  const next = ['create', 'allow_destination', 'issue_grant', 'ready'].includes(r.next_step) ? r.next_step : null;
  const b = r.budget && typeof r.budget === 'object' && ['day', 'week', 'month'].includes(r.budget.period) ? r.budget : null;
  return {
    configured: r.configured === true,
    owner,
    agent_id: str(r.agent_id),
    near_account_id: str(r.near_account_id),
    status,
    next_step: next,
    rules: cleanRules(r.rules),
    policy: r.policy ?? null,
    balance_atomic: str(r.balance_atomic),
    native_balance_atomic: str(r.native_balance_atomic),
    budget: b && { period: b.period, limit_usd: n(b.limit_usd), spent_usd: n(b.spent_usd), remaining_usd: n(b.remaining_usd), resets_at: str(b.resets_at) },
    grant: r.grant && typeof r.grant.grant_id === 'string' ? { grant_id: r.grant.grant_id, expires_at: String(r.grant.expires_at ?? '') } : null,
    pending_approvals: Array.isArray(r.pending_approvals)
      ? r.pending_approvals.filter((a: any) => a && typeof a.approval_id === 'string').map((a: any) => ({
        approval_id: a.approval_id, task_id: str(a.task_id), amount_atomic: String(a.amount_atomic ?? '0'), created_at: String(a.created_at ?? ''), expires_at: str(a.expires_at),
      }))
      : [],
  };
}

/** Without an Agent API key (or before the services had a wallet at all) the page shows nothing of it. */
export const NOT_CONFIGURED = (owner: string): AgentWalletView => walletViewOf({ configured: false }, owner);

/** An intent to sign as the page gets it: only OwnerIntentView's fields. */
export function intentViewOf(raw: unknown): OwnerIntentView {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const intent = r.intent && typeof r.intent === 'object' ? r.intent : {};
  return {
    correlation_id: String(r.correlation_id ?? ''),
    type: r.type,
    intent: { standard: intent.standard, payload: intent.payload },
    summary: String(r.summary ?? ''),
    ...(r.policy !== undefined ? { policy: r.policy } : {}),
    expires_at: String(r.expires_at ?? ''),
  };
}
