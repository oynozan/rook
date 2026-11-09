'use server';

import { revalidatePath } from 'next/cache';
import { forgetFundingOf, forgetUnreadFunding, fundingSent, markFundingRefunded, recordFundingSent, takeDraftSlot } from './db';
import { untilFinal, type Funding } from './funding';
import { approveTask, cancelTask, createTask, fundedTask, getMode, getTask, killTask, OrchestratorDown } from './orchestrator';
import { currentAccount } from './session';

export type DraftResult =
  | { kind: 'planned'; id: string }
  | { kind: 'invalid'; prompt?: string; budget?: string }
  | { kind: 'error'; message: string };

export type ActResult = { ok: true; funding?: Funding } | { ok: false; message: string };

const BUDGET = /^\d+(\.\d{1,6})?$/;
const PROMPT_MAX = 4000;
// Each draft spends NEAR AI credit on the planner, so one account can't drain it. ponytail: per account only; many
// throwaway accounts still add up, so the planner's own ROOK_LLM_MAX_USD cap is the backstop.
const DRAFTS_PER_HOUR = Math.max(1, Math.floor(Number(process.env.ROOK_DRAFTS_PER_HOUR)) || 20);
const DOWN = "Rook's services aren't running. Start them with pnpm dev, then try again.";
const refreshSidebar = () => revalidatePath('/app', 'layout');

const SIGN_IN = 'Sign in with your NEAR wallet first.';

/** "1.5" -> 1500000n (USDC has 6 decimals); the input already matched BUDGET. */
const toAtomic = (s: string) => {
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
};

// Every action acts as the signed-in account from the session cookie. The browser can't name an account.
export async function draftTask(input: { prompt: string; budget: string }): Promise<DraftResult> {
  const prompt = String(input.prompt ?? '').trim();
  const budget = String(input.budget ?? '').trim();
  const owner = await currentAccount();
  if (!owner) return { kind: 'error', message: SIGN_IN };

  const invalid: Extract<DraftResult, { kind: 'invalid' }> = { kind: 'invalid' };
  if (!prompt) invalid.prompt = 'Describe the task first.';
  else if (prompt.length > PROMPT_MAX) invalid.prompt = `Keep the task under ${PROMPT_MAX} characters. This one has ${prompt.length}.`;
  if (!BUDGET.test(budget) || Number(budget) <= 0) invalid.budget = 'Enter an amount above 0, like 3.00.';
  else {
    // The budget contract refunds a transfer below its minimum, so say so before any planning is paid for.
    const min = (await getMode().catch(() => null))?.min_budget_atomic;
    if (min && /^\d+$/.test(min) && toAtomic(budget) < BigInt(min)) invalid.budget = `The smallest budget is ${(Number(min) / 1e6).toFixed(2)} USDC.`;
  }
  if (invalid.prompt || invalid.budget) return invalid;

  const slot = takeDraftSlot(owner, DRAFTS_PER_HOUR, 3_600_000);
  if (!slot.ok) {
    return { kind: 'error', message: `You've drafted ${DRAFTS_PER_HOUR} plans in the last hour, the most Rook allows. Try again in ${Math.ceil(slot.retryInS / 60)} min.` };
  }

  try {
    const task = await createTask(prompt, budget, owner);
    refreshSidebar();
    return { kind: 'planned', id: task.id };
  } catch (e) {
    return { kind: 'error', message: e instanceof OrchestratorDown ? DOWN : "Rook couldn't draft a plan for this task. Try again in a moment." };
  }
}

async function act(run: () => Promise<object & { funding?: Funding }>): Promise<ActResult> {
  try {
    const out = await run();
    refreshSidebar();
    return out.funding ? { ok: true, funding: out.funding } : { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof OrchestratorDown ? DOWN : e instanceof Error ? e.message : 'That did not work. Try again.' };
  }
}

async function asOwner(run: (owner: string) => Promise<object & { funding?: Funding }>): Promise<ActResult> {
  const owner = await currentAccount();
  if (!owner) return { ok: false, message: SIGN_IN };
  return act(() => run(owner));
}

/** Simulation: starts the run. Chain mode: returns the funding transfer for the wallet (again, if asked again). */
export async function approve(id: string) { return asOwner((owner) => approveTask(id, owner)); }
export async function cancel(id: string) { return asOwner((owner) => cancelTask(id, owner)); }
export async function stop(id: string) { return asOwner((owner) => killTask(id, owner)); }

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
  if (!owner) return { ok: false, message: SIGN_IN };
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
  if (!owner) return { ok: false, message: SIGN_IN };
  const cid = String(input?.contract_task_id ?? '');
  if (!CONTRACT_TASK.test(cid)) return { ok: false, message: 'That contract task id is not valid.' };
  if (!markFundingRefunded(id, owner, cid, txOf(input?.refund_tx))) return { ok: true };
  return act(async () => {
    const { task, ledger } = await getTask(id, owner);
    const waiting = !['closed', 'cancelled', 'killed', 'failed'].includes(task.status) && (!ledger || ledger.contract_task_id === cid);
    return task.owner === owner && waiting ? killTask(id, owner) : {};
  });
}
