// NEAR Intents Agent API client (docs/agent-wallet-plan.md): the routes the agent wallet MVP uses, over plain fetch.
// The SDK (@near-intents-agent-api/sdk) needs Node 24; Rook runs on Node 22. Shapes and headers follow the API's
// /openapi.json and its skill's references/http-api.md (read 2026-11-12). The partner key and grant tokens go in headers
// only: never into an error message, a log line or a return value.
import { config } from '../shared/config.ts';

/** NEAR USDC on mainnet (the Agent API is mainnet only): the token contract and its NEAR Intents asset id. */
export const USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const USDC_ASSET = `nep141:${USDC_CONTRACT}`;
export const WNEAR_ASSET = 'nep141:wrap.near';

/** `errors[0]` of the API's JSON:API error document. Branch on `code`; `layer` says whose rule refused. */
export class AgentApiError extends Error {
  override name = 'AgentApiError';
  constructor(
    public status: number, public code: string, public layer: string | null, public title: string,
    public detail: string | null = null, public retryable = false, public available_at: string | null = null, public request_id: string | null = null,
  ) { super(`${code}: ${detail ?? title}`); }
}

export type Status =
  | 'PENDING_SIGNATURE' | 'QUEUED' | 'PENDING_APPROVAL' | 'PENDING_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'UNCERTAIN' | 'NEEDS_REVIEW';
export const TERMINAL_STATUS: Status[] = ['SUCCESS', 'REFUNDED', 'FAILED'];

export type OwnerWallet = { type: 'near'; account_id: string; public_key: string };
export type IntentType = 'agent_create' | 'policy_update' | 'grant_issue' | 'approval_vote';
export type Intent = { standard: 'nep413' | 'nep366' | 'eip712' | 'webauthn'; payload: any };

export type GenerateIntentResponse = {
  correlation_id: string; type: IntentType; agent_id: string; status: 'PENDING_SIGNATURE'; expires_at: string;
  signer: OwnerWallet; intent: Intent; preview: { summary: string; policy?: unknown; revision?: number; [k: string]: unknown };
};

export type StatusResponse = {
  correlation_id: string; agent_id: string | null; type: string; status: Status; failure_code: string | null;
  created_at: string; updated_at: string; dispatch_committed_at: string | null; grant: { id: string; label: string } | null;
  details: Record<string, any>;
};

export type AgentView = {
  id: string; name: string; external_user_id: string | null; status: 'PENDING' | 'ACTIVE' | 'ARCHIVED' | 'DELETED' | 'ABANDONED';
  archived: boolean; deleted: boolean; wallet: { wallet_id: string; near_account_id: string } | null; created_at: string;
  cooldowns: { policy_change_available_at: string | null; unfreeze_available_at: string | null };
};

export type BudgetWindow = { limit_usd: string | null; spent_usd: string | null; remaining_usd: string | null; resets_at: string | null };
export type PolicyView = {
  wallet_id: string; revision: number | null; status: 'NONE' | 'SIGNED' | 'APPLIED' | 'FAILED'; provider_policy_synced: boolean;
  policy: any | null; usage: { budget: { daily: BudgetWindow; weekly: BudgetWindow; monthly: BudgetWindow } };
};

export type BalanceEntry = { asset_id: string; balance_raw: string; available_raw: string; decimals: number | null; symbol: string | null };
export type GrantView = { grant_id: string; label: string; issued_at: string; expires_at: string; revoked_at: string | null };
export type ApprovalView = {
  approval_id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'; request_type: string; request_data: Record<string, unknown>; expires_at: string;
};

/** What a 65 s request may wait (the API's long poll is 30 s at most); settlement writes get 150 s, as the docs advise. */
const READ_MS = 65_000, SETTLE_MS = 150_000;

export type AgentApi = ReturnType<typeof agentApi>;

/** A client for one partner key. `url` and `key` default to ROOK_AGENT_API_URL and ROOK_AGENT_API_KEY, read per request. */
export function agentApi(opts: { url?: string; key?: string } = {}) {
  async function req<T>(method: 'GET' | 'POST', path: string, o: { body?: unknown; grant?: string; idem?: string; timeoutMs?: number } = {}): Promise<T> {
    const base = (opts.url ?? config.agentApiUrl).replace(/\/+$/, ''), key = opts.key ?? config.agentApiKey;
    if (!key) throw new AgentApiError(0, 'not_configured', 'api', 'ROOK_AGENT_API_KEY is not set');
    const headers: Record<string, string> = { 'X-API-Key': key, accept: 'application/json' };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.grant) headers['X-Grant-Token'] = o.grant;
    if (o.idem) headers['Idempotency-Key'] = o.idem;
    let r: Response;
    try {
      r = await fetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(o.timeoutMs ?? READ_MS) });
    } catch (e: any) {
      // No answer: the request may still have reached the API, so a money-moving caller repeats it under the same key.
      throw new AgentApiError(0, 'unreachable', 'api', `the Agent API did not answer: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message ?? e}`, null, true);
    }
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) {
      const e = Array.isArray(j?.errors) ? j.errors[0] : null;
      // The gas the wallet's own NEAR account is short of, in NEAR, instead of the API's yoctoNEAR field names.
      const near = (y: unknown) => (typeof y === 'string' && /^\d+$/.test(y) ? (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4) : null);
      const [held, cost] = [near(e?.meta?.available_amount), near(e?.meta?.min_amount)];
      const detail = e?.code === 'custody_native_balance_required' && held && cost
        ? `Your agent wallet's own NEAR account holds ${held} NEAR and this call needs ${cost} NEAR for gas. Send it NEAR and try again.`
        : e?.detail ?? null;
      throw new AgentApiError(
        r.status, typeof e?.code === 'string' ? e.code : `http_${r.status}`, e?.layer ?? null, e?.title ?? `HTTP ${r.status}`, detail,
        e?.meta?.retryable === true, e?.meta?.available_at ?? null, j?.meta?.request_id ?? r.headers.get('x-request-id'),
      );
    }
    return j as T;
  }
  const agent = (id: string) => `/v1/agents/${encodeURIComponent(id)}`;

  return {
    whoami: () => req<{ api_key_id: string; tenant_id: string }>('GET', '/v1/whoami'),
    /** 201 GenerateIntentResponse. `idem`: optional; repeat an interrupted call with the same key. */
    generateIntent: (body: Record<string, unknown>, idem?: string) => req<GenerateIntentResponse>('POST', '/v1/generate-intent', { body, idem }),
    /** 202 StatusResponse. `signed_data`: the generated intent with the wallet's output fields added. */
    submitIntent: (body: { type: IntentType; correlation_id: string; signed_data: unknown }) => req<StatusResponse>('POST', '/v1/submit-intent', { body }),
    /** `wait_ms` 0 to 30000: a long poll that returns early once the status is terminal or needs someone. */
    status: (cid: string, o: { wait_ms?: number; refresh?: boolean } = {}) => {
      const q = new URLSearchParams({ correlation_id: cid });
      if (o.wait_ms) q.set('wait_ms', String(Math.min(30_000, Math.max(0, Math.round(o.wait_ms)))));
      if (o.refresh) q.set('refresh', 'true');
      return req<StatusResponse>('GET', `/v1/status?${q}`);
    },
    agent: (id: string) => req<AgentView>('GET', agent(id)),
    wallet: (id: string) => req<{ wallet_id: string; near_account_id: string }>('GET', `${agent(id)}/wallet`),
    balances: (id: string, asset?: string) =>
      req<{ near_account_id: string; source: string; balances: BalanceEntry[] }>('GET', `${agent(id)}/balances?${new URLSearchParams({ source: 'public', ...(asset ? { asset } : {}) })}`),
    policy: (id: string) => req<PolicyView>('GET', `${agent(id)}/policy`),
    grants: (id: string) => req<{ data: GrantView[] }>('GET', `${agent(id)}/grants`),
    approvals: (id: string) => req<{ data: ApprovalView[] }>('GET', `${agent(id)}/approvals`),
    /** 202 StatusResponse. Needs the grant and an Idempotency-Key persisted before the call. */
    withdraw: (id: string, grant: string, idem: string, body: { asset: string; amount: string; chain: string; recipient: string; memo?: string; confidential?: boolean }) =>
      req<StatusResponse>('POST', `${agent(id)}/withdraw`, { body, grant, idem, timeoutMs: SETTLE_MS }),
    /** 202 StatusResponse: a function call from the wallet's native NEAR account on a contract the policy lists. */
    nearCall: (id: string, grant: string, idem: string, body: { receiver_id: string; method_name: string; args?: object; gas?: string; deposit?: string }) =>
      req<StatusResponse>('POST', `${agent(id)}/native/near/call`, { body, grant, idem, timeoutMs: SETTLE_MS }),
  };
}

/**
 * Polls `cid` until it stops moving: anything but PROCESSING, QUEUED or UNCERTAIN (UNCERTAIN may still have executed,
 * so only polling the same id resolves it), or until `deadlineMs`. A read that returns at once while still moving
 * waits `gapMs` (the API answers at once past 10 long polls per key). Returns the last status read.
 */
export async function settle(api: AgentApi, cid: string, o: { deadlineMs: number; gapMs: number; signal?: AbortSignal; waitMs?: number }): Promise<StatusResponse> {
  const end = Date.now() + o.deadlineMs;
  for (;;) {
    o.signal?.throwIfAborted();
    const t0 = Date.now();
    const s = await api.status(cid, { wait_ms: Math.min(o.waitMs ?? 30_000, Math.max(0, end - Date.now())) });
    if (!['PROCESSING', 'QUEUED', 'UNCERTAIN'].includes(s.status) || Date.now() >= end) return s;
    if (Date.now() - t0 < o.gapMs) await sleep(o.gapMs, o.signal);
  }
}

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((ok, fail) => {
  if (signal?.aborted) return fail(signal.reason);
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); ok(); }, ms);
  const stop = () => { clearTimeout(t); fail(signal!.reason); };
  signal?.addEventListener('abort', stop, { once: true });
});
