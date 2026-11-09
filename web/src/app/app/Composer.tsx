'use client';

import { useRef, useState } from 'react';
import { checkDraft, parseBudget } from './draft';
import { useMode } from './mode';
import { useWallet } from './wallet';

export type ComposerErrors = { prompt?: string; budget?: string; message?: string };

function reserveLabel(budget: string) {
  const b = parseBudget(budget);
  // The plan keeps at least 20% for re-hires, and whatever its caps leave on top of that.
  return b.ok ? `at least ${(Number(b.atomic) / 1e6 * 0.2).toFixed(2)} held for re-hires` : 'at least 20% held for re-hires';
}

/** Stays mounted through a conversation. Clears as soon as a task is sent, and gives the text back if the send fails. */
export function Composer({ onSend, errors, sending, compact }: {
  onSend: (prompt: string, budget: string) => Promise<boolean>;
  errors: ComposerErrors | null;
  sending: boolean;
  compact: boolean; // inside a conversation: replies aren't supported yet, so sending starts a new task
}) {
  const [prompt, setPrompt] = useState('');
  const [budget, setBudget] = useState('3.00');
  const wallet = useWallet();
  const { mode } = useMode();
  const locked = !wallet.account;
  // Problems found here, before anything is sent. They show instead of the last send's errors, until the next send.
  const [found, setFound] = useState<ComposerErrors | null>(null);
  const shown = found ?? errors;
  const invalid = !!(shown?.prompt || shown?.budget);
  const form = useRef<HTMLFormElement>(null);
  const [focused, setFocused] = useState(false);
  // Phones: just a line to type in, until it's being used. The budget comes back as soon as it is.
  const folded = !focused && !prompt && !shown?.budget;

  async function submit() {
    if (locked || sending) return;
    // Checked here first, so a task that can't be sent never shows in the thread. The action checks again.
    const check = checkDraft({ prompt, budget }, mode);
    if (!check.ok) return setFound({ prompt: check.prompt, budget: check.budget });
    setFound(null);
    // Phones: put the keyboard away, or it covers the plan this is about to bring up.
    if (window.matchMedia('(max-width: 639px)').matches) (document.activeElement as HTMLElement | null)?.blur();
    // Cleared straight away: live planning can take a minute, and the sent task already shows in the thread.
    // If the send fails, the text comes back, unless something new has been typed meanwhile.
    const sent = prompt;
    setPrompt('');
    if (!(await onSend(sent, check.usdc).catch(() => false))) setPrompt((now) => now || sent);
  }

  return (
    <>
      <form
        ref={form}
        noValidate
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
        className={`relative rounded-[1.75rem] border bg-surface p-2 sm:p-3 shadow-sm shadow-ink/5 transition-[border-color,box-shadow] duration-200 focus-within:ring-4 motion-reduce:transition-none ${invalid ? 'border-red-700/50 focus-within:ring-red-700/10' : 'border-ink/15 not-focus-within:hover:border-ink/25 focus-within:border-accent/50 focus-within:ring-accent/10'}`}
      >
        <textarea
          name="prompt"
          aria-label="What do you want done?"
          aria-invalid={!!shown?.prompt}
          aria-describedby={shown?.prompt ? 'prompt-error' : undefined}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void submit();
          }}
          rows={2}
          placeholder={compact ? 'Start a new task' : 'Due diligence on the NEAR token'}
          className={`field-sizing-content block max-h-64 w-full ${compact ? 'min-h-11' : 'min-h-11 sm:min-h-20'} resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-2 sm:pt-2 ${compact ? 'text-base sm:text-lg' : 'text-base sm:text-xl md:text-2xl'} ${folded ? 'max-sm:pr-12' : ''} leading-snug outline-none placeholder:text-ink/55`}
        />

        <div className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${folded ? 'grid-rows-[1fr] max-sm:grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}>
          <div className="flex min-h-0 min-w-0 items-center gap-3 overflow-hidden pr-14">
            <label className={`mt-2 inline-flex h-11 cursor-text items-center gap-1.5 rounded-full px-4 whitespace-nowrap text-ink/65 ring-inset transition-colors duration-200 focus-within:ring-2 motion-reduce:transition-none ${shown?.budget ?'bg-red-50 ring-1 ring-red-700/50 focus-within:ring-red-700/50' : 'bg-ink/5 hover:bg-ink/10 focus-within:bg-surface focus-within:ring-accent/50'}`}>
              Budget
              <input
                name="budget"
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={!!shown?.budget}
                aria-describedby={shown?.budget ? 'budget-error' : undefined}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="field-sizing-content max-w-[9ch] min-w-[2ch] bg-transparent font-medium text-ink tabular-nums outline-none"
              />
              USDC
            </label>
            <span className="mt-2 hidden text-sm whitespace-nowrap text-ink/55 sm:inline">{reserveLabel(budget)}</span>
          </div>
        </div>
        <button
            type="submit"
            aria-label="Send task"
            disabled={sending || locked}
            title={locked ? 'Connect your wallet first' : undefined}
            className={`group absolute right-2 bottom-2 grid size-11 place-items-center rounded-full sm:right-3 sm:bottom-3 transition-colors duration-200 motion-reduce:transition-none ${locked ? 'cursor-not-allowed bg-ink/10 text-ink/55'
                : sending ? 'cursor-wait bg-accent-hover text-on-accent'
                  : 'cursor-pointer bg-accent text-on-accent hover:bg-accent-hover focus-visible:bg-accent-hover active:translate-y-px'
              }`}
          >
            <svg className="size-5 shrink-0 transition-transform duration-250 group-enabled:group-hover:translate-x-0.75 group-focus-visible:translate-x-0.75 motion-reduce:translate-x-0! motion-reduce:transition-none" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                <path d="M2 8h11M9 3.5 13.5 8 9 12.5" />
            </svg>
        </button>
      </form>
      {shown?.prompt && <p id="prompt-error" className="mt-2 px-4 text-sm text-alert">{shown.prompt}</p>}
      {shown?.budget && <p id="budget-error" className="mt-2 px-4 text-sm text-alert">{shown.budget}</p>}
      {shown?.message && <p role="alert" className="mt-3 rounded-2xl border border-alert/40 bg-alert/10 p-4 text-alert">{shown.message}</p>}
    </>
  );
}
