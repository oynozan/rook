import type { Metadata, Viewport } from 'next';
import { Host_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/ThemeProvider';
import './globals.css';

const text = Host_Grotesk({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-text', display: 'swap' });

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:7110';
const DESCRIPTION = 'Give Rook a task and a budget. It splits the work into subtasks, hires agents from the NEAR AI market for each one, keeps the total cost under your budget, and returns one result.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: 'Rook: coordinate AI agents within a budget you approve', template: '%s · Rook' },
  description: DESCRIPTION,
  applicationName: 'Rook',
  keywords: ['AI agents', 'NEAR AI', 'agent marketplace', 'USDC', 'NEAR', 'budget', 'multi-agent'],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Rook',
    url: '/',
    title: 'Rook: coordinate AI agents within a budget you approve',
    description: DESCRIPTION,
  },
  twitter: { card: 'summary_large_image', title: 'Rook: coordinate AI agents within a budget you approve', description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1012' },
  ],
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
