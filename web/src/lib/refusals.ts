// What the orchestrator answers to the task page's buttons (approve, cancel, stop), and to the funding step asking for
// the funding transfer again (fund), in plain words for the page.
import { detail, failed, TOKEN_MISMATCH } from '@/lib/errors';

export type TaskAction = 'approve' | 'fund' | 'cancel' | 'stop';

const NOW: Record<string, string> = {
  draft: 'is still being planned', planned: 'is waiting for your approval', approved: 'is already approved',
  funded: 'is already running', running: 'is already running', aggregating: 'is already running', closing: 'has finished, and Rook is sending the unspent USDC back',
  closed: 'has already finished', cancelled: 'was cancelled', killed: 'was stopped', failed: 'has already failed',
};
const DONE: Record<TaskAction, string> = { approve: 'started', fund: 'funded', cancel: 'cancelled', stop: 'stopped' };
/**
 * Approving answered without the funding transfer: the orchestrator's ledger isn't the Rook contract now (it restarted
 * in simulation mode, say), or the plan hires no one and started at once. Either way there is nothing to sign.
 */
export const FUNDING_NOT_READY = 'Rook answered without a funding transfer for your wallet to sign: its services may not be running against '
  + 'the Rook contract right now (a restart in simulation mode, say). Reload the page to see where this task stands.';
/** The start of a failure Rook can't word more plainly; errors.ts failed() adds the cause. */
const FAILED: Record<TaskAction, string> = {
  approve: "Rook couldn't start this task",
  fund: "Rook couldn't get the funding transfer ready",
  cancel: "Rook couldn't cancel this task",
  stop: "Rook couldn't stop this task",
};

/**
 * The funding transfer carries the contract's settings, which the orchestrator reads from NEAR through the
 * chain-gateway: the gateway down, NEAR RPC failing, or the read timing out.
 */
const CHAIN_READ = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|-> \d{3}$|NEAR RPC|^view \S+\.get_|chain-gateway|aborted|timeout/i;

/**
 * The orchestrator's 404 for one of the owner's own tasks whose conversation they deleted (from another tab, say). It
 * tells only the owner so: anyone else's task is plain "no task".
 */
export const chatDeleted = (status: number | null, message: string) => status === 404 && /^no task \S+: its conversation was deleted/.test(message);

/**
 * `status`: the orchestrator's HTTP status, or null when it never answered with one. `known` false: a failure on Rook's
 * side or a refusal these words don't name, so the orchestrator's own message belongs in the server log. `final`:
 * asking again can never work, so the page offers no Try again.
 */
export function actionRefusal(action: TaskAction, status: number | null, message: string): { message: string; known: boolean; final?: true } {
  const known = (text: string) => ({ message: text, known: true });
  if (chatDeleted(status, message)) return known('This chat was deleted.');
  if (status === 401) return { ...known(`${FAILED[action]}: ${TOKEN_MISMATCH}.`), final: true };
  if (status === 404 && /^no task /.test(message)) return known("Rook has no task at this link for the wallet you're signed in with.");
  if (status === 409) {
    // A newer message in the conversation is revising this plan (another tab sent it, say).
    if (/^Wait for the revised plan below/.test(message)) return known('Wait for the revised plan below.');
    let m = /^task is (?:already )?(\w+)/.exec(message);
    // Stop is refused only once a task has ended, which says it all.
    if (m) return known(`This task ${NOW[m[1]] ?? `is ${m[1]}`}${action === 'stop' ? '' : `, so it can't be ${DONE[action]}`}.`);
    // Stop on a page that still showed the run after the report was written.
    if (/^the report is written/.test(message)) return known('This task has already finished. Rook is sending the unspent USDC back to your wallet.');
    if (/^the plan has no subtasks/.test(message)) return known("This plan has nothing to run, so it can't be started.");
    // A plan drafted before 0 USDC quotes were dropped: asking again can never work, only a new plan can. Approved, it
    // waits for its funding, so it is cancelled first; still planned, a new message revises it.
    if (/^this plan has a 0 USDC cap\b/.test(message)) {
      const next = action === 'fund' ? 'Cancel it and draft the task again.' : 'Draft the task again.';
      return { ...known(`This plan has a part capped at 0 USDC, which the Rook contract refuses. ${next}`), final: true };
    }
    if (/^live market: paying agents/.test(message)) return known("Paying live agents isn't switched on yet, so this plan can't be started.");
    m = /already has (\d+) open tasks on the contract/.exec(message);
    if (m) {
      return known(`You already have ${m[1]} funded tasks open on the Rook contract, the most it allows at once. Try again once one of them `
        + 'closes. A task you stopped before it ran closes when you refund it to your wallet.');
    }
    m = /below the contract's minimum of ([\d.]+) USDC/.exec(message);
    if (m) return known(`This task's budget is below the contract's smallest, ${m[1]} USDC. Draft it again with a larger budget.`);
  }
  if ((action === 'approve' || action === 'fund') && status !== null && status >= 500 && CHAIN_READ.test(message)) {
    return { message: `Rook couldn't read the Rook contract's settings from NEAR (${detail(message)}), so the funding transfer isn't ready. Try again in a moment.`, known: false };
  }
  return { message: failed(FAILED[action], status, message), known: false };
}

/**
 * A failed call of the funding step's (confirm, refund). The orchestrator's refusals (4xx) go back as it wrote them,
 * marked raw: the funding step reads them (funding.ts confirmFailure) and words them. Anything else (a 5xx such as the
 * chain-gateway down behind it, or a service token that differs) is Rook's own trouble, said in plain words; its text
 * belongs in the server log.
 */
export function fundingCallFailure(status: number | null, message: string): { message: string; raw?: true } {
  if (status !== null && status >= 400 && status < 500 && status !== 401 && message) return { message, raw: true };
  return { message: failed("Rook couldn't check your transfer", status, message) };
}
