// The task page's buttons: the orchestrator's refusals in plain words, and a fallback for anything else.
// Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionRefusal } from './refusals';

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
  assert.deepEqual(actionRefusal('approve', 500, 'fetch failed'), { message: "Rook couldn't get this task started right now. Try again in a moment.", known: false });
  assert.deepEqual(actionRefusal('cancel', 401, 'The orchestrator refused this web server: ROOK_SERVICE_TOKEN differs between them.'),
    { message: "Rook couldn't cancel this task right now. Try again in a moment.", known: false });
  assert.equal(words('stop', null, 'database is locked'), "Rook couldn't stop this task right now. Try again in a moment.");
  assert.equal(words('approve', 404, 'GET http://127.0.0.1:7104/config -> 404'), "Rook couldn't get this task started right now. Try again in a moment.");
  assert.equal(words('approve', 409, "reserve_share 0.2 gives 1 on chain but 2 in the plan; use a share with at most 4 decimals"), "Rook couldn't get this task started right now. Try again in a moment.");
});
