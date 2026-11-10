// Rook's own error texts made fit for the page. Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cause, detail, failed, pageUnreachable } from '@/lib/errors';

test('detail: one line, local services by name, no query strings or keys, short', () => {
  assert.equal(detail('  chain-gateway view failed:\n  GET http://127.0.0.1:7106/view?account=rook -> 502.  '), 'chain-gateway view failed: the chain gateway (GET /view) answered HTTP 502');
  assert.equal(detail('http://localhost:7101'), 'the planner');
  assert.equal(detail('http://127.0.0.1:9999/x -> 500'), 'http://127.0.0.1:9999/x answered HTTP 500'); // not one of Rook's ports
  assert.equal(detail('POST https://rpc.mainnet.fastnear.com/?apiKey=s3cret failed'), 'POST https://rpc.mainnet.fastnear.com/ failed');
  assert.equal(detail('bad key ed25519:3Fa8vWgYxHqbXq7dQnYVvEJx9fcp3hjTmQHKHGtT8WbZxK'), 'bad key ed25519:…');
  assert.equal(detail('x'.repeat(500)).length, 240);
  assert.equal(detail(null), '');
});

test('cause and failed: what went wrong, with Try again only where it may pass', () => {
  assert.match(cause(401, 'anything'), /ROOK_SERVICE_TOKEN doesn't match/);
  assert.equal(cause(500, 'fetch failed'), "a service behind Rook's orchestrator didn't answer (fetch failed)");
  assert.equal(cause(503, ''), "Rook's orchestrator hit an error (HTTP 503)");
  assert.equal(cause(409, 'task is weird'), "Rook's orchestrator refused it (task is weird)");
  assert.equal(failed("Rook couldn't stop this task", 500, 'db locked'), "Rook couldn't stop this task: Rook's orchestrator hit an error (db locked). Try again in a moment.");
  assert.equal(failed("Rook couldn't stop this task", 409, 'nope'), "Rook couldn't stop this task: Rook's orchestrator refused it (nope).");
  assert.match(pageUnreachable(new TypeError('Failed to fetch')), /^This page got no answer from Rook's web server \(Failed to fetch\)\./);
});
