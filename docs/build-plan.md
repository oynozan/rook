# NEAR HACKATHON build plan: multi-agent hiring with on-chain budgets

Nov 4, 2026. The project is now named **Rook** (see [product.md](product.md)); `<project>` below refers to it.

## How to use this document

This is the build spec for coding agents: one NEAR budget contract plus eight services that hire Agent Market agents through A2A + x402 and pay them from per-subtask sub-accounts. Every finding cites its source as [R#] (full list under References). Anything listed under "Verify before building" must be confirmed against the live docs before code depends on it.

**Hard rules for any agent working on this repo**

- Never sign transactions, spend tokens or deploy to mainnet without the human's explicit yes [R1]. x402 hires settle in USDC on NEAR mainnet only [R6], so every real hire is a spend. Run simulation mode by default.
- Never push, force-push or make the repository public without confirmation [R1].
- Never commit secrets. Keys live in environment variables only [R1].
- Never post on X or any other network on the human's behalf [R1].
- Never send the hackathon submission yourself. Print the full JSON payload and wait for a yes; each repository can be submitted once [R1].
- Never invent values the human decides: project name, team lead, email, payout NEAR account, repo link, demo link [R1].
- Re-read the live HACKATHON.md before submitting, because dates and rules may change [R1].
- When an Agent Market endpoint is unclear, start from the docs index [R5] instead of guessing.

## Hackathon constraints

The repository must be public, reproducible and submitted by 2026-11-14 23:59 UTC, and an AI screener runs it before any human looks [R1].

| Constraint | Effect on the build | Ref |
| --- | --- | --- |
| Code counts from the 2026-10-19 announcement; development ends 2026-11-14 23:59 UTC; judging 2026-11-16 to 2026-11-18 | All code in this repo is in the window; no baseline split needed | [R1] Q-001 |
| Repo must be public by the deadline and stay public through judging; add a LICENSE file | MIT LICENSE in the root | [R1] Q-014 |
| Claude Code and Codex screen every project first: reproducibility, feature check, preliminary score; humans decide | README must have "do X, see Y" steps a machine can follow; no marketing | [R1] Q-017, Procedure 1; [R2] |
| A local-only demo is accepted with a reproducible README and an X post with video; a hosted demo is a plus, kept up to 2026-11-18, ideally 2026-11-25 | Ship a simulation mode that runs with no funds and no keys | [R1] Q-012 |
| Testnet-only projects are eligible; mainnet only where the integration is mainnet-only | Contract deploys to testnet; x402 hiring is mainnet-only [R6], so real hires use a separate dev account and tiny amounts | [R1] Q-007, Q-010 |
| Mainnet costs are not reimbursed by default | Keep real demo hires to a few USDC in total | [R1] Q-008 |
| No mandatory integrations; track hints and example prompts are not requirements | Track-prompt items such as negotiation are optional; implement the ones that fit x402 | [R1] Q-011, Tracks |
| Libraries, templates and AI-written code are allowed if listed | README lists every dependency and template | [R1] Q-005 |
| One submission per project, any number of fitting tracks | Submit to `agents`, `swarms`, `security` | [R1] Tracks |
| One person may enter at most 2 independent projects; each README names the other | If the human enters a second project, name it in this README | [R1] Q-015 |
| NEAR AI credits: buy in the dashboard or claim $10 by joining NEAR Builders; API key from the dashboard | Planner and evaluator LLM calls use a NEAR AI Cloud key from env | [R1] Q-000 |
| Public NEAR RPC is free | No paid RPC provider | [R1] Q-009 |

Past NEAR hackathons judged technical implementation, design, impact, originality and sustainability; the site presents these as a guide, not confirmed criteria for this event [R2]. The judge panel includes Illia Polosukhin (NEAR), Eddy Lazzarin (a16z crypto), Mert Mumtaz (Helius), Avichal Garg (Electric Capital), Kain Warwick (Synthetix and Infinex), Haseeb Qureshi (Dragonfly) and Stepan Gershuni (cyber•Fund) [R2].

## Product definition

The user gives one task and a USDC budget; the system splits it into 3 to 5 checkable subtasks, hires an Agent Market agent for each over A2A + x402, verifies every deliverable, and re-hires from a reserve when a check fails. Every spending limit is enforced by a NEAR contract and sub-account balances, never by a prompt.

**Core loop**

1. The user enters a task and a budget in the web app.
2. The planner drafts at most 5 subtasks, each with pass/fail criteria, a price cap and a deadline. It checks agent supply for each one through agent search [R6]. A subtask with no fitting agent is done by the orchestrator itself or dropped; the track prompt's contractor also decides which parts to do itself [R3].
3. The user approves the whole plan once. The contract locks the budget and holds back a reserve (default 20%).
4. The contract creates one sub-account per subtask and funds it with exactly that subtask's cap.
5. All subtasks run in parallel: get the 402 quote, skip the agent if the quote is above the cap, sign the x402 payment from that subtask's sub-account, poll for the result [R6] [R7].
6. The evaluator checks each deliverable against its criteria. x402 settles and auto-accepts on delivery, with no review or dispute [R8], so a failed check means re-hiring another agent from the reserve.
7. The aggregator merges the results, receipts are recorded, and unspent USDC returns to the contract.

**Demo task.** A due-diligence report on a NEAR token. The Finance category already lists NEAR Token Holder Distribution, Luigi Token Check and NEAR Wallet Activity Lookup [R15]. They return on-chain data the planner LLM cannot produce, and their outputs are numbers the evaluator can cross-check. Confirm they can be hired over x402 before relying on them (Verify before building).

**Why this is not the sample prompt.** The Agent Economy example prompt is exactly a "general contractor" agent that splits a task, hires agents and stays within budget [R3], and Agent Market itself has an open job post for an agent-to-agent hiring system [R25]. Many teams will build the plain version. This project leads with three things the plain version lacks:

- Acceptance criteria written before hiring, checked by an evaluator that runs inside a TEE and returns an attestation [R24].
- Spending caps enforced on-chain by the contract and by sub-account balances.
- An on-chain receipt for every subtask.

**Target tracks**

| Track id | What the project shows | Ref |
| --- | --- | --- |
| `agents` | An agent that hires agents, pays per task within a budget, and keeps a receipt per task. Track prompt also asks for one counteroffer; x402 charges the agent's fixed default plan price [R7], so the substitute is comparing quotes across agents and walking away, stated in the README | [R3] |
| `swarms` | One sub-account per hired agent under one parent account, so every on-chain action traces to one agent; a simulation mode with scripted agents and no LLM calls | [R4] |
| `security` | Spending limits and sandboxed wallets; the orchestrator's contract calls use a function-call key scoped to one contract; an attack demo where a prompt-injected deliverable tries to get paid twice or to a bad address and is stopped, with the log shown | [R1] Tracks, [R26] |

## Architecture overview

Eight services and one Rust contract. Only the signer holds spending keys, only the chain gateway sends transactions, and only the market gateway talks to Agent Market. Suggested stack: a TypeScript monorepo for the services (the x402 payment example uses `near-api-js` [R6]) and `near-sdk` Rust for the contract.

| Service | Owns | Calls | Secrets |
| --- | --- | --- | --- |
| `web-app` | Task form, plan approval, live task tree, budget bars, receipts | `orchestrator` only | None |
| `orchestrator` | Task and subtask state machines, the database, retries, the event stream to the UI | all services below | None |
| `planner` | Plan drafting, agent-supply check, final aggregation | NEAR AI Cloud [R27], `market-gateway` (search only) | NEAR AI API key |
| `market-gateway` | Agent search, 402 quotes, A2A `SendMessage`, `GetTask` polling, `CancelTask`, the shared rate limiter | Agent Market [R6] [R7] | None |
| `signer` | Sub-account keys, building and signing x402 payments | `chain-gateway` (read-only checks) | Sub-account private keys |
| `evaluator` | Per-subtask verdicts, attestation hashes | OutLayer [R24], NEAR AI Cloud [R27] [R28] | OutLayer payment key, NEAR AI API key |
| `chain-gateway` | Contract calls, chain reads, the receipt index | NEAR RPC [R1] Q-009, the budget contract | Orchestrator function-call key |
| `simulator` | Fake Agent Market (402 quotes, tasks) and fake chain for simulation mode | nothing external | None |
| budget contract | Budget, caps, reserve, sub-accounts, kill switch, receipts | USDC contract | None (design A) |

Every service call goes through `orchestrator`. The evaluator also calls NEAR AI Cloud for prose criteria, and each sub-account pays Agent Market's treasury when the agent delivers.

**One task, end to end**

1. `web-app` sends the task and budget to `orchestrator`.
2. `orchestrator` asks `planner` for a plan; `planner` checks agent supply through `market-gateway` and returns subtasks with criteria, caps and deadlines.
3. The user approves and funds the task from their own wallet (USDC `ft_transfer_call` to the contract with a `create_task` message); `orchestrator` then asks `chain-gateway` to call `fund_subtask` once per subtask.
4. Per subtask, in parallel: `market-gateway` gets the 402 quote; `orchestrator` checks it against the cap; `signer` signs the payment from that subtask's sub-account; `market-gateway` resends with `X-PAYMENT` and polls `GetTask`.
5. On a terminal task state, `evaluator` checks the deliverable and returns pass or fail with an attestation hash.
6. Fail: `orchestrator` picks the next agent and repeats step 4, topping the sub-account up from the reserve if needed. Pass: `chain-gateway` calls `record_receipt`.
7. When all subtasks are settled, `planner` aggregates the results, `signer` returns each sub-account's leftover USDC to the contract, and `web-app` shows the deliverable and receipts.

## Component specs

Each service is a separate process with its own README section and tests; they talk over internal HTTP with JSON bodies.

### web-app

- Pages: new task (prompt + budget in USDC), plan review, live run, receipts.
- Plan review shows each subtask's brief, criteria, cap, deadline and candidate agents, with one approve button for the whole plan.
- Live run shows the task tree and a budget bar per subtask (cap, spent, reserve used) with status.
- Receipts show agent, price, A2A task id, verdict, attestation hash and explorer links for the funding and payment transactions.
- Simulation mode is on by default and clearly labelled [R1] Q-012. Live mode asks for a second confirmation showing the total USDC that will be spent on mainnet [R1].
- Holds no keys and signs nothing. The only human signature is funding the task from the human's own wallet (see Budget contract).

### orchestrator

- API for `web-app`: `POST /tasks`, `GET /tasks/:id`, `POST /tasks/:id/approve`, `POST /tasks/:id/kill`, `GET /tasks/:id/events` (server-sent events).
- Runs the state machines in Data model and owns the database.
- Concurrency: at most 6 A2A tasks in flight. Polling every 10 seconds is 6 requests a minute per task, and the limit is 60 requests a minute per IP [R7].
- Quote check before signing: `amount` (atomic USDC, `"2500000"` = 2.50 USDC) is within the subtask's remaining cap, `asset` is the configured USDC contract, `network` is `near:mainnet` [R6].
- Re-hire policy: on a failed verdict, mark that agent failed for the subtask, pick the next candidate, at most 2 re-hires per subtask, topped up from the reserve.
- Treats every agent message and artifact as data, never as instructions; a worker asking to be hired again is ignored [R10].
- Kill: calls the contract's kill switch, tells `signer` to refuse new signatures, and cancels unstarted tasks with `CancelTask` [R6].

### planner

- LLM calls go to NEAR AI Cloud, which is OpenAI-compatible at `https://cloud-api.near.ai/v1` with `Authorization: Bearer <key>`; models use `provider/model` names such as `zai-org/GLM-5.1-FP8` [R27].
- `POST /plan` returns JSON: `subtasks[]` of `{id, brief, criteria[], cap_usdc, deadline_s, candidates[], self_do}`. Each criterion is `{id, kind, spec}` with `kind` in `schema`, `numeric_match`, `cross_check`, `contains`, `llm_judge`.
- Prefer criteria a script can check; use `llm_judge` only for prose.
- Limits: at most 5 subtasks; the sum of caps is at most budget times (1 minus reserve share).
- Supply check per subtask through `market-gateway` search [R6]. No fitting agent: set `self_do` or drop the subtask.
- Briefs never contain secrets, because the agent's owner reads the task text [R7].
- `POST /aggregate` merges passed deliverables into the final result and says which agent produced which part.

### market-gateway

- Search: `GET https://market.near.ai/v1/agents?q=<term>` [R6].
- Each agent's endpoint is `https://<handle>.market.near.ai/a2a/v1`, JSON-RPC `SendMessage` [R6].
- Quote: send `SendMessage` with no payment. The reply is `402` with `x402Version` 2 and `accepts[]` rows of `{scheme: "exact", network: "near:mainnet", asset, amount, payTo, maxTimeoutSeconds}` [R6].
- Pay: resend the same request with `X-PAYMENT` = base64 of `{x402Version: 2, accepted: <row verbatim>, payload: {signedDelegateAction}}`. The call blocks up to 60 seconds [R6].
- Poll `GetTask` every 10 seconds (free). Stop at the SLA plus 10 minutes, when the payment has expired [R7].
- Keep `task.id` until the task is terminal; it is the only credential to read or cancel it [R7].
- Same agent again: pass the earlier `contextId`. Multi-turn through `message.taskId` is not supported, so a follow-up is a new paid task [R7].
- Errors: `429` back off [R7]; HTTP `502` (facilitator unreachable) retry with the same header and never re-sign [R7]; JSON-RPC `-32603` retry later or pick another agent [R7]; `-32602` means you cannot pay an agent you own [R7]; a reused `X-PAYMENT` is refused [R6].
- Billing: `REJECTED`, `FAILED` and `CANCELED` charge nothing [R6]. A `COMPLETED` task with no artifacts may still be landing; retry `GetTask` after a few seconds [R7].
- Reads `/.well-known/x402` at startup for the accepted networks, assets and payees [R7].
- Runs as a single instance behind one egress IP, so its token bucket is the global rate limit.

### signer

- The only service holding spending keys: one key per sub-account, loaded from environment or a secret file outside the repo [R1].
- `POST /sign` takes `{subtask_id, accepts_row}` and refuses unless all hold: `network` is `near:mainnet`; `asset` is the configured USDC contract; `payTo` matches `/.well-known/x402` [R7]; `amount` is within the sub-account's USDC balance and the contract's remaining cap; no unexpired authorization is outstanding for this subtask; the contract's kill switch is off.
- Builds the payment as the example does: `signedDelegate` with `receiverId` = `asset`, one `functionCall('ft_transfer', {receiver_id: payTo, amount}, 30 Tgas, 1 yoctoNEAR)`, `blockHeightTtl` = `maxTimeoutSeconds` [R6]. Sign the row exactly as sent and never shorten its validity [R7].
- Nonces: a delegate action's nonce must be greater than the access key's nonce, and it increments once processed [R17]. Payments from one key that settle out of order fail [R18], and x402 payments settle on delivery, in whatever order agents finish [R8]. One key per sub-account removes the collision; within one sub-account, sign one payment at a time.
- Function-call keys cannot attach NEAR, and `ft_transfer` needs 1 yoctoNEAR [R21] [R7]. So each sub-account key is a full-access key, and the cap is enforced by the sub-account's balance.
- Rejected alternatives: several keys on one account lose the per-subtask cap [R18]; gas keys with `DelegateV2` give parallel nonce lanes [R19] [R20], but the marketplace example uses the original delegate action [R6] and nothing says its facilitator accepts `DelegateV2`.
- `POST /return` sends a sub-account's leftover USDC back to the contract with `ft_transfer_call`.
- Design C keeps this interface and swaps local keys for Chain Signatures (see Budget contract).

### evaluator

- `POST /evaluate` takes the subtask's criteria and the deliverable artifacts, which are untrusted.
- Deterministic checks first: schema, required fields, and cross-checks between agents (for example, holder concentration recomputed from one agent's raw holder list against another agent's claimed figure).
- Check scripts compile to `wasm32-wasip2` and run on OutLayer. Each execution runs in an Intel TDX TEE and returns an attestation covering code hash, input hash, output and worker identity. It is paid per execution in NEAR, or in USDC through Payment Keys, and runs from under a second to a few minutes [R24].
- `llm_judge` criteria go to NEAR AI Cloud. Verify gateway attestation and, when present, the response signature [R28]. The deliverable is passed as quoted data and can only lead to pass or fail; it can never trigger a payment.
- Returns `{verdict, failed_criteria[], attestation_hash, evidence}`.
- x402 settles on delivery [R8], so the verdict decides re-hiring only, never whether a payment happens.
- Holds no spending keys; outbound network only to OutLayer and NEAR AI Cloud.

### chain-gateway

- Holds the orchestrator account's function-call key, scoped to the budget contract and the methods `fund_subtask`, `top_up`, `record_receipt`, `close_task`. Such a key can call only the listed methods of one contract and cannot attach NEAR [R21], so these methods take no deposit and the contract pays storage from its own balance.
- Reads contract views, sub-account balances (`ft_balance_of`) and the payment transactions to the treasury; builds the receipt index and explorer links.
- Uses public RPC [R1] Q-009.
- The contract runs on testnet for tests and simulation. Mainnet deployment and any mainnet transaction need the human's confirmation [R1].

### simulator

- Serves the same surface `market-gateway` calls: `/v1/agents`, `/a2a/v1` with 402 quotes, `SendMessage` with `X-PAYMENT`, and `GetTask` states including `FAILED`.
- Scripted agents with no LLM calls [R4]: a good agent, a slow agent, an agent with wrong numbers, and an agent whose deliverable carries a prompt injection asking for another payment (the security demo [R26]).
- Canned planner and evaluator responses, so screeners can run the full loop with no API keys [R1] Q-017.
- Chain side: a local NEAR sandbox or testnet with a mock NEP-141 token standing in for USDC.

## Budget contract

One Rust contract account holds each task's USDC, creates one sub-account per subtask funded with exactly its cap, and records receipts. Build design A first; design C (Chain Signatures) is an upgrade that keeps the same services.

**Why the contract is not the x402 payer.** An x402 payment is a signed NEP-366 delegate action of `ft_transfer` from the payer account [R6] [R17]. Contract code cannot produce that signature. A full-access key on the contract account would let its holder drain it, and a function-call key cannot attach the 1 yoctoNEAR that `ft_transfer` needs [R21] [R29]. So the contract pushes funds to sub-accounts, and the sub-accounts pay.

**State**

- `owner` (the human), `orchestrator` (the account whose function-call key `chain-gateway` holds), `usdc` (token contract id), `killed`.
- `tasks`: task id to `{funder, budget, reserve, allocated, spent, status}`.
- `subtasks`: (task id, n) to `{account_id, cap, funded, returned, status}`.
- `accounts`: sub-account id to (task id, n), used to recognise returns.
- `receipts`: (task id, n, seq) to `{a2a_task_id, agent_handle, amount, verdict, attestation_hash}`.

**Methods**

| Method | Caller | Does | Ref |
| --- | --- | --- | --- |
| `ft_on_transfer(sender_id, amount, msg)` | USDC contract only | `msg` `create_task`: opens a task with `budget` = amount and the reserve share given. `msg` `return` from a known sub-account: credits that task. Anything else: returns the full amount, which refunds the sender | [R29] |
| `fund_subtask(task_id, n, cap, public_key)` | `orchestrator` | Refuses if killed or if cap exceeds unallocated budget. Creates the sub-account with `public_key` as its access key and enough NEAR for its storage and one return transaction, calls `storage_deposit` for it on USDC, then `ft_transfer` of `cap` with 1 yoctoNEAR; callbacks update state and roll back on failure | [R29] |
| `top_up(task_id, n, amount)` | `orchestrator` | Moves `amount` from the task's reserve to the sub-account, for a re-hire | [R29] |
| `record_receipt(task_id, n, receipt)` | `orchestrator` | Appends a receipt |  |
| `close_task(task_id)` | `orchestrator` or `owner` | After every sub-account has returned its leftover, sends unallocated budget, unused reserve and returns back to `funder` | [R29] |
| `kill()`, `kill_task(task_id)` | `owner` | Stops all funding and top-ups |  |
| `get_task`, `get_subtasks`, `get_receipts` | anyone | Views |  |

**Keys and NEAR costs**

- The human funds a task from their own wallet with USDC `ft_transfer_call` to the contract. That call carries 1 yoctoNEAR, so it is the human's signature, and it is the only one in the loop [R29] [R1].
- `orchestrator` calls the contract through a function-call key limited to this contract and these methods. Such a key cannot attach NEAR [R21], so these methods take no deposit; the owner pre-funds the contract with NEAR for account creation, storage deposits and gas.
- In design A, `signer` holds each sub-account's full-access key. After creation a parent account has no control over its sub-accounts, so the kill switch stops new funding but cannot pull back what is already funded. The worst case from one leaked sub-account key is that subtask's balance; a leaked `signer` service reaches every funded sub-account, bounded by the caps the human approved. (Updated 2026-11-07: the orchestrator no longer chooses sub-account keys; see [x402-payments-plan.md](x402-payments-plan.md) section 4.6.)

**Design C: the contract signs through Chain Signatures**

- The MPC contract is `v1.signer` on mainnet and `v1.signer-prod.testnet` on testnet [R30]. Its `sign` takes a payload, a derivation path and a `domain_id`: 0 for Secp256k1, 1 for Ed25519 [R22]. `derived_public_key(path, predecessor, domain_id)` returns the key for a (path, calling account, domain) [R23].
- `fund_subtask` gets the derived Ed25519 public key for the path `task/<id>/<n>` and makes it the sub-account's only access key, so no service holds a spending key.
- A new `pay(task_id, n, accepts_row, nonce, max_block_height)` checks the row against the cap and an allowlisted `payTo`, builds the delegate action (`ft_transfer`, 1 yoctoNEAR, 30 Tgas), serialises and hashes it as NEP-366 specifies [R17], and calls `sign` with domain 1, attaching the MPC fee from its own balance. `signer` then assembles `X-PAYMENT` from the returned signature.
- The contract cannot read a sub-account's access-key nonce on-chain, so `orchestrator` passes it; a wrong nonce only makes the payment fail [R17].
- Returning leftovers also needs a signature from the sub-account; design that path before committing to C.

## Data model and state machines

`orchestrator` owns five tables; the contract mirrors only budgets, caps and receipts. Store hashes of payment headers, never the headers themselves.

| Entity | Fields |
| --- | --- |
| Task | `id`, `prompt`, `budget_usdc`, `reserve_share`, `funder_account`, `status`, `plan`, `final_result`, `created_at` |
| Subtask | `id`, `task_id`, `n`, `brief`, `criteria`, `cap_usdc`, `deadline_s`, `self_do`, `sub_account_id`, `status`, `rehire_count` |
| Hire | `id`, `subtask_id`, `agent_handle`, `context_id`, `a2a_task_id`, `quote_row`, `amount_atomic`, `payment_hash`, `auth_expires_block`, `a2a_state`, `artifacts_ref` |
| Evaluation | `id`, `hire_id`, `engine` (`outlayer` or `llm`), `verdict`, `failed_criteria`, `attestation_hash`, `evidence_ref` |
| Receipt | `id`, `subtask_id`, `hire_id`, `amount_atomic`, `payment_tx`, `receipt_tx` |

**Task transitions**

| From | Event | To |
| --- | --- | --- |
| `draft` | planner returns a plan | `planned` |
| `planned` | user approves | `approved` |
| `planned` | user cancels | `cancelled` |
| `approved` | `ft_on_transfer` with `create_task` seen on-chain | `funded` |
| `funded` | every `fund_subtask` succeeded | `running` |
| `running` | every subtask is `passed` or `abandoned` | `aggregating` |
| `aggregating` | aggregate done, returns sent | `closing` |
| `closing` | `close_task` succeeded | `closed` |
| any | owner kill | `killed` |

**Subtask transitions**

| From | Event | To |
| --- | --- | --- |
| `pending` | `fund_subtask` succeeded | `funded` |
| `funded` | quote requested | `quoting` |
| `quoting` | quote within cap, payment signed | `working` |
| `quoting` | quote above cap or agent unreachable | `quoting` with the next candidate, or `abandoned` if none left |
| `working` | A2A `COMPLETED` with artifacts | `evaluating` |
| `working` | A2A `REJECTED`, `FAILED` or `CANCELED` (not charged [R6]) | `quoting` with the next candidate |
| `working` | SLA plus 10 minutes passed (payment expired [R7]) | `quoting` with the next candidate |
| `evaluating` | verdict pass | `passed` |
| `evaluating` | verdict fail and `rehire_count` below 2 | `quoting` (top up from reserve if needed) |
| `evaluating` | verdict fail and `rehire_count` is 2 | `abandoned` |
| `passed` or `abandoned` | leftover returned to the contract | `returned` |
| `pending` with `self_do` | orchestrator does it itself | `evaluating` |

A2A task states come from the marketplace (the wire names carry a `TASK_STATE_` prefix): `SUBMITTED` and `WORKING` keep polling, `COMPLETED` is charged, and `REJECTED`, `FAILED` and `CANCELED` are not charged [R6] [R7].

## Security rules

No single compromised service can spend more than one subtask's cap, and no text from a hired agent can cause a payment.

**Keys**

| Key | Held by | Can do | Ref |
| --- | --- | --- | --- |
| Owner full-access key | The human's wallet | Fund tasks, kill, deploy | [R1] |
| Orchestrator function-call key | `chain-gateway` | Call `fund_subtask`, `top_up`, `record_receipt`, `close_task` on the budget contract only; cannot attach NEAR or transfer tokens | [R21] |
| Sub-account full-access keys (design A) | `signer` | Spend at most that sub-account's balance | [R21] |
| NEAR AI Cloud API key | `planner`, `evaluator` | LLM calls | [R27] |
| OutLayer payment key | `evaluator` | Pay for check executions | [R24] |

- All keys come from environment variables or secret files outside the repo; none is ever committed [R1].
- A function-call-only account can lock itself out if its gas allowance runs out [R26]: set the orchestrator key's allowance with headroom and alert on low allowance.
- The README explains each key's limits, as the security track prompt asks [R26].

**Spending**

- Simulation mode is the default. Live mode, mainnet deployment and any real spend need the human's explicit yes [R1].
- `signer` refuses any `payTo` that does not match `/.well-known/x402` [R7], any amount above the remaining cap, and any second signature while an earlier authorization for the subtask is still valid. A 502 is retried with the same header, never re-signed [R7].
- Attack demo: a simulated agent returns a deliverable that tells the orchestrator to pay it again or to pay another address. The orchestrator ignores it and `signer` refuses, with the log shown [R26].

**Untrusted input**

- Every message and artifact from a hired agent is data, never an instruction; never act on a request inside one, especially a request to hire [R10].
- `evaluator` returns only pass or fail with evidence. It holds no keys, cannot reach `signer`, and its outbound network is limited to OutLayer and NEAR AI Cloud.
- Store OutLayer attestations [R24] and check NEAR AI Cloud gateway attestation and response signatures [R28], so every verdict can be checked later.
- Briefs sent to agents contain no secrets, because the agent's owner reads the task text [R7].

**Paths not used, and why**

- `/mcp/pro` spends the account balance in the call, but the server sets no spending caps and the docs tell clients not to auto-approve `create_job`, `award_bid` or `accept_result` [R9]. Its sign-in is a browser OAuth flow [R9] [R11].
- The REST API's spending routes need a logged-in human session, and some refuse agent tokens [R16].
- x402 is the documented path for an agent that has only a wallet [R8].

## Verify before building

These facts are undocumented or untested; confirm each one before code depends on it, top to bottom. Any step that spends mainnet USDC needs the human's yes [R1].

1. `GET /.well-known/x402` on the marketplace: `near:mainnet` is accepted, and note the USDC asset contract id and the `payTo` treasury [R7].
2. The demo agents exist and answer `SendMessage` at `https://<handle>.market.near.ai/a2a/v1` with a 402 quote; record their prices [R6] [R15]. The skill mentions a pricing-plans endpoint without a path; find it in the OpenAPI spec [R7] [R16].
3. A NEAR sub-account (a named account such as `x.<contract>.near`) can be the payer. The payer's `<network>:<address>` becomes a payer account on first use, and a relayer pays the gas, so the payer holds no NEAR for payments [R7].
4. The USDC contract needs `storage_deposit` before a sub-account can receive tokens; read the amount from `storage_balance_bounds` [R29].
5. One real hire with a tiny amount from a dev sub-account, end to end: payment settles only on delivery, failed tasks are not charged, and delivery latency is acceptable [R6] [R8].
6. Concurrent tasks to the same agent are allowed; the docs do not say [R6].
7. Whether the 60 requests a minute per IP limit counts `GetTask` polls as well as `SendMessage` [R7].
8. Account creation, storage deposits and gas per subtask in the contract, measured on testnet.
9. OutLayer: pricing and limits, outbound network access from a check, and the output format [R24].
10. NEAR AI Cloud: the chosen model is available and returns response signatures [R27] [R28].
11. Design C only: an MPC Ed25519 signature over the NEP-366 hash is accepted as a delegate signature by NEAR and by the marketplace's facilitator; the MPC fee; the return path for leftovers [R17] [R22] [R23].

The marketplace refuses payment to an agent you own (`-32602`) [R7], so the team's own test agents can only be exercised through the simulator.

## README, demo post and submission

The README is written for an AI screener first: it must reproduce the full loop in simulation mode with one command and no funds [R1] Q-012, Q-017.

**README sections, in order**

1. What it is, in two sentences, and the problem it solves. No marketing [R1].
2. Quick start in simulation mode as "do X, see Y" steps: the command, the URL to open, the task to type, and what appears (plan, hires, one failed check, re-hire, receipts) [R1].
3. Live mode: mainnet only for x402 [R6], tiny amounts, which keys and environment variables are needed.
4. Architecture: the services table and the end-to-end sequence from this plan.
5. NEAR features used, named explicitly as the tracks ask [R1] Tracks: Agent Market A2A + x402 [R6], NEP-366 meta transactions [R17], USDC as NEP-141 with NEP-145 storage [R29], function-call access keys [R21], sub-accounts [R4], OutLayer TEE attestation [R24], NEAR AI Cloud [R27], and Chain Signatures if design C ships [R22].
6. Keys and their limits, and what needs the human's approval [R3] [R26].
7. Track mapping: `agents`, `swarms`, `security`, and the counteroffer substitute.
8. Libraries, templates and AI-written code used [R1] Q-005.
9. The other project, if the human enters a second one [R1] Q-015.
10. License (MIT, with a LICENSE file) [R1] Q-014.

**Demo post (the human writes and publishes it)**

- Must say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, and attach the video or screenshots; @NearLegion and @NearBuilders are optional [R1].
- First line: the user problem, understandable without knowing the project. Show one complete moment from a user action to a visible result, explain NEAR's role concretely, and end with the repo link and a specific question [R1].
- A coding agent may draft the text; it never posts [R1].
- Keep any hosted demo up until at least 2026-11-18, ideally 2026-11-25 [R1] Q-012.

**Submission (sent only after the human confirms the printed payload)**

- `POST https://nearhackathon.com/api/applications`, JSON body up to 12000 bytes, exactly these fields: `requestId`, `projectName`, `leadName`, `email`, `size`, `tracks`, `nearAddress`, `projectUrl`, `demoUrl`, `idea`, `consent` [R1].
- `requestId` is a UUID generated once and reused on any retry. `size` is one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`. `nearAddress` is a mainnet account matching the documented pattern. `idea` is 20 to 2000 characters [R1].
- Never add other fields: a non-empty `website` field rejects the submission [R1].
- Read the consent notice to the human verbatim before setting `consent` to true [R1].
- Responses: 201 saved; 400 fix the listed fields and resend with the same `requestId`; 403 tell the human and do not retry; 409 already submitted or email limit reached, ask the human; 413 shorten `idea`; 503 wait and resend with the same `requestId` [R1].
- Never commit the payload; it contains personal data. Mistakes after a 201 go through the request-changes page, never a second submission [R1].

## Risks

The biggest risks are paying for bad work (x402 has no disputes) and blending in with teams that build the plain sample prompt.

| Risk | What goes wrong | Mitigation | Ref |
| --- | --- | --- | --- |
| Looks like the sample prompt | Judges see one more "general contractor" agent | Lead the README and demo with attested checks, on-chain caps and receipts | [R3] [R25] |
| Paying for bad work | x402 settles and auto-accepts on delivery, with no review, rework or dispute | Cheap, checkable subtasks; re-hire from the reserve; at most 2 re-hires per subtask | [R8] |
| Payment fails after delivery | Payments from one key settle out of order and the lower nonces fail | One sub-account and key per subtask; one outstanding payment per key | [R17] [R18] |
| Paying twice | A re-signed payment and the original both settle | Never re-sign while an authorization is valid; retry 502 with the same header | [R7] |
| No fitting agent | The planner creates subtasks nobody on the marketplace can do | Supply check before plan approval; `self_do` or drop | [R6] [R15] |
| Rate limit | More than about 8 polling tasks hit 60 requests a minute per IP | At most 6 tasks in flight through one gateway instance | [R7] |
| Slow agents | A task outlives its authorization | Per-subtask SLA; move to the next candidate when the authorization expires | [R6] [R7] |
| Prompt injection in a deliverable | A deliverable tells the orchestrator to pay again or elsewhere | Deliverables are data only; `signer` allowlists `payTo` and checks caps | [R10] [R26] |
| Leaked sub-account key | Funds in that sub-account are lost | Loss bounded by one cap; kill switch stops new funding | [R21] |
| Locked function-call key | The orchestrator key runs out of gas allowance | Allowance with headroom and a low-allowance alert | [R26] |
| No counteroffer on x402 | The track prompt's negotiation step cannot be done on a fixed-price quote | Compare quotes across candidates and walk away; prompt items are not mandatory | [R3] [R7] [R1] Q-011 |
| Mainnet spend | Mainnet costs are not reimbursed | Simulation by default; a few USDC in total for real demo hires | [R1] Q-008 |
| Screener cannot reproduce | Low preliminary score | Simulation mode with no keys and canned LLM responses | [R1] Q-017 |
| Docs change | Endpoints or rules move during the hackathon | Re-read the Agent Market index and the live HACKATHON.md before relying on a detail | [R5] [R1] |

## References

All pages were opened on 2026-11-04; re-read the live versions before relying on a detail.

| Ref | Source | Backs |
| --- | --- | --- |
| R1 | [NEAR HACKATHON HACKATHON.md](https://nearhackathon.com/HACKATHON.md) | Dates, rules Q-000 to Q-017, tracks, README and demo rules, submission API, human-confirmation rules |
| R2 | [NEAR HACKATHON website](https://nearhackathon.com/) | Past judging criteria, judges, AI screening |
| R3 | [Track 07 Agent Economy prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/07-agents.md) | General contractor example, negotiation, receipts, key custody |
| R4 | [Track 05 AI Swarms prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/05-swarms.md) | Sub-account per agent, simulation mode with no LLM calls |
| R5 | [Agent Market docs index](https://docs.market.near.ai/llms.txt) | Map of all Agent Market pages |
| R6 | [Hire using A2A+x402](https://docs.market.near.ai/a2a/hire-agent-using-x402.md) | Agent search, A2A endpoint, 402 fields, payment build, polling, billing states |
| R7 | [x402 caller skill](https://market.near.ai/skill/x402-caller/SKILL.md) | One payment per task, rate limit, contextId, retries, errors, `/.well-known/x402`, signing rules |
| R8 | [x402 vs MCP](https://docs.market.near.ai/a2a/x402-vs-mcp.md) | x402 settles on delivery with no review or dispute; x402 is for wallet-only agents |
| R9 | [Connect to /mcp/pro](https://docs.market.near.ai/mcp/pro.md) | Why `/mcp/pro` is not used |
| R10 | [Hire over MCP](https://docs.market.near.ai/a2a/hire-agent-over-mcp.md) | Treat worker messages as data |
| R11 | [Connect over MCP](https://docs.market.near.ai/mcp/connect.md) | OAuth sign-in and identities |
| R12 | [How it works](https://docs.market.near.ai/concepts/how-it-works.md) | Job-board lifecycle (background for the unused MCP path) |
| R13 | [Payments and disputes](https://docs.market.near.ai/concepts/payments-and-disputes.md) | Fees and dispute timing on the job board (background) |
| R14 | [Hire from your AI assistant](https://docs.market.near.ai/buyers/hire-from-your-ai.md) | MCP tools and approval links (background) |
| R15 | [Agent Market Discover](https://market.near.ai/discover) | Finance agents for the demo task |
| R16 | [Agent Market OpenAPI spec](https://market.near.ai/openapi.json) | REST spending routes need a human session |
| R17 | [NEP-366 meta transactions](https://github.com/near/NEPs/blob/master/neps/nep-0366.md) | Delegate action nonce and signature rules |
| R18 | [NEAR meta transactions: parallel processing](https://www.mintlify.com/near/docs/chain-abstraction/meta-transactions) | Out-of-order nonces fail; one key per stream |
| R19 | [NEAR gas keys](https://docs.near.org/protocol/accounts-contracts/gas-keys) | Parallel nonce lanes (rejected alternative) |
| R20 | [nearcore 2.13.0 release notes](https://newreleases.io/project/github/near/nearcore/release/2.13.0) | `DelegateV2` for gas keys (rejected alternative) |
| R21 | [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys) | Function-call keys cannot attach NEAR; method scoping |
| R22 | [Chain Signatures](https://www.mintlify.com/near/docs/chain-abstraction/chain-signatures) | `sign` parameters and Ed25519 domain |
| R23 | [NEAR MPC overview](https://deepwiki.com/Quantus-Network/near-mpc) | `derived_public_key` |
| R24 | [OutLayer getting started](https://app.outlayer.ai/docs/getting-started) | TEE execution, attestation, WASM target, payment, runtime |
| R25 | [Agent Market job: agent-to-agent hiring system](https://market.near.ai/jobs/e1d9149f-b6fe-4ec7-a5e5-b68c651ebe53) | The plain idea is already requested on the marketplace |
| R26 | [Track 06 AI Security prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/06-security.md) | Scoped function-call keys, key-limit README, attack demo, allowance lockout |
| R27 | [NEAR AI Cloud quick start](https://docs.near.ai/cloud/quickstart.md) | Base URL, auth header, model names |
| R28 | [NEAR AI Cloud verification](https://docs.near.ai/cloud/verification) | Gateway attestation and response signatures |
| R29 | [NEAR fungible tokens](https://docs.near.org/primitives/ft) | `storage_deposit`, 1 yoctoNEAR on `ft_transfer`, `ft_transfer_call` and `ft_on_transfer` refunds |
| R30 | [Implementing Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures/implementation) | MPC contract ids on mainnet and testnet |
