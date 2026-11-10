// Task and subtask state machines and the hiring loop (docs/agentic-system.md sections 8.2 to 8.8).
// Agent messages and artifacts are data: they only go to the evaluator and the aggregator, never steer this loop.
// In chain mode a run survives a restart: restoreTask() rebuilds the books from the contract and runTask() resumes,
// skipping what is done and polling hires whose payment header was out; unwind() returns what a stopped task, or a
// closing one whose close failed, still holds, and keeps trying until the books close.
// Error events carry `message` (for logs and the CLI) and `kind`, which a client words for people: eval_retry,
// close_retry, unreachable_retry (retried); payment_lookup, receipt, paid_anyway, unpaid, aggregate, restore_note, rook_writes (notes); abandoned,
// unchecked, return, close, unwind, run, restore (problems). Agent-related ones name `agent_handle`.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { attach, cannedAggregate, agentOf, isMerged } from '../planner/canned.ts';
import { config } from '../shared/config.ts';
import { call } from '../shared/http.ts';
import { formatUsdc } from '../shared/money.ts';
import {
  TERMINAL, type A2AState, type A2ATask, type AcceptsRow, type AggregateResult, type Candidate, type Evaluation,
  type GatewayResult, type LlmCall, type Part, type TaskStatus, type X402Config,
} from '../shared/types.ts';
import { OtherContract, Unrebuildable, type ChainLedger } from './chain-ledger.ts';
import { LedgerError, type Ledger, type Recipient } from './ledger.ts';
import { emit, isFree, isTerminal, now, saveTask, setStatus, setSub, type Hire, type ReceiptView, type Sub, type Task } from './store.ts';

const gw = (path: string) => config.urls.marketGateway + path;
const msg = (e: any) => e?.message ?? String(e);
/** LLM calls a failed planner or evaluator request already paid for (they come back in its 502 body). */
const paidCalls = (e: any): LlmCall[] => e?.body?.details?.llm_calls ?? [];
const onChain = (l: Ledger): l is ChainLedger => 'bind' in l;
/** The abort reason of an orchestrator shutdown: a chain-mode run is left as it is, to be restored on the next start. */
export const SHUTDOWN = 'orchestrator shutting down';

// ---- global in-flight limit (section 8.6), shared by every task in this process ----
let inflight = 0;
const waiters = new Set<() => void>();
async function acquire(signal: AbortSignal) {
  while (inflight >= config.maxInflight) {
    await new Promise<void>((ok, fail) => {
      const wake = () => { signal.removeEventListener('abort', onAbort); waiters.delete(wake); ok(); };
      const onAbort = () => { waiters.delete(wake); fail(signal.reason); };
      if (signal.aborted) return fail(signal.reason);
      waiters.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  inflight++;
}
function release() {
  inflight--;
  const next = waiters.values().next().value;
  next?.();
}

/** Resolves with p, rejects when the signal aborts first. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((ok, fail) => {
    if (signal.aborted) return fail(signal.reason);
    const on = () => fail(signal.reason);
    signal.addEventListener('abort', on, { once: true });
    p.then(ok, fail).finally(() => signal.removeEventListener('abort', on));
  });
}

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => (resolve = ok));
  return { promise, resolve };
}

/** Runs one ledger call and emits its event. A synchronous ledger (sim) emits synchronously, so kill() stays atomic. */
function ledgerOp<T extends bigint | object>(t: Task, op: string, sub: Sub | null, fn: () => T | Promise<T>, extra: object = {}): Promise<T> {
  const record = (out: T) => {
    const amount = typeof out === 'bigint' ? out : (out as any).amount ?? null;
    // A release says whether the payment landed after all, so a client says "no charge" only when it did not.
    const settled = op === 'release' ? { settled: typeof out === 'object' && (out as any).settled === true } : {};
    emit(t, 'ledger', { op, ...(sub ? { n: sub.n } : {}), amount_atomic: amount, ...settled, ...extra }, sub?.id);
    return out;
  };
  const out = fn();
  return out instanceof Promise ? out.then(record) : Promise.resolve(record(out));
}

function cancelBestEffort(handle: string, id: string) {
  call(gw('/cancel'), { handle, id }).catch(() => {});
}
/** CancelTask and report whether the agent accepted it (only then is nothing chargeable any more). */
const cancelTask = (handle: string, id: string) => call<{ ok: boolean }>(gw('/cancel'), { handle, id }).then((r) => r?.ok === true, () => false);

const authorizedNow = (ledger: Ledger, t: Task, s: Sub) => ledger.view(t.id)?.subtasks.find((x) => x.n === s.n)?.authorized_atomic != null;
/** The hire the subtask's outstanding authorization was signed for, matched by payment_hash; null when no hire has it. */
function authHire(ledger: Ledger, t: Task, s: Sub): Hire | null {
  const ph = ledger.view(t.id)?.subtasks.find((x) => x.n === s.n)?.payment_hash;
  return ph ? s.hires.find((h) => h.payment_hash === ph) ?? null : null;
}

const ORDER: TaskStatus[] = ['draft', 'planned', 'approved', 'funded', 'running', 'aggregating', 'closing', 'closed'];
/** Forward only: a run resumed after a restart passes the steps it already took without repeating their events. */
const advance = (t: Task, to: TaskStatus) => { if (ORDER.indexOf(t.status) < ORDER.indexOf(to)) setStatus(t, to); };

// ---- task ----

/** Runs the task from approval to closed. Resumable: whatever the ledger and the subtasks already show done is skipped. */
export async function runTask(ledger: Ledger, t: Task) {
  const signal = t.abort.signal;
  const run = deferred();
  t.running = run.promise;
  try {
    // Books first (local in both modes): a failure from here on can always close the task and refund the funder.
    const held = isFree(t) ? 0n : BigInt(t.budget_atomic); // a plan that hires no agent holds nothing
    if (!ledger.view(t.id)) await ledgerOp(t, 'createTask', null, () => ledger.createTask(t.id, t.funder ?? '', held, t.reserve_share));
    const x402 = await call<X402Config>(gw('/x402'), undefined, { signal });
    signal.throwIfAborted();
    t.allow = x402.recipients ?? [];
    advance(t, 'funded');
    for (const s of t.subtasks) {
      if (s.self_do || ledger.view(t.id)!.subtasks.some((x) => x.n === s.n)) continue; // funded before a restart
      await ledgerOp(t, 'fundSubtask', s, () => ledger.fundSubtask(t.id, s.n, BigInt(s.cap_atomic)));
      setSub(t, s, 'funded');
    }
    advance(t, 'running');
    // A candidate being quoted when the services stopped has no hire: quote it again (quotes are free).
    for (const s of t.subtasks) if (!s.final_outcome && s.tried.length && !s.hires.some((h) => h.agent_handle === s.tried.at(-1))) s.tried.pop();

    // One subtask's error (planner /self-do down, evaluator unreachable, a ledger refusal) abandons that subtask
    // only; the others keep their paid work. Only an abort (kill, shutdown) stops the whole task. A leftover that
    // failed to go back stays unreturned: closeBooks tries it again.
    const done = new Map(t.subtasks.map((s) => [s.id, deferred()]));
    await Promise.allSettled(t.subtasks.map((s) => runSubtask(ledger, t, s, done).catch((e) => {
      if (signal.aborted) throw e;
      t.llm_calls.push(...paidCalls(e));
      if (s.final_outcome) { // finished: only its returnLeftover can have failed
        emit(t, 'error', { kind: 'return', message: `${s.id}: returning its leftover failed: ${msg(e)}` }, s.id);
        return;
      }
      emit(t, 'error', { kind: 'abandoned', message: `${s.id} abandoned: ${msg(e)}` }, s.id);
      finish(t, s, 'abandoned', done);
    })));
    signal.throwIfAborted();

    if (!t.final_result) { // written already when a restart came during the close
      advance(t, 'aggregating');
      const subtasks = t.subtasks.map((s) => ({
        id: s.id, title: s.title, status: s.final_outcome ?? s.status,
        agent_handle: s.accepted?.agent_handle, deliverable_text: s.accepted?.text,
      }));
      // In a conversation the aggregator reads the prompt with the messages before it ("make it shorter" changes them).
      const req = { task_id: t.id, prompt: t.prompt, ...(t.earlier_prompts?.length ? { earlier: t.earlier_prompts } : {}), subtasks };
      let agg: AggregateResult;
      try {
        agg = await call<AggregateResult>(config.urls.planner + '/aggregate', req, { signal });
      } catch (e) {
        // The deliverables are paid for and passed: fall back to the deterministic merge rather than lose them.
        signal.throwIfAborted();
        t.llm_calls.push(...paidCalls(e));
        emit(t, 'error', { kind: 'aggregate', message: `aggregate failed, using the deterministic merge: ${msg(e)}` });
        const attached = attach(subtasks); // the delivered files too: a web page an agent built stays a file
        agg = { final_markdown: cannedAggregate(req, attached), attribution: subtasks.filter(isMerged).map((s) => ({ subtask_id: s.id, agent_handle: agentOf(s) })), files: attached.files, llm_calls: [] };
      }
      signal.throwIfAborted();
      t.llm_calls.push(...(agg.llm_calls ?? []));
      // Stored before the close: the report is paid for, so a close that fails (or a restart) never loses it.
      t.final_result = {
        final_markdown: agg.final_markdown, attribution: agg.attribution ?? [], files: agg.files ?? [],
        abandoned: t.subtasks.filter((s) => s.final_outcome === 'abandoned').map((s) => s.id),
      };
      saveTask(t);
    }

    advance(t, 'closing');
    await closeBooks(ledger, t);
    closed(ledger, t);
  } catch (e) {
    if (t.status === 'killed') return; // kill() unwinds once this run has stopped
    if (onChain(ledger) && signal.reason?.message === SHUTDOWN) return; // left as it is: the next start restores and resumes it
    if (t.final_result) {
      // The report is written and kept: only returning the money failed. The task stays closing while the unwind keeps
      // trying, and ends closed once the books close; a shutdown leaves it closing, for the next start to resume.
      if (!signal.aborted) emit(t, 'error', { kind: 'close', message: msg(e) });
      await unwind(ledger, t, 'closing');
      if (ledger.view(t.id)?.closed) closed(ledger, t);
      return;
    }
    t.error = msg(e);
    emit(t, 'error', { kind: 'run', message: t.error });
    setStatus(t, 'failed');
    await unwind(ledger, t, 'salvage');
  } finally {
    run.resolve();
  }
}

/** The books are closed: the run ends with its report and what it spent and refunded. */
function closed(ledger: Ledger, t: Task) {
  const v = ledger.view(t.id)!;
  // The files (up to 3 MB) stay out of the event, which every reconnect replays and the task doc keeps: a client
  // reads them from the snapshot, as it does the report.
  const { files: _, ...result } = t.final_result!;
  emit(t, 'final', { ...result, spent_atomic: v.spent_atomic, refunded_atomic: v.refunded_atomic, reserve_used_atomic: v.reserve_used_atomic });
  setStatus(t, 'closed');
}

const CLOSE_TRIES = 5;

/**
 * Returns what a subtask still holds (its return failed during the run) and closes the task, so the contract refunds
 * the funder. Retried a few times at once: a chain call can fail for a moment (seen on mainnet: send_tx
 * INVALID_TRANSACTION). Past that, or with an authorization still outstanding, it throws and the unwind takes over.
 */
async function closeBooks(ledger: Ledger, t: Task): Promise<void> {
  const signal = t.abort.signal;
  for (let attempt = 1; ; attempt++) {
    try {
      const v = ledger.view(t.id)!;
      if (v.closed) return; // closed already when the services stopped right after close_task
      for (const s of t.subtasks) {
        if (s.self_do || v.subtasks.find((x) => x.n === s.n)?.returned_atomic !== null) continue;
        await ledgerOp(t, 'returnLeftover', s, () => ledger.returnLeftover(t.id, s.n));
        setSub(t, s, 'returned');
      }
      await ledgerOp(t, 'closeTask', null, () => ledger.closeTask(t.id));
      return;
    } catch (e) {
      signal.throwIfAborted();
      if (attempt >= CLOSE_TRIES || t.subtasks.some((s) => authorizedNow(ledger, t, s))) throw e;
      emit(t, 'error', { kind: 'close_retry', message: `closing, attempt ${attempt} failed, retrying: ${msg(e)}` });
      await sleep(Math.min(config.pollMs, 2000) * attempt, undefined, { signal });
    }
  }
}

/** How a stopped hire's authorization can be cleared: `terminal` when its A2A task ended unpaid or took CancelTask. */
async function unpaidHow(hire: Hire | null): Promise<'terminal' | 'wait' | 'void'> {
  if (!hire?.a2a_task_id) return 'void'; // the header may have reached the agent, but no deliverable can come back
  const r = await call<GatewayResult<{ task: A2ATask }>>(gw(`/task?handle=${encodeURIComponent(hire.agent_handle)}&id=${encodeURIComponent(hire.a2a_task_id)}`)).catch(() => null);
  const state = r?.ok ? r.task.state : null;
  if (state === 'REJECTED' || state === 'FAILED' || state === 'CANCELED') return 'terminal';
  if (state === 'COMPLETED') return 'wait'; // delivered: its payment settles, so wait for it to land
  // Stopped, and the agent refused CancelTask: its window may be a day, so Rook voids the payment rather than wait it out.
  return (await cancelTask(hire.agent_handle, hire.a2a_task_id)) ? 'terminal' : 'void';
}

/** The longest the unwind (or a restore) waits before it tries a failed step again. */
const UNWIND_MAX_WAIT_MS = 5 * 60_000;
/** The wait before try `round + 1` of a step that failed: doubling from the poll interval, at most UNWIND_MAX_WAIT_MS. */
const backoff = (round: number) => Math.min(Math.min(config.pollMs, 2000) * 2 ** (round - 1), UNWIND_MAX_WAIT_MS);

/**
 * Returns what a stopped task (killed, failed, or found stopped after a restart) or a closing one whose close failed
 * still holds: clears each outstanding authorization (at once when the agent's task ended unpaid, else once it landed
 * or expired; a payment that landed gets booked with a receipt), returns every funded sub-account (/return, or
 * mark_empty at 0), then closes the task so the contract refunds the funder. Each sub-account clears and returns on its
 * own, so one authorization that runs for hours holds back only its own money; the close waits for all. A step that
 * fails is tried again, waiting longer each time (at most UNWIND_MAX_WAIT_MS), until the books close: on mainnet
 * send_tx failed with INVALID_TRANSACTION for minutes. Only a shutdown stops it, and the next start resumes it. Each
 * problem is reported once. Its events record after the terminal status. `afterRun`: wait for the run's loops (a kill
 * aborts their waits for the chain, so that is quick).
 */
export async function unwind(ledger: Ledger, t: Task, why: string, afterRun = false): Promise<void> {
  if (t.unwinding) return t.unwinding;
  const p = (async () => {
    await (afterRun ? t.running?.catch(() => {}) : null);
    if (!ledger.view(t.id)) return;
    t.salvaging = true;
    const stop = t.shutdown.signal;
    const said = new Map<string, string>(); // each step's last reported problem
    const step = async (op: string, s: Sub | null, fn: () => bigint | object | Promise<bigint | object>) => {
      try { return await ledgerOp(t, op, s, fn); } catch (e) { // a sim ledger refuses synchronously, so not .catch
        if (stop.aborted) return null; // cut short by a shutdown: the next start resumes it
        const key = `${op} ${s?.id ?? ''}`, message = `${why}, ${op}${s ? ` ${s.id}` : ''}: ${msg(e)}`;
        if (said.get(key) !== message) emit(t, 'error', { kind: 'unwind', op, message }, s?.id);
        said.set(key, message);
        return null;
      }
    };
    const chain = onChain(ledger);
    const clearing = new Set<number>(); // subtasks whose clearing was reported
    for (const f of t.inflight.values()) { f.hire.state = t.status === 'killed' ? 'KILLED' : 'CANCELED'; f.hire.ended_at ??= now(); }
    t.inflight.clear();
    for (let round = 1; ; round++) {
      await Promise.all(t.subtasks.map(async (s) => {
        if (authorizedNow(ledger, t, s)) {
          const hire = authHire(ledger, t, s); // never an older hire: its A2A state says nothing about this authorization
          // The run stopped while this hire's send outcome was still being waited on (a kill cuts that wait short).
          if (hire && !hire.ended_at) { hire.state = t.status === 'killed' ? 'KILLED' : 'CANCELED'; hire.ended_at = now(); }
          if (!chain && hire?.a2a_task_id) cancelBestEffort(hire.agent_handle, hire.a2a_task_id);
          const how = chain ? await unpaidHow(hire) : 'now';
          if (chain && !clearing.has(s.n)) {
            clearing.add(s.n);
            emit(t, 'ledger', { op: 'clearing', n: s.n, how, agent_handle: hire?.agent_handle ?? null, expires_at: hire?.expires_at ?? null }, s.id);
          }
          const r = await step('release', s, () => ledger.release(t.id, s.n, how, stop));
          if (r && typeof r === 'object' && 'settled' in r && hire) { // it landed anyway: paid, so it gets a receipt
            hire.paid = true; hire.state = 'OUTCOME_UNKNOWN'; hire.ended_at ??= now();
            if (!t.receipts.some((x) => x.hire_id === hire.id)) await writeReceipt(ledger, t, s, hire, null);
          }
          if (authorizedNow(ledger, t, s)) return; // not cleared yet: nothing of this sub-account can go back
        }
        if (s.self_do || ledger.view(t.id)!.subtasks.find((x) => x.n === s.n)?.returned_atomic !== null) return;
        if ((await step('returnLeftover', s, () => ledger.returnLeftover(t.id, s.n))) !== null) setSub(t, s, 'returned');
      }));
      const v = ledger.view(t.id)!;
      if (!v.closed && v.subtasks.every((x) => x.returned_atomic !== null)) await step('closeTask', null, () => ledger.closeTask(t.id));
      if (ledger.view(t.id)!.closed || stop.aborted) return;
      await sleep(backoff(round), undefined, { signal: stop }).catch(() => {});
      if (stop.aborted) return;
    }
  })();
  t.unwinding = p;
  try { await p; } finally { t.salvaging = false; if (t.unwinding === p) t.unwinding = undefined; }
}

/**
 * Kill switch (section 8.7). Synchronous, so no loop can emit between the ledger kill and the killed status. The funds
 * then come back (unwind). The contract's own kill_task is the funder's call: the CLI's /kill answer prints it.
 */
export function kill(ledger: Ledger, t: Task) {
  ledger.kill(t.id);
  const chain = onChain(ledger) && contractTaskOf(ledger, t) !== null;
  // `returning`: money is on chain for this task, and the unwind sends it back to the funder.
  emit(t, 'ledger', { op: 'kill', ...(chain ? { returning: true } : {}) });
  t.abort.abort();
  const sending = new Set<number>();
  for (const f of t.inflight.values()) {
    // A /send still in flight has its payment header out: its hire1 waits for the answer and cancels.
    if (!f.a2a_task_id) { sending.add(f.subtask.n); continue; }
    cancelBestEffort(f.handle, f.a2a_task_id); f.hire.state = 'KILLED'; f.hire.ended_at = now();
  }
  t.inflight.clear();
  if (!onChain(ledger)) {
    for (const v of ledger.view(t.id)?.subtasks ?? []) {
      if (v.authorized_atomic === null || sending.has(v.n)) continue;
      const s = t.subtasks.find((x) => x.n === v.n) ?? null;
      ledgerOp(t, 'release', s, () => ledger.release(t.id, v.n, 'now')).catch((e) => console.error('[orchestrator] kill release', e));
    }
  }
  setStatus(t, 'killed');
  // In every mode: the sim ledger's books close too, so a stopped run shows its refund (no books: nothing to do).
  void unwind(ledger, t, 'after kill', true).catch((e) => console.error('[orchestrator] unwind after kill', e));
}

/**
 * The contract task that holds `t`'s money: the one it is bound to, or, while a restart's rebuild of its books is
 * being tried again (t.restoring), the one it was bound to before the restart. Null: none.
 */
export function contractTaskOf(ledger: ChainLedger, t: Task): string | null {
  return ledger.contractTaskOf(t.id) ?? (t.restoring && t.chain ? t.chain.contract_task_id : null);
}

type Step2 = (() => Promise<void>) | null;

/**
 * Restart, chain mode, step 1 (before the API listens): rebuild Rook's books for `t` from the contract. Returns step 2,
 * which finishes it: resume the run, or unwind what a killed or failed task still holds. Null: nothing left to do, the
 * task is another contract's, or its contract task's numbers don't fit Rook's books. A rebuild that fails (the chain
 * gateway or NEAR not answering, a transfer still in flight) is tried again in step 2, once the API listens, waiting
 * longer each time as the unwind does, until it works; only a shutdown stops it, and the next start tries again. Each
 * problem is reported once. Meanwhile the task is `restoring`: a Stop says its money comes back, and its event stream
 * stays open until it has.
 */
export async function restoreTask(ledger: ChainLedger, t: Task): Promise<Step2> {
  const said = { last: '' };
  const first = await rebuild(ledger, t, said);
  if (first !== 'again') return first;
  t.restoring = true;
  return async () => {
    const stop = t.shutdown.signal;
    try {
      for (let round = 1; ; round++) {
        await sleep(backoff(round), undefined, { signal: stop }).catch(() => {});
        if (stop.aborted) return;
        const next = await rebuild(ledger, t, said);
        if (stop.aborted) return; // rebuilt as the services stop: the next start resumes it
        if (next !== 'again') return next?.();
      }
    } finally { t.restoring = false; }
  };
}

/** One try at step 1: step 2, or 'again' when the rebuild failed for a reason that can pass. */
async function rebuild(ledger: ChainLedger, t: Task, said: { last: string }): Promise<Step2 | 'again'> {
  const cid = t.chain!.contract_task_id;
  let r: Awaited<ReturnType<ChainLedger['restore']>>;
  try {
    r = await ledger.restore(t.id, t.chain!, { funder: t.funder ?? '', budget: BigInt(t.budget_atomic), reserve_share: t.reserve_share, saved: t.ledger_saved });
  } catch (e) {
    const other = e instanceof OtherContract, misfit = e instanceof Unrebuildable;
    // Never bound here, so nothing of it moves: cleared before the event, which then ends its stream.
    if (other || misfit) Object.assign(t, { restoring: false, stranded: other ? 'other_contract' : 'misfit' });
    const next = other ? 'It is left as it is, for a Rook that runs that contract.'
      : misfit ? "Every try would fail the same way, so it is left as it is for Rook's operator."
      : 'Rook tries again, waiting longer each time.';
    const message = `after a restart Rook could not rebuild contract task ${cid}: ${msg(e)}. ${next}`;
    if (message !== said.last) emit(t, 'error', { kind: 'restore', message }, undefined, true);
    said.last = message;
    return other || misfit ? null : 'again';
  }
  // Rebuilt and bound: from here its books say whether money moves. A rebuild tried again ran while the API listened,
  // so a page may be following the task (stopped meanwhile, say): it hears the books are back.
  const followed = t.restoring === true;
  t.restoring = false;
  for (const note of r.notes) emit(t, 'error', { kind: 'restore_note', message: `restore: ${note}` }, undefined, true);
  if (isTerminal(t.status)) {
    if (followed) emit(t, 'ledger', { op: 'restored', contract_task_id: cid, contract_status: r.status }, undefined, true);
    // Closed on chain with Rook's books still open: the funder or the owner closed a killed task while sub-accounts
    // were still Funded. Returns still reach a Closed task and Rook's close_task refunds them, so it is unwound like any other.
    return r.status === 'Closed' && ledger.view(t.id)?.closed ? null : () => unwind(ledger, t, 'after restart');
  }
  emit(t, 'ledger', { op: 'restored', contract_task_id: cid, contract_status: r.status });
  if (r.deleted) {
    // The funder took the whole budget back before Rook funded any subtask: there is nothing to run or to return.
    emit(t, 'ledger', { op: 'refunded_before_run', contract_task_id: cid, note: `contract task ${cid} was refunded to its funder and deleted before Rook funded any subtask, so the run does not start` });
    setStatus(t, 'cancelled');
    return null;
  }
  // The owner killed it on the contract meanwhile. Once the report is written the work is done and paid for: the run
  // resumes to finish the close (the contract still takes the returns and close_task), and the task ends closed.
  if (r.killed && !t.final_result) return async () => kill(ledger, t);
  return () => runTask(ledger, t);
}

// ---- subtask ----

async function runSubtask(ledger: Ledger, t: Task, s: Sub, done: Map<string, Deferred>) {
  if (s.final_outcome) done.get(s.id)!.resolve(); // finished before a restart
  else if (s.self_do) await selfDo(t, s, done);
  else await hireLoop(ledger, t, s, done);
  if (!s.self_do && ledger.view(t.id)?.subtasks.find((x) => x.n === s.n)?.returned_atomic === null) {
    await ledgerOp(t, 'returnLeftover', s, () => ledger.returnLeftover(t.id, s.n));
  }
  setSub(t, s, 'returned');
}

function finish(t: Task, s: Sub, outcome: 'passed' | 'abandoned', done: Map<string, Deferred>) {
  s.final_outcome = outcome;
  setSub(t, s, outcome);
  done.get(s.id)!.resolve();
}

/** A failed verdict counts as a re-hire; returns true when the subtask must be abandoned. */
function failedVerdict(s: Sub) {
  s.rehire_count++;
  return s.rehire_count > config.maxRehires;
}

/** Every paid hire gets a receipt (8.8); verdict and attestation are null when it was never judged. */
async function writeReceipt(ledger: Ledger, t: Task, s: Sub, hire: Hire, ev: Evaluation | null) {
  hire.verdict = ev?.verdict ?? null;
  const receipt: ReceiptView = {
    id: `rc_${randomUUID().slice(0, 8)}`, task_id: t.id, subtask_id: s.id, hire_id: hire.id, agent_handle: hire.agent_handle,
    a2a_task_id: hire.a2a_task_id, amount_atomic: hire.paid ? hire.amount_atomic : '0', verdict: hire.verdict,
    attestation_hash: ev?.attestation_hash ?? null, payment_hash: hire.payment_hash, payment_tx: null, receipt_tx: null,
    payment_explorer_url: null, receipt_explorer_url: null,
  };
  t.receipts.push(receipt);
  if (onChain(ledger)) { // record_receipt on the contract fills receipt_tx; the payment's tx comes from the indexer later
    try { Object.assign(receipt, await ledger.recordReceipt(t.id, s.n, receipt)); } catch (e) { emit(t, 'error', { kind: 'receipt', agent_handle: hire.agent_handle, message: `receipt on chain: ${msg(e)}` }, s.id); }
    if (hire.paid && hire.pay_to) void findPayment(ledger, t, s, hire, receipt);
  }
  emit(t, 'receipt', receipt, s.id);
}

/** Fills payment_tx once the indexer shows the transfer (it lags); the hire was already booked from the balance. */
async function findPayment(ledger: ChainLedger, t: Task, s: Sub, hire: Hire, receipt: ReceiptView) {
  try {
    // Every paid hire of a subtask pays the same treasury from the same sub-account, one at a time: this hire's transfer
    // is the one after its earlier paid hires' transfers, so a re-hire at the same price never gets another's.
    const index = s.hires.slice(0, s.hires.indexOf(hire)).filter((h) => h.paid && h.pay_to === hire.pay_to).length;
    const found = await ledger.paymentTx(t.id, s.n, { amount_atomic: receipt.amount_atomic, pay_to: hire.pay_to!, after: hire.started_at, index });
    if (found) {
      Object.assign(receipt, found);
      emit(t, 'ledger', { op: 'payment_found', receipt_id: receipt.id, agent_handle: hire.agent_handle, ...found }, s.id, true);
    } else {
      emit(t, 'error', { kind: 'payment_lookup', agent_handle: hire.agent_handle, message: `${hire.agent_handle}: the indexer does not show the payment transaction yet; the balance already showed the payment, so the receipt stands without payment_tx` }, s.id, true);
    }
  } catch (e) { emit(t, 'error', { kind: 'payment_lookup', agent_handle: hire.agent_handle, message: `payment lookup for ${hire.agent_handle}: ${msg(e)}` }, s.id, true); }
}

/**
 * After a restart: the subtask's last hire when it was paid but still needs its verdict or receipt, else the hire whose
 * authorization is still outstanding (by payment_hash: an older unpaid hire never stands in for it).
 */
function unfinished(ledger: Ledger, t: Task, s: Sub): Hire | null {
  const h = s.hires.at(-1);
  if (h?.paid && !t.receipts.some((r) => r.hire_id === h.id)) return h;
  return authorizedNow(ledger, t, s) ? authHire(ledger, t, s) : null;
}

async function hireLoop(ledger: Ledger, t: Task, s: Sub, done: Map<string, Deferred>) {
  const signal = t.abort.signal;
  const last = s.hires.at(-1), judged = last && t.receipts.find((r) => r.hire_id === last.id);
  if (judged?.verdict === 'pass') { // passed just before a restart
    s.accepted = { hire_id: last!.id, agent_handle: last!.agent_handle, text: last!.deliverable_text ?? '' };
    return finish(t, s, 'passed', done);
  }
  let pending = unfinished(ledger, t, s);
  if (!pending && authorizedNow(ledger, t, s)) {
    // An authorization with no saved hire (stored before hires were saved ahead of /send): nothing else is signed for
    // this subtask until it lands or expires. Its agent and deliverable are unknown, so a landed payment only counts as spent.
    const r = await ledgerOp(t, 'release', s, () => ledger.release(t.id, s.n, 'void', signal));
    if (typeof r === 'object' && r.settled) emit(t, 'error', { kind: 'paid_anyway', message: 'a payment authorized before the restart, for a hire Rook has no record of, landed on chain; counted as spent' }, s.id);
  }
  for (;;) {
    signal.throwIfAborted();
    let hire: Hire | null;
    if (pending) {
      const h = pending;
      pending = null;
      hire = h.paid ? h : await resumeHire(ledger, t, s, h);
    } else {
      // The plan's order (lowest expected cost first, docs 5.2 step 4), never re-sorted by price here.
      const c = s.candidates.find((x) => !s.tried.includes(x.handle)) ?? await unreachableAgain(t, s);
      if (!c) return giveUp(t, s, done);
      if (!s.tried.includes(c.handle)) s.tried.push(c.handle);
      setSub(t, s, 'quoting');
      const row = await quote(ledger, t, s, c);
      if (!row) continue;
      hire = await hire1(ledger, t, s, c, row);
    }
    if (!hire) continue;
    if (hire.state === 'OUTCOME_UNKNOWN') { // counted as spent, nothing to judge; counts against the re-hire limit
      await writeReceipt(ledger, t, s, hire, null);
      if (failedVerdict(s)) return giveUp(t, s, done);
      continue;
    }

    let ev: Evaluation;
    try {
      ev = await evaluate(t, s, hire.deliverable_text ?? '', hire.parts, hire.id, hire.agent_handle, done);
    } catch (e) {
      await writeReceipt(ledger, t, s, hire, null); // paid even though the evaluation never finished (kill, evaluator outage)
      if (signal.aborted) throw e;
      // Rook's own outage is not the agent's failure: no verdict, no re-hire spend against a broken evaluator.
      emit(t, 'error', { kind: 'unchecked', agent_handle: hire.agent_handle, message: `evaluation of ${hire.agent_handle} failed, subtask abandoned unjudged: ${msg(e)}` }, s.id);
      return finish(t, s, 'abandoned', done);
    }
    await writeReceipt(ledger, t, s, hire, ev);
    if (ev.verdict === 'pass') {
      s.accepted = { hire_id: hire.id, agent_handle: hire.agent_handle, text: hire.deliverable_text ?? '' };
      return finish(t, s, 'passed', done);
    }
    if (failedVerdict(s)) return giveUp(t, s, done);
  }
}

/**
 * -32603 on a paid send is the market's "no reachable backend right now, retry in a few minutes" (its x402 caller
 * skill). Once every other candidate is tried, such an agent is asked again, once, after ROOK_UNREACHABLE_RETRY_S: on
 * mainnet the only affordable agent of a part answered it and the part was lost, though the agent was fine later.
 */
async function unreachableAgain(t: Task, s: Sub): Promise<Candidate | undefined> {
  const c = s.candidates.find((x) => s.unreachable?.includes(x.handle) && !s.retried?.includes(x.handle));
  if (!c) return undefined;
  (s.retried ??= []).push(c.handle);
  saveTask(t);
  emit(t, 'error', { kind: 'unreachable_retry', agent_handle: c.handle, message: `${c.handle} had no reachable backend; asking it again in ${config.unreachableRetryS} s` }, s.id);
  await sleep(config.unreachableRetryS * 1000, undefined, { signal: t.abort.signal });
  return c;
}

/**
 * No hired agent delivered work that passed (none could be hired, or the re-hire limit was reached). A part Rook may
 * write itself (self_do_ok) is written by Rook, at least once, rather than left out of the report: on mainnet a market
 * error on the only affordable agent left a one-part task with an empty report. Its cap still goes back as unspent.
 */
function giveUp(t: Task, s: Sub, done: Map<string, Deferred>) {
  if (!s.self_do_ok || t.abort.signal.aborted) return finish(t, s, 'abandoned', done);
  emit(t, 'error', { kind: 'rook_writes', message: `${s.id}: no hired agent delivered, Rook writes it itself` }, s.id);
  return selfDo(t, s, done);
}

function rejectQuote(t: Task, s: Sub, handle: string, reason: string) {
  emit(t, 'quote_rejected', { agent_handle: handle, reason }, s.id);
}

function checkQuote(row: AcceptsRow, allow: Recipient[]): { reason: string; alert?: boolean } | null {
  if (row.scheme !== 'exact') return { reason: `scheme ${row.scheme} is not exact` };
  const rows = allow.filter((r) => r.network === row.network && r.asset === row.asset);
  if (!rows.length) return { reason: `network ${row.network} / asset ${row.asset} not accepted by the marketplace` };
  if (!rows.some((r) => r.payTo === row.payTo)) return { reason: `payTo ${row.payTo} is not the marketplace treasury`, alert: true };
  if (!/^\d+$/.test(row.amount) || BigInt(row.amount) <= 0n) return { reason: `invalid amount ${row.amount}` };
  const ttl = row.maxTimeoutSeconds;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > config.maxPaymentTimeoutS) return { reason: `maxTimeoutSeconds ${ttl} is not an integer from 1 to ${config.maxPaymentTimeoutS}` };
  return null;
}

/** Re-quote right before paying, run the checks of section 8.4, top up from the reserve when short. */
async function quote(ledger: Ledger, t: Task, s: Sub, c: Candidate): Promise<AcceptsRow | null> {
  const signal = t.abort.signal;
  let r: GatewayResult<{ row: AcceptsRow }>;
  try {
    r = await call(gw('/quote'), { handle: c.handle }, { signal });
  } catch (e) {
    signal.throwIfAborted();
    rejectQuote(t, s, c.handle, `quote failed: ${msg(e)}`);
    return null;
  }
  signal.throwIfAborted();
  if (!r.ok) { rejectQuote(t, s, c.handle, `quote failed: ${r.error.code} ${r.error.message}`); return null; }
  const row = r.row;
  emit(t, 'quote', { agent_handle: c.handle, amount_atomic: row.amount, planned_atomic: c.price_atomic, network: row.network, asset: row.asset, payTo: row.payTo }, s.id);

  const bad = checkQuote(row, t.allow);
  if (bad) {
    if (bad.alert) emit(t, 'security_alert', { source: 'quote', agent_handle: c.handle, flag: bad.reason }, s.id);
    rejectQuote(t, s, c.handle, bad.reason);
    return null;
  }
  const amount = BigInt(row.amount);
  // The user approved the plan's prices: an agent that raised its price since then is skipped, never topped up.
  if (amount > BigInt(c.price_atomic)) {
    rejectQuote(t, s, c.handle, `price rose from ${formatUsdc(c.price_atomic)} in the approved plan to ${formatUsdc(amount)}`);
    return null;
  }
  const v = ledger.view(t.id)!;
  const balance = v.subtasks.find((x) => x.n === s.n)!.balance_atomic;
  if (amount > balance) {
    const short = amount - balance;
    if (short > v.reserve_remaining_atomic) {
      rejectQuote(t, s, c.handle, `price ${formatUsdc(amount)} exceeds balance ${formatUsdc(balance)} and the reserve cannot cover the ${formatUsdc(short)} top-up`);
      return null;
    }
    try {
      // ponytail: the top-up happens before the hire; if that hire is then skipped unpaid, the money waits in this
      // subtask's balance until returnLeftover instead of going back to the shared reserve.
      await ledgerOp(t, 'topUp', s, () => ledger.topUp(t.id, s.n, short), { agent_handle: c.handle });
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      signal.throwIfAborted();
      rejectQuote(t, s, c.handle, `top-up refused: ${e.reason}`);
      return null;
    }
  }
  return row;
}

/**
 * Ends the hire unpaid; true when the chain shows the payment landed anyway, and then it counts as paid. A kill stops
 * the wait for the chain (the run's signal): unwind then clears that authorization on its own.
 */
async function endUnpaid(ledger: Ledger, t: Task, s: Sub, hire: Hire, how: 'terminal' | 'wait' | 'void') {
  const r = await ledgerOp(t, 'release', s, async () => {
    const out = await ledger.release(t.id, s.n, how, t.abort.signal);
    if (typeof out === 'object' && out.settled) { hire.paid = true; hire.state = 'OUTCOME_UNKNOWN'; hire.ended_at = now(); }
    return out;
  }, { agent_handle: hire.agent_handle });
  if (typeof r !== 'object' || !r.settled) return false;
  emit(t, 'error', { kind: 'paid_anyway', agent_handle: hire.agent_handle, message: `${hire.agent_handle}: the payment landed on chain although the hire ended unpaid; counted as spent` }, s.id);
  return true;
}

/**
 * Authorize, send, poll. Returns the hire when COMPLETED and settled (or settled with an unknown outcome);
 * null when the agent was skipped without charge.
 */
async function hire1(ledger: Ledger, t: Task, s: Sub, c: Candidate, row: AcceptsRow): Promise<Hire | null> {
  const signal = t.abort.signal;
  await acquire(signal);
  try {
    let auth: { header: string; payment_hash: string; amount: bigint };
    try {
      auth = await ledgerOp(t, 'authorize', s, () => ledger.authorize(t.id, s.n, row, t.allow), { agent_handle: c.handle });
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      signal.throwIfAborted();
      rejectQuote(t, s, c.handle, `authorization refused: ${e.reason}`);
      return null;
    }
    if (signal.aborted) { // only an async (chain) signer lets an abort land here; the header never left Rook
      await ledgerOp(t, 'release', s, () => ledger.release(t.id, s.n, 'terminal'), { agent_handle: c.handle });
      throw signal.reason;
    }
    const hire: Hire = {
      id: `h_${randomUUID().slice(0, 8)}`, subtask_id: s.id, agent_handle: c.handle, amount_atomic: auth.amount.toString(),
      payment_hash: auth.payment_hash, a2a_task_id: null, context_id: null, state: 'SENDING', paid: false,
      deliverable_text: null, parts: [], verdict: null, started_at: now(), ended_at: null,
      pay_to: row.payTo, expires_at: new Date(Date.now() + row.maxTimeoutSeconds * 1000).toISOString(),
    };
    s.hires.push(hire);

    // No abort signal on /send: once the request leaves, the payment header is out. Waiting for the answer lets a
    // kill still learn the task id, cancel it and record how the payment ended (kill() leaves this one to us).
    t.inflight.set(hire.id, { subtask: s, hire, handle: c.handle, a2a_task_id: null });
    // Stored before the header leaves: a restart while /send is out resumes this hire (and settles or waits out its
    // payment) instead of finding an authorization with no hire behind it.
    saveTask(t);
    let sent: GatewayResult<{ task: A2ATask }>;
    try {
      sent = await call(gw('/send'), { handle: c.handle, text: s.brief, payment: auth.header });
    } catch (e) {
      sent = { ok: false, error: { code: 'network', message: msg(e) } };
    }
    t.inflight.delete(hire.id);
    if (signal.aborted) {
      if (sent.ok) { hire.a2a_task_id = sent.task.id; hire.context_id = sent.task.context_id; cancelBestEffort(c.handle, sent.task.id); }
      hire.state = t.status === 'killed' ? 'KILLED' : 'CANCELED'; hire.ended_at = now();
      // sim: released in Rook's books at once. chain: unwind clears it once it can no longer settle.
      if (!onChain(ledger) && authorizedNow(ledger, t, s)) await ledgerOp(t, 'release', s, () => ledger.release(t.id, s.n, 'now'), { agent_handle: c.handle });
      throw signal.reason;
    }
    if (!sent.ok && sent.error.code === 'outcome_unknown') {
      // The gateway saw a 502 and cannot tell whether the payment settled: never release it as unpaid. In chain mode
      // Rook voids it (no task id came back, so no deliverable can): paid only when the payment landed first.
      const paid = await ledgerOp(t, 'settle', s, async () => {
        const r = onChain(ledger) ? await ledger.release(t.id, s.n, 'void', signal) : null;
        const a = r === null ? await ledger.settle(t.id, s.n, signal) : typeof r === 'object' && r.settled ? r.amount : 0n;
        if (a > 0n) { hire.paid = true; hire.state = 'OUTCOME_UNKNOWN'; } else hire.state = 'SEND_FAILED';
        hire.ended_at = now();
        return a;
      }, { agent_handle: c.handle, payment_hash: hire.payment_hash, outcome: 'unknown' });
      if (paid === 0n) { rejectQuote(t, s, c.handle, `send failed after a 502 and no payment showed on chain: ${sent.error.message}`); return null; }
      emit(t, 'error', { kind: 'paid_anyway', agent_handle: c.handle, message: `send to ${c.handle}: ${sent.error.message}; counted as spent` }, s.id);
      return hire;
    }
    if (!sent.ok) {
      // A 402 means the agent refused the payment: nothing can settle. Anything else may have reached the market, but no
      // task id came back, so no deliverable can: Rook voids it, and a payment that landed first counts as paid.
      if (await endUnpaid(ledger, t, s, hire, sent.error.code === 402 ? 'terminal' : 'void')) return hire;
      hire.state = 'SEND_FAILED'; hire.ended_at = now();
      if (sent.error.code === -32603 && !s.unreachable?.includes(c.handle)) (s.unreachable ??= []).push(c.handle);
      rejectQuote(t, s, c.handle, `send failed: ${sent.error.code} ${sent.error.message}`);
      return null;
    }

    hire.a2a_task_id = sent.task.id; hire.context_id = sent.task.context_id; hire.state = sent.task.state;
    emit(t, 'hire_sent', { hire_id: hire.id, agent_handle: c.handle, a2a_task_id: sent.task.id, amount_atomic: hire.amount_atomic, payment_hash: hire.payment_hash }, s.id);
    setSub(t, s, 'working');
    return await follow(ledger, t, s, c, hire, sent.task, slaEnd(c, hire));
  } finally {
    release();
  }
}

/** After a restart: finish a hire whose payment header was out, by polling its A2A task again (or waiting out the header). */
async function resumeHire(ledger: Ledger, t: Task, s: Sub, hire: Hire): Promise<Hire | null> {
  const c = s.candidates.find((x) => x.handle === hire.agent_handle);
  await acquire(t.abort.signal);
  try {
    if (!hire.a2a_task_id || !c) { // the header may have reached the agent, but its task id never came back: void it
      if (await endUnpaid(ledger, t, s, hire, 'void')) return hire;
      hire.state = 'SEND_FAILED'; hire.ended_at = now();
      return null;
    }
    setSub(t, s, 'working');
    // TIMEOUT: Rook had given up on it before the restart (its payment not yet cleared): straight to the void, no new poll.
    const timedOut = hire.state === 'TIMEOUT';
    const state = (['SUBMITTED', 'WORKING', ...TERMINAL] as string[]).includes(hire.state) ? hire.state as A2AState : 'WORKING';
    return await follow(ledger, t, s, c, hire, { id: hire.a2a_task_id, context_id: hire.context_id, state, artifacts: [] }, timedOut ? 0 : slaEnd(c, hire), timedOut);
  } finally {
    release();
  }
}

/** When Rook stops waiting for a hire and sends CancelTask: its agent's SLA plus the grace, at most ROOK_HIRE_PATIENCE_S. */
const slaEnd = (c: Candidate, hire: Hire) =>
  Date.parse(hire.started_at) + Math.min(c.sla_seconds + config.paymentGraceS, config.hirePatienceS) * 1000;

/** Polls a sent hire to its end, then settles its payment or ends it unpaid (a fresh hire, or one resumed after a restart). */
async function follow(ledger: Ledger, t: Task, s: Sub, c: Candidate, hire: Hire, sentTask: A2ATask, slaEnd: number, timedOut = false): Promise<Hire | null> {
  const signal = t.abort.signal;
  t.inflight.set(hire.id, { subtask: s, hire, handle: c.handle, a2a_task_id: sentTask.id });
  let final = timedOut ? null : await poll(t, s, c, hire, sentTask, slaEnd);
  if (!final) {
    // Past sla + grace (at most ROOK_HIRE_PATIENCE_S): Rook stops waiting, whether or not the agent accepts CancelTask.
    // One last look catches a delivery that landed meanwhile; otherwise the payment is voided (the signer spends its
    // nonce), so the next candidate is hired now, not once the authorization's window ends. On mainnet a 2 h 10 min
    // window held a part for 1 h 40 min after its agent had accepted CancelTask, with the page saying nothing.
    await cancelTask(c.handle, sentTask.id);
    signal.throwIfAborted();
    const last = await getTask(c.handle, sentTask.id, signal);
    if (last?.state === 'COMPLETED' && hasContent(last)) { final = last; hire.state = last.state; }
  }
  t.inflight.delete(hire.id);
  hire.ended_at = now();

  if (!final) {
    hire.state = 'TIMEOUT';
    if (!timedOut) emit(t, 'a2a_state', { hire_id: hire.id, agent_handle: c.handle, a2a_task_id: sentTask.id, state: 'TIMEOUT' }, s.id);
    return (await endUnpaid(ledger, t, s, hire, 'void')) ? hire : null;
  }
  if (final.state !== 'COMPLETED') { // REJECTED, FAILED, CANCELED: terminal and unpaid
    return (await endUnpaid(ledger, t, s, hire, 'terminal')) ? hire : null;
  }
  // Delivered: keep the deliverable before settling, so the settle event stores it with the payment.
  hire.parts = final.artifacts.flatMap((a) => a.parts ?? []);
  hire.deliverable_text = hire.parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n\n');
  // A kill stops the wait for the facilitator: unwind then waits out this authorization on its own.
  const paid = await ledgerOp(t, 'settle', s, async () => {
    const a = await ledger.settle(t.id, s.n, signal);
    hire.paid = a > 0n;
    return a;
  }, { agent_handle: c.handle, payment_hash: hire.payment_hash });
  if (paid === 0n) emit(t, 'error', { kind: 'unpaid', agent_handle: c.handle, message: `${c.handle} delivered, but its payment never showed on chain before the authorization expired; booked unpaid` }, s.id);
  return hire;
}

const hasContent = (task: A2ATask) => task.artifacts?.some((a) => a.parts?.some((p) => (p.text ?? '').trim() || p.url || p.raw));

/** One GetTask; null when the gateway or the agent does not answer. */
async function getTask(handle: string, id: string, signal: AbortSignal): Promise<A2ATask | null> {
  const r = await call<GatewayResult<{ task: A2ATask }>>(gw(`/task?handle=${encodeURIComponent(handle)}&id=${encodeURIComponent(id)}`), undefined, { signal })
    .catch(() => { signal.throwIfAborted(); return null; });
  return r?.ok ? r.task : null;
}

/** Poll GetTask until terminal; null when the deadline passes first. */
async function poll(t: Task, s: Sub, c: Candidate, hire: Hire, initial: A2ATask, deadline: number): Promise<A2ATask | null> {
  const signal = t.abort.signal;
  let task = initial, emptyRetries = 0;
  const report = () => emit(t, 'a2a_state', { hire_id: hire.id, agent_handle: c.handle, a2a_task_id: task.id, state: task.state }, s.id);
  report();
  for (;;) {
    if (task.state === 'COMPLETED' && !hasContent(task) && emptyRetries < 3) {
      // ponytail: COMPLETED may land before its artifacts; three re-polls a second apart, then evaluate as empty.
      emptyRetries++;
      await sleep(1000, undefined, { signal });
    } else if (TERMINAL.includes(task.state)) {
      hire.state = task.state;
      return task;
    } else {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await sleep(Math.min(config.pollMs, left), undefined, { signal });
    }
    let r: GatewayResult<{ task: A2ATask }> | null = null;
    try {
      r = await call(gw(`/task?handle=${encodeURIComponent(c.handle)}&id=${encodeURIComponent(task.id)}`), undefined, { signal });
    } catch (e) { signal.throwIfAborted(); } // transient: keep polling until the deadline
    signal.throwIfAborted();
    if (r?.ok) {
      const changed = r.task.state !== task.state;
      task = r.task;
      hire.state = task.state;
      if (changed) report();
    }
  }
}

/** Wait for cross-check peers, then ask the evaluator (retried: an outage is not a verdict). Records the evaluation. */
async function evaluate(t: Task, s: Sub, text: string, parts: Part[], hire_id: string | null, agent_handle: string, done: Map<string, Deferred>): Promise<Evaluation> {
  const signal = t.abort.signal;
  setSub(t, s, 'evaluating');
  const refs = [...new Set(s.criteria.flatMap((c) => (c.kind === 'cross_check' ? [c.spec.other_subtask] : [])))];
  if (refs.length) await abortable(Promise.all(refs.map((id) => done.get(id)?.promise ?? Promise.resolve())), signal);
  const peers = refs
    .map((id) => t.subtasks.find((x) => x.id === id))
    .filter((p): p is Sub => p?.final_outcome === 'passed' && !!p.accepted)
    .map((p) => ({ subtask_id: p.id, text: p.accepted!.text }));
  let ev: Evaluation;
  for (let attempt = 1; ; attempt++) {
    try {
      ev = await call<Evaluation>(config.urls.evaluator + '/evaluate', {
        task_id: t.id, subtask_id: s.id, brief: s.brief, criteria: s.criteria, deliverable: { text, parts }, peers,
      }, { signal });
      break;
    } catch (e) {
      signal.throwIfAborted();
      t.llm_calls.push(...paidCalls(e));
      if (attempt >= 3) throw e;
      emit(t, 'error', { kind: 'eval_retry', message: `evaluator attempt ${attempt} failed, retrying: ${msg(e)}` }, s.id);
      await sleep(Math.min(config.pollMs, 2000) * attempt, undefined, { signal });
    }
  }
  signal.throwIfAborted();
  s.evaluations.push({ ...ev, hire_id });
  for (const flag of ev.security_flags ?? []) emit(t, 'security_alert', { source: 'evaluator', hire_id, agent_handle, flag }, s.id);
  emit(t, 'evaluation', { hire_id, agent_handle, verdict: ev.verdict, failed_criteria: ev.failed_criteria, attestation_hash: ev.attestation_hash }, s.id);
  return ev;
}

/** self_do subtasks: the planner writes the deliverable; no ledger involvement. An error abandons this subtask only. */
async function selfDo(t: Task, s: Sub, done: Map<string, Deferred>) {
  const signal = t.abort.signal;
  for (;;) {
    setSub(t, s, 'working'); // Rook writes it now, as a hired agent works on its part
    const r = await call<{ text: string; llm_calls: LlmCall[] }>(config.urls.planner + '/self-do', {
      task_id: t.id, subtask_id: s.id, brief: s.brief, criteria: s.criteria,
    }, { signal });
    signal.throwIfAborted();
    t.llm_calls.push(...(r.llm_calls ?? []));
    const ev = await evaluate(t, s, r.text, [{ text: r.text }], null, 'rook:self-do', done);
    if (ev.verdict === 'pass') {
      s.accepted = { hire_id: null, agent_handle: 'rook:self-do', text: r.text };
      return finish(t, s, 'passed', done);
    }
    if (failedVerdict(s)) return finish(t, s, 'abandoned', done);
  }
}
