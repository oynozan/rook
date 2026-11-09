'use server';

import { revalidatePath } from 'next/cache';
import { approveTask, cancelTask, createTask, killTask, OrchestratorDown } from './orchestrator';
import { currentAccount } from './session';

export type DraftResult =
  | { kind: 'planned'; id: string }
  | { kind: 'invalid'; prompt?: string; budget?: string }
  | { kind: 'error'; message: string };

export type ActResult = { ok: true; needsFunding?: boolean } | { ok: false; message: string };

const BUDGET = /^\d+(\.\d{1,6})?$/;
const DOWN = "Rook's services aren't running. Start them with pnpm dev, then try again.";
const refreshSidebar = () => revalidatePath('/app', 'layout');

const SIGN_IN = 'Sign in with your NEAR wallet first.';

// Every action acts as the signed-in account from the session cookie. The browser can't name an account.
export async function draftTask(input: { prompt: string; budget: string }): Promise<DraftResult> {
  const prompt = input.prompt.trim();
  const budget = input.budget.trim();
  const owner = await currentAccount();
  if (!owner) return { kind: 'error', message: SIGN_IN };

  const invalid: Extract<DraftResult, { kind: 'invalid' }> = { kind: 'invalid' };
  if (!prompt) invalid.prompt = 'Describe the task first.';
  if (!BUDGET.test(budget) || Number(budget) <= 0) invalid.budget = 'Enter an amount above 0, like 3.00.';
  if (invalid.prompt || invalid.budget) return invalid;

  try {
    const task = await createTask(prompt, budget, owner);
    refreshSidebar();
    return { kind: 'planned', id: task.id };
  } catch (e) {
    return { kind: 'error', message: e instanceof OrchestratorDown ? DOWN : "Rook couldn't draft a plan for this task. Try again in a moment." };
  }
}

async function act(run: () => Promise<object & { funding?: unknown }>): Promise<ActResult> {
  try {
    const out = await run();
    refreshSidebar();
    return { ok: true, needsFunding: !!out.funding };
  } catch (e) {
    return { ok: false, message: e instanceof OrchestratorDown ? DOWN : e instanceof Error ? e.message : 'That did not work. Try again.' };
  }
}

async function asOwner(run: (owner: string) => Promise<object & { funding?: unknown }>): Promise<ActResult> {
  const owner = await currentAccount();
  if (!owner) return { ok: false, message: SIGN_IN };
  return act(() => run(owner));
}

export async function approve(id: string) { return asOwner((owner) => approveTask(id, owner)); }
export async function cancel(id: string) { return asOwner((owner) => cancelTask(id, owner)); }
export async function stop(id: string) { return asOwner((owner) => killTask(id, owner)); }
