# Rook

Rook takes one task and a USDC budget, splits it into checkable subtasks, hires Agent Market agents for them, verifies every deliverable against criteria written before hiring, and re-hires from a limited reserve when a check fails. Spending limits are enforced by a ledger (the NEAR budget contract in phase 2), not by a prompt.

Status: phase 1. The agentic system (planner, evaluator, orchestrator) runs against a simulated market, or plans against the live Agent Market. Paying real agents over x402 is phase 2: [docs/x402-payments-plan.md](docs/x402-payments-plan.md).

## Quick start (no keys, no network)

```sh
pnpm install
pnpm test                       # 43 tests, including a full end-to-end run
ROOK_LLM=canned pnpm dev        # starts the five services on ports 7100-7104
# in another shell:
ROOK_LLM=canned pnpm rook run "Due diligence on the NEAR token" --budget 3 --yes
```

You see a plan of 4 subtasks with criteria, candidates and caps; then a cheap agent with wrong numbers fails a check and is re-hired, an agent whose deliverable carries a prompt injection raises a security alert and is re-hired, a failing agent is skipped without charge, a slow agent times out; then the final report with attribution, 6 receipts, and the ledger (spent 1.20 USDC, refunded 1.80).

## With real LLM calls

Put `NEARAI_API_KEY=...` in `.env` (repo root), then `pnpm dev` and `pnpm rook run "<task>" --budget 3`. Planner, evaluator and aggregator call NEAR AI Cloud; every call's signature is fetched and checked. Each process stops calling the LLM after `ROOK_LLM_MAX_USD` (default 1). A run costs about 0.10 USD.

Live market planning: `ROOK_MARKET=live pnpm dev`, then `pnpm rook plan "<task>" --budget 3`. Search and 402 quotes are free; approval is refused until phase 2.

CLI: `rook plan | run | approve <id> | status <id> | watch <id> | kill <id> | list`.

## Docs

- [docs/product.md](docs/product.md): what Rook is.
- [docs/agentic-system.md](docs/agentic-system.md): spec of the services, criteria, state machines, acceptance checks and the real-time test record.
- [docs/x402-payments-plan.md](docs/x402-payments-plan.md): plan for the signer, chain gateway and budget contract.
- [docs/build-plan.md](docs/build-plan.md): the hackathon build plan.

## Dependencies

Runtime: `zod`, `ajv`. Dev: `tsx`, `typescript`, `@types/node`. Code written with AI assistance (Claude Code).
