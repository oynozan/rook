// Local stack: one child process per service, started in dependency order, output prefixed by service name.
// `pnpm dev`: the simulation profile (ROOK_LLM / ROOK_MARKET / ROOK_LEDGER from env or ../.env); it refuses a
// configuration that would pay real agents. `pnpm live` (--live): ROOK_PROFILE=live, nothing simulated, every
// variable and key checked before anything starts (config.ts profileProblems). Ctrl+C stops every child.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { checkProfile, config } from '../src/shared/config.ts';

if (process.argv.includes('--live')) process.env.ROOK_PROFILE = 'live';
try { checkProfile(); } catch (e: any) { console.error(e.message); process.exit(1); }

const ORDER: [name: string, url: () => string][] = [
  ['simulator', () => config.urls.simulator],
  ['market-gateway', () => config.urls.marketGateway],
  ['planner', () => config.urls.planner],
  ['evaluator', () => config.urls.evaluator],
  // ROOK_LEDGER=chain only: they hold keys and send NEAR transactions (NEAR_RPC_URL, docs/x402-payments-plan.md).
  ...(config.ledger === 'chain' ? [['signer', () => config.urls.signer], ['chain-gateway', () => config.urls.chainGateway]] as [string, () => string][] : []),
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
const COLORS = [36, 33, 35, 32, 31, 90, 34];
const width = Math.max(...ORDER.map(([n]) => n.length));
const tag = (name: string, i: number) => {
  const t = name.padEnd(width);
  return color ? `\x1b[${COLORS[i]}m${t}\x1b[0m |` : `${t} |`;
};

console.log(`rook ${config.profile === 'live' ? 'live' : 'dev'}: market=${config.market} llm=${config.llm} ledger=${config.ledger}`);
{
  const sim = [
    config.market === 'sim' && 'Agent Market: the local simulator and its scripted agents',
    config.ledger === 'sim' && 'ledger: in memory, no NEAR transactions, no USDC',
    config.llm === 'canned' && 'LLM: canned answers, no NEAR AI calls',
  ].filter(Boolean) as string[];
  // With the chain ledger something real still moves (the funding transfer, sub-accounts, gas), simulated parts or not.
  const money = config.nearNetwork === 'mainnet' ? 'real USDC and NEAR' : 'testnet USDC and NEAR';
  const lines = !sim.length
    ? [`LIVE: real Agent Market agents paid in USDC on NEAR ${config.nearNetwork}, contract ${config.contractId}.`, 'Every approved plan spends real money.']
    : config.ledger === 'chain'
      ? [`TEST RUN on NEAR ${config.nearNetwork}: funding a plan moves ${money}, contract ${config.contractId}.`, ...sim.map((s) => `  simulated ${s}`)]
      : ['SIMULATION: no real money moves.', ...sim.map((s) => `  simulated ${s}`), 'Real mode: pnpm live (README, "Running for real").'];
  const w = Math.max(...lines.map((l) => l.length)) + 4, bar = '#'.repeat(w);
  const real = !sim.length || (config.ledger === 'chain' && config.nearNetwork === 'mainnet');
  const paint = (s: string) => (color ? `\x1b[1;${real ? '97;41' : '30;43'}m${s}\x1b[0m` : s);
  for (const l of [bar, ...lines.map((l) => `# ${l.padEnd(w - 4)} #`), bar]) console.log(paint(l));
}
if (config.ledger === 'chain') {
  // Origin only: commercial RPC URLs often carry an API key in the path or query.
  const rpc = process.env.NEAR_RPC_URL ? (URL.canParse(process.env.NEAR_RPC_URL) ? new URL(process.env.NEAR_RPC_URL).origin : '(NEAR_RPC_URL is not a URL)') : '(NEAR_RPC_URL not set)';
  console.log(`  chain: ${config.nearNetwork} via ${rpc}, contract ${config.contractId || '(ROOK_CONTRACT_ID not set)'}`);
  // The chain services read the payment network the simulator should quote in.
  if (config.market === 'sim') process.env.SIM_PAYMENT_NETWORK ??= `near:${config.nearNetwork}`;
}
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

/** Each role's NEAR key goes only to the service that uses it (design A key split, x402-payments-plan.md 4.6). */
function childEnv(name: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ROOK_DEV_CHILD: '1' };
  for (const k of Object.keys(env)) {
    if ((k.startsWith('ROOK_SIGNER_') && name !== 'signer') || (k.startsWith('ROOK_ORCHESTRATOR_') && name !== 'chain-gateway')) delete env[k];
  }
  return env;
}

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
    env: childEnv(name), stdio: ['pipe', 'pipe', 'pipe'], // stdin pipe: see service.ts
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
