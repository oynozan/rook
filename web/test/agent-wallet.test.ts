// The agent wallet as the page shows it (docs/agent-wallet-plan.md): spending rules in plain words and the policy they
// become, setup steps, funding from the wallet, the run's wallet lines, and the signed_data the owner's wallet makes
// (references/owner-intents.md "Browser signing"). Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import {
  approvalLine, budgetLeftLine, cleanRules, depositProblem, depositTransaction, intentHeadline, intentViewOf, nep366Request, nep413Request, parseDeposit, parseIntentAsk,
  rulesAsked, rulesAskedLine, rulesReplyLead, walletStopped,
  planRules, policyLines, rulesSentence, sameRules, setupSteps, signedNep366, signedNep413, walletEventLine, walletFundable, walletFundingLine,
  walletFundingLive, walletReady, walletReason, walletViewOf, USDC_MAINNET,
} from '@/lib/agent-wallet';
import { feedFrom } from '@/lib/feed';
import { payloadHash, signatureValid } from '@/lib/nep413';
import type { AgentWalletView, OwnerIntentView } from '@/lib/server/orchestrator';

const ready = (over: Partial<AgentWalletView> = {}): AgentWalletView => ({
  configured: true, owner: 'ozan.near', agent_id: 'agt_1', near_account_id: 'a'.repeat(64), status: 'active', next_step: 'ready',
  rules: { budget_usd: 1000, period: 'month', approval: 'every' }, policy: null, balance_atomic: '25000000', native_balance_atomic: '0',
  budget: { period: 'month', limit_usd: 1000, spent_usd: 12.5, remaining_usd: 987.5, resets_at: '2026-12-01T00:00:00Z' },
  grant: { grant_id: 'grt_1', expires_at: '2027-11-12T00:00:00Z' }, pending_approvals: [], ...over,
});

test("the user's own words become rules said back plainly: \"Only spend $1000, make sure all transactions come to me for approval\"", () => {
  const rules = { budget_usd: 1000, period: 'month' as const, approval: 'every' as const };
  assert.equal(rulesSentence(rules), 'Rook may spend up to 1,000 USDC a month from your agent wallet. Every spend waits for your approval.');
  assert.equal(rulesSentence({ budget_usd: 50, period: 'day', per_task_max_usd: 2.5, expires_days: 14 }),
    "Rook may spend up to 50 USDC a day from your agent wallet. No task gets more than 2.50 USDC. Spends within these limits go ahead without asking you. Rook's permission to spend ends after 14 days.");
  // "Only spend $1000" with no period is a monthly budget (the API's budget has no lifetime total).
  assert.match(rulesSentence({ budget_usd: 1000 }), /1,000 USDC a month/);
  assert.match(rulesSentence({ approval: 'every' }), /^Rook may spend what your agent wallet holds, with no budget per period\./);
});

test('each rule shows the policy field it sets, before any signature', () => {
  const lines = policyLines({ budget_usd: 1000, period: 'week', per_task_max_usd: 20, approval: 'every', expires_days: 30 });
  assert.deepEqual(lines.map((l) => l.field), [
    'actions [withdraw], destinations only its own account', 'budget.weekly_usd 1000', 'limits.per_transaction 20.00 USDC', 'owner_approval true', 'grant expires_at',
  ]);
  assert.equal(lines[1].text, 'At most 1,000 USD a week');
  assert.equal(policyLines({ budget_usd: 5 }).find((l) => l.field.startsWith('owner_approval'))?.field, 'owner_approval false');
});

test("rules pass through the services' schema: anything else is dropped, none left is null", () => {
  assert.deepEqual(cleanRules({ budget_usd: 1000, period: 'year', approval: 'always', expires_days: 3.5, per_task_max_usd: -1, owner: 'evil.near' }), { budget_usd: 1000 });
  assert.equal(cleanRules({ budget_usd: 0 }), null);
  assert.equal(cleanRules('x'), null);
  assert.equal(planRules({ spending: { budget_usd: 2_000_000 } }), null); // above the schema's 1,000,000
  assert.equal(planRules(null), null);
  assert.ok(sameRules({ budget_usd: 1000 }, { budget_usd: 1000, period: 'month', approval: 'none' }));
  assert.ok(!sameRules({ budget_usd: 1000, approval: 'every' }, { budget_usd: 1000 }));
  assert.ok(sameRules(null, null) && !sameRules(null, { budget_usd: 1 }));
});

test('setup is three signatures in order; no wallet starts at the first', () => {
  assert.deepEqual(setupSteps({ next_step: null }).map((s) => s.state), ['current', 'todo', 'todo']);
  assert.deepEqual(setupSteps({ next_step: 'issue_grant' }).map((s) => s.state), ['done', 'done', 'current']);
  assert.deepEqual(setupSteps({ next_step: 'ready' }).map((s) => s.state), ['done', 'done', 'done']);
  assert.deepEqual(setupSteps({ next_step: 'create' }).map((s) => [s.label, s.type]), [
    ['Create your agent wallet', 'agent_create'], ['Allow Rook to fund tasks from it', 'policy_update'], ['Give Rook its spending key', 'grant_issue'],
  ]);
});

test('a plan is offered to the agent wallet only when it is set up and can cover it; otherwise why, or nothing at all', () => {
  assert.deepEqual(walletFundable(ready(), '3000000'), { ok: true });
  // Not configured, not set up: nothing of it shows (no dead button, no sentence).
  assert.deepEqual(walletFundable(ready({ configured: false }), '3000000'), { ok: false, why: null });
  assert.deepEqual(walletFundable(ready({ next_step: 'issue_grant' }), '3000000'), { ok: false, why: null });
  assert.deepEqual(walletFundable(null, '3000000'), { ok: false, why: null });
  assert.ok(!walletReady(ready({ status: 'pending' })));
  assert.equal((walletFundable(ready({ balance_atomic: '1000000' }), '3000000') as { why: string }).why,
    'Your agent wallet holds 1.00 USDC; this plan needs 3.00 USDC. Deposit USDC to it first.');
  assert.equal((walletFundable(ready({ budget: { period: 'month', limit_usd: 1000, spent_usd: 998, remaining_usd: 2, resets_at: null } }), '3000000') as { why: string }).why,
    'Your agent wallet has 2 USD of its budget left this month; this plan needs 3.00 USDC.');
  assert.equal((walletFundable(ready({ rules: { per_task_max_usd: 2 } }), '3000000') as { why: string }).why,
    "This plan's 3.00 USDC is more than the 2 USDC your rules allow per task.");
  assert.match((walletFundable(ready({ status: 'frozen' }), '3000000') as { why: string }).why, /frozen/);
});

test("the wallet's numbers in lines", () => {
  assert.equal(budgetLeftLine(ready().budget!), '987.50 of 1,000 USD left this month.');
  assert.equal(approvalLine({ approval_id: 'apr_1', task_id: 't_1', amount_atomic: '3000000', created_at: '', expires_at: null }), 'Spend 3.00 USDC to fund a task.');
});

test('a deposit registers the wallet account on USDC, then is ft_transfer_call to NEAR Intents crediting it, 1 yocto', () => {
  const acct = 'b'.repeat(64);
  assert.deepEqual(depositTransaction(USDC_MAINNET, acct, '25000000'), {
    receiverId: USDC_MAINNET,
    actions: [{ type: 'FunctionCall', params: { methodName: 'storage_deposit', args: { account_id: acct, registration_only: true }, gas: '30000000000000', deposit: '1250000000000000000000' } }, { type: 'FunctionCall', params: { methodName: 'ft_transfer_call', args: { receiver_id: 'intents.near', amount: '25000000', msg: acct }, gas: '100000000000000', deposit: '1' } }],
  });
  assert.deepEqual(parseDeposit('25,5'), { ok: true, atomic: '25500000' });
  assert.deepEqual(parseDeposit('0'), { ok: false, error: 'Enter an amount of USDC above 0, like 25.00.' });
  assert.equal(depositProblem({ status: { SuccessValue: '' }, receipts_outcome: [] }), null);
  assert.equal(depositProblem({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } } } } } }),
    "your wallet doesn't hold enough USDC");
  assert.match(depositProblem({ status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { executor_id: 'intents.near', status: { Failure: {} } } }] })!, /NEAR Intents turned the deposit down/);
});

test("a task's funding from the wallet, step by step, in the run's words", () => {
  const f = { agent_id: 'agt_1', amount_atomic: '3000000' };
  assert.deepEqual(walletFundingLine({ ...f, state: 'withdrawing' }), { text: 'Withdrawing 3.00 USDC from your agent wallet.', tone: 'normal', working: true, approval_id: null });
  assert.deepEqual(walletFundingLine({ ...f, state: 'awaiting_approval', approval_id: 'apr_9' }),
    { text: 'Waiting for your approval to spend 3.00 USDC from your agent wallet.', tone: 'normal', working: false, approval_id: 'apr_9' });
  assert.equal(walletFundingLine({ ...f, state: 'transferring' }).text, 'Sending the 3.00 USDC budget to Rook.');
  assert.equal(walletFundingLine({ ...f, state: 'bound' }).text, 'Funded with 3.00 USDC from your agent wallet.');
  const failed = walletFundingLine({ ...f, state: 'failed', error: 'withdraw refused: spend_budget_exceeded (403)' });
  assert.deepEqual([failed.tone, failed.text], ['alert', "Funding from your agent wallet stopped: your agent wallet's budget for this period is used up."]);
  assert.ok(walletFundingLive({ ...f, state: 'awaiting_approval' }) && !walletFundingLive({ ...f, state: 'bound' }) && !walletFundingLive({ ...f, state: 'failed' }) && !walletFundingLive(null));
});

test("the Agent API's refusals in plain words, by their code; anything else as it was said, made safe", () => {
  assert.equal(walletReason('policy_transaction_limit_exceeded'), 'it is more than your spending rules allow');
  assert.equal(walletReason('Agent API 409 intent_expired: The intent expired'), 'the signing window closed before the signature came back');
  assert.equal(walletReason('owner_key_not_full_access'), "your wallet signed with a limited key; the agent wallet needs one of the account's full-access keys");
  assert.equal(walletReason('approval rejected by the owner'), 'you turned the spend down');
  assert.equal(walletReason('POST http://127.0.0.1:7100/x -> 500'), 'the orchestrator (POST /x) answered HTTP 500');
  assert.equal(walletReason(''), 'no reason was given');
});

test("the run's activity words the wallet's events, and shows Rook's raw failure only as the tooltip", () => {
  assert.equal(walletEventLine('wallet_withdraw', { amount_atomic: '3000000' })?.text, 'Withdrew 3.00 USDC from your agent wallet.');
  assert.equal(walletEventLine('wallet_approval_needed', { amount_atomic: '3000000' })?.text, 'Asked for your approval to spend 3.00 USDC from your agent wallet.');
  assert.equal(walletEventLine('wallet_transfer', { amount_atomic: '3000000' })?.text, 'Sent 3.00 USDC from your agent wallet to the Rook contract.');
  assert.equal(walletEventLine('wallet_bound', { amount_atomic: '3000000' })?.text, 'Rook checked the 3.00 USDC funding from your agent wallet against the plan, so the run starts.');
  assert.equal(walletEventLine('wallet_bound', {})?.text, 'Rook checked the funding from your agent wallet against the plan, so the run starts.');
  assert.equal(walletEventLine('wallet_swept', { amount_atomic: '1250000' })?.text, '1.25 USDC unspent went back into your agent wallet.');
  assert.equal(walletEventLine('wallet_swept', null)?.text, 'The unspent USDC went back into your agent wallet.');
  assert.equal(walletEventLine('wallet_something', {}), null);
  const lines = feedFrom([
    { seq: 1, type: 'wallet_withdraw', data: { amount_atomic: '3000000' } },
    { seq: 2, type: 'wallet_failed', data: { error: 'native call refused: wallet_frozen' } },
  ], { titles: new Map(), selfDo: new Set(), free: false, simNote: '' });
  assert.deepEqual(lines.map((l) => [l.text, l.tone, l.detail]), [
    ['Withdrew 3.00 USDC from your agent wallet.', 'muted', undefined],
    ['Funding from your agent wallet stopped: your agent wallet is frozen.', 'alert', 'native call refused: wallet_frozen'],
  ]);
});

// ---- signing ----

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf: Buffer) => {
  let n = BigInt(`0x${buf.toString('hex') || '0'}`), out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b) break; out = `1${out}`; }
  return out;
};

test('nep413: the base64 nonce becomes the 32 bytes NEP-413 signs, so a real signature over it verifies', () => {
  const nonce = Buffer.alloc(32, 7);
  const intent: OwnerIntentView['intent'] = { standard: 'nep413', payload: { message: '{"type":"grant_issue"}', recipient: 'api.agentsonintents.com', nonce: nonce.toString('base64') } };
  const req = nep413Request(intent.payload);
  assert.deepEqual(Buffer.from(req.nonce), nonce);
  assert.equal(req.message, '{"type":"grant_issue"}');
  // What a wallet does with it: ed25519 over sha256(borsh(NEP-413 payload)).
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const signature = sign(null, payloadHash(req.message, Buffer.from(req.nonce), req.recipient), privateKey).toString('base64');
  const signed = signedNep413(intent, { publicKey: `ed25519:${b58(raw)}`, signature, accountId: 'ozan.near' } as never);
  // signed_data is the intent exactly as generated (the payload untouched, its nonce still base64) plus the key and signature.
  assert.deepEqual(signed, { standard: 'nep413', payload: intent.payload, public_key: `ed25519:${b58(raw)}`, signature });
  assert.ok(signatureValid({ publicKey: signed.public_key, signature: signed.signature, message: req.message, nonce: Buffer.from(req.nonce), recipient: req.recipient }));
  assert.throws(() => nep413Request({ message: 'm', recipient: 'r', nonce: Buffer.alloc(16).toString('base64') }), /32 bytes/);
  assert.throws(() => nep413Request({ message: 'm', recipient: 'r' }), /not a NEP-413 message/);
  assert.throws(() => signedNep413(intent, {}), /no signature/);
});

test('nep366: the payload goes to signDelegateActions as it is, and its first signed delegate is submitted', () => {
  const payload = { receiverId: 'v1.custody.near', actions: [{ type: 'FunctionCall', params: { methodName: 'create_agent', args: { policy: {} }, gas: '30000000000000', deposit: '0' } }] };
  const intent: OwnerIntentView['intent'] = { standard: 'nep366', payload };
  assert.equal(nep366Request(payload), payload);
  assert.deepEqual(signedNep366(intent, { signedDelegateActions: ['AAEC'] }), { standard: 'nep366', payload, signed_delegate: 'AAEC' });
  assert.throws(() => signedNep366(intent, { signedDelegateActions: [] }), /no signed delegate/);
  assert.throws(() => nep366Request({ receiverId: 'x', actions: [] }), /not a NEAR delegate action/);
});

// ---- what the routes take and pass on ----

test('the browser names a step, never an owner or rules: an agent_create names the plan its rules come from', () => {
  const key = `ed25519:${'1'.repeat(44)}`;
  assert.deepEqual(parseIntentAsk({ type: 'agent_create', task_id: 't_1', public_key: key, owner: 'evil.near', rules: { budget_usd: 999999 } }),
    { type: 'agent_create', task_id: 't_1', public_key: key });
  assert.deepEqual(parseIntentAsk({ type: 'grant_issue', owner: 'evil.near' }), { type: 'grant_issue' });
  assert.deepEqual(parseIntentAsk({ type: 'approval_vote', approval_id: 'apr_1', verdict: 'reject' }), { type: 'approval_vote', approval_id: 'apr_1', verdict: 'reject' });
  assert.ok('error' in parseIntentAsk({ type: 'agent_delete' }));
  assert.ok('error' in parseIntentAsk({ type: 'agent_create', task_id: 't_1' })); // no key
  assert.ok('error' in parseIntentAsk({ type: 'approval_vote', approval_id: 'apr_1', verdict: 'maybe' }));
  assert.ok('error' in parseIntentAsk(null));
});

test('the wallet and an intent reach the page with only the fields the page reads: a grant token never passes', () => {
  const v = walletViewOf({ ...ready(), owner: 'someone.else', grant_token: 'ngt_secret', grant: { grant_id: 'grt_1', expires_at: 'x', token: 'ngt_secret' }, api_key: 'k' }, 'ozan.near');
  assert.equal(v.owner, 'ozan.near');
  assert.doesNotMatch(JSON.stringify(v), /ngt_secret|api_key/);
  assert.deepEqual(Object.keys(v).sort(), [
    'agent_id', 'balance_atomic', 'budget', 'configured', 'grant', 'native_balance_atomic', 'near_account_id', 'next_step', 'owner', 'pending_approvals', 'policy', 'rules', 'status',
  ]);
  assert.equal(walletViewOf({}, 'ozan.near').configured, false);
  const i = intentViewOf({ correlation_id: 'intent_1', type: 'grant_issue', intent: { standard: 'nep413', payload: { a: 1 } }, summary: 'Issue a grant', expires_at: 'e', credential_token: 'ngt_secret' });
  assert.doesNotMatch(JSON.stringify(i), /ngt_secret/);
  assert.deepEqual(i.intent, { standard: 'nep413', payload: { a: 1 } });
});

test("a funding the services stopped reads as the services wrote it, once, with where the money is", () => {
  // Browser QA 2026-11-12: "Funding from your agent wallet stopped: Funding from your agent wallet stopped: …".
  const said = 'Funding from your agent wallet stopped: an unexpected error. Your USDC is still in your agent wallet.';
  assert.equal(walletStopped(said), said);
  const rejected = "You rejected this spend, so Rook didn't fund the task. Your USDC is still in your agent wallet.";
  assert.equal(walletFundingLine({ agent_id: 'a', amount_atomic: '1', state: 'failed', error: rejected }).text, rejected);
  assert.equal(walletEventLine('wallet_failed', { message: rejected })?.text, rejected);
  assert.equal(walletStopped('native call refused: wallet_frozen'), 'Funding from your agent wallet stopped: your agent wallet is frozen.');
  assert.equal(walletStopped(''), 'Funding from your agent wallet stopped: no reason was given.');
});

test('a later message asking for other rules than the wallet has says so; one it leaves out, or repeats, is no difference', () => {
  const wallet = { budget_usd: 1000, approval: 'every' as const };
  assert.deepEqual(rulesAsked({ approval: 'every' }, wallet), []);
  assert.equal(rulesAskedLine({ approval: 'every' }, wallet), null);
  assert.deepEqual(rulesAsked({ budget_usd: 1000, period: 'month' }, wallet), []);
  assert.deepEqual(rulesAsked({ budget_usd: 5 }, wallet), ['at most 5 USDC a month']);
  assert.deepEqual(rulesAsked({ budget_usd: 1000, period: 'week' }, wallet), ['at most 1,000 USDC a week']);
  assert.equal(rulesAskedLine({ approval: 'none', per_task_max_usd: 20, expires_days: 14 }, wallet),
    "This message asks for at most 20 USDC per task, no approval within the limits and Rook's permission ending after 14 days, but your agent wallet keeps the rules it was created with.");
});

test("Rook's answer to a rules-only message follows the wallet: set it up, finish it, it is set up, or there is none here", () => {
  const v = (x: object) => walletViewOf({ configured: true, ...x }, 'alice.near');
  assert.match(rulesReplyLead(null), /^These are the spending rules Rook will follow\. Set up your agent wallet/);
  assert.match(rulesReplyLead(v({ status: 'none' })), /Set up your agent wallet with them/);
  assert.match(rulesReplyLead(v({ status: 'active', next_step: 'issue_grant' })), /Finish setting up your agent wallet/);
  assert.equal(rulesReplyLead(v({ status: 'active', next_step: 'ready' })), 'Your agent wallet is set up, so Rook funds your next tasks from it, under its rules.');
  assert.match(rulesReplyLead(walletViewOf({ configured: false }, 'alice.near')), /^Rook noted these spending rules\. This Rook server has no agent wallet/);
});

test('each setup signature is said in Rook\'s words before the wallet opens', () => {
  assert.equal(intentHeadline('agent_create', 'alice.near'), 'Create an agent wallet owned by alice.near, with these spending rules as its policy.');
  assert.match(intentHeadline('policy_update', 'alice.near'), /its own NEAR account/);
  assert.match(intentHeadline('grant_issue', null), /^Give Rook a spending key/);
});
