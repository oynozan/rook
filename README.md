# Rook

Rook is an AI agent that gets a job done by hiring other agents. You give it one task and a USDC budget. It splits the task into parts it can check, hires agents from the NEAR Agent Market for each part, checks every result against criteria it wrote before hiring, and re-hires when a check fails. It then gives you one report and returns the unspent USDC.

The budget is enforced by a NEAR contract, not by a prompt. Your funding transfer fixes a spending cap for each part. Each hire is paid from its own sub-account holding only that cap, refunds only ever go back to you, and you can stop the task at any time.

Rook runs on NEAR mainnet. The contract is `rook.oynozan.near`, and every real transaction so far is listed in [docs/x402-payments-plan.md](docs/x402-payments-plan.md), section 8.

## How a task runs

1. You sign in with a NEAR wallet and describe a task and a budget.
2. Rook drafts a plan: the parts, how each will be checked, the agents it would hire, and a price cap for each.
3. You approve the plan and fund it with one USDC transfer to the contract.
4. Rook hires and pays each agent over A2A and x402, then checks the work. A part that fails is re-hired from a small reserve.
5. You get the report and a receipt per hire, and the contract refunds the rest.

## Try it (simulation, no keys, no money)

```sh
pnpm install
pnpm test                       # services and web tests, all offline
ROOK_LLM=canned pnpm dev        # services on ports 7100-7104, simulated market and ledger
pnpm web                        # in another shell: http://localhost:7110/app
```

On PowerShell, set the variable first: `$env:ROOK_LLM = 'canned'; pnpm dev`.

You can also use the CLI: `pnpm rook run "Due diligence on the NEAR token" --budget 3 --yes`. To watch a prompt injection get refused, run `pnpm rook attack <task_id>` afterwards.

To run against real agents and real USDC, see [docs/operations.md](docs/operations.md).

## Hackathon tracks

- **Agents.** Rook hires agents per part over A2A and x402, pays each within its cap, and keeps a receipt per hire on the contract. x402 charges an agent's fixed price, so Rook stands in for a counteroffer by choosing between offers. It takes quotes from up to 3 agents per part, ranks them by price divided by the chance they pass, and walks away from any quote the cap can't pay.
- **Swarms.** Parts run in parallel. Each agent gets its own sub-account, so every on-chain action traces to one agent and one part. Rook also cross-checks numbers between agents' results.
- **Security.** Caps are enforced by the contract, each role has its own limited key, and deliverables are treated as data, never as instructions: one that tries to steer payment fails its check. `rook attack` replays such demands and shows each one refused.

## Project layout

| Folder | What it is |
| --- | --- |
| `services/` | The Node + TypeScript services: orchestrator, planner, evaluator, market gateway, signer, chain gateway, and a simulated market. `scripts/` holds the CLI, the dev runner and the deploy script. |
| `contract/` | The Rust budget contract: caps, reserve, per-part sub-accounts, kill switch, receipts. |
| `web/` | The Next.js app. Inside `src/`: `app/` (routes), `components/` (`app/` for the task UI, `landing/` for the home page), `hooks/`, `lib/` (`server/` for server-only code). Its tests are in `test/`. |
| `docs/` | Product, design and payment docs. |

## Docs

- [docs/product.md](docs/product.md): what Rook is and who it's for.
- [docs/agentic-system.md](docs/agentic-system.md): the services, their state machines and the test record.
- [docs/x402-payments-plan.md](docs/x402-payments-plan.md): payments, keys, the contract and the trust model.
- [docs/operations.md](docs/operations.md): modes, running on mainnet, every setting and key.
- [docs/model-choice.md](docs/model-choice.md): the NEAR AI models Rook uses and how their answers are verified.
- [contract/README.md](contract/README.md): the contract, its tests and the deploy steps.

## Dependencies

Services: `zod`, `ajv`, `near-api-js`, `@noble/curves`, `@noble/hashes`. Contract: `near-sdk`. Web: `next`, `react`, `@hot-labs/near-connect`, `lenis`, `motion`, `next-themes`, `blobatar`, `tailwindcss`. Tests and scripts run with `tsx`.

## License

MIT, see [LICENSE](LICENSE). Built with AI assistance (Claude Code). The agent search and run status UI are adapted from [Rare UI](https://rareui.com) ([licence](web/src/components/ui/RARE-UI-LICENSE)), and the theme toggle from [Skiper UI](https://skiper-ui.com).
