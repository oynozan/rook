import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';
delete process.env.ROOK_DB;

const { serve, call } = await import('../src/shared/http.ts');
const { start } = await import('../src/orchestrator/index.ts');

const plan = {
  subtasks: [{
    id: 's1', title: 'Holders', brief: 'b', search_terms: ['holders'], cap_atomic: '300000', deadline_s: 5, self_do: false,
    criteria: [{ id: 'c1', kind: 'contains', description: 'x', spec: { pattern: '.' } }],
    candidates: [{ handle: 'holderscope', name: 'Holderscope', description: '', sla_seconds: 5, success_rate: null, delivered_jobs: 0, price_atomic: '150000', quote: {} }],
  }],
  dropped: [],
  budget: { budget_atomic: '1000000', reserve_atomic: '200000', allocatable_atomic: '800000', allocated_atomic: '300000' },
  llm_calls: [],
};

// A planner double that streams like the real one, holding each line until the test releases it.
let release: () => void = () => {};
let mode: 'ok' | 'fail' | 'not_a_task' = 'ok';
const NOT_A_TASK = 'That reads like a reply, not a task: to start something new, say what you want done.';
const lines = [
  { type: 'progress', stage: 'searching', subtasks: [{ index: 0, title: 'Holders' }] },
  { type: 'progress', stage: 'found', index: 0, title: 'Holders', agents: [{ handle: 'holderscope', name: 'Holderscope' }, { handle: 'tokenholders', name: 'Token Holders' }] },
  { type: 'progress', stage: 'quoting', agents: 1 },
];
let planner: Awaited<ReturnType<typeof serve>>;
let orch: Awaited<ReturnType<typeof start>>;
before(async () => {
  planner = await serve('planner', {
    'POST /plan': async ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const l of lines) res.write(JSON.stringify(l) + '\n');
      await new Promise<void>((ok) => (release = ok)); // the progress is out; the plan waits
      res.write(JSON.stringify(
        mode === 'ok' ? { type: 'plan', plan }
        : mode === 'fail' ? { type: 'error', status: 502, error: 'planner LLM failed: NEAR AI 402' }
        : { type: 'error', status: 422, error: NOT_A_TASK },
      ) + '\n');
      res.end();
      return undefined;
    },
  }, 0);
  process.env.PLANNER_URL = planner.url;
  orch = await start(0);
});
after(async () => { await orch.close(); await planner.close(); });

const until = async <T>(fn: () => Promise<T | false | undefined>) => {
  for (let i = 0; i < 400; i++) { const v = await fn(); if (v) return v; await new Promise((ok) => setTimeout(ok, 10)); }
  throw new Error('timed out');
};
// Events as the web app reads them: the SSE stream, read for a moment and then closed (it stays open while planning).
const eventsOf = async (id: string) => {
  const ac = new AbortController();
  const r = await fetch(`${orch.url}/tasks/${id}/events`, { signal: ac.signal });
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  const stop = setTimeout(() => ac.abort(), 150);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += value; } } catch { /* closed by the timer */ }
  clearTimeout(stop);
  return text;
};

test('wait:false answers with the draft at once, then progress arrives as planning events before the plan', async () => {
  mode = 'ok';
  const t = await call(`${orch.url}/tasks`, { prompt: 'Holders please', budget_usdc: '1', wait: false });
  assert.equal(t.status, 'draft'); // answered while the planner is still working

  // All three progress lines are relayed while the plan is still pending.
  const relayed = await until(async () => {
    const text = await eventsOf(t.id);
    return (text.match(/event: planning/g) ?? []).length >= 4 && text; // drafting + searching + found + quoting
  });
  assert.match(relayed, /"stage":"drafting"/);
  assert.match(relayed, /"stage":"found".*"holderscope".*"tokenholders"/);
  assert.equal((await call(`${orch.url}/tasks/${t.id}`)).task.status, 'draft');

  release();
  const done = await until(async () => { const s = await call(`${orch.url}/tasks/${t.id}`); return s.task.status === 'planned' && s; });
  assert.equal(done.plan.subtasks[0].candidates[0].handle, 'holderscope');
});

test('an error line from the planner fails the task with its message', async () => {
  mode = 'fail';
  const t = await call(`${orch.url}/tasks`, { prompt: 'Will fail', budget_usdc: '1', wait: false });
  await until(async () => (await eventsOf(t.id)).includes('"stage":"quoting"'));
  release();
  const s = await until(async () => { const s = await call(`${orch.url}/tasks/${t.id}`); return s.task.status === 'failed' && s; });
  assert.match(s.task.error, /^planner: planner LLM failed: NEAR AI 402/); // internal: the web app puts it in plain words
});

test("the planner's not-a-task sentence (422) is kept as is, for the user", async () => {
  mode = 'not_a_task';
  const t = await call(`${orch.url}/tasks`, { prompt: 'go ahead', budget_usdc: '1', wait: false });
  await until(async () => (await eventsOf(t.id)).includes('"stage":"quoting"'));
  release();
  const s = await until(async () => { const s = await call(`${orch.url}/tasks/${t.id}`); return s.task.status === 'failed' && s; });
  assert.equal(s.task.error, NOT_A_TASK);
});

test('without wait:false the request still waits for the plan, as the CLI expects', async () => {
  mode = 'ok';
  const pending = call(`${orch.url}/tasks`, { prompt: 'Waits', budget_usdc: '1' });
  await new Promise((ok) => setTimeout(ok, 50));
  release();
  assert.equal((await pending).status, 'planned');
});
