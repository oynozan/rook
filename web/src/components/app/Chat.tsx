'use client';

import { motion } from 'motion/react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { Mark } from '@/components/Navbar';
import { useSmoothScroll } from '@/components/SmoothScroll';
import { AiStatus } from '@/components/ui/ai-status';
import { WebSearch, type WebSource } from '@/components/ui/web-search';
import { approve, cancel, confirmFunding, draftTask, forgetContractTask, forgetTransfer, fundingInstructions, fundingRefunded, rememberTransfer, stop, type ActResult } from '@/lib/server/actions';
import { go } from '@/components/app/AppShell';
import { Composer, type ComposerErrors, type ComposerThread } from '@/components/app/Composer';
import { ActionButton, Reveal } from '@/components/app/controls';
import { InlineText, Markdown } from '@/components/app/Markdown';
import { ReportFiles } from '@/components/app/ReportFiles';
import { clockTime, RunParts, useClock } from '@/components/app/RunParts';
import { attemptNote, canEdit, canSendAgain, failedDraft, messageProblem, redoWait, shownInstead, shownTasks } from '@/lib/chat-actions';
import { ASK_LEAD, askPrompt, conversationOf, missingParts, PLACEHOLDERS_ANSWER, questionsOf, retryMessage, revisedPlan } from '@/lib/conversations';
import { checkDraft, parseBudget } from '@/lib/draft';
import { deliveredParts, feedFrom, type FeedLine, type Now } from '@/lib/feed';
import { costLabel, criterionCheck, droppedLines, editLine, emptyPlanLead, fallbackLine, planBlocked, planCost, planNotes, reserveSpent, spendLabel, timeLine } from '@/lib/plan-view';
import { nowLine, partViews, runHeadline, type Line } from '@/lib/run-view';
import {
  balanceProblem, closeTaskTransaction, confirmFailure, contractHasTask, fetchTxOutcome, fundingFrom, fundingMismatch, fundingTerms, fundingTransaction, isWalletCancel,
  keptTransferKey, keptValue, moneyMoved, plainReason, planTerms, readCloseOutcome, readFundingOutcome, readUsdcBalance, restoreKept, termsOf, TX_HASH, txHashOf,
  usdc, whoseTransfer,
  type CloseResult, type Funding, type FundingResult, type KeptTransfer, type Terms,
} from '@/lib/funding';
import { explorerTx, NETWORK, rpcFor, type Network } from '@/lib/network';
import type { Candidate, LedgerSub, PlanView, Receipt, RookEvent, TaskSnapshot, TaskSummary } from '@/lib/server/orchestrator';
import { detail, pageUnreachable } from '@/lib/errors';
import { useMode } from '@/hooks/mode';
import { allSelfDoWhy, budgetToHire, selfDoWhy } from '@/lib/planner';
import { FUNDING_NOT_READY } from '@/lib/refusals';
import { useEase } from '@/hooks/useEase';
import { useWallet, WalletAccountMismatch } from '@/hooks/wallet';

const TERMINAL = new Set(['closed', 'cancelled', 'killed', 'failed']);
// Nothing more happens to these: the ended statuses, and Rook's questions (the next message answers them, as a task of
// its own). The event stream may end there, and history shows at once.
const QUIET = new Set([...TERMINAL, 'asking']);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const LINE_MS = 420;
const CATCH_UP_MS = 70; // a refresh mid-run replays history quickly, then returns to the live pace
const AGENT_MS = 320; // agents land one at a time, then the plan they make up
const AGENTS_MAX_MS = 2400;
const CARDS_OPEN_MS = 550; // how long the agent cards take to open, so following waits for their full height
const FOLLOW_HOLD_MS = 150; // after the reader scrolls up, how long scroll events can't resume following

// ---- loading one task ----

/** `problem`: 'deleted', this account deleted the task's chat (in another tab, say); 'missing', it isn't this account's. */
/** `down`: why the task couldn't load, as a clause, while `problem` is 'down'. */
type Loaded = { snap: TaskSnapshot | null; events: RookEvent[]; problem: 'deleted' | 'missing' | 'signin' | 'down' | null; down: string | null; refetch: () => void };

/** `account`: the signed-in account. Another one (or none) loads the task afresh, as that account may see it. */
function useTask(id: string | null, account: string | null): Loaded {
  const [snap, setSnap] = useState<TaskSnapshot | null>(null);
  const [events, setEvents] = useState<RookEvent[]>([]);
  const [problem, setProblem] = useState<Loaded['problem']>(null);
  const [down, setDown] = useState<string | null>(null);

  /** Loads the task; resolves with it, 'down' when Rook couldn't be reached, or null when it isn't this account's. */
  const load = useCallback(async (): Promise<TaskSnapshot | 'down' | null> => {
    if (!id) return null;
    try {
      const r = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (r.status === 404) {
        const why: { deleted?: boolean } | null = await r.json().catch(() => null);
        setProblem(why?.deleted === true ? 'deleted' : 'missing');
        return null;
      }
      if (r.status === 401) { setProblem('signin'); return null; }
      if (!r.ok) {
        const why: { error?: unknown } | null = await r.json().catch(() => null);
        setDown(typeof why?.error === 'string' ? why.error : `this web server answered HTTP ${r.status}`);
        setProblem('down');
        return 'down';
      }
      const s: TaskSnapshot = await r.json();
      setProblem(null);
      setSnap(s);
      return s;
    } catch (e) {
      setDown(`this page got no answer from Rook's web server (${detail(e instanceof Error ? e.message : e) || 'no reason given'})`);
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
    // 'quote': a price came in, so the run's status moves from getting it to sending the job.
    const types = ['task_status', 'subtask_status', 'planning', 'plan', 'quote', 'quote_rejected', 'hire_sent', 'a2a_state', 'evaluation', 'security_alert', 'ledger', 'receipt', 'final', 'error'];
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
      if (e.type === 'task_status' && QUIET.has(e.data.to)) ended = true;
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
  return { snap: snap?.task.id === id && snap.task.owner === account ? snap : null, events, problem, down, refetch };
}

// ---- pieces of the thread ----

/** `note`: it took another message's place ("Edited", "Sent again"). `onEdit`: the newest message, still editable. */
function UserMessage({ prompt, budget, animate, note, onEdit, editRef }: {
  prompt: string; budget: string; animate?: boolean; note?: string | null; onEdit?: () => void; editRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className={`flex flex-col items-end ${animate ? 'rook-in' : ''}`}>
      <div className="max-w-[85%] rounded-3xl rounded-br-md bg-ink/5 px-4 py-2.5 sm:px-5 sm:py-3">
        <p className="leading-snug whitespace-pre-wrap sm:text-lg">{prompt}</p>
        <p className="mt-1 text-right text-sm text-ink/65">Budget {budget} USDC{note && <span className="text-ink/55"> · {note}</span>}</p>
      </div>
      {onEdit && (
        <button
          ref={editRef}
          type="button"
          onClick={onEdit}
          className="-mb-2 inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm text-ink/65 transition-colors hover:bg-ink/5 hover:text-ink active:translate-y-px motion-reduce:transition-none"
        >
          <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11.4 2.35a1.3 1.3 0 0 1 1.84 1.84L5.5 11.93l-2.75.82.82-2.75z" />
          </svg>
          Edit<span className="sr-only"> message</span>
        </button>
      )}
    </div>
  );
}

/**
 * The newest message, edited in place: its text and its budget. Enter saves (Shift+Enter starts a new line), Escape
 * cancels. Save stays off until something changed: the same message again is "Send again".
 */
function MessageEditor({ prompt, budget, saving, errors, onSave, onCancel }: {
  prompt: string; budget: string; saving: boolean; errors: ComposerErrors | null;
  onSave: (prompt: string, budget: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(prompt);
  const [amount, setAmount] = useState(budget);
  const area = useRef<HTMLTextAreaElement>(null);
  const uid = useId();
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const was = parseBudget(budget), now = parseBudget(amount);
  const changed = text.trim() !== prompt.trim() || (now.ok && was.ok ? now.atomic !== was.atomic : amount.trim() !== budget.trim());
  const save = () => { if (!saving && changed) onSave(text, amount); };
  const invalid = !!(errors?.prompt || errors?.budget);
  return (
    <form
      noValidate
      aria-label="Edit your message"
      onSubmit={(e) => { e.preventDefault(); save(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !saving) { e.preventDefault(); e.stopPropagation(); onCancel(); } }}
      className={`ml-auto w-full max-w-[85%] rounded-3xl rounded-br-md border bg-surface p-2 shadow-sm shadow-ink/5 transition-[border-color,box-shadow] duration-200 focus-within:ring-4 motion-reduce:transition-none sm:p-3 ${invalid ? 'border-alert/50 focus-within:ring-alert/10' : 'border-ink/15 focus-within:border-accent/50 focus-within:ring-accent/10'}`}
    >
      <textarea
        ref={area}
        aria-label="Your message"
        aria-invalid={!!errors?.prompt}
        aria-describedby={errors?.prompt ? `${uid}-prompt` : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          save();
        }}
        rows={2}
        className="field-sizing-content block max-h-64 min-h-11 w-full resize-none overflow-y-auto bg-transparent px-2 pt-1.5 pb-1 leading-snug outline-none sm:px-3 sm:text-lg"
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <label className={`inline-flex h-11 cursor-text items-center gap-1.5 rounded-full px-4 whitespace-nowrap text-ink/65 ring-inset transition-colors duration-200 focus-within:ring-2 motion-reduce:transition-none ${errors?.budget ? 'bg-alert/10 text-ink ring-1 ring-alert/50 focus-within:ring-alert/50' : 'bg-ink/5 hover:bg-ink/10 focus-within:bg-surface focus-within:ring-accent/50'}`}>
          Budget
          <input
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={!!errors?.budget}
            aria-describedby={errors?.budget ? `${uid}-budget` : undefined}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="field-sizing-content max-w-[9ch] min-w-[2ch] bg-transparent font-medium text-ink tabular-nums outline-none"
          />
          USDC
        </label>
        <div className="ml-auto flex gap-2 max-sm:w-full">
          <ActionButton onClick={onCancel} disabled={saving}>Cancel</ActionButton>
          <ActionButton primary submit busy={saving} disabled={!changed} title={changed ? undefined : 'Change the message or its budget first'}>
            {saving ? 'Saving…' : 'Save'}
          </ActionButton>
        </div>
      </div>
      {errors?.prompt && <p id={`${uid}-prompt`} className="mt-2 px-2 text-sm text-alert sm:px-3">{errors.prompt}</p>}
      {errors?.budget && <p id={`${uid}-budget`} className="mt-2 px-2 text-sm text-alert sm:px-3">{errors.budget}</p>}
      {errors?.message && <p role="alert" className="mt-2 px-2 text-sm text-alert sm:px-3">{errors.message}</p>}
    </form>
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

/**
 * What a subtask can cost: Rook's own work, or the most it can cost (its cap, or more once Rook hires the next agent
 * from the reserve; the planner drops 0 USDC quotes, so a hired subtask's cap is never 0). During a run, what it has
 * spent of its cap, and what came from the reserve when it spent more.
 */
function CapLabel({ subtask: s, usage, reserve, why }: { subtask: PlanView['subtasks'][number]; usage?: LedgerSub; reserve: bigint; why: string }) {
  const cost = costLabel(s, reserve);
  return (
    <span title={s.self_do ? why : usage ? "Spent of this subtask's cap, and what came from the reserve when it spent more" : cost.line ?? undefined}
      className={`shrink-0 pl-3 text-sm text-ink/65 sm:pl-0 ${s.self_do ? '' : 'font-mono tabular-nums'}`}>
      {s.self_do ? 'Rook does this' : usage ? spendLabel(usage) : cost.label}
    </span>
  );
}

/**
 * `why`: why Rook does a self_do part itself (selfDoWhy). `started`: the run is under way, so the brief shows with each
 * part's progress (as sent, or to be sent) instead of here, once. Under its title, always in view: the delivered files
 * it edits, and what happens if no agent delivers.
 */
function PlanRow({ subtask: s, usage, reserve, why, started }: { subtask: PlanView['subtasks'][number]; usage?: LedgerSub; reserve: bigint; why: string; started: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const edits = editLine(s), fallback = fallbackLine(s), cost = costLabel(s, reserve).line, time = timeLine(s);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer flex-col justify-between gap-x-4 gap-y-0.5 rounded-2xl px-4 py-3 text-left hover:bg-ink/5 sm:flex-row sm:items-baseline"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`text-ink/55 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
          <span className="min-w-0">
            <span className="block font-medium wrap-break-word">{s.title}</span>
            {edits && <span className="block text-sm text-ink/65 wrap-break-word">{edits}</span>}
            {!started && fallback && <span className="block text-sm text-ink/65">{fallback}</span>}
          </span>
        </span>
        <CapLabel subtask={s} usage={usage} reserve={reserve} why={why} />
      </button>
      <Reveal open={open}>
        <div id={id} className="px-4 pt-1 pb-4 pl-8 text-ink/80">
          {/* The label's tooltip says the same, but a phone shows no tooltips. */}
          {s.self_do && <p className="mb-3 text-sm text-ink/65">{why}</p>}
          {!s.self_do && !usage && cost && <p className="mb-3 text-sm text-ink/65">{cost}</p>}
          {s.brief && !started && (
            // The planner's own words for the agent; plain text, never markup. Nothing is sent before the plan runs.
            <details className="mb-3">
              <summary className="cursor-pointer text-sm text-ink/65 hover:text-ink">{s.self_do ? 'Brief' : 'Brief for the agent'}</summary>
              <p className="mt-1 text-sm whitespace-pre-wrap">{s.brief}</p>
            </details>
          )}
          <p className="text-sm text-ink/65">Must pass</p>
          <ul className="mt-1 space-y-0.5">
            {s.criteria.map((c) => {
              // A check that loads something (an image, a cited source, the live link) says so: its words alone may promise less.
              const how = criterionCheck(c);
              return <li key={c.id}>{c.description}{how && <span className="block text-sm text-ink/60">{how}</span>}</li>;
            })}
          </ul>
          {time && <p className="mt-3 text-sm text-ink/65">{time}</p>}
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

/**
 * One candidate: its name, handle and price, what the market says about it, and why it sits where it does (expected
 * cost: price divided by its chance to pass). Agent text is shown as plain text. Its own promised time is left out:
 * Rook's wait for it (timeLine) is the one that holds.
 */
function CandidateLine({ c }: { c: Candidate }) {
  // success_rate is a percentage. A rate with no delivered jobs behind it says nothing, so it is left out, not shown as 0%.
  const rate = c.success_rate === null || c.delivered_jobs === 0 ? null : Math.round(c.success_rate);
  const facts = [
    rate !== null && `${rate}% success`,
    c.delivered_jobs > 0 && `${c.delivered_jobs} job${c.delivered_jobs === 1 ? '' : 's'} delivered`,
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

function PlanCard({ plan, usage, started }: { plan: PlanView; usage?: Map<string, LedgerSub>; started: boolean }) {
  const { mode } = useMode();
  const reserve = /^\d+$/.test(plan.budget.reserve_atomic) ? BigInt(plan.budget.reserve_atomic) : 0n;
  return (
    <ol className="mt-3 rounded-2xl border border-ink/15">
      {plan.subtasks.map((s, i) => (
        <li key={s.id} className="rook-in border-b border-ink/10 last:border-b-0" style={{ animationDelay: `${150 + i * 90}ms` }}>
          <PlanRow subtask={s} usage={usage?.get(s.id)} reserve={reserve} started={started}
            why={s.self_do ? selfDoWhy(s, budgetToHire(plan, s.id), plan.subtasks.slice(0, i).some((x) => !x.self_do), mode?.max_budget_atomic) : ''} />
        </li>
      ))}
    </ol>
  );
}

/** What Rook takes as given, and the notes to read before paying (planNotes), in plain lines under the plan. */
function PlanFacts({ plan }: { plan: PlanView }) {
  const { mode } = useMode();
  const assumed = (plan.assumptions ?? []).map((a) => a.trim()).filter(Boolean);
  const notes = planNotes(plan, mode?.max_budget_atomic);
  if (!assumed.length && !notes.length) return null;
  return (
    <div className="rook-in mt-3 space-y-3 text-sm" style={{ animationDelay: `${200 + plan.subtasks.length * 90}ms` }}>
      {assumed.length > 0 && (
        <div>
          <p className="text-ink/65">Rook will assume</p>
          <ul className="mt-1 space-y-0.5">{assumed.map((a, i) => <li key={i} className="pl-4 -indent-3">• <InlineText text={a} /></li>)}</ul>
        </div>
      )}
      {notes.length > 0 && (
        <ul className="space-y-1">{notes.map((n, i) => <li key={i} className={n.tone === 'alert' ? 'text-alert' : 'text-ink/65'}>{n.text}</li>)}</ul>
      )}
    </div>
  );
}

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const LINK = 'underline decoration-ink/30 underline-offset-2 hover:decoration-ink';

/**
 * What the run spent and refunded, and a receipt per paid hire, named by the part it paid for (`titles`). The refund
 * shows once the contract closed the task.
 */
function MoneyCard({ ledger, receipts, network, simNote, titles }: { ledger: TaskSnapshot['ledger']; receipts: Receipt[]; network: Network; simNote: string; titles: Map<string, string> }) {
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
                <span className="min-w-0">
                  <span className="block truncate font-mono">{r.agent_handle}</span>
                  {r.subtask_id && titles.get(r.subtask_id) && <span className="block truncate text-ink/60" title={titles.get(r.subtask_id)}>for {titles.get(r.subtask_id)}</span>}
                </span>
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
  /** Why the funding instructions didn't load (a sentence), and how to ask for them again (null: asking can never work). */
  trouble: string | null; onRetry: (() => void) | null;
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
      .catch((e) => ({ ok: false as const, message: pageUnreachable(e) }));
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
          {trouble && onRetry && <ActionButton primary onClick={onRetry} disabled={stopping}>Try again</ActionButton>}
          <ActionButton primary={!!trouble && !onRetry} onClick={onStop} busy={stopping}>{stopping ? 'Cancelling…' : 'Cancel'}</ActionButton>
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
        <div className={row}><dt className="shrink-0 text-ink/65">Token</dt><dd className="min-w-0 text-right">USDC <span className="font-mono text-ink/60 break-all" title={funding.usdc}>({short(funding.usdc)})</span></dd></div>
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

const TONE = { normal: '', muted: 'text-ink/65 text-sm', alert: 'text-alert' };

const STOPPED = (
  <svg viewBox="0 0 24 24" width={18} height={18} className="text-ink/65" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
);
const RUN_STATES = { stopped: { label: 'Stopped', active: false, icon: STOPPED } };

/**
 * Collapsed to one line that says what is happening now; the full list is one click away. `refunding`: the report is
 * written and only the refund is left, which Rook keeps sending until the contract closes the task. `current`: what
 * the parts are doing (nowLine), null when none is doing anything specific.
 */
function Activity({ lines, live, caughtUp, closing, refunding, outcome, timed, free, current }: {
  lines: FeedLine[]; live: boolean; caughtUp: boolean; closing: boolean; refunding: boolean; outcome: string; timed: boolean; free: boolean; current: Line | null;
}) {
  const [open, setOpen] = useState(false);
  const latest = lines[lines.length - 1];
  const rejected = lines.filter((l) => l.flag).length;

  let now: Now;
  if (refunding && caughtUp) now = { state: 'analyzing', label: 'Sending the unspent USDC back' };
  else if (!live) now = { state: outcome === 'killed' ? 'stopped' : outcome === 'failed' ? 'error' : 'done', label: '', detail: `${lines.length} step${lines.length === 1 ? '' : 's'}${rejected ? `, ${rejected} flagged` : ''}` };
  else if (!latest && !current) now = { state: 'thinking', label: 'Starting the run' };
  else if (!caughtUp && latest) now = latest.now;
  else if (closing) now = { state: 'writing', label: 'Combining the report' };
  else if (current) now = current;
  // Only when nothing more specific is known: between one agent's release and the next one's quote, for a moment.
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

// ---- one conversation ----

/** A server action call that never got an answer: the network dropped, or the web server was restarting. */
/** A plan Rook cancelled because a message below it revised it. */
const REPLACED = 'You revised this plan below, so it was cancelled.';

/**
 * The newest message drafted again in its place, as it was ("Send again") or edited. Resolves with what went wrong, or
 * null once the new message is sent.
 */
type Redo = (old: { id: string; parent_id: string | null; prompt: string; budget_atomic: string }, prompt: string, budget: string) => Promise<ComposerErrors | null>;

/** The next message in the conversation, sent from a button here as if typed in the composer (an answer, a retry). */
type Answer = (prompt: string, budget: string) => Promise<boolean>;

/**
 * `revised`: a newer message is revising this plan and is still being planned, so the plan waits for it. `onRedo`: this
 * is the newest message and nothing above it is planning or running, so it can be sent again or edited; `redoing`:
 * that is under way; `locked`: another message is being sent. `onAnswer`: this is the newest message, so a button
 * may send the next one (Use placeholders, Try this part again). `chat`: the chat's first request, which names its zip.
 */
function Thread({ id, loaded, tasks, onGrow, fresh, onRevealed, revised, onRedo, redoing, locked, onAnswer, chat }: {
  id: string; loaded: Loaded; tasks: TaskSummary[] | null; onGrow: () => void; fresh: boolean; onRevealed: (id: string) => void; revised: boolean;
  onRedo?: Redo; redoing: boolean; locked: boolean; onAnswer?: Answer; chat?: string;
}) {
  const { snap, events, problem, down, refetch } = loaded;
  const router = useRouter();
  const wallet = useWallet();
  const [editing, setEditing] = useState(false);
  const [editErrors, setEditErrors] = useState<ComposerErrors | null>(null);
  const [againError, setAgainError] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null); // the bubble's Edit
  const blockEditButton = useRef<HTMLButtonElement>(null); // the failure's own Edit message, shown instead of the bubble's
  const facts = snap ? { status: snap.task.status, subtasks: snap.plan ? snap.plan.subtasks.length : null, ledger: !!snap.ledger } : null;
  const editable = !!onRedo && !!facts && !!wallet.account && canEdit(facts);
  const resendable = !!onRedo && !!facts && !!wallet.account && canSendAgain(facts);
  useEffect(() => { if (!editable) setEditing(false); }, [editable]); // a newer message came, or the plan was approved
  const [busy, setBusy] = useState<'approve' | 'cancel' | 'stop' | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const [funding, setFunding] = useState<Funding | null>(null);
  const [fundingConfirmed, setFundingConfirmed] = useState(false);
  const [fundingBusy, setFundingBusy] = useState(false); // the funding step has the wallet open or a transfer in hand
  const [autoFund, setAutoFund] = useState(false); // approved here with one click: the wallet opens right away
  const status = snap?.task.status;
  // The report is written and only the refund is left (a close that failed is tried again, for minutes at times): the
  // run is finished, its report and money card show, and nothing is left to stop.
  const refundPending = status === 'closing' && !!snap?.final_result;
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
  // `final`: asking again can never work (a 0 USDC cap), so only Cancel is offered.
  const [fundingTrouble, setFundingTrouble] = useState<{ message: string; final?: true } | null>(null);
  useEffect(() => {
    if (!awaitingFunding || sentLive || funding || fundingConfirmed || fundingTrouble !== null || fundingAsked.current) return;
    fundingAsked.current = true; // approve again: the orchestrator repeats the funding instructions for an approved task
    void fundingInstructions(id)
      .catch((e): ActResult => ({ ok: false, message: pageUnreachable(e) }))
      .then((out) => {
        fundingAsked.current = false;
        if (out.ok && out.funding) return setFunding(out.funding);
        setFundingTrouble(out.ok ? { message: FUNDING_NOT_READY } : { message: out.message, ...(out.final ? { final: true as const } : {}) });
        refetch(); // the task may have moved on meanwhile (stopped, or funded from another page)
      });
  }, [awaitingFunding, sentLive, funding, fundingConfirmed, fundingTrouble, id, refetch]);
  // Chain mode, a plan waiting for approval: the wallet's USDC is checked now, while the plan can still be cancelled, so
  // a wallet short of the budget never leaves an approved task waiting for funding.
  // A plan Rook says can't be funded as it is (planBlocked) offers no funding, so the wallet isn't read for it.
  const blocked = snap?.plan ? planBlocked(snap.plan) : null;
  const needsFunds = status === 'planned' && chain && !free && !paymentsOff && !blocked;
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
  if (status && instant.current === null) instant.current = QUIET.has(status) || refundPending;
  // Rook's questions show at once: no agents were searched for, so there are none to land first.
  const asking = status === 'asking';
  useEffect(() => { if (asking && revealing) onAgentsDone(); }, [asking, revealing, onAgentsDone]);
  const [answering, setAnswering] = useState(false);
  async function answer(prompt: string) {
    if (!snap || !onAnswer) return;
    setAnswering(true);
    await onAnswer(prompt, usdc(snap.task.budget_atomic)).catch(() => false);
    setAnswering(false);
  }
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
  const settled = !!status && (TERMINAL.has(status) || refundPending) && caughtUp;
  useEffect(() => { onGrow(); }, [shown, status, settled, onGrow]);
  // Elapsed times and give-up times move on their own while a run is under way.
  const now = useClock(!!status && ['funded', 'running', 'aggregating'].includes(status));

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
    const out = await (kind === 'approve' ? approve(id) : kind === 'cancel' ? cancel(id) : stop(id)).catch((e) => ({ ok: false as const, message: pageUnreachable(e) }));
    setBusy(null);
    if (!out.ok) setActError(out.message);
    else if (out.funding) { setFunding(out.funding); if (kind === 'approve') setAutoFund(true); }
    refetch();
  }

  const openEditor = () => { setEditErrors(null); setAgainError(null); setEditing(true); };
  // Back to the Edit button that opened it: the failure's own when it shows one (the bubble's is hidden then), else the bubble's.
  const closeEditor = () => {
    setEditing(false);
    setEditErrors(null);
    requestAnimationFrame(() => (blockEditButton.current ?? editButton.current)?.focus());
  };
  // Checked here first, as the composer does; the action checks again. Once sent, this message makes way for the new one.
  async function saveEdit(prompt: string, budget: string) {
    if (!snap || !onRedo) return;
    const check = checkDraft({ prompt, budget }, mode);
    if (!check.ok) return setEditErrors({ prompt: check.prompt, budget: check.budget });
    setEditErrors(null);
    setEditErrors(await onRedo({ ...snap.task, parent_id: snap.task.parent_id ?? null }, check.prompt, check.usdc));
  }
  async function sendAgain() {
    if (!snap || !onRedo) return;
    setAgainError(null);
    const out = await onRedo({ ...snap.task, parent_id: snap.task.parent_id ?? null }, snap.task.prompt, usdc(snap.task.budget_atomic));
    if (out) setAgainError(out.message ?? out.budget ?? out.prompt ?? null);
  }

  if (problem === 'deleted') return <RookMessage><p>This chat was deleted.</p></RookMessage>;
  if (problem === 'missing') return <RookMessage><p>Rook has no task at this link for the wallet you&apos;re signed in with. If another wallet drafted it, sign in with that one.</p></RookMessage>;
  if (problem === 'signin') return <RookMessage><p>Connect your wallet to see this task.</p></RookMessage>;
  if (problem === 'down' && !snap) return <RookMessage><p>This task can&apos;t load: {down ?? "Rook's services aren't answering"}. This page reconnects on its own once Rook answers.</p></RookMessage>;
  if (!snap) return <RookMessage><Working label="Loading" /></RookMessage>;

  const { task, plan, receipts, ledger, final_result } = snap;
  const visible = feed.slice(0, shown);
  // Never "Running" before the budget is locked: approved with no ledger yet is the funding step, and a task stopped
  // before any funding never ran. Only money says the run started, not any feed line (a kill adds one regardless).
  const unfunded = (task.status === 'approved' || task.status === 'killed') && !moneyMoved(snap, events);
  // A task that failed with nothing to run (planning failed, or every part was dropped) never started, whatever its
  // feed shows (that failure is an error event too).
  // Rook's questions never started anything either: nothing was planned or funded.
  const started = !['draft', 'asking', 'planned', 'cancelled'].includes(task.status) && !unfunded && !(task.status === 'failed' && !plan?.subtasks.length);
  const live = started && !settled;
  const spent = visible.reduce((sum, l) => sum + (l.paid ?? 0), 0);
  // From the reserve: only what parts spent beyond their caps (a top-up returned unspent isn't spent), from Rook's books
  // once it has them; never more than the spending shown so far.
  const fromReserve = ledger?.subtasks ? Number(reserveSpent(ledger.subtasks)) : visible.reduce((sum, l) => sum + (l.fromReserve ?? 0), 0);
  const reserveUsed = Math.min(fromReserve, spent);
  const simNote = noMoney ? ' (simulated)' : '';
  const usage = new Map<string, LedgerSub>();
  if (started) for (const s of snap.subtasks ?? []) { const l = ledger?.subtasks?.find((x) => x.n === s.n); if (l) usage.set(s.id, l); }
  const delivered = deliveredParts(snap.subtasks ?? [], titles);
  // Each part's progress, live from the events, with the hires and deliveries of the last snapshot.
  const parts = started && plan ? partViews(plan, snap.subtasks, events, { now, time: clockTime }, TERMINAL.has(task.status) || refundPending) : [];
  // A finished run's parts that delivered nothing: the header names them, and the next step is trying them again.
  const missing = final_result ? missingParts(final_result.abandoned, titles) : [];
  const questions = asking ? questionsOf(plan, task.error) : [];
  // Only the newest message's questions ask for an answer; an action in the world is never done on placeholders.
  const ask = asking ? askPrompt({ newest: !!onAnswer, action: plan?.action }) : null;

  // The message's own problem (not a task, a budget out of range): editing it is what helps, so that comes first.
  const aboutMessage = messageProblem(task.error);
  const failure = failedDraft(task.error);
  const editMessage = editable && !editing && (
    <ActionButton primary={aboutMessage || !resendable} onClick={openEditor} disabled={locked || redoing || !!busy} buttonRef={blockEditButton}>Edit message</ActionButton>
  );
  // The failure offers Edit message itself (the planner's sentence about the message, or every part dropped): the
  // bubble's Edit would be a second button of the same name beside it.
  const failureEdits = !!editMessage && ((task.status === 'failed' && !plan && aboutMessage) || (!!plan && !asking && !revealing && plan.subtasks.length === 0));
  const cost = plan ? planCost(plan) : null;

  return (
    <>
      {editing && onRedo
        ? <MessageEditor prompt={task.prompt} budget={usdc(task.budget_atomic)} saving={redoing} errors={editErrors} onSave={(p, b) => void saveEdit(p, b)} onCancel={closeEditor} />
        : <UserMessage prompt={task.prompt} budget={usdc(task.budget_atomic)} note={attemptNote(task)} onEdit={editable && !locked && !redoing && !busy && !failureEdits ? openEditor : undefined} editRef={editButton} />}

      {(task.status === 'draft' || (plan && !asking && (revealing || plan.subtasks.some((s) => s.candidates.length > 0)))) && (
        <RookMessage still={fresh}>
          <AgentSearch plan={plan} planning={planning} animate={fresh && planning.found.length === 0} onGrow={onGrow} onDone={revealing ? onAgentsDone : undefined} />
        </RookMessage>
      )}

      {/* Rook asks for facts only the user knows, as its own message: the composer below takes the answer. */}
      {asking && (
        <RookMessage>
          <p>{questions.length ? ASK_LEAD : 'Rook needs a few details from you before it plans this.'}</p>
          {questions.length > 0 && (
            <ul className="mt-2 space-y-1.5">{questions.map((q, i) => <li key={i} className="pl-4 -indent-3">• <InlineText text={q} /></li>)}</ul>
          )}
          {ask && <p className="mt-3 text-sm text-ink/65">{ask.line}</p>}
          {ask?.placeholders && onAnswer && (
            <div className="mt-3 flex flex-wrap gap-3">
              <ActionButton onClick={() => void answer(PLACEHOLDERS_ANSWER)} busy={answering} disabled={locked || redoing || editing}>{answering ? 'Sending…' : 'Use placeholders'}</ActionButton>
            </div>
          )}
        </RookMessage>
      )}

      {/* The planner's reply to the message is Rook's message; Rook's own trouble says it couldn't plan (failedDraft). */}
      {task.status === 'failed' && !plan && (
        <RookMessage>
          {failure.lead && <p>{failure.lead}</p>}
          {failure.text && <p className={failure.lead ? 'mt-1 text-sm text-ink/65' : 'whitespace-pre-wrap'}>{failure.text}</p>}
          {!editing && ((!failure.again && editMessage) || (failure.again && resendable)) && (
            <div className="mt-3 flex flex-wrap gap-3">
              {!failure.again && editMessage}
              {failure.again && resendable && <ActionButton primary onClick={() => void sendAgain()} busy={redoing} disabled={locked}>{redoing ? 'Sending…' : 'Send again'}</ActionButton>}
            </div>
          )}
          {againError && <p role="alert" className="mt-2 text-sm text-alert">{againError}</p>}
        </RookMessage>
      )}

      {/* Every part was dropped: the task ended there. Why, part by part (what an over-budget part's cheapest agent asks,
          and the budget that would hire it), in place of the orchestrator's one sentence for all; and what the plan
          took as given, which still matters for the next message. */}
      {plan && !asking && !revealing && plan.subtasks.length === 0 && (
        <RookMessage>
          {plan.dropped.length > 0 ? (
            <>
              <p>{emptyPlanLead(plan.dropped)}</p>
              <ul className="mt-2 space-y-1">{droppedLines(plan, mode?.max_budget_atomic).map((l, i) => <li key={i} className="pl-4 -indent-3">• {l}</li>)}</ul>
            </>
          ) : (
            <>
              <p>Rook couldn&apos;t draft a plan for this task.</p>
              {task.error && <p className="mt-1 text-sm text-ink/65">{task.error}</p>}
            </>
          )}
          <PlanFacts plan={plan} />
          {editMessage && <div className="mt-3 flex flex-wrap gap-3">{editMessage}</div>}
        </RookMessage>
      )}

      {plan && !revealing && plan.subtasks.length > 0 && (
        <RookMessage>
          {free ? (
            <p>
              Here&apos;s the plan. {allSelfDoWhy(plan.subtasks, budgetToHire(plan), mode?.max_budget_atomic)}{' '}
              Nothing is hired, so nothing is paid and nothing leaves your wallet.{task.status === 'cancelled' && (task.replaced_by ? ` ${REPLACED}` : ' You cancelled it.')}
            </p>
          ) : (
            <p>
              {/* The most it can cost once fallback agents are counted (planCost), not the reserve's size. */}
              Here&apos;s the plan. The caps add up to <span className="font-medium">{usdc(cost!.caps)} USDC</span>
              {cost!.most > cost!.caps
                ? <>. If an agent fails and Rook hires the next one, it can cost up to <span className="font-medium">{usdc(cost!.most)} USDC</span>, paid from the reserve</>
                : ', the most it can cost'}.{' '}
              {started ? 'You approved it.' : task.status === 'cancelled' ? (task.replaced_by ? REPLACED : 'You cancelled it, so nothing was spent.') : task.status === 'approved' ? 'You approved it. Nothing has been spent yet.' : task.status !== 'killed' ? 'Nothing has been spent.'
                : 'You stopped it before Rook started the run, so no agent was paid.'}
            </p>
          )}
          <PlanCard plan={plan} usage={usage} started={started} />
          <PlanFacts plan={plan} />
          {plan.dropped.length > 0 && (
            <div className="mt-3 text-sm text-ink/65">
              <p>Left out of this plan:</p>
              <ul className="mt-1 space-y-0.5">{droppedLines(plan, mode?.max_budget_atomic).map((l, i) => <li key={i} className="pl-4 -indent-3">• {l}</li>)}</ul>
            </div>
          )}
          {/* Why it can't be funded as it is: said in place of the funding button, never after the money moved. */}
          {blocked && task.status === 'planned' && <p role="alert" className="mt-3 text-alert">{blocked}</p>}
          {/* Stopped before Rook bound the wallet's transfer: whatever the feed shows, its USDC is the funder's to take back. */}
          {task.status === 'killed' && !ledger && snap.funding_sent && (
            <HeldFunding id={id} sent={snap.funding_sent} want={(funding && termsOf(funding)) ?? planTerms(task.budget_atomic, plan)}
              contractId={contractId} network={network} onChanged={refetch} />
          )}
          {task.status === 'planned' && (
            <div className="rook-in mt-4 flex flex-wrap gap-3" style={{ animationDelay: `${250 + plan.subtasks.length * 90}ms` }}>
              {!blocked && (
                <ActionButton primary onClick={() => act('approve')} busy={busy === 'approve'} disabled={!wallet.account || paymentsOff || !!funds.short || revised || redoing}
                  title={paymentsOff ? 'Paying live agents is not switched on yet' : !wallet.account ? 'Connect your wallet first' : funds.short ? 'Your wallet holds less USDC than this budget' : revised ? 'Wait for the revised plan below' : undefined}>
                  {busy === 'approve' ? (funds.checking ? 'Checking your USDC balance…' : chain && !free ? 'Preparing the transfer…' : 'Starting…') : free ? 'Start' : paymentsOff ? 'Approve' : noMoney ? 'Run simulation' : `Fund ${usdc(task.budget_atomic)} USDC and start`}
                </ActionButton>
              )}
              {funds.short && <ActionButton onClick={() => void funds.check()} busy={funds.checking}>{funds.checking ? 'Checking…' : 'Check again'}</ActionButton>}
              <ActionButton onClick={() => act('cancel')} busy={busy === 'cancel'} disabled={redoing}>Cancel</ActionButton>
            </div>
          )}
          {task.status === 'planned' && revised && <p className="mt-2 text-sm text-ink/60">Your newer message is revising this plan. Wait for the revised plan below.</p>}
          {task.status === 'planned' && !blocked && !free && !paymentsOff && noMoney && <p className="mt-2 text-sm text-ink/60">A simulated {usdc(task.budget_atomic)} USDC budget: nothing leaves your wallet and no agent is paid.</p>}
          {task.status === 'planned' && funds.short && <p role="alert" className="mt-2 text-sm text-alert">{funds.short}</p>}
          {task.status === 'planned' && !blocked && !free && !paymentsOff && !noMoney && !funds.short && <p className="mt-2 text-sm text-ink/60">One click: your wallet opens to send the {usdc(task.budget_atomic)} USDC budget to the Rook contract on NEAR {network}, and the run starts once it lands. Each subtask spends at most its cap plus what Rook tops up from the reserve, and whatever isn&apos;t spent comes back to you.</p>}
          {task.status === 'planned' && !free && paymentsOff && <p className="mt-2 text-sm text-ink/60">Live agents and prices. Paying them isn&apos;t switched on yet, so nothing can be spent.</p>}
        </RookMessage>
      )}

      {awaitingFunding && plan && (
        <RookMessage>
          {fundingConfirmed
            ? <Working label="Funding confirmed. Starting the run" />
            : <FundingStep id={id} plan={plan} budget={task.budget_atomic} funding={funding} trouble={fundingTrouble?.message ?? null} onRetry={fundingTrouble?.final ? null : () => setFundingTrouble(null)}
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
              <span className="font-medium">{runHeadline({ live, status: task.status, report: !!final_result, missing, parts: planned.length })}</span>
              {free ? ' Rook does every part itself, so nothing is spent.' : <>
                {' '}Spent {usdc(spent)} of {usdc(task.budget_atomic)} USDC{simNote}
                {reserveUsed > 0 && <span className="text-ink/65">, {usdc(reserveUsed)} from the reserve</span>}
              </>}
            </p>
            {!TERMINAL.has(task.status) && !refundPending && <ActionButton onClick={() => act('stop')} busy={busy === 'stop'} disabled={fundingBusy}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</ActionButton>}
          </div>
          <Activity lines={visible} live={live} caughtUp={caughtUp} closing={task.status === 'aggregating' || task.status === 'closing' || task.status === 'closed'}
            refunding={refundPending && !free} outcome={task.status === 'failed' && final_result ? 'closed' : task.status} timed={!!timed.current} free={free}
            current={nowLine(parts)} />
          {parts.length > 0 && <RunParts parts={parts} now={now} live={live} />}
        </RookMessage>
      )}

      {final_result && settled && (
        <RookMessage>
          <p className="font-medium">Here&apos;s your report.</p>
          {missing.length > 0 && (
            <div className="mt-1">
              <p className="text-alert">{missing.length === 1 ? `“${missing[0]}” wasn't delivered.` : `These parts weren't delivered: ${missing.map((t) => `“${t}”`).join(', ')}.`}</p>
              {onAnswer && (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <ActionButton onClick={() => void answer(retryMessage(missing))} busy={answering} disabled={locked || redoing}>
                    {answering ? 'Sending…' : missing.length === 1 ? 'Try this part again' : 'Try these parts again'}
                  </ActionButton>
                  <span className="text-sm text-ink/60">Rook plans it again first, so nothing is spent until you approve.</span>
                </div>
              )}
            </div>
          )}
          <Markdown markdown={final_result.final_markdown} />
          {/* The zip carries the chat's name (its first request), not this message's: QA got "make-the-accent-color-orange.zip" for a whole site. */}
          {!!final_result.files?.length && <ReportFiles files={final_result.files} titles={titles} name={chat ?? titles.get(final_result.files[0].subtask_id) ?? task.prompt}
            changed={final_result.changed} edit={planned.some((s) => !!s.inputs?.length)} />}

          {!free && <MoneyCard ledger={ledger} receipts={receipts} network={network} simNote={simNote} titles={titles} />}
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
              <Markdown markdown={d.text} />
            </section>
          ))}
        </RookMessage>
      )}

      {/* Stopped or failed without a report: still say where the money went, and what came back. */}
      {!final_result && settled && started && !free && (ledger || receipts.length > 0) && (
        <RookMessage><MoneyCard ledger={ledger} receipts={receipts} network={network} simNote={simNote} titles={titles} /></RookMessage>
      )}

      {actError && <p role="alert" className="rounded-2xl border border-alert/40 bg-alert/10 p-4 text-alert">{actError}</p>}
    </>
  );
}

// ---- the page's one conversation surface ----

type ThreadProps = Omit<Parameters<typeof Thread>[0], 'loaded'>;

/**
 * One task of the conversation, loaded and followed on its own. It tells the page what it learns (`onSummary`: status,
 * budget, parent, whether it got a plan), and when it has loaded (`onReady`). `hidden`: a message just sent still shows
 * as sent until then.
 */
function TaskThread({ account, hidden, onReady, onSummary, ...props }: ThreadProps & {
  account: string | null; hidden: boolean; onReady: (id: string) => void; onSummary: (id: string, t: TaskSummary | null) => void;
}) {
  const { id } = props;
  const loaded = useTask(id, account);
  const { snap, problem } = loaded;
  useEffect(() => { if (snap || problem) onReady(id); }, [snap, problem, id, onReady]);
  const t = snap?.task;
  const [status, prompt, created, parent, budget, supersedes] = [t?.status, t?.prompt, t?.created_at, t?.parent_id ?? null, t?.budget_atomic, t?.supersedes ?? null];
  const hasPlan = !!snap?.plan?.subtasks.length;
  const action = !!snap?.plan?.action; // the composer offers no placeholders for an action in the world
  // The parts a finished run didn't deliver, so the composer can offer to try them again.
  const titles = new Map((snap?.plan?.subtasks ?? []).map((s) => [s.id, s.title]));
  const missing = missingParts(snap?.final_result?.abandoned, titles).join('\n');
  // superseded_by is left to the list: a snapshot loaded before an edit in another tab would override it.
  useEffect(() => {
    if (status && prompt !== undefined && created) {
      onSummary(id, { id, status, prompt, created_at: created, parent_id: parent, budget_atomic: budget, has_plan: hasPlan, supersedes, ...(missing ? { missing: missing.split('\n') } : {}), ...(action ? { action } : {}) });
    }
  }, [id, status, prompt, created, parent, budget, hasPlan, supersedes, missing, action, onSummary]);
  useEffect(() => () => onSummary(id, null), [id, onSummary]);
  return hidden ? null : <Thread {...props} loaded={loaded} />;
}

/**
 * The sidebar's list, with what this page knows sooner: tasks it sent that the list doesn't have yet, and the live state
 * of the tasks it shows.
 */
function withKnown(tasks: TaskSummary[] | null, sent: TaskSummary[], live: Record<string, TaskSummary>): TaskSummary[] {
  const merged = new Map(sent.map((t) => [t.id, t]));
  for (const t of tasks ?? []) merged.set(t.id, t);
  for (const t of Object.values(live)) merged.set(t.id, { ...merged.get(t.id), ...t });
  return [...merged.values()];
}

/** Lives in the layout, so going from /app to /app/{id} changes what it shows without remounting anything. */
export function Chat({ tasks }: { tasks: TaskSummary[] | null }) {
  const pathname = usePathname();
  const wallet = useWallet();
  const parts = pathname.split('/').filter(Boolean); // ['app', id?]
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  // `note`: a message sent again or edited, shown as such. `redoing`: the newest message, being sent again or edited.
  const [sending, setSending] = useState<{ prompt: string; budget: string; id?: string; note?: string } | null>(null);
  const [redoing, setRedoing] = useState<string | null>(null);
  const [errors, setErrors] = useState<ComposerErrors | null>(null);
  const { chain } = useMode();
  const scroller = useRef<HTMLDivElement>(null);
  const ease = useEase();
  const justDrafted = useRef(new Set<string>());
  const onRevealed = useCallback((task: string) => { justDrafted.current.delete(task); }, []);

  // The conversation this page shows: every task of the one `id` is in, oldest first. Until the list has the task (just
  // sent, or the services were unreachable), the task alone, and whatever its own snapshot says it follows.
  const [sent, setSent] = useState<TaskSummary[]>([]);
  const [live, setLive] = useState<Record<string, TaskSummary>>({});
  const onSummary = useCallback((task: string, t: TaskSummary | null) => setLive((k) => {
    if (t) return JSON.stringify(k[task]) === JSON.stringify(t) ? k : { ...k, [task]: t };
    if (!(task in k)) return k;
    const { [task]: _gone, ...rest } = k;
    return rest;
  }), []);
  const known = withKnown(tasks, sent, live);
  // A link to a message that was sent again or edited shows the message in its place, which the address then names.
  const shownId = id ? shownInstead(known, id) : null;
  useEffect(() => { if (id && shownId && shownId !== id) window.history.replaceState(null, '', `/app/${shownId}`); }, [id, shownId]);
  const conversation = shownId ? conversationOf(shownTasks(known), shownId) : null;
  const ids = conversation ? conversation.tasks.map((t) => t.id) : shownId ? [shownId] : [];
  const revised = conversation ? revisedPlan(conversation.tasks) : null;
  // The newest message can be sent again or edited, unless what it acts on is planning or running.
  const newest = conversation?.latest.id ?? shownId;
  const redoBlocked = conversation ? redoWait(conversation.tasks, chain) : null;
  const thread: ComposerThread | null = shownId
    ? { parent: conversation?.latest.id ?? shownId, root: conversation?.tasks[0]?.id ?? shownId, current: conversation?.current ?? null, budget_atomic: conversation?.latest.budget_atomic }
    : null;
  const onReady = useCallback((task: string) => setSending((s) => (s?.id === task ? null : s)), []);

  const home = !id && !sending;
  const lenis = useSmoothScroll(scroller, !home);

  async function send(prompt: string, budget: string) {
    setErrors(null);
    setSending({ prompt: prompt.trim(), budget });
    const parent_id = thread?.parent;
    // Returns as soon as the task exists; the plan then streams in on the task's page. The call itself can fail (the
    // network, or the web server restarting): then the composer gets its text back and says so.
    const out = await draftTask({ prompt, budget, parent_id }).catch((e) => ({ kind: 'error' as const, message: pageUnreachable(e) }));
    if (out.kind === 'planned') {
      placed(out.id, prompt, budget, parent_id ?? null);
      setSending((s) => s && { ...s, id: out.id });
      return true;
    }
    setSending(null);
    setErrors(out.kind === 'invalid' ? { prompt: out.prompt, budget: out.budget } : { message: out.message });
    return false;
  }

  /**
   * A message just drafted. It shows as sent until its task has loaded, so the thread takes over with no gap, and the
   * conversation counts it at once, so the tasks above it stay on the page (and the one it supersedes leaves).
   */
  function placed(task: string, prompt: string, budget: string, parent_id: string | null, supersedes?: string) {
    justDrafted.current.add(task);
    const b = parseBudget(budget);
    setSent((s) => [...s, {
      id: task, status: 'draft', prompt: prompt.trim(), created_at: new Date().toISOString(), parent_id,
      ...(supersedes ? { supersedes } : {}), ...(b.ok ? { budget_atomic: b.atomic.toString() } : {}),
    }]);
    // Sent again or edited, it takes the old message's place in the same conversation, and so in the history: a new
    // entry would leave the old message's address behind it, which Back lands on only to be sent forward again.
    if (supersedes) window.history.replaceState(null, '', `/app/${task}`);
    else go(`/app/${task}`);
  }

  /** The newest message, sent again or edited: the new one takes its place once Rook has it. */
  const redo: Redo = async (old, prompt, budget) => {
    if (sending || redoing) return { message: 'Wait until the message being sent is in.' };
    setRedoing(old.id);
    setErrors(null);
    const out = await draftTask({ prompt, budget, supersedes: old.id }).catch((e) => ({ kind: 'error' as const, message: pageUnreachable(e) }));
    setRedoing(null);
    if (out.kind === 'invalid') return { prompt: out.prompt, budget: out.budget };
    if (out.kind === 'error') return { message: out.message };
    const b = parseBudget(budget);
    const edited = prompt.trim() !== old.prompt.trim() || !b.ok || b.atomic !== BigInt(old.budget_atomic);
    placed(out.id, prompt, budget, old.parent_id, old.id);
    setSending({ prompt: prompt.trim(), budget, id: out.id, note: edited ? 'Edited' : 'Sent again' });
    // Focus was on the editor or the Send again button, both gone now: on to the composer (not on a phone, where that
    // would open the keyboard over the plan being drafted).
    if (!window.matchMedia('(max-width: 639px)').matches) requestAnimationFrame(() => document.querySelector<HTMLElement>('textarea[name="prompt"]')?.focus());
    return null;
  };

  // A failed send's errors are about that send: not the next page, nor the next sign-in ("Sign in first" is wrong once
  // the owner signed in again). A sign-out keeps them: a send refused for a lapsed session signs the page out after the
  // error is set, and the "your sign-in has ended" message must stay to say why nothing was sent.
  useEffect(() => { setErrors(null); }, [id]);
  useEffect(() => { if (wallet.account) setErrors(null); }, [wallet.account]);

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
              <h1 className="sr-only">{conversation?.title ?? sending?.prompt ?? 'Task'}</h1>
              {/* Every task of the conversation, oldest first, each with its own plan, run and report. */}
              {ids.map((task) => (
                <TaskThread key={`${task}:${wallet.account}`} id={task} account={wallet.account} hidden={sending?.id === task} onReady={onReady} onSummary={onSummary}
                  tasks={tasks} onGrow={follow} fresh={justDrafted.current.has(task)} onRevealed={onRevealed} revised={revised === task}
                  onRedo={task === newest && !redoBlocked ? redo : undefined} redoing={redoing === task} locked={!!sending || (redoing !== null && redoing !== task)}
                  onAnswer={task === newest ? send : undefined} chat={conversation?.title} />
              ))}
              {sending && (
                <>
                  <UserMessage animate prompt={sending.prompt} budget={sending.budget} note={sending.note} />
                  <RookMessage><AgentSearch plan={null} animate={false} onGrow={follow} /></RookMessage>
                </>
              )}
            </div>
          </div>
        )}

        {/* Glides between the centre of the home screen and the bottom of a conversation. */}
        <motion.div layout="position" transition={ease} className={`mx-auto w-full max-w-208 md:px-8 px-2.5 pb-2.5 sm:px-5 ${home ? 'sm:mt-8 sm:pb-16' : 'sm:pb-5'}`}>
          <Composer onSend={send} errors={errors} sending={!!sending || !!redoing} compact={!home} thread={thread} />
        </motion.div>
      </div>
    </div>
  );
}
