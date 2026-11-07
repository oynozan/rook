// Local stack: one child process per service, started in dependency order, output prefixed by service name.
// `pnpm dev` (ROOK_LLM / ROOK_MARKET from env or ../.env). Ctrl+C stops every child.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config } from '../src/shared/config.ts';

const ORDER: [name: string, url: () => string][] = [
  ['simulator', () => config.urls.simulator],
  ['market-gateway', () => config.urls.marketGateway],
  ['planner', () => config.urls.planner],
  ['evaluator', () => config.urls.evaluator],
  ['orchestrator', () => config.urls.orchestrator],
];

// The simulator answers in seconds, so poll faster and time out sooner than the live-market defaults.
// The rate limit guards market.near.ai; against the local simulator 60/min would starve polling.
if (config.market === 'sim') {
  process.env.ROOK_POLL_MS ??= '1000';
  process.env.ROOK_PAYMENT_GRACE_S ??= '5';
  process.env.ROOK_RATE_PER_MIN ??= '600';
}
// Pin the resolved mode so every child agrees with what is printed here.
process.env.ROOK_LLM = config.llm;
process.env.ROOK_MARKET = config.market;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const COLORS = [36, 33, 35, 32, 34];
const width = Math.max(...ORDER.map(([n]) => n.length));
const tag = (name: string, i: number) => {
  const t = name.padEnd(width);
  return color ? `\x1b[${COLORS[i]}m${t}\x1b[0m |` : `${t} |`;
};

console.log(`rook dev: market=${config.market} llm=${config.llm}`);
if (config.llm === 'near') {
  console.log(`  models: planner=${config.plannerModel} evaluator=${config.evaluatorModel} sim-agent=${config.simAgentModel}; cost guard ${config.llmMaxUsd} USD per process`);
} else {
  console.log('  canned LLM: no NEAR AI calls, deterministic plan and checks');
}
console.log(`  poll ${config.pollMs} ms, payment grace ${config.paymentGraceS} s, rate ${config.ratePerMin}/min, max in flight ${config.maxInflight}`);

const children: ChildProcess[] = [];
let stopping = false;

function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
process.on('exit', () => { for (const c of children) if (c.exitCode === null) c.kill(); });

const tsx = import.meta.resolve('tsx');
const entry = new URL('./service.ts', import.meta.url);

async function waitUp(url: string, child: ChildProcess, ms = 30_000) {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (child.exitCode !== null) throw new Error(`exited with code ${child.exitCode}`);
    try { await fetch(url, { signal: AbortSignal.timeout(1000) }); return; } catch { /* not up yet */ }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  throw new Error(`did not answer on ${url} within ${ms / 1000} s`);
}

for (const [i, [name, url]] of ORDER.entries()) {
  if (name === 'simulator' && config.market !== 'sim') continue;
  // node --import tsx directly (not npx), so killing the child kills the service on every OS.
  const child = spawn(process.execPath, ['--import', tsx, fileURLToPath(entry), name], {
    env: { ...process.env, ROOK_DEV_CHILD: '1' }, stdio: ['pipe', 'pipe', 'pipe'], // stdin pipe: see service.ts
  });
  children.push(child);
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', (line) => console.log(`${tag(name, i)} ${line}`));
  }
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`${tag(name, i)} exited with code ${code}; stopping the stack`);
    stopAll(1);
  });
  try {
    await waitUp(url(), child);
  } catch (e: any) {
    console.error(`${tag(name, i)} failed to start: ${e?.message ?? e}`);
    stopAll(1);
    break;
  }
}
if (!stopping) console.log(`rook dev: all services up; orchestrator at ${config.urls.orchestrator}. Try: pnpm rook run "Due diligence on the NEAR token" --budget 3`);
