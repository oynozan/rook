import type { ReactNode } from 'react';
import { AppShell } from './AppShell';
import { Chat } from './Chat';
import { ModeProvider } from './mode';
import { getMode, listTasks } from './orchestrator';
import { currentAccount } from './session';
import { WalletProvider } from './wallet';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [owner, mode] = await Promise.all([currentAccount(), getMode().catch(() => null)]);
  // Only the signed-in account's tasks; signed out, the list is empty. null still means the services are down.
  const tasks = owner ? await listTasks(owner).catch(() => null) : mode ? [] : null;
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
