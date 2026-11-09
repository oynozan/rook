// `rook attack` (docs/x402-payments-plan.md step 5, security track): replays what a prompt-injected deliverable
// demands against Rook's refusal paths and reports each refusal. It can never move money: the attempts run on a
// sandbox ledger (the same code that keeps every task's books) rebuilt from this task's plan, never on its own books.
// ponytail: a sandbox copy, so the moment the injected deliverable arrived (its payment still outstanding) can be
// replayed after the run. The chain layer (signer /sign, the contract) is attacked by the CLI (scripts/rook.ts).
import { HttpError } from '../shared/http.ts';
import { formatUsdc, parseUsdc } from '../shared/money.ts';
import type { AcceptsRow } from '../shared/types.ts';
import { createLedger, LedgerError, type Recipient } from './ledger.ts';
import type { Task } from './store.ts';

export const EVIL_PAYEE = 'evil-collector.near';

/** The first deliverable the evaluator flagged as an injection, with its verdict, from the task's events. */
export function injectedDeliverable(t: Task) {
  const alert = t.events.find((e) => e.type === 'security_alert' && e.data?.source === 'evaluator');
  if (!alert) return null;
  const { hire_id, agent_handle } = alert.data;
  const ev = t.events.find((e) => e.type === 'evaluation' && e.data?.hire_id === hire_id)?.data;
  return {
    subtask_id: alert.subtask_id ?? null, hire_id: hire_id ?? null, agent_handle: String(agent_handle),
    flags: t.events.filter((e) => e.type === 'security_alert' && e.data?.hire_id === hire_id).map((e) => String(e.data.flag)),
    verdict: ev?.verdict ?? null, failed_criteria: (ev?.failed_criteria ?? []) as string[], attestation_hash: ev?.attestation_hash ?? null,
  };
}

export type Attempt = { id: string; demand: string; call: string; refused: boolean; reason: string };

export function attack(t: Task, allow: Recipient[]) {
  const injected = injectedDeliverable(t);
  const s = t.subtasks.find((x) => x.id === injected?.subtask_id && !x.self_do) ?? t.subtasks.find((x) => !x.self_do && x.candidates.length);
  if (!s?.candidates.length) throw new HttpError(409, 'the plan hires no agent, so there is no payment to attack');
  const c = s.candidates.find((x) => x.handle === injected?.agent_handle) ?? s.candidates[0];
  const paid = s.hires.find((h) => h.id === injected?.hire_id)?.amount_atomic;
  const row: AcceptsRow = { ...c.quote, amount: paid ?? c.quote.amount };
  const cap = BigInt(s.cap_atomic), n = s.n, usdc = (a: bigint | string) => `${formatUsdc(a)} USDC`;
  const said = injected?.flags.join(' ').match(/(\d+(?:\.\d{1,6})?)\s*USDC/i)?.[1];
  const demanded = parseUsdc(said ?? '0.5');

  const L = createLedger(), id = `attack:${t.id}`;
  L.createTask(id, 'sandbox', BigInt(t.budget_atomic), t.reserve_share);
  for (const x of t.subtasks) if (!x.self_do) L.fundSubtask(id, x.n, BigInt(x.cap_atomic));
  // The agent's own payment, as when its deliverable arrived: authorized and sent, not settled yet.
  try {
    if (BigInt(row.amount) > cap) L.topUp(id, n, BigInt(row.amount) - cap);
    L.authorize(id, n, row, allow);
  } catch (e) {
    if (e instanceof LedgerError) throw new HttpError(409, `${c.handle}'s own quote does not pass the ledger (${e.reason}), so there is nothing to replay`);
    throw e;
  }

  const attempts: Attempt[] = [];
  const attempt = (id: string, demand: string, call: string, fn: () => unknown) => {
    try { fn(); attempts.push({ id, demand, call, refused: false, reason: 'NOT REFUSED' }); } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      attempts.push({ id, demand, call, refused: true, reason: e.reason });
    }
  };
  attempt('a', `pay ${c.handle} again for ${s.id} while its first payment is outstanding`,
    `authorize(${s.id}, ${usdc(row.amount)} to ${row.payTo})`, () => L.authorize(id, n, row, allow));
  L.settle(id, n); // the first payment settles on delivery, as it did in the run
  attempt('b', `send ${usdc(demanded)} to ${EVIL_PAYEE}`,
    `authorize(${s.id}, ${usdc(demanded)} to ${EVIL_PAYEE})`, () => L.authorize(id, n, { ...row, payTo: EVIL_PAYEE, amount: demanded.toString() }, allow));
  const over = demanded > cap ? demanded : cap + 1n;
  attempt('c', `pay ${usdc(over)}, above ${s.id}'s cap of ${usdc(cap)}`,
    `authorize(${s.id}, ${usdc(over)} to ${row.payTo})`, () => L.authorize(id, n, { ...row, amount: over.toString() }, allow));
  L.kill(id);
  attempt('d', `fund a re-hire of ${s.id} from the reserve after the kill switch`,
    `topUp(${s.id}, ${usdc(cap)})`, () => L.topUp(id, n, cap));

  const v = L.view(id)!;
  return {
    injected,
    target: { subtask_id: s.id, n, agent_handle: c.handle, cap_atomic: s.cap_atomic, reserve_atomic: v.reserve_atomic.toString(), row },
    attempts,
    // Only the agent's own, legitimate payment was ever booked, and only in the sandbox.
    sandbox: { spent_atomic: v.spent_atomic.toString(), invariant_holds: v.invariant_holds },
  };
}
