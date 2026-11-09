'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useTheme } from 'next-themes';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Mark } from '@/components/Navbar';
import { useSmoothScroll } from '@/components/SmoothScroll';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { useMode } from './mode';
import type { TaskSummary } from './orchestrator';
import { useEase } from './useEase';
import { UserAvatar } from './UserAvatar';
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

// Matches the sidebar's width animation, for the parts that CSS moves.
const GLIDE = 'duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none';

function Brand({ rail, onNavigate }: { rail?: boolean; onNavigate?: () => void }) {
  return (
    <a href="/app" onClick={(e) => { go('/app', e); onNavigate?.(); }} className="inline-flex items-center gap-2 py-1 text-2xl font-medium tracking-[-0.015em]">
      <Mark />
      <span className={`transition-opacity ${GLIDE} ${rail ? 'opacity-0' : ''}`}>rook</span>
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
  const { chain } = useMode(); // chain mode: an approved task waits for the owner's funding transfer
  const label = (s: string) => (chain && s === 'approved' ? 'Needs funding' : STATUS[s] ?? s);
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
              <span className={`mt-0.5 flex items-center gap-1.5 text-sm ${ACTIVE.has(t.status) ? 'text-accent-ink' : 'text-ink/65'}`}>
                {ACTIVE.has(t.status) && <span className="size-2 shrink-0 bg-accent" aria-hidden="true" />}
                {label(t.status)}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function TaskScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useSmoothScroll(ref);
  return <div ref={ref} className="mt-1 min-h-0 flex-1 overflow-y-auto px-3.5 pb-4"><div>{children}</div></div>;
}

type SidebarProps = {
  tasks: TaskSummary[] | null;
  rail?: boolean; // wide screens, collapsed: only the left column of this content shows
  toggleLabel?: string;
  onToggle: () => void;
  onNavigate: () => void;
  onExpand?: () => void;
  avatarRef?: Ref<HTMLButtonElement>;
};

/**
 * One layout for both states. Everything a rail shows is centred on the same line (36px from the left) and at the same
 * height whether the sidebar is open or not, so narrowing it only hides what's to the right, and the icons never move.
 */
function SidebarContent({ tasks, rail = false, toggleLabel = 'Close sidebar', onToggle, onNavigate, onExpand, avatarRef }: SidebarProps) {
  const wallet = useWallet();
  const fade = `transition-opacity ${GLIDE} ${rail ? 'opacity-0' : ''}`;
  const busy = tasks?.some((t) => ACTIVE.has(t.status));
  return (
    <>
      <div className="relative flex h-17 shrink-0 items-center pl-5.5">
        <Brand rail={rail} onNavigate={onNavigate} />
        <div inert={rail} className={`absolute top-3 right-2 ${fade}`}><PanelToggle label={toggleLabel} onClick={onToggle} /></div>
      </div>

      <a
        href="/app"
        title={rail ? 'New task' : undefined}
        onClick={(e) => { go('/app', e); onNavigate(); }}
        className={`ml-3.5 flex min-h-11 shrink-0 items-center gap-2.5 overflow-hidden rounded-lg bg-ink/5 pl-3.5 font-medium whitespace-nowrap transition-[width,background-color] ${GLIDE} hover:bg-ink/10 active:translate-y-px ${rail ? 'w-11' : 'w-[calc(100%-1.75rem)]'}`}
      >
        <svg className="size-4 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" /></svg>
        <span className={fade}>New task</span>
      </a>

      <div className="relative mt-3 flex h-11 shrink-0 items-center">
        <h2 className={`pl-6.5 text-sm text-ink/65 ${fade}`}>Your tasks</h2>
        {onExpand && (
          <button
            type="button"
            inert={!rail}
            aria-label="Your tasks"
            title="Your tasks"
            onClick={onExpand}
            className={`absolute top-0 left-3.5 grid size-11 cursor-pointer place-items-center rounded-lg transition-[opacity,background-color] ${GLIDE} hover:bg-ink/5 ${rail ? '' : 'opacity-0'}`}
          >
            <svg className="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M7 5.5h10M7 10h10M7 14.5h10M3 5.5h.01M3 10h.01M3 14.5h.01" /></svg>
            {busy && <span className="absolute top-2.5 right-2.5 size-2 bg-accent" aria-hidden="true" />}
          </button>
        )}
      </div>
      <div inert={rail} className={`flex min-h-0 flex-1 flex-col ${fade}`}>
        <TaskScroller><TaskList tasks={tasks} onNavigate={onNavigate} /></TaskScroller>
      </div>

      <div inert={!rail} className={`grid shrink-0 transition-[grid-template-rows] ${GLIDE} ${rail ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="min-h-0 overflow-hidden pl-3.5"><PanelToggle label="Open sidebar" onClick={onToggle} /></div>
      </div>
      {wallet.account && (
        <div className={`shrink-0 px-3.5 py-2 ${rail ? '' : 'border-t border-ink/10'}`}>
          {rail ? (
            <button
              ref={avatarRef}
              type="button"
              aria-label={`Open sidebar, signed in as ${wallet.account}`}
              onClick={onExpand}
              className="grid size-11 cursor-pointer place-items-center rounded-lg transition-colors hover:bg-ink/5 motion-reduce:transition-none"
            >
              <UserAvatar account={wallet.account} size={26} />
            </button>
          ) : (
            <AccountMenu account={wallet.account} onDisconnect={wallet.disconnect} />
          )}
        </div>
      )}
    </>
  );
}

const SIDEBAR_WIDTH = 288;
const RAIL_WIDTH = 72;
const PEEK_OPEN_MS = 150; // a pointer just crossing the rail shouldn't open anything
const PEEK_CLOSE_MS = 220; // room to cross a small gap without the sidebar running away

export function AppShell({ tasks, children }: { tasks: TaskSummary[] | null; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false); // wide screens: collapsed leaves a rail of icons
  const [drawer, setDrawer] = useState(false); // phones: the sidebar slides over the page
  const [peek, setPeek] = useState(false); // wide screens, collapsed: hovering the rail opens the sidebar over the page
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const avatar = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLDivElement>(null);
  const wallet = useWallet();
  const ease = useEase();
  const pathname = usePathname();
  const visible = !collapsed || peek;
  const topBarHidden = !!wallet.account; // wide screens: nothing is left up there but the theme toggle, which sits clear of the thread

  const peekAfter = (next: boolean, ms: number) => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(next), ms);
  };
  const setSidebar = (isCollapsed: boolean) => {
    clearTimeout(peekTimer.current);
    setPeek(false);
    setCollapsed(isCollapsed);
  };
  useEffect(() => () => clearTimeout(peekTimer.current), []);

  // The theme can only be changed with a wallet connected, so without one the app goes back to light.
  const { setTheme } = useTheme();
  const signedOut = !wallet.checking && !wallet.account;
  useEffect(() => { if (signedOut) setTheme('light'); }, [signedOut, setTheme]);

  useEffect(() => {
    if (!drawer && !peek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (peek) {
        clearTimeout(peekTimer.current);
        setPeek(false);
        requestAnimationFrame(() => avatar.current?.focus()); // the avatar returns with the rail
        return;
      }
      setDrawer(false);
      openButton.current?.querySelector('button')?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, peek]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Wide screens: the spacer makes room for the sidebar, which sits above the page. A peek widens it without making room. */}
      <motion.div initial={false} animate={{ width: collapsed ? RAIL_WIDTH : SIDEBAR_WIDTH }} transition={ease} className="h-full shrink-0 max-md:hidden" />
      <motion.aside
        aria-label="Your tasks"
        initial={false}
        animate={{ width: collapsed && !peek ? RAIL_WIDTH : SIDEBAR_WIDTH }}
        transition={ease}
        onPointerEnter={(e) => { if (collapsed && e.pointerType === 'mouse') peekAfter(true, PEEK_OPEN_MS); }}
        onPointerLeave={(e) => { if (collapsed && e.pointerType === 'mouse') peekAfter(false, PEEK_CLOSE_MS); }}
        className={`fixed inset-y-0 left-0 z-20 overflow-hidden border-r border-ink/10 bg-panel transition-shadow duration-300 motion-reduce:transition-none max-md:hidden ${peek ? 'shadow-2xl shadow-ink/15' : ''}`}
      >
        <div style={{ width: SIDEBAR_WIDTH }} className="flex h-full flex-col">
          <SidebarContent
            tasks={tasks}
            rail={collapsed && !peek}
            toggleLabel={peek ? 'Keep sidebar open' : 'Close sidebar'}
            onToggle={() => setSidebar(collapsed ? false : true)}
            onNavigate={() => {}}
            onExpand={() => setSidebar(false)}
            avatarRef={avatar}
          />
        </div>
      </motion.aside>

      {/* Phones: a drawer over the page. */}
      <AnimatePresence>
        {drawer && (
          <motion.button
            key="backdrop"
            type="button"
            aria-label="Close your tasks"
            tabIndex={-1}
            onClick={() => setDrawer(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={ease}
            className="fixed inset-0 z-20 bg-ink/40 md:hidden"
          />
        )}
        {drawer && (
          <motion.aside
            key="drawer"
            aria-label="Your tasks"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={ease}
            className="fixed inset-y-0 left-0 z-30 flex w-72 max-w-[85vw] flex-col border-r border-ink/10 bg-panel md:hidden"
          >
            <SidebarContent tasks={tasks} onToggle={() => setDrawer(false)} onNavigate={() => setDrawer(false)} />
          </motion.aside>
        )}
      </AnimatePresence>

      <div className="rook-glow relative flex min-w-0 flex-1 flex-col">
        {wallet.account && <ThemeToggle className="absolute top-2.5 right-3 z-10 sm:top-3 md:right-5" />}
        <div className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${topBarHidden ? 'min-[80rem]:grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}>
          <header className={`flex min-h-0 items-start justify-between gap-3 pl-1.5 max-sm:min-h-14 sm:pl-3 sm:max-[79.99rem]:min-h-17 md:pl-5 ${wallet.account ? 'pr-14 sm:pr-17 md:pr-19' : 'pr-3 md:pr-5'} ${topBarHidden ? 'py-1.5 sm:py-3 min-[80rem]:overflow-hidden min-[80rem]:py-0' : 'py-1.5 sm:py-3'}`}>
            <div ref={openButton} className="md:hidden">
              <button
                type="button"
                aria-label="Open your tasks"
                onClick={() => setDrawer(true)}
                className="grid size-11 cursor-pointer place-items-center rounded-lg transition-colors hover:bg-ink/5 active:translate-y-px motion-reduce:transition-none"
              >
                <svg className="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 6.5h14M3 13.5h14" /></svg>
              </button>
            </div>
            <div className="ml-auto flex items-center gap-0.5">
              {pathname !== '/app' && (
                <a
                  href="/app"
                  aria-label="New task"
                  onClick={(e) => go('/app', e)}
                  className="grid size-11 place-items-center rounded-lg transition-colors hover:bg-ink/5 active:translate-y-px motion-reduce:transition-none md:hidden"
                >
                  <svg className="size-5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" /></svg>
                </a>
              )}
              {!wallet.account && !wallet.checking && <WalletButton />}
            </div>
          </header>
        </div>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
