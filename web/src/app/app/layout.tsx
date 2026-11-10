import type { ReactNode } from 'react';
import { AppShell } from '@/components/app/AppShell';
import { Chat } from '@/components/app/Chat';
import { ModeProvider } from '@/hooks/mode';
import { getMode, listTasks } from '@/lib/server/orchestrator';
import { currentAccount } from '@/lib/server/session';
import { WalletProvider } from '@/hooks/wallet';

export const dynamic = 'force-dynamic';

// The page only says Rook's services are unreachable; why (not running, or ROOK_SERVICE_TOKEN differs) goes to the log.
const unreachable = (e: unknown) => { console.error('[web] orchestrator:', e instanceof Error ? e.message : e); return null; };

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [owner, mode] = await Promise.all([currentAccount(), getMode().catch(unreachable)]);
  // Only the signed-in account's tasks; signed out, the list is empty. null still means the services are down.
  const tasks = owner ? await listTasks(owner).catch(unreachable) : mode ? [] : null;
  return (
    <ModeProvider mode={mode}>
      <WalletProvider account={owner}>
        <AppShell tasks={tasks}>
          <Chat tasks={tasks} />
          {children}
        </AppShell>
      </WalletProvider>
    </ModeProvider>
  );
}
