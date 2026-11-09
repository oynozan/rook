'use client';

import { AnimatePresence, motion } from 'motion/react';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Mark } from '@/components/Navbar';
import { useSmoothScroll } from '@/components/SmoothScroll';
import { AiStatus } from '@/components/ui/ai-status';
import { WebSearch, type WebSource } from '@/components/ui/web-search';
import { approve, cancel, confirmFunding, draftTask, forgetContractTask, forgetTransfer, fundingInstructions, fundingRefunded, rememberTransfer, stop, type ActResult } from './actions';
import { go } from './AppShell';
import { Composer, type ComposerErrors } from './Composer';
import { alertLine, deliveredParts, problemLine, skipReason } from './feed';
import {
  balanceProblem, closeTaskTransaction, confirmFailure, contractHasTask, fetchTxOutcome, fundingFrom, fundingMismatch, fundingTerms, fundingTransaction, isWalletCancel,
  keptTransferKey, keptValue, moneyMoved, plainReason, planTerms, readCloseOutcome, readFundingOutcome, readUsdcBalance, restoreKept, termsOf, txHashOf, usdc,
  whoseTransfer,
  type CloseResult, type Funding, type FundingResult, type KeptTransfer, type Terms,
} from './funding';
import { explorerTx, NETWORK, rpcFor, type Network } from './network';
import type { Candidate, LedgerSub, PlanView, Receipt, RookEvent, TaskSnapshot, TaskSummary } from './orchestrator';
import { useMode } from './mode';
import { allSelfDoWhy, budgetToHire, plannerReason, selfDoWhy } from './planner';
import { FUNDING_NOT_READY } from './refusals';
import { useEase } from './useEase';
import { useWallet, WalletAccountMismatch } from './wallet';

const TERMINAL = new Set(['closed', 'cancelled', 'killed', 'failed']);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const LINE_MS = 420;
const CATCH_UP_MS = 70; // a refresh mid-run replays history quickly, then returns to the live pace
const AGENT_MS = 320; // agents land one at a time, then the plan they make up
const AGENTS_MAX_MS = 2400;
const CARDS_OPEN_MS = 550; // how long the agent cards take to open, so following waits for their full height
const FOLLOW_HOLD_MS = 150; // after the reader scrolls up, how long scroll events can't resume following

// ---- loading one task ----

type Loaded = { snap: TaskSnapshot | null; events: RookEvent[]; problem: 'missing' | 'signin' | 'down' | null; refetch: () => void };

/** `account`: the signed-in account. Another one (or none) loads the task afresh, as that account may see it. */
function useTask(id: string | null, account: string | null): Loaded {
  const [snap, setSnap] = useState<TaskSnapshot | null>(null);
  const [events, setEvents] = useState<RookEvent[]>([]);
  const [problem, setProblem] = useState<Loaded['problem']>(null);

  /** Loads the task; resolves with it, 'down' when Rook couldn't be reached, or null when it isn't this account's. */
  const load = useCallback(async (): Promise<TaskSnapshot | 'down' | null> => {
    if (!id) return null;
    try {
      const r = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (r.status === 404) { setProblem('missing'); return null; }
      if (r.status === 401) { setProblem('signin'); return null; }
      if (!r.ok) { setProblem('down'); return 'down'; }
      const s: TaskSnapshot = await r.json();
      setProblem(null);
      setSnap(s);
      return s;
    } catch {
      setProblem('down');
      return 'down';
    }
  }, [id]);
  const refetch = useCallback(() => { void load(); }, [load]);

  useEffect(() => {
    setSnap(null);
    setEvents([]);
    setProblem(null);
    if (!id) return;
    refetch();
    const seen = new Set<number>();
    let ended = false; // the task reached a terminal status
    let soon: ReturnType<typeof setTimeout> | undefined;
    const types = ['task_status', 'subtask_status', 'planning', 'plan', 'quote_rejected', 'hire_sent', 'a2a_state', 'evaluation', 'security_alert', 'ledger', 'receipt', 'final', 'error'];
    const onEvent = (m: MessageEvent) => {
      // The browser fires its own 'error' event, with no data, when the connection drops or is refused (signed out,
      // not your task, services restarting). That shares a name with Rook's 'error' events, so skip anything empty.
      if (typeof m.data !== 'string' || !m.data) return;
      let e: RookEvent;
      try { e = JSON.parse(m.data); } catch { return; }
      if (seen.has(e.seq)) return;
      seen.add(e.seq);
      fresh++;
      setEvents((all) => [...all, e]);
      if (e.type === 'task_status' && TERMINAL.has(e.data.to)) ended = true;
      if (e.type === 'task_status' || e.type === 'final' || (ended && e.type === 'ledger')) refetch();
      // During the run a payment, top-up or return changes what each subtask has spent: load the books again, at most
      // once a second, so the plan's rows keep up with the header.
      else if (e.type === 'receipt' || e.type === 'ledger') soon ??= setTimeout(() => { soon = undefined; refetch(); }, 1000);
    };
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let gone = false; // this page left the task
    let fresh = 0, openedAt = 0; // events new to this page, and when the current stream opened
    const again = () => {
      if (gone) return;
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15_000);
    };
    const open = () => {
      const es = new EventSource(`/api/tasks/${encodeURIComponent(id)}/events`);
      source = es;
      fresh = 0;
      types.forEach((t) => es.addEventListener(t, onEvent as EventListener));
      es.addEventListener('open', () => { delay = 1000; openedAt = Date.now(); });
      es.addEventListener('error', () => {
        // The stream ends after the terminal status, or once a killed or failed task's money is back. Stop there, or
        // EventSource reconnects forever. (Rook's own 'error' events arrive while the connection is OPEN.) A drop
        // before the money is back (a restart, the network) isn't that end: follow on while the books are open. A
        // stream that brought nothing new and ended at once was Rook saying nothing moves any more.
        if (ended && es.readyState !== EventSource.OPEN) {
          es.close();
          const held = fresh > 0 || Date.now() - openedAt > 2000;
          void load().then((s) => { if (s === 'down' || (held && s?.ledger?.closed === false)) again(); });
          return;
        }
        // Any reply but 200 (the services restarting answer 503) closes an EventSource for good: open a new one, with
        // backoff. It replays from the start, and `seen` drops what this page already has.
        if (es.readyState === EventSource.CLOSED && !gone) {
          refetch();
          again();
        }
      });
    };
    open();
    return () => { gone = true; clearTimeout(retry); clearTimeout(soon); source?.close(); };
  }, [id, account, refetch, load]);

  // Chain mode: the indexer shows a payment's transaction up to a minute after its receipt, often after the stream
  // ended, so a finished task with a paid receipt still missing payment_tx is looked at again a few times.
  const awaitingTx = !!snap && TERMINAL.has(snap.task.status) && !!snap.ledger?.contract_task_id
    && snap.receipts.some((r) => r.amount_atomic !== '0' && !r.payment_tx);
  useEffect(() => {
    if (!awaitingTx) return;
    let n = 0;
    const timer = setInterval(() => { if (++n >= 9) clearInterval(timer); refetch(); }, 10_000);
    return () => clearInterval(timer);
  }, [awaitingTx, refetch]);

  // Just after switching tasks or accounts the state still holds the old task for one render: never show it as the new one.
  return { snap: snap?.task.id === id && snap.task.owner === account ? snap : null, events, problem, refetch };
}

// ---- pieces of the thread ----

function UserMessage({ prompt, budget, animate }: { prompt: string; budget: string; animate?: boolean }) {
  return (
    <div className={`flex justify-end ${animate ? 'rook-in' : ''}`}>
      <div className="max-w-[85%] rounded-3xl rounded-br-md bg-ink/5 px-4 py-2.5 sm:px-5 sm:py-3">
        <p className="leading-snug whitespace-pre-wrap sm:text-lg">{prompt}</p>
        <p className="mt-1 text-right text-sm text-ink/65">Budget {budget} USDC</p>
      </div>
    </div>
  );
}

function RookMessage({ children, still }: { children: ReactNode; still?: boolean }) {
  return (
    <div className={`flex gap-3 ${still ? '' : 'rook-in'}`}>
      {/* On a phone the width matters more than the logo: Rook is already everything that isn't in a bubble. */}
      <span className="mt-0.5 flex h-7 shrink-0 items-center max-sm:hidden [&>svg]:size-5" aria-hidden="true"><Mark /></span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Rook is working: the logo's three blocks take turns. */
function Working({ label }: { label: string }) {
  return (
    <p role="status" className="flex h-7 items-center gap-2.5 text-ink/65">
      <span className="rook-blocks flex items-center gap-1" aria-hidden="true">
        <span className="size-2 bg-accent" /><span className="size-2 bg-accent" /><span className="size-2 bg-accent" />
      </span>
      {label}
    </p>
  );
}

function ActionButton({ onClick, busy, disabled, title, primary, children }: { onClick: () => void; busy?: boolean; disabled?: boolean; title?: string; primary?: boolean; children: ReactNode }) {
  const off = disabled || busy;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      title={title}
      className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 font-medium whitespace-nowrap transition-colors max-sm:grow sm:px-5 duration-200 motion-reduce:transition-none ${
        primary
          ? disabled ? 'cursor-not-allowed bg-ink/10 text-ink/55' : `bg-accent text-on-accent ${busy ? 'cursor-wait' : 'cursor-pointer hover:bg-accent-hover active:translate-y-px'}`
          : `border border-ink/25 ${off ? 'cursor-wait text-ink/55' : 'cursor-pointer hover:border-ink hover:bg-ink/5 active:translate-y-px'}`
      }`}
    >
      {children}
    </button>
  );
}

/** Opens and closes by height. */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const ease = useEase();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={ease}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * What a subtask can cost: Rook's own work, or a cap in USDC (the planner drops 0 USDC quotes, so a hired subtask's cap
 * is never 0). During a run, what it has spent of its cap.
 */
function CapLabel({ subtask: s, usage, why }: { subtask: PlanView['subtasks'][number]; usage?: LedgerSub; why: string }) {
  const topped = usage ? BigInt(usage.topped_up_atomic) : 0n;
  return (
    <span title={s.self_do ? why : usage ? 'Spent of this subtask\'s cap, plus any top-up from the reserve' : undefined}
      className={`shrink-0 pl-3 text-sm text-ink/65 sm:pl-0 ${s.self_do ? '' : 'font-mono tabular-nums'}`}>
      {s.self_do ? 'Rook does this' : usage ? `${usdc(usage.spent_atomic)} of ${usdc(usage.cap_atomic)}${topped > 0n ? ` +${usdc(topped)} reserve` : ''}` : `Cap ${usdc(s.cap_atomic)}`}
    </span>
  );
}

/** `why`: why Rook does a self_do part itself (selfDoWhy). */
function PlanRow({ subtask: s, usage, why }: { subtask: PlanView['subtasks'][number]; usage?: LedgerSub; why: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer flex-col justify-between gap-x-4 gap-y-0.5 rounded-2xl px-4 py-3 text-left hover:bg-ink/5 sm:flex-row sm:items-baseline"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`text-ink/55 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
          <span className="font-medium">{s.title}</span>
        </span>
        <CapLabel subtask={s} usage={usage} why={why} />
      </button>
      <Reveal open={open}>
        <div className="px-4 pt-1 pb-4 pl-8 text-ink/80">
          {/* The label's tooltip says the same, but a phone shows no tooltips. */}
          {s.self_do && <p className="mb-3 text-sm text-ink/65">{why}</p>}
          {s.brief && (
            // The planner's own words for the agent; plain text, never markup.
            <details className="mb-3">
              <summary className="cursor-pointer text-sm text-ink/65 hover:text-ink">{s.self_do ? 'Brief' : 'Brief sent to the agent'}</summary>
              <p className="mt-1 text-sm whitespace-pre-wrap">{s.brief}</p>
            </details>
          )}
          <p className="text-sm text-ink/65">Must pass</p>
          <ul className="mt-1 space-y-0.5">{s.criteria.map((c) => <li key={c.id}>{c.description}</li>)}</ul>
          {!!s.deadline_s && <p className="mt-3 text-sm text-ink/65">Deadline: delivered within {turnaround(s.deadline_s)}</p>}
          {s.candidates.length > 0 && (
            <>
              <p className="mt-3 text-sm text-ink/65">Candidates, in the order Rook hires them: lowest expected cost first</p>
              <ul className="mt-1.5 space-y-2">{s.candidates.map((c) => <CandidateLine key={c.handle} c={c} />)}</ul>
            </>
          )}
        </div>
      </Reveal>
    </>
  );
}

const turnaround = (s: number) =>
  s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;

/**
 * One candidate: its name, handle and price, what the market says about it, and why it sits where it does (expected
 * cost: price divided by its chance to pass). Agent text is shown as plain text.
 */
function CandidateLine({ c }: { c: Candidate }) {
  // success_rate is a percentage. A rate with no delivered jobs behind it says nothing, so it is left out, not shown as 0%.
  const rate = c.success_rate === null || c.delivered_jobs === 0 ? null : Math.round(c.success_rate);
  const facts = [
    rate !== null && `${rate}% success`,
    c.delivered_jobs > 0 && `${c.delivered_jobs} job${c.delivered_jobs === 1 ? '' : 's'} delivered`,
    c.sla_seconds > 0 && `within ${turnaround(c.sla_seconds)}`,
  ].filter(Boolean);
  return (
    <li>
      <p className="flex flex-wrap items-baseline gap-x-2">
        {c.name && c.name !== c.handle && <span className="font-medium">{c.name}</span>}
        <span className="font-mono text-sm text-ink/65">{c.handle}</span>
        <span className="ml-auto font-mono text-sm tabular-nums">{usdc(c.price_atomic)} USDC</span>
      </p>
      {facts.length > 0 && <p className="text-sm text-ink/60">{facts.join(' · ')}</p>}
      {c.rank_reason && <p className="text-xs text-ink/55">{c.rank_reason}</p>}
    </li>
  );
}

function PlanCard({ plan, usage }: { plan: PlanView; usage?: Map<string, LedgerSub> }) {
  return (
    <ol className="mt-3 rounded-2xl border border-ink/15">
      {plan.subtasks.map((s, i) => (
        <li key={s.id} className="rook-in border-b border-ink/10 last:border-b-0" style={{ animationDelay: `${150 + i * 90}ms` }}>
          <PlanRow subtask={s} usage={usage?.get(s.id)}
            why={s.self_do ? selfDoWhy(s, budgetToHire(plan, s.id), plan.subtasks.slice(0, i).some((x) => !x.self_do)) : ''} />
        </li>
      ))}
    </ol>
  );
}

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const LINK = 'underline decoration-ink/30 underline-offset-2 hover:decoration-ink';

/** What backs a receipt: the agent's A2A task, the evaluator's verdict hash, and the transactions on NEAR. */
/** What the run spent and refunded, and a receipt per paid hire. The refund shows once the contract closed the task. */
function MoneyCard({ ledger, receipts, network, simNote }: { ledger: TaskSnapshot['ledger']; receipts: Receipt[]; network: Network; simNote: string }) {
  // Not closed yet: a payment still in flight holds the refund back; otherwise Rook is still sending it (a close that failed).
  const inFlight = !!ledger?.subtasks?.some((s) => s.authorized_atomic != null);
  return (
    <div className="rook-in mt-6 rounded-2xl border border-ink/15 p-4" style={{ animationDelay: '500ms' }}>
      {ledger && (
        <p className="tabular-nums">
          Spent {usdc(ledger.spent_atomic)} USDC, {ledger.closed !== false ? `refunded ${usdc(ledger.refunded_atomic)} USDC`
            : inFlight ? 'and the rest is on its way back: the refund lands once every payment still in flight has settled or expired'
            : 'and Rook is still sending the rest back to your wallet'}{simNote}.
        </p>
      )}
      {receipts.length > 0 && (
        <ol className="mt-3 border-t border-ink/10">
          {receipts.map((r, n) => (
            <li key={r.id} className="border-b border-ink/10 py-1.5 text-sm last:border-b-0">
              <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto_2.5rem] items-baseline gap-2">
                <span className="font-mono text-ink/55">{n + 1}</span>
                <span className="truncate font-mono">{r.agent_handle}</span>
                <span className="font-mono tabular-nums">{usdc(r.amount_atomic)}</span>
                <span className={r.verdict === 'fail' ? 'text-alert' : r.verdict === 'pass' ? '' : 'text-ink/65'}>{r.verdict === 'fail' ? 'Fail' : r.verdict === 'pass' ? 'Pass' : 'N/A'}</span>
              </div>
              <ReceiptProof r={r} network={network} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ReceiptProof({ r, network }: { r: Receipt; network: Network }) {
  const items = [
    r.a2a_task_id && <span key="a2a" title={r.a2a_task_id}>A2A task <span className="font-mono">{short(r.a2a_task_id)}</span></span>,
    r.attestation_hash && <span key="eval" title={r.attestation_hash}>evaluation hash <span className="font-mono">{short(r.attestation_hash)}</span></span>,
    r.payment_tx && <a key="pay" href={explorerTx(network, r.payment_tx)} target="_blank" rel="noopener noreferrer" className={LINK}>payment transaction</a>,
    r.receipt_tx && <a key="rec" href={explorerTx(network, r.receipt_tx)} target="_blank" rel="noopener noreferrer" className={LINK}>receipt on chain</a>,
  ].filter(Boolean);
  return items.length ? <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-8 text-xs text-ink/60">{items}</p> : null;
}

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** This tab's sessionStorage. A private window or blocked site data may refuse it: then nothing is kept. */
const session = {
  get: (key: string) => { try { return window.sessionStorage.getItem(key); } catch { return null; } },
  set: (key: string, value: string | null) => {
    try {
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch { /* nothing kept */ }
  },
};

type Sent = NonNullable<TaskSnapshot['funding_sent']>;

/** What a funding transfer did, read from NEAR by its hash; unknown while NEAR can't find it. */
const lookUpFunding = (network: Network, tx: string, account: string, contractId: string) =>
  fetchTxOutcome(rpcFor(network), tx, account).then((o) => readFundingOutcome(o, contractId), (): FundingResult => ({ kind: 'unknown' }));

/**
 * Whether the signed-in wallet holds `amount` (atomic USDC; null: nothing to check), read from NEAR when it is set and
 * again on `check`. `short` is the sentence for a wallet that can't send it. A balance NEAR can't show right now holds
 * nothing back: the funding step checks again before the wallet opens, and the token refuses what it can't cover.
 */
function useUsdcShortfall(amount: string | null) {
  const wallet = useWallet();
  const { mode, network } = useMode();
  const account = wallet.account, token = mode?.usdc ?? null;
  const [short, setShort] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const asked = useRef(0); // only the latest read's answer counts
  const check = useCallback(async (): Promise<string | null> => {
    const n = ++asked.current;
    if (!amount || !account || !token) { setChecking(false); return null; }
    setChecking(true);
    const why = await readUsdcBalance(rpcFor(network), token, account).then((b) => balanceProblem(b, amount, account), () => null);
    if (n === asked.current) { setShort(why); setChecking(false); }
    return why;
  }, [amount, account, token, network]);
  useEffect(() => {
    setShort(null);
    void check();
  }, [check]);
  return { short, checking, check };
}

function TxLink({ network, tx }: { network: Network; tx: string | null }) {
  return tx ? <> (<a href={explorerTx(network, tx)} target="_blank" rel="noopener noreferrer" className={LINK}>transaction</a>)</> : null;
}

/**
 * Chain mode, after approval: the owner's wallet sends the budget to the Rook contract (SHARED API DECISION 4), the
 * contract's task_created event names the contract task, and Rook checks it against the plan before running. The
 * transfer's hash is remembered by this web server the moment the wallet returns it, so no reload offers a second one,
 * and by this tab too, for when the session ended and the server couldn't take it.
 */
function FundingStep({ id, plan, budget, funding, trouble, onRetry, sent, contractId, onConfirmed, onStop, stopping, autoStart, onBusy, onChanged }: {
  id: string; plan: PlanView; budget: string; funding: Funding | null;
  /** Why the funding instructions didn't load (a sentence), and how to ask for them again. */
  trouble: string | null; onRetry: () => void;
  sent: TaskSnapshot['funding_sent'];
  /** The contract to read and refund from when Rook couldn't repeat the funding instructions. */
  contractId: string | null;
  onConfirmed: () => void; onStop: () => void; stopping: boolean;
  /** One click: the approve button already asked for the transfer, so the wallet opens as soon as it is ready. */
  autoStart: boolean;
  /** The wallet is open, or a transfer is being read or confirmed: the task must not be stopped meanwhile. */
  onBusy: (busy: boolean) => void;
  /** The server's record changed, or the task may have moved on: load the task again. */
  onChanged: () => void;
}) {
  const wallet = useWallet();
  const { network: modeNetwork } = useMode();
  const [phase, setPhase] = useState<'idle' | 'checking' | 'wallet' | 'reading' | 'confirming'>('idle');
  const [error, setError] = useState<string | null>(null);
  // The error means Rook will never run this contract task for this task, so its USDC can only go back.
  const [refundable, setRefundable] = useState(false);
  // A transfer may have gone out but can't be read: ask for its hash, and offer no second transfer (or Cancel) meanwhile.
  const [pasted, setPasted] = useState<string | null>(null);
  const [mayBeUnsent, setMayBeUnsent] = useState(false); // the wallet errored, so the owner may know nothing went out
  // This tab's own transfer, kept in sessionStorage too: a session that ends mid-funding remounts this step after the
  // next sign-in, and the server may never have heard of the transfer (remembering it needs a session).
  const [kept] = useState(() => restoreKept(session.get(keptTransferKey(id)), wallet.account ?? '', sent ?? null));
  // The transfer created a contract task: from then on this step only confirms it, before the server remembers it too.
  const [made, setMade] = useState<{ contract_task_id: string; tx_hash: string | null } | null>(kept.made);
  // This page's own transfer, by hash, while what it did isn't settled: sent from here, or remembered by the server.
  const [ownTx, setOwnTx] = useState<string | null>(kept.ownTx);
  // This account's transfer created a contract task on other terms than the plan's: Rook never runs it, so the only way
  // for its USDC is back to the wallet (the funder's close_task). Then the plan can be funded again.
  const [stray, setStray] = useState<{ task_id: string; tx: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const held = sent && !sent.refunded && sent.contract_task_id ? { contract_task_id: sent.contract_task_id, tx_hash: sent.tx_hash } : null;
  const done = held ?? made;
  const unreadTx = !done && sent && !sent.refunded && !sent.contract_task_id ? sent.tx_hash : null;
  const pendingTx = done ? null : ownTx ?? unreadTx;
  const network = funding?.network ?? modeNetwork;
  const contract = funding?.contract_id ?? contractId;
  const want: Terms = (funding && termsOf(funding)) ?? planTerms(budget, plan);

  useEffect(() => { onBusy(phase !== 'idle'); }, [phase, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);

  const keep = (t: KeptTransfer | null) => { if (wallet.account) session.set(keptTransferKey(id), keptValue(wallet.account, t)); };
  // Kept while it is unsettled. The entry goes with it: it moved no USDC, funds another task, or left the contract.
  useEffect(() => keep(made ?? (ownTx ? { contract_task_id: null, tx_hash: ownTx } : null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keep only reads the account and id
    [id, wallet.account, made, ownTx]);
  // A restored transfer is one the server doesn't hold: it hears of it now, so a reload, a Stop (which then offers the
  // refund) or another tab knows it too.
  useEffect(() => {
    const tx = kept.made?.tx_hash ?? kept.ownTx;
    if (tx) void rememberTransfer(id, { tx_hash: tx, contract_task_id: kept.made?.contract_task_id ?? null }).then((r) => { if (r.ok) onChanged(); }, () => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for what this mount restored
  }, []);

  async function confirm(cid: string, tx: string | null) {
    setError(null);
    setRefundable(false);
    setPhase('confirming');
    const out: ActResult = await confirmFunding(id, { contract_task_id: cid, tx_hash: tx })
      .catch(() => ({ ok: false as const, message: UNREACHABLE }));
    setPhase('idle');
    if (out.ok) {
      session.set(keptTransferKey(id), null); // Rook runs it now: the server's books know the way back to it
      return onConfirmed();
    }
    // The orchestrator's own refusals are fragments, quoted after a lead; Rook's own sentences stand on their own.
    const why = out.message.replace(/\.?$/, '.');
    const next = confirmFailure(out.message);
    onChanged(); // the task may have moved on meanwhile: bound by another confirm, or stopped
    if (next === 'refund') {
      setRefundable(true);
      return setError(`Rook won't run this task from contract task ${cid}: ${why} Take the USDC back to your wallet.`);
    }
    if (next === 'refetch') {
      if (/already funds/.test(out.message)) setMade(null); // another task's contract task: this one can be funded again
      return setError(out.raw ? `Rook didn't start the run from here: ${why}` : why);
    }
    if (next === 'not_final') {
      // Rook still can't see the contract task after its tries. If the wallet's own view of NEAR, which is ahead of
      // Rook's, has no such task either, it is gone (refunded and deleted, or an old transfer's), not late: confirming
      // again would never work, so the plan can be funded again. A read that fails says nothing is gone.
      setPhase('confirming');
      const gone = !!contract && await contractHasTask(rpcFor(network), contract, cid).then((has) => !has, () => false);
      setPhase('idle');
      if (!gone) return setError("NEAR hasn't finished recording your transfer yet. Your USDC is safe in the Rook contract. Confirm again in a few seconds.");
      await forgetContractTask(id, cid).catch(() => null);
      setMade(null);
      onChanged();
      return setError(`Contract task ${cid} isn't on the Rook contract any more, so Rook can't start the run from it. Its USDC most likely went back to the wallet that funded it already. Fund the plan again to start the run.`);
    }
    setError(out.raw ? `Rook didn't start the run: ${why} Your USDC is safe in the Rook contract. Confirm again to start it.` : `${why} Your USDC is safe in the Rook contract.`);
  }

  const lookUp = (tx: string) => lookUpFunding(network, tx, wallet.account ?? '', contract ?? '');

  /**
   * What a transfer did, once read. `who` (whoseTransfer): only the transfer this page waits on, or a paste when it knows
   * none, ends the wait. `start`: confirm a match at once (the owner just acted).
   */
  async function settle(result: FundingResult, tx: string | null, who: 'own' | 'other' | 'unsure', start: boolean) {
    if (result.kind === 'created') {
      if (who === 'other') {
        setPhase('idle');
        return setError(`That transaction created contract task ${result.task_id}, but it isn't the transfer your wallet sent for this task (linked above), so Rook won't use it here. Look that one up instead.`);
      }
      const bad = fundingMismatch(result, want, wallet.account ?? '');
      if (bad) {
        setPhase('idle');
        const mine = !!wallet.account && result.funder === wallet.account; // 'other' hashes never get here
        if (mine) setStray({ task_id: result.task_id, tx });
        return setError(`That transaction created contract task ${result.task_id}, but not for this plan: ${bad}. Rook won't use it for this task.${mine ? ' Take its USDC back to your wallet, then fund the plan again.' : ''}`);
      }
      // A paste while this page knows no transfer of its own keeps the paste form behind the confirm: if Rook turns the
      // contract task down as another task's, the form comes back, not a second transfer.
      if (who === 'own') { setPasted(null); setMayBeUnsent(false); }
      keep({ contract_task_id: result.task_id, tx_hash: tx }); // at once: this step may be gone before it renders again
      setOwnTx(null);
      setMade({ contract_task_id: result.task_id, tx_hash: tx });
      if (start) return confirm(result.task_id, tx);
      setPhase('idle');
      if (tx) await rememberTransfer(id, { tx_hash: tx, contract_task_id: result.task_id }).catch(() => null);
      return;
    }
    setPhase('idle');
    if (result.kind === 'unknown') {
      setPasted((p) => tx ?? p ?? '');
      return setError("Rook can't tell what the transfer did. Paste its transaction hash from your wallet's history so Rook can read it. Until then Rook won't offer the transfer again, so nothing is sent twice.");
    }
    const why = result.kind === 'refunded'
      ? `The Rook contract refused the transfer, so the USDC went back to your wallet: ${plainReason(result.reason).replace(/\.?$/, '.')}`
      : `The transfer failed on NEAR, so no USDC left your wallet: ${plainReason(result.reason).replace(/\.?$/, '.')}`;
    if (who === 'other') return setError(`${why} That was a different transaction, so Rook still can't tell what your transfer did.`);
    setPasted(null); setMayBeUnsent(false); setOwnTx(null);
    setError(why);
    if (tx) { await forgetTransfer(id, tx).catch(() => null); onChanged(); }
  }

  async function fund() {
    if (!funding) return;
    setError(null);
    setNotice(null);
    setRefundable(false);
    // A wallet short of USDC is told so before the wallet opens: the transfer would only fail in the USDC contract. A
    // balance NEAR can't show right now doesn't hold the transfer back; the token still refuses one it can't cover.
    const account = wallet.account;
    if (account) {
      setPhase('checking');
      const short = await readUsdcBalance(rpcFor(funding.network), funding.usdc, account)
        .then((b) => balanceProblem(b, funding.amount_atomic, account), () => null);
      if (short) { setPhase('idle'); return setError(short); }
    }
    setPhase('wallet');
    let outcome: unknown;
    try {
      outcome = await wallet.sendTransaction(fundingTransaction(funding));
    } catch (e) {
      setPhase('idle');
      const m = e instanceof Error ? e.message : String(e);
      if (e instanceof WalletAccountMismatch) return setError(m); // checked before anything is signed
      // A wallet can fail, or close, after it broadcast the transfer: an error doesn't show that nothing went out.
      setPasted('');
      setMayBeUnsent(true);
      setError(`${isWalletCancel(m) ? 'Your wallet reports the transfer was stopped' : "Your wallet reported an error, so Rook can't tell whether the transfer went out"}: ${plainReason(m).replace(/\.?$/, '.')} If you approved it there, paste its transaction hash from your wallet's history so Rook can read it. If nothing was sent, choose “Nothing was sent” to try again.`);
      return;
    }
    setPhase('reading');
    const tx = txHashOf(outcome);
    if (tx) {
      // Remembered before anything reads the outcome or calls Rook, so a reload or a closed tab never offers a second
      // transfer. This page reads it itself. This tab keeps it at once, too: if the session ended while the wallet was
      // open, the server can't take it, and this step is mounted afresh after the next sign-in.
      keep({ contract_task_id: null, tx_hash: tx });
      autoRead.current = tx;
      setOwnTx(tx);
      await rememberTransfer(id, { tx_hash: tx }).catch(() => null);
    }
    const first = readFundingOutcome(outcome, funding.contract_id);
    await settle(first.kind === 'unknown' && tx ? await lookUp(tx) : first, tx, 'own', true);
  }

  async function lookUpPasted() {
    const tx = (pasted ?? '').trim();
    if (!TX_HASH.test(tx)) return setError("That isn't a NEAR transaction hash.");
    setError(null);
    setPhase('reading');
    await settle(await lookUp(tx), tx, whoseTransfer(tx, pendingTx), true);
  }

  // A transfer remembered only by its hash (the page closed or reloaded while reading it, by the server or this tab): read
  // it once, so the page can confirm or refund the contract task it created. One this page is reading already is skipped.
  const autoRead = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingTx || !contract || !wallet.account || phase !== 'idle' || autoRead.current === pendingTx) return;
    autoRead.current = pendingTx;
    setOwnTx(pendingTx);
    setPhase('reading');
    void lookUp(pendingTx).then((r) => settle(r, pendingTx, 'own', false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per remembered hash; settle reads the current state
  }, [pendingTx, contract, wallet.account, phase]);

  // One click: the approve button asked for the transfer, so the wallet opens once, as soon as the instructions are in.
  const autoFired = useRef(false);
  useEffect(() => {
    if (!autoStart || autoFired.current || !funding || done || pendingTx || phase !== 'idle') return;
    const from = fundingFrom(funding);
    if (!fundingTerms(funding) || funding.network !== NETWORK || !wallet.account || (from && wallet.account !== from)) return;
    autoFired.current = true;
    void fund();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per approval; fund reads the current state
  }, [autoStart, funding, done, pendingTx, phase, wallet.account]);

  const busyLabel = { checking: 'Checking your USDC balance…', wallet: 'Confirm in your wallet…', reading: 'Reading the transaction…', confirming: 'Checking with Rook…' } as const;
  const pasteForm = () => (
    <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void lookUpPasted(); }}>
      <label className="sr-only" htmlFor={`tx-${id}`}>Transaction hash</label>
      <input id={`tx-${id}`} value={pasted ?? ''} onChange={(e) => setPasted(e.target.value)} placeholder="Transaction hash"
        className="min-h-11 min-w-0 flex-1 rounded-full bg-ink/5 px-4 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/50" />
      <ActionButton onClick={() => void lookUpPasted()} busy={phase !== 'idle'}>Look it up</ActionButton>
      {mayBeUnsent && <ActionButton onClick={() => { setPasted(null); setMayBeUnsent(false); setError(null); }}>Nothing was sent</ActionButton>}
    </form>
  );
  const stopButton = (label: string) => (
    <ActionButton onClick={onStop} busy={stopping} disabled={phase !== 'idle'} title={phase !== 'idle' ? 'Wait until the transfer is settled' : undefined}>
      {stopping ? 'Stopping…' : label}
    </ActionButton>
  );

  // Already sent from this account's wallet (remembered by this web server, or just read here): confirm it, never offer
  // a second transfer. The refund appears only when Rook will never run this contract task, and not while confirming.
  if (done) {
    const refund = refundable && phase === 'idle' && contract;
    return (
      <div className="rounded-2xl border border-ink/15 p-4">
        <p>
          Your wallet already sent the funding. It created contract task <span className="font-mono">{done.contract_task_id}</span>
          <TxLink network={network} tx={done.tx_hash} />, and Rook hasn&apos;t started the run yet.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {refund
            ? <RefundButton id={id} contractId={refund} taskId={done.contract_task_id} network={network} onRefunded={() => { session.set(keptTransferKey(id), null); onChanged(); }} />
            : <ActionButton primary onClick={() => confirm(done.contract_task_id, done.tx_hash)} busy={phase !== 'idle'}>{phase === 'idle' ? 'Confirm funding and start' : busyLabel[phase]}</ActionButton>}
          {stopButton('Stop')}
        </div>
        {error && <p role="alert" className="mt-3 text-alert">{error}</p>}
      </div>
    );
  }

  // This page's transfer went out, and what it did isn't settled: read it, or ask for its hash. Never a second transfer.
  if (pendingTx) {
    return (
      <div className="rounded-2xl border border-ink/15 p-4">
        <p>Your wallet sent the funding transfer<TxLink network={network} tx={pendingTx} />.</p>
        {phase === 'reading' && <div className="mt-3"><Working label="Reading what it did" /></div>}
        <div className="mt-4 flex flex-wrap gap-3">
          {stray && phase === 'idle' && contract && (
            <RefundButton id={id} contractId={contract} taskId={stray.task_id} network={network} stray onRefunded={async (r) => {
              // Nothing of this task's funding is left: forget the transfer, so the plan can be funded again.
              if (stray.tx) await forgetTransfer(id, stray.tx).catch(() => null);
              setStray(null); setOwnTx(null); setPasted(null); setError(null);
              setNotice(`Contract task ${stray.task_id} refunded ${usdc(r.amount)} USDC to your wallet.`);
              onChanged();
            }} />
          )}
          {stopButton('Stop')}
        </div>
        {pasted !== null && pasteForm()}
        {error && <p role="alert" className="mt-3 text-alert">{error}</p>}
      </div>
    );
  }
  // The instructions are loading, or didn't come: either way the plan can still be cancelled.
  if (!funding) {
    return (
      <div className="rounded-2xl border border-ink/15 p-4">
        {trouble ? <p role="alert">{trouble}</p> : <Working label="Getting the funding transfer ready" />}
        <div className="mt-4 flex flex-wrap gap-3">
          {trouble && <ActionButton primary onClick={onRetry} disabled={stopping}>Try again</ActionButton>}
          <ActionButton onClick={onStop} busy={stopping}>{stopping ? 'Cancelling…' : 'Cancel'}</ActionButton>
        </div>
        {error && <p role="alert" className="mt-3 text-alert">{error}</p>}
      </div>
    );
  }

  const from = fundingFrom(funding);
  const terms = fundingTerms(funding);
  const hired = plan.subtasks.filter((s) => !s.self_do);
  const wrongNetwork = funding.network !== NETWORK;
  const otherAccount = !!from && !!wallet.account && wallet.account !== from;
  const capsTotal = terms?.caps.reduce((sum, c) => sum + BigInt(c), 0n) ?? 0n;
  const ready = !!terms && !wrongNetwork && !!wallet.account && !otherAccount;
  const unallocated = terms ? BigInt(funding.amount_atomic) - BigInt(terms.reserve_atomic) - capsTotal : 0n;
  const row = 'flex items-baseline justify-between gap-4 py-1';

  return (
    <div className="rounded-2xl border border-ink/15 p-4">
      {notice && <p className="mb-3 text-sm">{notice}</p>}
      <p className="font-medium">Fund this plan</p>
      <p className="mt-1">
        This moves {funding.network === 'mainnet' ? 'real USDC' : 'USDC test tokens'} on NEAR {funding.network}: {usdc(funding.amount_atomic)} USDC from your wallet to the Rook contract.
        Each subtask spends at most its cap plus what Rook tops up from the reserve, and the contract refunds what isn&apos;t spent when the task closes.
      </p>
      <dl className="mt-3 border-t border-ink/10 text-sm">
        <div className={row}><dt className="text-ink/65">Network</dt><dd>NEAR {funding.network}</dd></div>
        <div className={row}><dt className="shrink-0 text-ink/65">Contract</dt><dd className="min-w-0 font-mono break-all">{funding.contract_id}</dd></div>
        <div className={row}><dt className="shrink-0 text-ink/65">Token</dt><dd className="min-w-0 font-mono break-all">{funding.usdc}</dd></div>
        {terms?.caps.map((c, i) => (
          <div key={i} className={row}><dt className="min-w-0 truncate">Cap: {hired[i]?.title ?? `subtask ${i + 1}`}</dt><dd className="font-mono tabular-nums">{usdc(c)}</dd></div>
        ))}
        {terms && <div className={row}><dt>Reserve for re-hires</dt><dd className="font-mono tabular-nums">{usdc(terms.reserve_atomic)}</dd></div>}
        {unallocated > 0n && <div className={row}><dt>Not allocated, refunded at close</dt><dd className="font-mono tabular-nums">{usdc(unallocated)}</dd></div>}
        <div className={`${row} border-t border-ink/10 font-medium`}><dt>Total</dt><dd className="font-mono tabular-nums">{usdc(funding.amount_atomic)} USDC</dd></div>
      </dl>
      {!terms && <p className="mt-3 text-alert">Rook sent funding instructions this page can&apos;t read, so it won&apos;t offer the transfer.</p>}
      {wrongNetwork && <p className="mt-3 text-alert">Rook&apos;s contract is on NEAR {funding.network}, but this app connects wallets on NEAR {NETWORK}. Run the web app with NEXT_PUBLIC_NEAR_NETWORK={funding.network}.</p>}
      {otherAccount && (
        <p className="mt-3 text-ink/80">
          This task belongs to <span className="font-mono">{from}</span>, so that account&apos;s wallet funds it. You&apos;re signed in as <span className="font-mono">{wallet.account}</span>.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <ActionButton primary onClick={fund} busy={phase !== 'idle'} disabled={!ready || pasted !== null}
          title={pasted !== null ? 'Rook can’t tell yet whether your first transfer went out' : undefined}>
          {phase === 'idle' ? `Fund ${usdc(funding.amount_atomic)} USDC with wallet` : busyLabel[phase]}
        </ActionButton>
        <ActionButton onClick={onStop} busy={stopping} disabled={phase !== 'idle' || pasted !== null}
          title={phase !== 'idle' ? 'Wait until the transfer is settled' : pasted !== null ? 'Your wallet may have sent the funding: look the transaction up first' : undefined}>
          {stopping ? 'Cancelling…' : 'Cancel'}
        </ActionButton>
      </div>
      {pasted !== null && pasteForm()}
      {error && <p role="alert" className="mt-3 text-alert">{error}</p>}
    </div>
  );
}

/**
 * The funder takes the budget back: its own wallet calls close_task on the contract, which refunds what it holds for
 * that contract task. Works for a task Rook never ran (no subtask holds money); the contract refuses anything else.
 * It says the refund went through only on the contract's word (readCloseOutcome); then this web server remembers it
 * and stops the task, which can't run without that funding.
 */
function RefundButton({ id, contractId, taskId, network, onRefunded, stray = false }: {
  id: string; contractId: string; taskId: string; network: Network; onRefunded: (r: { amount: string; tx: string | null }) => void;
  /** A contract task that was never this task's funding (other terms): its refund doesn't touch this task's record or status. */
  stray?: boolean;
}) {
  const wallet = useWallet();
  const [state, setState] = useState<'idle' | 'wallet' | 'reading' | 'done'>('idle');
  const [amount, setAmount] = useState('0');
  const [tx, setTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function refund() {
    setState('wallet');
    setError(null);
    setTx(null);
    let out: unknown;
    try {
      out = await wallet.sendTransaction(closeTaskTransaction(contractId, taskId));
    } catch (e) {
      setState('idle');
      return setError(`The refund didn't go through: ${plainReason(e instanceof Error ? e.message : String(e)).replace(/\.?$/, '.')}`);
    }
    const hash = txHashOf(out);
    setTx(hash);
    let result = readCloseOutcome(out, contractId, taskId);
    if (result.kind === 'unknown' && hash) {
      // Some wallets return no outcome: read the transaction from NEAR before saying anything.
      setState('reading');
      result = await fetchTxOutcome(rpcFor(network), hash, wallet.account ?? '')
        .then((o) => readCloseOutcome(o, contractId, taskId), (): CloseResult => ({ kind: 'unknown' }));
    }
    if (result.kind === 'refunded') {
      setAmount(result.amount);
      setState('done');
      if (!stray) await fundingRefunded(id, { contract_task_id: taskId, refund_tx: hash }).catch(() => null);
      return onRefunded({ amount: result.amount, tx: hash });
    }
    setState('idle');
    setError(result.kind === 'refused' ? `The refund didn't go through: ${plainReason(result.reason).replace(/\.?$/, '.')}`
      : hash ? "Rook can't tell yet whether the refund went through. Check the transaction before you try again."
      : "Your wallet didn't say what happened, so Rook can't tell whether the refund went through. Check your wallet's history before you try again.");
  }
  if (state === 'done') return <p className="text-sm">Refund sent to your wallet: {usdc(amount)} USDC<TxLink network={network} tx={tx} />.</p>;
  return (
    <span className="flex flex-col gap-1">
      <ActionButton onClick={refund} busy={state !== 'idle'} disabled={!wallet.account}>
        {state === 'wallet' ? 'Confirm in your wallet…' : state === 'reading' ? 'Reading the transaction…' : 'Refund to my wallet'}
      </ActionButton>
      {error && <span role="alert" className="text-sm text-alert">{error}<TxLink network={network} tx={tx} /></span>}
    </span>
  );
}

/**
 * A task stopped before Rook bound its funding: where the wallet's transfer is, and the way back. A transfer remembered
 * only by its hash (the page closed while reading it) is read first, so the refund names the contract task it created.
 */
function HeldFunding({ id, sent, want, contractId, network, onChanged }: {
  id: string; sent: Sent; want: Terms; contractId: string | null; network: Network; onChanged: () => void;
}) {
  const wallet = useWallet();
  const unread = !sent.refunded && !sent.contract_task_id ? sent.tx_hash : null;
  const [note, setNote] = useState<string | null>(null);
  const [strayTask, setStrayTask] = useState<string | null>(null); // this account's transfer, on other terms than the plan's
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!unread || !contractId || !wallet.account) return;
    const account = wallet.account;
    let live = true;
    setNote(null);
    void lookUpFunding(network, unread, account, contractId).then(async (r) => {
      if (!live) return;
      if (r.kind === 'unknown') return setNote("Rook can't read it from NEAR yet.");
      if (r.kind === 'created') {
        const bad = fundingMismatch(r, want, account);
        if (bad) {
          if (r.funder === account) setStrayTask(r.task_id);
          return setNote(`It created contract task ${r.task_id}, which isn't this plan's funding: ${bad}.`);
        }
        await rememberTransfer(id, { tx_hash: unread, contract_task_id: r.task_id }).catch(() => null);
      } else await forgetTransfer(id, unread).catch(() => null); // it moved no USDC
      onChanged();
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per hash; `want` and `onChanged` don't change which transfer it is
  }, [unread, contractId, wallet.account, network, id, tries]);

  if (sent.refunded) return <p className="mt-3">Your funding went back to your wallet<TxLink network={network} tx={sent.refund_tx} />.</p>;
  if (sent.contract_task_id) {
    return (
      <div className="mt-3">
        <p>Your wallet&apos;s funding transfer is still in contract task <span className="font-mono">{sent.contract_task_id}</span><TxLink network={network} tx={sent.tx_hash} />. Take it back to your wallet:</p>
        {contractId && <div className="mt-3"><RefundButton id={id} contractId={contractId} taskId={sent.contract_task_id} network={network} onRefunded={onChanged} /></div>}
      </div>
    );
  }
  return (
    <div className="mt-3">
      <p>Your wallet sent a funding transfer<TxLink network={network} tx={sent.tx_hash} />. {note ?? (contractId ? 'Reading what it did…' : '')}</p>
      {note && (
        <div className="mt-3 flex flex-wrap gap-3">
          {strayTask && contractId
            ? <RefundButton id={id} contractId={contractId} taskId={strayTask} network={network} stray onRefunded={async () => { await forgetTransfer(id, unread!).catch(() => null); onChanged(); }} />
            : <ActionButton onClick={() => setTries((n) => n + 1)}>Read it again</ActionButton>}
        </div>
      )}
    </div>
  );
}

/** What the planner has reported so far: its stage, and the agents its searches turned up, one card each. */
type Planning = { stage: string | null; quoting: number; found: { handle: string; name: string; title: string }[] };

function planningFrom(events: RookEvent[]): Planning {
  const out: Planning = { stage: null, quoting: 0, found: [] };
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== 'planning') continue;
    out.stage = e.data.stage;
    if (e.data.stage === 'quoting') out.quoting = e.data.agents;
    if (e.data.stage === 'found') for (const a of e.data.agents ?? []) {
      if (seen.has(a.handle)) continue;
      seen.add(a.handle);
      out.found.push({ handle: a.handle, name: a.name, title: e.data.title });
    }
  }
  return out;
}

/**
 * Rook choosing agents. While planning, cards land as the planner's market searches return; once the plan is in, they
 * narrow to the candidates it picked. Names and handles are plain text, with no links or images.
 */
function AgentSearch({ plan, planning, animate, onGrow, onDone }: { plan: PlanView | null; planning?: Planning; animate: boolean; onGrow?: () => void; onDone?: () => void }) {
  const { live } = useMode();
  // Live agents have real names; the simulator's names are just their handles, so the subtask reads better there.
  const name = (n: string, handle: string, fallback: string) => (n && n !== handle ? n : fallback);
  // One card per agent, as the search counts them: an agent picked for several subtasks shows once, for its first.
  const picked = new Map<string, WebSource>();
  for (const s of plan?.subtasks ?? []) {
    for (const c of s.candidates) if (!picked.has(c.handle)) picked.set(c.handle, { id: c.handle, title: name(c.name, c.handle, s.title), url: c.handle });
  }
  const sources: WebSource[] = plan
    ? [...picked.values()]
    : (planning?.found ?? []).map((a) => ({ id: a.handle, title: name(a.name, a.handle, a.title), url: a.handle }));
  const foundCount = planning?.found.length ?? 0;
  const total = sources.length;
  const [landed, setLanded] = useState(0);
  const count = animate && plan ? landed : total;
  const searching = !plan || count < total;
  const market = live ? 'the NEAR AI market' : 'the simulated market';
  const working =
    planning?.stage === 'quoting' ? `Getting prices from ${planning.quoting} agent${planning.quoting === 1 ? '' : 's'}`
    : planning?.stage === 'searching' || planning?.stage === 'found' ? `Searching ${market}`
    : plan ? `Searching ${market}`
    : 'Planning the subtasks';
  const done = foundCount > total
    ? `Picked ${total} of ${foundCount} agents found`
    : `Found ${total} agent${total === 1 ? '' : 's'}`;

  useEffect(() => {
    if (!plan || !animate || landed >= total) return;
    if (reducedMotion()) { setLanded(total); return; }
    const t = setTimeout(() => setLanded((n) => n + 1), Math.min(AGENT_MS, AGENTS_MAX_MS / total));
    return () => clearTimeout(t);
  }, [plan, animate, landed, total]);

  useEffect(() => {
    onGrow?.();
    const t = setTimeout(() => onGrow?.(), CARDS_OPEN_MS);
    return () => clearTimeout(t);
  }, [count, onGrow]);

  const finished = !!plan && count >= total;
  useEffect(() => { if (finished) onDone?.(); }, [finished, onDone]);

  // On a phone the cards fold away once they've landed, so the plan they led to starts at the top of the screen.
  const [open, setOpen] = useState(animate || !plan);
  useEffect(() => { if (finished && window.matchMedia('(max-width: 639px)').matches) setOpen(false); }, [finished]);

  return (
    <WebSearch
      status={searching ? 'searching' : 'done'}
      label={searching ? working : done}
      sources={sources.slice(0, count)}
      linked={false}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

type Now = { state: string; label: string; detail?: string };
/**
 * started/ended: an agent hired and done; writing/written: a part Rook does itself (its title). detail: the raw text
 * behind a reworded line, as a tooltip. flag: an agent's delivery or quote was flagged (what "flagged" counts).
 */
type FeedLine = {
  key: number; text: string; tone: 'normal' | 'muted' | 'alert'; now: Now; paid?: number; fromReserve?: number;
  started?: string; ended?: string; writing?: string; written?: string; detail?: string; flag?: true;
};
/** What the feed needs from the plan: titles by subtask, the self_do ones, and whether no agent is hired at all. */
type FeedContext = { titles: Map<string, string>; selfDo: Set<string>; free: boolean; simNote: string };

/** Turns the run's events into plain lines. Agent text is never shown as instructions: only handles and Rook's verdicts. */
function feedFrom(events: RookEvent[], ctx: FeedContext): FeedLine[] {
  const lines: FeedLine[] = [];
  let receipt = 0;
  const hired = new Map<string | undefined, string>(); // subtask -> the agent its payment authorization is for
  const tries = new Map<string, number>(); // self_do subtask -> times Rook started on it
  const part = (id?: string) => (id && ctx.titles.get(id)) || 'this part';
  for (const { seq: key, type, data, subtask_id } of events) {
    const agent = data?.agent_handle;
    const self = !!subtask_id && ctx.selfDo.has(subtask_id);
    if (agent && (type === 'hire_sent' || (type === 'ledger' && data.op === 'clearing'))) hired.set(subtask_id, agent);
    if (type === 'hire_sent') lines.push({ key, text: `Hired ${agent}, quoted ${usdc(data.amount_atomic)} USDC.`, tone: 'normal', started: agent, now: { state: 'researching', label: 'Hired', detail: agent } });
    // Rook does a self_do part with its own model: no hire, so never "rook:self-do" or a hire's wording.
    else if (type === 'subtask_status' && self && data.to === 'working') {
      const n = (tries.get(subtask_id!) ?? 0) + 1;
      tries.set(subtask_id!, n);
      const title = part(subtask_id);
      lines.push({ key, text: n === 1 ? `Rook is doing ${title} itself.` : `Rook is trying ${title} again.`, tone: 'normal', writing: title, now: { state: 'writing', label: 'Rook is working on', detail: title } });
    }
    else if (type === 'evaluation' && (self || agent === 'rook:self-do')) {
      const title = part(subtask_id), pass = data.verdict === 'pass';
      lines.push({ key, text: `Rook's own work on ${title} ${pass ? 'passed every check' : 'failed a check'}.`, tone: 'normal', written: title, now: { state: 'analyzing', label: pass ? 'Passed' : 'Failed a check', detail: title } });
    }
    // Whether an unpaid hire cost anything is known only once its authorization is released (it can still land).
    else if (type === 'a2a_state' && ['FAILED', 'REJECTED', 'CANCELED'].includes(data.state)) lines.push({ key, text: `${agent} didn't deliver.`, tone: 'normal', ended: agent, now: { state: 'analyzing', label: 'No delivery', detail: agent } });
    else if (type === 'a2a_state' && data.state === 'TIMEOUT') lines.push({ key, text: `${agent} timed out.`, tone: 'normal', ended: agent, now: { state: 'analyzing', label: 'Timed out', detail: agent } });
    else if (type === 'ledger' && data.op === 'release' && data.settled === false) {
      const who = agent ?? hired.get(subtask_id);
      lines.push({ key, text: `No charge${who ? ` for ${who}` : ''}: its payment authorization was released unpaid.`, tone: 'muted', now: { state: 'analyzing', label: 'No charge', detail: who } });
    }
    else if (type === 'evaluation') {
      if (data.verdict === 'pass') lines.push({ key, text: `${agent} passed every check.`, tone: 'normal', ended: agent, now: { state: 'analyzing', label: 'Passed', detail: agent } });
      else if (data.failed_criteria?.includes('injection')) lines.push({ key, text: `${agent}'s delivery tried to give Rook instructions. Flagged and rejected.`, tone: 'alert', flag: true, ended: agent, now: { state: 'analyzing', label: 'Flagged', detail: agent } });
      else lines.push({ key, text: `${agent} failed a check.`, tone: 'alert', flag: true, ended: agent, now: { state: 'analyzing', label: 'Failed a check', detail: agent } });
    } else if (type === 'security_alert' && data.source === 'quote') lines.push({ key, text: alertLine(data.flag, agent), detail: data.flag, tone: 'alert', flag: true, now: { state: 'analyzing', label: 'Security alert' } });
    else if (type === 'quote_rejected') lines.push({ key, text: `Skipped ${agent}: ${skipReason(data.reason)}.`, detail: data.reason, tone: 'muted', now: { state: 'researching', label: 'Skipped', detail: agent } });
    else if (type === 'ledger' && data.op === 'topUp') lines.push({ key, text: `Topped up ${usdc(data.amount_atomic)} USDC from the reserve.`, tone: 'muted', fromReserve: Number(data.amount_atomic), now: { state: 'analyzing', label: 'Topped up', detail: `${usdc(data.amount_atomic)} USDC` } });
    else if (type === 'receipt' && data.amount_atomic === '0') lines.push({ key, text: `Receipt ${++receipt}: ${agent} delivered, but no payment showed on chain, so nothing was paid.`, tone: 'muted', now: { state: 'analyzing', label: 'Unpaid', detail: agent } });
    else if (type === 'receipt') lines.push({ key, text: `Receipt ${++receipt}: paid ${usdc(data.amount_atomic)} USDC to ${agent}.`, tone: 'muted', paid: Number(data.amount_atomic), now: { state: 'analyzing', label: 'Paid', detail: agent } });
    // What happens to the money after a kill, a failure or a restart (runner.ts unwind and restoreTask). Older kill
    // events carried a near-cli command (human_action) for the funder: never shown, the unwind refunds on its own.
    else if (type === 'ledger' && data.op === 'kill') {
      const text = ctx.free ? 'Stopped.' : data.returning || data.human_action
        ? "Stopped. Rook pays no more agents and is sending what's left back to your wallet."
        : 'Stopped. Rook pays no more agents.';
      lines.push({ key, text, tone: 'muted', now: { state: 'analyzing', label: 'Stopped' } });
    }
    else if (type === 'ledger' && data.op === 'clearing') lines.push({ key, text: data.how === 'void' ? `Cancelling the unused payment to ${data.agent_handle ?? 'an agent'} on NEAR before returning its funds.` : `Waiting for ${data.agent_handle ?? 'an agent'}'s payment authorization to ${data.how === 'terminal' ? 'clear' : 'settle or expire'} before returning its funds.`, tone: 'muted', now: { state: 'analyzing', label: 'Clearing', detail: data.agent_handle ?? undefined } });
    else if (type === 'ledger' && data.op === 'restored') lines.push({ key, text: `Rook restarted and picked this task up again from contract task ${data.contract_task_id}.`, tone: 'muted', now: { state: 'analyzing', label: 'Restored' } });
    // A plan that hires no agent held no money: no budget to close, nothing refunded.
    else if (type === 'ledger' && data.op === 'closeTask' && data.amount_atomic != null && !ctx.free) lines.push({ key, text: `Closed the budget: ${usdc(data.amount_atomic)} USDC went back to your wallet${ctx.simNote}.`, tone: 'muted', now: { state: 'analyzing', label: 'Closed' } });
    // Rook's own errors: plain words, the raw text as a tooltip, never counted as an agent's flag.
    else if (type === 'error') {
      // A part given up on (abandoned, or its work unchecked) ends its agent's wait too, not only Rook's own work.
      const p = problemLine(data ?? {}, subtask_id && ctx.titles.get(subtask_id), self || !subtask_id ? undefined : hired.get(subtask_id));
      if (p) {
        lines.push({
          key, text: p.text, tone: p.tone, detail: data?.message, ...(p.ended ? { ended: p.ended } : {}),
          ...(self && p.tone === 'alert' ? { written: part(subtask_id) } : {}), now: { state: 'analyzing', label: p.label },
        });
      }
    }
  }
  return lines;
}

const TONE = { normal: '', muted: 'text-ink/65 text-sm', alert: 'text-alert' };

const STOPPED = (
  <svg viewBox="0 0 24 24" width={18} height={18} className="text-ink/65" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
);
const RUN_STATES = { stopped: { label: 'Stopped', active: false, icon: STOPPED } };

/** Collapsed to one line that says what is happening now; the full list is one click away. */
function Activity({ lines, live, caughtUp, closing, outcome, timed, free }: { lines: FeedLine[]; live: boolean; caughtUp: boolean; closing: boolean; outcome: string; timed: boolean; free: boolean }) {
  const [open, setOpen] = useState(false);
  const latest = lines[lines.length - 1];
  const working = new Set<string>(), writing = new Set<string>();
  for (const l of lines) {
    if (l.started) working.add(l.started);
    if (l.ended) working.delete(l.ended);
    if (l.writing) writing.add(l.writing);
    if (l.written) writing.delete(l.written);
  }
  const rejected = lines.filter((l) => l.flag).length;

  let now: Now;
  if (!live) now = { state: outcome === 'killed' ? 'stopped' : outcome === 'failed' ? 'error' : 'done', label: '', detail: `${lines.length} step${lines.length === 1 ? '' : 's'}${rejected ? `, ${rejected} flagged` : ''}` };
  else if (!latest) now = { state: 'thinking', label: 'Starting the run' };
  else if (!caughtUp) now = latest.now;
  else if (closing) now = { state: 'writing', label: 'Combining the report' };
  else if (working.size) now = { state: 'analyzing', label: 'Waiting on', detail: [...working, ...(writing.size ? ['Rook'] : [])].join(', ') };
  else if (writing.size) now = { state: 'writing', label: 'Rook is working on', detail: [...writing].join(', ') };
  else now = free ? { state: 'writing', label: 'Rook is working' } : { state: 'researching', label: 'Lining up the next hire' };

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group -mx-2 flex max-w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-0.5 text-left text-ink/65 transition-colors hover:bg-ink/5 hover:text-ink motion-reduce:transition-none"
      >
        <AiStatus className="min-w-0" state={now.state} states={RUN_STATES} label={now.label || undefined} detail={now.detail} timer={timed} />
        {live && rejected > 0 && <span className="shrink-0 text-sm text-alert">{rejected} flagged</span>}
        <span className={`shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
      </button>
      <Reveal open={open && lines.length > 0}>
        <ul className="mt-2 space-y-1.5 border-l-2 border-ink/10 pl-4">
          {lines.map((l) => <li key={l.key} className={TONE[l.tone]} title={l.detail}>{l.text}</li>)}
        </ul>
      </Reveal>
    </div>
  );
}

/** Inline Markdown only: `code`, **bold**, _emphasis_. Report text comes from agents, so it stays plain React text. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\b_[^_]+_\b)/g).map((part, i) => {
    if (/^`.+`$/.test(part)) return <code key={i} className="font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    if (/^\*\*.+\*\*$/.test(part)) return <strong key={i} className="font-medium">{part.slice(2, -2)}</strong>;
    if (/^_.+_$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function Report({ markdown }: { markdown: string }) {
  const delay = (i: number) => ({ animationDelay: `${Math.min(i * 25, 900)}ms` });
  return (
    <div className="mt-3 space-y-2 leading-relaxed">
      {markdown.split('\n').map((raw, i) => {
        const line = raw.trim();
        if (!line) return null;
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) return <h3 key={i} style={delay(i)} className={`rook-in font-medium tracking-[-0.01em] ${heading[1].length <= 1 ? 'mt-4 text-2xl' : 'mt-4 text-xl'}`}>{inline(heading[2])}</h3>;
        if (/^[-*]\s/.test(line)) return <p key={i} style={delay(i)} className="rook-in pl-4 -indent-3">• {inline(line.slice(2))}</p>;
        return <p key={i} style={delay(i)} className="rook-in">{inline(line)}</p>;
      })}
    </div>
  );
}

// ---- one conversation ----

/** A server action call that never got an answer: the network dropped, or the web server was restarting. */
const UNREACHABLE = "This page couldn't reach Rook. Check your connection and try again.";

function Thread({ id, loaded, tasks, onGrow, fresh, onRevealed }: { id: string; loaded: Loaded; tasks: TaskSummary[] | null; onGrow: () => void; fresh: boolean; onRevealed: (id: string) => void }) {
  const { snap, events, problem, refetch } = loaded;
  const router = useRouter();
  const wallet = useWallet();
  const [busy, setBusy] = useState<'approve' | 'cancel' | 'stop' | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const [funding, setFunding] = useState<Funding | null>(null);
  const [fundingConfirmed, setFundingConfirmed] = useState(false);
  const [fundingBusy, setFundingBusy] = useState(false); // the funding step has the wallet open or a transfer in hand
  const [autoFund, setAutoFund] = useState(false); // approved here with one click: the wallet opens right away
  const status = snap?.task.status;
  const { mode, paymentsOff, noMoney, chain, network } = useMode();
  const contractId = funding?.contract_id ?? mode?.contract_id ?? null;
  // Approved but not yet funded (chain mode): the run starts only once the funding is bound, so this survives a reload.
  // The in-memory ledger starts the run at once, so there this state is gone in a moment.
  // A plan that hires no agent (Rook does every part itself) pays no one, so it starts with no funding at all.
  const free = !!snap?.plan?.subtasks.length && snap.plan.subtasks.every((s) => s.self_do);
  const awaitingFunding = status === 'approved' && !snap?.ledger && !noMoney && !free;
  // A transfer already sent needs no new instructions (the mode names the contract, the plan gives the terms). Asking
  // again would count its own contract task against the funder's open-task limit, and fail at that limit.
  const sentLive = !!snap?.funding_sent && !snap.funding_sent.refunded;
  const fundingAsked = useRef(false);
  // Why the funding instructions didn't come: the funding step says so, with Try again (which clears it) and Cancel.
  const [fundingTrouble, setFundingTrouble] = useState<string | null>(null);
  useEffect(() => {
    if (!awaitingFunding || sentLive || funding || fundingConfirmed || fundingTrouble !== null || fundingAsked.current) return;
    fundingAsked.current = true; // approve again: the orchestrator repeats the funding instructions for an approved task
    void fundingInstructions(id)
      .catch((): ActResult => ({ ok: false, message: UNREACHABLE }))
      .then((out) => {
        fundingAsked.current = false;
        if (out.ok && out.funding) return setFunding(out.funding);
        setFundingTrouble(out.ok ? FUNDING_NOT_READY : out.message);
        refetch(); // the task may have moved on meanwhile (stopped, or funded from another page)
      });
  }, [awaitingFunding, sentLive, funding, fundingConfirmed, fundingTrouble, id, refetch]);
  // Chain mode, a plan waiting for approval: the wallet's USDC is checked now, while the plan can still be cancelled, so
  // a wallet short of the budget never leaves an approved task waiting for funding.
  const needsFunds = status === 'planned' && chain && !free && !paymentsOff;
  const funds = useUsdcShortfall(needsFunds ? snap?.task.budget_atomic ?? null : null);
  const known = tasks?.find((t) => t.id === id)?.status;
  const [revealing, setRevealing] = useState(fresh); // a plan just drafted here: agents land first, then the plan
  const onAgentsDone = useCallback(() => { setRevealing(false); onRevealed(id); }, [id, onRevealed]);

  // Run updates roll in one at a time. A task that had already ended when opened is history, so it shows at once.
  const planned = snap?.plan?.subtasks ?? [];
  const titles = new Map(planned.map((s) => [s.id, s.title]));
  const feed = feedFrom(events, { titles, selfDo: new Set(planned.filter((s) => s.self_do).map((s) => s.id)), free, simNote: noMoney ? ' (simulated)' : '' });
  const planning = planningFrom(events);
  const [shown, setShown] = useState(0);
  const instant = useRef<boolean | null>(null);
  if (status && instant.current === null) instant.current = TERMINAL.has(status);
  // The run's clock starts when this page sees it start. Joining mid-run, it would show a time that's too short.
  const timed = useRef<boolean | null>(null);
  if (status && timed.current === null) timed.current = status === 'draft' || status === 'planned';
  const hasSnap = !!snap;
  useEffect(() => {
    if (!hasSnap || shown >= feed.length) return;
    if (instant.current || reducedMotion()) { setShown(feed.length); return; }
    const t = setTimeout(() => setShown((n) => n + 1), feed.length - shown > 6 ? CATCH_UP_MS : LINE_MS);
    return () => clearTimeout(t);
  }, [hasSnap, shown, feed.length]);
  const caughtUp = shown >= feed.length;
  const settled = !!status && TERMINAL.has(status) && caughtUp;
  useEffect(() => { onGrow(); }, [shown, status, settled, onGrow]);

  // Keep the sidebar's status honest when the run moves on without an action from this page: every step, so it never
  // says "Needs funding" while the funded run is starting.
  useEffect(() => { if (status && known && status !== known) router.refresh(); }, [status, known, router]);
  // The server has no session for this page (another tab signed out, or it lapsed): render signed out, with Connect.
  useEffect(() => { if (problem === 'signin' && wallet.account) router.refresh(); }, [problem, wallet.account, router]);

  async function act(kind: 'approve' | 'cancel' | 'stop') {
    setBusy(kind);
    setActError(null);
    // Checked again on the click (the balance may have changed since): a short wallet's plan is never approved.
    if (kind === 'approve' && needsFunds && await funds.check()) return setBusy(null);
    const out = await (kind === 'approve' ? approve(id) : kind === 'cancel' ? cancel(id) : stop(id)).catch(() => ({ ok: false as const, message: UNREACHABLE }));
    setBusy(null);
    if (!out.ok) setActError(out.message);
    else if (out.funding) { setFunding(out.funding); if (kind === 'approve') setAutoFund(true); }
    refetch();
  }

  if (problem === 'missing') return <RookMessage><p>Rook has no task at this link for the wallet you&apos;re signed in with. If another wallet drafted it, sign in with that one.</p></RookMessage>;
  if (problem === 'signin') return <RookMessage><p>Connect your wallet to see this task.</p></RookMessage>;
  if (problem === 'down' && !snap) return <RookMessage><p>Rook&apos;s services are unreachable right now. This page reconnects on its own once they&apos;re back.</p></RookMessage>;
  if (!snap) return <RookMessage><Working label="Loading" /></RookMessage>;

  const { task, plan, receipts, ledger, final_result } = snap;
  const visible = feed.slice(0, shown);
  // Never "Running" before the budget is locked: approved with no ledger yet is the funding step, and a task stopped
  // before any funding never ran. Only money says the run started, not any feed line (a kill adds one regardless).
  const unfunded = (task.status === 'approved' || task.status === 'killed') && !moneyMoved(snap, events);
  // A task that failed with nothing to run (planning failed, or every part was dropped) never started, whatever its
  // feed shows (that failure is an error event too).
  const started = !['draft', 'planned', 'cancelled'].includes(task.status) && !unfunded && !(task.status === 'failed' && !plan?.subtasks.length);
  const live = started && !settled;
  const spent = visible.reduce((sum, l) => sum + (l.paid ?? 0), 0);
  const reserveUsed = visible.reduce((sum, l) => sum + (l.fromReserve ?? 0), 0);
  const simNote = noMoney ? ' (simulated)' : '';
  const usage = new Map<string, LedgerSub>();
  if (started) for (const s of snap.subtasks ?? []) { const l = ledger?.subtasks?.find((x) => x.n === s.n); if (l) usage.set(s.id, l); }
  const delivered = deliveredParts(snap.subtasks ?? [], titles);

  return (
    <>
      <UserMessage prompt={task.prompt} budget={usdc(task.budget_atomic)} />

      {(task.status === 'draft' || (plan && (revealing || plan.subtasks.some((s) => s.candidates.length > 0)))) && (
        <RookMessage still={fresh}>
          <AgentSearch plan={plan} planning={planning} animate={fresh && planning.found.length === 0} onGrow={onGrow} onDone={revealing ? onAgentsDone : undefined} />
        </RookMessage>
      )}
      {task.status === 'failed' && !plan && (
        <RookMessage>
          <p>Rook couldn&apos;t draft a plan for this task.</p>
          {task.error && <p className="mt-1 text-sm text-ink/65">{plannerReason(task.error)}</p>}
        </RookMessage>
      )}

      {/* Every part was dropped: the task ended there, with the orchestrator's reason (no agent fits, or over budget). */}
      {plan && !revealing && plan.subtasks.length === 0 && (
        <RookMessage>
          <p>Rook couldn&apos;t draft a plan for this task.</p>
          {task.error && <p className="mt-1 text-sm text-ink/65">{task.error}</p>}
          {plan.dropped.length > 0 && <ul className="mt-2 text-sm text-ink/65">{plan.dropped.map((d, i) => <li key={i}>{d.title}: {d.reason}</li>)}</ul>}
        </RookMessage>
      )}

      {plan && !revealing && plan.subtasks.length > 0 && (
        <RookMessage>
          {free ? (
            <p>
              Here&apos;s the plan. {allSelfDoWhy(plan.subtasks.map((s) => s.self_do_reason), budgetToHire(plan))}{' '}
              Nothing is hired, so nothing is paid and nothing leaves your wallet.{task.status === 'cancelled' && ' You cancelled it.'}
            </p>
          ) : (
            <p>
              Here&apos;s the plan. The caps add up to <span className="font-medium">{usdc(plan.budget.allocated_atomic)} USDC</span>
              {BigInt(plan.budget.reserve_atomic || 0) > 0n && <>, and up to {usdc(plan.budget.reserve_atomic)} USDC more can come from the reserve when a subtask needs more than its cap</>}.{' '}
              {started ? 'You approved it.' : task.status === 'cancelled' ? 'You cancelled it, so nothing was spent.' : task.status === 'approved' ? 'You approved it. Nothing has been spent yet.' : task.status !== 'killed' ? 'Nothing has been spent.'
                : 'You stopped it before Rook started the run, so no agent was paid.'}
            </p>
          )}
          <PlanCard plan={plan} usage={usage} />
          {plan.dropped.length > 0 && <p className="mt-2 text-sm text-ink/65">Left out: {plan.dropped.map((d) => `${d.title} (${d.reason})`).join(', ')}</p>}
          {/* Stopped before Rook bound the wallet's transfer: whatever the feed shows, its USDC is the funder's to take back. */}
          {task.status === 'killed' && !ledger && snap.funding_sent && (
            <HeldFunding id={id} sent={snap.funding_sent} want={(funding && termsOf(funding)) ?? planTerms(task.budget_atomic, plan)}
              contractId={contractId} network={network} onChanged={refetch} />
          )}
          {task.status === 'planned' && (
            <div className="rook-in mt-4 flex flex-wrap gap-3" style={{ animationDelay: `${250 + plan.subtasks.length * 90}ms` }}>
              <ActionButton primary onClick={() => act('approve')} busy={busy === 'approve'} disabled={!wallet.account || paymentsOff || !!funds.short}
                title={paymentsOff ? 'Paying live agents is not switched on yet' : !wallet.account ? 'Connect your wallet first' : funds.short ? 'Your wallet holds less USDC than this budget' : undefined}>
                {busy === 'approve' ? (funds.checking ? 'Checking your USDC balance…' : chain && !free ? 'Preparing the transfer…' : 'Starting…') : free ? 'Start' : paymentsOff ? 'Approve' : noMoney ? 'Run simulation' : `Fund ${usdc(task.budget_atomic)} USDC and start`}
              </ActionButton>
              {funds.short && <ActionButton onClick={() => void funds.check()} busy={funds.checking}>{funds.checking ? 'Checking…' : 'Check again'}</ActionButton>}
              <ActionButton onClick={() => act('cancel')} busy={busy === 'cancel'}>Cancel</ActionButton>
            </div>
          )}
          {task.status === 'planned' && !free && !paymentsOff && noMoney && <p className="mt-2 text-sm text-ink/60">A simulated {usdc(task.budget_atomic)} USDC budget: nothing leaves your wallet and no agent is paid.</p>}
          {task.status === 'planned' && funds.short && <p role="alert" className="mt-2 text-sm text-alert">{funds.short}</p>}
          {task.status === 'planned' && !free && !paymentsOff && !noMoney && !funds.short && <p className="mt-2 text-sm text-ink/60">One click: your wallet opens to send the {usdc(task.budget_atomic)} USDC budget to the Rook contract on NEAR {network}, and the run starts once it lands. Each subtask spends at most its cap plus what Rook tops up from the reserve, and whatever isn&apos;t spent comes back to you.</p>}
          {task.status === 'planned' && !free && paymentsOff && <p className="mt-2 text-sm text-ink/60">Live agents and prices. Paying them isn&apos;t switched on yet, so nothing can be spent.</p>}
        </RookMessage>
      )}

      {awaitingFunding && plan && (
        <RookMessage>
          {fundingConfirmed
            ? <Working label="Funding confirmed. Starting the run" />
            : <FundingStep id={id} plan={plan} budget={task.budget_atomic} funding={funding} trouble={fundingTrouble} onRetry={() => setFundingTrouble(null)}
                sent={snap.funding_sent ?? null} contractId={contractId}
                stopping={busy === 'stop'} onStop={() => act('stop')} autoStart={autoFund} onBusy={setFundingBusy} onChanged={refetch}
                onConfirmed={() => { setFundingConfirmed(true); refetch(); router.refresh(); }} />}
        </RookMessage>
      )}

      {unfunded && task.status === 'killed' && !plan && <RookMessage><p>Stopped before any money moved. Nothing was spent.</p></RookMessage>}

      {started && (
        <RookMessage>
          <div className="flex items-start justify-between gap-x-3 gap-y-2 sm:flex-wrap sm:items-center sm:gap-x-6">
            <p className="min-w-0 tabular-nums max-sm:pt-2.5">
              {/* Failed with a report: the work finished and only the refund hit a problem, which the money card says. */}
              <span className="font-medium">{live ? 'Running.' : task.status === 'killed' ? 'Stopped.' : task.status === 'failed' && !final_result ? 'This run hit a problem.' : 'Finished.'}</span>
              {free ? ' Rook does every part itself, so nothing is spent.' : <>
                {' '}Spent {usdc(spent)} of {usdc(task.budget_atomic)} USDC{simNote}
                {reserveUsed > 0 && <span className="text-ink/65">, {usdc(reserveUsed)} from the reserve</span>}
              </>}
            </p>
            {!TERMINAL.has(task.status) && <ActionButton onClick={() => act('stop')} busy={busy === 'stop'} disabled={fundingBusy}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</ActionButton>}
          </div>
          <Activity lines={visible} live={live} caughtUp={caughtUp} closing={task.status === 'aggregating' || task.status === 'closing' || task.status === 'closed'}
            outcome={task.status === 'failed' && final_result ? 'closed' : task.status} timed={!!timed.current} free={free} />
        </RookMessage>
      )}

      {final_result && settled && (
        <RookMessage>
          <p className="font-medium">Here&apos;s your report.</p>
          {final_result.abandoned.length > 0 && <p className="mt-1 text-alert">{final_result.abandoned.length} subtask{final_result.abandoned.length > 1 ? 's' : ''} couldn&apos;t be completed.</p>}
          <Report markdown={final_result.final_markdown} />

          {!free && <MoneyCard ledger={ledger} receipts={receipts} network={network} simNote={simNote} />}
        </RookMessage>
      )}

      {/* Stopped or failed without a report: the parts that passed were paid for, so they are still here to read. */}
      {!final_result && settled && started && delivered.length > 0 && (
        <RookMessage>
          <p className="font-medium">{task.status === 'killed' ? 'Before you stopped it, these parts were delivered and passed every check.' : 'Before the problem, these parts were delivered and passed every check.'}</p>
          {delivered.map((d) => (
            <section key={d.id} className="mt-5">
              <h3 className="text-xl font-medium tracking-[-0.01em]">{d.title}</h3>
              <p className="text-sm text-ink/65">{d.agent ? <>Delivered by <span className="font-mono">{d.agent}</span>.</> : 'Rook did this part itself.'}</p>
              <Report markdown={d.text} />
            </section>
          ))}
        </RookMessage>
      )}

      {/* Stopped or failed without a report: still say where the money went, and what came back. */}
      {!final_result && settled && started && !free && (ledger || receipts.length > 0) && (
        <RookMessage><MoneyCard ledger={ledger} receipts={receipts} network={network} simNote={simNote} /></RookMessage>
      )}

      {actError && <p role="alert" className="rounded-2xl border border-alert/40 bg-alert/10 p-4 text-alert">{actError}</p>}
    </>
  );
}

// ---- the page's one conversation surface ----

/** Lives in the layout, so going from /app to /app/{id} changes what it shows without remounting anything. */
export function Chat({ tasks }: { tasks: TaskSummary[] | null }) {
  const pathname = usePathname();
  const wallet = useWallet();
  const parts = pathname.split('/').filter(Boolean); // ['app', id?]
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  const loaded = useTask(id, wallet.account);
  const [sending, setSending] = useState<{ prompt: string; budget: string; id?: string } | null>(null);
  const [errors, setErrors] = useState<ComposerErrors | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ease = useEase();
  const justDrafted = useRef(new Set<string>());
  const onRevealed = useCallback((task: string) => { justDrafted.current.delete(task); }, []);

  const home = !id && !sending;
  const lenis = useSmoothScroll(scroller, !home);

  async function send(prompt: string, budget: string) {
    setErrors(null);
    setSending({ prompt: prompt.trim(), budget });
    // Returns as soon as the task exists; the plan then streams in on the task's page. The call itself can fail (the
    // network, or the web server restarting): then the composer gets its text back and says so.
    const out = await draftTask({ prompt, budget }).catch(() => ({ kind: 'error' as const, message: UNREACHABLE }));
    if (out.kind === 'planned') {
      // Keep showing this message until the task has loaded, so the thread takes over with no gap.
      justDrafted.current.add(out.id);
      setSending((s) => s && { ...s, id: out.id });
      go(`/app/${out.id}`);
      return true;
    }
    setSending(null);
    setErrors(out.kind === 'invalid' ? { prompt: out.prompt, budget: out.budget } : { message: out.message });
    return false;
  }

  useEffect(() => {
    if (sending?.id && sending.id === id && (loaded.snap?.task.id === id || loaded.problem)) setSending(null);
  }, [sending, id, loaded.snap, loaded.problem]);
  useEffect(() => { setErrors(null); }, [id]); // a failed send's errors are about that send, not the next page

  // Follow the conversation as it grows, until the reader scrolls up. Only their input can stop it: a smooth scroll on
  // its way down is also far from the bottom for a moment, and must not count. Moving down to the bottom resumes following;
  // moving up must not, since the first frames of scrolling up are still close to the bottom. Neither must the last frame
  // of a follow already under way, which can arrive just after the reader's input: that is what the hold is for.
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const lastTouchY = useRef(0);
  const holdUntil = useRef(0);
  const letGo = (at: number) => { pinned.current = false; holdUntil.current = at + FOLLOW_HOLD_MS; };
  useEffect(() => { pinned.current = true; }, [id]);
  const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const follow = useCallback(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    if (!lenis.current) { el.scrollTop = el.scrollHeight; return; }
    lenis.current.resize();
    lenis.current.scrollTo(el.scrollHeight - el.clientHeight, { duration: 0.7 });
  }, [lenis]);
  useEffect(follow, [sending, id, follow]);

  return (
    <div className="flex h-full flex-col">
      <div className={`flex min-h-0 flex-1 flex-col ${home ? 'sm:justify-center' : ''}`}>
        {home ? (
          <div className="mx-auto flex w-full max-w-208 flex-col items-center justify-center px-5 max-sm:flex-1 md:px-8">
            <span className="mb-4 sm:hidden [&>svg]:size-9" aria-hidden="true"><Mark /></span>
            <h1 className="text-center text-[1.75rem] leading-[1.05] font-normal tracking-[-0.035em] sm:text-[clamp(2.25rem,4.5vw,4rem)]">
              What do you want done?
            </h1>
          </div>
        ) : (
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (e.timeStamp > holdUntil.current && el.scrollTop > lastTop.current && nearBottom(el)) pinned.current = true;
              lastTop.current = el.scrollTop;
            }}
            onWheel={(e) => { if (e.deltaY < 0) letGo(e.timeStamp); }}
            onTouchStart={(e) => { lastTouchY.current = e.touches[0].clientY; }}
            onTouchMove={(e) => {
              const y = e.touches[0].clientY;
              if (y > lastTouchY.current) letGo(e.timeStamp); // a finger moving down scrolls up
              lastTouchY.current = y;
            }}
            onKeyDown={(e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) letGo(e.timeStamp); }}
            className="min-h-0 flex-1 overflow-y-auto mask-[linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%-12px),transparent)] sm:mask-[linear-gradient(to_bottom,transparent,#000_48px,#000_calc(100%-12px),transparent)]"
          >
            <div className="mx-auto w-full max-w-208 space-y-6 px-4 pt-3 pb-6 sm:px-5 sm:pt-16 sm:pb-8 md:px-8">
              <h1 className="sr-only">{sending?.prompt ?? loaded.snap?.task.prompt ?? 'Task'}</h1>
              {sending ? (
                <>
                  <UserMessage animate prompt={sending.prompt} budget={sending.budget} />
                  <RookMessage><AgentSearch plan={null} animate={false} onGrow={follow} /></RookMessage>
                </>
              ) : id && <Thread key={`${id}:${wallet.account}`} id={id} loaded={loaded} tasks={tasks} onGrow={follow} fresh={justDrafted.current.has(id)} onRevealed={onRevealed} />}
            </div>
          </div>
        )}

        {/* Glides between the centre of the home screen and the bottom of a conversation. */}
        <motion.div layout="position" transition={ease} className={`mx-auto w-full max-w-208 md:px-8 px-2.5 pb-2.5 sm:px-5 ${home ? 'sm:mt-8 sm:pb-16' : 'sm:pb-5'}`}>
          <Composer onSend={send} errors={errors} sending={!!sending} compact={!home} />
        </motion.div>
      </div>
    </div>
  );
}
