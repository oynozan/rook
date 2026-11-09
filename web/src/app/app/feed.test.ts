// The run's activity lines in plain words: skip reasons, Rook's own error events (as the services word them in
// services/src/orchestrator/runner.ts). Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertLine, problemLine, skipReason } from './feed';

test('skip reasons: the common ones in plain words, a price rise with its unit', () => {
  assert.equal(skipReason('price rose from 0.10 in the approved plan to 0.15'), 'its price went up from 0.10 to 0.15 USDC since you approved the plan');
  assert.equal(skipReason('quote failed: unreachable fetch failed'), "it didn't answer");
  assert.equal(skipReason('quote failed: bad_quote malformed accepts row: [ { "origin": "string" } ]'), "it sent a price Rook can't read");
  assert.equal(skipReason('quote failed: no_payments agent accepts no NEAR payment'), "it doesn't take USDC on NEAR");
  assert.equal(skipReason('quote failed: 500 Internal Server Error'), 'it answered with an error');
  assert.equal(skipReason('quote failed: POST http://127.0.0.1:7102/quote -> 502'), "Rook couldn't get its price");
  assert.equal(skipReason('payTo evil.near is not the marketplace treasury'), "it asked to be paid to an account that isn't the marketplace's");
  assert.equal(skipReason('maxTimeoutSeconds 999999 is not an integer from 1 to 90000'), "it asked for a payment window Rook doesn't allow");
  assert.equal(skipReason('price 0.50 exceeds balance 0.30 and the reserve cannot cover the 0.20 top-up'), 'its price is more than this part has left, even with the reserve');
  assert.equal(skipReason('send failed: 402 payment refused'), 'it turned the payment down, so nothing was paid');
  assert.equal(skipReason('send failed after a 502 and no payment showed on chain: x'), "the job didn't reach it, so nothing was paid");
  assert.equal(skipReason('something new'), "Rook couldn't use its quote");
});

test('a quote security alert names the agent and says what it asked for', () => {
  assert.equal(alertLine('payTo evil.near is not the marketplace treasury', 'evil'), "Security alert: evil asked to be paid to an account that isn't the marketplace's.");
});

test("Rook's errors: retries and notes muted, real problems alert, no ids or raw text in the line", () => {
  const retry = problemLine({ kind: 'eval_retry', message: 'evaluator attempt 1 failed, retrying: NEAR AI 502 for evaluate: <html>' }, 'Holder data');
  assert.deepEqual(retry, { text: "Checking Holder data didn't go through, so Rook is trying again.", tone: 'muted', label: 'Retrying' });
  const lag = problemLine({ kind: 'payment_lookup', agent_handle: 'web-research', message: 'web-research: the indexer does not show the payment transaction yet; ...' });
  assert.equal(lag?.tone, 'muted');
  assert.match(lag!.text, /^The payment to web-research went through/);
  const abandoned = problemLine({ kind: 'abandoned', message: 's2 abandoned: NEAR RPC send_tx: INVALID_TRANSACTION {}' }, 'Contract check');
  assert.deepEqual(abandoned, { text: "Rook couldn't finish Contract check because of a problem on its side.", tone: 'alert', label: 'Problem' });
  assert.equal(problemLine({ kind: 'close', message: 'ledger refused: subtask 2 has not returned its leftover' })?.text, 'Sending the unspent USDC back hit a problem. Rook is still finishing the refund.');
  assert.equal(problemLine({ kind: 'unpaid', message: 'x delivered, but its payment never showed on chain before the authorization expired; booked unpaid' }), null);
  assert.equal(problemLine({ kind: 'something-new', message: 'raw' })?.text, 'Rook hit a problem on its side.');
});

test('error events stored before they had a kind are read from their message', () => {
  assert.equal(problemLine({ message: 'evaluator attempt 2 failed, retrying: fetch failed' }, 'Prices')?.tone, 'muted');
  assert.match(problemLine({ message: 'web-research: the indexer does not show the payment transaction yet; the balance already showed the payment, so the receipt stands without payment_tx' })!.text, /^The payment to web-research went through/);
  assert.equal(problemLine({ message: 's2 abandoned: NEAR RPC send_tx: INVALID_TRANSACTION {}' }, 'Contract check')?.text, "Rook couldn't finish Contract check because of a problem on its side.");
  assert.equal(problemLine({ message: 'salvage, closeTask: ledger refused: subtask 2 has not returned its leftover' })?.tone, 'alert');
  assert.equal(problemLine({ message: 'send to luigi: after a 502 the agent answered HTTP 402; counted as spent' })?.text, "luigi's payment went through after all, so it counts as spent.");
  assert.equal(problemLine({ message: 'evaluation of luigi failed, subtask abandoned unjudged: down' }, 'Prices')?.text, "Rook couldn't check luigi's work on Prices, so that part is left out.");
});
