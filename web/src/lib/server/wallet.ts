// The agent wallet's routes (app/api/wallet, app/api/tasks/[id]/fund-from-wallet), as plain functions of the signed-in
// account so the tests can run them against a stand-in orchestrator. Server code only. The owner always comes from the
// session; the browser only names a step, a task, an approval, and forwards what its wallet signed.
import { DOWN, failed } from '@/lib/errors';
import {
  intentViewOf, knownWalletReason, NOT_CONFIGURED, parseIntentAsk, planRules, walletReason, walletRetryable, walletViewOf,
} from '@/lib/agent-wallet';
import { isFullAccessKey } from '@/lib/nep413';
import { DEFAULT_RPC, NETWORK } from '@/lib/network';
import {
  fundFromWallet, getTask, getWallet, OrchestratorDown, OrchestratorError, submitWalletIntent, walletIntent,
} from '@/lib/server/orchestrator';

export type Out = { status: number; body: Record<string, unknown> };

/** The calls the routes make, so a test can stand in for NEAR. */
export type Deps = { fullAccess: (account: string, publicKey: string) => Promise<boolean> };
export const liveDeps: Deps = {
  fullAccess: (account, key) => isFullAccessKey(account, key, process.env.WEB_NEAR_RPC_URL ?? DEFAULT_RPC[NETWORK]),
};

const ok = (body: object): Out => ({ status: 200, body: body as Record<string, unknown> });
const no = (status: number, error: string, more: object = {}): Out => ({ status, body: { error, ...more } });

/**
 * A failed call to the orchestrator, for the page: a refusal (4xx) in plain words from its Agent API code, with `retry`
 * when asking again may work; anything else (down, a 5xx, a service token that differs) says Rook couldn't, and its
 * text goes to the server log. `what` ends "Rook couldn't …".
 */
export function walletFailure(what: string, e: unknown): Out {
  if (e instanceof OrchestratorDown) return no(503, `${DOWN}, so Rook couldn't ${what}. Try again in a minute.`, { retry: true });
  const status = e instanceof OrchestratorError ? e.status : null;
  const message = e instanceof Error ? e.message : String(e);
  if (status !== null && status >= 400 && status < 500 && status !== 401) {
    return no(status, `Rook couldn't ${what}: ${walletReason(message)}.`, walletRetryable(message) ? { retry: true } : {});
  }
  // The services passing on an Agent API failure they know (its sponsor busy, say): said plainly, as a refusal is.
  const known = status !== null && status >= 500 ? knownWalletReason(message) : null;
  if (known) return no(503, `Rook couldn't ${what}: ${known}. Try again in a moment.`, { retry: true });
  console.error(`[web] agent wallet, ${what}:`, message);
  return no(502, failed(`Rook couldn't ${what}`, status, message), { retry: true });
}

/** GET /api/wallet. An orchestrator without wallet routes (404) has no wallet to show, like one without an API key. */
export async function readWallet(owner: string): Promise<Out> {
  try {
    return ok(walletViewOf(await getWallet(owner), owner));
  } catch (e) {
    if (e instanceof OrchestratorError && e.status === 404) return ok(NOT_CONFIGURED(owner));
    return walletFailure('read your agent wallet', e);
  }
}

/**
 * POST /api/wallet/intents: one owner intent to sign. An agent_create takes its rules from the named task's plan, read
 * as `owner` (anyone else's task is "no task"), and its owner key only once NEAR says the key is one of the account's
 * full-access keys: the agent wallet's owner key is the one that signs every later change.
 */
export async function prepareIntent(owner: string, body: unknown, deps: Deps = liveDeps): Promise<Out> {
  const ask = parseIntentAsk(body);
  if ('error' in ask) return no(400, ask.error);
  let request: Parameters<typeof walletIntent>[1];
  if (ask.type === 'agent_create') {
    let plan;
    try {
      const snap = await getTask(ask.task_id, owner);
      if (snap.task.owner !== owner) return no(404, `no task ${ask.task_id}`);
      plan = snap.plan;
    } catch (e) {
      if (e instanceof OrchestratorError && e.status === 404) return no(404, `no task ${ask.task_id}`);
      return walletFailure('read the plan with your spending rules', e);
    }
    const rules = planRules(plan);
    if (!rules) return no(400, 'This plan states no spending rules, so Rook has none to give an agent wallet. Say in a message how Rook may spend, like "only spend $1000, and every spend comes to me for approval".');
    try {
      if (!(await deps.fullAccess(owner, ask.public_key))) {
        return no(403, `The key your wallet shared isn't one of ${owner}'s full-access keys on NEAR, and only a full-access key can own an agent wallet. Switch your wallet to the account's own key and try again.`);
      }
    } catch {
      return no(503, `Rook couldn't ask NEAR whether your key belongs to ${owner}. Try again in a moment.`, { retry: true });
    }
    request = { type: 'agent_create', rules, public_key: ask.public_key };
  } else if (ask.type === 'approval_vote') {
    request = { type: 'approval_vote', approval_id: ask.approval_id, verdict: ask.verdict };
  } else {
    request = { type: ask.type };
  }
  try {
    return ok(intentViewOf(await walletIntent(owner, request)));
  } catch (e) {
    return walletFailure(ask.type === 'approval_vote' ? 'prepare your vote for signing' : 'prepare this step for your signature', e);
  }
}

const CID = /^[\w:.-]{1,128}$/;

/**
 * POST /api/wallet/intents/:cid/submit: the wallet's output, forwarded as it came. The services check that intent `cid`
 * is one they generated for `owner`, and the Agent API that the payload is the one it generated.
 */
export async function submitIntent(owner: string, cid: string, body: unknown): Promise<Out> {
  if (!CID.test(cid)) return no(400, 'This signature names no intent Rook prepared.');
  const signed = (body as { signed_data?: unknown } | null)?.signed_data as Record<string, unknown> | undefined;
  if (!signed || typeof signed !== 'object' || (signed.standard !== 'nep413' && signed.standard !== 'nep366') || !signed.payload) {
    return no(400, "Your wallet's answer isn't a signature Rook can pass on. Try again.");
  }
  try {
    return ok(walletViewOf(await submitWalletIntent(cid, owner, signed), owner));
  } catch (e) {
    return walletFailure('submit your signature', e);
  }
}

/** POST /api/tasks/:id/fund-from-wallet: only the task's owner, as GET /api/tasks/:id checks it. */
export async function fundTaskFromWallet(owner: string, id: string): Promise<Out> {
  try {
    const snap = await getTask(id, owner);
    if (snap.task.owner !== owner) return no(404, `no task ${id}`);
  } catch (e) {
    if (e instanceof OrchestratorError && e.status === 404) return no(404, `no task ${id}`);
    return walletFailure('fund this task from your agent wallet', e);
  }
  try {
    const task = await fundFromWallet(id, owner);
    return ok({ status: task.status, wallet_funding: task.wallet_funding ?? null });
  } catch (e) {
    return walletFailure('fund this task from your agent wallet', e);
  }
}

/** The routes' answer, never cached. */
export const respond = (out: Out) => Response.json(out.body, { status: out.status, headers: { 'cache-control': 'no-store' } });
export const signedOut = () => respond(no(401, 'Your sign-in has ended. Connect your NEAR wallet again.'));
