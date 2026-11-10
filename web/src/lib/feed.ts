// Plain words for the run's activity lines: why Rook skipped an agent, and what Rook's own error events mean. The
// services word these for logs and the CLI (runner.ts); the page shows these sentences and keeps the raw text as a
// tooltip. Also the parts a run delivered. Pure functions, so the page and the tests both use them.
import { detail } from '@/lib/errors';
import { usdc } from '@/lib/funding';
import { plannerReason } from '@/lib/planner';
import type { RookEvent, SubtaskView } from '@/lib/server/orchestrator';

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

/**
 * A send that never reached the agent (a "send failed" reason), as one line: what happened, then that nothing was paid.
 * `fore`: " for <part>" when the run has more than one part.
 */
export function sendFailedLine(agent: string, reason: string, fore = ''): string {
  if (/^send failed: 402\b/.test(reason)) return `${agent} turned down the payment${fore}, so nothing was paid.`;
  if (/^send failed: unreachable\b/.test(reason)) return `${agent} didn't answer when Rook sent the job${fore}, so nothing was paid.`;
  return `The job${fore} didn't reach ${agent}, so nothing was paid.`;
}

/** A security alert raised on an agent's quote (runner.ts checkQuote), as a line for people. */
export const alertLine = (flag: string, agent?: string) => /is not the marketplace treasury/.test(flag)
  ? `Security alert: ${agent ?? 'an agent'} asked to be paid to an account that isn't the marketplace's.`
  : `Security alert on ${agent ?? 'an agent'}: ${flag}`;

export type ProblemLine = { text: string; tone: 'muted' | 'alert'; label: string };

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
 * and notes are muted; real problems show as alerts but are Rook's, never an agent's flag. `part`: the subtask's title.
 */
export function problemLine(data: { kind?: string; message?: string; agent_handle?: string }, part?: string): ProblemLine | null {
  const message = data.message ?? '';
  const guess = data.kind ? {} : inferKind(message);
  const kind = data.kind ?? guess.kind;
  const who = data.agent_handle ?? guess.agent;
  const it = part ?? 'this part';
  const note = (text: string): ProblemLine => ({ text, tone: 'muted', label: 'Note' });
  const retry = (text: string): ProblemLine => ({ text, tone: 'muted', label: 'Retrying' });
  const problem = (text: string): ProblemLine => ({ text, tone: 'alert', label: 'Problem' });
  // What the event says went wrong, after the prefix that names its kind: " (why)", or nothing when it says nothing.
  const why = (prefix?: RegExp) => { const d = detail(prefix ? message.replace(prefix, '') : message); return d ? ` (${d})` : ''; };
  switch (kind) {
    case 'eval_retry': return retry(`Checking ${it} didn't go through, so Rook is trying again.`);
    case 'close_retry': return retry("Sending the unspent USDC back didn't go through yet, so Rook is trying again.");
    case 'return': return retry(`Returning the unspent USDC from ${it} didn't go through yet; Rook tries again before it closes the budget.`);
    case 'payment_lookup': return note(`The payment to ${who ?? 'the agent'} went through; its transaction link isn't available yet.`);
    case 'receipt': return note(`Rook couldn't record ${who ? `${who}'s` : 'a'} receipt on NEAR${why(/^receipt on chain: /)}, so it's kept in Rook's own records.`);
    case 'paid_anyway': return note(who ? `${who}'s payment went through after all, so it counts as spent.` : 'A payment Rook made before it restarted went through, so it counts as spent.');
    case 'unpaid': return null; // the receipt line says it: delivered, nothing paid
    case 'aggregate': return note("Rook couldn't write the report itself, so the report puts the deliverables together as they are.");
    case 'unreachable_retry': return retry(`${who ?? 'The agent'} couldn't take the job just now, so Rook asks it again in a few minutes.`);
    case 'rook_writes': return note(`No agent could deliver ${it}, so Rook writes it itself. That part's USDC goes back to you.`);
    case 'restore_note': return note("Rook restarted and found its records differ from the contract's, so it goes by the contract.");
    case 'abandoned': return problem(`Rook couldn't finish ${it} because of a problem on its side${why(/^\S+ abandoned: /)}.`);
    case 'unchecked': return problem(`Rook couldn't check ${who ? `${who}'s` : 'the'} work on ${it}${why(/^evaluation of \S+ failed, subtask abandoned unjudged: /)}, so that part is left out.`);
    case 'close': return problem(`Sending the unspent USDC back hit a problem${why()}. Rook is still finishing the refund.`);
    case 'unwind': return problem(`Rook couldn't send all the unspent USDC back yet${why(/^(salvage|after kill|after restart), /)}. It will try again.`);
    case 'run': return problem(`The run stopped because of a problem on Rook's side${why()}.`);
    case 'restore': return /left as it is/.test(message)
      ? problem(`Rook restarted and can't pick this task up again on its own${why()}. Its USDC stays on the Rook contract until Rook's operator sorts it out.`)
      : problem(`Rook restarted and couldn't pick this task up again yet${why(/^after a restart Rook could not rebuild[^:]*: /)}. It keeps trying on its own.`);
    case 'restart': return problem('Rook restarted during this task, so the run stopped there.');
    case 'planner': return problem(`Rook couldn't draft a plan for this task: ${plannerReason(message)}`);
    case 'no_plan': return problem(message);
    default: return problem(`Rook hit a problem on its side${why()}.`);
  }
}

/** What the run's status says a line means, while the page replays the lines one by one. */
export type Now = { state: string; label: string; detail?: string };
/** detail: the raw text behind a reworded line, as a tooltip. flag: an agent's delivery or quote was flagged (what "flagged" counts). */
export type FeedLine = {
  key: number; text: string; tone: 'normal' | 'muted' | 'alert'; now: Now; paid?: number; fromReserve?: number; detail?: string; flag?: true;
};
/** What the feed needs from the plan: titles by subtask, the self_do ones, and whether no agent is hired at all. */
export type FeedContext = { titles: Map<string, string>; selfDo: Set<string>; free: boolean; simNote: string };

/**
 * Turns the run's events into plain lines. Agent text is never shown as instructions: only handles and Rook's verdicts.
 * With more than one part, a line about an agent names its part: parts run side by side, and one agent can be hired
 * for two of them.
 */
export function feedFrom(events: RookEvent[], ctx: FeedContext): FeedLine[] {
  const lines: FeedLine[] = [];
  let receipt = 0;
  const hired = new Map<string | undefined, string>(); // subtask -> the agent its payment authorization is for
  const tries = new Map<string, number>(); // self_do subtask -> times Rook started on it
  const part = (id?: string) => (id && ctx.titles.get(id)) || 'this part';
  const named = (id?: string) => (ctx.titles.size > 1 && id && ctx.titles.get(id)) || '';
  // A failed send and its release say the same thing: the newest "No charge" line, and a failed send with no release yet.
  let released: { at: number; who: string } | null = null;
  let unsent: string | null = null;
  for (const { seq: key, type, data, subtask_id } of events) {
    const agent = data?.agent_handle;
    if ((type === 'quote' || type === 'hire_sent') && unsent === `${subtask_id}:${agent}`) unsent = null; // asked again: a new hire
    const self = !!subtask_id && ctx.selfDo.has(subtask_id);
    const title = named(subtask_id);
    const on = title ? ` on ${title}` : '', fore = title ? ` for ${title}` : '';
    if (agent && (type === 'hire_sent' || (type === 'ledger' && data.op === 'clearing'))) hired.set(subtask_id, agent);
    if (type === 'hire_sent') lines.push({ key, text: `Hired ${agent}${fore}, quoted ${usdc(data.amount_atomic)} USDC.`, tone: 'normal', now: { state: 'researching', label: 'Hired', detail: agent } });
    // Rook does a self_do part with its own model: no hire, so never "rook:self-do" or a hire's wording.
    else if (type === 'subtask_status' && self && data.to === 'working') {
      const n = (tries.get(subtask_id!) ?? 0) + 1;
      tries.set(subtask_id!, n);
      const it = part(subtask_id);
      lines.push({ key, text: n === 1 ? `Rook is doing ${it} itself.` : `Rook is trying ${it} again.`, tone: 'normal', now: { state: 'writing', label: 'Rook is working on', detail: it } });
    }
    else if (type === 'evaluation' && (self || agent === 'rook:self-do')) {
      const it = part(subtask_id), pass = data.verdict === 'pass';
      lines.push({ key, text: `Rook's own work on ${it} ${pass ? 'passed every check' : 'failed a check'}.`, tone: 'normal', now: { state: 'analyzing', label: pass ? 'Passed' : 'Failed a check', detail: it } });
    }
    // Whether an unpaid hire cost anything is known only once its authorization is released (it can still land).
    else if (type === 'a2a_state' && ['FAILED', 'REJECTED', 'CANCELED'].includes(data.state)) lines.push({ key, text: `${agent} didn't deliver${on}.`, tone: 'normal', now: { state: 'analyzing', label: 'No delivery', detail: agent } });
    else if (type === 'a2a_state' && data.state === 'TIMEOUT') lines.push({ key, text: `${agent} timed out${on}.`, tone: 'normal', now: { state: 'analyzing', label: 'Timed out', detail: agent } });
    else if (type === 'ledger' && data.op === 'release' && data.settled === false) {
      const who = agent ?? hired.get(subtask_id);
      // A send that failed already said nothing was paid: its release says it again.
      if (unsent === `${subtask_id}:${who}`) { unsent = null; continue; }
      lines.push({ key, text: `No charge${who ? ` for ${who}` : ''}${on}: its payment authorization was released unpaid.`, tone: 'muted', now: { state: 'analyzing', label: 'No charge', detail: who } });
      released = { at: lines.length - 1, who: `${subtask_id}:${who}` };
      continue;
    }
    // The job never reached the agent (runner.ts hire1): cause first, then that nothing was paid, in one line in
    // place of its release's "No charge" line. Not "Skipped": Rook did try it.
    else if (type === 'quote_rejected' && /^send failed/.test(data.reason ?? '')) {
      const line: FeedLine = { key, text: sendFailedLine(agent, data.reason, fore), detail: data.reason, tone: 'muted', now: { state: 'researching', label: 'Not reached', detail: agent } };
      if (released?.who === `${subtask_id}:${agent}` && released.at === lines.length - 1) lines[released.at] = line;
      else { lines.push(line); unsent = `${subtask_id}:${agent}`; }
      released = null;
      continue;
    }
    else if (type === 'evaluation') {
      if (data.verdict === 'pass') lines.push({ key, text: `${agent} passed every check${on}.`, tone: 'normal', now: { state: 'analyzing', label: 'Passed', detail: agent } });
      else if (data.failed_criteria?.includes('injection')) lines.push({ key, text: `${agent}'s delivery${fore} tried to give Rook instructions. Flagged and rejected.`, tone: 'alert', flag: true, now: { state: 'analyzing', label: 'Flagged', detail: agent } });
      else lines.push({ key, text: `${agent} failed a check${on}.`, tone: 'alert', flag: true, now: { state: 'analyzing', label: 'Failed a check', detail: agent } });
    } else if (type === 'security_alert' && data.source === 'quote') lines.push({ key, text: alertLine(data.flag, agent), detail: data.flag, tone: 'alert', flag: true, now: { state: 'analyzing', label: 'Security alert' } });
    else if (type === 'quote_rejected') lines.push({ key, text: `Skipped ${agent}${fore}: ${skipReason(data.reason)}.`, detail: data.reason, tone: 'muted', now: { state: 'researching', label: 'Skipped', detail: agent } });
    else if (type === 'ledger' && data.op === 'topUp') lines.push({ key, text: `Topped up ${usdc(data.amount_atomic)} USDC from the reserve${fore}.`, tone: 'muted', fromReserve: Number(data.amount_atomic), now: { state: 'analyzing', label: 'Topped up', detail: `${usdc(data.amount_atomic)} USDC` } });
    else if (type === 'receipt' && data.amount_atomic === '0') lines.push({ key, text: `Receipt ${++receipt}: ${agent} delivered${on}, but no payment showed on chain, so nothing was paid.`, tone: 'muted', now: { state: 'analyzing', label: 'Unpaid', detail: agent } });
    else if (type === 'receipt') lines.push({ key, text: `Receipt ${++receipt}: paid ${usdc(data.amount_atomic)} USDC to ${agent}${fore}.`, tone: 'muted', paid: Number(data.amount_atomic), now: { state: 'analyzing', label: 'Paid', detail: agent } });
    // What happens to the money after a kill, a failure or a restart (runner.ts unwind and restoreTask). Older kill
    // events carried a near-cli command (human_action) for the funder: never shown, the unwind refunds on its own.
    else if (type === 'ledger' && data.op === 'kill') {
      const text = ctx.free ? 'Stopped.' : data.returning || data.human_action
        ? "Stopped. Rook pays no more agents and is sending what's left back to your wallet."
        : 'Stopped. Rook pays no more agents.';
      lines.push({ key, text, tone: 'muted', now: { state: 'analyzing', label: 'Stopped' } });
    }
    else if (type === 'ledger' && data.op === 'clearing') lines.push({ key, text: data.how === 'void' ? `Cancelling the unused payment to ${data.agent_handle ?? 'an agent'} on NEAR before returning its funds.` : `Waiting for ${data.agent_handle ?? 'an agent'}'s payment authorization to ${data.how === 'terminal' ? 'clear' : 'settle or expire'} before returning its funds.`, tone: 'muted', now: { state: 'analyzing', label: 'Clearing', detail: data.agent_handle ?? undefined } });
    // The contract's own task id means nothing to the user; the line keeps it as its tooltip.
    else if (type === 'ledger' && data.op === 'restored') lines.push({ key, text: 'Rook restarted and picked this task up again.', ...(data.contract_task_id != null ? { detail: `contract task ${data.contract_task_id}` } : {}), tone: 'muted', now: { state: 'analyzing', label: 'Restored' } });
    // A plan that hires no agent held no money: no budget to close, nothing refunded.
    else if (type === 'ledger' && data.op === 'closeTask' && data.amount_atomic != null && !ctx.free) lines.push({ key, text: `Closed the budget: ${usdc(data.amount_atomic)} USDC went back to your wallet${ctx.simNote}.`, tone: 'muted', now: { state: 'analyzing', label: 'Closed' } });
    // Rook's own errors: plain words, the raw text as a tooltip, never counted as an agent's flag.
    else if (type === 'error') {
      const p = problemLine(data ?? {}, subtask_id && ctx.titles.get(subtask_id));
      if (p) lines.push({ key, text: p.text, tone: p.tone, detail: data?.message, now: { state: 'analyzing', label: p.label } });
    }
  }
  return lines;
}
