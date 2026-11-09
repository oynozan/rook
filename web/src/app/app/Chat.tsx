'use client';

import { AnimatePresence, motion } from 'motion/react';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Mark } from '@/components/Navbar';
import { useSmoothScroll } from '@/components/SmoothScroll';
import { AiStatus } from '@/components/ui/ai-status';
import { WebSearch, type WebSource } from '@/components/ui/web-search';
import { approve, cancel, draftTask, stop } from './actions';
import { go } from './AppShell';
import { Composer, type ComposerErrors } from './Composer';
import type { Candidate, PlanView, RookEvent, TaskSnapshot, TaskSummary } from './orchestrator';
import { useMode } from './mode';
import { useEase } from './useEase';
import { useWallet } from './wallet';

const TERMINAL = new Set(['closed', 'cancelled', 'killed', 'failed']);
const usdc = (atomic: string | number | bigint) => (Number(atomic) / 1e6).toFixed(2);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const LINE_MS = 420;
const CATCH_UP_MS = 70; // a refresh mid-run replays history quickly, then returns to the live pace
const AGENT_MS = 320; // agents land one at a time, then the plan they make up
const AGENTS_MAX_MS = 2400;
const CARDS_OPEN_MS = 550; // how long the agent cards take to open, so following waits for their full height
const FOLLOW_HOLD_MS = 150; // after the reader scrolls up, how long scroll events can't resume following

// ---- loading one task ----

type Loaded = { snap: TaskSnapshot | null; events: RookEvent[]; problem: 'missing' | 'signin' | 'down' | null; refetch: () => void };

function useTask(id: string | null): Loaded {
  const [snap, setSnap] = useState<TaskSnapshot | null>(null);
  const [events, setEvents] = useState<RookEvent[]>([]);
  const [problem, setProblem] = useState<Loaded['problem']>(null);

  const refetch = useCallback(() => {
    if (!id) return;
    fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 404) return setProblem('missing');
        if (r.status === 401) return setProblem('signin');
        if (!r.ok) return setProblem('down');
        setProblem(null);
        setSnap(await r.json());
      })
      .catch(() => setProblem('down'));
  }, [id]);

  useEffect(() => {
    setSnap(null);
    setEvents([]);
    setProblem(null);
    if (!id) return;
    refetch();
    const source = new EventSource(`/api/tasks/${encodeURIComponent(id)}/events`);
    const seen = new Set<number>();
    const types = ['task_status', 'planning', 'plan', 'quote_rejected', 'hire_sent', 'a2a_state', 'evaluation', 'security_alert', 'ledger', 'receipt', 'final', 'error'];
    const onEvent = (m: MessageEvent) => {
      // The browser fires its own 'error' event, with no data, when the connection drops or is refused (signed out,
      // not your task, services restarting). That shares a name with Rook's 'error' events, so skip anything empty.
      if (typeof m.data !== 'string' || !m.data) return;
      let e: RookEvent;
      try { e = JSON.parse(m.data); } catch { return; }
      if (seen.has(e.seq)) return;
      seen.add(e.seq);
      setEvents((all) => [...all, e]);
      if (e.type === 'task_status' || e.type === 'final') refetch();
      if (e.type === 'task_status' && TERMINAL.has(e.data.to)) source.close(); // otherwise EventSource reconnects forever
    };
    types.forEach((t) => source.addEventListener(t, onEvent as EventListener));
    return () => source.close();
  }, [id, refetch]);

  // Just after switching tasks the state still holds the old task for one render: never show it as the new one.
  return { snap: snap?.task.id === id ? snap : null, events, problem, refetch };
}

// ---- pieces of the thread ----

function UserMessage({ prompt, budget, animate }: { prompt: string; budget: string; animate?: boolean }) {
  return (
    <div className={`flex justify-end ${animate ? 'rook-in' : ''}`}>
      <div className="max-w-[85%] rounded-3xl rounded-br-md bg-ink/5 px-4 py-2.5 sm:px-5 sm:py-3">
        <p className="leading-snug whitespace-pre-wrap sm:text-lg">{prompt}</p>
        <p className="mt-1 text-right text-sm text-ink/65">Budget {budget} USDC</p>
      </div>
    </div>
  );
}

function RookMessage({ children, still }: { children: ReactNode; still?: boolean }) {
  return (
    <div className={`flex gap-3 ${still ? '' : 'rook-in'}`}>
      {/* On a phone the width matters more than the logo: Rook is already everything that isn't in a bubble. */}
      <span className="mt-0.5 flex h-7 shrink-0 items-center max-sm:hidden [&>svg]:size-5" aria-hidden="true"><Mark /></span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Rook is working: the logo's three blocks take turns. */
function Working({ label }: { label: string }) {
  return (
    <p role="status" className="flex h-7 items-center gap-2.5 text-ink/65">
      <span className="rook-blocks flex items-center gap-1" aria-hidden="true">
        <span className="size-2 bg-accent" /><span className="size-2 bg-accent" /><span className="size-2 bg-accent" />
      </span>
      {label}
    </p>
  );
}

function ActionButton({ onClick, busy, disabled, title, primary, children }: { onClick: () => void; busy?: boolean; disabled?: boolean; title?: string; primary?: boolean; children: ReactNode }) {
  const off = disabled || busy;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      title={title}
      className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 font-medium whitespace-nowrap transition-colors max-sm:grow sm:px-5 duration-200 motion-reduce:transition-none ${
        primary
          ? disabled ? 'cursor-not-allowed bg-ink/10 text-ink/55' : `bg-accent text-on-accent ${busy ? 'cursor-wait' : 'cursor-pointer hover:bg-accent-hover active:translate-y-px'}`
          : `border border-ink/25 ${off ? 'cursor-wait text-ink/55' : 'cursor-pointer hover:border-ink hover:bg-ink/5 active:translate-y-px'}`
      }`}
    >
      {children}
    </button>
  );
}

/** Opens and closes by height. */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const ease = useEase();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={ease}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** What a subtask can cost: Rook's own work, a free agent, or a cap in USDC. */
function CapLabel({ subtask: s }: { subtask: PlanView['subtasks'][number] }) {
  const free = !s.self_do && BigInt(s.cap_atomic) === 0n && s.candidates.length > 0 && BigInt(s.candidates[0].price_atomic) === 0n;
  const words = s.self_do ? 'Rook does this' : free ? 'Free' : null;
  return (
    <span title={s.self_do ? 'No agent is hired: Rook does this part with its own model' : free ? 'The cheapest agent quoted 0 USDC; paid re-hires come from the reserve' : undefined}
      className={`shrink-0 pl-3 text-sm text-ink/65 sm:pl-0 ${words ? '' : 'font-mono'}`}>
      {words ?? `Cap ${usdc(s.cap_atomic)}`}
    </span>
  );
}

function PlanRow({ subtask: s }: { subtask: PlanView['subtasks'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer flex-col justify-between gap-x-4 gap-y-0.5 rounded-2xl px-4 py-3 text-left hover:bg-ink/5 sm:flex-row sm:items-baseline"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`text-ink/55 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
          <span className="font-medium">{s.title}</span>
        </span>
        <CapLabel subtask={s} />
      </button>
      <Reveal open={open}>
        <div className="px-4 pt-1 pb-4 pl-8 text-ink/80">
          <p className="text-sm text-ink/65">Must pass</p>
          <ul className="mt-1 space-y-0.5">{s.criteria.map((c) => <li key={c.id}>{c.description}</li>)}</ul>
          {s.candidates.length > 0 && (
            <>
              <p className="mt-3 text-sm text-ink/65">Candidates, cheapest first</p>
              <ul className="mt-1.5 space-y-2">{s.candidates.map((c) => <CandidateLine key={c.handle} c={c} />)}</ul>
            </>
          )}
        </div>
      </Reveal>
    </>
  );
}

const turnaround = (s: number) =>
  s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;

/** One candidate: its name, handle and price, then what the market says about it. Agent text is shown as plain text. */
function CandidateLine({ c }: { c: Candidate }) {
  // The live market reports success as a percentage (100), the simulator as a share (1.0). A rate with no delivered
  // jobs behind it says nothing, so it is left out rather than shown as 0%.
  const rate = c.success_rate === null || c.delivered_jobs === 0 ? null : Math.round(c.success_rate > 1 ? c.success_rate : c.success_rate * 100);
  const facts = [
    rate !== null && `${rate}% success`,
    c.delivered_jobs > 0 && `${c.delivered_jobs} job${c.delivered_jobs === 1 ? '' : 's'} delivered`,
    c.sla_seconds > 0 && `within ${turnaround(c.sla_seconds)}`,
  ].filter(Boolean);
  return (
    <li>
      <p className="flex flex-wrap items-baseline gap-x-2">
        {c.name && c.name !== c.handle && <span className="font-medium">{c.name}</span>}
        <span className="font-mono text-sm text-ink/65">{c.handle}</span>
        <span className="ml-auto font-mono text-sm tabular-nums">{usdc(c.price_atomic)} USDC</span>
      </p>
      {facts.length > 0 && <p className="text-sm text-ink/60">{facts.join(' · ')}</p>}
    </li>
  );
}

function PlanCard({ plan }: { plan: PlanView }) {
  return (
    <ol className="mt-3 rounded-2xl border border-ink/15">
      {plan.subtasks.map((s, i) => (
        <li key={s.id} className="rook-in border-b border-ink/10 last:border-b-0" style={{ animationDelay: `${150 + i * 90}ms` }}>
          <PlanRow subtask={s} />
        </li>
      ))}
    </ol>
  );
}

/** What the planner has reported so far: its stage, and the agents its searches turned up, one card each. */
type Planning = { stage: string | null; quoting: number; found: { handle: string; name: string; title: string }[] };

function planningFrom(events: RookEvent[]): Planning {
  const out: Planning = { stage: null, quoting: 0, found: [] };
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== 'planning') continue;
    out.stage = e.data.stage;
    if (e.data.stage === 'quoting') out.quoting = e.data.agents;
    if (e.data.stage === 'found') for (const a of e.data.agents ?? []) {
      if (seen.has(a.handle)) continue;
      seen.add(a.handle);
      out.found.push({ handle: a.handle, name: a.name, title: e.data.title });
    }
  }
  return out;
}

/**
 * Rook choosing agents. While planning, cards land as the planner's market searches return; once the plan is in, they
 * narrow to the candidates it picked. Names and handles are plain text, with no links or images.
 */
function AgentSearch({ plan, planning, animate, onGrow, onDone }: { plan: PlanView | null; planning?: Planning; animate: boolean; onGrow?: () => void; onDone?: () => void }) {
  const { live } = useMode();
  // Live agents have real names; the simulator's names are just their handles, so the subtask reads better there.
  const name = (n: string, handle: string, fallback: string) => (n && n !== handle ? n : fallback);
  const sources: WebSource[] = plan
    ? plan.subtasks.flatMap((s) => s.candidates.map((c) => ({ id: `${s.id}/${c.handle}`, title: name(c.name, c.handle, s.title), url: c.handle })))
    : (planning?.found ?? []).map((a) => ({ id: a.handle, title: name(a.name, a.handle, a.title), url: a.handle }));
  const foundCount = planning?.found.length ?? 0;
  const total = sources.length;
  const [landed, setLanded] = useState(0);
  const count = animate && plan ? landed : total;
  const searching = !plan || count < total;
  const market = live ? 'the NEAR AI market' : 'the simulated market';
  const working =
    planning?.stage === 'quoting' ? `Getting prices from ${planning.quoting} agent${planning.quoting === 1 ? '' : 's'}`
    : planning?.stage === 'searching' || planning?.stage === 'found' ? `Searching ${market}`
    : plan ? `Searching ${market}`
    : 'Planning the subtasks';
  const done = foundCount > total
    ? `Picked ${total} of ${foundCount} agents found`
    : `Found ${total} agent${total === 1 ? '' : 's'}`;

  useEffect(() => {
    if (!plan || !animate || landed >= total) return;
    if (reducedMotion()) { setLanded(total); return; }
    const t = setTimeout(() => setLanded((n) => n + 1), Math.min(AGENT_MS, AGENTS_MAX_MS / total));
    return () => clearTimeout(t);
  }, [plan, animate, landed, total]);

  useEffect(() => {
    onGrow?.();
    const t = setTimeout(() => onGrow?.(), CARDS_OPEN_MS);
    return () => clearTimeout(t);
  }, [count, onGrow]);

  const finished = !!plan && count >= total;
  useEffect(() => { if (finished) onDone?.(); }, [finished, onDone]);

  // On a phone the cards fold away once they've landed, so the plan they led to starts at the top of the screen.
  const [open, setOpen] = useState(animate || !plan);
  useEffect(() => { if (finished && window.matchMedia('(max-width: 639px)').matches) setOpen(false); }, [finished]);

  return (
    <WebSearch
      status={searching ? 'searching' : 'done'}
      label={searching ? working : done}
      sources={sources.slice(0, count)}
      linked={false}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

type Now = { state: string; label: string; detail?: string };
type FeedLine = { key: number; text: string; tone: 'normal' | 'muted' | 'alert'; now: Now; paid?: number; fromReserve?: number; started?: string; ended?: string };

/** Turns the run's events into plain lines. Agent text is never shown as instructions: only handles and Rook's verdicts. */
function feedFrom(events: RookEvent[]): FeedLine[] {
  const lines: FeedLine[] = [];
  let receipt = 0;
  for (const { seq: key, type, data } of events) {
    const agent = data?.agent_handle;
    if (type === 'hire_sent') lines.push({ key, text: `Hired ${agent}, quoted ${usdc(data.amount_atomic)} USDC.`, tone: 'normal', started: agent, now: { state: 'researching', label: 'Hired', detail: agent } });
    else if (type === 'a2a_state' && ['FAILED', 'REJECTED'].includes(data.state)) lines.push({ key, text: `${agent} didn't deliver. No charge.`, tone: 'normal', ended: agent, now: { state: 'analyzing', label: 'No delivery', detail: agent } });
    else if (type === 'a2a_state' && data.state === 'TIMEOUT') lines.push({ key, text: `${agent} timed out. No charge.`, tone: 'normal', ended: agent, now: { state: 'analyzing', label: 'Timed out', detail: agent } });
    else if (type === 'evaluation') {
      if (data.verdict === 'pass') lines.push({ key, text: `${agent} passed every check.`, tone: 'normal', ended: agent, now: { state: 'analyzing', label: 'Passed', detail: agent } });
      else if (data.failed_criteria?.includes('injection')) lines.push({ key, text: `${agent}'s delivery tried to give Rook instructions. Flagged and rejected.`, tone: 'alert', ended: agent, now: { state: 'analyzing', label: 'Flagged', detail: agent } });
      else lines.push({ key, text: `${agent} failed a check.`, tone: 'alert', ended: agent, now: { state: 'analyzing', label: 'Failed a check', detail: agent } });
    } else if (type === 'security_alert' && data.source === 'quote') lines.push({ key, text: `Security alert: ${data.flag}`, tone: 'alert', now: { state: 'analyzing', label: 'Security alert' } });
    else if (type === 'quote_rejected') lines.push({ key, text: `Skipped ${agent}: ${data.reason}`, tone: 'muted', now: { state: 'researching', label: 'Skipped', detail: agent } });
    else if (type === 'ledger' && data.op === 'topUp') lines.push({ key, text: `Topped up ${usdc(data.amount_atomic)} USDC from the reserve.`, tone: 'muted', fromReserve: Number(data.amount_atomic), now: { state: 'analyzing', label: 'Topped up', detail: `${usdc(data.amount_atomic)} USDC` } });
    else if (type === 'receipt') lines.push({ key, text: `Receipt ${++receipt}: paid ${usdc(data.amount_atomic)} USDC to ${agent}.`, tone: 'muted', paid: Number(data.amount_atomic), now: { state: 'analyzing', label: 'Paid', detail: agent } });
    else if (type === 'error') lines.push({ key, text: `Problem: ${data.message}`, tone: 'alert', now: { state: 'analyzing', label: 'Problem' } });
  }
  return lines;
}

const TONE = { normal: '', muted: 'text-ink/65 text-sm', alert: 'text-alert' };

const STOPPED = (
  <svg viewBox="0 0 24 24" width={18} height={18} className="text-ink/65" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
);
const RUN_STATES = { stopped: { label: 'Stopped', active: false, icon: STOPPED } };

/** Collapsed to one line that says what is happening now; the full list is one click away. */
function Activity({ lines, live, caughtUp, closing, outcome, timed }: { lines: FeedLine[]; live: boolean; caughtUp: boolean; closing: boolean; outcome: string; timed: boolean }) {
  const [open, setOpen] = useState(false);
  const latest = lines[lines.length - 1];
  const working = new Set<string>();
  for (const l of lines) {
    if (l.started) working.add(l.started);
    if (l.ended) working.delete(l.ended);
  }
  const rejected = lines.filter((l) => l.tone === 'alert').length;

  let now: Now;
  if (!live) now = { state: outcome === 'killed' ? 'stopped' : outcome === 'failed' ? 'error' : 'done', label: '', detail: `${lines.length} step${lines.length === 1 ? '' : 's'}${rejected ? `, ${rejected} flagged` : ''}` };
  else if (!latest) now = { state: 'thinking', label: 'Starting the run' };
  else if (!caughtUp) now = latest.now;
  else if (closing) now = { state: 'writing', label: 'Combining the report' };
  else if (working.size) now = { state: 'analyzing', label: 'Waiting on', detail: [...working].join(', ') };
  else now = { state: 'researching', label: 'Lining up the next hire' };

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group -mx-2 flex max-w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-0.5 text-left text-ink/65 transition-colors hover:bg-ink/5 hover:text-ink motion-reduce:transition-none"
      >
        <AiStatus className="min-w-0" state={now.state} states={RUN_STATES} label={now.label || undefined} detail={now.detail} timer={timed} />
        {live && rejected > 0 && <span className="shrink-0 text-sm text-alert">{rejected} flagged</span>}
        <span className={`shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
      </button>
      <Reveal open={open && lines.length > 0}>
        <ul className="mt-2 space-y-1.5 border-l-2 border-ink/10 pl-4">
          {lines.map((l) => <li key={l.key} className={TONE[l.tone]}>{l.text}</li>)}
        </ul>
      </Reveal>
    </div>
  );
}

/** The planner's error in plain words where we recognise it; otherwise the error itself, which comes from Rook, not an agent. */
function plannerReason(error: string) {
  if (/no_limit_configured|No spending limit/i.test(error)) return 'NEAR AI has no credits set up for this API key, so the planner model could not run.';
  if (/NEAR AI 401|invalid api key|unauthorized/i.test(error)) return 'NEAR AI rejected the API key.';
  if (/cost guard|LLM_MAX_USD/i.test(error)) return 'The planner reached its spending cap for this session.';
  if (/market search/i.test(error)) return 'The NEAR AI market could not be reached.';
  return error.replace(/^planner: /, '');
}

/** Inline Markdown only: `code`, **bold**, _emphasis_. Report text comes from agents, so it stays plain React text. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\b_[^_]+_\b)/g).map((part, i) => {
    if (/^`.+`$/.test(part)) return <code key={i} className="font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    if (/^\*\*.+\*\*$/.test(part)) return <strong key={i} className="font-medium">{part.slice(2, -2)}</strong>;
    if (/^_.+_$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function Report({ markdown }: { markdown: string }) {
  const delay = (i: number) => ({ animationDelay: `${Math.min(i * 25, 900)}ms` });
  return (
    <div className="mt-3 space-y-2 leading-relaxed">
      {markdown.split('\n').map((raw, i) => {
        const line = raw.trim();
        if (!line) return null;
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) return <h3 key={i} style={delay(i)} className={`rook-in font-medium tracking-[-0.01em] ${heading[1].length <= 1 ? 'mt-4 text-2xl' : 'mt-4 text-xl'}`}>{inline(heading[2])}</h3>;
        if (/^[-*]\s/.test(line)) return <p key={i} style={delay(i)} className="rook-in pl-4 -indent-3">• {inline(line.slice(2))}</p>;
        return <p key={i} style={delay(i)} className="rook-in">{inline(line)}</p>;
      })}
    </div>
  );
}

// ---- one conversation ----

function Thread({ id, loaded, tasks, onGrow, fresh, onRevealed }: { id: string; loaded: Loaded; tasks: TaskSummary[] | null; onGrow: () => void; fresh: boolean; onRevealed: (id: string) => void }) {
  const { snap, events, problem, refetch } = loaded;
  const router = useRouter();
  const wallet = useWallet();
  const [busy, setBusy] = useState<'approve' | 'cancel' | 'stop' | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const [needsFunding, setNeedsFunding] = useState(false);
  const status = snap?.task.status;
  const { paymentsOff } = useMode();
  const known = tasks?.find((t) => t.id === id)?.status;
  const [revealing, setRevealing] = useState(fresh); // a plan just drafted here: agents land first, then the plan
  const onAgentsDone = useCallback(() => { setRevealing(false); onRevealed(id); }, [id, onRevealed]);

  // Run updates roll in one at a time. A task that had already ended when opened is history, so it shows at once.
  const feed = feedFrom(events);
  const planning = planningFrom(events);
  const [shown, setShown] = useState(0);
  const instant = useRef<boolean | null>(null);
  if (status && instant.current === null) instant.current = TERMINAL.has(status);
  // The run's clock starts when this page sees it start. Joining mid-run, it would show a time that's too short.
  const timed = useRef<boolean | null>(null);
  if (status && timed.current === null) timed.current = status === 'draft' || status === 'planned';
  const hasSnap = !!snap;
  useEffect(() => {
    if (!hasSnap || shown >= feed.length) return;
    if (instant.current || reducedMotion()) { setShown(feed.length); return; }
    const t = setTimeout(() => setShown((n) => n + 1), feed.length - shown > 6 ? CATCH_UP_MS : LINE_MS);
    return () => clearTimeout(t);
  }, [hasSnap, shown, feed.length]);
  const caughtUp = shown >= feed.length;
  const settled = !!status && TERMINAL.has(status) && caughtUp;
  useEffect(() => { onGrow(); }, [shown, status, settled, onGrow]);

  // Keep the sidebar's status honest when the run moves on without an action from this page.
  useEffect(() => {
    if (status && known && status !== known && (status === 'planned' || status === 'running' || TERMINAL.has(status))) router.refresh();
  }, [status, known, router]);

  async function act(kind: 'approve' | 'cancel' | 'stop') {
    setBusy(kind);
    setActError(null);
    const out = kind === 'approve' ? await approve(id) : kind === 'cancel' ? await cancel(id) : await stop(id);
    setBusy(null);
    if (!out.ok) setActError(out.message);
    else if (out.needsFunding) setNeedsFunding(true);
    refetch();
  }

  if (problem === 'missing') return <RookMessage><p>This task isn&apos;t available anymore. Tasks are cleared when Rook&apos;s services restart.</p></RookMessage>;
  if (problem === 'signin') return <RookMessage><p>Connect your wallet to see this task.</p></RookMessage>;
  if (problem === 'down' && !snap) return <RookMessage><p>Rook&apos;s services aren&apos;t running. Start them with pnpm dev, then refresh.</p></RookMessage>;
  if (!snap) return <RookMessage><Working label="Loading" /></RookMessage>;

  const { task, plan, receipts, ledger, final_result } = snap;
  const visible = feed.slice(0, shown);
  const started = !['draft', 'planned', 'cancelled'].includes(task.status) && !(task.status === 'failed' && !feed.length);
  const live = started && !settled;
  const spent = visible.reduce((sum, l) => sum + (l.paid ?? 0), 0);
  const reserveUsed = visible.reduce((sum, l) => sum + (l.fromReserve ?? 0), 0);

  return (
    <>
      <UserMessage prompt={task.prompt} budget={usdc(task.budget_atomic)} />

      {(task.status === 'draft' || (plan && (revealing || plan.subtasks.some((s) => s.candidates.length > 0)))) && (
        <RookMessage still={fresh}>
          <AgentSearch plan={plan} planning={planning} animate={fresh && planning.found.length === 0} onGrow={onGrow} onDone={revealing ? onAgentsDone : undefined} />
        </RookMessage>
      )}
      {task.status === 'failed' && !plan && (
        <RookMessage>
          <p>Rook couldn&apos;t draft a plan for this task.</p>
          {task.error && <p className="mt-1 text-sm text-ink/65">{plannerReason(task.error)}</p>}
        </RookMessage>
      )}

      {plan && !revealing && plan.subtasks.length === 0 && (
        <RookMessage>
          <p>I couldn&apos;t find anything to hire for at this budget. Try a larger budget or a different task.</p>
          {plan.dropped.length > 0 && <ul className="mt-2 text-sm text-ink/65">{plan.dropped.map((d) => <li key={d.title}>{d.title}: {d.reason}</li>)}</ul>}
        </RookMessage>
      )}

      {plan && !revealing && plan.subtasks.length > 0 && (
        <RookMessage>
          <p>Here&apos;s the plan. The agents cost at most <span className="font-medium">{usdc(plan.budget.allocated_atomic)} USDC</span> together. {started ? 'You approved it.' : task.status === 'cancelled' ? 'You cancelled it, so nothing was spent.' : 'Nothing has been spent.'}</p>
          <PlanCard plan={plan} />
          {plan.dropped.length > 0 && <p className="mt-2 text-sm text-ink/65">Left out: {plan.dropped.map((d) => `${d.title} (${d.reason})`).join(', ')}</p>}
          {task.status === 'planned' && (
            <div className="rook-in mt-4 flex flex-wrap gap-3" style={{ animationDelay: `${250 + plan.subtasks.length * 90}ms` }}>
              <ActionButton primary onClick={() => act('approve')} busy={busy === 'approve'} disabled={!wallet.account || paymentsOff} title={paymentsOff ? 'Paying live agents is not switched on yet' : wallet.account ? undefined : 'Connect your wallet first'}>
                {busy === 'approve' ? 'Starting…' : `Fund ${usdc(task.budget_atomic)} USDC and start`}
              </ActionButton>
              <ActionButton onClick={() => act('cancel')} busy={busy === 'cancel'}>Cancel</ActionButton>
            </div>
          )}
          {task.status === 'planned' && !paymentsOff && <p className="mt-2 text-sm text-ink/60">Your {usdc(task.budget_atomic)} USDC budget is held while the agents work. Whatever isn&apos;t spent comes back to you.</p>}
          {task.status === 'planned' && paymentsOff && <p className="mt-2 text-sm text-ink/60">Live agents and prices. Paying them isn&apos;t switched on yet, so nothing can be spent.</p>}
        </RookMessage>
      )}

      {needsFunding && <RookMessage><p>This plan needs funding from your wallet, and that step isn&apos;t in the app yet. Nothing has been spent.</p></RookMessage>}

      {started && !needsFunding && (
        <RookMessage>
          <div className="flex items-start justify-between gap-x-3 gap-y-2 sm:flex-wrap sm:items-center sm:gap-x-6">
            <p className="min-w-0 tabular-nums max-sm:pt-2.5">
              <span className="font-medium">{live ? 'Running.' : task.status === 'killed' ? 'Stopped.' : task.status === 'failed' ? 'This run hit a problem.' : 'Finished.'}</span>
              {' '}Spent {usdc(spent)} of {usdc(task.budget_atomic)} USDC
              {reserveUsed > 0 && <span className="text-ink/65">, {usdc(reserveUsed)} from the reserve</span>}
            </p>
            {!TERMINAL.has(task.status) && <ActionButton onClick={() => act('stop')} busy={busy === 'stop'}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</ActionButton>}
          </div>
          <Activity lines={visible} live={live} caughtUp={caughtUp} closing={task.status === 'aggregating' || task.status === 'closing' || task.status === 'closed'} outcome={task.status} timed={!!timed.current} />
        </RookMessage>
      )}

      {final_result && settled && (
        <RookMessage>
          <p className="font-medium">Here&apos;s your report.</p>
          {final_result.abandoned.length > 0 && <p className="mt-1 text-alert">{final_result.abandoned.length} subtask{final_result.abandoned.length > 1 ? 's' : ''} couldn&apos;t be completed.</p>}
          <Report markdown={final_result.final_markdown} />

          <div className="rook-in mt-6 rounded-2xl border border-ink/15 p-4" style={{ animationDelay: '500ms' }}>
            {ledger && <p className="tabular-nums">Spent {usdc(ledger.spent_atomic)} USDC, refunded {usdc(ledger.refunded_atomic)} USDC.</p>}
            <ol className="mt-3 border-t border-ink/10">
              {receipts.map((r, n) => (
                <li key={r.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto_2.5rem] items-baseline gap-2 border-b border-ink/10 py-1.5 text-sm last:border-b-0">
                  <span className="font-mono text-ink/55">{n + 1}</span>
                  <span className="truncate font-mono">{r.agent_handle}</span>
                  <span className="font-mono tabular-nums">{usdc(r.amount_atomic)}</span>
                  <span className={r.verdict === 'fail' ? 'text-alert' : r.verdict === 'pass' ? '' : 'text-ink/65'}>{r.verdict === 'fail' ? 'Fail' : r.verdict === 'pass' ? 'Pass' : 'N/A'}</span>
                </li>
              ))}
            </ol>
          </div>
        </RookMessage>
      )}

      {actError && <p role="alert" className="rounded-2xl border border-alert/40 bg-alert/10 p-4 text-alert">{actError}</p>}
    </>
  );
}

// ---- the page's one conversation surface ----

/** Lives in the layout, so going from /app to /app/{id} changes what it shows without remounting anything. */
export function Chat({ tasks }: { tasks: TaskSummary[] | null }) {
  const pathname = usePathname();
  const wallet = useWallet();
  const parts = pathname.split('/').filter(Boolean); // ['app', id?]
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  const loaded = useTask(id);
  const [sending, setSending] = useState<{ prompt: string; budget: string; id?: string } | null>(null);
  const [errors, setErrors] = useState<ComposerErrors | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ease = useEase();
  const justDrafted = useRef(new Set<string>());
  const onRevealed = useCallback((task: string) => { justDrafted.current.delete(task); }, []);

  const home = !id && !sending;
  const lenis = useSmoothScroll(scroller, !home);

  async function send(prompt: string, budget: string) {
    setErrors(null);
    setSending({ prompt: prompt.trim(), budget });
    // Returns as soon as the task exists; the plan then streams in on the task's page.
    const out = await draftTask({ prompt, budget });
    if (out.kind === 'planned') {
      // Keep showing this message until the task has loaded, so the thread takes over with no gap.
      justDrafted.current.add(out.id);
      setSending((s) => s && { ...s, id: out.id });
      go(`/app/${out.id}`);
      return true;
    }
    setSending(null);
    setErrors(out.kind === 'invalid' ? { prompt: out.prompt, budget: out.budget } : { message: out.message });
    return false;
  }

  useEffect(() => {
    if (sending?.id && sending.id === id && (loaded.snap?.task.id === id || loaded.problem)) setSending(null);
  }, [sending, id, loaded.snap, loaded.problem]);

  // Follow the conversation as it grows, until the reader scrolls up. Only their input can stop it: a smooth scroll on
  // its way down is also far from the bottom for a moment, and must not count. Moving down to the bottom resumes following;
  // moving up must not, since the first frames of scrolling up are still close to the bottom. Neither must the last frame
  // of a follow already under way, which can arrive just after the reader's input: that is what the hold is for.
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const lastTouchY = useRef(0);
  const holdUntil = useRef(0);
  const letGo = (at: number) => { pinned.current = false; holdUntil.current = at + FOLLOW_HOLD_MS; };
  useEffect(() => { pinned.current = true; }, [id]);
  const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const follow = useCallback(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    if (!lenis.current) { el.scrollTop = el.scrollHeight; return; }
    lenis.current.resize();
    lenis.current.scrollTo(el.scrollHeight - el.clientHeight, { duration: 0.7 });
  }, [lenis]);
  useEffect(follow, [sending, id, follow]);

  return (
    <div className={`flex h-full flex-col ${home ? 'sm:justify-center' : ''}`}>
      {home ? (
        <div className="mx-auto flex w-full max-w-208 flex-col items-center justify-center px-5 max-sm:flex-1 md:px-8">
          <span className="mb-4 sm:hidden [&>svg]:size-9" aria-hidden="true"><Mark /></span>
          <h1 className="text-center text-[1.75rem] leading-[1.05] font-normal tracking-[-0.035em] sm:text-[clamp(2.25rem,4.5vw,4rem)]">
            What do you want done?
          </h1>
        </div>
      ) : (
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (e.timeStamp > holdUntil.current && el.scrollTop > lastTop.current && nearBottom(el)) pinned.current = true;
            lastTop.current = el.scrollTop;
          }}
          onWheel={(e) => { if (e.deltaY < 0) letGo(e.timeStamp); }}
          onTouchStart={(e) => { lastTouchY.current = e.touches[0].clientY; }}
          onTouchMove={(e) => {
            const y = e.touches[0].clientY;
            if (y > lastTouchY.current) letGo(e.timeStamp); // a finger moving down scrolls up
            lastTouchY.current = y;
          }}
          onKeyDown={(e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) letGo(e.timeStamp); }}
          className="min-h-0 flex-1 overflow-y-auto max-sm:mask-[linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%-12px),transparent)]"
        >
          <div className="mx-auto w-full max-w-208 space-y-6 px-4 pt-3 pb-6 sm:px-5 sm:pt-4 sm:pb-8 md:px-8">
            <h1 className="sr-only">{sending?.prompt ?? loaded.snap?.task.prompt ?? 'Task'}</h1>
            {sending ? (
              <>
                <UserMessage animate prompt={sending.prompt} budget={Number(sending.budget).toFixed(2)} />
                <RookMessage><AgentSearch plan={null} animate={false} onGrow={follow} /></RookMessage>
              </>
            ) : id && <Thread key={id} id={id} loaded={loaded} tasks={tasks} onGrow={follow} fresh={justDrafted.current.has(id)} onRevealed={onRevealed} />}
          </div>
        </div>
      )}

      {/* Glides between the centre of the home screen and the bottom of a conversation. */}
      <motion.div layout="position" transition={ease} className={`mx-auto w-full max-w-208 md:px-8 px-2.5 pb-2.5 sm:px-5 ${home ? 'sm:mt-8 sm:pb-16' : 'sm:pb-5'}`}>
        <Composer onSend={send} errors={errors} sending={!!sending} compact={!home} />
      </motion.div>
    </div>
  );
}
