# Running Rook

How to run Rook in each mode, run it for real on NEAR mainnet, and what every setting and key does. The short overview is in the [README](../README.md).

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

## Running for real (`pnpm live`)

This runs on mainnet today (`rook.oynozan.near`, section 8 of the payments plan). Steps marked **owner** send real transactions.

1. **Owner:** build the contract (with `--cfg near`, see [contract/README.md](../contract/README.md)), then run `pnpm --filter @rook/services exec tsx scripts/deploy.ts --network mainnet` with the admin account's key in `ROOK_ADMIN_KEY` (or `ADMIN_WALLET_PRIVATE_KEY` in the repo's `.env`, which no service reads). It creates `rook.`, `orch.` and `signer.` sub-accounts of the admin, deploys and initialises the contract, registers it on USDC, adds the two function-call role keys, and writes `~/.rook/mainnet.env` with everything below. It skips each step that is already done; `--dry` prints the plan, `--upgrade` deploys new code over existing state. Keep the contract funded with NEAR: about 0.066 per subtask in flight, nearly all of which comes back when the finished sub-account is deleted. Each run of the script prints what is left of the role keys' gas allowances (the orchestrator burns about 0.013 NEAR of its 1 NEAR per task); when one runs low, `--rotate-keys` replaces both keys in one transaction each (add the new, delete the old) and rewrites the env file, after which the services restart. Keep the orchestrator and signer accounts funded too: they pay their own gas.
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
| `NEXT_PUBLIC_SITE_URL` | web app: the public address, e.g. `https://rook.example`; used for share links, the social card, sitemap and robots (default `http://localhost:7110`) |
| `ROOK_SIGNIN_RECIPIENT` | web app: the domain the sign-in message names; required in production |
| `ROOK_DRAFTS_PER_HOUR` | web app: plans one account may draft per hour (default 20), so one account cannot drain the NEAR AI budget |
| `ROOK_WEB_DB` | web app: SQLite file for spent sign-in nonces, sessions, draft limits and sent funding transfers (default `web/.data/web.sqlite`) |
| `ORCHESTRATOR_URL`, `NEXT_PUBLIC_NEAR_NETWORK` | web app: where the orchestrator is (default `http://127.0.0.1:7100`) and the wallet network (default mainnet) |
| `NEXT_PUBLIC_NEAR_RPC_URL` | web app, optional: the RPC the browser reads funding transactions from, for the wallet's network (default FastNEAR) |
| `SIM_PAYMENT_NETWORK`, `SIM_USDC_ID`, `SIM_PAY_TO` | simulated market with `ROOK_LEDGER=chain` (testnet): quote in `near:testnet` with the contract's token and a payee. The simulator verifies each payment's NEP-366 delegate and never submits it |

## Keys and their limits

No single leaked key can send USDC anywhere except approved caps into Rook's own sub-accounts and refunds to the funder ([docs/x402-payments-plan.md](x402-payments-plan.md) 4.6).

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

## CLI

`pnpm rook plan | run | approve <id> | funded <id> <contract_task_id> | status <id> | watch <id> | kill <id> | attack <id> [--send-refused-tx] | mode | list`. In chain mode `rook attack` sends the signer only attempts it must refuse, and only for a finished task; the contract attempt (a `top_up` after `kill_task`) is a real transaction that costs gas, so it is sent only with `--send-refused-tx`.

