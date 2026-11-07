'use client';

import { ThemeProvider as NextThemes } from 'next-themes';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** The theme belongs to the app. Every other page stays light, whatever was chosen there. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const inApp = /^\/app(\/|$)/.test(usePathname());
  return (
    <NextThemes attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange forcedTheme={inApp ? undefined : 'light'}>
      {children}
    </NextThemes>
  );
}
