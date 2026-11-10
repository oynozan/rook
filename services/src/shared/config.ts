// Env-driven config shared by every service. See docs/agentic-system.md sections 2, 3, 11.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseUsdc } from './money.ts';

// ponytail: tiny .env loader; real env vars win. First the real-mode env file outside the repo (ROOK_ENV_FILE, or
// ~/.rook/mainnet.env for `pnpm live`, written by scripts/deploy.ts), the only file NEAR role keys are read from;
// then the repo's .env (root, then cwd). The admin key in the repo's .env is for scripts/deploy.ts, never a service.
const REPO = resolve(import.meta.dirname, '../../..');
const NEAR_KEY = /^ROOK_(SIGNER|ORCHESTRATOR)_KEY$/, ADMIN_KEY = /^(ADMIN_WALLET_PRIVATE_KEY|ROOK_ADMIN_KEY)$/;
const live = process.env.ROOK_PROFILE === 'live' || process.argv.includes('--live');
// A child of scripts/dev.ts gets its env from the parent, which hands each role key only to the service that uses it.
const outside = process.env.ROOK_DEV_CHILD ? '' : process.env.ROOK_ENV_FILE || (live ? join(homedir(), '.rook', 'mainnet.env') : '');
for (const p of [outside, resolve(REPO, '.env'), resolve(process.cwd(), '.env')]) {
  if (!p || !existsSync(p)) continue;
  const inRepo = !relative(REPO, resolve(p)).startsWith('..');
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || ADMIN_KEY.test(m[1])) continue;
    if (inRepo && NEAR_KEY.test(m[1])) { console.warn(`[config] ignoring ${m[1]} in ${p}: set it in the environment or ~/.rook, never in a file in the repo`); continue; }
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const env = (k: string, d: string) => process.env[k] ?? d;
const num = (k: string, d: number) => Number(process.env[k] ?? d);

const port = (name: string, d: number) => num(`${name}_PORT`, d);
const url = (name: string, d: number) => env(`${name}_URL`, `http://127.0.0.1:${port(name, d)}`);

// Getters so tests can set process.env before reading.
export const config = {
  get market() { return env('ROOK_MARKET', 'sim') as 'sim' | 'live'; },
  get llm() { return env('ROOK_LLM', process.env.NEARAI_API_KEY ? 'near' : 'canned') as 'near' | 'canned'; },
  get nearAiKey() { return process.env.NEARAI_API_KEY ?? ''; },
  get nearAiBase() { return env('NEARAI_BASE_URL', 'https://cloud-api.near.ai/v1'); },
  // Planner and evaluator calls are Rook's evidence; defaults are TEE-hosted models chosen by benchmark, see docs/model-choice.md.
  // Simulated agents need no signature.
  // SQLite file for tasks; empty keeps them in memory only. scripts/service.ts sets a default for the real service.
  get dbPath() { return env('ROOK_DB', ''); },
  get plannerModel() { return env('PLANNER_MODEL', 'z-ai/glm-5.3'); },
  // Reasoning effort for drafting the plan. 'medium' made GLM 5.3 think for ~12k tokens (most of a minute and ~90% of
  // the plan's cost); 'low' skips the thinking. Raise it if plans for complex tasks come out too shallow.
  get planEffort() { const e = env('ROOK_PLAN_EFFORT', 'low'); return (['low', 'medium', 'high'].includes(e) ? e : 'low') as 'low' | 'medium' | 'high'; },
  get evaluatorModel() { return env('EVALUATOR_MODEL', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'); },
  get simAgentModel() { return env('SIM_AGENT_MODEL', 'anthropic/claude-haiku-5-5'); },
  get llmMaxUsd() { return num('ROOK_LLM_MAX_USD', 1); },

  ports: {
    get orchestrator() { return port('ORCHESTRATOR', 7100); },
    get planner() { return port('PLANNER', 7101); },
    get evaluator() { return port('EVALUATOR', 7102); },
    get marketGateway() { return port('MARKET_GATEWAY', 7103); },
    get simulator() { return port('SIMULATOR', 7104); },
    get signer() { return port('SIGNER', 7105); },
    get chainGateway() { return port('CHAIN_GATEWAY', 7106); },
  },
  urls: {
    get orchestrator() { return url('ORCHESTRATOR', 7100); },
    get planner() { return url('PLANNER', 7101); },
    get evaluator() { return url('EVALUATOR', 7102); },
    get marketGateway() { return url('MARKET_GATEWAY', 7103); },
    get simulator() { return url('SIMULATOR', 7104); },
    get signer() { return url('SIGNER', 7105); },
    get chainGateway() { return url('CHAIN_GATEWAY', 7106); },
  },

  get marketBase() { return env('MARKET_BASE_URL', 'https://market.near.ai'); },
  get maxInflight() { return num('ROOK_MAX_INFLIGHT', 6); },
  get pollMs() { return num('ROOK_POLL_MS', 10_000); },
  get paymentGraceS() { return num('ROOK_PAYMENT_GRACE_S', 600); },
  get maxRehires() { return num('ROOK_MAX_REHIRES', 2); },
  get ratePerMin() { return num('ROOK_RATE_PER_MIN', 60); },

  // Phase 2 (docs/x402-payments-plan.md). `sim`: in-memory ledger; `chain`: signer + chain-gateway + budget contract.
  get ledger() { return env('ROOK_LEDGER', 'sim') as 'sim' | 'chain'; },
  get nearNetwork() { return env('NEAR_NETWORK', 'testnet') as 'testnet' | 'mainnet'; },
  /** No default on purpose: nothing talks to a real NEAR RPC unless the human sets it. */
  get nearRpcUrl() {
    const u = process.env.NEAR_RPC_URL;
    if (!u) throw new Error('NEAR_RPC_URL is not set');
    return u;
  },
  get contractId() { return env('ROOK_CONTRACT_ID', ''); },
  /**
   * Longest payment validity Rook signs or accepts, in blocks (about seconds); the planner drops a quote asking more.
   * The window is the agent's SLA + 600 s, and the market refuses a payment signed for less, so this must admit the
   * common 1-day SLA (87 000 s): at 15 000 the planner dropped most of the market. An authorization holds its
   * sub-account's money until it lands or expires, but only an agent that hangs AND refuses CancelTask holds it that long.
   */
  get maxPaymentTimeoutS() { return num('ROOK_MAX_PAYMENT_TIMEOUT_S', 90_000); },
  /**
   * How long Rook waits for one hire to deliver before it sends CancelTask and moves on (when the agent accepts the
   * cancel): its SLA + ROOK_PAYMENT_GRACE_S, at most this. An advertised 1-day SLA must not hold a run for a day.
   */
  get hirePatienceS() { return num('ROOK_HIRE_PATIENCE_S', 1_800); },
  /** How long Rook waits before asking an agent again whose backend was unreachable (-32603), once. */
  get unreachableRetryS() { return num('ROOK_UNREACHABLE_RETRY_S', 180); },

  /** `live`: `pnpm live`, nothing simulated (checkProfile). Anything else: the simulation profile of `pnpm dev`. */
  get profile() { return process.env.ROOK_PROFILE === 'live' ? 'live' as const : 'sim' as const; },
  /** Any simulated part: a client must label the run as simulation, never as real money. */
  get simulated(): boolean { return config.market === 'sim' || config.ledger === 'sim' || config.llm === 'canned'; },
  /** Shared secret the orchestrator requires as `x-rook-token` when set (the web server and the CLI send it). */
  get serviceToken() { return process.env.ROOK_SERVICE_TOKEN ?? ''; },
  /** Largest budget one task may ask for (ROOK_MAX_BUDGET_USDC, default 50 USDC), atomic; unparseable means 50. */
  get maxBudgetAtomic(): bigint { try { return parseUsdc(env('ROOK_MAX_BUDGET_USDC', '50')); } catch { return 50_000_000n; } },
};

/** Longest task prompt the orchestrator and the planner accept. */
export const MAX_PROMPT_CHARS = 4000;

/** NEAR role keys and the one service that holds each (scripts/dev.ts hands them to no other). */
const ROLE_KEYS: Record<string, string[]> = {
  signer: ['ROOK_SIGNER_ACCOUNT', 'ROOK_SIGNER_KEY'],
  'chain-gateway': ['ROOK_ORCHESTRATOR_ACCOUNT', 'ROOK_ORCHESTRATOR_KEY'],
};
const ROLE_PREFIX: Record<string, string> = { signer: 'ROOK_SIGNER_', 'chain-gateway': 'ROOK_ORCHESTRATOR_' };

/**
 * The variables in `env` that `service` must not hold: the admin key (scripts/deploy.ts only; it can replace the
 * signer and the orchestrator) and every other role's ROOK_SIGNER_* / ROOK_ORCHESTRATOR_* variables. scripts/dev.ts
 * leaves them out of each child's env, and scripts/service.ts deletes them once config has loaded, so a service
 * started on its own (which reads the whole real-mode env file) still holds only its own key.
 */
export function foreignKeys(service: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => ADMIN_KEY.test(k) || Object.entries(ROLE_PREFIX).some(([s, p]) => s !== service && k.startsWith(p)));
}

/**
 * What stops this configuration from starting; empty when it may start. `service`: check what that one service
 * holds; omitted: the whole stack (scripts/dev.ts). The live profile runs on nothing simulated, and anything that
 * pays real agents needs the live profile.
 */
export function profileProblems(service?: string): string[] {
  const e = process.env, p: string[] = [];
  if (config.llm === 'canned' && (config.market !== 'sim' || config.ledger !== 'sim')) {
    p.push(`ROOK_LLM=canned${e.ROOK_LLM ? '' : ' (the default without NEARAI_API_KEY)'} runs only with ROOK_MARKET=sim and ROOK_LEDGER=sim; set ROOK_LLM=near and NEARAI_API_KEY`);
  }
  if (config.market === 'live' && config.ledger === 'chain' && config.nearNetwork !== 'mainnet') {
    p.push('ROOK_MARKET=live with ROOK_LEDGER=chain needs NEAR_NETWORK=mainnet: x402 settles on mainnet only');
  }
  if (config.profile !== 'live') {
    if (!config.simulated) p.push('this configuration pays real agents: start it with `pnpm live`, which checks the whole real-mode setup');
    return p;
  }
  for (const [k, v] of [['ROOK_MARKET', 'live'], ['ROOK_LEDGER', 'chain'], ['ROOK_LLM', 'near'], ['NEAR_NETWORK', 'mainnet']]) {
    if (e[k] !== v) p.push(`${k}=${v} is required (it is ${e[k] ? e[k] : 'not set'})`);
  }
  const keys = service ? ROLE_KEYS[service] ?? [] : Object.values(ROLE_KEYS).flat();
  for (const k of ['NEAR_RPC_URL', 'ROOK_CONTRACT_ID', 'NEARAI_API_KEY', 'ROOK_SERVICE_TOKEN', ...keys]) if (!e[k]) p.push(`${k} is not set`);
  if (e.ROOK_SERVICE_TOKEN && e.ROOK_SERVICE_TOKEN.length < 32) p.push('ROOK_SERVICE_TOKEN must be at least 32 characters');
  if (service === 'simulator') p.push('the simulator does not run in the live profile');
  return p;
}

/** Throws one message listing every problem (fail fast at startup). */
export function checkProfile(service?: string) {
  const p = profileProblems(service);
  if (p.length) throw new Error(`rook (${config.profile} profile${service ? `, ${service}` : ''}) refuses to start:\n  - ${p.join('\n  - ')}`);
}
