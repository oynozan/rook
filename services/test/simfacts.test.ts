process.env.ROOK_LLM = 'canned';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefFacts, simValue } from '../src/simulator/agents.ts';

test('briefFacts: quoted labels get deterministic values, known labels reuse the fact sheet', () => {
  const a = briefFacts('Use exactly these labels: "Audits found:", "Risk score", "Total supply", "Top 10 holders share".');
  assert.equal(a, briefFacts('"Audits found" "Risk score" "Total supply" "Top 10 holders share"'));
  assert.match(a, /^Audits found: \d$/m);
  assert.match(a, /^Risk score: \d$/m);
  assert.match(a, /^Total supply: 1,250,000,000$/m);
  assert.match(a, /^Top 10 holders share: 41\.6%$/m);
  assert.match(simValue('Active holder share'), /^\d+(\.\d)?%$/);
  assert.ok(briefFacts('no quoted labels').includes('Holder count: 412,530'));
});

test('briefFacts: bare "Label:" lines count as requested labels; fallback omits the contract id', () => {
  const b = "Print every key figure on its own line as 'Label: value' using exactly these labels:\nRisk score:\nIssues found:\nTotal supply:\nEnd with a line reading 'Verdict: ' followed by one word.";
  const f = briefFacts(b);
  assert.match(f, /^Risk score: \d$/m);
  assert.match(f, /^Issues found: \d$/m);
  assert.match(f, /^Total supply: 1,250,000,000$/m);
  assert.doesNotMatch(f, /^Label:/m);
  assert.doesNotMatch(briefFacts('nothing'), /wrap\.near/);
});

test('briefFacts: digit-leading labels, no sentence lines, prices stay price-sized', () => {
  const f = briefFacts('Print figures using exactly these labels:\nVenue count:\nREF price USD:\n24h volume USD:\n');
  assert.deepEqual(f.split('\n').map((l) => l.split(':')[0]), ['Venue count', 'REF price USD', '24h volume USD']);
  assert.ok(Number(f.match(/REF price USD: ([\d.]+)/)![1]) < 25);
});

test('briefFacts: comma-separated label sentence; non-numeric labels left to the agent', () => {
  const f = briefFacts("then print every key figure in the exact format 'Label: value', using these exact labels: Audits found, Critical issues found, High issues found, Admin controlled, Upgradeable. The last two must be yes or no.");
  assert.deepEqual(f.split('\n').map((l) => l.split(':')[0]), ['Audits found', 'Critical issues found', 'High issues found']);
  const g = briefFacts('using these exact labels: Price (USD), 24h volume (USD), Total supply and Trend. Trend is one word.');
  assert.deepEqual(g.split('\n').map((l) => l.split(':')[0]), ['Price (USD)', '24h volume (USD)', 'Total supply']);
  assert.match(g, /^Price \(USD\): 3\.12$/m);
});

test('briefFacts: "Label: <placeholder>" lines', () => {
  const f = briefFacts("Print as 'Label: value':\nPrice USD: <current NEAR price in US dollars>\nMarket cap USD: <market cap>\nPrice 30d change pct: <percent, may be negative>");
  assert.deepEqual(f.split('\n').map((l) => l.split(':')[0]), ['Price USD', 'Market cap USD', 'Price 30d change pct']);
});

test('simValue: ranks and fees stay in sane ranges', () => {
  assert.ok(Number(simValue('Market cap rank')) <= 150);
  assert.ok(Number(simValue('Average transaction fee in USD')) < 1);
});
