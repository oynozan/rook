// Plain words for the run's activity lines: why Rook skipped an agent, and what Rook's own error events mean. The
// services word these for logs and the CLI (runner.ts); the page shows these sentences and keeps the raw text as a
// tooltip. Also the parts a run delivered. Pure functions, so the page and the tests both use them.
import type { SubtaskView } from './orchestrator';

export type DeliveredPart = { id: string; title: string; agent: string | null; text: string };

/**
 * The parts that passed, with what was delivered (paid for, so a run stopped or failed before its report still shows
 * them): a hired agent's text from its accepted hire, Rook's own (agent null) from the accepted text.
 */
export function deliveredParts(subtasks: SubtaskView[], titles: Map<string, string>): DeliveredPart[] {
  return subtasks.flatMap((s) => {
    const a = s.accepted;
    if (s.final_outcome !== 'passed' || !a) return [];
    const own = a.hire_id === null;
    const text = own ? a.text : s.hires?.find((h) => h.id === a.hire_id)?.deliverable_text;
    return text?.trim() ? [{ id: s.id, title: titles.get(s.id) ?? s.title ?? s.id, agent: own ? null : a.agent_handle, text }] : [];
  });
}

const payToElsewhere = "it asked to be paid to an account that isn't the marketplace's";

/** Why Rook skipped an agent at hire time, from runner.ts quote() and hire1() reasons. */
export function skipReason(reason: string): string {
  const rose = reason.match(/^price rose from (\S+) in the approved plan to (\S+)$/);
  if (rose) return `its price went up from ${rose[1]} to ${rose[2]} USDC since you approved the plan`;
  if (/^quote failed: unreachable\b/.test(reason)) return "it didn't answer";
  if (/^quote failed: no_payments\b/.test(reason)) return "it doesn't take USDC on NEAR";
  if (/^quote failed: bad_quote\b/.test(reason)) return "it sent a price Rook can't read";
  if (/^quote failed: no_quote\b/.test(reason)) return "it didn't name a price, so Rook can't pay it";
  if (/^quote failed: \d+\b/.test(reason)) return 'it answered with an error';
  if (/^quote failed/.test(reason)) return "Rook couldn't get its price";
  if (/is not the marketplace treasury/.test(reason)) return payToElsewhere;
  if (/^maxTimeoutSeconds /.test(reason)) return "it asked for a payment window Rook doesn't allow";
  if (/^(scheme|network) .* (is not exact|not accepted)/.test(reason)) return "it asked to be paid in a way the marketplace doesn't accept";
  if (/^invalid amount/.test(reason)) return "its price isn't a valid amount";
  if (/reserve cannot cover/.test(reason)) return 'its price is more than this part has left, even with the reserve';
  if (/^top-up refused/.test(reason)) return "Rook couldn't add to this part from the reserve";
  if (/^authorization refused/.test(reason)) return "Rook couldn't authorize its payment";
  if (/^send failed: 402\b/.test(reason)) return 'it turned the payment down, so nothing was paid';
  if (/^send failed: unreachable\b/.test(reason)) return "it didn't answer, so nothing was paid";
  if (/^send failed/.test(reason)) return "the job didn't reach it, so nothing was paid";
  return "Rook couldn't use its quote";
}

/** A security alert raised on an agent's quote (runner.ts checkQuote), as a line for people. */
export const alertLine = (flag: string, agent?: string) => /is not the marketplace treasury/.test(flag)
  ? `Security alert: ${agent ?? 'an agent'} asked to be paid to an account that isn't the marketplace's.`
  : `Security alert on ${agent ?? 'an agent'}: ${flag}`;

/** `ended`: the agent whose work on the part this line ends, so the run's status stops waiting on it. */
export type ProblemLine = { text: string; tone: 'muted' | 'alert'; label: string; ended?: string };

/**
 * Infers the kind of an error event stored before the services named one, from runner.ts's messages; `agent` is the
 * handle a message starts with, where it names one.
 */
function inferKind(message: string): { kind?: string; agent?: string } {
  const lead = message.match(/^([^\s:]+): /)?.[1];
  if (/^evaluator attempt \d+ failed, retrying/.test(message)) return { kind: 'eval_retry' };
  if (/indexer does not show the payment/.test(message)) return { kind: 'payment_lookup', agent: lead };
  if (/^payment lookup for (\S+):/.test(message)) return { kind: 'payment_lookup', agent: message.match(/^payment lookup for (\S+):/)![1] };
  if (/^receipt on chain:/.test(message)) return { kind: 'receipt' };
  if (/landed on chain although the hire ended unpaid/.test(message)) return { kind: 'paid_anyway', agent: lead };
  if (/^send to (\S+): .*counted as spent$/.test(message)) return { kind: 'paid_anyway', agent: message.match(/^send to (\S+?):/)![1] };
  if (/authorized before the restart/.test(message)) return { kind: 'paid_anyway' };
  if (/delivered, but its payment never showed on chain/.test(message)) return { kind: 'unpaid' };
  if (/^aggregate failed/.test(message)) return { kind: 'aggregate' };
  if (/^restore: /.test(message)) return { kind: 'restore_note' };
  if (/^after a restart Rook could not rebuild/.test(message)) return { kind: 'restore' };
  if (/^evaluation of (\S+) failed, subtask abandoned unjudged/.test(message)) return { kind: 'unchecked', agent: message.match(/^evaluation of (\S+) failed/)![1] };
  if (/^s\d+ abandoned: /.test(message)) return { kind: 'abandoned' };
  if (/^(salvage|after kill|after restart), /.test(message)) return { kind: 'unwind' };
  if (/restarted while this task was/.test(message)) return { kind: 'restart' };
  if (/^planner: /.test(message)) return { kind: 'planner' };
  return {};
}

/**
 * One of Rook's own error events as a line for people (null: nothing to show, another line already says it). Retries
 * and notes are muted; real problems show as alerts but are Rook's, never an agent's flag. `part`: the subtask's title;
 * `hired`: the agent its latest hire went to, which a part given up on is no longer waiting for.
 */
export function problemLine(data: { kind?: string; message?: string; agent_handle?: string }, part?: string, hired?: string): ProblemLine | null {
  const message = data.message ?? '';
  const guess = data.kind ? {} : inferKind(message);
  const kind = data.kind ?? guess.kind;
  const who = data.agent_handle ?? guess.agent;
  const it = part ?? 'this part';
  const note = (text: string): ProblemLine => ({ text, tone: 'muted', label: 'Note' });
  const retry = (text: string): ProblemLine => ({ text, tone: 'muted', label: 'Retrying' });
  const problem = (text: string, ended?: string): ProblemLine => ({ text, tone: 'alert', label: 'Problem', ...(ended ? { ended } : {}) });
  switch (kind) {
    case 'eval_retry': return retry(`Checking ${it} didn't go through, so Rook is trying again.`);
    case 'close_retry': return retry("Sending the unspent USDC back didn't go through yet, so Rook is trying again.");
    case 'return': return retry(`Returning the unspent USDC from ${it} didn't go through yet; Rook tries again before it closes the budget.`);
    case 'payment_lookup': return note(`The payment to ${who ?? 'the agent'} went through; its transaction link isn't available yet.`);
    case 'receipt': return note(`Rook couldn't record ${who ? `${who}'s` : 'a'} receipt on NEAR, so it's kept in Rook's own records.`);
    case 'paid_anyway': return note(who ? `${who}'s payment went through after all, so it counts as spent.` : 'A payment Rook made before it restarted went through, so it counts as spent.');
    case 'unpaid': return null; // the receipt line says it: delivered, nothing paid
    case 'aggregate': return note("Rook couldn't write the report itself, so the report puts the deliverables together as they are.");
    case 'restore_note': return note("Rook restarted and found its records differ from the contract's, so it goes by the contract.");
    case 'abandoned': return problem(`Rook couldn't finish ${it} because of a problem on its side.`, hired);
    case 'unchecked': return problem(`Rook couldn't check ${who ? `${who}'s` : 'the'} work on ${it}, so that part is left out.`, who ?? hired);
    case 'close': return problem('Sending the unspent USDC back hit a problem. Rook is still finishing the refund.');
    case 'unwind': return problem("Rook couldn't send all the unspent USDC back yet. It will try again.");
    case 'run': return problem("The run stopped because of a problem on Rook's side.");
    case 'restore': return /left as it is/.test(message)
      ? problem("Rook restarted and can't pick this task up again on its own. Its USDC stays on the Rook contract until Rook's operator sorts it out.")
      : problem("Rook restarted and couldn't pick this task up again yet. It keeps trying on its own.");
    case 'restart': return problem('Rook restarted during this task, so the run stopped there.');
    case 'planner': return problem("Rook couldn't draft a plan for this task.");
    case 'no_plan': return problem(message);
    default: return problem('Rook hit a problem on its side.');
  }
}
