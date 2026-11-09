'use server';

import { revalidatePath } from 'next/cache';
import { forgetFundingOf, forgetUnreadFunding, fundingSent, giveBackDraftSlot, markFundingRefunded, recordFundingSent, takeDraftSlot } from './db';
import { checkDraft, draftRefusal, followUpRefusal } from './draft';
import { untilFinal, type Funding } from './funding';
import { approveTask, cancelTask, createTask, fundedTask, getMode, getTask, killTask, OrchestratorDown, OrchestratorError } from './orchestrator';
import { actionRefusal, type TaskAction } from './refusals';
import { currentAccount } from './session';

export type DraftResult =
  | { kind: 'planned'; id: string }
  | { kind: 'invalid'; prompt?: string; budget?: string }
  | { kind: 'error'; message: string };

export type ActResult = { ok: true; funding?: Funding } | { ok: false; message: string };

// Each draft spends NEAR AI credit on the planner, so one account can't drain it. ponytail: per account only; many
// throwaway accounts still add up, so the planner's own ROOK_LLM_MAX_USD cap is the backstop.
const DRAFTS_PER_HOUR = Math.max(1, Math.floor(Number(process.env.ROOK_DRAFTS_PER_HOUR)) || 20);
const DOWN = "Rook's services are unreachable right now. Try again in a minute.";
const refreshSidebar = () => revalidatePath('/app', 'layout');

/** No session (it lapsed, or another tab signed out): the layout renders signed out again, so the page offers Connect. */
function signInFirst() {
  refreshSidebar();
  return 'Sign in with your NEAR wallet first.';
}

// Every action acts as the signed-in account from the session cookie. The browser can't name an account.
// parent_id: the conversation's newest task, which this message follows (the orchestrator checks it is the account's).
export async function draftTask(input: { prompt: string; budget: string; parent_id?: string }): Promise<DraftResult> {
  const owner = await currentAccount();
  if (!owner) return { kind: 'error', message: signInFirst() };

  // The composer's own checks again, with the orchestrator's budget limits, all before a draft slot is taken.
  const check = checkDraft({ prompt: String(input?.prompt ?? ''), budget: String(input?.budget ?? '') }, await getMode().catch(() => null));
  if (!check.ok) return { kind: 'invalid', prompt: check.prompt, budget: check.budget };

  const slot = takeDraftSlot(owner, DRAFTS_PER_HOUR, 3_600_000);
  if (!slot.ok) {
    return { kind: 'error', message: `You've drafted ${DRAFTS_PER_HOUR} plans in the last hour, the most Rook allows. Try again in ${Math.ceil(slot.retryInS / 60)} min.` };
  }

  try {
    const parent = typeof input?.parent_id === 'string' && input.parent_id ? input.parent_id : undefined;
    const task = await createTask(check.prompt, check.usdc, owner, parent);
    refreshSidebar();
    return { kind: 'planned', id: task.id };
  } catch (e) {
    giveBackDraftSlot(owner, slot.slot); // no task, so no planning was paid for
    if (e instanceof OrchestratorDown) return { kind: 'error', message: DOWN };
    const refused = e instanceof OrchestratorError && e.status === 400 ? draftRefusal(e.message) : null;
    if (refused) return { kind: 'invalid', ...refused };
    const follow = e instanceof OrchestratorError ? followUpRefusal(e.status, e.message) : null;
    if (follow) return { kind: 'error', message: follow };
    console.error('[web] draftTask:', e instanceof Error ? e.message : e);
    return { kind: 'error', message: "Rook couldn't draft a plan for this task. Try again in a moment." };
  }
}

/**
 * `action`: a task page button, whose refusals go back in plain words (the orchestrator's own go to the server log).
 * Without one they go back as the orchestrator wrote them: the funding step reads them (funding.ts confirmFailure).
 */
async function act(run: () => Promise<object & { funding?: Funding }>, action?: TaskAction): Promise<ActResult> {
  try {
    const out = await run();
    refreshSidebar();
    return out.funding ? { ok: true, funding: out.funding } : { ok: true };
  } catch (e) {
    if (e instanceof OrchestratorDown) return { ok: false, message: DOWN };
    const message = e instanceof Error ? e.message : '';
    if (!action) return { ok: false, message: message || 'That did not work. Try again.' };
    const plain = actionRefusal(action, e instanceof OrchestratorError ? e.status : null, message);
    if (!plain.known) console.error(`[web] ${action}:`, message || e);
    return { ok: false, message: plain.message };
  }
}

async function asOwner(action: TaskAction, run: (owner: string) => Promise<object & { funding?: Funding }>): Promise<ActResult> {
  const owner = await currentAccount();
  if (!owner) return { ok: false, message: signInFirst() };
  return act(() => run(owner), action);
}

/** Simulation: starts the run. Chain mode: returns the funding transfer for the wallet (again, if asked again). */
export async function approve(id: string) { return asOwner('approve', (owner) => approveTask(id, owner)); }
export async function cancel(id: string) { return asOwner('cancel', (owner) => cancelTask(id, owner)); }
export async function stop(id: string) { return asOwner('stop', (owner) => killTask(id, owner)); }

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const CONTRACT_TASK = /^[0-9a-z]{1,20}$/;
const txOf = (v: unknown) => (typeof v === 'string' && TX_HASH.test(v) ? v : null);

// Funding records are keyed by task and signed-in account, so writing one needs no orchestrator: a record only ever
// changes what this account's own page offers, and the page shows tasks only to their owner.

/**
 * The wallet returned the funding transfer's hash. Remembered before anything reads the outcome or calls Rook, so a
 * reload, a closed tab or a restarting orchestrator never leads to a second transfer. With `contract_task_id`, the
 * page read what the transfer created.
 */
export async function rememberTransfer(id: string, input: { tx_hash: string; contract_task_id?: string | null }): Promise<{ ok: boolean }> {
  const owner = await currentAccount();
  const tx = txOf(input?.tx_hash);
  const cid = input?.contract_task_id == null ? null : String(input.contract_task_id);
  if (!owner || !tx || (cid !== null && !CONTRACT_TASK.test(cid))) return { ok: false };
  return { ok: recordFundingSent(String(id), owner, { tx_hash: tx, contract_task_id: cid }) };
}

/** The remembered transfer moved no USDC (it failed, or the contract refunded it at once): the page may offer it again. */
export async function forgetTransfer(id: string, tx_hash: string) {
  const owner = await currentAccount();
  const tx = txOf(tx_hash);
  if (owner && tx) forgetUnreadFunding(String(id), owner, tx);
}

/**
 * The wallet's funding transfer created contract task `contract_task_id`. It is remembered first, so a reload shows
 * "confirm" instead of offering to fund twice; then the orchestrator checks the contract task against the plan. A task
 * whose funding is already a different contract task keeps it.
 */
export async function confirmFunding(id: string, input: { contract_task_id: string; tx_hash: string | null }): Promise<ActResult> {
  const owner = await currentAccount();
  if (!owner) return { ok: false, message: signInFirst() };
  const cid = String(input?.contract_task_id ?? '');
  if (!CONTRACT_TASK.test(cid)) return { ok: false, message: 'That contract task id is not valid.' };
  if (!recordFundingSent(id, owner, { contract_task_id: cid, tx_hash: txOf(input?.tx_hash) })) {
    const was = fundingSent(id, owner);
    return { ok: false, message: `This task's funding is already ${was?.contract_task_id ? `contract task ${was.contract_task_id}` : 'another transfer'}, so Rook won't confirm contract task ${cid} for it.` };
  }
  const out = await untilFinal(() => act(() => fundedTask(id, cid, owner)));
  // That contract task funds another of this account's tasks: it isn't this one's, so this one can be funded again.
  const other = !out.ok && out.message.match(/^contract task \S+ already funds (\S+)/)?.[1];
  if (other && other !== id) forgetFundingOf(id, owner, cid);
  return out;
}

/**
 * The funder's close_task refunded contract task `contract_task_id` (the page read the contract's task_closed event).
 * The record says so, so the page stops saying the USDC is in the contract; and a task still waiting for that funding is
 * stopped, since it can't run without it. A task whose funding is another contract task (bound or not) is left alone.
 */
export async function fundingRefunded(id: string, input: { contract_task_id: string; refund_tx: string | null }): Promise<ActResult> {
  const owner = await currentAccount();
  if (!owner) return { ok: false, message: signInFirst() };
  const cid = String(input?.contract_task_id ?? '');
  if (!CONTRACT_TASK.test(cid)) return { ok: false, message: 'That contract task id is not valid.' };
  if (!markFundingRefunded(id, owner, cid, txOf(input?.refund_tx))) return { ok: true };
  return act(async () => {
    const { task, ledger } = await getTask(id, owner);
    const waiting = !['closed', 'cancelled', 'killed', 'failed'].includes(task.status) && (!ledger || ledger.contract_task_id === cid);
    return task.owner === owner && waiting ? killTask(id, owner) : {};
  });
}
