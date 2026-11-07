// Task and subtask state machines and the hiring loop (docs/agentic-system.md sections 8.2 to 8.8).
// Agent messages and artifacts are data: they only go to the evaluator and the aggregator, never steer this loop.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { cannedAggregate, agentOf, isMerged } from '../planner/canned.ts';
import { config } from '../shared/config.ts';
import { call } from '../shared/http.ts';
import { formatUsdc } from '../shared/money.ts';
import {
  TERMINAL, type A2AState, type A2ATask, type AcceptsRow, type AggregateResult, type Candidate, type Evaluation,
  type GatewayResult, type LlmCall, type Part, type Receipt, type X402Config,
} from '../shared/types.ts';
import { LedgerError, type Ledger, type Recipient } from './ledger.ts';
import { emit, now, setStatus, setSub, type Hire, type Sub, type Task } from './store.ts';

const gw = (path: string) => config.urls.marketGateway + path;
const msg = (e: any) => e?.message ?? String(e);
/** LLM calls a failed planner or evaluator request already paid for (they come back in its 502 body). */
const paidCalls = (e: any): LlmCall[] => e?.body?.details?.llm_calls ?? [];

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

function ledgerOp<T extends bigint | object>(t: Task, op: string, sub: Sub | null, fn: () => T, extra: object = {}): T {
  const out = fn();
  const amount = typeof out === 'bigint' ? out : (out as any).amount ?? null;
  emit(t, 'ledger', { op, ...(sub ? { n: sub.n } : {}), amount_atomic: amount, ...extra }, sub?.id);
  return out;
}

function cancelBestEffort(handle: string, id: string) {
  call(gw('/cancel'), { handle, id }).catch(() => {});
}
/** CancelTask and report whether the agent accepted it (only then is nothing chargeable any more). */
const cancelTask = (handle: string, id: string) => call<{ ok: boolean }>(gw('/cancel'), { handle, id }).then((r) => r?.ok === true, () => false);

const authorizedNow = (ledger: Ledger, t: Task, s: Sub) => ledger.view(t.id)?.subtasks.find((x) => x.n === s.n)?.authorized_atomic != null;

// ---- task ----

export async function runTask(ledger: Ledger, t: Task) {
  const signal = t.abort.signal;
  try {
    const x402 = await call<X402Config>(gw('/x402'), undefined, { signal });
    signal.throwIfAborted();
    t.allow = x402.recipients ?? [];
    ledgerOp(t, 'createTask', null, () => ledger.createTask(t.id, t.funder!, BigInt(t.budget_atomic), t.reserve_share));
    setStatus(t, 'funded');
    for (const s of t.subtasks) {
      if (s.self_do) continue;
      ledgerOp(t, 'fundSubtask', s, () => ledger.fundSubtask(t.id, s.n, BigInt(s.cap_atomic)));
      setSub(t, s, 'funded');
    }
    setStatus(t, 'running');

    // One subtask's error (planner /self-do down, evaluator unreachable, a ledger refusal) abandons that subtask
    // only; the others keep their paid work. Only an abort (kill, shutdown) stops the whole task.
    const done = new Map(t.subtasks.map((s) => [s.id, deferred()]));
    await Promise.allSettled(t.subtasks.map((s) => runSubtask(ledger, t, s, done).catch((e) => {
      if (signal.aborted) throw e;
      t.llm_calls.push(...paidCalls(e));
      emit(t, 'error', { message: `${s.id} abandoned: ${msg(e)}` }, s.id);
      if (!s.final_outcome) finish(t, s, 'abandoned', done);
      try {
        if (!s.self_do && ledger.view(t.id)?.subtasks.find((x) => x.n === s.n)?.returned_atomic === null) {
          ledgerOp(t, 'returnLeftover', s, () => ledger.returnLeftover(t.id, s.n));
        }
      } catch (e2) { emit(t, 'error', { message: `${s.id}: ${msg(e2)}` }, s.id); }
      setSub(t, s, 'returned');
    })));
    signal.throwIfAborted();

    setStatus(t, 'aggregating');
    const subtasks = t.subtasks.map((s) => ({
      id: s.id, title: s.title, status: s.final_outcome ?? s.status,
      agent_handle: s.accepted?.agent_handle, deliverable_text: s.accepted?.text,
    }));
    let agg: AggregateResult;
    try {
      agg = await call<AggregateResult>(config.urls.planner + '/aggregate', { task_id: t.id, prompt: t.prompt, subtasks }, { signal });
    } catch (e) {
      // The deliverables are paid for and passed: fall back to the deterministic merge rather than lose them.
      signal.throwIfAborted();
      t.llm_calls.push(...paidCalls(e));
      emit(t, 'error', { message: `aggregate failed, using the deterministic merge: ${msg(e)}` });
      const req = { task_id: t.id, prompt: t.prompt, subtasks };
      agg = { final_markdown: cannedAggregate(req), attribution: subtasks.filter(isMerged).map((s) => ({ subtask_id: s.id, agent_handle: agentOf(s) })), llm_calls: [] };
    }
    signal.throwIfAborted();
    t.llm_calls.push(...(agg.llm_calls ?? []));

    setStatus(t, 'closing');
    const refunded = ledgerOp(t, 'closeTask', null, () => ledger.closeTask(t.id));
    const view = ledger.view(t.id)!;
    t.final_result = {
      final_markdown: agg.final_markdown, attribution: agg.attribution ?? [],
      abandoned: t.subtasks.filter((s) => s.final_outcome === 'abandoned').map((s) => s.id),
    };
    emit(t, 'final', { ...t.final_result, spent_atomic: view.spent_atomic, refunded_atomic: refunded, reserve_used_atomic: view.reserve_used_atomic });
    setStatus(t, 'closed');
  } catch (e) {
    if (t.status === 'killed') return; // kill already released and reported everything
    emit(t, 'error', { message: msg(e) });
    salvage(ledger, t);
    t.error = msg(e);
    setStatus(t, 'failed');
  }
}

/** After a failure: cancel A2A tasks, release authorizations, return leftovers and refund, so no funds stay locked. */
function salvage(ledger: Ledger, t: Task) {
  for (const f of t.inflight.values()) {
    if (f.a2a_task_id) cancelBestEffort(f.handle, f.a2a_task_id);
    f.hire.state = 'CANCELED'; f.hire.ended_at = now();
  }
  t.inflight.clear();
  if (!ledger.view(t.id)) return;
  for (const s of t.subtasks) {
    const v = ledger.view(t.id)!.subtasks.find((x) => x.n === s.n);
    if (!v) continue;
    try {
      if (v.authorized_atomic !== null) ledgerOp(t, 'release', s, () => ledger.release(t.id, s.n));
      if (v.returned_atomic === null) ledgerOp(t, 'returnLeftover', s, () => ledger.returnLeftover(t.id, s.n));
    } catch (e) { emit(t, 'error', { message: `salvage ${s.id}: ${msg(e)}` }, s.id); }
  }
  try { ledgerOp(t, 'closeTask', null, () => ledger.closeTask(t.id)); } catch (e) { emit(t, 'error', { message: `salvage close: ${msg(e)}` }); }
}

/** Kill switch (section 8.7). Synchronous, so no loop can emit between the ledger kill and the killed status. */
export function kill(ledger: Ledger, t: Task) {
  ledger.kill(t.id);
  emit(t, 'ledger', { op: 'kill' });
  t.abort.abort();
  const sending = new Set<number>();
  for (const f of t.inflight.values()) {
    // A /send still in flight has its payment header out: its hire1 waits for the answer, cancels, then releases.
    if (!f.a2a_task_id) { sending.add(f.subtask.n); continue; }
    cancelBestEffort(f.handle, f.a2a_task_id); f.hire.state = 'KILLED'; f.hire.ended_at = now();
  }
  t.inflight.clear();
  for (const v of ledger.view(t.id)?.subtasks ?? []) {
    if (v.authorized_atomic === null || sending.has(v.n)) continue;
    const s = t.subtasks.find((x) => x.n === v.n) ?? null;
    ledgerOp(t, 'release', s, () => ledger.release(t.id, v.n));
  }
  setStatus(t, 'killed');
}

// ---- subtask ----

async function runSubtask(ledger: Ledger, t: Task, s: Sub, done: Map<string, Deferred>) {
  if (s.self_do) await selfDo(t, s, done);
  else await hireLoop(ledger, t, s, done);
  if (!s.self_do) ledgerOp(t, 'returnLeftover', s, () => ledger.returnLeftover(t.id, s.n));
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
function writeReceipt(t: Task, s: Sub, hire: Hire, ev: Evaluation | null) {
  hire.verdict = ev?.verdict ?? null;
  const receipt: Receipt = {
    id: `rc_${randomUUID().slice(0, 8)}`, task_id: t.id, subtask_id: s.id, hire_id: hire.id, agent_handle: hire.agent_handle,
    a2a_task_id: hire.a2a_task_id, amount_atomic: hire.amount_atomic, verdict: hire.verdict,
    attestation_hash: ev?.attestation_hash ?? null, payment_hash: hire.payment_hash, payment_tx: null, receipt_tx: null,
  };
  t.receipts.push(receipt);
  emit(t, 'receipt', receipt, s.id);
}

async function hireLoop(ledger: Ledger, t: Task, s: Sub, done: Map<string, Deferred>) {
  const signal = t.abort.signal;
  for (;;) {
    signal.throwIfAborted();
    const c = s.candidates.find((x) => !s.tried.includes(x.handle)); // plan order = cheapest first
    if (!c) return finish(t, s, 'abandoned', done);
    s.tried.push(c.handle);
    setSub(t, s, 'quoting');

    const row = await quote(ledger, t, s, c);
    if (!row) continue;
    const hire = await hire1(ledger, t, s, c, row);
    if (!hire) continue;
    if (hire.state === 'OUTCOME_UNKNOWN') { // counted as spent, nothing to judge; counts against the re-hire limit
      writeReceipt(t, s, hire, null);
      if (failedVerdict(s)) return finish(t, s, 'abandoned', done);
      continue;
    }

    let ev: Evaluation;
    try {
      ev = await evaluate(t, s, hire.deliverable_text ?? '', hire.parts, hire.id, hire.agent_handle, done);
    } catch (e) {
      writeReceipt(t, s, hire, null); // paid even though the evaluation never finished (kill, evaluator outage)
      if (signal.aborted) throw e;
      // Rook's own outage is not the agent's failure: no verdict, no re-hire spend against a broken evaluator.
      emit(t, 'error', { message: `evaluation of ${hire.agent_handle} failed, subtask abandoned unjudged: ${msg(e)}` }, s.id);
      return finish(t, s, 'abandoned', done);
    }
    writeReceipt(t, s, hire, ev);
    if (ev.verdict === 'pass') {
      s.accepted = { hire_id: hire.id, agent_handle: hire.agent_handle, text: hire.deliverable_text ?? '' };
      return finish(t, s, 'passed', done);
    }
    if (failedVerdict(s)) return finish(t, s, 'abandoned', done);
  }
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
      ledgerOp(t, 'topUp', s, () => ledger.topUp(t.id, s.n, short), { agent_handle: c.handle });
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
 * Authorize, send, poll. Returns the hire when COMPLETED and settled (or settled with an unknown outcome);
 * null when the agent was skipped without charge.
 */
async function hire1(ledger: Ledger, t: Task, s: Sub, c: Candidate, row: AcceptsRow): Promise<Hire | null> {
  const signal = t.abort.signal;
  await acquire(signal);
  try {
    let auth: { header: string; payment_hash: string; amount: bigint };
    try {
      auth = ledgerOp(t, 'authorize', s, () => ledger.authorize(t.id, s.n, row, t.allow), { agent_handle: c.handle });
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      signal.throwIfAborted();
      rejectQuote(t, s, c.handle, `authorization refused: ${e.reason}`);
      return null;
    }
    const authAt = Date.now();
    const hire: Hire = {
      id: `h_${randomUUID().slice(0, 8)}`, subtask_id: s.id, agent_handle: c.handle, amount_atomic: auth.amount.toString(),
      payment_hash: auth.payment_hash, a2a_task_id: null, context_id: null, state: 'SENDING', paid: false,
      deliverable_text: null, parts: [], verdict: null, started_at: now(), ended_at: null,
    };
    s.hires.push(hire);

    // No abort signal on /send: once the request leaves, the payment header is out. Waiting for the answer lets a
    // kill still learn the task id, cancel it and record how the payment ended (kill() leaves this one to us).
    t.inflight.set(hire.id, { subtask: s, hire, handle: c.handle, a2a_task_id: null });
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
      if (authorizedNow(ledger, t, s)) ledgerOp(t, 'release', s, () => ledger.release(t.id, s.n));
      throw signal.reason;
    }
    if (!sent.ok && sent.error.code === 'outcome_unknown') {
      // The gateway saw a 502 and cannot tell whether the payment settled: count it as spent, never release it.
      ledgerOp(t, 'settle', s, () => ledger.settle(t.id, s.n), { agent_handle: c.handle, payment_hash: hire.payment_hash, outcome: 'unknown' });
      hire.paid = true; hire.state = 'OUTCOME_UNKNOWN'; hire.ended_at = now();
      emit(t, 'error', { message: `send to ${c.handle}: ${sent.error.message}; counted as spent` }, s.id);
      return hire;
    }
    if (!sent.ok) {
      // ponytail: any other send failure releases the authorization. In live mode a network error after the agent
      // accepted the payment could still charge; phase 2 checks the chain before releasing.
      ledgerOp(t, 'release', s, () => ledger.release(t.id, s.n));
      hire.state = 'SEND_FAILED'; hire.ended_at = now();
      rejectQuote(t, s, c.handle, `send failed: ${sent.error.code} ${sent.error.message}`);
      return null;
    }

    hire.a2a_task_id = sent.task.id; hire.context_id = sent.task.context_id; hire.state = sent.task.state;
    t.inflight.set(hire.id, { subtask: s, hire, handle: c.handle, a2a_task_id: sent.task.id });
    emit(t, 'hire_sent', { hire_id: hire.id, agent_handle: c.handle, a2a_task_id: sent.task.id, amount_atomic: hire.amount_atomic, payment_hash: hire.payment_hash }, s.id);
    setSub(t, s, 'working');

    let final = await poll(t, s, c, hire, sent.task, Date.now() + (c.sla_seconds + config.paymentGraceS) * 1000);
    if (!final) {
      // Past sla + grace. The header stays redeemable until the authorization expires, so the next candidate is
      // authorized only once CancelTask is accepted or that expiry has passed (the agent may still complete and charge).
      const cancelled = await cancelTask(c.handle, sent.task.id);
      signal.throwIfAborted();
      const expiresAt = authAt + row.maxTimeoutSeconds * 1000;
      if (!cancelled && expiresAt - Date.now() > 1000) {
        final = await poll(t, s, c, hire, { ...sent.task, state: hire.state as A2AState }, expiresAt);
      }
    }
    t.inflight.delete(hire.id);
    hire.ended_at = now();

    if (!final) {
      hire.state = 'TIMEOUT';
      emit(t, 'a2a_state', { hire_id: hire.id, agent_handle: c.handle, a2a_task_id: sent.task.id, state: 'TIMEOUT' }, s.id);
      ledgerOp(t, 'release', s, () => ledger.release(t.id, s.n));
      return null;
    }
    if (final.state !== 'COMPLETED') {
      ledgerOp(t, 'release', s, () => ledger.release(t.id, s.n));
      return null;
    }
    ledgerOp(t, 'settle', s, () => ledger.settle(t.id, s.n), { agent_handle: c.handle, payment_hash: hire.payment_hash });
    hire.paid = true;
    hire.parts = final.artifacts.flatMap((a) => a.parts ?? []);
    hire.deliverable_text = hire.parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n\n');
    return hire;
  } finally {
    release();
  }
}

const hasContent = (task: A2ATask) => task.artifacts?.some((a) => a.parts?.some((p) => (p.text ?? '').trim() || p.url || p.raw));

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
      emit(t, 'error', { message: `evaluator attempt ${attempt} failed, retrying: ${msg(e)}` }, s.id);
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
