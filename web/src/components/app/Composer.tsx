'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { budgetField, outgoing, placeholderFor, waitReason } from '@/lib/conversations';
import { checkDraft } from '@/lib/draft';
import { useMode } from '@/hooks/mode';
import type { TaskSummary } from '@/lib/server/orchestrator';
import { useWallet } from '@/hooks/wallet';

// Tasks that plan well on the live NEAR AI market, each with a budget it fits (1 USDC is the contract's minimum).
const icon = 'size-5 shrink-0 text-ink/70';
const EXAMPLES = [
  {
    label: 'Write a launch post in three languages', budget: '1.00',
    prompt: 'Write a product announcement for a budgeting app, translate it into French and Spanish, and draft three short social posts to go with it.',
    // Two speech marks: one message, more than one language.
    icon: <svg className={icon} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5h8.5v6H7L4.5 12.5v-2H3z" /><path d="M11.5 7.5H17v6h-1.5v2L13 13.5H8.5v-3" /></svg>,
  },
  {
    label: "Audit a website's SEO", budget: '1.00',
    prompt: 'Audit the SEO of https://near.org and list the ten fixes that would help most, in order.',
    icon: <svg className={icon} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="8.75" cy="8.75" r="5" /><path d="m12.5 12.5 4 4" /></svg>,
  },
  {
    label: "Brief me on this week's NEAR news", budget: '2.00',
    prompt: "Summarise this week's NEAR ecosystem news into a one-page brief with links to the sources.",
    icon: <svg className={icon} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3.5" width="14" height="13" rx="2" /><path d="M6.5 7.5h7M6.5 10.5h7M6.5 13.5h4" /></svg>,
  },
];

export type ComposerErrors = { prompt?: string; budget?: string; message?: string };

/**
 * A conversation page: the task a message follows (`parent`), the one it acts on (`current`: a plan it revises, or work
 * it follows up on; null while the page doesn't know the conversation yet) and the budget to start from.
 */
export type ComposerThread = { parent: string; root?: string; current: TaskSummary | null; budget_atomic?: string };

/** Stays mounted through a conversation. Clears as soon as a message is sent, and gives the text back if the send fails. */
export function Composer({ onSend, errors, sending, compact, thread }: {
  onSend: (prompt: string, budget: string) => Promise<boolean>;
  errors: ComposerErrors | null;
  sending: boolean;
  compact: boolean; // inside a conversation, or sending its first message
  thread: ComposerThread | null; // null: the message starts a new conversation
}) {
  const [prompt, setPrompt] = useState('');
  const [budget, setBudget] = useState('3.00');
  // A conversation's budget starts at its newest task's, and again after each message, unless the field holds one the
  // user typed and hasn't sent yet.
  // Another conversation starts from its own budget, whatever was typed in the last one.
  const parent = thread?.parent, root = thread?.root, startBudget = thread?.budget_atomic;
  const lastStart = useRef<{ root?: string; start?: string }>({});
  useEffect(() => {
    if (!parent || !startBudget) return;
    const was = lastStart.current.root === root ? lastStart.current.start : undefined;
    lastStart.current = { root, start: startBudget };
    setBudget((field) => budgetField(field, was, startBudget));
  }, [parent, root, startBudget]);
  const current = thread?.current ?? null;
  const wallet = useWallet();
  const { mode, chain } = useMode();
  const locked = !wallet.account;
  // Problems found here, before anything is sent. They show instead of the last send's errors, until the next send, a
  // sign-in or another page.
  const [found, setFound] = useState<ComposerErrors | null>(null);
  const pathname = usePathname();
  useEffect(() => { setFound(null); }, [locked, pathname]);
  const shown = found ?? errors;
  const invalid = !!(shown?.prompt || shown?.budget);
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  // Phones: just a line to type in, until it's being used. The budget comes back as soon as it is.
  const folded = !focused && !prompt && !shown?.budget;

  async function submit() {
    if (sending) return;
    if (locked) return setFound({ message: 'Connect your NEAR wallet to send this task.' }); // the text stays
    const wait = current && waitReason(current.status, chain);
    if (wait) return setFound({ message: wait }); // the orchestrator refuses it too
    // Checked here first, so a task that can't be sent never shows in the thread. The action checks again. In a
    // conversation a changed budget alone asks for the same task at that budget.
    const check = checkDraft({ prompt: thread ? outgoing(prompt, budget, current) : prompt, budget }, mode);
    if (!check.ok) return setFound({ prompt: check.prompt && thread && !prompt.trim() ? 'Type a message, or change the budget.' : check.prompt, budget: check.budget });
    setFound(null);
    // Phones: put the keyboard away, or it covers the plan this is about to bring up.
    if (window.matchMedia('(max-width: 639px)').matches) (document.activeElement as HTMLElement | null)?.blur();
    // Cleared straight away: live planning can take a minute, and the sent task already shows in the thread.
    // If the send fails, the text comes back, unless something new has been typed meanwhile.
    const sent = prompt;
    setPrompt('');
    if (!(await onSend(check.prompt, check.usdc).catch(() => false))) setPrompt((now) => now || sent);
  }

  // Only on the empty screen, until something is typed. A pick fills the task and its budget, ready to edit or send.
  // Phones: above the input pinned to the bottom. Wider: below it, as a list.
  const examples = !compact && !thread && (
    <ul className={`flex flex-col px-2 transition-opacity duration-200 motion-reduce:transition-none max-sm:order-first max-sm:mb-3 sm:mt-6 sm:px-4 ${prompt ? 'pointer-events-none opacity-0' : ''}`} inert={!!prompt}>
      {EXAMPLES.map((x) => (
        <li key={x.label}>
          <button
            type="button"
            onClick={() => { setPrompt(x.prompt); setBudget(x.budget); field.current?.focus(); }}
            className="-mx-2 flex min-h-11 w-[calc(100%+1rem)] cursor-pointer items-center gap-3.5 rounded-xl px-2 text-left text-ink/80 transition-colors duration-200 hover:bg-ink/5 hover:text-ink active:translate-y-px motion-reduce:transition-none sm:text-lg"
          >
            {x.icon}
            {x.label}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="flex flex-col">
      <form
        ref={form}
        noValidate
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
        className={`relative rounded-[1.75rem] border bg-surface p-2 sm:p-3 shadow-sm shadow-ink/5 transition-[border-color,box-shadow] duration-200 focus-within:ring-4 motion-reduce:transition-none ${invalid ? 'border-alert/50 focus-within:ring-alert/10' : 'border-ink/15 not-focus-within:hover:border-ink/25 focus-within:border-accent/50 focus-within:ring-accent/10'}`}
      >
        <textarea
          ref={field}
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
          placeholder={thread ? placeholderFor(current, budget, chain) : compact ? 'Start a new task' : 'Describe a task, or pick an example'}
          className={`field-sizing-content block max-h-64 w-full ${compact ? 'min-h-11' : 'min-h-11 sm:min-h-20'} resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-2 sm:pt-2 ${compact ? 'text-base sm:text-lg' : 'text-base sm:text-xl md:text-2xl'} ${folded ? 'max-sm:pr-12' : ''} leading-snug outline-none placeholder:text-ink/55`}
        />

        <div className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${folded ? 'grid-rows-[1fr] max-sm:grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}>
          <div className="flex min-h-0 min-w-0 items-center gap-3 overflow-hidden pr-14">
            <label className={`mt-2 inline-flex h-11 cursor-text items-center gap-1.5 rounded-full px-4 whitespace-nowrap text-ink/65 ring-inset transition-colors duration-200 focus-within:ring-2 motion-reduce:transition-none ${shown?.budget ? 'bg-alert/10 text-ink ring-1 ring-alert/50 focus-within:ring-alert/50' : 'bg-ink/5 hover:bg-ink/10 focus-within:bg-surface focus-within:ring-accent/50'}`}>
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
          </div>
        </div>
        <button
            type="submit"
            aria-label={thread ? 'Send message' : 'Send task'}
            disabled={sending}
            aria-disabled={locked || undefined} // still pressable: it says to connect first (a tooltip never shows on a phone)
            title={locked ? 'Connect your wallet first' : undefined}
            className={`group absolute right-2 bottom-2 grid size-11 place-items-center rounded-full sm:right-3 sm:bottom-3 transition-colors duration-200 motion-reduce:transition-none ${locked ? 'cursor-not-allowed bg-ink/10 text-ink/55'
                : sending ? 'cursor-wait bg-accent-hover text-on-accent'
                  : 'cursor-pointer bg-accent text-on-accent hover:bg-accent-hover focus-visible:bg-accent-hover active:translate-y-px'
              }`}
          >
            <svg className="size-5 shrink-0 transition-transform duration-250 group-enabled:group-hover:translate-x-0.75 group-focus-visible:translate-x-0.75 group-aria-disabled:translate-x-0! motion-reduce:translate-x-0! motion-reduce:transition-none" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                <path d="M2 8h11M9 3.5 13.5 8 9 12.5" />
            </svg>
        </button>
      </form>
      {shown?.prompt && <p id="prompt-error" className="mt-2 px-4 text-sm text-alert">{shown.prompt}</p>}
      {shown?.budget && <p id="budget-error" className="mt-2 px-4 text-sm text-alert">{shown.budget}</p>}
      {shown?.message && <p role="alert" className="mt-3 rounded-2xl border border-alert/40 bg-alert/10 p-4 text-alert">{shown.message}</p>}
      {examples}
    </div>
  );
}
