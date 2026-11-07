import type { ReactNode } from 'react';
import { AppShell } from './AppShell';
import { listTasks } from './orchestrator';
import { WalletProvider } from './wallet';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const tasks = await listTasks().catch(() => null);
  return (
    <WalletProvider>
      <AppShell tasks={tasks}>{children}</AppShell>
    </WalletProvider>
  );
}
