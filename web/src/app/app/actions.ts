'use server';

import { revalidatePath } from 'next/cache';
import { createTask, OrchestratorDown, type PlanView } from './orchestrator';

export type DraftState =
  | { kind: 'idle' }
  | { kind: 'invalid'; prompt?: string; budget?: string }
  | { kind: 'error'; message: string }
  | { kind: 'planned'; prompt: string; plan: PlanView };

const BUDGET = /^\d+(\.\d{1,6})?$/;

export async function draftPlan(_: DraftState, form: FormData): Promise<DraftState> {
  const prompt = String(form.get('prompt') ?? '').trim();
  const budget = String(form.get('budget') ?? '').trim();

  // ponytail: this is the account the browser reports, not proof of ownership. Phase 2 funding needs the wallet's own
  // signature anyway; a signed sign-in message would be the upgrade if drafting ever needs real identity.
  if (!String(form.get('account') ?? '').trim()) return { kind: 'error', message: 'Connect your NEAR wallet to draft a plan.' };

  const invalid: Extract<DraftState, { kind: 'invalid' }> = { kind: 'invalid' };
  if (!prompt) invalid.prompt = 'Describe the task first.';
  if (!BUDGET.test(budget) || Number(budget) <= 0) invalid.budget = 'Enter an amount above 0, like 3.00.';
  if (invalid.prompt || invalid.budget) return invalid;

  try {
    const task = await createTask(prompt, budget);
    revalidatePath('/app', 'layout');
    if (!task.plan) return { kind: 'error', message: "Rook couldn't draft a plan for this task. Try again in a moment." };
    return { kind: 'planned', prompt: task.prompt, plan: task.plan };
  } catch (e) {
    return {
      kind: 'error',
      message: e instanceof OrchestratorDown
        ? "Rook's services aren't running. Start them with pnpm dev, then try again."
        : "Rook couldn't draft a plan for this task. Try again in a moment.",
    };
  }
}
