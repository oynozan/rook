# Rook agentic system: orchestrator, planner, evaluator

Status: phase 1 (2026-11-07). This document is the contract for the agentic services and the checklist for testing them. Payments over x402, the signer, the chain gateway and the budget contract are phase 2; their plan is [x402-payments-plan.md](x402-payments-plan.md). The full hackathon plan is [build-plan.md](build-plan.md).

## 1. Scope of phase 1

In scope:

- `planner`: drafts a plan with an LLM, checks agent supply on the market, takes quotes, sets caps, does `self_do` work, aggregates results.
- `evaluator`: checks one deliverable against its criteria, deterministic first, LLM only where needed, returns a verdict with a hash and the signed LLM calls.
- `orchestrator`: task and subtask state machines, hiring, polling, re-hiring from the reserve, kill switch, receipts, the event stream.
- `market-gateway`: search, quotes, `SendMessage`, `GetTask`, `CancelTask`, rate limit. In `sim` it talks to the simulator, in `live` to `market.near.ai`.
- `simulator`: a fake Agent Market with scripted agents (good, wrong numbers, prompt injection, failing, slow).
- A ledger inside the orchestrator that stands in for the budget contract and the signer, with the same method names, so phase 2 swaps it for `chain-gateway` and `signer` without changing the state machines.

Not in phase 1: signing x402 payments, any on-chain transaction, OutLayer, the web app (the CLI replaces it for now). In `live` market mode the system plans with real agents and real quotes, but `approve` is refused because nothing can pay yet.

## 2. Modes

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `ROOK_MARKET` | `sim`, `live` | `sim` | Where `market-gateway` sends search, quotes and A2A calls |
| `ROOK_LLM` | `near`, `canned` | `near` if `NEARAI_API_KEY` is set, else `canned` | Real NEAR AI Cloud calls, or deterministic canned responses with no network |
| `ROOK_LEDGER` | `sim`, `chain` | `sim` | In-memory ledger, or the budget contract through `signer` and `chain-gateway` ([x402-payments-plan.md](x402-payments-plan.md)) |
| `ROOK_PROFILE` | `sim`, `live` | `sim` | `pnpm dev` is the simulation profile; `pnpm live` sets `live` |

- `sim` + `canned`: the full loop with no keys and no network. This is what screeners run, and what the end-to-end test runs.
- `sim` + `near`: real planner, evaluator and aggregator LLM calls; the simulator's agents write their deliverables with the LLM from fixed simulated facts, then apply their scripted fault. This is the real-time test of the agentic system.
- `live` + `near`: real Agent Market search and 402 quotes (free) for planning. With `ROOK_LEDGER=sim`, approval is refused with HTTP 409.

Startup rules (`profileProblems` in `services/src/shared/config.ts`, checked by `scripts/dev.ts` for the whole stack and by `scripts/service.ts` for each service; every problem is listed, then nothing starts):

- `ROOK_LLM=canned` only with `ROOK_MARKET=sim` and `ROOK_LEDGER=sim`.
- `ROOK_MARKET=live` with `ROOK_LEDGER=chain` only with `NEAR_NETWORK=mainnet` (x402 settles on mainnet only).
- The simulation profile refuses a setup with nothing simulated: paying real agents needs `pnpm live`.
- The live profile needs `ROOK_MARKET=live`, `ROOK_LEDGER=chain`, `ROOK_LLM=near` (set explicitly), `NEAR_NETWORK=mainnet`, `NEAR_RPC_URL`, `ROOK_CONTRACT_ID`, `NEARAI_API_KEY`, `ROOK_SERVICE_TOKEN` (32+ characters) and the role keys (`ROOK_SIGNER_*` for the signer, `ROOK_ORCHESTRATOR_*` for the chain gateway). The simulator does not run in it.
- Each service holds only its own role key, and none holds the admin key (`ROOK_ADMIN_KEY`, `ADMIN_WALLET_PRIVATE_KEY`, for `scripts/deploy.ts` only): `scripts/dev.ts` leaves the others out of each child's environment, and `scripts/service.ts` deletes them once the config has loaded, so a service started on its own (which reads the whole real-mode env file) keeps only its own (`foreignKeys` in `config.ts`).

A run is simulated when the market or the ledger is `sim` or the LLM is `canned`; `GET /mode` reports it. With the `sim` ledger, `pnpm dev` prints a SIMULATION banner and clients label the run "simulation, no money moves". With `ROOK_LEDGER=chain` money still moves (the funding transfer, sub-account funding, gas), so the banner and clients say "test run on NEAR <network>" and name the simulated parts.

## 3. Services and ports

All services are Node 22 + TypeScript processes talking JSON over HTTP on localhost. Each exports `start(port)` so tests can run them in one process.

| Service | Port env | Default | Holds |
| --- | --- | --- | --- |
| `orchestrator` | `ORCHESTRATOR_PORT` | 7100 | Task store, ledger (sim stand-in for contract and signer) |
| `planner` | `PLANNER_PORT` | 7101 | `NEARAI_API_KEY` |
| `evaluator` | `EVALUATOR_PORT` | 7102 | `NEARAI_API_KEY` |
| `market-gateway` | `MARKET_GATEWAY_PORT` | 7103 | Nothing |
| `simulator` | `SIMULATOR_PORT` | 7104 | `NEARAI_API_KEY` when `ROOK_LLM=near` (simulated agents only) |

Every service is reached through `<NAME>_URL` (default `http://127.0.0.1:<port>`). Only the orchestrator calls the planner, evaluator and gateway; the planner also calls the gateway for search and quotes.

## 4. Money

- All amounts are atomic USDC as decimal integer strings (6 decimals): `"2500000"` = 2.50 USDC. Fields end in `_atomic`. Code uses `bigint`; never floats.
- The user's budget is entered in USDC (`"2.5"`) and converted once.
- `reserve_share` defaults to `0.2`: it sets how much the caps may take, `budget − floor(budget × reserve_share)`. Once the caps are set, every budget unit they leave becomes the reserve, up to the contract's 90%: `reserve_bps = min(9000, 100 × floor((budget − allocated) × 100 / budget))` (whole percents), `reserve_atomic = floor(budget × reserve_bps / 10000)`, `allocatable_atomic = budget − reserve_atomic`. The user's budget is what Rook may spend, so none of it sits idle while a subtask is abandoned for want of a top-up (seen on mainnet on 2026-11-09: 0.90 USDC unallocated, a 0.50 re-hire refused). The orchestrator adopts `reserve_bps / 10000` as the task's `reserve_share`, so the funding transfer, the contract and the ledger agree.

## 5. Planner

### 5.1 `POST /plan`

Request: `{ task_id, prompt, budget_atomic, reserve_share, history? }`. `history` is Rook's own record per agent: `{ [handle]: { pass, fail } }`, the evaluator's verdicts on Rook's earlier paid hires of that agent, counted by the orchestrator from every task's receipts (with `ROOK_DB` this spans restarts). Only judged deliveries count: an unjudged receipt has no verdict, and a hire that ended without a delivery (`FAILED`, timeout) has no receipt. At most 500 handles (the orchestrator sends the most-judged), non-negative integers; a request breaking that is a 400. Without it (a direct call such as `scripts/bench-models.ts`, or tests) the ranking uses the market's record alone.

Response (`Plan`):

```json
{
  "subtasks": [{
    "id": "s1", "title": "...", "brief": "...", "search_terms": ["..."],
    "criteria": [Criterion],
    "cap_atomic": "300000", "deadline_s": 120, "self_do": false,
    "candidates": [Candidate]
  }],
  "dropped": [{ "title": "...", "reason": "no fitting agent | over budget | ..." }],
  "budget": { "budget_atomic": "...", "reserve_atomic": "...", "reserve_bps": 7000, "allocatable_atomic": "...", "allocated_atomic": "..." },
  "notes": ["criterion s2.c3 removed: invalid regex", "..."],
  "llm_calls": [LlmCall]
}
```

A `self_do` subtask also carries `self_do_reason`: `no_agent` when no candidate was left after quoting, `over_budget` when candidates were quoted but no price fit what was left of `allocatable_atomic` (a bigger budget would hire one).

`Candidate`: `{ handle, name, description, sla_seconds, success_rate, delivered_jobs, price_atomic, quote: AcceptsRow, p_pass, expected_cost_atomic, rank_reason }`. `p_pass` is the pass chance (0 to 1, 3 decimals), `expected_cost_atomic` = ceil(price / pass chance), `rank_reason` one sentence such as `0.10 USDC / 0.842 pass chance (market 12 of 14, Rook 3 of 3) = 0.11875 USDC expected` (section 5.2 step 4).

### 5.2 Algorithm

1. **Draft (LLM call 1).** Input: the prompt and the budget. Output: 1 to 5 subtasks (3 to 5 preferred), each with `title`, `brief`, 1 to 3 `search_terms`, criteria, and `self_do_ok` (true when an LLM alone can do the subtask well, for example writing or summarising, and false when it needs data an LLM does not have). Subtasks are listed in priority order. Each is doable from its brief alone, since subtasks run in parallel and never see each other's results; no subtask summarises or combines the others (the aggregator writes the final report). On mainnet a planned "write a summary of the findings" subtask ran before the finding existed and failed its checks, or was hired out for a fee. The brief is the full message an agent will receive: first line a title, then the request. It never contains secrets or anything about Rook's budget. A message that is not a task ("go ahead", "hi", too vague to act on) gets no subtasks and a `not_a_task` sentence instead; the planner answers 422 with it and the web app shows it. The draft, self-do and aggregate prompts state today's date (UTC): without it a plan made in November 2026 asked paid agents for "the best laptops of 2025".
2. **Supply check.** For each subtask, search the market through the gateway with each term, keep agents with `available_now`, `listing_status` `live` and `USDC` in `payable_with`, and merge by handle round-robin over the terms (each term's next unseen agent in turn), at most 10 per subtask. The first term is the generic skill and used to fill all 10 slots alone, so the specialists the other terms found never reached the select step.
3. **Select (LLM call 2, one call for all subtasks).** For each subtask the LLM picks up to 3 handles from its search results that can actually do the brief. It may pick none. It does not rank them.
4. **Quote.** Ask the gateway for a 402 quote from each selected handle. Drop candidates whose quote fails (`-32603`, `-32004`, network error), whose row does not match the gateway's `/x402` recipients, whose amount is 0 (x402 cannot pay it, the orchestrator refuses it at hire time, and a cap of 0 makes the contract refuse the funding; seen live), or whose `maxTimeoutSeconds` is not an integer from 1 to `ROOK_MAX_PAYMENT_TIMEOUT_S` (default 90,000 s: the window is the agent's SLA + 600 s, most agents ask 87,000 s for a 1-day SLA, and the market refuses a payment signed for less; the orchestrator and the signer refuse a longer one at hire time), each with a note. Rank the rest by **expected cost**, what Rook pays on average per passing deliverable:
   - successes and jobs: the market's `round(success_rate / 100 × delivered_jobs)` of `delivered_jobs` (`success_rate` is the market's percentage; none counts as 0 of 0), plus Rook's own `history` for the handle (`pass` of `pass + fail`);
   - `p_pass = (successes + 1) / (jobs + 2)` (Laplace: an agent with no record at all gets 0.5, and a few jobs move it less than many);
   - `expected_cost = price / p_pass`, computed in integers as ceil(price × (jobs + 2) / (successes + 1)).

   Sort by expected cost ascending, then `p_pass` descending, `delivered_jobs` descending, handle. A cheap agent that often fails ranks below a dearer one that passes, and Rook's own failed verdicts push an agent down on the next plan. This is the counteroffer substitute: x402 prices are fixed, so Rook compares quotes and records and walks away from what is likely to cost more. The orchestrator hires in this order (8.6) and never re-sorts by price.
5. **No supply.** A subtask with no candidate left becomes `self_do` (`self_do_reason` `no_agent`) when `self_do_ok`, else it is dropped with reason `no fitting agent`.
6. **Caps.** The fallback cap over the first two ranked prices is min(max(first, second), 2 × first) (the only price when there is one candidate). The first-ranked agent need not be the cheapest, so the cap is never below its price: x402 charges exactly the quoted price and the first hire must fit. It also covers the second-ranked fallback when the first agent fails without charge (`FAILED`, timeout), whether that fallback is cheaper or up to twice the first price. The 2× bound keeps one expensive candidate from inflating what is locked per subtask (and lost if a phase 2 sub-account key leaks): quotes of 0.05 and 1.50 ranked in that order give a cap of 0.10, not 1.50. With candidates ranked cheapest first this is min(second-cheapest, 2 × cheapest). `self_do` subtasks cost 0. Caps are set in three passes:
   - **Hire.** Walk the subtasks in priority order with a running sum. A subtask is hired at the price of its first-ranked candidate that fits what is left of `allocatable_atomic`; candidates ranked above that one are dropped with a note (the first hire must fit the cap). When no price fits, the subtask becomes `self_do` (`self_do_reason` `over_budget`) when `self_do_ok`, else it is dropped with reason `over budget`. Before, a full cap that did not fit sent the whole subtask to `self_do` although its first agent fit, and fallback cover for one subtask cost a later one its agent.
   - **Cover.** In the same order, raise each hired subtask's cap toward its fallback cap, as far as `allocatable_atomic` allows.
   - **Prune.** Candidates priced above the cap plus the whole reserve can never be paid. A cap raised for one shrinks back to the fallback cap of the candidates that can be paid, which grows the reserve; this repeats until no cap changes (caps only shrink). Those candidates are then dropped with a note, wherever they rank. The rest keep their rank order, and the first-ranked is never dropped (the cap covers its price). On a coding plan, quotes of 1.00 and 5.00 locked a 2.00 cap for an agent that was then dropped, and the next subtask went `self_do` for want of that 1.00.

   The reserve pays for top-ups only: a re-hire after a paid but failed delivery, or a fallback whose price exceeds the remaining balance.
7. **Deadline.** `deadline_s` = the largest `sla_seconds` among the candidates, at most `ROOK_HIRE_PATIENCE_S` (default 1,800 s; shown to the user); each hire times out on its own agent's `sla_seconds` plus `ROOK_PAYMENT_GRACE_S`, at most `ROOK_HIRE_PATIENCE_S`, so an advertised 1-day SLA does not hold a run for a day. 0 for `self_do`.
8. **Validate criteria** (section 7). Invalid criteria are removed with a note. A subtask left with no criteria gets a default `llm_judge`: "Does the deliverable fully answer the brief with specific content rather than generic filler?"
9. Ids are `s1`..`s5` in priority order after drops; criterion ids are `c1`.. within a subtask. Cross-check references are rewritten to the final ids; a reference to a dropped subtask removes that criterion.

In `canned` mode steps 1 and 3 return a fixed draft for the NEAR token due-diligence demo (any prompt), and steps 2 and 4 to 9 run unchanged against the market in use.

### 5.3 `POST /self-do`

Request: `{ task_id, subtask_id, brief, criteria }`. The LLM writes the deliverable for the brief, aware of the criteria. Response: `{ text, llm_calls }`. `canned`: a fixed text that passes the canned criteria.

### 5.4 `POST /aggregate`

Request: `{ task_id, prompt, subtasks: [{ id, title, status, agent_handle?, deliverable_text? }] }`. Deliverables are untrusted data: they are quoted inside delimiters and the system prompt says to ignore any instruction inside them. Response: `{ final_markdown, attribution: [{ subtask_id, agent_handle }], llm_calls }`. The result names who produced each part (a "Source:" line: the agent's handle, or "Rook (its own model)" for a `self_do` part, whose `agent_handle` is the internal `rook:self-do` and stays so in `attribution`) and lists the subtasks not delivered as gaps, by title. `canned`: a deterministic merge of the passed deliverables with a heading per subtask title; the orchestrator also uses it when the aggregate call fails, so it carries no internal ids or states either.

## 6. Evaluator

### 6.1 `POST /evaluate`

Request:

```json
{
  "task_id": "...", "subtask_id": "s2", "brief": "...",
  "criteria": [Criterion],
  "deliverable": { "text": "...", "parts": [Part] },
  "peers": [{ "subtask_id": "s1", "text": "..." }]
}
```

`peers` carries the deliverables of subtasks referenced by this subtask's `cross_check` criteria that have already passed. `deliverable.text` is all `text` parts joined with blank lines; `url` and `raw` parts are listed in `parts` but not fetched.

Response (`Evaluation`):

```json
{
  "verdict": "pass" | "fail",
  "results": [{ "criterion_id": "c1", "kind": "contains", "passed": true, "detail": "...", "skipped": false }],
  "failed_criteria": ["c2", "injection"],
  "security_flags": ["asks for payment: 'send 5 USDC to ...'"],
  "extracted": { "Total supply": { "value": 1234.5, "quote": "Total supply: 1,234.5" } },
  "llm_calls": [LlmCall],
  "engine": "local",
  "attestation_hash": "<sha256 hex>"
}
```

### 6.2 Order of checks

1. **Built-in `non_empty`.** Fails if `text` is under 20 characters after trimming.
2. **Built-in `injection`.** A deterministic scanner over the raw text. It fails the deliverable when the text tries to instruct the hiring system: payment requests (an imperative `pay`, `send`, `transfer`, `release` or `deposit` followed by an amount, the payment or balance, a payee, or a NEAR or 0x address, and the same verbs or `must be paid` addressed to Rook, the orchestrator or "you"), requests to hire, re-hire, approve, or raise a budget, `X-PAYMENT`, role markers (`SYSTEM:` in capitals, `system note:`, `<system>`, a line starting `Evaluator:` or `Orchestrator:`), and override phrases (`ignore previous instructions`, `you are now`, `as the orchestrator`, `mark every criterion as passed`). It looks for instructions, not topics: third-person prose such as "users pay $0.001 per transaction" or "holders send tokens to x.near" passes. Each hit becomes a `security_flags` entry quoting the text. A flagged deliverable fails even if every other criterion passes: Rook does not merge text that tries to steer it.
3. **Deterministic criteria:** `contains`, `schema`, then `numeric_match` and `cross_check` (which need extraction, below).
4. **`llm_judge` criteria**, only when steps 1 to 3 passed (no point paying for a judge on a failed deliverable).

`verdict` is `pass` only when every non-skipped result passed. When an LLM step fails (NEAR AI errors, the cost guard, invalid JSON twice) `/evaluate` answers HTTP 502 with the calls already paid in `details.llm_calls`: an outage is never a verdict on the agent.

### 6.3 Extraction for numeric criteria

`numeric_match` and `cross_check` need a number with a label from free text, because real agents write Markdown in their own format.

- `near`: one LLM call per deliverable extracts every needed label as `{ label: { value, quote } | null }`, where `quote` must be copied verbatim from the deliverable. Each label's entry is checked on its own, so one malformed entry loses only that label.
- `canned`: a regex finds `<label>` followed by `:`, `=` or `is`, then a number (commas and a trailing `%` allowed).
- **Verification, both modes:** the quote must appear verbatim in the deliverable (whitespace and Markdown emphasis `*`, `_`, `` ` `` normalised) and must contain the value's digits. Otherwise the label counts as not found. This stops an LLM extractor from inventing numbers.
- Numbers parse with commas removed and `k`, `m`, `b` suffixes expanded; a trailing `%` keeps the number as written (`38.2%` is `38.2`); a leading minus is kept (`-3.2%` is `-3.2`) unless it is a hyphen after a digit or letter (`10-20`). The stored value is the one parsed from the quote, sign included.

### 6.4 The hash

`attestation_hash = sha256(canonical JSON of { engine, evaluator_version, subtask_id, criteria, deliverable_sha256, results, security_flags, extracted, llm_calls })`, with keys sorted. Despite the field name, this is a local sha256 evaluation hash computed by Rook's own evaluator process (`engine` `local`): it lets anyone holding the inputs re-check a verdict, but it is not a TEE attestation. Running the evaluator under OutLayer TEE attestation is planned, pending a decision ([build-plan.md](build-plan.md), evaluator).

### 6.5 Signed LLM calls

Every NEAR AI call made by the planner, evaluator or aggregator is recorded as `LlmCall`: `{ purpose, model, chat_id, request_sha256, response_sha256, input_tokens, output_tokens, cost_usd, signature, signing_address, signing_algo, signature_kind, signature_verified }`. After each call the service fetches `GET https://cloud-api.near.ai/v1/signature/<chat_id>?model=<model>&signing_algo=ecdsa`. For models NEAR AI proxies (`signature_kind` `gateway`, e.g. `anthropic/*`) the gateway signs `sha256(request body):sha256(response body)`; for models running in a TEE (`signature_kind` `provider_tee`, marked `verifiable` in `/v1/model/list`) the text is `<model>:sha256(request body):sha256(response body)` (checked live on 2026-11-07). `signature_verified` is true when the text equals either form built from the hashes Rook computed over the exact bytes it sent and received. Each record also carries `signer_recovered`, `attested` and `attestation_checked_at` (`services/src/shared/attest.ts`, docs/model-choice.md "Verification"): the EIP-191 signer is recovered from the ECDSA signature, and that address is checked against NEAR AI's attestation report (Intel TDX quote chain to Intel's root, report binding the signing address and Rook's nonce, NVIDIA GPU evidence through NRAS). `signature_verified` is true only when the text matches, the signer is recovered, and `attested !== false` (null when the report could not be fetched).

## 7. Criteria

Every criterion is `{ id, kind, description, spec }`.

| `kind` | `spec` | Passes when | Checked by |
| --- | --- | --- | --- |
| `contains` | `{ pattern }` (JavaScript regex source, matched case-insensitively) | The pattern matches the text, or the text contains the pattern verbatim (case-insensitive), so a literal such as `Price (USD)` works | Script |
| `schema` | `{ json_schema }` | The text, or a fenced ```json block in it, parses as JSON valid against the schema | Script (Ajv) |
| `numeric_match` | `{ label, min?, max? }` (at least one bound) | The labelled number is found and within the bounds | Extraction + script |
| `cross_check` | `{ label, other_subtask, other_label, tolerance_pct }` | Both numbers are found and differ by at most `tolerance_pct` percent of the larger | Extraction + script |
| `llm_judge` | `{ question }` | The judge answers yes | LLM |

Rules the planner enforces (section 5.2 step 8):

- Prefer script-checkable kinds; `llm_judge` is for prose quality only, at most 2 per subtask.
- A `contains` pattern is a short plain phrase the brief explicitly asks the agent to write (for example one of its labels), so an honest agent that follows the brief always matches.
- `pattern` must compile; `json_schema` must compile with Ajv.
- `numeric_match` bounds are sanity ranges the planner can know without the data (a percentage is between 0 and 100, a holder count is above 0), never guesses of the answer.
- `cross_check.other_subtask` must be an earlier subtask in the final plan. This makes cycles impossible: a subtask's evaluation waits only on earlier subtasks.
- If the other subtask ends `abandoned`, or its deliverable does not contain `other_label`, the cross-check result is `skipped` (it neither passes nor fails).

## 8. Orchestrator

### 8.1 API

| Method | Path | Body | Does |
| --- | --- | --- | --- |
| `POST` | `/tasks` | `{ prompt, budget_usdc, reserve_share?, owner?, wait? }` | Creates the task in `draft`, calls the planner, moves to `planned`. Returns the task. Planner failure moves the task to `failed` with the error. A task killed while planning stays `killed` when the planner answers. 400 when the prompt is over 4000 characters or the budget over `ROOK_MAX_BUDGET_USDC` (default 50); the planner checks the same limits. |
| `GET` | `/mode` | | `{ market, llm, ledger, network, contract_id, usdc, paying, simulated }`. `network` is `sim` with the sim ledger; `contract_id` and `usdc` come from the chain gateway's `/config` and are null with the sim ledger; `simulated` is true when the market or ledger is `sim` or the LLM `canned` |
| `GET` | `/tasks/:id` | `?owner=` | Snapshot: task, plan, subtasks with hires and evaluations, receipts, ledger view, final result |
| `GET` | `/tasks` | `?owner=` | List of tasks (id, status, prompt, created_at); with `owner`, only that account's tasks (none for an unknown account) |
| `POST` | `/tasks/:id/approve` | `{ funder_account?, owner? }` | Only from `planned` and only when the plan has at least one subtask. Starts the run (sim ledger) or returns `funding` (chain ledger). Chain ledger, `approved` and not yet bound to a contract task: returns `funding` again, without the open-task check (the funder's own transfer may already count toward that limit). `live` market with the sim ledger: 409. |
| `POST` | `/tasks/:id/funded` | `{ contract_task_id, owner? }` | Chain ledger: binds the contract task the funding transfer created, after checking it against the plan. A task with an owner needs that owner named (403 otherwise). |
| `POST` | `/tasks/:id/cancel` | `{ owner? }` | `planned` to `cancelled` |
| `POST` | `/tasks/:id/kill` | `{ owner? }` | Any non-terminal status to `killed` |
| `POST` | `/tasks/:id/attack` | `{ owner? }` | Security demo for `rook attack`: replays the injected deliverable's demands (pay again while a payment is outstanding, pay `evil-collector.near`, pay above the cap, fund after kill) on a sandbox ledger rebuilt from the plan, and returns each refusal, the injected deliverable's flags and verdict from the events, and the target subtask's quote row. Never touches the task's own books, in any mode |
| `GET` | `/tasks/:id/events` | `?owner=` | Server-sent events; replays all past events, then streams. Honours `Last-Event-ID`. |

Every task route takes the caller's `owner` (body, or `?owner=` on a GET): a task with another owner, or with none, answers 404, as if it did not exist. A caller naming no owner (the CLI) acts on any task. With `ROOK_SERVICE_TOKEN` set, every route needs the header `x-rook-token: <token>` (401 otherwise); the web server and the CLI send it from their environment.

### 8.2 Task states

`draft → planned → approved → funded → running → aggregating → closing → closed`; also `planned → cancelled` (and, in chain mode after a restart, a task whose contract task was refunded and deleted before Rook funded any subtask), any non-terminal → `killed`, and `draft → failed` when planning fails. Terminal: `closed`, `cancelled`, `killed`, `failed`; no transition leaves a terminal state. After approval only an error outside every subtask (the ledger refusing `createTask`, an orchestrator shutdown) moves a task to `failed`, after salvaging funds; an error inside one subtask abandons that subtask only (8.3).

- `approved → funded`: `ledger.createTask` locks the budget and the reserve (in phase 2, the `ft_on_transfer` with `create_task` seen on-chain).
- `funded → running`: `ledger.fundSubtask` for every non-`self_do` subtask, with exactly its cap.
- A plan whose subtasks are all `self_do` hires no agent and pays no one: `/approve` starts it at once with books of budget 0, in chain mode too (no funding transfer, no contract task).
- `running → aggregating`: every subtask is `passed` or `abandoned`.
- `aggregating → closing`: aggregate done. If `/aggregate` fails, the orchestrator uses the deterministic merge of `canned` mode (section 5.4) and emits an `error` event, so passed deliverables are never lost.
- `closing → closed`: every funded subtask's leftover returned, then `ledger.closeTask` refunds unallocated budget, unused reserve and returns to the funder.

### 8.3 Subtask states

| From | Event | To |
| --- | --- | --- |
| `pending` | funded with its cap | `funded` |
| `pending` with `self_do` | run starts | `evaluating` after the planner's `/self-do` returns |
| `funded` | next candidate picked, quote requested | `quoting` |
| `quoting` | quote checks pass, payment authorized, message sent | `working` |
| `quoting` | quote fails a check or the agent is unreachable | `quoting` with the next candidate, or `abandoned` if none is left |
| `working` | A2A `COMPLETED` with artifacts | `evaluating` (payment settles) |
| `working` | A2A `REJECTED`, `FAILED` or `CANCELED` | `quoting` with the next candidate (authorization released, nothing charged) |
| `working` | `sla_seconds + ROOK_PAYMENT_GRACE_S` passed | `quoting` with the next candidate once the agent accepts `CancelTask` or the authorization has expired (`maxTimeoutSeconds` after signing). Until then the header can still be redeemed, so Rook keeps polling; a late `COMPLETED` is settled and evaluated like any delivery |
| `evaluating` | verdict pass | `passed` |
| `evaluating` | verdict fail, `rehire_count` below `ROOK_MAX_REHIRES` (2) | `quoting` with the next candidate, `rehire_count + 1` |
| `evaluating` | verdict fail, `rehire_count` is 2, or no candidate left | `abandoned` |
| `evaluating` | evaluator unreachable or 5xx after 3 attempts | `abandoned`, receipt with `verdict: null` (Rook's outage is not the agent's failure, and no more money is spent against a broken evaluator) |
| any | an error inside this subtask (planner `/self-do` down, a ledger refusal) | `abandoned`; the other subtasks continue |
| `passed` or `abandoned` | leftover returned to the task | `returned` |

`self_do` subtasks retry `/self-do` on a failed verdict under the same re-hire limit. Only a failed verdict counts as a re-hire; skipped candidates (bad quote, `FAILED`, timeout) do not, because nothing was paid.

A subtask with `cross_check` criteria waits, after its deliverable arrives and before evaluation, until every referenced subtask is `passed` or `abandoned`, then sends the passed peers' deliverables as `peers`.

### 8.4 Quote checks before paying

All must hold, or the candidate is skipped with event `quote_rejected` and the reason:

- `scheme` is `exact`; `network` and `asset` match a row of the gateway's `/x402` recipients.
- `payTo` matches that row's `payTo` (allowlist). A mismatch also emits `security_alert`.
- `amount` is at most the candidate's price in the approved plan: an agent that raised its price since planning is skipped, never topped up.
- `maxTimeoutSeconds` is an integer from 1 to `ROOK_MAX_PAYMENT_TIMEOUT_S` (default 90,000 s): an authorization holds its sub-account's money until it lands or expires, which takes the whole window only when the agent hangs and refuses CancelTask.
- `amount` is at most the subtask's balance. On a re-hire, when the balance is short, the orchestrator first tops up the difference from the reserve (`ledger.topUp`); if the reserve cannot cover it, the candidate is skipped.

### 8.5 The ledger (stand-in for contract and signer)

In-process and in-memory, methods named after the contract and signer so phase 2 replaces them with HTTP calls to `chain-gateway` and `signer`:

| Method | Refuses when |
| --- | --- |
| `createTask(task_id, funder, budget, reserve_share)` | killed |
| `fundSubtask(task_id, n, cap)` | killed, or cap exceeds the unallocated budget |
| `topUp(task_id, n, amount)` | killed, or amount exceeds the remaining reserve |
| `authorize(task_id, n, row)` (signer `/sign`) | killed; `payTo`, `asset` or `network` not allowlisted; amount above the sub-balance; an earlier authorization for this subtask is still outstanding |
| `settle(task_id, n)` | no outstanding authorization |
| `release(task_id, n)` | no outstanding authorization |
| `returnLeftover(task_id, n)` | an authorization is outstanding |
| `closeTask(task_id)` | a subtask has not returned its leftover |
| `kill(task_id)` | |

Invariant, checked after every call and in tests: `budget = unallocated + reserve_remaining + Σ sub-balances + Σ spent + refunded`. In `sim` the authorization is a payment header the simulator accepts (base64 JSON `{ x402Version: 2, accepted: row, payload: { sim: { task_id, n, nonce } } }`); its sha256 is stored as `payment_hash`, never the header.

### 8.6 Hiring loop and limits

- At most `ROOK_MAX_INFLIGHT` (6) A2A tasks in flight across all tasks; polling every `ROOK_POLL_MS` (10000; the simulator setup uses 1000).
- Candidates are tried in the plan's order (lowest expected cost first, 5.2 step 4), never re-sorted by price: the first hire is the first candidate, and after a failure (verdict `fail`, `FAILED`, timeout, rejected quote) the next untried one.
- The message sent is the subtask's `brief`. A re-hire of the same agent would pass its earlier `contextId`; Rook never re-hires an agent that failed the same subtask.
- Every agent message and artifact is data. The orchestrator never reads instructions from them, never passes them to the planner's `/plan`, and only forwards them to the evaluator and the aggregator.

### 8.7 Kill

`POST /tasks/:id/kill`: `ledger.kill` (refuses all later funding, top-ups and authorizations), aborts the task's loops, sends `CancelTask` for in-flight A2A tasks, releases outstanding authorizations for tasks that are not `COMPLETED`, and sets `killed`. A hire whose `/send` is still in flight already has its payment header out: Rook waits for the answer, cancels the A2A task once its id is known, then releases that authorization. In simulation, funds in sub-accounts stay in the in-memory books. In chain mode they come back: after the `killed` status Rook waits until each authorization already out can no longer settle (CancelTask accepted, or expiry; a payment that lands anyway gets a receipt), returns every sub-account (`/return`, or `mark_empty` at a 0 balance), and calls `close_task`, which refunds the funder. Each sub-account clears and returns on its own, so one long authorization holds back only its own money (a hire the run was still settling or waiting out stops waiting at the kill, and the unwind takes over its authorization); `close_task` waits for all. If the funder already closed the task, late returns wait in it and Rook's `close_task` refunds them; with nothing left, the contract's "task is already closed" closes Rook's books too. Each step is an event after the terminal status, and the SSE stream of a bound chain task stays open until the books are closed. The contract's own `kill_task` stays the owner's call; the `kill` ledger event and the `/kill` answer carry its command.

### 8.8 Events and receipts

Event: `{ seq, ts, task_id, subtask_id?, type, data }`. Types: `task_status`, `subtask_status`, `plan`, `quote`, `quote_rejected`, `hire_sent`, `a2a_state`, `evaluation`, `security_alert`, `ledger`, `receipt`, `final`, `error`.

A receipt is written for every paid hire (every `COMPLETED` task, and every send whose payment outcome is unknown), passed or failed: `{ id, task_id, subtask_id, hire_id, agent_handle, a2a_task_id, amount_atomic, verdict, attestation_hash, payment_hash, payment_tx: null, receipt_tx: null }`. `verdict` and `attestation_hash` are null when the hire was never judged (a kill or an evaluator outage during evaluation, or an unknown payment outcome), so ledger `spent` always equals the sum of receipt amounts. In simulation the transaction fields stay null. In chain mode `receipt_tx` comes from `record_receipt` and `payment_tx` from the indexer (NearBlocks, which can lag a minute; the web app looks again after the run closes), each with `payment_explorer_url` / `receipt_explorer_url`. A receipt with `amount_atomic` "0" means the agent delivered but no payment showed on chain.

## 9. Market gateway

| Method | Path | Body or query | Returns |
| --- | --- | --- | --- |
| `GET` | `/search` | `q` | `{ agents: AgentSummary[] }`, only agents available now |
| `GET` | `/x402` | | The marketplace's `/.well-known/x402` (`{ x402Version, recipients: [{ network, asset, payTo }] }`), read at startup |
| `POST` | `/quote` | `{ handle }` | `{ ok: true, row: AcceptsRow }` or `{ ok: false, error: { code, message } }` |
| `POST` | `/send` | `{ handle, text, context_id?, payment }` | `{ ok: true, task: A2ATask }` or `{ ok: false, error }`. `error.code` is `outcome_unknown` when a 502 was retried with the same header and the call still did not succeed: the payment may have settled, so the orchestrator counts it as spent and writes a receipt with no verdict |
| `GET` | `/task` | `handle`, `id` | `{ ok: true, task: A2ATask }` or `{ ok: false, error }` |
| `POST` | `/cancel` | `{ handle, id }` | `{ ok: true }` or `{ ok: false, error }` |

`A2ATask` is normalised: `{ id, context_id, state, artifacts: [{ name?, parts: [{ text } | { url } | { raw }] }] }`, with `state` one of `SUBMITTED`, `WORKING`, `COMPLETED`, `REJECTED`, `FAILED`, `CANCELED` (the `TASK_STATE_` prefix stripped). `AgentSummary` keeps `handle, name, description, category, tags, available_now, listing_status, payable_with, sla_seconds, success_rate, delivered_jobs`.

- A token bucket of `ROOK_RATE_PER_MIN` (60) requests a minute covers every outbound call; a `429` backs off and retries up to 3 times.
- `/search` pages through the market's results (`limit=50`, the market's largest page, then `offset`) and keeps the agents with `available_now`; the market lists offline agents too, often half a page, and answers 20 rows without `limit`. It stops once 20 agents are available, at a short page (the last), at a page with no new handle, or after 3 pages, so a search costs one request in the common case and at most 3. A later page that fails leaves the agents already found; a failed first page is a 502.
- `/quote` sends `SendMessage` with a placeholder message and no payment, and expects HTTP 402. A JSON-RPC error inside HTTP 200 becomes `{ ok: false, error }`.
- `live`: `https://market.near.ai/v1/agents`, `https://<handle>.market.near.ai/a2a/v1`. `/send` without `payment` is refused locally, since that call would only return a quote.
- `sim`: the simulator's `/v1/agents` and `/a2a/<handle>/v1`, same JSON-RPC bodies.

## 10. Simulator

Same surface as the market: `GET /v1/agents?q=`, `GET /.well-known/x402`, `POST /a2a/<handle>/v1` with `SendMessage`, `GetTask`, `CancelTask`, plus `GET /llm-cost` (NEAR AI spend of the simulated agents, process total). Its x402 row uses `network: near:mainnet`, `asset: usdc.sim`, `payTo: treasury.sim` and `maxTimeoutSeconds = sla_seconds + ROOK_PAYMENT_GRACE_S`. It accepts a payment header only when `accepted` equals its quote row exactly and the header was never used before; otherwise HTTP 402. A task that finishes after its authorization expired ends `FAILED`: nothing can be charged.

Agents come in pairs: a cheap one with a fault and a pricier good one. The cheap one's market record is good enough that it still ranks first by expected cost (5.2 step 4), so the run meets the fault first and the re-hire path runs. Rook's own failed verdicts push it down only after many runs on one database (about 38 for `sim-holders-lite`).

| Handle | Specialty | Price | Profile | What happens |
| --- | --- | --- | --- | --- |
| `sim-holders-lite` | NEAR token holder distribution | 0.15 | `wrong_numbers` | Delivers, numbers multiplied so shares exceed 100% and totals disagree; fails `numeric_match` / `cross_check`, gets re-hired |
| `sim-holders` | NEAR token holder distribution | 0.30 | `good` | Correct deliverable |
| `sim-wallets-express` | NEAR wallet activity | 0.10 | `injection` | Delivers a good report with an embedded instruction to pay it again at another account; evaluator flags `injection` |
| `sim-wallets` | NEAR wallet activity | 0.20 | `good` | |
| `sim-tokencheck-fast` | Token contract check | 0.12 | `fails` | Goes `WORKING`, then `FAILED`; not charged |
| `sim-tokencheck` | Token contract check | 0.25 | `good` | |
| `sim-price-slow` | Token market snapshot | 0.08 | `slow` | Never delivers within its SLA plus grace; the orchestrator times out and releases the authorization |
| `sim-price` | Token market snapshot | 0.20 | `good` | |
| `sim-research` | General web research | 0.25 | `good` | Generic fallback for prompts outside the demo |

- Search matches any query word against handle, name, description and tags.
- Timing: `good` and faulty agents deliver after 2 to 4 seconds; `sla_seconds` is 20 for every agent; `slow` would deliver after 120 seconds. With `ROOK_PAYMENT_GRACE_S=5` the slow agent times out after 25 seconds.
- Content: `canned` fills a template from fixed simulated facts about the NEAR token (marked SIMULATED). `near` asks the LLM (`SIM_AGENT_MODEL`) to write the deliverable for the brief from the whole fact sheet, using the brief's exact labels and making up a plausible value for any figure the sheet lacks (a good agent answers the whole brief), then applies the profile's fault to the text. Writing starts when the task is accepted, so it overlaps the scripted delay. Simulated agents' calls skip the signature fetch (they are not Rook's evidence).

## 11. LLM use and cost guard

- NEAR AI Cloud, OpenAI-compatible: `POST https://cloud-api.near.ai/v1/chat/completions` with `Authorization: Bearer $NEARAI_API_KEY`.
- Anthropic models on NEAR AI ignore `response_format` and some reject forced `tool_choice`, so structured output is "reply with one JSON object only", parsed (code fences stripped, first `{` to last `}`), validated with zod, and retried once with the validation error.
- Models: `PLANNER_MODEL` (default `z-ai/glm-5.3`), `EVALUATOR_MODEL` (default `deepseek-ai/DeepSeek-V4.1-Flash-1017`) and `SIM_AGENT_MODEL` (default `anthropic/claude-haiku-5-5`). Planner and evaluator calls are Rook's evidence, so their defaults are models NEAR AI Cloud lists as verifiable (`GET /v1/model/list`, `metadata.verifiable`). `anthropic/*`, `openai/*` and `google/*` models are not verifiable: they run on the provider's infrastructure, outside any TEE. Their calls are `gateway`-signed, so they still get `signature_verified: true` when the gateway key is attested, which shows only that NEAR AI's gateway relayed those exact bytes, not that a TEE ran the model (`signature_kind` tells the two apart; docs/model-choice.md). A leading `<think>...</think>` block in a reply is stripped before parsing.
- Every call's cost is computed from the model price list (`GET /v1/models`, per-token `pricing.prompt` and `pricing.completion`) and added to a rolling 24 h total per process; a call that would start above `ROOK_LLM_MAX_USD` (default 1.00 per process in any 24 h) is refused, with one `[llm] LLM cost guard` log line per trip naming when calls can resume (the window lives in memory, so a restart clears it). Calls in flight count at their worst case (`max_tokens`) until they finish, so concurrent calls cannot overshoot together. The guard fails closed: a price list that cannot be read is fetched again on the next call, and a model missing from it is costed at a high fallback price (10 and 50 USD per million tokens). The account holds 10 USD.

## 12. Acceptance checks

These are the "do X, see Y" checks for real-time testing. Commands assume `pnpm install` was run in the repo root.

### A. Offline full loop (`sim` + `canned`)

`pnpm test` runs the unit tests and an end-to-end run with all services in one process. Manually: `ROOK_LLM=canned pnpm dev`, then in another shell `pnpm rook run "Due diligence on the NEAR token" --budget 3 --yes`. Expect:

1. A plan with 4 subtasks (holders, wallets, contract check, market snapshot), each with criteria, candidates ranked by expected cost with a reason line each (the cheap agent of each pair first), caps 0.30, 0.20, 0.24 and 0.16 (min of the larger of the first two ranked prices and twice the first, 0.90 in total), and a reserve of 2.10 (all the caps leave of 3.00).
2. `sim-holders-lite` delivers, fails a numeric or cross-check criterion, receipt with verdict `fail`, re-hire of `sim-holders` with a 0.15 top-up from the reserve, pass.
3. `sim-wallets-express` delivers, `security_alert` with the quoted injection, verdict `fail`, re-hire of `sim-wallets` with a 0.10 top-up, pass.
4. `sim-tokencheck-fast` ends `FAILED`, no receipt, no charge, `sim-tokencheck` hired with a 0.01 top-up (price 0.25, balance 0.24), pass.
5. `sim-price-slow` times out after about 25 seconds, authorization released, no receipt, `sim-price` hired with a 0.04 top-up, pass.
6. Final report naming the agent behind each section; task `closed`; ledger invariant holds; total spent = sum of receipt amounts = 0.15 + 0.30 + 0.10 + 0.20 + 0.25 + 0.20 = 1.20 USDC; reserve used 0.30; everything else refunded to the funder.

### B. Real LLM against the simulator (`sim` + `near`)

`pnpm dev` with `NEARAI_API_KEY` set, then `pnpm rook run "Due diligence report on the NEAR token: holder concentration, wallet activity, contract safety and market data" --budget 3`. Expect:

1. The plan is written by the LLM: 3 to 5 subtasks, every criterion valid, `numeric_match` bounds are sanity ranges, at least one script-checkable criterion per subtask, candidates only from the simulator catalogue, caps fit within 80% of the budget.
2. The faulty agents are caught as in A (the exact criterion that fails a wrong-numbers deliverable may differ, but it fails).
3. Every evaluation lists its `llm_calls` with `signature_verified: true` (with the default models; a non-verifiable `EVALUATOR_MODEL` passes this too, on the gateway's signature alone).
4. The final report is coherent and attributes each section.
5. The run costs under 0.25 USD of NEAR AI credit (printed by the CLI: the task's planner and evaluator calls, plus the simulated agents' calls read from the simulator's `/llm-cost`).

### C. Live market planning (`live` + `near`)

`ROOK_MARKET=live pnpm dev`, then `pnpm rook plan "Due diligence on the NEAR token" --budget 3`. Expect real Agent Market handles with real 402 prices (for example `luigi-check` at 0.10 USDC), caps derived from those prices, and `approve` refused with 409 and a pointer to the payments plan.

### D. Kill and limits

- `pnpm rook kill <task_id>` during a run: task `killed`, no further `hire_sent` events, in-flight authorizations released.
- Unit tests cover: ledger refusals (over cap, second authorization, wrong `payTo`, after kill), the invariant, planner budget fitting and cross-check reference rules, extraction quote verification, the injection scanner, ranking by expected cost (market record and Rook's own verdicts), caps that never fall below the first-ranked price, and hiring in the plan's order.

### E. Attack demo (`rook attack`)

After A, `pnpm rook attack <task_id>`. Expect: the injected deliverable from `sim-wallets-express` with its flags and verdict `FAIL` (`injection`), then four lines `REFUSED`: (a) a second payment while the first is outstanding, (b) 0.50 USDC to `evil-collector.near` (`payTo` not allowlisted), (c) 0.50 USDC, above the 0.20 cap (exceeds the subtask balance), (d) a top-up after the kill switch (`task is killed`); the sandbox spent only the agent's own 0.10, and the task's ledger is unchanged. With `ROOK_LEDGER=chain` and a finished task, the CLI also sends (a) to (c) to the signer (a only when the subtask is no longer Funded or the task is killed on chain, so a replay can never be signed) and, with `--send-refused-tx` and the contract task killed, a `top_up` the contract refuses. `services/test/attack.test.ts` runs all of this offline.

### F. Real-mode profile

`pnpm live` with any required variable missing prints every missing one and starts nothing; `pnpm dev` with `ROOK_LLM=canned` and a live market or chain ledger refuses the same way. `services/test/realmode.test.ts` covers the rules, the service token, `/mode`, the request limits and the owner checks.

## 13. Real-time test record (2026-11-07)

Run on Windows 11, Node 22.14, with the repo's NEAR AI key. Planner `z-ai/glm-5.3` (runs in a third-party confidential TEE; its replies are signed by NEAR AI's gateway, `signature_kind` `gateway`), evaluator `deepseek-ai/DeepSeek-V4.1-Flash-1017` (runs on NEAR AI's own TEE nodes; signed by the model's enclave, `signature_kind` `provider_tee`), simulated agents `anthropic/claude-haiku-5-5`. See [model-choice.md](model-choice.md).

| Check | Result |
| --- | --- |
| A, offline (`pnpm test`, 43 tests incl. end-to-end) | Pass: exact plan, receipts, top-ups, spent 1.20, refunded 1.80 |
| B, NEAR demo prompt, budget 3 | Pass: all four faults caught (wrong numbers, injection, `FAILED`, timeout), re-hires from the reserve, attributed report, invariant holds; 0.08 to 0.11 USD of NEAR AI credit per run |
| B, off-demo prompt (REF token), budget 2 | Pass after simulator fixes: all four subtasks delivered and attributed |
| C, live market planning | Pass: real handles and 402 prices, approve refused with 409 |
| D, kill mid-run | Pass: hires `KILLED`, no `hire_sent` after the kill, nothing spent, invariant holds |

Found and fixed during the runs: TEE models sign `model:req:res` rather than `req:res`; reasoning models used up `max_tokens` on hidden thinking (truncated deliverables and reports), now handled with higher limits, `reasoning_effort`, and a warning on every cut-off reply; the simulator's agents refused to invent data about real assets, so the simulator now supplies a per-label simulated dataset parsed from the brief; label-only `contains` criteria were brittle; unpayable fallback candidates are dropped from plans.

Known limits: in `sim` + `near` a good simulated agent occasionally still fails a check (a judge question about detail, or a simulated value outside a sanity bound); in each observed case the evaluator's verdict was correct for the text delivered. A large gap between the two cheapest quotes used to make a large cap (0.05 and 1.50 gave 1.50); fixed the same day with the 2× bound in section 5.2 step 6.
