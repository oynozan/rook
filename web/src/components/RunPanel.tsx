'use client';

import { useEffect, useState } from 'react';
import { FILES, FRAMES, RUN, SUBTASKS, rowsAt, type Hire, type Row } from '@/data/demo-run';

const LAST = FRAMES.length - 1;
const STEP_MS = 1700;
const HOLD_MS = 4000;

type Card = { agent: string; state: string; label: string; detail: string; receipt?: number } | null;

function cardsFor(file: (typeof FILES)[number], r: Row): [Card, Card] {
  const step = !r.agent ? 0 : r.agent === file.first.agent ? 1 : 2;
  const done = (h: Hire): Card => ({ agent: h.agent, state: h.end, label: h.label, detail: h.detail, receipt: h.receipt });
  const live = (h: Hire): Card => (r.state === 'working' ? { agent: h.agent, state: 'working', label: 'Working', detail: r.detail } : done(h));
  return [
    step === 1 ? live(file.first) : step === 2 ? done(file.first) : null,
    step === 2 ? live(file.second) : null,
  ];
}

const CARD_STYLE: Record<string, string> = {
  working: 'border-[#7aa2ff] bg-accent/40 text-white',
  failed: 'border-white/25 bg-white/5 text-white/70',
  unpaid: 'border-white/25 bg-white/5 text-white/70',
  passed: 'border-white bg-white text-ink',
};
const MARKER_STYLE: Record<string, string> = {
  working: 'bg-[#7aa2ff] motion-safe:animate-pulse',
  failed: 'border border-white/70',
  unpaid: 'border border-white/70',
  passed: 'bg-accent',
};

function HireCard({ card, slot }: { card: Card; slot: string }) {
  if (!card) {
    return (
      <div className="flex min-h-19 min-w-0 items-center rounded-md border border-dashed border-white/15 px-2.5 text-xs text-white/55 md:text-sm lg:h-full lg:px-3 xl:px-5 xl:text-base">
        {slot}
      </div>
    );
  }
  return (
    <div className={`flex min-h-19 min-w-0 flex-col justify-center gap-0.5 rounded-md border px-2.5 py-1.5 transition-colors duration-300 motion-reduce:transition-none lg:h-full lg:px-3 xl:gap-1 xl:px-5 ${CARD_STYLE[card.state]}`}>
      <p className={`truncate font-mono text-[0.6875rem] md:text-sm lg:text-xs xl:text-base ${card.state === 'failed' || card.state === 'unpaid' ? 'line-through' : ''}`}>{card.agent}</p>
      <p className="flex items-center gap-1.5 text-sm leading-tight font-medium md:text-base xl:text-lg">
        <span className={`size-2 shrink-0 ${MARKER_STYLE[card.state]}`} aria-hidden="true" />
        {card.label}
      </p>
      <p className="font-mono text-[0.6875rem] tabular-nums opacity-80 md:text-sm lg:text-xs xl:text-base">
        {card.detail}
        {card.receipt && <span className="hidden sm:inline">, receipt {card.receipt}</span>}
      </p>
    </div>
  );
}

function Link({ lit }: { lit: boolean }) {
  return <span className={`h-px transition-colors duration-300 motion-reduce:transition-none ${lit ? 'bg-white/70' : 'bg-white/15'}`} aria-hidden="true" />;
}

/** Plays the recorded demo run: one task branches into four lines of task cards, and receipts get numbered. */
export function RunPanel() {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setI(LAST);
    else setPlaying(true);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => setI((v) => (v === LAST ? 0 : v + 1)), i === LAST ? HOLD_MS : STEP_MS);
    return () => clearTimeout(id);
  }, [playing, i]);

  const frame = FRAMES[i];
  const rows = rowsAt(i);

  return (
    <figure className="relative isolate flex flex-col gap-6 overflow-hidden rounded-xl bg-[#071226] p-5 text-white md:p-8 lg:aspect-video lg:p-10 xl:p-14">
      <div className="dots absolute inset-0 -z-10 text-white/10" aria-hidden="true" />

      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="flex items-center gap-2 text-sm tabular-nums md:text-base xl:text-lg">
          <span className="size-2.5 bg-[#7aa2ff]" aria-hidden="true" />
          <span className="tracking-wider text-[#a9c3ff] uppercase">{frame.closed ? 'Closed' : 'Running'}</span>
          <span>Spent {frame.spent} of {RUN.budget} USDC</span>
        </p>
        <p className="text-xs text-white/70 md:text-sm xl:text-base">Recorded demo on a simulated market. No real money moved.</p>
      </div>

      <div className="flex min-h-0 flex-1 items-stretch">
        <div className="hidden w-[13%] shrink-0 flex-col justify-center lg:flex">
          <div className="rounded-md border border-white/25 p-3">
            <p className="text-xs text-white/70 xl:text-sm">Task</p>
            <p className="mt-1 text-sm leading-snug font-medium xl:text-lg">{RUN.prompt}</p>
          </div>
        </div>

        {/* The branch: a stub from the task, then a spine from the first line's center to the last. */}
        <div className="relative hidden w-[3%] shrink-0 lg:block" aria-hidden="true">
          <span className="absolute top-1/2 left-0 h-px w-1/2 bg-white/70" />
          <span className="absolute top-[12.5%] bottom-[12.5%] left-1/2 w-px bg-white/70" />
        </div>

        <ol className="grid min-w-0 flex-1 gap-3 lg:grid-rows-4 lg:gap-2.5">
          {FILES.map((file, f) => {
            const [first, second] = cardsFor(file, rows[file.id]);
            return (
              <li key={file.id} className="grid min-h-0 grid-cols-[minmax(0,1fr)_0.75rem_minmax(0,1fr)] items-center gap-y-1.5 lg:grid-cols-[0.75rem_minmax(0,0.9fr)_1rem_minmax(0,1.2fr)_1rem_minmax(0,1.2fr)]">
                <span className="hidden h-px bg-white/70 lg:block" aria-hidden="true" />
                <div className="col-span-3 flex items-baseline justify-between gap-2 lg:col-span-1 lg:block lg:pl-3">
                  <p className="text-sm leading-tight font-medium md:text-base xl:text-lg">{SUBTASKS[f].title}</p>
                  <p className="font-mono text-xs text-white/70 tabular-nums md:text-sm xl:text-base">Cap {file.cap}</p>
                </div>
                <span className="hidden lg:block"><Link lit={!!first} /></span>
                <HireCard card={first} slot="First hire" />
                <Link lit={!!second} />
                <HireCard card={second} slot="Re-hire if needed" />
              </li>
            );
          })}
        </ol>

        <div className="relative hidden w-[3%] shrink-0 lg:block" aria-hidden="true">
          <span className={`absolute top-[12.5%] bottom-[12.5%] left-1/2 w-px transition-colors duration-300 motion-reduce:transition-none ${frame.closed ? 'bg-white/70' : 'bg-white/15'}`} />
          <span className={`absolute top-1/2 right-0 h-px w-1/2 transition-colors duration-300 motion-reduce:transition-none ${frame.closed ? 'bg-white/70' : 'bg-white/15'}`} />
        </div>

        <div className="hidden w-[13%] shrink-0 flex-col justify-center lg:flex">
          <div className={`rounded-md border p-3 transition-colors duration-300 motion-reduce:transition-none ${frame.closed ? 'border-white bg-white text-ink' : 'border-dashed border-white/15 text-white/55'}`}>
            <p className="text-xs xl:text-sm">Combined report</p>
            <p className="mt-1 text-sm leading-snug font-medium xl:text-lg">{frame.closed ? `${RUN.refunded} USDC refunded` : 'Waiting on all four'}</p>
          </div>
        </div>
      </div>

      <figcaption className="flex min-h-11 items-center gap-3">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? 'Pause the run' : 'Play the run'}
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border border-white/50 bg-white/10 transition-colors hover:bg-white/25 focus-visible:outline-white motion-reduce:transition-none"
        >
          {playing ? (
            <svg className="size-3.5" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="2.5" y="1.5" width="3" height="11" /><rect x="8.5" y="1.5" width="3" height="11" /></svg>
          ) : (
            <svg className="size-3.5" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 1.5v11l9-5.5z" /></svg>
          )}
        </button>
        <p className="min-h-10 content-center text-sm leading-snug md:text-base xl:text-lg">
          <span className="mr-2 font-mono text-xs text-white/70 tabular-nums md:text-sm xl:text-base">{frame.t.toFixed(1)} s</span>
          {frame.note}
        </p>
      </figcaption>
    </figure>
  );
}
