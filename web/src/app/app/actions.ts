'use server';

import { revalidatePath } from 'next/cache';
import { approveTask, cancelTask, createTask, killTask, OrchestratorDown } from './orchestrator';

export type DraftResult =
  | { kind: 'planned'; id: string }
  | { kind: 'invalid'; prompt?: string; budget?: string }
  | { kind: 'error'; message: string };

export type ActResult = { ok: true; needsFunding?: boolean } | { ok: false; message: string };

const BUDGET = /^\d+(\.\d{1,6})?$/;
const DOWN = "Rook's services aren't running. Start them with pnpm dev, then try again.";
const refreshSidebar = () => revalidatePath('/app', 'layout');

export async function draftTask(input: { prompt: string; budget: string; account: string }): Promise<DraftResult> {
  const prompt = input.prompt.trim();
  const budget = input.budget.trim();

  // ponytail: this is the account the browser reports, not proof of ownership. Phase 2 funding needs the wallet's own
  // signature anyway; a signed sign-in message would be the upgrade if drafting ever needs real identity.
  if (!input.account.trim()) return { kind: 'error', message: 'Connect your NEAR wallet to draft a plan.' };

  const invalid: Extract<DraftResult, { kind: 'invalid' }> = { kind: 'invalid' };
  if (!prompt) invalid.prompt = 'Describe the task first.';
  if (!BUDGET.test(budget) || Number(budget) <= 0) invalid.budget = 'Enter an amount above 0, like 3.00.';
  if (invalid.prompt || invalid.budget) return invalid;

  try {
    const task = await createTask(prompt, budget);
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

export async function approve(id: string, account: string): Promise<ActResult> {
  if (!account.trim()) return { ok: false, message: 'Connect your NEAR wallet to approve this plan.' };
  return act(() => approveTask(id, account));
}
export async function cancel(id: string) { return act(() => cancelTask(id)); }
export async function stop(id: string) { return act(() => killTask(id)); }
