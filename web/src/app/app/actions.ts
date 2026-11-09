'use server';

import { revalidatePath } from 'next/cache';
import { recordFundingSent, takeDraftSlot } from './db';
import { untilFinal, type Funding } from './funding';
import { approveTask, cancelTask, createTask, fundedTask, getTask, killTask, OrchestratorDown } from './orchestrator';
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

/**
 * The wallet's funding transfer created contract task `contract_task_id`. It is remembered first, so a reload shows
 * "confirm" instead of offering to fund twice; then the orchestrator checks the contract task against the plan.
 */
export async function confirmFunding(id: string, input: { contract_task_id: string; tx_hash: string | null }): Promise<ActResult> {
  const owner = await currentAccount();
  if (!owner) return { ok: false, message: SIGN_IN };
  const cid = String(input?.contract_task_id ?? '');
  const tx = typeof input?.tx_hash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(input.tx_hash) ? input.tx_hash : null;
  if (!/^[0-9a-z]{1,20}$/.test(cid)) return { ok: false, message: 'That contract task id is not valid.' };
  try {
    if ((await getTask(id, owner)).task.owner !== owner) return { ok: false, message: `No task ${id}.` };
  } catch (e) {
    return { ok: false, message: e instanceof OrchestratorDown ? DOWN : `No task ${id}.` };
  }
  recordFundingSent(id, owner, { contract_task_id: cid, tx_hash: tx });
  return untilFinal(() => act(() => fundedTask(id, cid, owner)));
}
