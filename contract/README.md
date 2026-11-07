# Rook contracts

Cargo workspace with two NEAR contracts (near-sdk 5.30.1):

- `budget/` (`rook-budget`): the budget contract, design A from [docs/build-plan.md](../docs/build-plan.md) "Budget contract" and [docs/x402-payments-plan.md](../docs/x402-payments-plan.md) section 4.1. It holds each task's USDC, funds one sub-account per subtask with exactly its cap, takes leftovers back, records receipts and refunds the funder on close. The accounting rule is documented at the top of `budget/src/lib.rs`.
- `mock-ft/` (`rook-mock-ft`): a minimal NEP-141 + NEP-145 token (6 decimals, whole supply minted to `owner_id` at init) that stands in for USDC on testnet.

## Build and test

NEAR's VM only runs MVP WebAssembly, and recent rustc versions turn on newer wasm features by default, so build with `target-cpu=mvp`:

```sh
cd contract
RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s" cargo build -p rook-budget -p rook-mock-ft --target wasm32-unknown-unknown --release
# target/wasm32-unknown-unknown/release/rook_budget.wasm, rook_mock_ft.wasm
```

PowerShell: `$env:RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s"` before the same `cargo build`.

Unit tests (near-sdk `unit-testing`, mocked blockchain, callbacks simulated by setting promise results):

```sh
cargo test -p rook-budget
```

On Windows without NASM, the test build of `aws-lc-sys` (pulled in by near-sdk's mocked VM) fails; set `AWS_LC_SYS_PREBUILT_NASM=1` for that command. The wasm build does not need it.

Without `cargo-near` the wasm is not run through `wasm-opt`; `rook_budget.wasm` is about 290 KB, which costs about 2.9 NEAR of storage on the contract account (1 NEAR per 100 KB). Running `wasm-opt -Oz` or building with `cargo near build` shrinks it.

## Methods (`rook-budget`)

Amounts are USDC atomic units as decimal strings. Task ids are short base-36 strings assigned by the contract.

| Method | Caller | Gas to attach | Does |
| --- | --- | --- | --- |
| `new(owner, orchestrator, usdc)` | deployer (init) | | Sets the three accounts |
| `ft_on_transfer(sender_id, amount, msg)` | USDC contract only (panics otherwise) | | `{"create_task":{"reserve_bps":2000}}` from the owner opens a task (reserve at most 9000 bps). `{"return":{"task_id":"0","n":1}}` from that subtask's sub-account credits the task. Anything else, or `create_task` while killed: full refund |
| `fund_subtask(task_id, n, cap, public_key)` | orchestrator | 100 Tgas | Takes `cap` from the unallocated budget, creates `t<task_id>-<n>.<contract>` with `public_key` and 0.01 NEAR, then in one receipt on USDC: `storage_deposit` (0.00125 NEAR) and `ft_transfer` of `cap` (1 yocto). Rolls back on any failure. Refused unless the contract has 0.01625 NEAR free above its storage stake; if the storage deposit cannot be paid when the callback runs, the funding fails and rolls back |
| `top_up(task_id, n, amount)` | orchestrator | 50 Tgas | Sends `amount` from the task's reserve to a funded sub-account; restores the reserve if the transfer fails |
| `record_receipt(task_id, n, receipt)` | orchestrator | 30 Tgas | Appends `{a2a_task_id, agent_handle, amount, verdict: "pass"/"fail"/null, attestation_hash, payment_hash}`; strings at most 128 bytes, 64 receipts per task. On a closing or closed task, only for a subtask still Funded. Returns the seq |
| `close_task(task_id)` | orchestrator or owner | 50 Tgas | Needs every subtask Returned or Failed, then refunds what the contract holds for the task to the funder. The owner may close a killed task with unreturned subtasks; later returns can be refunded by closing again. If the refund fails, the task goes back to its status before that close (Open, or Closed for a re-close) |
| `kill()`, `kill_task(task_id)` | owner | | Blocks `fund_subtask`, `top_up` and new tasks. Returns and close still work. No deposit needed, so a wallet sign-in key can kill (it can only stop funding) |
| `set_orchestrator(account_id)` | owner, 1 yoctoNEAR | | Key rotation. The deposit means only a full-access key can call it, not a wallet sign-in key |
| `resolve_stuck(task_id, n?, arrived)` | owner, 1 yoctoNEAR | | Repair for a callback that never completed, allowed 10,000 blocks after the transfer started. With `n`: a subtask stuck in Funding or ToppingUp becomes Funded (`arrived: true`) or rolls back. Without `n`: a task stuck in Closing becomes Closed or rolls back. Read the USDC receipt outcome on chain before choosing `arrived` |
| `get_config()`, `get_task(task_id)`, `get_subtasks(task_id)`, `get_receipts(task_id, from?, limit?)`, `ledger_check(task_id)` | anyone (views) | | `get_receipts` pages at most 50. `ledger_check` recomputes the accounting |

Orchestrator methods take no attached deposit (a function-call key cannot attach NEAR). The contract pays sub-account NEAR and storage deposits from its own balance, so keep it funded: about 0.01125 NEAR per subtask plus its own state storage (about 0.006 NEAR per receipt at the string limits).

**Trust limit of the orchestrator key.** The orchestrator chooses each sub-account's public key and cap, so a leaked orchestrator key can fund sub-accounts it controls with every open task's unallocated budget and then top them up with the reserve. The contract only bounds this by what open tasks hold; `kill()` / `kill_task` stop it. This is wider than the build plan's "one subtask's cap" rule; closing the gap needs the sub-account keys to come from a source the orchestrator cannot choose (a separate signer account registering keys, or design C).

Events are NEP-297 logs, `EVENT_JSON:{"standard":"rook","version":"1.0.0","event":...,"data":[...]}`: `task_created`, `subtask_funded`, `subtask_funding_failed`, `top_up` (with `ok`), `returned`, `receipt`, `task_closed` (with `ok`), `killed`.

## Deploy (later, with the human's yes)

Nothing here has been deployed. Commands use [near-cli-rs](https://github.com/near/near-cli-rs). Replace `you.testnet`. Keep the contract account name short: sub-account ids `t<task>-<n>.<contract>` must fit in 64 characters.

```sh
W=target/wasm32-unknown-unknown/release
# Accounts: contract, mock token, orchestrator
near account create-account fund-myself rook.you.testnet '5 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send
near account create-account fund-myself usdc.you.testnet '3 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send
near account create-account fund-myself orch.you.testnet '1 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send

# Mock token: 1,000,000 mUSDC to you.testnet
near contract deploy usdc.you.testnet use-file $W/rook_mock_ft.wasm with-init-call new json-args '{"owner_id":"you.testnet","total_supply":"1000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# Budget contract
near contract deploy rook.you.testnet use-file $W/rook_budget.wasm with-init-call new json-args '{"owner":"you.testnet","orchestrator":"orch.you.testnet","usdc":"usdc.you.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# The contract must be registered on the token before it can receive USDC
near contract call-function as-transaction usdc.you.testnet storage_deposit json-args '{"account_id":"rook.you.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send

# Orchestrator function-call key, limited to this contract and these methods
near account add-key orch.you.testnet grant-function-call-access --allowance '1 NEAR' --contract-account-id rook.you.testnet --function-names 'fund_subtask, top_up, record_receipt, close_task' autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send

# Fund a task with 5 mUSDC, 20% reserve (the owner's one signature)
near contract call-function as-transaction usdc.you.testnet ft_transfer_call json-args '{"receiver_id":"rook.you.testnet","amount":"5000000","msg":"{\"create_task\":{\"reserve_bps\":2000}}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as you.testnet network-config testnet sign-with-keychain send

near contract call-function as-read-only rook.you.testnet get_task json-args '{"task_id":"0"}' network-config testnet now
```

## Needs measuring on testnet (payments plan step 2)

- `SUBACCOUNT_NEAR` (0.01 NEAR): enough for the sub-account's storage and one return `ft_transfer_call`?
- Gas: `ft_transfer` / `storage_deposit` get 10 Tgas each, callbacks 10 Tgas, `on_account_created` 45 Tgas. Check the real burn of a full `fund_subtask`, `top_up` and `close_task`, and the gas a sub-account's return `ft_transfer_call` needs.
- `STORAGE_DEPOSIT` (0.00125 NEAR) is the mainnet USDC value read on 2026-11-07; the mock token's own bound may differ (the deposit uses `registration_only`, so any excess is refunded to the contract).
