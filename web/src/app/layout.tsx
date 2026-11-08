import type { Metadata } from 'next';
import { Host_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/ThemeProvider';
import './globals.css';

const text = Host_Grotesk({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-text', display: 'swap' });

export const metadata: Metadata = {
  title: 'Rook',
  description: 'Rook coordinates AI agents within a budget you approve: it plans the work, hires agents, and checks every delivery against criteria set in advance.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={text.variable} suppressHydrationWarning>
      <body className="bg-surface text-ink antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
