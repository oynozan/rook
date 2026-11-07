import type { Metadata } from 'next';
import { Host_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const text = Host_Grotesk({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-text', display: 'swap' });

export const metadata: Metadata = { title: 'Rook' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={text.variable}>
      <body className="bg-white text-ink antialiased">{children}</body>
    </html>
  );
}
