// Env-driven config shared by every service. See docs/agentic-system.md sections 2, 3, 11.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ponytail: tiny .env loader (repo root, then cwd); real env vars win.
for (const p of [resolve(import.meta.dirname, '../../../.env'), resolve(process.cwd(), '.env')]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
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
  get plannerModel() { return env('PLANNER_MODEL', 'anthropic/claude-sonnet-5-5'); },
  get evaluatorModel() { return env('EVALUATOR_MODEL', 'anthropic/claude-haiku-5-5'); },
  get simAgentModel() { return env('SIM_AGENT_MODEL', 'anthropic/claude-haiku-5-5'); },
  get llmMaxUsd() { return num('ROOK_LLM_MAX_USD', 1); },

  ports: {
    get orchestrator() { return port('ORCHESTRATOR', 7100); },
    get planner() { return port('PLANNER', 7101); },
    get evaluator() { return port('EVALUATOR', 7102); },
    get marketGateway() { return port('MARKET_GATEWAY', 7103); },
    get simulator() { return port('SIMULATOR', 7104); },
  },
  urls: {
    get orchestrator() { return url('ORCHESTRATOR', 7100); },
    get planner() { return url('PLANNER', 7101); },
    get evaluator() { return url('EVALUATOR', 7102); },
    get marketGateway() { return url('MARKET_GATEWAY', 7103); },
    get simulator() { return url('SIMULATOR', 7104); },
  },

  get marketBase() { return env('MARKET_BASE_URL', 'https://market.near.ai'); },
  get maxInflight() { return num('ROOK_MAX_INFLIGHT', 6); },
  get pollMs() { return num('ROOK_POLL_MS', 10_000); },
  get paymentGraceS() { return num('ROOK_PAYMENT_GRACE_S', 600); },
  get maxRehires() { return num('ROOK_MAX_REHIRES', 2); },
  get ratePerMin() { return num('ROOK_RATE_PER_MIN', 60); },
};
