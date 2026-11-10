import type { ReactNode } from 'react';
import { AppShell } from '@/components/app/AppShell';
import { Chat } from '@/components/app/Chat';
import { ModeProvider } from '@/hooks/mode';
import { getMode, listTasks, whyUnreachable } from '@/lib/server/orchestrator';
import { currentAccount } from '@/lib/server/session';
import { WalletProvider } from '@/hooks/wallet';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  // The page says why Rook can't be read (not running, ROOK_SERVICE_TOKEN differs, an error); the log keeps it too.
  let down: string | null = null;
  const unreachable = (e: unknown) => { console.error('[web] orchestrator:', e instanceof Error ? e.message : e); down ??= whyUnreachable(e); return null; };
  const [owner, mode] = await Promise.all([currentAccount(), getMode().catch(unreachable)]);
  // Only the signed-in account's tasks; signed out, the list is empty. null still means the services are down.
  const tasks = owner ? await listTasks(owner).catch(unreachable) : mode ? [] : null;
  return (
    <ModeProvider mode={mode} down={down}>
      <WalletProvider account={owner}>
        <AppShell tasks={tasks}>
          <Chat tasks={tasks} />
          {children}
        </AppShell>
      </WalletProvider>
    </ModeProvider>
  );
}
