'use client';

// The conversation's buttons and its open/close motion, shared by the chat and the run's views.
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode, Ref } from 'react';
import { useEase } from '@/hooks/useEase';

/** `submit`: the form's submit button (no onClick needed). `buttonRef`: for focus to come back to it. */
export function ActionButton({ onClick, busy, disabled, title, primary, submit, buttonRef, children }: {
  onClick?: () => void; busy?: boolean; disabled?: boolean; title?: string; primary?: boolean; submit?: boolean; buttonRef?: Ref<HTMLButtonElement>; children: ReactNode;
}) {
  const off = disabled || busy;
  return (
    <button
      ref={buttonRef}
      type={submit ? 'submit' : 'button'}
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

/** A small text button, for actions on one row (a file, a part). At least 44 px tall, for a finger. */
export function RowButton({ onClick, expanded, controls, children }: { onClick: () => void; expanded?: boolean; controls?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
      className="inline-flex min-h-11 cursor-pointer items-center rounded-full px-3 text-sm text-ink/70 transition-colors hover:bg-ink/5 hover:text-ink active:translate-y-px motion-reduce:transition-none"
    >
      {children}
    </button>
  );
}

/** Opens and closes by height. */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
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
