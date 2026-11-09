// The browser's funding step: the transfer it asks the wallet to send, and reading the contract's answer from the
// outcome. Outcomes are shaped like NEAR RPC FinalExecutionOutcome; the logs are the budget contract's own formats
// (contract/budget/src/lib.rs: emit() and ft_on_transfer's refund log). Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchTxOutcome, fundingOwner, fundingTerms, fundingTransaction, isWalletCancel, readFundingOutcome, txHashOf, untilFinal, type Funding } from './funding';

const F: Funding = {
  contract_id: 'rook.near', usdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', network: 'mainnet',
  amount_atomic: '3000000', msg: JSON.stringify({ create_task: { reserve_bps: 2000, caps: ['1000000', '800000'] } }), owner: 'ops.near',
};

const event = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'rook', version: '1.0.0', event, data: [data] })}`;
const outcome = (receipts: { executor_id: string; logs: string[]; status?: unknown }[], status: unknown = { SuccessValue: '' }) => ({
  status,
  transaction: { hash: '9xQ1oFz3pW7Zb6cQx6m3c7cR8mN4m2Qe5yVfK1sLdTzA', signer_id: 'ops.near', receiver_id: F.usdc },
  transaction_outcome: { id: '9xQ1oFz3pW7Zb6cQx6m3c7cR8mN4m2Qe5yVfK1sLdTzA', outcome: { logs: [] } },
  receipts_outcome: receipts.map((r, i) => ({ id: `r${i}`, outcome: { executor_id: r.executor_id, logs: r.logs, status: r.status ?? { SuccessValue: '' } } })),
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

test('owner: SHARED API DECISION 4 says owner; older orchestrators said funder', () => {
  assert.equal(fundingOwner(F), 'ops.near');
  assert.equal(fundingOwner({ ...F, owner: undefined, funder: 'old.near' }), 'old.near');
  assert.equal(fundingOwner({ ...F, owner: undefined }), null);
});

test('reads the contract task id from task_created', () => {
  const o = outcome([
    { executor_id: F.usdc, logs: ['EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"ops.near","new_owner_id":"rook.near","amount":"3000000"}]}'] },
    { executor_id: 'rook.near', logs: [event('task_created', { task_id: '1a', funder: 'ops.near', budget: '3000000', reserve: '600000', caps: ['1000000', '800000'] })] },
    { executor_id: F.usdc, logs: [] },
  ]);
  assert.deepEqual(readFundingOutcome(o, 'rook.near'), { kind: 'created', task_id: '1a', funder: 'ops.near', budget: '3000000' });
  assert.equal(txHashOf(o), '9xQ1oFz3pW7Zb6cQx6m3c7cR8mN4m2Qe5yVfK1sLdTzA');
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
  const o = outcome([{ executor_id: 'rook.near', logs: ['refunding 3000000: only the owner funds tasks'] }]);
  assert.deepEqual(readFundingOutcome(o, 'rook.near'), { kind: 'refunded', reason: 'only the owner funds tasks' });
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

test('wallet cancellations read as a choice', () => {
  for (const m of ['User rejected the request', 'Wallet closed', 'User cancelled', 'Request denied']) assert.equal(isWalletCancel(m), true, m);
  assert.equal(isWalletCancel('Exceeded the prepaid gas'), false);
});
