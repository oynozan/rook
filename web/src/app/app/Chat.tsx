'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Mark } from '@/components/Navbar';
import { approve, cancel, draftTask, stop } from './actions';
import { go } from './AppShell';
import { Composer, type ComposerErrors } from './Composer';
import type { PlanView, RookEvent, TaskSnapshot, TaskSummary } from './orchestrator';
import { useWallet } from './wallet';

const TERMINAL = new Set(['closed', 'cancelled', 'killed', 'failed']);
const usdc = (atomic: string | number | bigint) => (Number(atomic) / 1e6).toFixed(2);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MIN_DRAFT_MS = 1100; // an instant plan reads as canned; real LLM drafts take longer than this anyway
const LINE_MS = 420;
const CATCH_UP_MS = 70; // a refresh mid-run replays history quickly, then returns to the live pace

// ---- loading one task ----

type Loaded = { snap: TaskSnapshot | null; events: RookEvent[]; problem: 'missing' | 'down' | null; refetch: () => void };

function useTask(id: string | null): Loaded {
  const [snap, setSnap] = useState<TaskSnapshot | null>(null);
  const [events, setEvents] = useState<RookEvent[]>([]);
  const [problem, setProblem] = useState<Loaded['problem']>(null);

  const refetch = useCallback(() => {
    if (!id) return;
    fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 404) return setProblem('missing');
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
    const types = ['task_status', 'plan', 'quote_rejected', 'hire_sent', 'a2a_state', 'evaluation', 'security_alert', 'ledger', 'receipt', 'final', 'error'];
    const onEvent = (m: MessageEvent) => {
      const e = JSON.parse(m.data) as RookEvent;
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
      <div className="max-w-[85%] rounded-3xl rounded-br-md bg-ink/5 px-5 py-3">
        <p className="text-lg leading-snug whitespace-pre-wrap">{prompt}</p>
        <p className="mt-1 text-right text-sm text-ink/65">Budget {budget} USDC</p>
      </div>
    </div>
  );
}

function RookMessage({ children }: { children: ReactNode }) {
  return (
    <div className="rook-in flex gap-3">
      <span className="mt-0.5 flex h-7 shrink-0 items-center [&>svg]:size-5" aria-hidden="true"><Mark /></span>
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
      className={`inline-flex min-h-11 items-center rounded-full px-5 font-medium whitespace-nowrap transition-colors duration-200 motion-reduce:transition-none ${
        primary
          ? disabled ? 'cursor-not-allowed bg-ink/10 text-ink/55' : `bg-accent text-on-accent ${busy ? 'cursor-wait' : 'cursor-pointer hover:bg-accent-hover active:translate-y-px'}`
          : `border border-ink/25 ${off ? 'cursor-wait text-ink/55' : 'cursor-pointer hover:border-ink hover:bg-ink/5 active:translate-y-px'}`
      }`}
    >
      {children}
    </button>
  );
}

function PlanCard({ plan }: { plan: PlanView }) {
  return (
    <ol className="mt-3 rounded-2xl border border-ink/15">
      {plan.subtasks.map((s, i) => (
        <li key={s.id} className="rook-in border-b border-ink/10 last:border-b-0" style={{ animationDelay: `${150 + i * 90}ms` }}>
          <details className="group">
            <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4 rounded-2xl px-4 py-3 hover:bg-ink/5 [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="text-ink/55 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true">›</span>
                <span className="font-medium">{s.title}</span>
              </span>
              <span className="shrink-0 font-mono text-sm text-ink/65">{s.self_do ? 'No hire' : `Cap ${usdc(s.cap_atomic)}`}</span>
            </summary>
            <div className="px-4 pt-1 pb-4 pl-8 text-ink/80">
              <p className="text-sm text-ink/65">Must pass</p>
              <ul className="mt-1 space-y-0.5">{s.criteria.map((c) => <li key={c.id}>{c.description}</li>)}</ul>
              {s.candidates.length > 0 && (
                <>
                  <p className="mt-3 text-sm text-ink/65">Candidates, cheapest first</p>
                  <ul className="mt-1 space-y-0.5 font-mono text-sm">{s.candidates.map((c) => <li key={c.handle}>{c.handle} {usdc(c.price_atomic)}</li>)}</ul>
                </>
              )}
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}

type FeedLine = { key: number; text: string; tone: 'normal' | 'muted' | 'alert'; paid?: number; fromReserve?: number; started?: string; ended?: string };

/** Turns the run's events into plain lines. Agent text is never shown as instructions: only handles and Rook's verdicts. */
function feedFrom(events: RookEvent[]): FeedLine[] {
  const lines: FeedLine[] = [];
  let receipt = 0;
  for (const { seq: key, type, data } of events) {
    const agent = data?.agent_handle;
    if (type === 'hire_sent') lines.push({ key, text: `Hired ${agent}, quoted ${usdc(data.amount_atomic)} USDC.`, tone: 'normal', started: agent });
    else if (type === 'a2a_state' && ['FAILED', 'REJECTED'].includes(data.state)) lines.push({ key, text: `${agent} didn't deliver. No charge.`, tone: 'normal', ended: agent });
    else if (type === 'a2a_state' && data.state === 'TIMEOUT') lines.push({ key, text: `${agent} timed out. No charge.`, tone: 'normal', ended: agent });
    else if (type === 'evaluation') {
      if (data.verdict === 'pass') lines.push({ key, text: `${agent} passed every check.`, tone: 'normal', ended: agent });
      else if (data.failed_criteria?.includes('injection')) lines.push({ key, text: `${agent}'s delivery tried to give Rook instructions. Flagged and rejected.`, tone: 'alert', ended: agent });
      else lines.push({ key, text: `${agent} failed a check.`, tone: 'alert', ended: agent });
    } else if (type === 'security_alert' && data.source === 'quote') lines.push({ key, text: `Security alert: ${data.flag}`, tone: 'alert' });
    else if (type === 'quote_rejected') lines.push({ key, text: `Skipped ${agent}: ${data.reason}`, tone: 'muted' });
    else if (type === 'ledger' && data.op === 'topUp') lines.push({ key, text: `Topped up ${usdc(data.amount_atomic)} USDC from the reserve.`, tone: 'muted', fromReserve: Number(data.amount_atomic) });
    else if (type === 'receipt') lines.push({ key, text: `Receipt ${++receipt}: paid ${usdc(data.amount_atomic)} USDC to ${agent}.`, tone: 'muted', paid: Number(data.amount_atomic) });
    else if (type === 'error') lines.push({ key, text: `Problem: ${data.message}`, tone: 'alert' });
  }
  return lines;
}

const TONE = { normal: '', muted: 'text-ink/65 text-sm', alert: 'text-red-700' };

/** Collapsed to one line that says what is happening now; the full list is one click away. */
function Activity({ lines, live, caughtUp, closing }: { lines: FeedLine[]; live: boolean; caughtUp: boolean; closing: boolean }) {
  const [open, setOpen] = useState(false);
  const latest = lines[lines.length - 1];
  const working = new Set<string>();
  for (const l of lines) {
    if (l.started) working.add(l.started);
    if (l.ended) working.delete(l.ended);
  }
  const rejected = lines.filter((l) => l.tone === 'alert').length;

  let label: string;
  let keyed: string | number = 'summary';
  let tone = '';
  if (!live) label = `${lines.length} step${lines.length === 1 ? '' : 's'}${rejected ? `, ${rejected} flagged` : ''}`;
  else if (!latest) label = 'Starting the run';
  else if (!caughtUp) { label = latest.text; keyed = latest.key; tone = latest.tone === 'alert' ? 'text-red-700' : ''; }
  else if (closing) label = 'Combining the report';
  else if (working.size) label = `Waiting on ${[...working].join(', ')}`;
  else label = 'Lining up the next hire';
  if (live && caughtUp) keyed = label;

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group -mx-2 flex max-w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-left text-ink/65 transition-colors hover:bg-ink/5 hover:text-ink motion-reduce:transition-none"
      >
        {live && (
          <span className="rook-blocks flex shrink-0 items-center gap-1" aria-hidden="true">
            <span className="size-2 bg-accent" /><span className="size-2 bg-accent" /><span className="size-2 bg-accent" />
          </span>
        )}
        <span key={keyed} role="status" className={`rook-in min-w-0 truncate ${tone}`}>{label}</span>
        {live && rejected > 0 && <span className="shrink-0 text-sm text-red-700">{rejected} flagged</span>}
        <span className={`shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
      </button>
      {open && lines.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-l-2 border-ink/10 pl-4">
          {lines.map((l) => <li key={l.key} className={`rook-in ${TONE[l.tone]}`}>{l.text}</li>)}
        </ul>
      )}
    </div>
  );
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

function Thread({ id, loaded, tasks, onGrow }: { id: string; loaded: Loaded; tasks: TaskSummary[] | null; onGrow: () => void }) {
  const { snap, events, problem, refetch } = loaded;
  const router = useRouter();
  const wallet = useWallet();
  const [busy, setBusy] = useState<'approve' | 'cancel' | 'stop' | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const [needsFunding, setNeedsFunding] = useState(false);
  const status = snap?.task.status;
  const known = tasks?.find((t) => t.id === id)?.status;

  // Run updates roll in one at a time. A task that had already ended when opened is history, so it shows at once.
  const feed = feedFrom(events);
  const [shown, setShown] = useState(0);
  const instant = useRef<boolean | null>(null);
  if (status && instant.current === null) instant.current = TERMINAL.has(status);
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
    if (status && known && status !== known && (status === 'running' || TERMINAL.has(status))) router.refresh();
  }, [status, known, router]);

  async function act(kind: 'approve' | 'cancel' | 'stop') {
    setBusy(kind);
    setActError(null);
    const out = kind === 'approve' ? await approve(id, wallet.account ?? '') : kind === 'cancel' ? await cancel(id) : await stop(id);
    setBusy(null);
    if (!out.ok) setActError(out.message);
    else if (out.needsFunding) setNeedsFunding(true);
    refetch();
  }

  if (problem === 'missing') return <RookMessage><p>This task isn&apos;t available anymore. Tasks are cleared when Rook&apos;s services restart.</p></RookMessage>;
  if (problem === 'down' && !snap) return <RookMessage><p>Rook&apos;s services aren&apos;t running. Start them with pnpm dev, then refresh.</p></RookMessage>;
  if (!snap) return <RookMessage><Working label="Loading" /></RookMessage>;

  const { task, plan, receipts, ledger, final_result } = snap;
  const visible = feed.slice(0, shown);
  const started = !['draft', 'planned', 'cancelled'].includes(task.status) && !(task.status === 'failed' && !feed.length);
  const live = started && !settled;
  const spent = visible.reduce((sum, l) => sum + (l.paid ?? 0), 0);
  const reserveUsed = visible.reduce((sum, l) => sum + (l.fromReserve ?? 0), 0);
  const max = plan ? BigInt(plan.budget.allocated_atomic) + BigInt(plan.budget.reserve_atomic) : 0n;

  return (
    <>
      <UserMessage prompt={task.prompt} budget={usdc(task.budget_atomic)} />

      {task.status === 'draft' && <RookMessage><Working label="Drafting your plan" /></RookMessage>}
      {task.status === 'failed' && !plan && <RookMessage><p>Rook couldn&apos;t draft a plan for this task. Try sending it again.</p></RookMessage>}

      {plan && plan.subtasks.length === 0 && (
        <RookMessage>
          <p>I couldn&apos;t find anything to hire for at this budget. Try a larger budget or a different task.</p>
          {plan.dropped.length > 0 && <ul className="mt-2 text-sm text-ink/65">{plan.dropped.map((d) => <li key={d.title}>{d.title}: {d.reason}</li>)}</ul>}
        </RookMessage>
      )}

      {plan && plan.subtasks.length > 0 && (
        <RookMessage>
          <p>Here&apos;s the plan, up to <span className="font-medium">{usdc(max)} USDC</span>. {started ? 'You approved it.' : task.status === 'cancelled' ? 'You cancelled it, so nothing was spent.' : 'Nothing has been spent.'}</p>
          <PlanCard plan={plan} />
          {plan.dropped.length > 0 && <p className="mt-2 text-sm text-ink/65">Left out: {plan.dropped.map((d) => `${d.title} (${d.reason})`).join(', ')}</p>}
          {task.status === 'planned' && (
            <div className="rook-in mt-4 flex flex-wrap gap-3" style={{ animationDelay: `${250 + plan.subtasks.length * 90}ms` }}>
              <ActionButton primary onClick={() => act('approve')} busy={busy === 'approve'} disabled={!wallet.account} title={wallet.account ? undefined : 'Connect your wallet first'}>
                {busy === 'approve' ? 'Starting…' : `Approve, up to ${usdc(max)} USDC`}
              </ActionButton>
              <ActionButton onClick={() => act('cancel')} busy={busy === 'cancel'}>Cancel</ActionButton>
            </div>
          )}
        </RookMessage>
      )}

      {needsFunding && <RookMessage><p>This plan needs funding from your wallet, and that step isn&apos;t in the app yet. Nothing has been spent.</p></RookMessage>}

      {started && !needsFunding && (
        <RookMessage>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <p className="tabular-nums">
              <span className="font-medium">{live ? 'Running.' : task.status === 'killed' ? 'Stopped.' : task.status === 'failed' ? 'This run hit a problem.' : 'Finished.'}</span>
              {' '}Spent {usdc(spent)} of {usdc(task.budget_atomic)} USDC
              {reserveUsed > 0 && <span className="text-ink/65">, {usdc(reserveUsed)} from the reserve</span>}
            </p>
            {!TERMINAL.has(task.status) && <ActionButton onClick={() => act('stop')} busy={busy === 'stop'}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</ActionButton>}
          </div>
          <Activity lines={visible} live={live} caughtUp={caughtUp} closing={task.status === 'aggregating' || task.status === 'closing' || task.status === 'closed'} />
        </RookMessage>
      )}

      {final_result && settled && (
        <RookMessage>
          <p className="font-medium">Here&apos;s your report.</p>
          {final_result.abandoned.length > 0 && <p className="mt-1 text-red-700">{final_result.abandoned.length} subtask{final_result.abandoned.length > 1 ? 's' : ''} couldn&apos;t be completed.</p>}
          <Report markdown={final_result.final_markdown} />

          <div className="rook-in mt-6 rounded-2xl border border-ink/15 p-4" style={{ animationDelay: '500ms' }}>
            {ledger && <p className="tabular-nums">Spent {usdc(ledger.spent_atomic)} USDC, refunded {usdc(ledger.refunded_atomic)} USDC.</p>}
            <ol className="mt-3 border-t border-ink/10">
              {receipts.map((r, n) => (
                <li key={r.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto_2.5rem] items-baseline gap-2 border-b border-ink/10 py-1.5 text-sm last:border-b-0">
                  <span className="font-mono text-ink/55">{n + 1}</span>
                  <span className="truncate font-mono">{r.agent_handle}</span>
                  <span className="font-mono tabular-nums">{usdc(r.amount_atomic)}</span>
                  <span className={r.verdict === 'fail' ? 'text-red-700' : r.verdict === 'pass' ? '' : 'text-ink/65'}>{r.verdict === 'fail' ? 'Fail' : r.verdict === 'pass' ? 'Pass' : 'N/A'}</span>
                </li>
              ))}
            </ol>
          </div>
        </RookMessage>
      )}

      {actError && <p role="alert" className="rounded-2xl border border-red-700/40 bg-red-50 p-4 text-red-800">{actError}</p>}
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

  const status = loaded.snap?.task.status;
  const home = !id && !sending;

  async function send(prompt: string, budget: string) {
    setErrors(null);
    setSending({ prompt: prompt.trim(), budget });
    const [out] = await Promise.all([
      draftTask({ prompt, budget, account: wallet.account ?? '' }),
      new Promise((ok) => setTimeout(ok, reducedMotion() ? 0 : MIN_DRAFT_MS)),
    ]);
    if (out.kind === 'planned') {
      // Keep showing this message until the task has loaded, so the thread takes over with no gap.
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

  // Follow the conversation as it grows, unless the reader has scrolled up.
  const pinned = useRef(true);
  useEffect(() => { pinned.current = true; }, [id]);
  const follow = useCallback(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, []);
  useEffect(follow, [sending, id, follow]);

  return (
    <div className={`flex h-full flex-col ${home ? 'justify-center' : ''}`}>
      {home ? (
        <h1 className="mx-auto w-full max-w-208 px-5 text-center text-[clamp(2.25rem,4.5vw,4rem)] leading-[1.05] font-normal tracking-[-0.035em] md:px-8">
          What do you want done?
        </h1>
      ) : (
        <div
          ref={scroller}
          onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-208 space-y-6 px-5 pt-4 pb-8 md:px-8">
            <h1 className="sr-only">{sending?.prompt ?? loaded.snap?.task.prompt ?? 'Task'}</h1>
            {sending ? (
              <>
                <UserMessage animate prompt={sending.prompt} budget={Number(sending.budget).toFixed(2)} />
                <RookMessage><Working label="Drafting your plan" /></RookMessage>
              </>
            ) : id && <Thread key={id} id={id} loaded={loaded} tasks={tasks} onGrow={follow} />}
          </div>
        </div>
      )}

      <div className={`mx-auto w-full max-w-208 px-5 md:px-8 ${home ? 'mt-8 pb-16' : 'pb-5'}`}>
        <Composer onSend={send} errors={errors} sending={!!sending} compact={!home} />
      </div>
    </div>
  );
}
