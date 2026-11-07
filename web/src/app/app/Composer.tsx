'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { draftPlan, type DraftState } from './actions';
import type { PlanView } from './orchestrator';
import { useWallet } from './wallet';

const EXAMPLES = [
  'Due diligence on the NEAR token',
  'Compare three wallets for new NEAR users',
  'Write a launch brief for a developer tool',
];

const usdc = (atomic: string | bigint) => (Number(atomic) / 1e6).toFixed(2);

function reserveHint(budget: string) {
  const n = Number(budget);
  return budget.trim() && n > 0 ? `${(n * 0.2).toFixed(2)} of this is held in reserve for re-hires.` : '20% is held in reserve for re-hires.';
}

function PlanSummary({ prompt, plan }: { prompt: string; plan: PlanView }) {
  const ref = useRef<HTMLElement>(null);
  // The plan lands below the form, often past the fold: bring it into view.
  useEffect(() => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ref.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'nearest' });
  }, [plan]);
  const max = BigInt(plan.budget.allocated_atomic) + BigInt(plan.budget.reserve_atomic);
  if (!plan.subtasks.length) {
    return (
      <section ref={ref} aria-live="polite" className="mt-6 rounded-2xl border border-ink/15 p-6">
        <h2 className="text-xl font-medium">No plan for this budget</h2>
        <p className="mt-1 text-ink/65">Rook found no subtask it could hire for. Try a larger budget or a different task.</p>
        <ul className="mt-3 text-ink/65">
          {plan.dropped.map((d) => <li key={d.title}>{d.title}: {d.reason}</li>)}
        </ul>
      </section>
    );
  }
  return (
    <section ref={ref} aria-live="polite" className="mt-6 rounded-2xl border border-accent p-6 md:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-2xl font-medium tracking-[-0.015em]">Your plan is ready</h2>
        <p className="font-mono text-sm text-ink/65">Up to {usdc(max)} USDC</p>
      </div>
      <p className="mt-1 text-ink/65">{prompt}. Nothing has been spent.</p>
      <ol className="mt-5 border-t border-ink/15">
        {plan.subtasks.map((s) => (
          <li key={s.id} className="flex items-baseline justify-between gap-6 border-b border-ink/15 py-3 text-lg">
            <span>{s.title}</span>
            <span className="shrink-0 font-mono text-sm text-ink/65">{s.self_do ? 'No hire' : `Cap ${usdc(s.cap_atomic)}`}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Composer() {
  const [prompt, setPrompt] = useState('');
  const [budget, setBudget] = useState('3.00');
  const [state, action, pending] = useActionState<DraftState, FormData>(draftPlan, { kind: 'idle' });
  const invalid = state.kind === 'invalid' ? state : null;
  const wallet = useWallet();
  const locked = !wallet.account;

  return (
    <>
      <form action={action} noValidate className="mt-8 rounded-2xl border border-ink/20 transition-colors focus-within:border-accent motion-reduce:transition-none">
        <input type="hidden" name="account" value={wallet.account ?? ''} />
        <textarea
          name="prompt"
          aria-labelledby="task-question"
          aria-invalid={!!invalid?.prompt}
          aria-describedby={invalid?.prompt ? 'prompt-error' : undefined}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Due diligence on the NEAR token"
          className="block w-full resize-none rounded-t-2xl bg-transparent px-5 pt-5 pb-3 text-xl leading-snug outline-none placeholder:text-ink/55 md:px-7 md:pt-7 md:text-2xl"
        />
        {invalid?.prompt && <p id="prompt-error" className="px-5 pb-3 text-red-700 md:px-7">{invalid.prompt}</p>}

        <div className="flex flex-wrap items-end justify-between gap-4 border-t border-ink/15 px-5 py-4 md:px-7">
          <div className="min-w-0">
            <label htmlFor="budget" className="block text-sm text-ink/65">Budget</label>
            <div className="mt-1 flex items-baseline gap-2">
              <input
                id="budget"
                name="budget"
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={!!invalid?.budget}
                aria-describedby={invalid?.budget ? 'budget-error' : 'budget-hint'}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-24 rounded-md border border-ink/20 px-2 py-1.5 font-mono text-lg outline-offset-2 focus-visible:border-accent"
              />
              <span className="text-ink/65">USDC</span>
            </div>
            {invalid?.budget
              ? <p id="budget-error" className="mt-1.5 text-sm text-red-700">{invalid.budget}</p>
              : <p id="budget-hint" className="mt-1.5 text-sm text-ink/65">{reserveHint(budget)}</p>}
          </div>
          <button
            type="submit"
            disabled={pending || locked}
            title={locked ? 'Connect your wallet first' : undefined}
            className={`group inline-flex min-h-14 items-center gap-2.5 rounded-full px-7 text-lg font-medium whitespace-nowrap transition-colors duration-200 motion-reduce:transition-none ${
              locked ? 'cursor-not-allowed bg-ink/10 text-ink/55'
              : pending ? 'cursor-wait bg-accent-hover text-on-accent'
              : 'cursor-pointer bg-accent text-on-accent hover:bg-accent-hover focus-visible:bg-accent-hover active:translate-y-px'
            }`}
          >
            {pending ? 'Drafting your plan…' : 'Draft a plan'}
            {!pending && (
              <svg className="size-5 shrink-0 transition-transform duration-250 group-hover:translate-x-[3px] group-focus-visible:translate-x-[3px] motion-reduce:translate-x-0! motion-reduce:transition-none" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                <path d="M2 8h11M9 3.5 13.5 8 9 12.5" />
              </svg>
            )}
          </button>
        </div>
      </form>

      <p className="mt-3 text-center text-sm text-ink/65">You&apos;ll review the plan before anything is spent. No real money moves in this version.</p>

      {state.kind === 'error' && (
        <p role="alert" className="mt-6 rounded-2xl border border-red-700/40 bg-red-50 p-5 text-red-800">{state.message}</p>
      )}
      {state.kind === 'planned' && <PlanSummary prompt={state.prompt} plan={state.plan} />}

      {state.kind !== 'planned' && (
        <ul className="mt-6">
          {EXAMPLES.map((e) => (
            <li key={e}>
              <button
                type="button"
                onClick={() => setPrompt(e)}
                className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 text-left text-lg transition-colors hover:bg-ink/5 active:translate-y-px motion-reduce:transition-none"
              >
                <span className="size-2 shrink-0 bg-accent" aria-hidden="true" />
                {e}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
