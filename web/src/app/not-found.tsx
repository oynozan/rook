import type { Metadata } from 'next';
import { Navbar } from '@/components/Navbar';

export const metadata: Metadata = { title: 'Page not found', robots: { index: false } };

export default function NotFound() {
  return (
    <>
      <Navbar />
      <main className="px-[clamp(1.25rem,6vw,6rem)] pt-16 md:pt-28">
        <h1 className="text-[clamp(2.75rem,6vw,5rem)] leading-[1.05] font-normal tracking-[-0.035em]">Page not found</h1>
      </main>
    </>
  );
}
