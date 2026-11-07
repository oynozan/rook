'use client';

import { useRef, useState } from 'react';
import { useWallet } from './wallet';

export type ComposerErrors = { prompt?: string; budget?: string; message?: string };

function reserveLabel(budget: string) {
  const n = Number(budget);
  return budget.trim() && n > 0 ? `${(n * 0.2).toFixed(2)} held for re-hires` : '20% held for re-hires';
}

/** Stays mounted through a conversation, so typed text survives a failed send. Clears only when the send succeeds. */
export function Composer({ onSend, errors, sending, compact }: {
  onSend: (prompt: string, budget: string) => Promise<boolean>;
  errors: ComposerErrors | null;
  sending: boolean;
  compact: boolean; // inside a conversation: replies aren't supported yet, so sending starts a new task
}) {
  const [prompt, setPrompt] = useState('');
  const [budget, setBudget] = useState('3.00');
  const wallet = useWallet();
  const locked = !wallet.account;
  const invalid = !!(errors?.prompt || errors?.budget);
  const form = useRef<HTMLFormElement>(null);

  async function submit() {
    if (locked || sending) return;
    if (await onSend(prompt, budget)) setPrompt('');
  }

  return (
    <>
      <form
        ref={form}
        noValidate
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        className={`rounded-[1.75rem] border bg-white p-3 shadow-sm shadow-ink/5 transition-[border-color,box-shadow] duration-200 focus-within:ring-4 motion-reduce:transition-none ${invalid ? 'border-red-700/50 focus-within:ring-red-700/10' : 'border-ink/15 not-focus-within:hover:border-ink/25 focus-within:border-accent/50 focus-within:ring-accent/10'}`}
      >
        <textarea
          name="prompt"
          aria-label="What do you want done?"
          aria-invalid={!!errors?.prompt}
          aria-describedby={errors?.prompt ? 'prompt-error' : undefined}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void submit();
          }}
          rows={2}
          placeholder={compact ? 'Start a new task' : 'Due diligence on the NEAR token'}
          className={`field-sizing-content block max-h-64 w-full ${compact ? 'min-h-11' : 'min-h-20'} resize-none overflow-y-auto bg-transparent px-3 pt-2 pb-2 ${compact ? 'text-lg' : 'text-xl'} leading-snug outline-none placeholder:text-ink/55 ${compact ? '' : 'md:text-2xl'}`}
        />

        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <label className={`inline-flex h-11 cursor-text items-center gap-1.5 rounded-full px-4 whitespace-nowrap text-ink/65 ring-inset transition-colors duration-200 focus-within:ring-2 motion-reduce:transition-none ${errors?.budget ? 'bg-red-50 ring-1 ring-red-700/50 focus-within:ring-red-700/50' : 'bg-ink/5 hover:bg-ink/10 focus-within:bg-white focus-within:ring-accent/50'}`}>
              Budget
              <input
                name="budget"
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={!!errors?.budget}
                aria-describedby={errors?.budget ? 'budget-error' : undefined}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="field-sizing-content max-w-[9ch] min-w-[2ch] bg-transparent font-medium text-ink tabular-nums outline-none"
              />
              USDC
            </label>
            <span className="hidden text-sm whitespace-nowrap text-ink/55 sm:inline">{reserveLabel(budget)}</span>
          </div>
          <button
            type="submit"
            aria-label="Send task"
            disabled={sending || locked}
            title={locked ? 'Connect your wallet first' : undefined}
            className={`group grid size-11 shrink-0 place-items-center rounded-full transition-colors duration-200 motion-reduce:transition-none ${locked ? 'cursor-not-allowed bg-ink/10 text-ink/55'
                : sending ? 'cursor-wait bg-accent-hover text-on-accent'
                  : 'cursor-pointer bg-accent text-on-accent hover:bg-accent-hover focus-visible:bg-accent-hover active:translate-y-px'
              }`}
          >
            <svg className="size-5 shrink-0 transition-transform duration-250 group-enabled:group-hover:translate-x-0.75 group-focus-visible:translate-x-0.75 motion-reduce:translate-x-0! motion-reduce:transition-none" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path d="M2 8h11M9 3.5 13.5 8 9 12.5" />
            </svg>
          </button>
        </div>
      </form>
      {errors?.prompt && <p id="prompt-error" className="mt-2 px-4 text-sm text-red-700">{errors.prompt}</p>}
      {errors?.budget && <p id="budget-error" className="mt-2 px-4 text-sm text-red-700">{errors.budget}</p>}
      {errors?.message && <p role="alert" className="mt-3 rounded-2xl border border-red-700/40 bg-red-50 p-4 text-red-800">{errors.message}</p>}
    </>
  );
}
