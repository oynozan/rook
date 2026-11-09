// The browser's funding step: the transfer it asks the wallet to send, and reading the contract's answer from the
// outcome. Outcomes are shaped like NEAR RPC FinalExecutionOutcome; the logs are the budget contract's own formats
// (contract/budget/src/lib.rs: emit() and ft_on_transfer's refund log). Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  balanceProblem, closeTaskTransaction, confirmFailure, fetchTxOutcome, fundingFrom, fundingLoadReason, fundingMismatch, fundingTerms, fundingTransaction, isWalletCancel,
  moneyMoved, plainReason, planTerms, readCloseOutcome, readFundingOutcome, readUsdcBalance, termsOf, txHashOf, typedUsdc, usdc, whoseTransfer, untilFinal, type Funding,
} from './funding';

const F: Funding = {
  contract_id: 'rook.near', usdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', network: 'mainnet',
  amount_atomic: '3000000', msg: JSON.stringify({ create_task: { reserve_bps: 2000, caps: ['1000000', '800000'] } }), funder: 'ops.near',
};

const event = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'rook', version: '1.0.0', event, data: [data] })}`;
const outcome = (receipts: { executor_id: string; logs: string[]; status?: unknown }[], status: unknown = { SuccessValue: '' }) => ({
  status,
  transaction: { hash: '9xQ1oFz3pW7Zb6cQx6m3c7cR8mN4m2Qe5yVfK1sLdTzA', signer_id: 'ops.near', receiver_id: F.usdc },
  transaction_outcome: { id: '9xQ1oFz3pW7Zb6cQx6m3c7cR8mN4m2Qe5yVfK1sLdTzA', outcome: { logs: [] } },
  receipts_outcome: receipts.map((r, i) => ({ id: `r${i}`, outcome: { executor_id: r.executor_id, logs: r.logs, status: r.status ?? { SuccessValue: '' } } })),
});

test('USDC amounts show what really moves: at least 2 decimals, up to 6, no float rounding', () => {
  assert.equal(usdc('3000000'), '3.00');
  assert.equal(usdc('2999000'), '2.999'); // never "3.00" while the wallet sends 2.999
  assert.equal(usdc('5000'), '0.005'); // a sub-cent price is not "0.00"
  assert.equal(usdc('855000'), '0.855');
  assert.equal(usdc('1500000'), '1.50');
  assert.equal(usdc('100000'), '0.10');
  assert.equal(usdc('1'), '0.000001');
  assert.equal(usdc(0), '0.00');
  assert.equal(usdc(125000n), '0.125');
  assert.equal(usdc(2_130_000), '2.13'); // sums the page adds up as numbers
  assert.equal(usdc('9007199254740993000000'), '9007199254740993.00');
  assert.equal(usdc(-250000n), '-0.25');
  assert.equal(usdc('abc'), '?');
  // A budget as typed, before the task exists.
  assert.equal(typedUsdc('2.999'), '2.999');
  assert.equal(typedUsdc(' 3 '), '3.00');
  assert.equal(typedUsdc('03.5'), '3.50');
  assert.equal(typedUsdc('1,5'), '1,5');
});

test('the transfer: USDC ft_transfer_call to the contract with the approved msg, 1 yoctoNEAR, 100 Tgas', () => {
  assert.deepEqual(fundingTransaction(F), {
    receiverId: F.usdc,
    actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer_call', args: { receiver_id: 'rook.near', amount: '3000000', msg: F.msg }, gas: '100000000000000', deposit: '1' } }],
  });
});

test('terms: caps and the reserve the contract will compute', () => {
  assert.deepEqual(fundingTerms(F), { reserve_bps: 2000, caps: ['1000000', '800000'], reserve_atomic: '600000' });
  assert.equal(fundingTerms({ ...F, msg: '{"return":{}}' }), null);
  assert.equal(fundingTerms({ ...F, msg: 'nope' }), null);
  assert.equal(fundingTerms({ ...F, msg: JSON.stringify({ create_task: { reserve_bps: 2000, caps: [1000000] } }) }), null);
});

test('from: open funding names the signed-in funder; older orchestrators only sent the contract owner', () => {
  assert.equal(fundingFrom({ ...F, owner: undefined, funder: 'alice.near', contract_owner: 'ops.near' }), 'alice.near');
  assert.equal(fundingFrom(F), 'ops.near');
  assert.equal(fundingFrom({ ...F, owner: undefined, funder: null }), null); // a CLI task: whoever sends it funds it
});

test('close_task from the funder refunds a task Rook never ran: no deposit, 50 Tgas', () => {
  assert.deepEqual(closeTaskTransaction('rook.near', '1a'), {
    receiverId: 'rook.near',
    actions: [{ type: 'FunctionCall', params: { methodName: 'close_task', args: { task_id: '1a' }, gas: '50000000000000', deposit: '0' } }],
  });
});

test('reads the contract task id from task_created', () => {
  const o = outcome([
    { executor_id: F.usdc, logs: ['EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"ops.near","new_owner_id":"rook.near","amount":"3000000"}]}'] },
    { executor_id: 'rook.near', logs: [event('task_created', { task_id: '1a', funder: 'ops.near', budget: '3000000', reserve: '600000', caps: ['1000000', '800000'] })] },
    { executor_id: F.usdc, logs: [] },
  ]);
  assert.deepEqual(readFundingOutcome(o, 'rook.near'), { kind: 'created', task_id: '1a', funder: 'ops.near', budget: '3000000', reserve: '600000', caps: ['1000000', '800000'] });
  assert.equal(txHashOf(o), '9xQ1oFz3pW7Zb6cQx6m3c7cR8mN4m2Qe5yVfK1sLdTzA');
});

test('a contract task is this plan\'s funding only with its budget, reserve, caps and funder', () => {
  const created = { kind: 'created' as const, task_id: '1a', funder: 'ops.near', budget: '3000000', reserve: '600000', caps: ['1000000', '800000'] };
  const want = termsOf(F)!;
  assert.deepEqual(want, { budget: '3000000', reserve: '600000', caps: ['1000000', '800000'] });
  assert.equal(fundingMismatch(created, want, 'ops.near'), null);
  // The plan gives the same terms when the instructions aren't in: hired subtasks' caps in plan order.
  const sub = (cap_atomic: string, self_do = false) => ({ id: cap_atomic, title: 't', cap_atomic, self_do, criteria: [], candidates: [] });
  const plan = { subtasks: [sub('1000000'), sub('0', true), sub('800000')], budget: { reserve_atomic: '600000', allocated_atomic: '1800000' } };
  assert.deepEqual(planTerms('3000000', plan), want);

  // Another task's transfer, another account's, or a different plan: never this one.
  assert.match(fundingMismatch({ ...created, funder: 'alice.near' }, want, 'ops.near') ?? '', /sent by alice\.near, not ops\.near/);
  assert.match(fundingMismatch({ ...created, budget: '5000000' }, want, 'ops.near') ?? '', /budget is 5\.00 USDC, not 3\.00 USDC/);
  assert.match(fundingMismatch({ ...created, budget: '2999000' }, want, 'ops.near') ?? '', /budget is 2\.999 USDC, not 3\.00 USDC/);
  assert.match(fundingMismatch({ ...created, reserve: '0' }, want, 'ops.near') ?? '', /reserve is 0\.00 USDC/);
  assert.match(fundingMismatch({ ...created, caps: ['800000', '1000000'] }, want, 'ops.near') ?? '', /caps are 0\.80 USDC, 1\.00 USDC/);
  assert.match(fundingMismatch({ ...created, caps: null, funder: null }, want, 'ops.near') ?? '', /unnamed account.*caps are missing/);
});

test('while the page waits on its own transfer, no other pasted hash stands in for it', () => {
  assert.equal(whoseTransfer('H1', 'H1'), 'own');
  assert.equal(whoseTransfer('H2', 'H1'), 'other'); // its contract task may match the plan, but H1 would be forgotten
  assert.equal(whoseTransfer('H2', null), 'unsure'); // the wallet errored or returned no hash: the paste is all there is
});

test('a failed confirm offers the refund only when Rook will never run that contract task', () => {
  assert.equal(confirmFailure('contract task 1a does not match the approved plan: caps differ'), 'refund');
  assert.equal(confirmFailure('task is killed, funded needs approved'), 'refund');
  assert.equal(confirmFailure('task is cancelled, funded needs approved'), 'refund');
  // Another confirm is binding it, or has: a refund could cut the starting run short.
  assert.equal(confirmFailure('task t_1 or contract task 1a is already being checked'), 'refetch');
  assert.equal(confirmFailure('task is already funded by contract task 1a'), 'refetch');
  assert.equal(confirmFailure('contract task 1a already funds t_2'), 'refetch');
  assert.equal(confirmFailure('task is running, funded needs approved'), 'refetch');
  assert.equal(confirmFailure("This task's funding is already contract task 1a, so Rook won't confirm contract task 1b for it."), 'refetch');
  assert.equal(confirmFailure("Rook's services are unreachable right now. Try again in a minute."), 'retry');
  // Rook reads NEAR a few seconds behind the wallet: the contract task the transfer made isn't there for it yet.
  assert.equal(confirmFailure('no contract task 1a'), 'not_final');
});

test('a refund counts only with the contract\'s word for it', () => {
  const closed = (ok: boolean, task_id = '1a') => event('task_closed', { task_id, funder: 'ops.near', refund: '3000000', ok, deleted: ok });
  const value = (v: string) => ({ SuccessValue: btoa(v) });
  // close_task -> ft_transfer to the funder -> on_task_closed, which logs task_closed and returns true.
  const refunded = outcome([
    { executor_id: 'rook.near', logs: [], status: { SuccessReceiptId: 'r1' } },
    { executor_id: F.usdc, logs: [], status: value('') },
    { executor_id: 'rook.near', logs: [closed(true)], status: value('true') },
  ], value('true'));
  assert.deepEqual(readCloseOutcome(refunded, 'rook.near', '1a'), { kind: 'refunded', amount: '3000000' });

  // The refund transfer failed (say the wallet has no USDC storage): the contract kept the USDC, and returned false.
  const kept = outcome([
    { executor_id: 'rook.near', logs: [], status: { SuccessReceiptId: 'r1' } },
    { executor_id: F.usdc, logs: [], status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'The account ops.near is not registered' } } } } } },
    { executor_id: 'rook.near', logs: [closed(false)], status: value('false') },
  ], value('false'));
  assert.equal(readCloseOutcome(kept, 'rook.near', '1a').kind, 'refused');

  // The contract refused the close: already refunded and deleted, or a subtask still holds money.
  const panicked = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: unknown task' } } } } };
  assert.deepEqual(readCloseOutcome(outcome([{ executor_id: 'rook.near', logs: [], status: panicked }], panicked), 'rook.near', '1a'), { kind: 'refused', reason: 'Smart contract panicked: unknown task' });

  // No evidence: no outcome, no event, an event for another task, or one logged by another account.
  assert.deepEqual(readCloseOutcome(undefined, 'rook.near', '1a'), { kind: 'unknown' });
  assert.deepEqual(readCloseOutcome({ transaction: { hash: 'h' } }, 'rook.near', '1a'), { kind: 'unknown' });
  assert.deepEqual(readCloseOutcome(outcome([{ executor_id: 'rook.near', logs: [] }], value('true')), 'rook.near', '1a'), { kind: 'unknown' });
  assert.deepEqual(readCloseOutcome(outcome([{ executor_id: 'rook.near', logs: [closed(true, '1b')] }], value('true')), 'rook.near', '1a'), { kind: 'unknown' });
  assert.deepEqual(readCloseOutcome(outcome([{ executor_id: 'evil.near', logs: [closed(true)] }], value('true')), 'rook.near', '1a'), { kind: 'unknown' });
});

test('ignores a task_created logged by any other account', () => {
  const o = outcome([{ executor_id: 'evil.near', logs: [event('task_created', { task_id: '9' })] }]);
  assert.deepEqual(readFundingOutcome(o, 'rook.near'), { kind: 'unknown' });
});

test('ignores other standards, other events and malformed ids', () => {
  const o = outcome([{ executor_id: 'rook.near', logs: [
    'EVENT_JSON:{"standard":"nep141","event":"task_created","data":[{"task_id":"1"}]}',
    event('receipt', { task_id: '1' }),
    event('task_created', { task_id: 'X; drop' }),
    'EVENT_JSON:{not json',
  ] }]);
  assert.deepEqual(readFundingOutcome(o, 'rook.near'), { kind: 'unknown' });
});

test('a refused create_task: the contract logs why and the token refunds', () => {
  const o = outcome([{ executor_id: 'rook.near', logs: ['refunding 3000000: alice.near already has 5 open tasks'] }]);
  assert.deepEqual(readFundingOutcome(o, 'rook.near'), { kind: 'refunded', reason: 'alice.near already has 5 open tasks' });
});

test('ft_on_transfer panicked: the token refunds everything', () => {
  const o = outcome([{ executor_id: 'rook.near', logs: [], status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: only the USDC contract can call this' } } } } } }]);
  assert.deepEqual(readFundingOutcome(o, 'rook.near'), { kind: 'refunded', reason: 'Smart contract panicked: only the USDC contract can call this' });
});

test('a task_created logged by a contract receipt that then failed created nothing: the token refunded', () => {
  const failure = { Failure: { ActionError: { index: 0, kind: { LackBalanceForState: { account_id: 'rook.near', amount: '1000000000000000000000' } } } } };
  const created = event('task_created', { task_id: '1b', funder: 'ops.near', budget: '3000000' });
  const o = outcome([{ executor_id: F.usdc, logs: [] }, { executor_id: 'rook.near', logs: [created], status: failure }, { executor_id: F.usdc, logs: [] }]);
  const r = readFundingOutcome(o, 'rook.near');
  assert.equal(r.kind, 'refunded');
  assert.match((r as { reason: string }).reason, /LackBalanceForState/);
  // A receipt that returned a promise also succeeded.
  const later = outcome([{ executor_id: 'rook.near', logs: [created], status: { SuccessReceiptId: 'r9' } }]);
  assert.equal(readFundingOutcome(later, 'rook.near').kind, 'created');
});

test('the transfer itself failed: no USDC left the wallet', () => {
  const failure = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } } } } };
  const o = outcome([{ executor_id: F.usdc, logs: [], status: failure }], failure);
  assert.deepEqual(readFundingOutcome(o, 'rook.near'), { kind: 'failed', reason: "Smart contract panicked: The account doesn't have enough balance" });
});

test('no outcome from the wallet', () => {
  assert.deepEqual(readFundingOutcome(undefined, 'rook.near'), { kind: 'unknown' });
  assert.deepEqual(readFundingOutcome({ transaction: { hash: 'h' } }, 'rook.near'), { kind: 'unknown' });
  assert.equal(txHashOf(undefined), null);
  assert.equal(txHashOf({ transaction_outcome: { id: 'abc' } }), 'abc');
});

test('fetches the outcome by hash with the tx method, retrying while the node has not seen it', async () => {
  const bodies: any[] = [];
  let calls = 0;
  const fake = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    calls++;
    return new Response(JSON.stringify(calls === 1 ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } } : { result: { receipts_outcome: [] } }));
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchTxOutcome('http://rpc', 'H', 'ops.near', fake, 2), { receipts_outcome: [] });
  assert.equal(calls, 2);
  assert.deepEqual(bodies[0].params, { tx_hash: 'H', sender_account_id: 'ops.near', wait_until: 'EXECUTED_OPTIMISTIC' });
  assert.equal(bodies[0].method, 'tx');

  const never = (async () => new Response(JSON.stringify({ error: { cause: { name: 'INVALID_TRANSACTION' } } }))) as unknown as typeof fetch;
  await assert.rejects(fetchTxOutcome('http://rpc', 'H', 'ops.near', never, 3), /INVALID_TRANSACTION/);
});

test('a NEAR RPC that never answers the transaction read is given up on, never waited on forever', async () => {
  let calls = 0;
  const signals: unknown[] = [];
  const hung = (async (_url: string, init: RequestInit) => {
    signals.push(init.signal);
    if (++calls === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response(JSON.stringify({ result: { receipts_outcome: [] } }));
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchTxOutcome('http://rpc', 'H', 'ops.near', hung, 2), { receipts_outcome: [] });
  assert.equal(calls, 2); // the timed-out ask was made again
  assert.ok(signals.every((s) => s instanceof AbortSignal));
  const always = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as unknown as typeof fetch;
  await assert.rejects(fetchTxOutcome('http://rpc', 'H', 'ops.near', always, 2), /no answer in time/);
  // Any other failure to reach the node ends the read at once, as before.
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  await assert.rejects(fetchTxOutcome('http://rpc', 'H', 'ops.near', down, 3), /fetch failed/);
});

test('confirming retries only while the just-created contract task is not final yet', async () => {
  let n = 0;
  const lagging = async () => (++n < 3 ? { ok: false, message: 'no contract task 1a' } : { ok: true });
  assert.deepEqual(await untilFinal(lagging, 5, 1), { ok: true });
  assert.equal(n, 3);
  n = 0;
  const mismatch = async () => (++n, { ok: false, message: 'contract task 1a does not match the approved plan: caps differ' });
  assert.equal((await untilFinal(mismatch, 5, 1)).ok, false);
  assert.equal(n, 1);
  n = 0;
  const missing = async () => (++n, { ok: false, message: 'no contract task 1a' });
  assert.equal((await untilFinal(missing, 4, 1)).message, 'no contract task 1a');
  assert.equal(n, 4);
});

test('a task stopped before its funding was bound never ran, though the kill adds a ledger line', () => {
  const none = { ledger: null, receipts: [] };
  assert.equal(moneyMoved(none, []), false);
  assert.equal(moneyMoved(none, [{ type: 'task_status' }, { type: 'ledger', data: { op: 'kill' } }]), false);
  assert.equal(moneyMoved(none, [{ type: 'ledger', data: { op: 'restored' } }]), true);
  assert.equal(moneyMoved(none, [{ type: 'hire_sent' }]), true);
  assert.equal(moneyMoved({ ledger: null, receipts: [{}] }, []), true);
  assert.equal(moneyMoved({ ledger: { spent_atomic: '0' }, receipts: [] }, []), true);
});

test("reads the wallet's USDC balance and registration from NEAR before the wallet opens", async () => {
  const bodies: any[] = [];
  const rpc = (answers: Record<string, unknown>) => (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const a = answers[body.params.method_name];
    if (a instanceof Error) return new Response(JSON.stringify({ error: { cause: { name: a.message } } }));
    return new Response(JSON.stringify({ result: { result: [...new TextEncoder().encode(JSON.stringify(a))], logs: [] } }));
  }) as unknown as typeof fetch;

  const held = await readUsdcBalance('http://rpc', F.usdc, 'alice.near', rpc({ ft_balance_of: '2130000', storage_balance_of: { total: '1250000000000000000000', available: '0' } }));
  assert.deepEqual(held, { balance: 2_130_000n, registered: true });
  assert.deepEqual(bodies[0].params, {
    request_type: 'call_function', finality: 'optimistic', account_id: F.usdc, method_name: 'ft_balance_of', args_base64: btoa('{"account_id":"alice.near"}'),
  });
  assert.deepEqual(await readUsdcBalance('http://rpc', F.usdc, 'new.near', rpc({ ft_balance_of: '0', storage_balance_of: null })), { balance: 0n, registered: false });
  // No storage_balance_of on the token: only the balance counts.
  assert.deepEqual(await readUsdcBalance('http://rpc', F.usdc, 'alice.near', rpc({ ft_balance_of: '5', storage_balance_of: new Error('MethodNotFound') })), { balance: 5n, registered: true });
  // Can't read the balance: the caller lets the transfer go ahead.
  await assert.rejects(readUsdcBalance('http://rpc', F.usdc, 'alice.near', rpc({ ft_balance_of: new Error('UNKNOWN_ACCOUNT'), storage_balance_of: null })), /UNKNOWN_ACCOUNT/);
  // Every read has a deadline: an RPC that hangs fails the check (so the transfer goes ahead) instead of holding it.
  const signals: unknown[] = [];
  const hung = (async (_url: string, init: RequestInit) => {
    signals.push(init.signal);
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }) as unknown as typeof fetch;
  await assert.rejects(readUsdcBalance('http://rpc', F.usdc, 'alice.near', hung), /timeout/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((s) => s instanceof AbortSignal));

  // What the page says, before any signature.
  assert.equal(balanceProblem(held, '3000000', 'alice.near'), 'Your wallet holds 2.13 USDC; this plan needs 3.00 USDC. Add USDC or draft it again with a smaller budget.');
  assert.equal(balanceProblem(held, '2130000', 'alice.near'), null);
  assert.equal(balanceProblem({ balance: 5_000n, registered: true }, '2999000', 'alice.near'), 'Your wallet holds 0.005 USDC; this plan needs 2.999 USDC. Add USDC or draft it again with a smaller budget.');
  assert.match(balanceProblem({ balance: 0n, registered: false }, '3000000', 'new.near') ?? '', /^Your account new\.near isn't registered with the USDC contract on NEAR, so it holds no USDC\./);
});

test('the raw texts a failed transfer or refund carries read in plain words', () => {
  const plain: [string, string][] = [
    ["Smart contract panicked: The account doesn't have enough balance", "your wallet doesn't hold enough USDC"],
    ['Smart contract panicked: The account new.near is not registered', "your account isn't registered with the USDC contract, so it holds no USDC"],
    ['Sender alice.near does not have enough balance 1000 for operation costing 2000', "your wallet doesn't hold enough NEAR to pay for the transaction"],
    ['budget below the minimum of 500000', "the budget is below the contract's minimum of 0.50 USDC"],
    ['alice.near already has 5 open tasks', 'your account already has 5 tasks open on the Rook contract, the most it allows; wait for one to close'],
    ['need 1 to 8 caps, each > 0', "the plan's spending limits don't fit the contract's rules; draft the task again"],
    ['contract is killed', 'the Rook contract is paused and takes no new tasks'],
    ['{"ActionError":{"index":0,"kind":{"LackBalanceForState":{"account_id":"rook.near","amount":"1"}}}}', 'the Rook contract is short of NEAR for new tasks; try again later'],
    // The same error about the sender: the wallet, not the contract, is short of NEAR.
    ['{"InvalidTxError":{"LackBalanceForState":{"signer_id":"alice.near","amount":"1820000000000000000000"}}}', "your wallet doesn't hold enough NEAR to pay for the transaction"],
    ['Smart contract panicked: unknown task', 'the contract has no such task any more; its USDC was most likely refunded already'],
    ['Smart contract panicked: subtask 2 has not returned its leftover', "part of this task still holds USDC, so the contract can't close it yet; try again in a few minutes"],
    ['Smart contract panicked: subtask 1 has a transfer in flight', "part of this task still holds USDC, so the contract can't close it yet; try again in a few minutes"],
    // A close already under way: the refund is coming, nothing is stuck.
    ['Smart contract panicked: task is closing', 'the contract is already closing this task, and its USDC is on its way back to the wallet that funded it'],
  ];
  for (const [raw, want] of plain) assert.equal(plainReason(raw), want, raw);
  // Anything else as NEAR gave it, without the panic prefix.
  assert.equal(plainReason('Smart contract panicked: something new'), 'something new');
  assert.equal(plainReason('the contract is short of NEAR for new tasks; try again later'), 'the contract is short of NEAR for new tasks; try again later');
});

test('funding instructions that did not load say why in a sentence', () => {
  // The orchestrator couldn't read the contract's settings (chain-gateway down, or NEAR RPC failing).
  for (const m of ['fetch failed', 'GET http://127.0.0.1:7104/config -> 502', 'NEAR RPC query failed: TIMEOUT_ERROR']) {
    assert.equal(fundingLoadReason(m), "It couldn't read the Rook contract's settings from NEAR just now.", m);
  }
  // Rook's own sentences stay, ending in a full stop.
  assert.equal(fundingLoadReason("Rook's services aren't running. Start them with pnpm dev, then try again."), "Rook's services aren't running. Start them with pnpm dev, then try again.");
  assert.equal(fundingLoadReason("This page couldn't reach Rook's web server"), "This page couldn't reach Rook's web server.");
});

test('wallet cancellations read as a choice', () => {
  for (const m of ['User rejected the request', 'Wallet closed', 'User cancelled', 'Request denied']) assert.equal(isWalletCancel(m), true, m);
  assert.equal(isWalletCancel('Exceeded the prepaid gas'), false);
});
