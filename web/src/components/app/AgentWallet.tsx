'use client';

// The agent wallet's surfaces (docs/agent-wallet-plan.md): the spending rules on a plan, and the wallet panel (setup,
// balance, budget, approvals, deposit). The words and checks live in lib/agent-wallet.ts; these only lay them out.
import { useEffect, useId, useRef, useState } from 'react';
import { ActionButton } from '@/components/app/controls';
import {
  approvalLine, budgetLeftLine, depositProblem, depositTransaction, intentHeadline, parseDeposit, policyLines, rulesAskedLine, rulesSentence, setupSteps,
  USDC_MAINNET, walletReady,
} from '@/lib/agent-wallet';
import { isWalletCancel, usdc } from '@/lib/funding';
import { detail } from '@/lib/errors';
import type { AgentWalletView, OwnerIntentView, SpendingRules } from '@/lib/server/orchestrator';
import { useAgentWallet, WalletStepError, type SetupFrom } from '@/hooks/agent-wallet';
import { useMode } from '@/hooks/mode';
import { useWallet } from '@/hooks/wallet';

/** A wallet that was closed or declined is a choice; anything else is said as it is. */
const problem = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return isWalletCancel(m) ? null : detail(m) || 'Your wallet gave no reason.';
};
const whole = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
const day = (iso: string | null | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
};

/**
 * A plan's spending rules (Plan.spending): what Rook may spend in plain words, and the policy each rule becomes, before
 * any signature. Once the owner has an agent wallet, its rules are the ones that apply: the card shows those, and says
 * so when the message asks for others. Nothing shows when the services have no Agent API key. `primary`: setting up
 * the wallet is this message's main action (a message that only states rules).
 */
export function SpendingRulesCard({ taskId, rules, open, primary = false }: { taskId: string; rules: SpendingRules; open: boolean; primary?: boolean }) {
  const { view, openPanel } = useAgentWallet();
  if (!view?.configured) return null;
  const exists = view.status !== 'none';
  const shown = (exists && view.rules) || rules;
  const asked = exists && view.rules ? rulesAskedLine(rules, view.rules) : null;
  return (
    <section className="mt-3 rounded-2xl border border-ink/15 p-4" aria-label="Spending rules">
      <p className="font-medium">{exists && view.rules ? "Your agent wallet's spending rules" : 'Spending rules'}</p>
      <p className="mt-1">{rulesSentence(shown)}</p>
      <ul className="mt-2 space-y-1 text-sm text-ink/65">
        {policyLines(shown).map((l) => (
          <li key={l.field} className="pl-4 -indent-3">• {l.text} <span className="font-mono text-xs text-ink/50">{l.field}</span></li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-ink/65">
        Each task&apos;s budget is withdrawn under these rules to the wallet&apos;s own NEAR account, then sent from there to the Rook contract.
      </p>
      {asked && <p className="mt-2 text-sm">{asked}</p>}
      {open && !walletReady(view) && view.status !== 'frozen' && (
        <div className="mt-3 flex flex-wrap gap-3">
          <ActionButton primary={primary} onClick={() => openPanel({ task_id: taskId, rules })}>{exists ? 'Finish setting up your agent wallet' : 'Set up an agent wallet with these rules'}</ActionButton>
        </div>
      )}
    </section>
  );
}

/** The intent the owner is about to sign: Rook's preview first, then the wallet opens on one click. */
function IntentReview({ intent, owner, busy, onSign, onBack }: { intent: OwnerIntentView; owner: string | null; busy: boolean; onSign: () => void; onBack: () => void }) {
  return (
    <div className="mt-4 rounded-2xl border border-ink/15 p-4">
      <p className="text-sm text-ink/65">You&apos;re about to sign</p>
      <p className="mt-1 font-medium">{intentHeadline(intent.type, owner)}</p>
      {intent.summary && <p className="mt-1 text-sm text-ink/65">The Agent API describes it as: {whole(intent.summary)}</p>}
      {intent.policy != null && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-ink/70">The policy, as the wallet gets it</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-ink/5 p-3 font-mono text-xs whitespace-pre-wrap break-all">{JSON.stringify(intent.policy, null, 2)}</pre>
        </details>
      )}
      <p className="mt-2 text-sm text-ink/65">
        {intent.intent.standard === 'nep366' ? 'Your wallet signs it, and the Agent API pays the gas.' : 'Your wallet signs a message: nothing is sent and no gas is paid.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <ActionButton primary onClick={onSign} busy={busy}>{busy ? 'Check your wallet…' : 'Sign with your wallet'}</ActionButton>
        <ActionButton onClick={onBack} disabled={busy}>Back</ActionButton>
      </div>
    </div>
  );
}

/**
 * The wallet panel, a modal dialog like the delete dialog: Escape or a click outside closes it. Setup is three steps,
 * one signature each, each shown before the wallet opens; then the balance, the budget left, the spends waiting for a
 * vote, and a deposit from the owner's NEAR wallet.
 */
export function AgentWalletDialog() {
  const agent = useAgentWallet();
  const wallet = useWallet();
  const { mode, network } = useMode();
  const dialog = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const { view, panel } = agent;
  const [intent, setIntent] = useState<OwnerIntentView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const open = panel.open && !!view?.configured;

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) { setError(null); setNote(null); setIntent(null); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);

  // Escape closes this dialog only: the capture phase keeps it from also closing the sidebar drawer behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (!busy) agent.closePanel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, busy, agent]);

  async function run(key: string, step: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNote(null);
    try { await step(); } catch (e) { const p = problem(e); if (p) setError(whole(p)); } finally { setBusy(null); }
  }

  const prepareStep = (type: 'agent_create' | 'policy_update' | 'grant_issue', from: SetupFrom | null) => run('prepare', async () => {
    setIntent(await agent.prepare(type === 'agent_create' ? { type, task_id: from!.task_id } : { type }));
  });
  const signIntent = () => run('sign', async () => {
    if (!intent) return;
    // Rook refused the signature (the intent expired, say): the step's own button prepares a fresh one. A wallet closed
    // or declined keeps this one, to sign again.
    const before = view?.next_step ?? null;
    let after: AgentWalletView;
    try { after = await agent.sign(intent); } catch (e) { if (e instanceof WalletStepError) setIntent(null); throw e; }
    setIntent(null);
    // The submit waits for the step to apply: say what it did, and what comes next. One still settling says so.
    const next = setupSteps(after).find((s) => s.state === 'current');
    setNote(after.next_step === 'ready' && before !== 'ready'
      ? 'Your agent wallet is ready. Deposit USDC to it, and Rook can fund tasks from it.'
      : after.next_step !== before && next ? `Done. Next step: ${next.label}.`
        : 'Signed. The Agent API is still applying it; this panel updates on its own.');
    await agent.refresh();
  });
  const vote = (approval_id: string, verdict: 'approve' | 'reject') => run(`${verdict}:${approval_id}`, async () => {
    await agent.vote(approval_id, verdict);
    setNote(verdict === 'approve' ? 'Approved. Rook goes on with the task.' : 'Rejected. Nothing was spent.');
  });
  const token = mode?.usdc ?? (network === 'mainnet' ? USDC_MAINNET : null);
  const deposit = () => run('deposit', async () => {
    const a = parseDeposit(amount);
    if (!a.ok) { setError(a.error); return; }
    if (!token || !view?.near_account_id) return;
    const outcome = await wallet.sendTransaction(depositTransaction(token, view.near_account_id, a.atomic));
    const why = depositProblem(outcome);
    if (why) { setError(`The deposit didn't go through: ${why}.`); return; }
    setAmount('');
    setNote(`Sent ${usdc(a.atomic)} USDC. It shows in the balance within a minute.`);
    await agent.refresh();
  });

  const ready = walletReady(view);
  const rules = view?.rules ?? panel.from?.rules ?? null;
  const steps = view ? setupSteps(view) : [];

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${uid}-title`}
      onCancel={(e) => { e.preventDefault(); if (!busy) agent.closePanel(); }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) agent.closePanel(); }}
      className="rook-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100%-2rem))] overflow-y-auto rounded-2xl border border-ink/15 bg-surface p-0 text-ink shadow-2xl shadow-ink/20"
    >
      {view?.configured && (
        <div className="p-5">
          <h2 id={`${uid}-title`} className="text-lg font-medium tracking-[-0.01em]">Your agent wallet</h2>
          <p className="mt-1 text-sm text-ink/65">A NEAR Intents wallet you own. Rook funds tasks from it only within your spending rules, and you can see every spend.</p>

          {rules && <p className="mt-3">{rulesSentence(rules)}</p>}

          {view.status === 'frozen' && <p className="mt-3 text-alert">This wallet is frozen, so Rook can&apos;t spend from it.</p>}

          {!ready && view.status !== 'frozen' && (
            <>
              {!rules && view.status === 'none' && (
                <p className="mt-3">
                  Tell Rook how it may spend in a chat message, like “Only spend $1000, and every spend comes to me for approval.” The plan then shows your
                  rules, and you can set up the wallet from there.
                </p>
              )}
              <ol className="mt-4 space-y-2">
                {steps.map((s, i) => (
                  <li key={s.step} className={`flex items-center gap-3 ${s.state === 'todo' ? 'text-ink/50' : ''}`}>
                    <span className={`grid size-6 shrink-0 place-items-center rounded-full text-xs ${s.state === 'done' ? 'bg-accent text-on-accent' : 'border border-ink/25'}`} aria-hidden="true">
                      {s.state === 'done' ? '✓' : i + 1}
                    </span>
                    <span>{s.label}<span className="sr-only">{s.state === 'done' ? ', done' : s.state === 'current' ? ', next' : ''}</span></span>
                  </li>
                ))}
              </ol>
              {view.status === 'pending' ? (
                <p role="status" className="mt-4 text-ink/65">Your wallet is being set up on NEAR. This takes up to a minute.</p>
              ) : intent ? (
                <IntentReview intent={intent} owner={wallet.account} busy={busy === 'sign'} onSign={() => void signIntent()} onBack={() => setIntent(null)} />
              ) : (() => {
                const current = steps.find((s) => s.state === 'current');
                if (!current) return null;
                const needsPlan = current.type === 'agent_create' && !panel.from;
                if (needsPlan && rules) return <p className="mt-4 text-sm text-ink/65">Open a plan with spending rules to create the wallet from it.</p>;
                if (needsPlan) return null;
                return (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <ActionButton primary onClick={() => void prepareStep(current.type as 'agent_create' | 'policy_update' | 'grant_issue', panel.from)} busy={busy === 'prepare'}>
                      {busy === 'prepare' ? 'Preparing…' : current.label}
                    </ActionButton>
                  </div>
                );
              })()}
            </>
          )}

          {(ready || view.status === 'frozen') && (
            <div className="mt-4 space-y-3">
              <div>
                <p className="text-sm text-ink/65">Balance</p>
                <p className="text-2xl font-medium tabular-nums">{usdc(view.balance_atomic ?? '0')} USDC</p>
                {/^\d+$/.test(view.native_balance_atomic ?? '') && BigInt(view.native_balance_atomic!) > 0n && (
                  <p className="text-sm text-ink/65">Plus {usdc(view.native_balance_atomic!)} USDC on its NEAR account, on its way to a task or back into the wallet.</p>
                )}
              </div>
              {view.budget && (
                <p className="text-sm">{budgetLeftLine(view.budget)}{day(view.budget.resets_at) ? ` It resets on ${day(view.budget.resets_at)}.` : ''}</p>
              )}
              {view.grant && day(view.grant.expires_at) && <p className="text-sm text-ink/65">Rook&apos;s spending key lasts until {day(view.grant.expires_at)}.</p>}
              {view.near_account_id && <p className="text-sm text-ink/65">Its account: <span className="font-mono break-all">{view.near_account_id}</span></p>}
            </div>
          )}

          {view.pending_approvals.length > 0 && (
            <div className="mt-5">
              <p className="font-medium">Waiting for your approval</p>
              <ul className="mt-2 space-y-3">
                {view.pending_approvals.map((a) => (
                  <li key={a.approval_id} className="rounded-xl border border-ink/15 p-3">
                    <p>{approvalLine(a)}{a.task_id && <> <a href={`/app/${a.task_id}`} className="underline decoration-ink/30 underline-offset-2 hover:decoration-ink">Open the task</a></>}</p>
                    <div className="mt-2 flex flex-wrap gap-3">
                      <ActionButton primary onClick={() => void vote(a.approval_id, 'approve')} busy={busy === `approve:${a.approval_id}`} disabled={!!busy}>Approve</ActionButton>
                      <ActionButton onClick={() => void vote(a.approval_id, 'reject')} busy={busy === `reject:${a.approval_id}`} disabled={!!busy}>Reject</ActionButton>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {ready && token && view.near_account_id && (
            <form className="mt-5" onSubmit={(e) => { e.preventDefault(); void deposit(); }}>
              <label htmlFor={`${uid}-amount`} className="font-medium">Deposit USDC</label>
              <p className="text-sm text-ink/65">From {wallet.account} to your agent wallet. Your wallet opens to confirm.</p>
              <div className="mt-2 flex flex-wrap gap-3">
                <input id={`${uid}-amount`} inputMode="decimal" autoComplete="off" placeholder="25.00" value={amount} onChange={(e) => setAmount(e.target.value)}
                  className="min-h-11 w-32 grow rounded-full border border-ink/25 bg-transparent px-4 tabular-nums focus-visible:border-ink focus-visible:outline-none" />
                <ActionButton submit busy={busy === 'deposit'} disabled={!!busy && busy !== 'deposit'}>{busy === 'deposit' ? 'Check your wallet…' : 'Deposit'}</ActionButton>
              </div>
            </form>
          )}

          {error && <p role="alert" className="mt-4 text-sm text-alert">{error}</p>}
          {note && <p role="status" className="mt-4 text-sm text-ink/80">{note}</p>}

          <div className="mt-5 flex justify-end">
            <ActionButton onClick={() => agent.closePanel()} disabled={!!busy}>Close</ActionButton>
          </div>
        </div>
      )}
    </dialog>
  );
}
