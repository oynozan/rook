// The task page's buttons: the orchestrator's refusals in plain words, and a fallback for anything else.
// Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionRefusal, fundingCallFailure } from './refusals';

const words = (...a: Parameters<typeof actionRefusal>) => actionRefusal(...a).message;

test('a task that moved on says where it is, never "task is killed, cancel needs planned"', () => {
  assert.equal(words('cancel', 409, 'task is running, cancel needs planned'), "This task is already running, so it can't be cancelled.");
  assert.equal(words('approve', 409, 'task is cancelled, approve needs planned'), "This task was cancelled, so it can't be started.");
  assert.equal(words('stop', 409, 'task is already closed'), 'This task has already finished.');
  assert.equal(words('stop', 409, 'task is already killed'), 'This task was stopped.');
  assert.deepEqual(actionRefusal('cancel', 409, 'task is killed, cancel needs planned'), { message: "This task was stopped, so it can't be cancelled.", known: true });
});

test('known refusals: no task for this account, an empty plan, payments off, the open-task limit, the contract minimum', () => {
  assert.equal(words('stop', 404, 'no task t_1'), "Rook has no task at this link for the wallet you're signed in with.");
  assert.equal(words('approve', 409, 'the plan has no subtasks'), "This plan has nothing to run, so it can't be started.");
  assert.equal(words('approve', 409, 'live market: paying agents needs ROOK_LEDGER=chain (signer, chain-gateway, budget contract); see docs/x402-payments-plan.md'),
    "Paying live agents isn't switched on yet, so this plan can't be started.");
  const limit = words('approve', 409, 'alice.near already has 5 open tasks on the contract (the limit is 5); wait for one to close');
  assert.match(limit, /^You already have 5 funded tasks open on the Rook contract/);
  assert.match(limit, /refund it to your wallet\.$/);
  assert.equal(words('approve', 409, "budget 0.05 USDC is below the contract's minimum of 0.10 USDC"),
    "This task's budget is below the contract's smallest, 0.10 USDC. Draft it again with a larger budget.");
});

test('anything else gets a plain fallback per button, and is marked for the server log', () => {
  assert.deepEqual(actionRefusal('approve', 500, 'database is locked'), { message: "Rook couldn't get this task started right now. Try again in a moment.", known: false });
  assert.deepEqual(actionRefusal('cancel', 401, 'The orchestrator refused this web server: ROOK_SERVICE_TOKEN differs between them.'),
    { message: "Rook couldn't cancel this task right now. Try again in a moment.", known: false });
  assert.equal(words('stop', null, 'database is locked'), "Rook couldn't stop this task right now. Try again in a moment.");
  assert.equal(words('approve', 404, 'GET http://127.0.0.1:7104/config -> 404'), "Rook couldn't get this task started right now. Try again in a moment.");
  assert.equal(words('approve', 409, "reserve_share 0.2 gives 1 on chain but 2 in the plan; use a share with at most 4 decimals"), "Rook couldn't get this task started right now. Try again in a moment.");
  // The funding step asking for the transfer again has its own words.
  assert.equal(words('fund', 500, 'database is locked'), "Rook couldn't get the funding transfer ready. Try again in a moment.");
  assert.equal(words('fund', 409, 'task is killed, approve needs planned'), "This task was stopped, so it can't be funded.");
});

test("approving can't read the contract's settings from NEAR: said once, the same for the button and the funding step", () => {
  const settings = "Rook couldn't read the Rook contract's settings from NEAR just now, so the funding transfer isn't ready. Try again in a moment.";
  // The chain-gateway down, its answer not JSON, NEAR RPC failing behind it, or its 60 s RPC deadline.
  for (const m of ['fetch failed', 'GET http://127.0.0.1:7104/config -> 502', 'NEAR RPC query: TIMEOUT_ERROR {}',
    'view rook.oynozan.near.get_config: wasm execution failed', 'The operation was aborted due to timeout']) {
    assert.deepEqual(actionRefusal('approve', 500, m), { message: settings, known: false }, m);
    assert.equal(words('fund', 502, m), settings, m);
  }
  // Only for a failure on Rook's side, and never for the other buttons.
  assert.equal(words('cancel', 500, 'fetch failed'), "Rook couldn't cancel this task right now. Try again in a moment.");
  assert.equal(words('approve', 409, 'timeout'), "Rook couldn't get this task started right now. Try again in a moment.");
});

test("confirming: the orchestrator's refusals stay as written for the funding step to read; Rook's own trouble is a plain sentence", () => {
  // 4xx: what confirmFailure and untilFinal read (the chain-gateway's 404 for a contract task NEAR doesn't show yet).
  assert.deepEqual(fundingCallFailure(409, 'contract task 1a does not match the approved plan: caps differ'), { message: 'contract task 1a does not match the approved plan: caps differ', raw: true });
  assert.deepEqual(fundingCallFailure(404, 'no contract task 1a'), { message: 'no contract task 1a', raw: true });
  // Never "Rook didn't start the run: fetch failed".
  const plain = { message: "Rook couldn't check your transfer right now. Try again in a moment." };
  assert.deepEqual(fundingCallFailure(500, 'fetch failed'), plain);
  assert.deepEqual(fundingCallFailure(502, 'NEAR RPC query: TIMEOUT_ERROR {}'), plain);
  assert.deepEqual(fundingCallFailure(401, 'The orchestrator refused this web server: ROOK_SERVICE_TOKEN differs between them.'), plain);
  assert.deepEqual(fundingCallFailure(null, 'database is locked'), plain);
});
