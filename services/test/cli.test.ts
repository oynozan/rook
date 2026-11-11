// `rook plan` prints what the plan says before any money moves: Rook's questions, its assumptions, and why a plan can't
// be funded. Offline: a fake orchestrator answers the CLI.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const { serve } = await import('../src/shared/http.ts');

const budget = { budget_atomic: '1000000', reserve_atomic: '200000', allocatable_atomic: '800000', allocated_atomic: '0' };
const task = (status: string, plan: Record<string, unknown>) => ({
  id: 't_cli', status, prompt: 'make me a portfolio website', error: null,
  plan: { subtasks: [], dropped: [], budget, notes: [], llm_calls: [], ...plan },
});

test('rook plan prints questions, assumptions and why a plan is blocked, and stops there', { timeout: 120_000 }, async (t) => {
  let answer: unknown;
  const orch = await serve('fake-orchestrator', {
    'GET /mode': () => ({ market: 'sim', llm: 'canned', ledger: 'sim', network: 'sim', simulated: true }),
    'POST /tasks': () => answer,
  }, 0);
  t.after(() => orch.close());
  const plan = () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/rook.ts', 'plan', 'make me a portfolio website', '--budget', '1'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 60_000,
    env: { ...process.env, ORCHESTRATOR_URL: orch.url, ROOK_SERVICE_TOKEN: '', NO_COLOR: '1' },
  }).then((r) => ({ code: 0, out: r.stdout }), (e: any) => ({ code: e.code as number, out: String(e.stdout) }));

  answer = task('asking', { questions: ['What is your name?', 'Which projects, with a link for each?'], assumptions: ['A dark one-page site.'] });
  const asked = await plan();
  assert.equal(asked.code, 1);
  assert.match(asked.out, /Rook needs a few details before it plans this:\n {2}- What is your name\?\n {2}- Which projects, with a link for each\?\n {2}Put the answers in the prompt and plan again\./);
  assert.match(asked.out, /Rook will assume\n {2}- A dark one-page site\./);

  // A plan Rook can't fund as it is: the reason is printed, and `rook run` would not offer to approve it.
  const blocked = 'The files "Rename games" works on come to 301 KB, more than the 300 KB Rook can send with one part, so this plan can\'t run as it is. Ask for a change to fewer or smaller files.';
  answer = task('planned', { blocked });
  const stopped = await plan();
  assert.equal(stopped.code, 1);
  assert.ok(stopped.out.includes(blocked), stopped.out);
});
