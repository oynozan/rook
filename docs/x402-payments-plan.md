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
- Library: `near-api-js` (the marketplace example uses it). New dependency, listed in the README.

### 4.3 `chain-gateway` service

- Holds the orchestrator account's function-call key, limited to the budget contract and `fund_subtask`, `top_up`, `record_receipt`, `close_task`, with a gas allowance and a low-allowance alert (build plan, security).
- Sends those calls, reads views and `ft_balance_of`, and finds the payment transaction for each `COMPLETED` hire: the sub-account's `ft_transfer` to `payTo` for the quoted amount, after the A2A completion time. Source: NEAR RPC `EXPERIMENTAL_tx_status` is per-transaction, so use an indexer API for "transactions of account X" (NearBlocks API or FastNEAR); pick one in step 4 and record it here.
- Builds explorer links for funding, payment and receipt transactions.

### 4.4 `market-gateway` (already built)

Live `/send` with a real header already forwards to `https://<handle>.market.near.ai/a2a/v1` and retries 502 with the same header. Add: `returnImmediately: true` on paid calls to agents with an SLA over 60 seconds, so the orchestrator polls from the start instead of holding a connection.

### 4.5 `orchestrator` changes

- `ROOK_LEDGER=chain`: `approve` returns the funding instructions (contract id, amount, `msg`) and waits for `chain-gateway` to report the task created, instead of creating it in memory.
- Live mode confirmation: `approve` in live mode requires `{confirm_mainnet_spend_usdc: "<total>"}` equal to the plan's maximum spend (caps plus reserve), so a client cannot approve real spending by accident. The CLI prints the total and asks twice.
- Lift the phase 1 refusal of `approve` in `live` mode only when `ROOK_LEDGER=chain`.

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
3. **`signer` and `chain-gateway` on testnet.** Implement both, add `ROOK_LEDGER=chain`, and run the simulated market loop with real testnet transactions (the simulator accepts `near:testnet` rows and checks the delegate's signature and amount, but does not submit it). **Built, offline-tested:** `services/src/signer`, `services/src/chain-gateway`, `services/src/shared/near.ts` (near-api-js 7.4.0), `services/src/orchestrator/chain-ledger.ts`, and the simulator's NEP-366 check (`SIM_PAYMENT_NETWORK`). `services/test/chain.test.ts` runs them against a mock NEAR RPC that verifies every transaction signature. The run with real testnet transactions is still to do (it needs step 2's deployment). Found while building: NEP-141 refuses a 0-amount transfer, so a sub-account spent to exactly 0 can never send a `return` and stays Funded, and the orchestrator's `close_task` then fails; the contract needs a way to mark an empty subtask returned (for example a signer- or orchestrator-callable `mark_empty(task_id, n)` that checks nothing is owed).
4. **Indexer choice.** Pick the account-history API for payment detection and record it in section 4.3.
5. **Attack demo.** `rook attack <task_id>`: replays the demands of the injection deliverable against the real refusal paths: a second `/sign` while one is outstanding, a `payTo` of `evil-collector.near`, an amount above the cap, a `fund_subtask` after `kill_task`. Each is refused and the log is printed (security track, build plan). The orchestrator path is already covered: the injection deliverable fails evaluation and never reaches a payment decision.
6. **Mainnet contract deploy. Human yes.** Deploy the contract to the human's chosen mainnet account and pre-fund it with NEAR (about 0.05 NEAR per planned subtask plus contract storage, refined by step 2).
7. **One real hire. Human yes.** One task with one subtask, budget 0.20 USDC, hiring the cheapest live agent found in the plan (for example `luigi-check` at 0.10 USDC). Check: the payment settles only on delivery, the receipt matches the on-chain transfer, the leftover returns, `close_task` refunds. Answers verify items 3 and 5.
8. **Unpaid paths. Human yes.** If any agent can be made to reject or fail cheaply (an empty or malformed brief), confirm no charge and that the signer releases correctly after expiry.
9. **Concurrency check. Human yes.** Two subtasks hiring the same agent at once (verify item 6) and polling under the rate limit (verify item 7). Keep the total under 1 USDC.
10. **Demo run. Human yes.** The full due-diligence demo on mainnet with a budget of 2 to 3 USDC, recorded for the demo post.

## 6. Costs

- USDC: only real hires, a few USDC in total (steps 7 to 10).
- NEAR per subtask: sub-account creation and storage (about 0.002 NEAR for a minimal account), USDC storage deposit (0.00125 NEAR), gas for the return transaction, and the contract's own calls. Estimate 0.01 NEAR per subtask until step 2 measures it; most is refunded only if the sub-accounts are deleted, which the contract does not do.
- NEAR AI: unchanged from phase 1.

## 7. Risks specific to this phase

| Risk | Mitigation |
| --- | --- |
| A named sub-account is refused as an x402 payer | Step 7 tests it with 0.10 USDC before anything else depends on it. Fallback: implicit (64-hex) accounts created by `fund_subtask` transferring NEAR to the implicit id, which keeps per-subtask isolation |
| Unpaid authorization still settles later | The signer never signs a second payment for a subtask until the first one's `blockHeightTtl` has passed or the marketplace reports an unpaid terminal state |
| Indexer lag hides the payment transaction | Receipts are written with `payment_tx: null` first and filled when found; the balance drop (`ft_balance_of`) is the immediate signal |
| Orchestrator function-call key runs out of allowance | Allowance with headroom; `chain-gateway` exposes the remaining allowance and the CLI warns under 20% |
| Leaked sub-account key | Loss bounded by one cap; keys deleted after the leftover returns |
