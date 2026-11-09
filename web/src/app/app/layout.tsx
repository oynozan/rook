import type { ReactNode } from 'react';
import { AppShell } from './AppShell';
import { Chat } from './Chat';
import { ModeProvider } from './mode';
import { getMode, listTasks } from './orchestrator';
import { WalletProvider } from './wallet';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [tasks, mode] = await Promise.all([listTasks().catch(() => null), getMode().catch(() => null)]);
  return (
    <ModeProvider mode={mode}>
      <WalletProvider>
        <AppShell tasks={tasks}>
          <Chat tasks={tasks} />
          {children}
        </AppShell>
      </WalletProvider>
    </ModeProvider>
  );
}
