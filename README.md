# Rook

Rook takes one task and a USDC budget, splits it into checkable subtasks, hires NEAR Agent Market agents for them over A2A and x402, checks every deliverable against criteria written before hiring, and re-hires from a limited reserve when a check fails. Spending limits are enforced by a NEAR budget contract and one capped sub-account per subtask, not by a prompt.

**Status, 2026-11-09.** Rook runs on NEAR mainnet. The budget contract is `rook.oynozan.near`. Its first real task hired the Agent Market agent `web-research` and paid it 0.50 USDC over x402 from a per-subtask sub-account ([payment transaction](https://nearblocks.io/txns/GTw5hCY4U43TExFNgr4NBkUG6s8NtFUmmcoS6sXzoZAP)). The evaluator passed its work, the receipt went on chain, and the contract refunded the unspent 1.00 USDC to the funder. Every transaction is listed in [docs/x402-payments-plan.md](docs/x402-payments-plan.md), section 8. Any NEAR account can fund its own task. Simulation is an explicit, labelled mode for development and for screeners, never the default for real use.

## Quick start: simulation, no keys, no network

```sh
pnpm install
pnpm test                       # 90 service tests, including a full end-to-end run and the attack demo (all offline)
ROOK_LLM=canned pnpm dev        # simulation profile: a SIMULATION banner, services on ports 7100-7104
# in another shell:
pnpm rook run "Due diligence on the NEAR token" --budget 3 --yes
pnpm rook attack <task_id>      # the task id that run printed
```

PowerShell (an `$env:` variable lasts for the session; `Remove-Item Env:ROOK_LLM` clears it):

```powershell
pnpm install
pnpm test
$env:ROOK_LLM = 'canned'; pnpm dev
# in another PowerShell window:
pnpm rook run "Due diligence on the NEAR token" --budget 3 --yes
pnpm rook attack <task_id>
```

What you see:

1. `pnpm dev` prints a yellow `SIMULATION: no real money moves` banner naming each simulated part (market, ledger, LLM). `pnpm rook run` prints the same line before planning.
2. A plan of 4 subtasks with criteria, candidates ranked by expected cost (price over pass chance, with the reason printed under each) and caps (0.30, 0.20, 0.24, 0.16 USDC; reserve 0.60).
3. The run: a cheap agent with wrong numbers fails a numeric check and is re-hired; an agent whose deliverable carries a prompt injection raises a `SECURITY ALERT` and is re-hired; a failing agent is skipped without charge; a slow agent times out and its authorization is released.
4. The final report with an agent named for each section, 6 receipts, and the ledger: spent 1.20 USDC, reserve used 0.30, refunded 1.80, invariant holds.
5. `rook attack`: the injected deliverable's flags and its `FAIL` verdict, then four demands, each `REFUSED` by the ledger: (a) pay the agent again while its payment is outstanding, (b) send 0.50 USDC to `evil-collector.near`, (c) pay above the subtask's cap, (d) fund a re-hire after the kill switch. It ends with `Nothing was paid`.

### The web app

```sh
pnpm web                        # http://localhost:7110 (landing page), http://localhost:7110/app (the app; needs pnpm dev)
```

1. Open http://localhost:7110/app and sign in with a NEAR wallet. You sign a message (NEP-413): no gas, no funds move, and the session lasts 7 days. Each account sees only its own tasks.
2. Type a task and a budget. Agents appear as Rook finds them while it plans; the plan shows each subtask's chosen agent, success rate, turnaround and price cap.
3. Approve. In simulation the run starts at once against the simulated ledger and the app labels it as simulation. With `ROOK_LEDGER=chain`, approving asks your wallet to send the USDC funding transfer to the budget contract with the approved caps, then Rook binds the contract task and runs it.

## Modes

`pnpm dev` is the simulation profile; `pnpm live` is the real one. Every client can ask the orchestrator `GET /mode` (`{market, llm, ledger, network, contract_id, usdc, paying, simulated}`) and shows "simulation, no money moves" whenever `simulated` is true and the ledger is `sim`; with `ROOK_LEDGER=chain` a simulated part makes it a test run on that NEAR network, where funding still moves tokens.

| | `pnpm dev` (simulation profile) | `pnpm live` (real) |
| --- | --- | --- |
| Agent Market `ROOK_MARKET` | `sim` (default): local simulator with scripted agents; `live`: real search and free 402 quotes | `live` |
| LLM `ROOK_LLM` | `canned` (default without `NEARAI_API_KEY`): fixed answers, no calls; `near`: NEAR AI Cloud | `near`, set explicitly |
| Ledger `ROOK_LEDGER` | `sim` (default): in memory; `chain`: budget contract on testnet, with the simulated market | `chain` on `NEAR_NETWORK=mainnet` |
| Refuses to start | `ROOK_LLM=canned` unless market and ledger are both `sim`; `ROOK_MARKET=live` with `ROOK_LEDGER=chain` off mainnet; any setup that pays real agents (use `pnpm live`) | any variable or key in the list below missing |
| Banner | `SIMULATION: no real money moves` (`TEST RUN on NEAR <network>` with `ROOK_LEDGER=chain`) | `LIVE: real Agent Market agents paid in USDC on NEAR mainnet` |

Other useful setups: `ROOK_LLM=near pnpm dev` (real planner and evaluator against the simulator, about 0.10 USD of NEAR AI credit per run; put `NEARAI_API_KEY=...` in `.env` at the repo root) and `ROOK_MARKET=live ROOK_LLM=near pnpm dev` (real agents and prices for planning; approving is refused because the ledger is simulated). Each process stops calling the LLM after `ROOK_LLM_MAX_USD` (default 1) in any 24 h, and logs when it trips.

Other test suites, all offline: `cd contract; cargo test -p rook-budget` (77 tests; on Windows set `AWS_LC_SYS_PREBUILT_NASM=1`) and `cd web; npx tsx --test src/app/app/*.test.ts` (25 tests: NEP-413 sign-in, the funding-outcome parser and transactions, the sign-in store).

## Running for real (`pnpm live`)

This runs on mainnet today (`rook.oynozan.near`, section 8 of the payments plan). Steps marked **owner** send real transactions.

1. **Owner:** build the contract (with `--cfg near`, see [contract/README.md](contract/README.md)), then run `pnpm --filter @rook/services exec tsx scripts/deploy.ts --network mainnet` with the admin account's key in `ROOK_ADMIN_KEY` (or `ADMIN_WALLET_PRIVATE_KEY` in the repo's `.env`, which no service reads). It creates `rook.`, `orch.` and `signer.` sub-accounts of the admin, deploys and initialises the contract, registers it on USDC, adds the two function-call role keys, and writes `~/.rook/mainnet.env` with everything below. It skips each step that is already done; `--dry` prints the plan, `--upgrade` deploys new code over existing state. Keep the contract funded with NEAR: about 0.066 per subtask in flight, nearly all of which comes back when the finished sub-account is deleted.
2. `pnpm live` reads `~/.rook/mainnet.env` (or the file in `ROOK_ENV_FILE`), the only file role keys are read from. To set the environment by hand instead, keep the keys out of the repo:

   ```sh
   export ROOK_MARKET=live ROOK_LEDGER=chain ROOK_LLM=near NEAR_NETWORK=mainnet
   export NEAR_RPC_URL=https://rpc.mainnet.fastnear.com ROOK_CONTRACT_ID=<contract>.near NEARAI_API_KEY=<key>
   export ROOK_SERVICE_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
   export ROOK_SIGNER_ACCOUNT=<signer>.near ROOK_SIGNER_KEY=ed25519:<...> ROOK_ORCHESTRATOR_ACCOUNT=<orch>.near ROOK_ORCHESTRATOR_KEY=ed25519:<...>
   pnpm live
   ```

   ```powershell
   $env:ROOK_MARKET='live'; $env:ROOK_LEDGER='chain'; $env:ROOK_LLM='near'; $env:NEAR_NETWORK='mainnet'
   $env:NEAR_RPC_URL='https://rpc.mainnet.fastnear.com'; $env:ROOK_CONTRACT_ID='<contract>.near'; $env:NEARAI_API_KEY='<key>'
   $env:ROOK_SERVICE_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   $env:ROOK_SIGNER_ACCOUNT='<signer>.near'; $env:ROOK_SIGNER_KEY='ed25519:<...>'; $env:ROOK_ORCHESTRATOR_ACCOUNT='<orch>.near'; $env:ROOK_ORCHESTRATOR_KEY='ed25519:<...>'
   pnpm live
   ```

   `pnpm live` checks all of these before starting anything and lists every one that is missing or wrong. Run `pnpm web` and `pnpm rook` with the same `ROOK_SERVICE_TOKEN`: with it set, the orchestrator answers 401 to any caller without it. The web app reads it from `web/.env.local` (with `NEXT_PUBLIC_NEAR_NETWORK=mainnet`); the CLI from `ROOK_ENV_FILE=~/.rook/mainnet.env`.
3. **Any user:** approve a plan and fund it with one click: one USDC `ft_transfer_call` from your own wallet to the contract, carrying the approved caps (`msg` = `{"create_task":{"reserve_bps":2000,"caps":[...]}}`). The sender becomes the task's funder: only it gets refunds, and it can stop (`kill_task`) and close its own task. The contract takes at least 1 USDC per task and at most 5 open tasks per funder (the owner can change both with `set_limits`). `pnpm rook approve <id>` prints the near-cli-rs command and `pnpm rook funded <id> <contract_task_id>` binds it; a task drafted by a signed-in account binds only a contract task that account funded.
4. Rook checks the contract task's budget, reserve and caps against the plan, then per subtask: registers a fresh key, funds the sub-account with exactly its cap, signs the x402 payment from it, records a receipt on the contract, returns the leftover (or marks an emptied sub-account returned with `mark_empty`) and closes the task, which refunds the rest to the funder.
5. `pnpm rook kill <id>` (or Stop in the app) makes the signer refuse every further payment and prints the funder's `kill_task` command for the contract. Rook then brings the money back itself: it waits until each payment already out can no longer settle (the agent accepted CancelTask, or the authorization expired), returns every sub-account, and closes the task so the contract refunds the funder. Each step is an event on the task.
6. If the services stop mid-run, the next start rebuilds each funded task from the contract and the sub-accounts' balances, polls hires whose payment was out by their A2A task id, and carries on; a killed or failed task with money still on chain is unwound. Nothing is signed twice.

Spending is bounded per task by `ROOK_MAX_BUDGET_USDC` (default 50) and by the caps in the owner's own funding transfer.

| Variable | Meaning |
| --- | --- |
| `NEAR_RPC_URL` | NEAR JSON-RPC endpoint. Required with `ROOK_LEDGER=chain`, no default, so nothing reaches a network by accident |
| `NEAR_NETWORK` | `testnet` (default) or `mainnet`; x402 rows must say `near:<network>` |
| `ROOK_CONTRACT_ID` | the deployed budget contract |
| `ROOK_SERVICE_TOKEN` | shared secret (32+ characters in the live profile) the orchestrator requires as `x-rook-token`; the web server and the CLI send it |
| `ROOK_SIGNER_ACCOUNT`, `ROOK_SIGNER_KEY` | the contract's signer role and its function-call key (`ed25519:...`) limited to `register_subtask_key` |
| `ROOK_SIGNER_KEY_DIR` | where sub-account keys are written (mode 0600), default `~/.rook/keys`; a directory inside the repo is refused |
| `ROOK_ORCHESTRATOR_ACCOUNT`, `ROOK_ORCHESTRATOR_KEY` | the orchestrator role and its function-call key on `fund_subtask, top_up, record_receipt, close_task, mark_empty` |
| `NEARBLOCKS_API_KEY`, `NEARBLOCKS_API_URL` | chain-gateway, optional: a NearBlocks key (sent as a Bearer token) and API base for finding payment transactions; keyless `api.nearblocks.io` / `api-testnet.nearblocks.io` by default |
| `ROOK_MAX_BUDGET_USDC` | largest budget one task may ask for (default 50); prompts are capped at 4000 characters |
| `ROOK_DB` | orchestrator: SQLite file for tasks; `pnpm dev` uses `services/data/rook.sqlite` |
| `ROOK_SESSION_SECRET` | web app: 32+ random characters that sign the sign-in cookie; required in production |
| `ROOK_SIGNIN_RECIPIENT` | web app: the domain the sign-in message names; required in production |
| `ROOK_DRAFTS_PER_HOUR` | web app: plans one account may draft per hour (default 20), so one account cannot drain the NEAR AI budget |
| `ROOK_WEB_DB` | web app: SQLite file for spent sign-in nonces, sessions, draft limits and sent funding transfers (default `web/.data/web.sqlite`) |
| `ORCHESTRATOR_URL`, `NEXT_PUBLIC_NEAR_NETWORK` | web app: where the orchestrator is (default `http://127.0.0.1:7100`) and the wallet network (default mainnet) |
| `NEXT_PUBLIC_NEAR_RPC_URL` | web app, optional: the RPC the browser reads funding transactions from, for the wallet's network (default FastNEAR) |
| `SIM_PAYMENT_NETWORK`, `SIM_USDC_ID`, `SIM_PAY_TO` | simulated market with `ROOK_LEDGER=chain` (testnet): quote in `near:testnet` with the contract's token and a payee. The simulator verifies each payment's NEP-366 delegate and never submits it |

## Architecture

Seven Node 22 + TypeScript services talking JSON over HTTP on localhost, one Next.js web app and one Rust contract. Only the signer holds spending keys, only the chain gateway sends contract calls, only the market gateway talks to Agent Market.

| Service | Port | Owns | Secrets |
| --- | --- | --- | --- |
| `web` (Next.js) | 7110 | Landing page, wallet sign-in, task chat, plan approval, browser funding, live run view | Session secret, service token |
| `orchestrator` | 7100 | Task and subtask state machines, hiring loop, re-hires, kill switch, receipts, SQLite store, event stream | Service token |
| `planner` | 7101 | Plan drafting, agent search, quotes, caps, `self_do` work, final aggregation | NEAR AI key |
| `evaluator` | 7102 | Verdicts: injection scan, deterministic checks, LLM judge; evaluation hash | NEAR AI key |
| `market-gateway` | 7103 | Agent search, 402 quotes, A2A `SendMessage` / `GetTask` / `CancelTask`, rate limit | None |
| `simulator` | 7104 | Fake Agent Market with scripted agents (simulation only) | NEAR AI key when `ROOK_LLM=near` |
| `signer` | 7105 | Per-subtask keys, x402 payments as NEP-366 delegates, leftover returns, refusals | Signer role key, sub-account keys |
| `chain-gateway` | 7106 | Contract calls and views, token balances | Orchestrator role key |
| budget contract (`contract/`) | | Budget, caps, reserve, sub-accounts, kill switch, receipts | None |

One task, end to end:

1. The web app (or `rook`) sends the task and budget to the orchestrator; the planner drafts subtasks with criteria, searches the market, takes free 402 quotes, and sets each cap.
2. The user approves. With the chain ledger, the user's own USDC `ft_transfer_call` creates the contract task with the approved caps and reserve; the contract's `task_created` event gives its id, and the orchestrator checks it against the plan.
3. Per subtask, in parallel: the signer registers a fresh key; the chain gateway calls `fund_subtask`, which creates `t<task>-<n>.<contract>` funded with exactly the cap.
4. The market gateway re-quotes; the orchestrator checks the row (scheme, network, asset, `payTo` allowlist, price not above the approved one, balance), topping up from the reserve when short; the signer signs the payment from the sub-account; the market gateway sends it with the brief and polls.
5. On delivery the evaluator checks the deliverable. Fail: the next candidate is hired (at most 2 re-hires). A payment counts only once the sub-account's USDC balance shows it. Every paid hire gets a receipt, written to the contract with `record_receipt`; it carries the A2A task id, the evaluation hash, and the payment and receipt transactions with explorer links (the payment transaction is looked up on NearBlocks, which can lag a minute).
6. When every subtask has passed or been abandoned, the planner merges the results with attribution, each sub-account returns its leftover, and `close_task` refunds the rest to the funder.

Spec: [docs/agentic-system.md](docs/agentic-system.md); payments: [docs/x402-payments-plan.md](docs/x402-payments-plan.md).

## NEAR features used

| Feature | Where | Status |
| --- | --- | --- |
| Agent Market search and A2A + x402 quotes (HTTP 402 rows, `/.well-known/x402`) | market-gateway, planner | Exercised for real: live planning against market.near.ai (quotes are free) |
| Agent Market paid hires: `X-PAYMENT` header from a NEP-366 signed delegate (`ft_transfer` to the marketplace treasury) | signer, market-gateway | Built and offline-tested (mock RPC; the simulator verifies each delegate). First real hire: planned, needs the owner's yes |
| NEP-366 meta transactions | signer | Built and offline-tested |
| USDC as NEP-141 (`ft_transfer_call` for `create_task` and returns, `ft_balance_of`) with NEP-145 `storage_deposit` | contract, signer, chain-gateway | Built and offline-tested with a mock token; mainnet USDC's storage bounds read live |
| Sub-accounts, one per subtask, created and funded by the contract | contract | Built and offline-tested |
| Function-call access keys scoped to the contract and named methods | chain-gateway, signer | Built and offline-tested; created at deploy |
| NEP-297 events (`task_created`, `subtask_funded`, `returned`, `receipt`, `killed`, ...) | contract, web funding | Built and offline-tested |
| NEP-413 signed messages for wallet sign-in | web | Exercised for real |
| NEAR AI Cloud inference with per-call response signatures, signer recovery and TEE attestation reports | planner, evaluator | Signed-hash checks exercised for real since 2026-11-07; signer recovery and attestation checks built 2026-11-09 against recorded NEAR AI reports ([docs/model-choice.md](docs/model-choice.md), "Verification") |
| OutLayer TEE execution of the evaluator | | Planned, pending a decision. Today each verdict carries a local sha256 evaluation hash (field `attestation_hash`) over the criteria, the deliverable's hash, the results and the LLM calls. It lets a verdict be re-checked later; it is not a TEE attestation |
| Chain Signatures (design C, no signer custody of sub-account keys) | | Planned, not built |

## Keys and their limits

No single leaked key can send USDC anywhere except approved caps into Rook's own sub-accounts and refunds to the funder ([docs/x402-payments-plan.md](docs/x402-payments-plan.md) 4.6).

| Key | Held by | Can do | Bound |
| --- | --- | --- | --- |
| Owner wallet (full access) | The human | Fund tasks (the caps are in the funding transfer), `kill`, `kill_task`, close a killed task, rotate roles | Everything the owner owns; never given to Rook |
| Orchestrator function-call key | `chain-gateway` | `fund_subtask`, `top_up`, `record_receipt`, `close_task`, `mark_empty` on the budget contract only; cannot attach NEAR or move tokens itself | Approved caps into signer-keyed sub-accounts, top-ups from the reserve, refunds to the funder |
| Signer function-call key | `signer` | `register_subtask_key` only | Cannot move tokens |
| Sub-account keys (one per subtask attempt, files outside the repo) | `signer` | Spend what is in that sub-account | Its cap plus top-ups; with the signer key, every funded sub-account of open tasks |
| Both role keys together | | Fund every approved cap and reserve into sub-accounts they can spend from | Approved caps plus reserves of open tasks |
| NEAR AI API key | `planner`, `evaluator`, `simulator` | LLM calls | `ROOK_LLM_MAX_USD` per process in any 24 h; drafts rate-limited per account in the web app |
| `ROOK_SERVICE_TOKEN` | orchestrator, web server, CLI | Act on any task through the orchestrator, naming any owner | Moves no money by itself; funding still needs the owner's transfer |
| `ROOK_SESSION_SECRET` | web server | Sign session cookies | Sessions only |

What needs the human's approval, always: deploying, creating accounts and keys, pre-funding the contract, funding a task, every mainnet hire, posting about the project and sending the hackathon submission.

## Tracks

- **Agents.** Rook is an agent that hires agents per subtask over A2A + x402, pays each from a capped sub-account within the budget, and keeps a receipt per hire (on the contract in chain mode). Counteroffer substitute: x402 charges an agent's fixed price, so Rook negotiates by choice: it takes 402 quotes from up to 3 candidates per subtask, ranks them by expected cost (price over a pass chance from the market's record and Rook's own verdicts on earlier hires) and hires in that order, caps each subtask at min(larger of the first two ranked prices, 2 x the first), skips any agent whose price rose after approval, and walks away from quotes the cap and reserve cannot pay.
- **Swarms.** One sub-account per hired agent under the contract, so every on-chain action traces to one agent and one subtask; subtasks run in parallel; cross-checks compare numbers between agents' deliverables. Simulation mode runs scripted agents with no LLM calls (`ROOK_LLM=canned`).
- **Security.** Caps fixed by the owner's own transfer and enforced by the contract; one sub-account per subtask; function-call keys split by role; deliverables are data, never instructions (an injection scanner fails any deliverable that tries to steer payment); `rook attack <task_id>` replays an injected deliverable's demands against the ledger, and in chain mode against the signer and the contract, and shows each refusal; kill switch; service token and per-account task scoping; budget and prompt limits.

## CLI

`pnpm rook plan | run | approve <id> | funded <id> <contract_task_id> | status <id> | watch <id> | kill <id> | attack <id> [--send-refused-tx] | mode | list`. In chain mode `rook attack` sends the signer only attempts it must refuse, and only for a finished task; the contract attempt (a `top_up` after `kill_task`) is a real transaction that costs gas, so it is sent only with `--send-refused-tx`.

## Docs

- [docs/product.md](docs/product.md): what Rook is.
- [docs/agentic-system.md](docs/agentic-system.md): services, criteria, state machines, acceptance checks and the real-time test record.
- [docs/x402-payments-plan.md](docs/x402-payments-plan.md): signer, chain gateway, budget contract, trust model.
- [contract/README.md](contract/README.md): the budget contract, its tests and the deploy runbooks.
- [docs/model-choice.md](docs/model-choice.md): NEAR AI models for the planner and evaluator, the benchmark, and what the signature checks verify.
- [docs/build-plan.md](docs/build-plan.md): the hackathon build plan.

## Dependencies

Services: `zod`, `ajv`, `near-api-js` (7.4.0), `@noble/curves` and `@noble/hashes` (2.2.0, signature recovery); dev `tsx`, `typescript`, `@types/node`. Contract: `near-sdk` 5.30.1. Web (`web/`): `next`, `react`, `react-dom`, `@hot-labs/near-connect`, `lenis`, `motion`, `next-themes`, `blobatar`, `@blobatar/react`; dev `tailwindcss`, `@tailwindcss/postcss`. Code written with AI assistance (Claude Code).

UI credits: the agent search and run status are adapted from [Rare UI](https://rareui.com) ([licence](web/src/components/ui/RARE-UI-LICENSE)); the theme toggle is adapted from [Skiper UI](https://skiper-ui.com).

## License

MIT, see [LICENSE](LICENSE).
