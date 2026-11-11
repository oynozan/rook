// The run's activity lines in plain words: skip reasons, Rook's own error events (as the services word them in
// services/src/orchestrator/runner.ts), and the parts a stopped run delivered. Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertLine, deliveredParts, feedFrom, problemLine, skipReason, type FeedContext } from '@/lib/feed';
import type { RookEvent } from '@/lib/server/orchestrator';

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

test("Rook's errors: retries and notes muted, real problems alert, in plain words with their cause", () => {
  const retry = problemLine({ kind: 'eval_retry', message: 'evaluator attempt 1 failed, retrying: NEAR AI 502 for evaluate: <html>' }, 'Holder data');
  assert.deepEqual(retry, { text: "Checking Holder data didn't go through, so Rook is trying again.", tone: 'muted', label: 'Retrying' });
  const lag = problemLine({ kind: 'payment_lookup', agent_handle: 'web-research', message: 'web-research: the indexer does not show the payment transaction yet; ...' });
  assert.equal(lag?.tone, 'muted');
  assert.match(lag!.text, /^The payment to web-research went through/);
  const abandoned = problemLine({ kind: 'abandoned', message: 's2 abandoned: NEAR RPC send_tx: INVALID_TRANSACTION {}' }, 'Contract check');
  assert.deepEqual(abandoned, { text: "Rook couldn't finish Contract check because of a problem on its side (NEAR RPC send_tx: INVALID_TRANSACTION {}).", tone: 'alert', label: 'Problem' });
  assert.equal(problemLine({ kind: 'close', message: 'ledger refused: subtask 2 has not returned its leftover' })?.text,
    'Sending the unspent USDC back hit a problem (ledger refused: subtask 2 has not returned its leftover). Rook is still finishing the refund.');
  assert.equal(problemLine({ kind: 'unpaid', message: 'x delivered, but its payment never showed on chain before the authorization expired; booked unpaid' }), null);
  assert.equal(problemLine({ kind: 'something-new', message: 'raw' })?.text, 'Rook hit a problem on its side (raw).');
  assert.equal(problemLine({ kind: 'something-new' })?.text, 'Rook hit a problem on its side.');
  // A planning failure in the planner's plain words; a local address named by its service, never shown.
  assert.equal(problemLine({ kind: 'planner', message: 'planner: planner LLM failed: NEAR AI 402 for plan.draft: x' })?.text,
    "Rook couldn't draft a plan for this task: NEAR AI has no credits available for Rook, so the planning model could not run.");
  assert.equal(problemLine({ kind: 'run', message: 'POST http://127.0.0.1:7105/pay -> 500' })?.text, "The run stopped because of a problem on Rook's side (the signer (POST /pay) answered HTTP 500).");
});

const ev = (seq: number, type: string, data: object, subtask_id?: string): RookEvent => ({ seq, type, data, ...(subtask_id ? { subtask_id } : {}) });
const ctx = (titles: [string, string][]): FeedContext => ({ titles: new Map(titles), selfDo: new Set(), free: false, simNote: '' });

test('with more than one part, a line about an agent names its part: one agent hired for two parts reads as two hires', () => {
  // Mainnet, "make me a portfolio website like oynozan.com": taifoon-creative was hired for the brief and the copy.
  const plan = ctx([['s1', 'Design brief'], ['s2', 'Build one-page portfolio website'], ['s3', 'Write portfolio copy']]);
  const lines = feedFrom([
    ev(1, 'hire_sent', { agent_handle: 'taifoon-creative', amount_atomic: '10000' }, 's1'),
    ev(2, 'hire_sent', { agent_handle: 'taifoon-creative', amount_atomic: '10000' }, 's3'),
    ev(3, 'evaluation', { agent_handle: 'quill-writer', verdict: 'pass', failed_criteria: [] }, 's3'),
    ev(4, 'evaluation', { agent_handle: 'quill-writer', verdict: 'fail', failed_criteria: ['c1'] }, 's1'),
    ev(5, 'a2a_state', { agent_handle: 'codex-engineer-01', state: 'TIMEOUT' }, 's2'),
    ev(6, 'quote_rejected', { agent_handle: 'dev-tools-agent', reason: 'send failed: -32603 internal error' }, 's2'),
    ev(7, 'ledger', { op: 'release', agent_handle: 'codex-engineer-01', settled: false, amount_atomic: null }, 's2'),
    ev(8, 'receipt', { agent_handle: 'quill-writer', amount_atomic: '20000' }, 's3'),
  ], plan).map((l) => l.text);
  assert.deepEqual(lines, [
    'Hired taifoon-creative for Design brief, quoted 0.01 USDC.',
    'Hired taifoon-creative for Write portfolio copy, quoted 0.01 USDC.',
    'quill-writer passed every check on Write portfolio copy.',
    'quill-writer failed a check on Design brief.',
    'codex-engineer-01 timed out on Build one-page portfolio website.',
    "The job for Build one-page portfolio website didn't reach dev-tools-agent, so nothing was paid.",
    'No charge for codex-engineer-01 on Build one-page portfolio website: its payment authorization was released unpaid.',
    'Receipt 1: paid 0.02 USDC to quill-writer for Write portfolio copy.',
  ]);
  // One part: there is only one it can be, so the lines stay short.
  const one = feedFrom([ev(1, 'hire_sent', { agent_handle: 'quill-writer', amount_atomic: '20000' }, 's1'), ev(2, 'evaluation', { agent_handle: 'quill-writer', verdict: 'pass' }, 's1')], ctx([['s1', 'Copy']]));
  assert.deepEqual(one.map((l) => l.text), ['Hired quill-writer, quoted 0.02 USDC.', 'quill-writer passed every check.']);
});

test('error events stored before they had a kind are read from their message', () => {
  assert.equal(problemLine({ message: 'evaluator attempt 2 failed, retrying: fetch failed' }, 'Prices')?.tone, 'muted');
  assert.match(problemLine({ message: 'web-research: the indexer does not show the payment transaction yet; the balance already showed the payment, so the receipt stands without payment_tx' })!.text, /^The payment to web-research went through/);
  assert.equal(problemLine({ message: 's2 abandoned: NEAR RPC send_tx: INVALID_TRANSACTION {}' }, 'Contract check')?.text, "Rook couldn't finish Contract check because of a problem on its side (NEAR RPC send_tx: INVALID_TRANSACTION {}).");
  assert.equal(problemLine({ message: 'salvage, closeTask: ledger refused: subtask 2 has not returned its leftover' })?.tone, 'alert');
  assert.equal(problemLine({ message: 'send to luigi: after a 502 the agent answered HTTP 402; counted as spent' })?.text, "luigi's payment went through after all, so it counts as spent.");
  assert.equal(problemLine({ message: 'evaluation of luigi failed, subtask abandoned unjudged: down' }, 'Prices')?.text, "Rook couldn't check luigi's work on Prices (down), so that part is left out.");
});

test("delivered parts: a hire's text from its accepted hire, Rook's own from the accepted text, only parts that passed", () => {
  const titles = new Map([['s1', 'Holders'], ['s2', 'Summary'], ['s3', 'Prices']]);
  const parts = deliveredParts([
    { id: 's1', n: 1, status: 'returned', final_outcome: 'passed', accepted: { hire_id: 'h2', agent_handle: 'holders-good' },
      hires: [{ id: 'h1', agent_handle: 'holders-bad', deliverable_text: 'wrong' }, { id: 'h2', agent_handle: 'holders-good', deliverable_text: 'Top holders: ...' }] },
    { id: 's2', n: 2, status: 'returned', final_outcome: 'passed', accepted: { hire_id: null, agent_handle: 'rook:self-do', text: 'Rook wrote this.' }, hires: [] },
    { id: 's3', n: 3, status: 'working', final_outcome: null, accepted: null, hires: [{ id: 'h3', agent_handle: 'p', deliverable_text: 'not judged' }] },
  ], titles);
  assert.deepEqual(parts, [
    { id: 's1', title: 'Holders', agent: 'holders-good', text: 'Top holders: ...' },
    { id: 's2', title: 'Summary', agent: null, text: 'Rook wrote this.' },
  ]);
  // An older orchestrator sends only id, n and status: nothing to show, nothing breaks.
  assert.deepEqual(deliveredParts([{ id: 's1', n: 1, status: 'returned' }], titles), []);
});

test('a send that never reached the agent is one line, cause first, never "Skipped"; no internal ids show', () => {
  const one = ctx([['s1', 'Site']]);
  // t_3ad45053: the release came first, then the failed send. One line says both.
  const sent = feedFrom([
    ev(1, 'ledger', { op: 'release', agent_handle: 'dev-tools-agent', settled: false }, 's1'),
    ev(2, 'quote_rejected', { agent_handle: 'dev-tools-agent', reason: 'send failed: -32603 internal error' }, 's1'),
    // The other order says it once too.
    ev(3, 'quote_rejected', { agent_handle: 'dev-tools-agent', reason: 'send failed: unreachable after 3 tries' }, 's1'),
    ev(4, 'ledger', { op: 'release', agent_handle: 'dev-tools-agent', settled: false }, 's1'),
    // Asked again later, that hire's release is its own line.
    ev(5, 'hire_sent', { agent_handle: 'dev-tools-agent', amount_atomic: '80000' }, 's1'),
    ev(6, 'ledger', { op: 'release', agent_handle: 'dev-tools-agent', settled: false }, 's1'),
    ev(7, 'quote_rejected', { agent_handle: 'quill', reason: 'send failed: 402 payment refused' }, 's1'),
    ev(8, 'ledger', { op: 'restored', contract_task_id: 'e' }),
  ], one);
  assert.deepEqual(sent.map((l) => l.text), [
    "The job didn't reach dev-tools-agent, so nothing was paid.",
    "dev-tools-agent didn't answer when Rook sent the job, so nothing was paid.",
    'Hired dev-tools-agent, quoted 0.08 USDC.',
    'No charge for dev-tools-agent: its payment authorization was released unpaid.',
    'quill turned down the payment, so nothing was paid.',
    'Rook restarted and picked this task up again.',
  ]);
  assert.equal(sent[0].detail, 'send failed: -32603 internal error'); // the raw reason stays as the tooltip
  assert.equal(sent.at(-1)!.detail, 'contract task e');
});
