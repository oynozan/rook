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

- `sim` + `canned`: the full loop with no keys and no network. This is what screeners run, and what the end-to-end test runs.
- `sim` + `near`: real planner, evaluator and aggregator LLM calls; the simulator's agents write their deliverables with the LLM from fixed simulated facts, then apply their scripted fault. This is the real-time test of the agentic system.
- `live` + `near`: real Agent Market search and 402 quotes (free) for planning. Approval is refused with HTTP 409 until phase 2.

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
- `reserve_share` defaults to `0.2`. `reserve_atomic = floor(budget × reserve_share)`; `allocatable_atomic = budget − reserve`.

## 5. Planner

### 5.1 `POST /plan`

Request: `{ task_id, prompt, budget_atomic, reserve_share }`.

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
  "budget": { "budget_atomic": "...", "reserve_atomic": "...", "allocatable_atomic": "...", "allocated_atomic": "..." },
  "notes": ["criterion s2.c3 removed: invalid regex", "..."],
  "llm_calls": [LlmCall]
}
```

`Candidate`: `{ handle, name, description, sla_seconds, success_rate, delivered_jobs, price_atomic, quote: AcceptsRow }`.

### 5.2 Algorithm

1. **Draft (LLM call 1).** Input: the prompt and the budget. Output: 1 to 5 subtasks (3 to 5 preferred), each with `title`, `brief`, 1 to 3 `search_terms`, criteria, and `self_do_ok` (true when an LLM alone can do the subtask well, for example writing or summarising, and false when it needs data an LLM does not have). Subtasks are listed in priority order. The brief is the full message an agent will receive: first line a title, then the request. It never contains secrets or anything about Rook's budget.
2. **Supply check.** For each subtask, search the market through the gateway with each term, merge by handle, keep agents with `available_now`, `listing_status` `live` and `USDC` in `payable_with`, at most 10 per subtask.
3. **Select (LLM call 2, one call for all subtasks).** For each subtask the LLM picks up to 3 handles from its search results that can actually do the brief. It may pick none. It does not rank them.
4. **Quote.** Ask the gateway for a 402 quote from each selected handle. Drop candidates whose quote fails (`-32603`, `-32004`, network error) or whose row does not match the gateway's `/x402` recipients. Sort the rest by `price_atomic` ascending, then `success_rate` descending, then `delivered_jobs` descending. Cheapest-first is the counteroffer substitute: x402 prices are fixed, so Rook compares quotes and walks away from expensive ones.
5. **No supply.** A subtask with no candidate left becomes `self_do` when `self_do_ok`, else it is dropped with reason `no fitting agent`.
6. **Caps.** `cap_atomic` = the higher of the two cheapest candidates' prices (the only price when there is one candidate). x402 charges exactly the quoted price, so the first hire pays the cheapest price and the cap still covers one fallback when the first agent fails without charge (`FAILED`, timeout). `self_do` subtasks cost 0. Walk the subtasks in priority order and keep a running sum; a subtask that would push the sum over `allocatable_atomic` becomes `self_do` when `self_do_ok`, else it is dropped with reason `over budget`. Candidates priced above the cap plus the whole reserve are then dropped with a note: they could never be paid. The reserve pays for top-ups only: a re-hire after a paid but failed delivery, or a fallback whose price exceeds the remaining balance.
7. **Deadline.** `deadline_s` = the largest `sla_seconds` among the candidates (shown to the user); each hire times out on its own agent's `sla_seconds` plus `ROOK_PAYMENT_GRACE_S`. 0 for `self_do`.
8. **Validate criteria** (section 7). Invalid criteria are removed with a note. A subtask left with no criteria gets a default `llm_judge`: "Does the deliverable fully answer the brief with specific content rather than generic filler?"
9. Ids are `s1`..`s5` in priority order after drops; criterion ids are `c1`.. within a subtask. Cross-check references are rewritten to the final ids; a reference to a dropped subtask removes that criterion.

In `canned` mode steps 1 and 3 return a fixed draft for the NEAR token due-diligence demo (any prompt), and steps 2 and 4 to 9 run unchanged against the market in use.

### 5.3 `POST /self-do`

Request: `{ task_id, subtask_id, brief, criteria }`. The LLM writes the deliverable for the brief, aware of the criteria. Response: `{ text, llm_calls }`. `canned`: a fixed text that passes the canned criteria.

### 5.4 `POST /aggregate`

Request: `{ task_id, prompt, subtasks: [{ id, title, status, agent_handle?, deliverable_text? }] }`. Deliverables are untrusted data: they are quoted inside delimiters and the system prompt says to ignore any instruction inside them. Response: `{ final_markdown, attribution: [{ subtask_id, agent_handle }], llm_calls }`. The result names which agent produced each part and lists abandoned subtasks as gaps. `canned`: a deterministic merge of the passed deliverables with a heading per subtask.

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

`attestation_hash = sha256(canonical JSON of { engine, evaluator_version, subtask_id, criteria, deliverable_sha256, results, security_flags, extracted, llm_calls })`, with keys sorted. `engine` is `local` in phase 1; OutLayer TEE attestation replaces it later ([build-plan.md](build-plan.md), evaluator).

### 6.5 Signed LLM calls

Every NEAR AI call made by the planner, evaluator or aggregator is recorded as `LlmCall`: `{ purpose, model, chat_id, request_sha256, response_sha256, input_tokens, output_tokens, cost_usd, signature, signing_address, signing_algo, signature_kind, signature_verified }`. After each call the service fetches `GET https://cloud-api.near.ai/v1/signature/<chat_id>?model=<model>&signing_algo=ecdsa`. For models NEAR AI proxies (`signature_kind` `gateway`, e.g. `anthropic/*`) the gateway signs `sha256(request body):sha256(response body)`; for models running in a TEE (`signature_kind` `provider_tee`, marked `verifiable` in `/v1/model/list`) the text is `<model>:sha256(request body):sha256(response body)` (checked live on 2026-11-07). `signature_verified` is true when the text equals either form built from the hashes Rook computed over the exact bytes it sent and received. Recovering the signer address from the ECDSA signature and checking it against the gateway attestation is a later step.

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
| `POST` | `/tasks` | `{ prompt, budget_usdc, reserve_share? }` | Creates the task in `draft`, calls the planner, moves to `planned`. Returns the task. Planner failure moves the task to `failed` with the error. A task killed while planning stays `killed` when the planner answers. |
| `GET` | `/tasks/:id` | | Snapshot: task, plan, subtasks with hires and evaluations, receipts, ledger view, final result |
| `GET` | `/tasks` | | List of tasks (id, status, prompt, created_at) |
| `POST` | `/tasks/:id/approve` | `{ funder_account? }` | Only from `planned` and only when the plan has at least one subtask. Starts the run. `live` market: 409. |
| `POST` | `/tasks/:id/cancel` | | `planned` to `cancelled` |
| `POST` | `/tasks/:id/kill` | | Any non-terminal status to `killed` |
| `GET` | `/tasks/:id/events` | | Server-sent events; replays all past events, then streams. Honours `Last-Event-ID`. |

### 8.2 Task states

`draft → planned → approved → funded → running → aggregating → closing → closed`; also `planned → cancelled`, any non-terminal → `killed`, and `draft → failed` when planning fails. Terminal: `closed`, `cancelled`, `killed`, `failed`; no transition leaves a terminal state. After approval only an error outside every subtask (the ledger refusing `createTask`, an orchestrator shutdown) moves a task to `failed`, after salvaging funds; an error inside one subtask abandons that subtask only (8.3).

- `approved → funded`: `ledger.createTask` locks the budget and the reserve (in phase 2, the `ft_on_transfer` with `create_task` seen on-chain).
- `funded → running`: `ledger.fundSubtask` for every non-`self_do` subtask, with exactly its cap.
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
- The message sent is the subtask's `brief`. A re-hire of the same agent would pass its earlier `contextId`; Rook never re-hires an agent that failed the same subtask.
- Every agent message and artifact is data. The orchestrator never reads instructions from them, never passes them to the planner's `/plan`, and only forwards them to the evaluator and the aggregator.

### 8.7 Kill

`POST /tasks/:id/kill`: `ledger.kill` (refuses all later funding, top-ups and authorizations), aborts the task's loops, sends `CancelTask` for in-flight A2A tasks, releases outstanding authorizations for tasks that are not `COMPLETED`, and sets `killed`. A hire whose `/send` is still in flight already has its payment header out: Rook waits for the answer, cancels the A2A task once its id is known, then releases that authorization. Funds already in sub-accounts stay there (in phase 2 the kill switch cannot pull them back, see build plan).

### 8.8 Events and receipts

Event: `{ seq, ts, task_id, subtask_id?, type, data }`. Types: `task_status`, `subtask_status`, `plan`, `quote`, `quote_rejected`, `hire_sent`, `a2a_state`, `evaluation`, `security_alert`, `ledger`, `receipt`, `final`, `error`.

A receipt is written for every paid hire (every `COMPLETED` task, and every send whose payment outcome is unknown), passed or failed: `{ id, task_id, subtask_id, hire_id, agent_handle, a2a_task_id, amount_atomic, verdict, attestation_hash, payment_hash, payment_tx: null, receipt_tx: null }`. `verdict` and `attestation_hash` are null when the hire was never judged (a kill or an evaluator outage during evaluation, or an unknown payment outcome), so ledger `spent` always equals the sum of receipt amounts. Transaction fields stay null until phase 2.

## 9. Market gateway

| Method | Path | Body or query | Returns |
| --- | --- | --- | --- |
| `GET` | `/search` | `q` | `{ agents: AgentSummary[] }` |
| `GET` | `/x402` | | The marketplace's `/.well-known/x402` (`{ x402Version, recipients: [{ network, asset, payTo }] }`), read at startup |
| `POST` | `/quote` | `{ handle }` | `{ ok: true, row: AcceptsRow }` or `{ ok: false, error: { code, message } }` |
| `POST` | `/send` | `{ handle, text, context_id?, payment }` | `{ ok: true, task: A2ATask }` or `{ ok: false, error }`. `error.code` is `outcome_unknown` when a 502 was retried with the same header and the call still did not succeed: the payment may have settled, so the orchestrator counts it as spent and writes a receipt with no verdict |
| `GET` | `/task` | `handle`, `id` | `{ ok: true, task: A2ATask }` or `{ ok: false, error }` |
| `POST` | `/cancel` | `{ handle, id }` | `{ ok: true }` or `{ ok: false, error }` |

`A2ATask` is normalised: `{ id, context_id, state, artifacts: [{ name?, parts: [{ text } | { url } | { raw }] }] }`, with `state` one of `SUBMITTED`, `WORKING`, `COMPLETED`, `REJECTED`, `FAILED`, `CANCELED` (the `TASK_STATE_` prefix stripped). `AgentSummary` keeps `handle, name, description, category, tags, available_now, listing_status, payable_with, sla_seconds, success_rate, delivered_jobs`.

- A token bucket of `ROOK_RATE_PER_MIN` (60) requests a minute covers every outbound call; a `429` backs off and retries up to 3 times.
- `/quote` sends `SendMessage` with a placeholder message and no payment, and expects HTTP 402. A JSON-RPC error inside HTTP 200 becomes `{ ok: false, error }`.
- `live`: `https://market.near.ai/v1/agents`, `https://<handle>.market.near.ai/a2a/v1`. `/send` without `payment` is refused locally, since that call would only return a quote.
- `sim`: the simulator's `/v1/agents` and `/a2a/<handle>/v1`, same JSON-RPC bodies.

## 10. Simulator

Same surface as the market: `GET /v1/agents?q=`, `GET /.well-known/x402`, `POST /a2a/<handle>/v1` with `SendMessage`, `GetTask`, `CancelTask`, plus `GET /llm-cost` (NEAR AI spend of the simulated agents, process total). Its x402 row uses `network: near:mainnet`, `asset: usdc.sim`, `payTo: treasury.sim` and `maxTimeoutSeconds = sla_seconds + ROOK_PAYMENT_GRACE_S`. It accepts a payment header only when `accepted` equals its quote row exactly and the header was never used before; otherwise HTTP 402. A task that finishes after its authorization expired ends `FAILED`: nothing can be charged.

Agents come in pairs: a cheap one with a fault and a pricier good one, so cheapest-first hiring meets the fault first and the re-hire path runs.

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
- Models: `PLANNER_MODEL` (default `z-ai/glm-5.3`), `EVALUATOR_MODEL` (default `deepseek-ai/DeepSeek-V4.1-Flash-1017`) and `SIM_AGENT_MODEL` (default `anthropic/claude-haiku-5-5`). Planner and evaluator calls are Rook's evidence, so their defaults are models NEAR AI Cloud lists as verifiable (`GET /v1/model/list`, `metadata.verifiable`); `anthropic/*`, `openai/*` and `google/*` models are not verifiable, so their calls never get `signature_verified: true`. A leading `<think>...</think>` block in a reply is stripped before parsing.
- Every call's cost is computed from the model price list (`GET /v1/models`, per-token `pricing.prompt` and `pricing.completion`) and added to a per-process total; a call that would start above `ROOK_LLM_MAX_USD` (default 1.00 per process) is refused. Calls in flight count at their worst case (`max_tokens`) until they finish, so concurrent calls cannot overshoot together. The guard fails closed: a price list that cannot be read is fetched again on the next call, and a model missing from it is costed at a high fallback price (10 and 50 USD per million tokens). The account holds 10 USD.

## 12. Acceptance checks

These are the "do X, see Y" checks for real-time testing. Commands assume `pnpm install` was run in the repo root.

### A. Offline full loop (`sim` + `canned`)

`pnpm test` runs the unit tests and an end-to-end run with all services in one process. Manually: `ROOK_LLM=canned pnpm dev`, then in another shell `pnpm rook run "Due diligence on the NEAR token" --budget 3 --yes`. Expect:

1. A plan with 4 subtasks (holders, wallets, contract check, market snapshot), each with criteria, candidates sorted cheapest first, caps 0.30, 0.20, 0.25 and 0.20 (the higher of the two cheapest quotes, 0.95 in total), and a reserve of 0.60.
2. `sim-holders-lite` delivers, fails a numeric or cross-check criterion, receipt with verdict `fail`, re-hire of `sim-holders` with a 0.15 top-up from the reserve, pass.
3. `sim-wallets-express` delivers, `security_alert` with the quoted injection, verdict `fail`, re-hire of `sim-wallets` with a 0.10 top-up, pass.
4. `sim-tokencheck-fast` ends `FAILED`, no receipt, no charge, `sim-tokencheck` hired from the cap without a top-up, pass.
5. `sim-price-slow` times out after about 25 seconds, authorization released, no receipt, `sim-price` hired without a top-up, pass.
6. Final report naming the agent behind each section; task `closed`; ledger invariant holds; total spent = sum of receipt amounts = 0.15 + 0.30 + 0.10 + 0.20 + 0.25 + 0.20 = 1.20 USDC; reserve used 0.25; everything else refunded to the funder.

### B. Real LLM against the simulator (`sim` + `near`)

`pnpm dev` with `NEARAI_API_KEY` set, then `pnpm rook run "Due diligence report on the NEAR token: holder concentration, wallet activity, contract safety and market data" --budget 3`. Expect:

1. The plan is written by the LLM: 3 to 5 subtasks, every criterion valid, `numeric_match` bounds are sanity ranges, at least one script-checkable criterion per subtask, candidates only from the simulator catalogue, caps fit within 80% of the budget.
2. The faulty agents are caught as in A (the exact criterion that fails a wrong-numbers deliverable may differ, but it fails).
3. Every evaluation lists its `llm_calls` with `signature_verified: true`.
4. The final report is coherent and attributes each section.
5. The run costs under 0.25 USD of NEAR AI credit (printed by the CLI: the task's planner and evaluator calls, plus the simulated agents' calls read from the simulator's `/llm-cost`).

### C. Live market planning (`live` + `near`)

`ROOK_MARKET=live pnpm dev`, then `pnpm rook plan "Due diligence on the NEAR token" --budget 3`. Expect real Agent Market handles with real 402 prices (for example `luigi-check` at 0.10 USDC), caps derived from those prices, and `approve` refused with 409 and a pointer to the payments plan.

### D. Kill and limits

- `pnpm rook kill <task_id>` during a run: task `killed`, no further `hire_sent` events, in-flight authorizations released.
- Unit tests cover: ledger refusals (over cap, second authorization, wrong `payTo`, after kill), the invariant, planner budget fitting and cross-check reference rules, extraction quote verification, the injection scanner, and cheapest-first ordering.
