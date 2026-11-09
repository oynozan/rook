# Rook payments plan: x402 hiring, signer, chain gateway, budget contract

Status: plan for phase 2, written 2026-11-07. Phase 1 ([agentic-system.md](agentic-system.md)) runs the full loop against a simulated market with an in-memory ledger. This phase replaces that ledger with real money: a NEAR budget contract, per-subtask sub-accounts, a `signer` that builds x402 payments, and a `chain-gateway` that sends contract calls and records receipts. The build plan's rules apply throughout ([build-plan.md](build-plan.md)): nothing is signed, deployed to mainnet or spent without the human's explicit yes.

## 1. What phase 1 already gives us

The state machines call a ledger whose methods are named after the contract and the signer (agentic-system.md section 8.5). Phase 2 keeps the state machines and swaps each ledger method for a service call:

| Ledger method (phase 1) | Phase 2 call | Where |
| --- | --- | --- |
| `createTask` | Human's USDC `ft_transfer_call` to the contract, `msg` = `{"create_task": {"reserve_bps": 2000, "caps": [...]}}` carrying the caps the human approved; `chain-gateway` waits for `ft_on_transfer` and reads `get_task` | Human wallet, contract |
| `fundSubtask` | `signer` generates the key pair and calls `register_subtask_key(task_id, n, public_key)` from its own account; then `chain-gateway` → `fund_subtask(task_id, n)`, which funds exactly the approved cap into an account with that key | Signer, contract |
| `topUp` | `chain-gateway` → `top_up(task_id, n, amount)` | Contract |
| `authorize` | `signer` `POST /sign {task_id, n, accepts_row}` returns the `X-PAYMENT` header | Signer |
| `settle` | `chain-gateway` sees the sub-account's `ft_transfer` to `payTo` on-chain after the A2A task is `COMPLETED` and fills `payment_tx` | Chain reads |
| `release` | Nothing to send: an unsettled authorization expires after `maxTimeoutSeconds` blocks. `signer` marks it expired so the next one can be signed | Signer |
| `returnLeftover` | `signer` `POST /return` signs `ft_transfer_call` of the sub-account's balance back to the contract with `msg` = `return` | Signer, contract |
| `closeTask` | `chain-gateway` → `close_task(task_id)` | Contract |
| `kill` | Owner calls `kill_task` from the human wallet; `orchestrator` tells `signer` to refuse | Human wallet, signer |
| receipt write | `chain-gateway` → `record_receipt(task_id, n, receipt)`, fills `receipt_tx` | Contract |

The orchestrator talks to one interface. A `ROOK_LEDGER=sim|chain` switch picks the in-memory ledger or the HTTP clients for `signer` and `chain-gateway`, so simulation mode keeps working with no keys.

## 2. Facts checked on 2026-11-07

| Fact | Value | Source |
| --- | --- | --- |
| Marketplace payment config | `GET https://market.near.ai/.well-known/x402` → `near:mainnet`, asset `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (native USDC, `ft-1.0.0`, symbol USDC), `payTo` `ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc` | Live call |
| Quotes are free | `SendMessage` with no payment returns HTTP 402 with the row; no task is created | Live call to `luigi-check` |
| Example price | `luigi-check`: `amount` `100000` (0.10 USDC), `maxTimeoutSeconds` 1200 = its `sla_seconds` 600 + 600 | Live call |
| Price lookup without a quote | `GET https://market.near.ai/v1/agents/{agent_id}/pricing-plans`, row with `is_default: true`, `price_amount` in USD | Live call |
| USDC storage | `storage_balance_bounds` min = max = `1250000000000000000000` yoctoNEAR (0.00125 NEAR) per account | Mainnet RPC view |
| Payment build | NEP-366 `signedDelegate`, `receiverId` = asset, one `ft_transfer` `{receiver_id: payTo, amount}`, 30 Tgas, 1 yoctoNEAR, `blockHeightTtl` = `maxTimeoutSeconds`; header = base64 of `{x402Version: 2, accepted: row, payload: {signedDelegateAction}}` | x402 caller skill |
| Errors | 402 bad payment; 502 facilitator down (retry the same header, never re-sign); 429 rate; JSON-RPC -32602 (paying your own agent, bad params), -32603 (no backend), -32004 (not taking calls), -32001 (task not found), -32002 (not cancelable) | x402 caller skill |

Still open (from the build plan's "Verify before building"): whether a named sub-account works as the payer (item 3), whether concurrent tasks to one agent are allowed (6), whether `GetTask` counts toward the 60 per minute limit (7), and the real per-subtask NEAR cost (8). Each is answered by a step below.

## 3. Where the contract lives

x402 settles on NEAR mainnet only, and the payer is the sub-account. A sub-account of a testnet contract cannot pay a mainnet agent. So:

- **Testnet**: the contract and a mock NEP-141 token (the simulator's `usdc.sim` on chain) for contract tests and the simulated loop with real transactions.
- **Mainnet, for live hires**: the same contract deployed to a mainnet account the human owns, used with tiny budgets (a few USDC in total, build plan constraint). Deploying it needs the human's yes and costs NEAR for storage.

Decision needed from the human before step 6: the mainnet contract account name, and how much NEAR to pre-fund it with (estimate in section 6).

## 4. Components

### 4.1 Budget contract (`contract/`, Rust, `near-sdk`)

As specified in the build plan, design A. Additions found while planning:

- `fund_subtask` gives each sub-account enough NEAR for the USDC `storage_deposit` (0.00125 NEAR, paid by the contract to the USDC contract on the sub-account's behalf), its own account storage, and one `ft_transfer_call` back to the contract (leftover return). Measure the total on testnet (step 2); start from 0.01 NEAR.
- Sub-account ids: `t<task>-<n>.<contract>`, with `<task>` a short base-36 counter the contract assigns in `ft_on_transfer`. NEAR account ids are at most 64 characters, so keep the contract name short.
- `ft_on_transfer` `msg` is JSON: `{"create_task": {"reserve_bps": 2000, "caps": ["300000", ...]}}` (the plan's caps as approved by the human; the sum must fit within budget minus reserve, else the transfer is refunded) or `{"return": {"task_id": "...", "n": 1}}`. The `return` branch accepts tokens only from the matching sub-account (`sender_id`).
- Every state change happens in callbacks that check promise results and roll back on failure (`fund_subtask` creates the account, then deposits storage, then transfers the cap).
- Views: `get_task`, `get_subtasks`, `get_receipts`. Events (NEP-297 logs) for `task_created`, `subtask_funded`, `top_up`, `receipt`, `task_closed`, `killed`, so `chain-gateway` can index without polling every view.
- Tests: `near-workspaces` sandbox with a mock FT: create task, fund, top up over reserve (refused), fund after kill (refused), return from an unknown account (refunded), close before all returns (refused), close refunds the right amount.

### 4.2 `signer` service

- Has its own NEAR account (the contract's `signer` role) with a function-call key limited to `register_subtask_key`. Generates one ed25519 key pair per subtask, registers the public key on the contract before funding, and keeps the private key in a key file outside the repo (`ROOK_SIGNER_KEY_DIR`, default `~/.rook/keys`), never in env dumps, logs or events.
- `POST /sign {task_id, n, accepts_row}`: refuses unless `network` = `near:mainnet` (or `near:testnet` in testnet mode), `asset` and `payTo` match `/.well-known/x402`, `amount` ≤ the sub-account's `ft_balance_of` and ≤ the contract's remaining cap for the subtask, no unexpired authorization for this subtask, and the contract and the task are not killed. Builds the delegate exactly as the skill shows, with `blockHeightTtl` = `maxTimeoutSeconds`. Stores `{payment_hash, expires_at_block}`; returns the header once.
- One authorization per sub-account at a time, so nonces never race (build plan, signer).
- `POST /expire {task_id, n}`: called by the orchestrator when the A2A task ended unpaid (`REJECTED`, `FAILED`, `CANCELED`, timeout); the signer still refuses a new signature until the chain's block height passes `expires_at_block`, unless the marketplace has reported a terminal unpaid state for that task id. This is the one place a double payment could happen, so it errs on waiting.
- `POST /return {task_id, n}`: `ft_transfer_call` of the full balance to the contract, `msg` return.
- `POST /reclaim {task_id, n, account_id}`: deletes a sub-account with the contract as beneficiary, so its NEAR comes back: one whose subtask is Returned, or a funding attempt that failed after `create_account` (Failed with `account_exists`; its key is the attempt's, from the account id). Refused while the account holds USDC or has an outstanding authorization. The orchestrator calls it after each return, when `fund_subtask` ends Failed with the account created, and on restart for such attempts.
- Library: `near-api-js` (the marketplace example uses it). New dependency, listed in the README.

### 4.3 `chain-gateway` service

- Holds the orchestrator account's function-call key, limited to the budget contract and `fund_subtask`, `top_up`, `record_receipt`, `close_task`, `mark_empty`, with a gas allowance and a low-allowance alert (build plan, security).
- Sends those calls, reads views and `ft_balance_of`. `POST /mark-empty {task_id, n}` calls `mark_empty` (50 Tgas) for a sub-account spent to exactly 0, which can never send a 0-amount `return` (NEP-141); the answer says whether the contract marked it (its callback returns `false`, with no change, when the balance it read was not 0).
- Builds explorer links (`nearblocks.io`, or `testnet.nearblocks.io` by `NEAR_NETWORK`) for funding, payment and receipt transactions.

**Payment detection (built, offline-tested 2026-11-09).** Booking a payment needs no indexer: after the signer reports the delegate ran or expired (`/expire`), the orchestrator books the hire as spent only if the sub-account's `ft_balance_of` is lower by the quoted amount. A `COMPLETED` hire whose payment never shows by then is booked unpaid, with an `error` event and a receipt of amount 0. The delegate's nonce alone is not enough: it is used even when the `ft_transfer` inside fails.

The transaction hash for the receipt comes from an indexer, in the background (it lags): chain-gateway `GET /payment?account=&to=&amount=&index=` finds the sub-account's `index`-th USDC transfer to `payTo` (oldest first; the orchestrator passes how many of the subtask's earlier hires were paid), which must be of exactly `amount`, so a re-hire at the same price never gets another hire's transaction (without `index`: the newest such transfer at or after `after`, minus 2 minutes of clock skew), trying `ROOK_PAYMENT_LOOKUP_TRIES` (6) times `ROOK_PAYMENT_LOOKUP_MS` (10 s) apart. A hit fills the receipt's `payment_tx` and `payment_explorer_url` and emits `ledger` `payment_found`; a miss leaves `payment_tx` null with an `error` event (the balance already showed the payment).

| Option, checked with free GETs on 2026-11-09 | Result |
| --- | --- |
| **NearBlocks API v3, `GET /v3/accounts/{account}/ft-txns?limit=25` (chosen)** | Works without a key on mainnet (`api.nearblocks.io`) and testnet (`api-testnet.nearblocks.io`). One call gives each FT event with `affected_account_id`, `involved_account_id`, signed `delta_amount`, `contract_account_id`, `transaction_hash`, `receipt_id`, `block_timestamp` (ns): exactly what matching a payment needs |
| NearBlocks API v1/v2 (`/v1/account/{account}/ft-txns`) | Works, but answers with `Sunset: 22 Nov 2026`; the migration page says v1 and v2 are switched off that day and testnet already runs v3 only |
| FastNEAR transactions API (`POST https://tx.main.fastnear.com/v0/account`) | Works without a key, but returns only transaction hashes per account; each would need a second call to learn amount and payee |
| NEAR RPC `EXPERIMENTAL_changes` or a block scan | Fallback if both indexers go away; not built |

Rate limits: NearBlocks' responses carry no rate-limit headers and its pricing page sits behind a Cloudflare challenge, so the keyless limit could not be read offline. Rook stays far below any plausible one: one indexer request at a time, at least `ROOK_INDEXER_GAP_MS` (1 s) apart, at most 6 per paid hire, a 429 waits for `Retry-After` (10 s when absent), and `NEARBLOCKS_API_KEY`, when set, is sent as a Bearer token. `NEARBLOCKS_API_URL` overrides the base (tests point it at a mock). The marketplace's own limit (60 requests per minute per IP) is separate.

### 4.4 `market-gateway` (already built)

Live `/send` with a real header forwards to `https://<handle>.market.near.ai/a2a/v1` and retries 502 with the same header. Built: paid calls send `configuration: {historyLength: 0}`, plus `returnImmediately: true` when the window (the payment's `maxTimeoutSeconds` minus 600) is over 60 seconds, so the orchestrator polls from the start instead of holding a connection. A `SendMessage` result that is a Message rather than a Task (A2A allows a direct answer) counts as `COMPLETED` with the message's parts.

### 4.5 `orchestrator` changes

- `ROOK_LEDGER=chain`: `approve` returns the funding instructions (contract id, amount, `msg`) and waits for `chain-gateway` to report the task created, instead of creating it in memory.
- Live mode confirmation: `approve` in live mode requires `{confirm_mainnet_spend_usdc: "<total>"}` equal to the plan's maximum spend (caps plus reserve), so a client cannot approve real spending by accident. The CLI prints the total and asks twice.
- Lift the phase 1 refusal of `approve` in `live` mode only when `ROOK_LEDGER=chain`.
- Restart (built, offline-tested): the task document stores the chain binding (contract task id with its contract and network, Rook n to contract n, sub-accounts, and each outstanding authorization's `payment_hash`, amount, `expires_at_block` and delegate nonce; never the header). On start, before the API listens, each bound task's books are rebuilt from `get_task`, `get_subtasks` and the sub-accounts' `ft_balance_of`, waiting out a funding or top-up still in flight; an authorization that already paid shows as a balance below the one stored before the restart. The run then resumes: done subtasks are skipped, a hire whose header was out is polled again by its stored A2A task id until it ends or its authorization expires, then settled or released. A killed or failed task with money still on chain is unwound instead. A shutdown leaves a chain-mode run as it is for this; a sim-ledger run that was mid-way is marked failed (its balances lived in memory). Contract task ids restart at 0 on every contract, so a binding made on another contract or network (for an older binding: by its stored ledger view, its sub-account ids, or the contract task's funder and budget) is left as it is with an error event and never bound, so it cannot block `/funded` for a task here. A contract task the contract deleted (refunded before any subtask was funded) ends the Rook task `cancelled` instead of running it. A failed funding attempt whose account was created is reclaimed. A Closed contract task still holding a return that arrived after the close keeps Rook's books open, so Rook's `close_task` refunds it.
- Kill (built, offline-tested): the signer refuses at once; then Rook waits until each outstanding authorization can no longer settle (the agent ended unpaid or accepted CancelTask, else until the payment landed or expired; a landed one is booked with a receipt), returns every funded sub-account (`/return`, or `mark_empty` at 0) and calls `close_task`, which the orchestrator may do once every subtask is Returned or Failed. Each sub-account clears and returns on its own, so one long authorization holds back only its own money (a hire the run was still settling or waiting out stops waiting at the kill, and the unwind takes over its authorization); `close_task` waits for all. When the funder closed the task first, `close_task` refunds the returns that arrived since, and the contract's "task is already closed" (nothing left to refund) closes Rook's books too. Each step is an event after the `killed` status. The contract's `kill_task` stays the owner's call; the kill event and the `/kill` answer give the command.

## 4.6 Trust model

Keys are split so that no single leaked key can send USDC anywhere except approved caps into Rook's own sub-accounts and refunds to the funder:

| Leaked key | What it can do | Bound |
| --- | --- | --- |
| Orchestrator (function-call key on `fund_subtask`, `top_up`, `record_receipt`, `close_task`) | Fund approved caps into signer-keyed sub-accounts, top up from the reserve into them, write receipts, close (refunds go to the funder) | Cannot direct USDC to any account it controls |
| Signer (function-call key on `register_subtask_key`, plus the sub-account keys it holds in design A) | Spend what is already in funded sub-accounts | Approved caps plus top-ups of funded subtasks |
| Both | Fund every approved cap and the reserve into sub-accounts it can spend from | Approved caps plus reserves of open tasks |
| Owner wallet sign-in key (no deposit) | `kill`, `kill_task`, owner `close_task` (refund to the funder) | `set_orchestrator`, `set_signer` and `resolve_stuck` need 1 yoctoNEAR, so a sign-in key cannot rotate roles |

The caps are fixed by the human's own funding transfer, so the on-chain contract, not a service, enforces what the human approved. Design C (Chain Signatures) later removes the signer's custody of sub-account keys. This corrects the build plan's "worst case is one subtask's balance" for design A: a leaked signer key reaches every funded sub-account, bounded by the approved caps.

## 5. Order of work

Each step ends with something that runs. Steps marked **human yes** spend real money or deploy, and stop until the human agrees.

1. **Contract and sandbox tests.** Write the contract and its `near-workspaces` tests with a mock FT. No keys, no network. **Built, offline-tested:** `contract/` (budget contract and mock FT) with `cargo test -p rook-budget` on near-sdk's mocked VM; see [contract/README.md](../contract/README.md).
2. **Testnet deploy and cost measurement.** Deploy to a testnet account, a mock FT as `usdc`, run one task through `fund_subtask`, `top_up`, return and `close_task` by hand. Record the NEAR cost per subtask (build plan verify item 8) and set the pre-funding numbers.
3. **`signer` and `chain-gateway` on testnet.** Implement both, add `ROOK_LEDGER=chain`, and run the simulated market loop with real testnet transactions (the simulator accepts `near:testnet` rows and checks the delegate's signature and amount, but does not submit it). **Built, offline-tested:** `services/src/signer`, `services/src/chain-gateway`, `services/src/shared/near.ts` (near-api-js 7.4.0), `services/src/orchestrator/chain-ledger.ts`, and the simulator's NEP-366 check (`SIM_PAYMENT_NETWORK`). `services/test/chain.test.ts` runs them against a mock NEAR RPC that verifies every transaction signature. The run with real testnet transactions is still to do (it needs step 2's deployment). Found while building: NEP-141 refuses a 0-amount transfer, so a sub-account spent to exactly 0 can never send a `return` and stays Funded, and the orchestrator's `close_task` then fails. Resolved: the contract's `mark_empty(task_id, n)` and chain-gateway `/mark-empty`; the signer now signs a payment of the whole balance, and nothing keeps 1 atomic unit back.
4. **Indexer choice.** Done: NearBlocks API v3, recorded in section 4.3.
5. **Attack demo.** `rook attack <task_id>`: replays the demands of the injection deliverable against the real refusal paths: a second `/sign` while one is outstanding, a `payTo` of `evil-collector.near`, an amount above the cap, a `fund_subtask` after `kill_task`. Each is refused and the log is printed (security track, build plan). The orchestrator path is already covered: the injection deliverable fails evaluation and never reaches a payment decision.
6. **Mainnet contract deploy. Human yes.** Deploy the contract to the human's chosen mainnet account and pre-fund it with NEAR (about 0.05 NEAR per planned subtask plus contract storage, refined by step 2).
7. **One real hire. Human yes.** One task with one subtask, budget 0.20 USDC, hiring the cheapest live agent found in the plan (for example `luigi-check` at 0.10 USDC). Check: the payment settles only on delivery, the receipt matches the on-chain transfer, the leftover returns, `close_task` refunds. Answers verify items 3 and 5.
8. **Unpaid paths. Human yes.** If any agent can be made to reject or fail cheaply (an empty or malformed brief), confirm no charge and that the signer releases correctly after expiry.
9. **Concurrency check. Human yes.** Two subtasks hiring the same agent at once (verify item 6) and polling under the rate limit (verify item 7). Keep the total under 1 USDC.
10. **Demo run. Human yes.** The full due-diligence demo on mainnet with a budget of 2 to 3 USDC, recorded for the demo post.

## 6. Costs

- USDC: only real hires, a few USDC in total (steps 7 to 10).
- NEAR per subtask, measured on mainnet (section 8): the contract advances 0.06 NEAR to the sub-account plus the 0.00125 NEAR USDC storage deposit. A return `ft_transfer_call` at 50 Tgas needs 0.0509 NEAR up front (the runtime prices prepaid gas pessimistically and refunds the unused part), so the first value, 0.01, failed with `NotEnoughBalance`. Once a subtask is Returned the signer sends `storage_unregister` and `DeleteAccount` with the contract as beneficiary, so almost all of it comes back (task 0's second sub-account returned 0.06 of 0.06125).
- NEAR AI: unchanged from phase 1.

## 7. Risks specific to this phase

| Risk | Mitigation |
| --- | --- |
| A named sub-account is refused as an x402 payer | Settled on mainnet 2026-11-09: `t0-1.rook.oynozan.near` paid `web-research` 0.50 USDC through the marketplace facilitator (section 8) |
| Unpaid authorization still settles later | The signer never signs a second payment for a subtask until the first one's `blockHeightTtl` has passed or the marketplace reports an unpaid terminal state |
| Indexer lag hides the payment transaction | Receipts are written with `payment_tx: null` first and filled when found; the balance drop (`ft_balance_of`) is the immediate signal |
| Orchestrator function-call key runs out of allowance | Allowance with headroom; `chain-gateway` exposes the remaining allowance and the CLI warns under 20% |
| Leaked sub-account key | Loss bounded by one cap; keys deleted after the leftover returns |

## 8. Mainnet record (2026-11-09)

Rook runs on NEAR mainnet. Everything below can be checked on nearblocks.io.

**Accounts.** All are sub-accounts of `oynozan.near`, created by `services/scripts/deploy.ts`. Their keys are in `~/.rook/accounts/mainnet/` and `~/.rook/mainnet.env`, outside the repo.

| Account | Role | Created with |
| --- | --- | --- |
| `rook.oynozan.near` | budget contract (owner `oynozan.near`) | 3.04 NEAR, of which about 2.72 is the code stake |
| `orch.oynozan.near` | orchestrator: function-call key for `fund_subtask, top_up, record_receipt, close_task, mark_empty`, 0.25 NEAR allowance | 0.3 NEAR |
| `signer.oynozan.near` | signer: function-call key for `register_subtask_key`, 0.1 NEAR allowance | 0.15 NEAR |

**Transactions.**

| What | Transaction |
| --- | --- |
| Create the contract account | `DJhUs7nbRMQ7ufR8F84wbkM4hT9ChqUJgjEtYLqCkRw4` |
| Deploy and init | `3bLBu5oXJzVvmEmBrDjTKF6PPHs8JgerrUPhKDPFFaZf` |
| Redeploy built with `--cfg near` (errors had no message, see below) | `CzMKik7VkVRe1a3N23ppnguhcR99KwMSYBxgAXvds3tv` |
| Redeploy with 0.06 NEAR per sub-account | `G8xEA46mTBmyF1oBPSJZckNpetcF4RSzDeDXgu3wG1HY` |
| Swap 1.3 NEAR to 4.53 USDC on Ref Finance (pool 4512), for the test funder | `GhfaGbKvao7SHxjSoFaCSJdix9QpVNrDjsZ9KQUJ1mJy` |
| Task 0 funded by `oynozan.near`: 1.50 USDC, caps 0.30 and 0.50, reserve 0.30 | `DFkg59zhnitZR2jxfyzKyWfe1MMNJr1x5VZbsrXmPYEf` |
| **First x402 payment**: `t0-1.rook.oynozan.near` paid `web-research` 0.50 USDC (cap 0.30 plus a 0.20 top-up from the reserve) | `GTw5hCY4U43TExFNgr4NBkUG6s8NtFUmmcoS6sXzoZAP` |
| Its receipt on the contract (verdict pass, evaluation hash `f0ac5fc4…`) | `CFmXWsYdspCTdP7k8L2PEtoPQnu6qHuG2pcMDEurDVWA` |
| Delete the emptied `t0-1` sub-account, NEAR back to the contract | `BbA95XKB1Eb2mwABLy3nxroadt1rLhEMjDvTbfLsJ6wq` |
| Task 1 funded by `oynozan.near`: 1.50 USDC, one cap of 0.30 | `AhL3eih7BRF7PMRss4a8B7CqFvdZy1onj4YwwMus2aZL` |
| Task 1: `cited-web-research-brief` paid 0.15 USDC | `FkEyVeHwEn7bpPUNWNzsFCJ6yjw6ybMApTXrhJuSAUes` |
| Its receipt (verdict fail) | `89w7V5c9bdbHgvCvKzr2HFfimv9vMgDEGpe9rUybEkWS` |
| Task 2 funded by `oynozan.near`: 1.50 USDC, one cap of 0.25, reserve 83.33% (the budget the cap left) | `Dhy5v2jS2XDuBgQRwQUSdeAFwqc1FHG115AoxXvra4n8` |
| Task 2: `cited-web-research-brief` paid 0.15 USDC | `2uM24irmYEHMJuvzwwkDBGGr3A2pygLRX96Go4jxELP7` |
| Its receipt (verdict pass) | `F4CyorVtrVzXv2Da95JJKd4pVBJnLTVWn94UXcMvVpBw` |
| Upgrade with the review fixes (`mark_empty` on a Closed task, at most 8 caps, `NEW_TASK_FLOOR`) | `2qBhsyuPL91DLy1DPVCmzqNPS3LMrJwtNEd92dxsRyM2` |
| Task 3 funded **from the web app** by `oynozan.near`: 1.50 USDC, caps 0.30 and 0.15, reserve 70% | `EWYsGeFZL9U1yCL7PD1U8XnqfNBoFWXzSRNCWNqC7Mr7` |
| Task 3 subtask 1: `cited-web-research-brief` paid 0.15 USDC | `26jHoNtsFiktDMwMgC9nakcFndbd7YwLwSN8PMQ9PeYn` |
| Its receipt (verdict pass) | `8q1YYLAb63o6SdPDVBGh26dbNGdwwxGVgj2mYLomaZp5` |
| Task 3 subtask 2: `cited-web-research-brief` paid 0.15 USDC | `D1aBPxFVV1hwFRrHf6TeRPBzaMGi7rvccYffpuCdmjP7` |
| Its receipt (verdict pass) | `jKQ7myQWAdG6FpoXucS4i4Yp858JaaGv4skrs7hs5Wv` |
| Task 4: a wallet sends other terms than the plan's (first cap 0.29, not 0.30), 1.00 USDC | `EMfEjaG46FZxw8kd5noDt37HAWHWyCAS81rGifJ38H7p` |
| Task 4 refunded by its funder's `close_task` from the web app's "Refund to my wallet" | `yDrSXegFuvLfxNWotwxjc62vvfARq9NvsY8L2869ogA` |
| Task 5: the same Rook task funded again, on the plan's terms, 1.00 USDC | `HkGE6xjXr9tzABCikpVNjXxLh2RjCDRBraRActtqqU3U` |
| Task 5: `cited-web-research-brief` paid 0.15 USDC | `DLZPhPaPMYpJx92qwrUM9DWVMmdHhygDc1yPVYc6gG9t` |
| Its receipt (verdict pass) | `2BQcWcm5n2kVgXprTNCNg96XoEyHVdDEnhhDsMDUUhDm` |
| Task 6 funded from the web app: 1.50 USDC, caps 0.30, 0.30 and 0.04, reserve 57% | `BH7p9idbF3uCddrTajWeWwJUV62u4jkWBXNT5NjL3u2X` |
| Task 6, after Stop: subtask 1's agent delivered and its payment landed, 0.15 USDC | `4n6o1G2T68vmMEyrMei1daCPNoXgCyLwxgYgSaYX8qjU` |
| Its receipt (no verdict: stopped before evaluation) | `FvyDgYUgGfHanoTYjy3HZihaQhK8cQuehsABa5M9WzSs` |
| Task 6, after Stop: subtask 2's payment, 0.15 USDC | `FWrrH6yWXFq2Cc3UjrNGYdVWwmfoy83kY4SX9TUog3bV` |
| Its receipt | `FFTV46KLegfr1kLN5J9tjHUw21fErA7JoXcnb5jLt9uc` |
| Task 7 funded from the web app: 1.00 USDC, one cap of 0.15 (plus a self-done summary) | `ACQNrDJhSf4AoRXuQmbVnA7EEmXPKj1xjQDvqGABBBwu` |
| Task 7, after the services were killed and restarted mid-hire: the payment, 0.15 USDC | `6a2oC6Sihz4vhvmgK2WTj8wQJNuFJpag1PBxy5nBXuxh` |
| Its receipt (verdict pass) | `BoFFhA6nbt9jeoKzVXXiRB47axXW3zTjS4K6UkkPzudt` |
| Task 8 funded from the web app: 1.00 USDC, caps 0.25 and 0.25 | `9MqTLEoEtGv9m3ZJotQTAFr4L3pFRvnhLuob5b8x9aFf` |
| Task 8, after a second restart mid-hire: subtask 1 paid 0.15 USDC | `J5XmUKDvDrY8XvqauitvWaU6eZXvz3AoGzPHr9arr9J9` |
| Its receipt (verdict pass) | `Fo9zWrdfTyeTtdam16CL7J3wnap8HnwUkg6dXYYnEPXp` |
| Task 8: subtask 2 paid 0.15 USDC | `Fw6J9Ns4v3P8yQvNzYtHJ81ZWhyynmP52jdiUEAijAiZ` |
| Its receipt (verdict pass) | `iUDogHawiipKBi7GgxNNXF63w4hoB7X7mq3HvmKNW23` |

| Contract task | Rook task | Hires | Paid | Refunded | Outcome |
| --- | --- | --- | --- | --- | --- |
| 0 | `t_891b1147`, NEAR wallets | `web-research` (pass); subtask 2 had no payable agent | 0.50 | 1.00 | report from the passing subtask; exposed the sub-account NEAR and payment-window bugs |
| 1 | `t_d8d77b31`, NEAR releases in October 2026 | `cited-web-research-brief` (fail) | 0.15 | 1.35 | good work failed a `numeric_match` on "Date" (2026-10-26 is not one number); the 0.50 re-hire did not fit the 0.30 reserve while 0.90 sat unallocated |
| 2 | `t_6b7dbc9e`, top 3 NEAR DeFi apps by TVL | `cited-web-research-brief` (pass) | 0.15 | 1.35 | clean run: paid, passed, 0.10 leftover returned, sub-account deleted, report with DefiLlama sources |
| 3 | `t_9fffa66f`, the three latest nearcore releases | `cited-web-research-brief` twice (pass, pass) | 0.30 | 1.20 | the first run from the browser: NEP-413 sign-in, plan, funding transfer from the wallet, report about 4 minutes after funding, both sub-accounts deleted |
| 4 | `t_17e54e06` (wrong transfer) | none | 0 | 1.00 | the page read the transfer, saw caps 0.29 against the plan's 0.30, refused to run it and offered the refund; the funder's `close_task` returned all of it and the contract deleted the task |
| 5 | `t_17e54e06`, NEAR circulating supply with a source | `cited-web-research-brief` (pass) | 0.15 | 0.85 | the same Rook task, funded again from the page after the refund; report with the CoinGecko figure |
| 6 | `t_924d21c2`, latest nearcore release and NEAR staking APR, **stopped** 11 s after the hires went out | `cited-web-research-brief` twice (paid on delivery), `taifoon-research` (ended unpaid) | 0.30 | 1.20 | the kill path: no new hires; the unpaid hire released at once and its sub-account returned 0.04 within 13 s; each sub-account waited out its own authorization (the two agents delivered, 40 s and 2 min after Stop), then returned; the close refunded 1.20 2.5 minutes after Stop |
| 7 | `t_4ad5ea62`, NEAR TVL last week from DefiLlama; **all services killed and restarted** while the hire was out | `cited-web-research-brief` (pass); the self-done summary abandoned | 0.15 | 0.85 | Rook rebuilt the task from contract task 7, followed the hire it had sent, booked the payment and closed. The planned "summarise the finding" subtask ran before the finding existed and failed its checks; the open page stayed on "Running" after the restart |
| 8 | `t_ac564006`, NEAR staking APR and total staked; services restarted mid-hire again | `cited-web-research-brief` twice (pass, pass) | 0.30 | 0.70 | after both fixes below: the page reconnected by itself and showed the report |

Task 3 ran in the web app (`web/`, branch `feat/web-real-path`) in a headless Chromium. The wallet was an injected near-connect wallet, the way extension wallets plug in, holding `oynozan.near`'s key: it signed the sign-in message and the funding transfer, and nothing else was stubbed.

`ledger_check` held for every task, and every sub-account was deleted after its return.

**What broke, and the fixes.**

1. Every refusal read "WebAssembly trap: An `unreachable` opcode was executed". near-sdk 5.30 sends `env::panic_str` to the host only when the crate is built with `--cfg near` (cargo-near sets it); without it, a panic is a bare `unreachable`. The build now passes `--cfg near`, and the wasm imports `panic_utf8`.
2. The return from a sub-account failed with `NotEnoughBalance`: 0.01 NEAR could not cover the 0.0509 NEAR up-front cost of a 50 Tgas `ft_transfer_call`. `SUBACCOUNT_NEAR` is now 0.06 NEAR, and the signer's `/reclaim` deletes each finished sub-account with the contract as beneficiary, so the NEAR comes back. The stuck sub-account `t0-2` was rescued with 0.05 NEAR from `oynozan.near`, then returned 0.50 USDC and was deleted.
3. Agents ask for payment windows longer than one hour (`maxTimeoutSeconds` is the agent's SLA plus 600 s, up to 87,000 s), and Rook refused anything over 3,600 s. The limit was raised to 90,000 s. A long window does not block a subtask: a terminal unpaid hire clears at once, and the return uses a newer nonce of the sub-account's key, which voids any unused delegate. A review then found that an agent which hangs, or a payment that never settles, holds the sub-account's money, a hiring slot and a killed task's unwind for the whole window, so `ROOK_MAX_PAYMENT_TIMEOUT_S` now defaults to 15,000 s (about 4 h: agents whose SLA is up to about 4 h). The planner drops a quote over it with a note, and the unwind after a kill returns each sub-account on its own.
4. The planner searched the market only with topic words, which matched few agents. Its first search term is now the general skill agents advertise (for example "web research").
5. Task 1's agent did good work but failed a `numeric_match` on its "Date" line. The planner no longer writes `numeric_match` for dates, years, versions or ids: the prompt says so, and a guard removes any that slip through.
6. Task 1's re-hire was refused for want of reserve while 0.90 USDC of the budget sat unallocated. The budget the caps leave now becomes the reserve, up to the contract's 90% (task 2's reserve was 1.25 of 1.50).
7. Task 3's page first said "no task at this link" once the plan was approved. The web server's dev reload had kept a store connection opened before the `funding` table existed, and the task route turned that error into a 404. The connection is now keyed by schema version, and the route reports its own errors as errors. The page reopened, funded and ran the same task.
8. Task 4's page said the transfer was not this plan's and offered only Stop: its 1.00 USDC had no way back from the page. A transfer from the signed-in account on other terms now gets "Refund to my wallet" (the funder's `close_task`), after which the plan can be funded again; a stopped task's held funding offers the same.
9. Task 6's page said "Stopped. Spent 0.30 of 1.50 USDC" and nothing more: not the 1.20 refund, not the two receipts. A stopped or failed run now shows the same money card as a finished one: spent, refunded (or that the refund is on its way while payments are in flight), and a receipt per paid hire.
10. Task 7's planner added a "summarise the finding" subtask. Subtasks run in parallel and never see each other's results, so it ran on nothing and failed; task 6 had hired an agent for 0.02 USDC to do the same. The planner prompt now says every subtask must be doable from its brief alone, and none may summarise or combine the others: the aggregator writes the report.
11. Task 7's open page never caught up after the restart: while the services were down, the event stream's reconnect got a 503, and any reply but 200 closes an EventSource for good. The page now opens a new stream with backoff and reloads the task; task 8 confirmed it.
