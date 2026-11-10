'use client';

import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FILES, MARKET, RECEIPTS, RUN, SPENT, SUBTASKS } from '@/data/market';
import { AgentChip } from '@/components/landing/AgentChip';
import { INSET } from '@/components/layout';

const STEPS = [
  { title: 'Give it a task and a budget.', body: 'Write what you want done and the most you will spend. Nothing is spent until you approve the plan.' },
  { title: 'Rook splits it into subtasks.', body: 'Each subtask gets its own cap and the checks its result has to pass, written before any agent is hired.' },
  { title: 'It hires priced agents from the NEAR AI market.', body: 'Every agent quotes a price. For each subtask, Rook hires the cheapest candidate that fits under the cap.' },
  { title: 'The total stays under your budget.', body: 'Every payment counts against the one budget. If a result fails its checks, the re-hire comes from a reserve inside that same budget.' },
  { title: 'You get one result.', body: 'Rook combines the work into a single report and sends back whatever it did not spend.' },
];

const caps = FILES.reduce((s, f) => s + Number(f.cap), 0).toFixed(2);
const refunded = (Number(RUN.budget) - Number(SPENT)).toFixed(2);

// ---- what the app shows at each step, filled with the recorded run ----

function Composer() {
  return (
    <div className="rounded-[1.5rem] border border-ink/12 bg-ink/[0.03] p-3">
      <p className="px-3 pt-2 pb-6 text-lg leading-snug md:text-xl">{RUN.prompt}</p>
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex h-10 items-center gap-1.5 rounded-full bg-ink/8 px-4 text-ink/65">Budget <span className="font-medium text-ink tabular-nums">{RUN.budget}</span> USDC</span>
        <span className="grid size-10 place-items-center rounded-full bg-accent text-white" aria-hidden="true">
          <svg className="size-4.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M2 8h11M9 3.5 13.5 8 9 12.5" /></svg>
        </span>
      </div>
    </div>
  );
}

function Plan() {
  return (
    <div>
      <p className="text-ink/65">{SUBTASKS.length} subtasks, caps totalling <span className="text-ink tabular-nums">{caps}</span> USDC</p>
      <ol className="mt-3 overflow-hidden rounded-2xl border border-ink/12">
        {SUBTASKS.map((s, i) => (
          <li key={s.id} className="flex items-baseline justify-between gap-4 border-b border-ink/8 px-4 py-3 last:border-b-0">
            <span>{s.title}</span>
            <span className="shrink-0 font-mono text-sm text-ink/60">Cap {FILES[i].cap}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Hires() {
  return (
    <ul className="space-y-3">
      {SUBTASKS.map((s) => {
        const [first, second] = MARKET.filter((a) => a.subtask === s.title);
        return (
          <li key={s.id}>
            <p className="text-sm text-ink/60">{s.title}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <AgentChip handle={first.handle} price={first.price} size="sm" className="ring-1 ring-accent/50" />
              <AgentChip handle={second.handle} price={second.price} size="sm" dim />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Budget() {
  const pct = (Number(SPENT) / Number(RUN.budget)) * 100;
  return (
    <div>
      <p className="text-ink/65">Spent <span className="text-ink tabular-nums">{SPENT}</span> of {RUN.budget} USDC</p>
      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-ink/10" role="img" aria-label={`${SPENT} of ${RUN.budget} USDC spent`}>
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <ol className="mt-5 space-y-1.5 font-mono text-sm">
        {RECEIPTS.map((r) => (
          <li key={r.n} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-2">
            <span className="text-ink/60">{r.n}</span>
            <span className="truncate">{r.agent}{!r.passed && <span className="text-ink/60"> · re-hired</span>}</span>
            <span className="tabular-nums">{r.amount}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Result() {
  return (
    <div>
      <p className="font-medium">Here&apos;s your report.</p>
      <div className="mt-3 space-y-1.5 text-ink/80">
        <p className="text-sm text-ink/55">Simulated test data from the recorded run, not real market data.</p>
        <p>Price (USD): 3.12</p>
        <p>Market cap (USD): 3,680,000,000</p>
        <p>Circulating supply: 1,180,000,000 NEAR</p>
      </div>
      <p className="mt-5 rounded-xl border border-ink/12 px-4 py-3 tabular-nums">Spent {SPENT} USDC, refunded {refunded} USDC.</p>
    </div>
  );
}

const SCREENS = [Composer, Plan, Hires, Budget, Result];

function Window({ step, children }: { step: number; children: ReactNode }) {
  return (
    <figure className="overflow-hidden rounded-3xl border border-ink/10 bg-white shadow-2xl shadow-ink/10">
      <figcaption className="flex items-center justify-between gap-3 border-b border-ink/8 px-5 py-3 text-sm text-ink/55">
        <span className="truncate">rook · {RUN.prompt}</span>
        <span className="shrink-0 tabular-nums">{step + 1} / {STEPS.length}</span>
      </figcaption>
      <div className="p-5 md:p-7">{children}</div>
    </figure>
  );
}

function Step({ i, onActive }: { i: number; onActive: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const centred = useInView(ref, { margin: '-45% 0px -45% 0px' });
  useEffect(() => { if (centred) onActive(i); }, [centred, i, onActive]);
  const Screen = SCREENS[i];
  return (
    <div ref={ref} className="py-12 md:flex md:min-h-[85svh] md:flex-col md:justify-center md:py-0">
      <p className="font-mono text-sm text-accent-ink tabular-nums">0{i + 1}</p>
      <h3 className="mt-3 max-w-[18ch] text-[clamp(1.75rem,3vw,2.75rem)] leading-[1.08] tracking-[-0.025em]">{STEPS[i].title}</h3>
      <p className="mt-4 max-w-[38ch] text-lg leading-relaxed text-ink/65">{STEPS[i].body}</p>
      {/* Phones: each step carries its own screen, in reading order. */}
      <div className="mt-8 md:hidden"><Window step={i}><Screen /></Window></div>
    </div>
  );
}

/** Five steps on the left; on wide screens one window stays pinned on the right and changes to match the step in view. */
export function HowItWorks() {
  const [active, setActive] = useState(0);
  const reduced = useReducedMotion();
  const Screen = SCREENS[active];

  return (
    <section id="how" aria-labelledby="how-title" className={`${INSET} scroll-mt-4 pb-16 md:pb-24`}>
      <h2 id="how-title" className="sr-only">How it works</h2>
      <div className="md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-[clamp(2rem,6vw,6rem)]">
        <div>
          {STEPS.map((_, i) => <Step key={i} i={i} onActive={setActive} />)}
        </div>
        <div className="max-md:hidden" aria-hidden="true">
          <div className="sticky top-0 flex h-[100svh] items-center">
            <div className="w-full">
              <Window step={active}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={active}
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={reduced ? { duration: 0 } : { duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                    className="min-h-[22rem]"
                  >
                    <Screen />
                  </motion.div>
                </AnimatePresence>
              </Window>
              <div className="mt-5 flex gap-1.5" aria-hidden="true">
                {STEPS.map((_, i) => (
                  <span key={i} className={`h-1 flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none ${i <= active ? 'bg-accent' : 'bg-ink/12'}`} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
