'use client';

// Adapted from Skiper UI's Theme Toggle Btn, skiper26 (https://skiper-ui.com/v1/skiper26), by @gurvinder-singh02, which
// credits rudrodip's theme-toggle-effect (https://github.com/rudrodip/theme-toggle-effect). Free version: attribution to
// Skiper UI required. Fixed to the rectangle variant with blur; its reveal is `::view-transition-*` in globals.css.

import { motion, useReducedMotion } from 'motion/react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { cn } from '@/lib/utils';

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [ready, setReady] = useState(false); // the saved theme is only known in the browser
  const reduced = useReducedMotion();
  useEffect(() => setReady(true), []);
  const dark = ready && resolvedTheme === 'dark';
  const turn = { ease: 'easeInOut', duration: reduced ? 0 : 0.5 } as const;

  function toggle() {
    const next = dark ? 'light' : 'dark';
    if (reduced || !document.startViewTransition) return setTheme(next);
    // flushSync: the new theme has to be on the page before the browser takes its "after" picture.
    document.startViewTransition(() => flushSync(() => setTheme(next)));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className={cn('size-9 cursor-pointer rounded-full bg-black p-0 ring-1 ring-ink/15 transition-transform after:absolute after:-inset-1 sm:size-11 sm:after:hidden duration-300 active:scale-95 motion-reduce:transition-none', className)}
    >
      {/* Remounts once the theme is known, so a saved dark theme doesn't spin into place on load. */}
      <svg key={String(ready)} viewBox="0 0 240 240" fill="none" aria-hidden="true">
        <motion.g initial={false} animate={{ rotate: dark ? -180 : 0 }} transition={turn}>
          <path d="M120 67.5C149.25 67.5 172.5 90.75 172.5 120C172.5 149.25 149.25 172.5 120 172.5" fill="white" />
          <path d="M120 67.5C90.75 67.5 67.5 90.75 67.5 120C67.5 149.25 90.75 172.5 120 172.5" fill="black" />
        </motion.g>
        <motion.path
          initial={false}
          animate={{ rotate: dark ? 180 : 0 }}
          transition={turn}
          d="M120 3.75C55.5 3.75 3.75 55.5 3.75 120C3.75 184.5 55.5 236.25 120 236.25C184.5 236.25 236.25 184.5 236.25 120C236.25 55.5 184.5 3.75 120 3.75ZM120 214.5V172.5C90.75 172.5 67.5 149.25 67.5 120C67.5 90.75 90.75 67.5 120 67.5V25.5C172.5 25.5 214.5 67.5 214.5 120C214.5 172.5 172.5 214.5 120 214.5Z"
          fill="white"
        />
      </svg>
    </button>
  );
}
