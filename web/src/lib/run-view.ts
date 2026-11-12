// What each part of a run is doing now, and the run's one-line status. The event stream says what happens as it
// happens; the snapshot (reloaded on payments and status changes) holds the hires, briefs and deliveries. Market agents
// publish no progress while they work (A2A GetTask gives only a state), so between a hire and its delivery all Rook can
// say is who is working and for how long. Pure functions, so the page and the tests both use them.
import { skipReason } from '@/lib/feed';
import { plainText } from '@/lib/report';
import { usdc } from '@/lib/funding';
import type { HireView, PlanView, RookEvent, SubtaskView } from '@/lib/server/orchestrator';

/**
 * ponytail: the services' defaults (services/src/shared/config.ts). A Rook run with another ROOK_PAYMENT_GRACE_S,
 * ROOK_HIRE_PATIENCE_S or ROOK_UNREACHABLE_RETRY_S would need /mode to send them, or the times shown are off.
 */
export const GRACE_S = 600, PATIENCE_S = 720, RETRY_S = 180;

/** How long Rook waits on a hire before it gives up on it (runner.ts slaEnd): the agent's SLA plus a grace, at most 12 min. */
export const patienceS = (sla: number) => Math.min(Math.max(0, sla || 0) + GRACE_S, PATIENCE_S);

/** What one part is doing. Times are milliseconds on Rook's clock (its events' ts and its hires' started_at). */
export type Phase =
  | { kind: 'waiting' } // not started
  | { kind: 'next' } // between hires, nothing more specific known
  | { kind: 'quoting'; agent: string }
  | { kind: 'sending'; agent: string } // price checked: authorizing the payment and sending the job
  | { kind: 'working'; agent: string; hire_id?: string; since: number; until: number }
  | { kind: 'moving_on'; agent: string } // timed out or didn't deliver: its payment is being released
  | { kind: 'retry_wait'; agent: string; at: number }
  | { kind: 'settling'; agent: string } // delivered: its payment is being settled before the work is checked
  | { kind: 'checking'; agent: string | null } // null: Rook's own work
  | { kind: 'writing' } // Rook writes it itself
  | { kind: 'done'; outcome: 'passed' | 'abandoned' | 'stopped' };

type PlanSub = PlanView['subtasks'][number];
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** The phase a part is in after `events` (all of the run's; only this part's count), and when it began. */
export function phaseOf(sub: PlanSub, events: RookEvent[], hires: HireView[] = []): { phase: Phase; at: number } {
  let phase: Phase = { kind: 'waiting' }, at = 0;
  let self = sub.self_do, last: string | null = null;
  const seen = new Set<string>(); // the agents Rook got to, in the plan's order (runner.ts hireLoop)
  const sla = (a: string) => sub.candidates.find((c) => c.handle === a)?.sla_seconds ?? 0;
  const next = (): Phase => {
    const c = sub.candidates.find((x) => !seen.has(x.handle));
    return c ? { kind: 'quoting', agent: c.handle } : { kind: 'next' };
  };
  const working = (agent: string, hire_id: string | undefined, ts: number): Phase => {
    const h = hire_id ? hires.find((x) => x.id === hire_id) : undefined;
    const since = Number.isFinite(ms(h?.started_at)) ? ms(h?.started_at) : ts;
    return { kind: 'working', agent, ...(hire_id ? { hire_id } : {}), since, until: since + patienceS(sla(agent)) * 1000 };
  };
  for (const e of events) {
    if (e.subtask_id !== sub.id) continue;
    const ts = ms(e.ts);
    const a: string | undefined = e.data?.agent_handle;
    let to: Phase | null = null;
    if (e.type === 'subtask_status') {
      const s = e.data?.to;
      if (s === 'quoting') to = next();
      else if (s === 'working' && self) to = { kind: 'writing' };
      else if (s === 'working' && phase.kind !== 'working') {
        // A hire picked up again after a restart: no hire_sent this time, the snapshot names it.
        const h = hires.at(-1);
        if (h && !h.ended_at) to = working(h.agent_handle, h.id, ts);
      }
      else if (s === 'evaluating') to = { kind: 'checking', agent: self ? null : last };
      else if (s === 'passed' || s === 'abandoned') to = { kind: 'done', outcome: s };
      else if (s === 'returned' && phase.kind !== 'done') to = { kind: 'done', outcome: 'stopped' };
    } else if (e.type === 'quote' && a) { seen.add(a); to = { kind: 'sending', agent: a }; }
    else if (e.type === 'quote_rejected' && a) { seen.add(a); to = next(); }
    else if (e.type === 'hire_sent' && a) { seen.add(a); last = a; to = working(a, e.data?.hire_id, ts); }
    else if (e.type === 'a2a_state' && a) {
      last = a;
      const s = e.data?.state;
      if (['TIMEOUT', 'DECLINED', 'FAILED', 'REJECTED', 'CANCELED'].includes(s)) to = { kind: 'moving_on', agent: a };
      else if (s === 'COMPLETED') to = { kind: 'settling', agent: a };
      else if (phase.kind !== 'working' || phase.agent !== a) to = working(a, e.data?.hire_id, ts);
    }
    // Released: Rook is done with that agent and hires the next one in the same breath.
    else if (e.type === 'ledger' && e.data?.op === 'release' && phase.kind === 'moving_on') to = next();
    else if (e.type === 'evaluation' && e.data?.verdict === 'fail') to = self ? { kind: 'writing' } : next();
    else if (e.type === 'error' && e.data?.kind === 'unreachable_retry' && a) to = { kind: 'retry_wait', agent: a, at: ts + RETRY_S * 1000 };
    else if (e.type === 'error' && e.data?.kind === 'rook_writes') { self = true; to = { kind: 'writing' }; }
    if (to) { phase = to; at = Number.isFinite(ts) ? ts : at; }
  }
  return { phase, at };
}

const minutes = (span: number) => Math.max(0, Math.floor(span / 60_000));

/** A span of time, as the progress view shows it: "45 s", "12 min 5 s", "1 h 3 min". */
export function span(msLong: number): string {
  const s = Math.max(0, Math.floor(msLong / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ''}`;
}

/** A span rounded to the minute, for what already happened: "45 s", "30 min". */
const roughly = (msLong: number) => (msLong < 60_000 ? span(msLong) : `${Math.round(msLong / 60_000)} min`);

/** How the status line shows a phase: an AiStatus state, its words, and the detail after them. */
export type Line = { state: string; label: string; detail?: string };

/** `time`: a clock time in the reader's zone ("14:05"). */
export type Clock = { now: number; time: (at: number) => string };

/** A part's status in plain words, and what the run's status line says about it (null: nothing specific to say). */
export function phaseWords(p: Phase, clock: Clock, title: string): { status: string; line: Line | null } {
  switch (p.kind) {
    case 'waiting': return { status: 'Not started yet', line: null };
    case 'next': return { status: 'Finding the next agent', line: null };
    case 'quoting': return { status: `Getting ${p.agent}'s price`, line: { state: 'researching', label: `Getting ${p.agent}'s price` } };
    case 'sending': return { status: `Sending the job to ${p.agent}`, line: { state: 'researching', label: `Sending the job to ${p.agent}` } };
    case 'working': {
      const total = Math.round((p.until - p.since) / 60_000);
      if (clock.now >= p.until) return { status: `Giving up on ${p.agent}: nothing came in ${total} min`, line: { state: 'analyzing', label: `Giving up on ${p.agent}`, detail: `nothing in ${total} min` } };
      return { status: `${p.agent} is working on it`, line: { state: 'analyzing', label: `Waiting on ${p.agent}`, detail: `${minutes(clock.now - p.since)} of ${total} min` } };
    }
    case 'moving_on': return { status: `Moving on from ${p.agent}`, line: { state: 'analyzing', label: `Moving on from ${p.agent}` } };
    case 'retry_wait': {
      const words = clock.now < p.at ? `Asking ${p.agent} again at ${clock.time(p.at)}` : `Asking ${p.agent} again`;
      return { status: `${p.agent} couldn't take the job. ${words}`, line: { state: 'researching', label: words } };
    }
    case 'settling': return { status: `${p.agent} delivered. Settling its payment`, line: { state: 'analyzing', label: `Settling ${p.agent}'s payment` } };
    case 'checking': {
      const words = p.agent ? `Checking ${p.agent}'s work` : "Checking Rook's own work";
      return { status: words, line: { state: 'analyzing', label: words } };
    }
    case 'writing': return { status: 'Rook is writing it', line: { state: 'writing', label: 'Rook is writing', detail: title } };
    case 'done': return { status: p.outcome === 'passed' ? 'Done. It passed every check' : p.outcome === 'abandoned' ? "Couldn't be done" : 'Stopped', line: null };
  }
}

/** One agent Rook tried for a part, and what came of it. money: what it cost, or what it is quoted while it runs. */
export type TriedRow = { key: string; agent: string; outcome: string; money?: string; tone: 'normal' | 'muted' | 'alert' };

export type PartView = {
  id: string; title: string; brief: string | null; self: boolean;
  /** Rook hired an agent for it, so its brief went out (a quote it turned down sent nothing). */
  sent: boolean;
  status: string; tone: 'active' | 'idle' | 'passed' | 'failed';
  /** The agent working on it now: since when, and when Rook gives up on it. */
  // said: the newest thing the working agent wrote while working, as it wrote it (untrusted; most agents say nothing).
  working: { agent: string; since: number; until: number; said: string | null } | null;
  tried: TriedRow[];
  /** A passed part's delivery, cut short; by: the agent, null for Rook's own work. */
  delivered: { by: string | null; preview: string } | null;
  /** When its phase began, and what the run's status line says about it. */
  at: number; line: Line | null;
};

/** The newest message `agent` sent while working on part `id`, or null: shown live under the part, as written. */
export function saidBy(events: RookEvent[], id: string, agent: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'agent_message' && e.subtask_id === id && e.data?.agent_handle === agent && typeof e.data?.text === 'string') return e.data.text;
  }
  return null;
}

/** What one hire came to, in plain words. `settled`: Rook's books are done with its payment (released or settled). */
function hireRow(h: HireView, settled: boolean): TriedRow {
  const took = ms(h.ended_at) - ms(h.started_at);
  const after = Number.isFinite(took) ? ` after ${roughly(took)}` : '';
  const [outcome, tone]: [string, TriedRow['tone']] =
    h.state === 'COMPLETED' ? (h.verdict === 'pass' ? ['Delivered and passed every check', 'normal'] : h.verdict === 'fail' ? ['Delivered, but failed a check', 'alert'] : ['Delivered', 'normal'])
    : h.state === 'TIMEOUT' ? [`Timed out${after}`, 'muted']
    : h.state === 'DECLINED' ? [`Said it couldn't do it${after}`, 'muted']
    : h.state === 'SEND_FAILED' ? ["Couldn't take the job", 'muted']
    : h.state === 'FAILED' || h.state === 'REJECTED' || h.state === 'CANCELED' ? ["Didn't deliver", 'muted']
    : h.state === 'KILLED' ? ['Stopped with the task', 'muted']
    : h.state === 'OUTCOME_UNKNOWN' ? ['Its payment went through, but no delivery came back', 'alert']
    : h.state === 'SENDING' ? ['Sending it the job', 'normal']
    : ['Working on it', 'normal'];
  const amount = h.amount_atomic ? usdc(h.amount_atomic) : null;
  const money = h.paid ? (amount ? `Paid ${amount} USDC` : 'Paid')
    : settled ? 'Not paid'
    : amount ? `Quoted ${amount} USDC` : undefined;
  return { key: h.id, agent: h.agent_handle, outcome, tone, ...(money ? { money } : {}) };
}

/**
 * A part's hires as the events have them by now. The snapshot is reloaded on payments, so between them (an agent's
 * whole working time) its newest hire can still read as being sent, or be missing.
 */
function liveHires(hires: HireView[], events: RookEvent[], id: string): HireView[] {
  const out = hires.map((h) => ({ ...h }));
  for (const e of events) {
    const hid: string | undefined = e.data?.hire_id;
    if (e.subtask_id !== id || !hid) continue;
    let h = out.find((x) => x.id === hid);
    if (!h && e.type === 'hire_sent') {
      out.push({ id: hid, agent_handle: e.data.agent_handle, deliverable_text: null, state: 'SUBMITTED', started_at: e.ts, ended_at: null, amount_atomic: e.data.amount_atomic, paid: false });
      continue;
    }
    if (!h || h.ended_at) continue; // the snapshot already has how it ended
    if (e.type === 'a2a_state') {
      h.state = e.data.state;
      if (['TIMEOUT', 'DECLINED', 'FAILED', 'REJECTED', 'CANCELED'].includes(e.data.state)) h.ended_at = e.ts ?? null;
    } else if (e.type === 'evaluation') h.verdict = e.data.verdict;
  }
  return out;
}

/**
 * Text cut to about `max` characters at a word, as one line of plain words (report.ts plainText): no Markdown marks or
 * rules, a table's cells side by side, and a fenced code block as "(code, N lines)": the code itself is in the report's
 * files, and its first lines say nothing (a web page opened with "<!DOCTYPE html>").
 */
export function preview(text: string, max = 280): string {
  const flat = plainText(text);
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max).trimEnd()}…`;
}

/**
 * Every part of the plan as the progress view shows it. `ended`: the task stopped or finished, so a part still
 * mid-way says "Stopped", not what it was doing.
 */
export function partViews(plan: PlanView, subtasks: SubtaskView[] | undefined, events: RookEvent[], clock: Clock, ended: boolean): PartView[] {
  return plan.subtasks.map((p) => {
    const s = subtasks?.find((x) => x.id === p.id);
    const hires = liveHires(s?.hires ?? [], events, p.id);
    let { phase, at } = phaseOf(p, events, hires);
    if (ended && phase.kind !== 'done') phase = { kind: 'done', outcome: s?.final_outcome ?? 'stopped' };
    else if (phase.kind === 'waiting' && s?.final_outcome) phase = { kind: 'done', outcome: s.final_outcome }; // an older run's events
    const words = phaseWords(phase, clock, p.title);

    // Each hire's payment ends in one release or settle; counted per agent, as one agent can be hired twice for a part.
    const closed = new Map<string, number>();
    const rejected: { key: string; agent: string; reason: string; at: number }[] = [];
    for (const e of events) {
      if (e.subtask_id !== p.id) continue;
      const a = e.data?.agent_handle;
      if (e.type === 'ledger' && (e.data?.op === 'release' || e.data?.op === 'settle') && a) closed.set(a, (closed.get(a) ?? 0) + 1);
      // A failed send has its own hire (SEND_FAILED), which says so.
      if (e.type === 'quote_rejected' && a && !/^send failed/.test(e.data?.reason ?? '')) rejected.push({ key: `q${e.seq}`, agent: a, reason: e.data.reason, at: ms(e.ts) });
    }
    const nth = new Map<string, number>();
    const rows = hires.map((h) => {
      const i = nth.get(h.agent_handle) ?? 0;
      nth.set(h.agent_handle, i + 1);
      return { at: ms(h.started_at), row: hireRow(h, i < (closed.get(h.agent_handle) ?? 0)) };
    });
    for (const r of rejected) {
      const why = skipReason(r.reason);
      rows.push({ at: r.at, row: { key: r.key, agent: r.agent, outcome: `Skipped: ${why}`, tone: 'muted' } });
    }
    rows.sort((x, y) => (x.at || 0) - (y.at || 0));

    const a = s?.accepted;
    const text = a ? (a.hire_id === null ? a.text : hires.find((h) => h.id === a.hire_id)?.deliverable_text) : null;
    const passed = phase.kind === 'done' && phase.outcome === 'passed';
    return {
      id: p.id, title: p.title, brief: p.brief?.trim() || null, self: p.self_do, sent: hires.length > 0,
      status: words.status,
      tone: phase.kind === 'done' ? (phase.outcome === 'passed' ? 'passed' : 'failed') : phase.kind === 'waiting' ? 'idle' : 'active',
      working: phase.kind === 'working' ? { agent: phase.agent, since: phase.since, until: phase.until, said: saidBy(events, p.id, phase.agent) } : null,
      tried: rows.map((r) => r.row),
      delivered: passed && text?.trim() ? { by: a!.hire_id === null ? null : a!.agent_handle, preview: preview(text) } : null,
      at, line: words.line,
    };
  });
}

/**
 * The run's header, in its own words: running, stopped, a problem, or finished, and when finished, which parts
 * delivered nothing (`missing`: their titles, of `parts`), so a run without its website never just says "Finished.".
 */
export function runHeadline(o: { live: boolean; status: string; report: boolean; missing: string[]; parts: number }): string {
  if (o.live) return 'Running.';
  if (o.status === 'killed') return 'Stopped.';
  // Failed with a report: the work finished and only the refund hit a problem, which the money card says.
  if (o.status === 'failed' && !o.report) return 'This run hit a problem.';
  const n = o.missing.length;
  if (n && n >= o.parts) return o.parts === 1 ? `Finished without “${o.missing[0]}”: nothing was delivered.` : 'Finished, but no part was delivered.';
  if (n === 1) return `Finished without “${o.missing[0]}”.`;
  if (n > 1) return `Finished without ${n} of its ${o.parts} parts.`;
  return 'Finished.';
}

/**
 * The run's status line: what the part that moved last is doing, and how many others are under way too. Null when no
 * part is doing anything specific (between hires): then the page says it is lining up the next hire.
 */
export function nowLine(parts: PartView[]): Line | null {
  const busy = parts.filter((p) => p.line).sort((x, y) => y.at - x.at);
  if (!busy.length) return null;
  const [first, ...rest] = busy;
  const more = rest.length ? `and ${rest.length} other part${rest.length === 1 ? '' : 's'}` : '';
  const { state, label, detail } = first.line!;
  const all = [detail, more].filter(Boolean).join(' · ');
  return all ? { state, label, detail: all } : { state, label };
}
