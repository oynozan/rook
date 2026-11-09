// What the orchestrator answers to the task page's buttons (approve, cancel, stop), in plain words for the page.

export type TaskAction = 'approve' | 'cancel' | 'stop';

const NOW: Record<string, string> = {
  draft: 'is still being planned', planned: 'is waiting for your approval', approved: 'is already approved',
  funded: 'is already running', running: 'is already running', aggregating: 'is already running', closing: 'is already running',
  closed: 'has already finished', cancelled: 'was cancelled', killed: 'was stopped', failed: 'has already failed',
};
const DONE: Record<TaskAction, string> = { approve: 'started', cancel: 'cancelled', stop: 'stopped' };
const FAILED: Record<TaskAction, string> = {
  approve: "Rook couldn't get this task started right now. Try again in a moment.",
  cancel: "Rook couldn't cancel this task right now. Try again in a moment.",
  stop: "Rook couldn't stop this task right now. Try again in a moment.",
};

/**
 * `status`: the orchestrator's HTTP status, or null when it never answered with one. `known` false: the words are the
 * fallback, and the orchestrator's own message belongs in the server log.
 */
export function actionRefusal(action: TaskAction, status: number | null, message: string): { message: string; known: boolean } {
  const known = (text: string) => ({ message: text, known: true });
  if (status === 404 && /^no task /.test(message)) return known("Rook has no task at this link for the wallet you're signed in with.");
  if (status === 409) {
    let m = /^task is (?:already )?(\w+)/.exec(message);
    // Stop is refused only once a task has ended, which says it all.
    if (m) return known(`This task ${NOW[m[1]] ?? `is ${m[1]}`}${action === 'stop' ? '' : `, so it can't be ${DONE[action]}`}.`);
    if (/^the plan has no subtasks/.test(message)) return known("This plan has nothing to run, so it can't be started.");
    if (/^live market: paying agents/.test(message)) return known("Paying live agents isn't switched on yet, so this plan can't be started.");
    m = /already has (\d+) open tasks on the contract/.exec(message);
    if (m) {
      return known(`You already have ${m[1]} funded tasks open on the Rook contract, the most it allows at once. Try again once one of them `
        + 'closes. A task you stopped before it ran closes when you refund it to your wallet.');
    }
    m = /below the contract's minimum of ([\d.]+) USDC/.exec(message);
    if (m) return known(`This task's budget is below the contract's smallest, ${m[1]} USDC. Draft it again with a larger budget.`);
  }
  return { message: FAILED[action], known: false };
}
