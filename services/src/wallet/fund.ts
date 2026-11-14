// Funding a task from the owner's agent wallet (docs/agent-wallet-plan.md, "The gap, and how the MVP bridges it"):
// withdraw the budget to the wallet's own native NEAR account (where the budget, the per-task limit and the owner's
// approval apply), then ft_transfer_call it from there to Rook's contract with the plan's create_task msg, then bind
// the contract task it created as /funded does. After a run, what came back to the native account is swept into the
// wallet's NEAR Intents balance again. Each step is kept in Task.wallet_funding, so a restart picks it up where it was.
import { randomUUID } from 'node:crypto';
import { config } from '../shared/config.ts';
import { call, HttpError } from '../shared/http.ts';
import { formatUsdc } from '../shared/money.ts';
import { emit, isTerminal, saveTask, setStatus, type Task } from '../orchestrator/store.ts';
import { AgentApiError, settle, sleep, USDC_ASSET, USDC_CONTRACT, type AgentApi, type StatusResponse } from './api.ts';
import { refusal, type Wallets } from './index.ts';

/** The steps that may have money between the wallet and the contract: nothing else may move the native account's USDC. */
const ACTIVE = ['withdrawing', 'awaiting_approval', 'transferring'];
export const fundingActive = (t: Task) => !!t.wallet_funding && ACTIVE.includes(t.wallet_funding.state);

const TGAS_100 = '100000000000000';

export type FundDeps = {
  api: AgentApi; wallets: Wallets; tasks: () => Iterable<Task>;
  /** The /funded checks for contract task `cid` funded by `funder`, then the bind and the run (index.ts). */
  bind: (t: Task, cid: string, funder: string) => Promise<void>;
  gapMs: number; // between status reads that answer at once
  approvalGapMs: number; // between reads while the owner's vote is awaited
  sweep?: (owner: string) => Promise<void>; // after a funding stops: USDC it moved to the native account goes back
};

/** Where the money is when a funding stops, in the words the page shows. */
const IN_WALLET = 'Your USDC is still in your agent wallet.';
const ON_NATIVE = "The USDC is on your agent wallet's NEAR account; Rook moves it back into your agent wallet.";

class Stop extends Error {}

/** `fn` again while it fails for a moment (see transient), at most a few times. */
async function retried<T>(fn: () => Promise<T>, d: FundDeps, signal: AbortSignal): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (signal.aborted || !transient(e) || i >= 5) throw e;
      await sleep(d.gapMs * 2 ** i, signal);
    }
  }
}

/** An answer that may come right on the next try: no answer, a server error, or one the API marks retryable. */
const transient = (e: unknown) =>
  (e instanceof AgentApiError && (e.retryable || e.status === 0 || e.status >= 500)) || (e instanceof HttpError && e.status >= 500) || e instanceof TypeError;

/**
 * Reads `cid` until it settles (PENDING_APPROVAL is returned to the caller). A read that fails for a moment is tried
 * again: the operation goes on at the API whether Rook reads it or not, so a blip must not end the funding.
 */
async function follow(d: FundDeps, cid: string, signal: AbortSignal): Promise<StatusResponse> {
  for (let i = 0; ; i++) {
    try { return await settle(d.api, cid, { deadlineMs: 10 * 60_000, gapMs: d.gapMs, signal }); } catch (e) {
      if (signal.aborted || !transient(e) || i >= 30) throw e;
      await sleep(Math.min(30_000, d.gapMs * 2 ** i), signal);
    }
  }
}
const moving = (s: StatusResponse) => ['PROCESSING', 'QUEUED', 'UNCERTAIN'].includes(s.status);

/**
 * A money-moving call under one Idempotency-Key: repeated with the same key while the API says it may be retried (or
 * did not answer), as its docs require; a plain refusal is final. A retryable failure "may have taken effect"
 * (errors.md, retry rules), and only the same key can tell, so it is repeated as long as a status is followed, not
 * a few seconds.
 */
async function sent(fn: () => Promise<StatusResponse>, d: FundDeps, signal: AbortSignal): Promise<StatusResponse> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (!(e instanceof AgentApiError) || !e.retryable || i >= 30) throw e;
      await sleep(Math.min(30_000, d.gapMs * 2 ** i), signal);
    }
  }
}
/** A call that failed this way may still have gone through: Rook can't say where the money is. */
const unknown = (e: unknown) => e instanceof AgentApiError && e.retryable;

/**
 * Runs `t`'s wallet funding from its current step. `transfer`: Rook's contract, its USDC token and the plan's
 * create_task msg, as the user's own funding sends them. Ends bound (the run started), or failed with where the money is.
 */
export async function runFunding(d: FundDeps, t: Task, transfer: { contract_id: string; usdc: string; msg: string }): Promise<void> {
  const f = t.wallet_funding!;
  const signal = t.abort.signal;
  const op = (name: string, data: object = {}) => emit(t, 'ledger', { op: name, ...data }, undefined, isTerminal(t.status));
  const save = () => saveTask(t);
  // The transfer reached Rook's contract and nothing sent it back (refused, or closed by Rook): see fail.
  let returned = false;
  const fail = (message: string) => {
    Object.assign(f, { state: 'failed', error: message });
    delete f.approval_id;
    save();
    op('wallet_failed', { message });
    // Nothing reached the contract, or it came back: the plan can be funded again, from the wallet or by the user's own.
    // USDC that may still sit in a contract task ends the task instead: offered again, a second click funded it twice.
    if (f.tx_hash && !returned) {
      if (!isTerminal(t.status)) { t.error = message; setStatus(t, 'failed'); }
    } else if (!isTerminal(t.status)) setStatus(t, 'planned');
    void d.sweep?.(t.owner!);
  };
  const w = d.wallets.ready(t.owner!);
  try {
    if (!w) throw new Stop(`Rook's permission to spend from your agent wallet expired. Give it again in the wallet setup. ${IN_WALLET}`);
    const sAmount = `${formatUsdc(BigInt(f.amount_atomic))} USDC`;

    if (f.state === 'withdrawing' || f.state === 'awaiting_approval') {
      if (!f.withdraw_correlation_id) {
        signal.throwIfAborted();
        // ponytail: from the public balance, where the owner's intents.near deposit lands; a 1Click deposit (confidential) would need the default.
        const body = { asset: USDC_ASSET, amount: f.amount_atomic, chain: 'near', recipient: w.near_account_id, confidential: false };
        let s: StatusResponse;
        try {
          s = await sent(() => d.api.withdraw(w.agent_id, w.grant.token, `${f.key}:withdraw`, body), d, signal);
        } catch (e) {
          if (signal.aborted) throw e;
          if (unknown(e)) throw new Stop(`Rook couldn't learn whether your agent wallet sent ${sAmount} (${(e as AgentApiError).code}). If it did, the USDC lands on your agent wallet's NEAR account and Rook moves it back into your agent wallet.`);
          throw new Stop(`Your agent wallet refused to send ${sAmount}: ${refusal(e).message} ${IN_WALLET}`);
        }
        f.withdraw_correlation_id = s.correlation_id;
        save();
        op('wallet_withdraw', { amount_atomic: f.amount_atomic, correlation_id: s.correlation_id, to: w.near_account_id });
      }
      for (;;) {
        const s = await follow(d, f.withdraw_correlation_id, signal);
        if (s.status === 'PENDING_APPROVAL') {
          if (f.state !== 'awaiting_approval') {
            Object.assign(f, { state: 'awaiting_approval', approval_id: String(s.details?.approval_id ?? '') });
            save();
            op('wallet_approval_needed', { approval_id: f.approval_id, amount_atomic: f.amount_atomic, correlation_id: s.correlation_id });
          }
          await sleep(d.approvalGapMs, signal);
          continue;
        }
        if (f.state === 'awaiting_approval') { f.state = 'withdrawing'; save(); } // voted: it moves again
        if (moving(s)) continue;
        if (s.status === 'SUCCESS') break;
        const code = s.failure_code ?? '';
        if (s.status === 'NEEDS_REVIEW') throw new Stop(`The agent wallet service stopped this withdrawal for review (${s.details?.reason ?? 'no reason given'}). Rook can't tell yet whether the USDC left your agent wallet: check it before funding again.`);
        if (/reject/.test(code)) throw new Stop(`You rejected this spend, so Rook didn't fund the task. ${IN_WALLET}`);
        if (/expired/.test(code)) throw new Stop(`The approval request expired before you answered. ${IN_WALLET}`);
        if (code === 'authorization_stale') throw new Stop(`Rook's permission or your wallet's rules changed while this waited, so it was not sent. ${IN_WALLET}`);
        throw new Stop(`The withdrawal from your agent wallet failed (${code || s.status}). ${IN_WALLET}`);
      }
      f.state = 'transferring';
      save();
    }

    if (f.state === 'transferring') {
      if (!f.call_correlation_id) {
        if (signal.aborted) throw new Stop(`Stopped before Rook sent the USDC to its contract. ${ON_NATIVE}`);
        const body = {
          receiver_id: transfer.usdc, method_name: 'ft_transfer_call',
          args: { receiver_id: transfer.contract_id, amount: f.amount_atomic, msg: transfer.msg }, gas: TGAS_100, deposit: '1',
        };
        let s: StatusResponse;
        try {
          s = await sent(() => d.api.nearCall(w.agent_id, w.grant.token, `${f.key}:transfer`, body), d, signal);
        } catch (e) {
          if (unknown(e)) throw new Stop(`Rook couldn't learn whether the USDC went from your agent wallet's NEAR account to its contract (${(e as AgentApiError).code}). Check that account before funding again: if it holds the USDC, Rook moves it back into your agent wallet; if not, Rook's contract holds it.`);
          throw new Stop(`Rook couldn't send the USDC from your agent wallet's NEAR account to its contract: ${refusal(e).message} ${ON_NATIVE}`);
        }
        f.call_correlation_id = s.correlation_id;
        save();
        op('wallet_transfer', { amount_atomic: f.amount_atomic, correlation_id: s.correlation_id, contract_id: transfer.contract_id });
      }
      let s: StatusResponse;
      // Once sent, the transfer is followed to its end even if the task is stopped meanwhile (the USDC is on its way);
      // only a shutdown leaves it, for the next start to follow.
      do s = await follow(d, f.call_correlation_id, t.shutdown.signal); while (moving(s));
      if (s.status === 'NEEDS_REVIEW') {
        throw new Stop(`The agent wallet service stopped the transfer to Rook's contract for review (${s.details?.reason ?? 'no reason given'}). Rook can't tell yet where the USDC is: check your agent wallet's NEAR account.`);
      }
      if (s.status !== 'SUCCESS' || typeof s.details?.tx_hash !== 'string') throw new Stop(`The transfer to Rook's contract failed (${s.failure_code ?? s.status}). ${ON_NATIVE}`);
      f.tx_hash = s.details.tx_hash;
      save();
      // The transfer is on chain now: a failure to read it never says the USDC is still on the wallet's account.
      const made = await retried(() => call(`${config.urls.chainGateway}/created-task?${new URLSearchParams({ tx: f.tx_hash!, sender: w.near_account_id })}`), d, t.shutdown.signal)
        .catch((e) => {
          if (t.shutdown.signal.aborted) throw e;
          const why = /TIMEOUT|NOT_OBSERVED|UNKNOWN_TRANSACTION/.test((e as Error)?.message ?? '') ? "NEAR didn't show that transaction in time" : "Rook's chain-gateway couldn't read it";
          console.error(`[wallet] created task of ${f.tx_hash}:`, (e as Error)?.message ?? e);
          throw new Stop(`Your agent wallet's NEAR account sent ${sAmount} to Rook's contract (transaction ${f.tx_hash}), but Rook couldn't read the contract task it made: ${why}. Rook's contract holds the USDC, unless it refused it and sent it back to that account, from where Rook moves it into your agent wallet. So that it is never funded twice, this plan stops here: check that transaction, then send the task again.`);
        });
      if (!made.found) {
        returned = !!made.refunded;
        throw new Stop(made.refunded
          ? `Rook's contract refused the transfer (${made.refunded}), so the USDC went back. ${ON_NATIVE}`
          : `Rook couldn't find the contract task transaction ${f.tx_hash} made. Nothing runs until that is checked.`);
      }
      try {
        // A chain-gateway blip here must not end the funding: the USDC is already in the contract task.
        await retried(() => d.bind(t, made.task_id, w.near_account_id), d, t.shutdown.signal);
      } catch (e) {
        if (t.shutdown.signal.aborted) throw e;
        // No run will ever close this contract task, and the wallet's NEAR account may only call USDC, so it can't close
        // it either: Rook closes it (the orchestrator may), and the contract refunds the whole budget to that account,
        // where the sweep picks it up. One try: a close that failed on chain is not one to repeat blindly.
        const why = isTerminal(t.status) ? 'the task was stopped' : (e as Error).message;
        const closed = await call(`${config.urls.chainGateway}/close`, { task_id: made.task_id }).then(() => true, (x) => {
          console.error(`[wallet] close of unbound contract task ${made.task_id}:`, (x as Error)?.message ?? x);
          return false;
        });
        returned = closed;
        throw new Stop(closed
          ? `The USDC reached Rook's contract as task ${made.task_id}, but the run could not start: ${why}. Rook closed that contract task, which sent the USDC back to your agent wallet's NEAR account; Rook moves it back into your agent wallet.`
          : `Rook's contract holds the USDC as task ${made.task_id}, funded by your agent wallet's NEAR account, but the run could not start: ${why}. Rook's operator can close that contract task to send it back.`);
      }
      f.state = 'bound';
      save();
      op('wallet_bound', { contract_task_id: made.task_id, tx_hash: f.tx_hash });
    }
  } catch (e) {
    if (t.shutdown.signal.aborted) return; // left at its step: the next start picks it up (index.ts)
    if (e instanceof Stop) return fail(e.message);
    // Where the money is when the funding ends half way: what the withdrawal may still move lands on the wallet's NEAR
    // account, and the sweep moves it back.
    const where = f.state === 'transferring' && f.tx_hash
      ? `The USDC was sent to Rook's contract (transaction ${f.tx_hash}): check it before funding this plan again.`
      : f.state === 'transferring' ? ON_NATIVE
      : f.withdraw_correlation_id ? 'If the withdrawal still goes through, Rook moves the USDC back into your agent wallet.' : IN_WALLET;
    if (signal.aborted) return fail(`Stopped before the USDC reached Rook's contract. ${where}`);
    console.error('[wallet] funding', (e as Error)?.message ?? e);
    fail(`Funding from your agent wallet stopped: ${e instanceof HttpError || e instanceof AgentApiError ? e.message : 'an unexpected error'}. ${where}`);
  }
}

/**
 * Moves USDC on an owner's agent wallet's native NEAR account back into its NEAR Intents balance (ft_transfer_call to
 * intents.near, msg the account to credit), where the policy guards it again. Never while one of the owner's fundings
 * is between the wallet and the contract: that USDC is on its way to a task. A fresh Idempotency-Key per sweep: the
 * amount is the balance just read, so a sweep sent twice fails on the second for want of USDC and moves nothing.
 */
export function createSweeper(d: Omit<FundDeps, 'bind'> & { nativeBalance: (account: string) => Promise<string | null> }) {
  const busy = new Set<string>();
  async function sweep(owner: string): Promise<void> {
    if (busy.has(owner)) return;
    busy.add(owner);
    try {
      const w = d.wallets.ready(owner);
      const own = [...d.tasks()].filter((t) => t.owner === owner && t.wallet_funding);
      if (!w || own.some(fundingActive)) return;
      const bal = BigInt((await d.nativeBalance(w.near_account_id)) ?? '0');
      if (bal <= 0n) return;
      const body = {
        receiver_id: USDC_CONTRACT, method_name: 'ft_transfer_call',
        args: { receiver_id: 'intents.near', amount: bal.toString(), msg: w.near_account_id }, gas: TGAS_100, deposit: '1',
      };
      let s = await d.api.nearCall(w.agent_id, w.grant.token, `rook:sweep:${randomUUID()}`, body);
      while (moving(s)) s = await settle(d.api, s.correlation_id, { deadlineMs: 10 * 60_000, gapMs: d.gapMs });
      const t = own.sort((a, b) => a.updated_at.localeCompare(b.updated_at)).at(-1);
      if (s.status !== 'SUCCESS') { console.error(`[wallet] sweep for ${owner}: ${s.failure_code ?? s.status}`); return; }
      if (t) emit(t, 'ledger', { op: 'wallet_swept', amount_atomic: bal.toString(), correlation_id: s.correlation_id }, undefined, true);
    } catch (e) {
      console.error(`[wallet] sweep for ${owner}:`, (e as Error)?.message ?? e);
    } finally {
      busy.delete(owner);
    }
  }
  return { sweep, pass: () => Promise.all(d.wallets.owners().map(sweep)).then(() => undefined) };
}
