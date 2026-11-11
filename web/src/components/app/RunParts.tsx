'use client';

// Each part of a run, one click away on the run card: what it is doing, who works on it and for how long, every agent
// tried and what came of it, the brief Rook sent, and a passed part's delivery. Built from what the page already has
// (the event stream and the snapshot, see run-view.ts); only the clock ticks here.
import { useEffect, useId, useState } from 'react';
import { Reveal, RowButton } from '@/components/app/controls';
import { span, type PartView } from '@/lib/run-view';

/** Now, every second while `on`; frozen otherwise. */
export function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** A clock time in the reader's own zone: "14:05". */
export const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const TONE: Record<PartView['tone'], string> = { active: 'text-accent-ink', idle: 'text-ink/60', passed: 'text-ink/70', failed: 'text-alert' };
const ROW_TONE = { normal: 'text-ink/80', muted: 'text-ink/60', alert: 'text-alert' };

/** `live`: the run is under way, so the agents still at work are counted against Rook's patience. */
export function RunParts({ parts, now, live }: { parts: PartView[]; now: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const done = parts.filter((p) => p.tone === 'passed').length;
  const hired = parts.some((p) => !p.self || p.tried.length > 0);
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 inline-flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-ink/65 transition-colors hover:bg-ink/5 hover:text-ink motion-reduce:transition-none"
      >
        <span className={`shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
        <span>Each part&apos;s progress</span>
        <span className="text-sm text-ink/55 tabular-nums">{done} of {parts.length} done</span>
      </button>
      <Reveal open={open}>
        <div id={id} className="pt-1">
          {hired && <p className="mb-2 text-sm text-ink/65">Agents on the market don&apos;t share progress while they work. Rook checks on each one every few seconds.</p>}
          <ol className="rounded-2xl border border-ink/15">
            {parts.map((p, i) => <PartRow key={p.id} part={p} n={i + 1} now={now} live={live} />)}
          </ol>
        </div>
      </Reveal>
    </div>
  );
}

function PartRow({ part: p, n, now, live }: { part: PartView; n: number; now: number; live: boolean }) {
  const [brief, setBrief] = useState(false);
  const briefId = useId();
  const w = live ? p.working : null;
  const total = w ? Math.round((w.until - w.since) / 60_000) : 0;
  return (
    <li className="min-w-0 border-b border-ink/10 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="min-w-0 font-medium wrap-break-word"><span className="text-ink/55 tabular-nums">{n}.</span> {p.title}</p>
        <p className={`min-w-0 text-sm wrap-break-word ${TONE[p.tone]}`}>{p.status}</p>
      </div>

      {w && (
        <p className="mt-1.5 text-sm text-ink/80 tabular-nums">
          <span className="font-mono break-all">{w.agent}</span>{' '}
          {now < w.until
            ? <>has been on it for {span(now - w.since)}. Rook gives up at {clockTime(w.until)}, {total} min after hiring it.</>
            : <>sent nothing in {total} min, so Rook is giving up on it.</>}
        </p>
      )}

      {p.tried.length > 0 && (
        <>
          <p className="mt-2 text-sm text-ink/60">Agents tried</p>
          <ul className="mt-0.5 space-y-0.5 text-sm">
            {p.tried.map((t) => (
              <li key={t.key} className="flex flex-wrap gap-x-2">
                <span className="font-mono break-all">{t.agent}</span>
                <span className={ROW_TONE[t.tone]}>{t.outcome}{t.money && <span className="text-ink/60 tabular-nums"> · {t.money}</span>}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {p.delivered && (
        <div className="mt-2 text-sm">
          <p className="text-ink/60">{p.delivered.by ? <>Delivered by <span className="font-mono break-all">{p.delivered.by}</span></> : 'Rook wrote it'}</p>
          {/* The agent's own words, as plain text with no Markdown marks (run-view.ts preview). */}
          <p className="mt-0.5 wrap-break-word text-ink/80">{p.delivered.preview}</p>
        </div>
      )}

      {p.brief && (
        <div className="mt-1">
          <RowButton onClick={() => setBrief((b) => !b)} expanded={brief} controls={brief ? briefId : undefined}>
            <span className={`mr-1.5 inline-block transition-transform duration-200 motion-reduce:transition-none ${brief ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
            {/* Sent once Rook hired an agent (a quote it turned down sent nothing); until then it is what Rook will send. */}
            {p.self ? 'Brief' : p.sent ? 'Brief Rook sent' : 'Brief for the agent'}
          </RowButton>
          <Reveal open={brief}>
            {/* The planner's own words for the agent; plain text, never markup. */}
            <p id={briefId} className="pb-1 pl-3 text-sm whitespace-pre-wrap wrap-break-word text-ink/80">{p.brief}</p>
          </Reveal>
        </div>
      )}
    </li>
  );
}
