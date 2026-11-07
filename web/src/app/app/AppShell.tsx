'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Mark } from '@/components/Navbar';
import type { TaskSummary } from './orchestrator';
import { useWallet } from './wallet';
import { AccountMenu, WalletButton } from './WalletButton';

const STATUS: Record<string, string> = {
  draft: 'Drafting',
  planned: 'Plan ready',
  approved: 'Starting',
  funded: 'Starting',
  running: 'Running',
  aggregating: 'Combining results',
  closing: 'Closing',
  closed: 'Closed',
  cancelled: 'Cancelled',
  killed: 'Stopped',
  failed: 'Failed',
};
const ACTIVE = new Set(['planned', 'approved', 'funded', 'running', 'aggregating', 'closing']);

/** Changes the URL without leaving the page: the conversation in the layout reads it and stays mounted. */
export function go(path: string, e?: MouseEvent) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) return; // let new-tab clicks through
  e?.preventDefault();
  if (window.location.pathname !== path) window.history.pushState(null, '', path);
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <a href="/app" onClick={(e) => { go('/app', e); onNavigate?.(); }} className="inline-flex items-center gap-2 py-1 text-2xl font-medium tracking-[-0.015em]">
      <Mark />
      rook
    </a>
  );
}

function PanelToggle({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg transition-colors hover:bg-ink/5 active:translate-y-px motion-reduce:transition-none"
    >
      <svg className="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
        <path d="M7.5 3.5v13" />
      </svg>
    </button>
  );
}

function TaskList({ tasks, onNavigate }: { tasks: TaskSummary[] | null; onNavigate: () => void }) {
  const pathname = usePathname();
  if (tasks === null) return <p className="px-3 text-sm text-ink/65">Rook&apos;s services aren&apos;t running. Start them with pnpm dev to see your tasks.</p>;
  if (!tasks.length) return <p className="px-3 text-sm text-ink/65">Tasks you draft will appear here.</p>;
  const recent = [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <ul>
      {recent.map((t) => {
        const href = `/app/${t.id}`;
        const current = pathname === href;
        return (
          <li key={t.id}>
            <a
              href={href}
              aria-current={current ? 'page' : undefined}
              onClick={(e) => { go(href, e); onNavigate(); }}
              className={`block rounded-lg px-3 py-2 transition-colors motion-reduce:transition-none ${current ? 'bg-ink/10' : 'hover:bg-ink/5'}`}
            >
              <span className="block truncate" title={t.prompt}>{t.prompt}</span>
              <span className={`mt-0.5 flex items-center gap-1.5 text-sm ${ACTIVE.has(t.status) ? 'text-accent' : 'text-ink/65'}`}>
                {ACTIVE.has(t.status) && <span className="size-2 shrink-0 bg-accent" aria-hidden="true" />}
                {STATUS[t.status] ?? t.status}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function AppShell({ tasks, children }: { tasks: TaskSummary[] | null; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false); // wide screens: the sidebar is in the layout unless collapsed
  const [drawer, setDrawer] = useState(false); // phones: the sidebar slides over the page
  const openButton = useRef<HTMLDivElement>(null);
  const wallet = useWallet();

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDrawer(false);
      openButton.current?.querySelector('button')?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {drawer && <button type="button" aria-label="Close your tasks" tabIndex={-1} onClick={() => setDrawer(false)} className="fixed inset-0 z-20 bg-ink/40 md:hidden" />}

      <aside
        aria-label="Your tasks"
        className={`fixed inset-y-0 left-0 z-30 flex w-72 max-w-[85vw] shrink-0 flex-col border-r border-ink/10 bg-panel transition-transform duration-250 motion-reduce:transition-none md:static md:z-auto md:max-w-none md:translate-x-0 md:transition-none ${drawer ? 'translate-x-0' : '-translate-x-full max-md:invisible'} ${collapsed ? 'md:hidden' : ''}`}
      >
        <div className="flex items-center justify-between gap-2 py-3 pr-2 pl-4">
          <Brand onNavigate={() => setDrawer(false)} />
          <PanelToggle label="Close sidebar" onClick={() => { if (drawer) setDrawer(false); else setCollapsed(true); }} />
        </div>
        <div className="px-2">
          <a href="/app" onClick={(e) => { go('/app', e); setDrawer(false); }} className="flex min-h-11 items-center gap-2.5 rounded-lg bg-ink/5 px-3 font-medium transition-colors hover:bg-ink/10 active:translate-y-px motion-reduce:transition-none">
            <svg className="size-4 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" /></svg>
            New task
          </a>
        </div>
        <h2 className="mt-6 px-5 text-sm text-ink/65">Your tasks</h2>
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <TaskList tasks={tasks} onNavigate={() => setDrawer(false)} />
        </div>
        {wallet.account && (
          <div className="border-t border-ink/10 p-2">
            <AccountMenu inSidebar account={wallet.account} onDisconnect={wallet.disconnect} />
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Connected with the sidebar open, nothing is left up here on wide screens, so the bar goes away. */}
        <header className={`flex min-h-[4.75rem] items-center justify-between gap-3 px-3 py-3 md:px-5 ${wallet.account && !collapsed ? 'md:hidden' : ''}`}>
          <div ref={openButton} className="flex min-w-0 items-center gap-1">
            <div className="md:hidden"><PanelToggle label="Open your tasks" onClick={() => setDrawer(true)} /></div>
            {collapsed && (
              <div className="max-md:hidden"><PanelToggle label="Open sidebar" onClick={() => setCollapsed(false)} /></div>
            )}
            <div className={collapsed ? 'ml-1' : 'ml-1 md:hidden'}><Brand /></div>
          </div>
          {wallet.account
            ? collapsed && <div className="max-md:hidden"><AccountMenu account={wallet.account} onDisconnect={wallet.disconnect} /></div>
            : !wallet.checking && <WalletButton />}
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
