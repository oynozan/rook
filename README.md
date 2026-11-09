# Rook

Rook takes one task and a USDC budget, splits it into checkable subtasks, hires Agent Market agents for them, verifies every deliverable against criteria written before hiring, and re-hires from a limited reserve when a check fails. Spending limits are enforced by a ledger (the NEAR budget contract in phase 2), not by a prompt.

Status: phase 1. The agentic system (planner, evaluator, orchestrator) runs against a simulated market, or plans against the live Agent Market. Paying real agents over x402 is phase 2: [docs/x402-payments-plan.md](docs/x402-payments-plan.md).

## Quick start (no keys, no network)

```sh
pnpm install
pnpm test                       # 51 tests, including a full end-to-end run (all offline)
ROOK_LLM=canned pnpm dev        # starts the five services on ports 7100-7104
# in another shell:
ROOK_LLM=canned pnpm rook run "Due diligence on the NEAR token" --budget 3 --yes
```

You see a plan of 4 subtasks with criteria, candidates and caps; then a cheap agent with wrong numbers fails a check and is re-hired, an agent whose deliverable carries a prompt injection raises a security alert and is re-hired, a failing agent is skipped without charge, a slow agent times out; then the final report with attribution, 6 receipts, and the ledger (spent 1.20 USDC, refunded 1.80).

## With real LLM calls

Put `NEARAI_API_KEY=...` in `.env` (repo root), then `pnpm dev` and `pnpm rook run "<task>" --budget 3`. Planner, evaluator and aggregator call NEAR AI Cloud; every call's signature is fetched and checked. Each process stops calling the LLM after `ROOK_LLM_MAX_USD` (default 1). A run costs about 0.10 USD.

Live market planning: `ROOK_MARKET=live pnpm dev`, then `pnpm rook plan "<task>" --budget 3`. Search and 402 quotes are free; approval is refused until phase 2.

CLI: `rook plan | run | approve <id> | status <id> | watch <id> | kill <id> | list`.

## Running with ROOK_LEDGER=chain

Phase 2 swaps the in-memory ledger for the budget contract ([contract/README.md](contract/README.md)), a `signer` (port 7105) and a `chain-gateway` (port 7106). It is built and tested offline only, against a mock NEAR RPC; it has not run on testnet or mainnet yet. Nothing runs against a real network without the owner's yes: deploying, funding and every mainnet hire are the owner's own steps ([docs/x402-payments-plan.md](docs/x402-payments-plan.md) section 5).

Environment (export in your shell; keys never go in the repo, `.env` is git-ignored but a shell or secret store is better):

| Variable | Meaning |
| --- | --- |
| `ROOK_LEDGER=chain` | `pnpm dev` also starts `signer` and `chain-gateway`; the orchestrator uses them |
| `NEAR_RPC_URL` | NEAR JSON-RPC endpoint. Required, no default, so nothing reaches a network by accident |
| `NEAR_NETWORK` | `testnet` (default) or `mainnet`; x402 rows must say `near:<network>` |
| `ROOK_CONTRACT_ID` | the deployed budget contract |
| `ROOK_SESSION_SECRET` | web app: 32+ random characters that sign the sign-in cookie; required in production (development uses a per-process secret, so restarting `pnpm web` signs everyone out) |
| `ROOK_DB` | orchestrator: SQLite file for tasks; `pnpm dev` uses `services/data/rook.sqlite`, empty keeps tasks in memory |
| `ROOK_SIGNER_ACCOUNT`, `ROOK_SIGNER_KEY` | the contract's signer role and its function-call key (`ed25519:...`) limited to `register_subtask_key` |
| `ROOK_SIGNER_KEY_DIR` | where sub-account keys are written (mode 0600), default `~/.rook/keys`; a directory inside the repo is refused |
| `ROOK_ORCHESTRATOR_ACCOUNT`, `ROOK_ORCHESTRATOR_KEY` | the orchestrator role and its function-call key on `fund_subtask, top_up, record_receipt, close_task` |
| `SIM_PAYMENT_NETWORK`, `SIM_USDC_ID`, `SIM_PAY_TO` | simulated market only: quote in `near:testnet` with the contract's token and a payee account. The simulator then verifies each payment's NEP-366 delegate (signature, token, payee, amount, 30 Tgas, 1 yoctoNEAR) and never submits it. `pnpm dev` sets the network; set the other two yourself |

What the human does:

1. Deploys the contract and creates the accounts and keys (contract/README.md, "Deploy").
2. `pnpm rook run "<task>" --budget 3`, approves the plan. Rook does not move the budget: it prints the USDC `ft_transfer_call` to the contract with `msg` `{"create_task":{"reserve_bps":...,"caps":[...]}}` (the approved caps, in plan order) and the near-cli-rs command to send it from the owner account.
3. After the transfer: `pnpm rook funded <task_id> <contract_task_id>`. Rook checks the contract task's budget, reserve and caps against the plan, then for each subtask registers a fresh key, funds the sub-account, signs x402 payments from it, records receipts on the contract, returns the leftover and closes the task (the refund goes to the owner).
4. `rook kill <task_id>` makes the signer refuse every further payment and prints the owner's `kill_task` command; the contract-side kill is the owner's.

Known gap: a sub-account spent to exactly 0 cannot send a `return` (NEP-141 refuses 0 transfers), so `close_task` fails for that task until the contract can mark an empty subtask returned.

## Docs

- [docs/product.md](docs/product.md): what Rook is.
- [docs/agentic-system.md](docs/agentic-system.md): spec of the services, criteria, state machines, acceptance checks and the real-time test record.
- [docs/x402-payments-plan.md](docs/x402-payments-plan.md): plan for the signer, chain gateway and budget contract.
- [docs/model-choice.md](docs/model-choice.md): which NEAR AI models the planner and evaluator use, and the benchmark behind it.
- [docs/build-plan.md](docs/build-plan.md): the hackathon build plan.

## Dependencies

Runtime: `zod`, `ajv`, `near-api-js` (7.4.0, for `ROOK_LEDGER=chain`). Dev: `tsx`, `typescript`, `@types/node`. Web (`web/`, `pnpm web`, port 7110; landing page at `/`, the app at `/app`, which needs `pnpm dev` running): `next`, `react`, `react-dom`, `@hot-labs/near-connect`, `lenis`, `motion`, `next-themes`, `blobatar`, `@blobatar/react`; dev `tailwindcss`, `@tailwindcss/postcss`. Code written with AI assistance (Claude Code).

UI credits: the agent search and run status are adapted from [Rare UI](https://rareui.com) ([licence](web/src/components/ui/RARE-UI-LICENSE)); the theme toggle is adapted from [Skiper UI](https://skiper-ui.com).

## License

MIT, see [LICENSE](LICENSE).
