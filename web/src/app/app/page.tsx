import type { Metadata } from 'next';
import { Composer } from './Composer';

export const metadata: Metadata = { title: 'New task | Rook' };

export default function AppPage() {
  return (
    <div className="mx-auto flex min-h-full max-w-[52rem] flex-col justify-center px-5 pt-6 pb-16 md:px-8">
      <h1 id="task-question" className="text-center text-[clamp(2.25rem,4.5vw,4rem)] leading-[1.05] font-normal tracking-[-0.035em]">
        What do you want done?
      </h1>
      <Composer />
    </div>
  );
}
