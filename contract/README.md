# Rook contracts

Cargo workspace with two NEAR contracts (near-sdk 5.30.1):

- `budget/` (`rook-budget`): the budget contract, design A from [docs/build-plan.md](../docs/build-plan.md) "Budget contract" and [docs/x402-payments-plan.md](../docs/x402-payments-plan.md) section 4.1. It holds each task's USDC, funds one sub-account per subtask with exactly the cap the owner approved, under a key the signer registered, takes leftovers back, records receipts and refunds the funder on close. The accounting rule is documented at the top of `budget/src/lib.rs`.
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

Without `cargo-near` the wasm is not run through `wasm-opt`; `rook_budget.wasm` is about 320 KB, which costs about 3.2 NEAR of storage on the contract account (1 NEAR per 100 KB). Running `wasm-opt -Oz` or building with `cargo near build` shrinks it.

## Methods (`rook-budget`)

Amounts are USDC atomic units as decimal strings. Task ids are short base-36 strings assigned by the contract.

| Method | Caller | Gas to attach | Does |
| --- | --- | --- | --- |
| `new(owner, orchestrator, signer, usdc)` | deployer (init) | | Sets the four accounts; orchestrator and signer must differ |
| `ft_on_transfer(sender_id, amount, msg)` | USDC contract only (panics otherwise) | | `{"create_task":{"reserve_bps":2000,"caps":["300000","200000"]}}` from the owner opens a task: reserve at most 9000 bps, 1 to 32 caps, each > 0, summing to at most budget - reserve. Cap n (1-based) is the only amount subtask n can ever be funded with. `{"return":{"task_id":"0","n":1}}` from that subtask's sub-account credits the task. Anything else, or `create_task` while killed: full refund |
| `register_subtask_key(task_id, n, public_key)` | signer | 30 Tgas | Sets the full-access key of sub-account n. Task open and not killed, `n` within the approved caps, the subtask new or Failed with attempts left; once per funding attempt (a key left by a previous signer is overwritten). Event `subtask_key_registered` |
| `fund_subtask(task_id, n)` | orchestrator | 100 Tgas | Panics unless the current signer registered a key for n (the key is used up). Takes the approved `caps[n-1]` from the unallocated budget, creates `t<task_id>-<n>.<contract>` with the registered key and 0.01 NEAR, then in one receipt on USDC: `storage_deposit` (0.00125 NEAR) and `ft_transfer` of the cap (1 yocto). Rolls back on any failure: the subtask becomes Failed and its cap goes back to the pool. A Failed n can be retried (3 attempts in all) after the signer registers a new key; retry k creates `t<task_id>-<n>-<k>.<contract>` and the subtask's `attempt` says which one is current. Refused unless the contract has 0.01625 NEAR free above its storage stake; if the storage deposit cannot be paid when the callback runs, the funding fails and rolls back |
| `top_up(task_id, n, amount)` | orchestrator | 50 Tgas | Sends `amount` from the task's reserve to a funded sub-account; restores the reserve if the transfer fails |
| `record_receipt(task_id, n, receipt)` | orchestrator | 30 Tgas | Appends `{a2a_task_id, agent_handle, amount, verdict: "pass"/"fail"/null, attestation_hash, payment_hash}`; strings at most 128 bytes, 64 receipts per task. On a closing or closed task, only for a subtask still Funded. Returns the seq |
| `close_task(task_id)` | orchestrator or owner | 50 Tgas | Needs every subtask Returned or Failed, then refunds what the contract holds for the task to the funder. The owner may close a killed task with unreturned subtasks; later returns can be refunded by closing again. If the refund fails, the task goes back to its status before that close (Open, or Closed for a re-close) |
| `kill()`, `kill_task(task_id)` | owner | | Blocks `register_subtask_key`, `fund_subtask`, `top_up` and new tasks. Returns and close still work. No deposit needed, so a wallet sign-in key can kill (it can only stop funding) |
| `set_orchestrator(account_id)`, `set_signer(account_id)` | owner, 1 yoctoNEAR | | Key rotation (the two must stay different accounts). `set_signer` also voids every key registered so far for subtasks not yet funded; the new signer registers its own. The deposit means only a full-access key can call it, not a wallet sign-in key |
| `resolve_stuck(task_id, n?, arrived)` | owner, 1 yoctoNEAR | | Repair for a callback that never completed, allowed 10,000 blocks after the transfer started. With `n`: a subtask stuck in Funding or ToppingUp becomes Funded (`arrived: true`) or rolls back. Without `n`: a task stuck in Closing becomes Closed or rolls back. Read the USDC receipt outcome on chain before choosing `arrived` |
| `get_config()`, `get_task(task_id)` (with `caps`), `get_subtasks(task_id)` (with each `public_key`), `get_receipts(task_id, from?, limit?)`, `ledger_check(task_id)` | anyone (views) | | `get_receipts` pages at most 50. `ledger_check` recomputes the accounting |

Orchestrator and signer methods take no attached deposit (a function-call key cannot attach NEAR). The contract pays sub-account NEAR and storage deposits from its own balance, so keep it funded: about 0.01125 NEAR per subtask plus its own state storage (about 0.006 NEAR per receipt at the string limits).

**Trust model.** The owner approves every subtask's cap when it funds the task; the orchestrator and the signer are separate accounts with separate keys (design A).

- Orchestrator key alone: can only fund approved caps into sub-accounts whose key the signer registered, top them up from the task's reserve, record receipts and close (the refund always goes to the funder). It cannot pick a sub-account key or send USDC anywhere else.
- Signer key alone: can only register keys for unfunded subtasks. It holds the sub-account keys, so it can spend what is already in funded sub-accounts: at most the approved caps plus top-ups. Rotating it with `set_signer` cuts it off from every subtask not yet funded.
- Both: bounded by the approved caps plus the reserve of open tasks. `kill()` / `kill_task` stop further funding and top-ups.

Design C (Chain Signatures) later removes the signer's key custody.

Events are NEP-297 logs, `EVENT_JSON:{"standard":"rook","version":"1.0.0","event":...,"data":[...]}`: `task_created` (with `caps`), `subtask_key_registered`, `subtask_funded`, `subtask_funding_failed`, `top_up` (with `ok`), `returned`, `receipt`, `task_closed` (with `ok`), `killed`.

## Deploy (later, with the human's yes)

Nothing here has been deployed. Commands use [near-cli-rs](https://github.com/near/near-cli-rs). Replace `you.testnet`. Keep the contract account name short: sub-account ids `t<task>-<n>-<retry>.<contract>` must fit in 64 characters.

```sh
W=target/wasm32-unknown-unknown/release
# Accounts: contract, mock token, orchestrator, signer
near account create-account fund-myself rook.you.testnet '5 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send
near account create-account fund-myself usdc.you.testnet '3 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send
near account create-account fund-myself orch.you.testnet '1 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send
near account create-account fund-myself signer.you.testnet '1 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send

# Mock token: 1,000,000 mUSDC to you.testnet
near contract deploy usdc.you.testnet use-file $W/rook_mock_ft.wasm with-init-call new json-args '{"owner_id":"you.testnet","total_supply":"1000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# Budget contract
near contract deploy rook.you.testnet use-file $W/rook_budget.wasm with-init-call new json-args '{"owner":"you.testnet","orchestrator":"orch.you.testnet","signer":"signer.you.testnet","usdc":"usdc.you.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# The contract must be registered on the token before it can receive USDC
near contract call-function as-transaction usdc.you.testnet storage_deposit json-args '{"account_id":"rook.you.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send

# Orchestrator function-call key, limited to this contract and these methods
near account add-key orch.you.testnet grant-function-call-access --allowance '1 NEAR' --contract-account-id rook.you.testnet --function-names 'fund_subtask, top_up, record_receipt, close_task' autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send
# Signer function-call key: only register_subtask_key (the sub-account keys themselves stay with the signer service)
near account add-key signer.you.testnet grant-function-call-access --allowance '0.25 NEAR' --contract-account-id rook.you.testnet --function-names 'register_subtask_key' autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send

# Fund a task with 5 mUSDC, 20% reserve, two subtasks capped at 2 and 1.5 mUSDC (the owner's one signature)
near contract call-function as-transaction usdc.you.testnet ft_transfer_call json-args '{"receiver_id":"rook.you.testnet","amount":"5000000","msg":"{\"create_task\":{\"reserve_bps\":2000,\"caps\":[\"2000000\",\"1500000\"]}}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as you.testnet network-config testnet sign-with-keychain send

near contract call-function as-read-only rook.you.testnet get_task json-args '{"task_id":"0"}' network-config testnet now
```

## Needs measuring on testnet (payments plan step 2)

- `SUBACCOUNT_NEAR` (0.01 NEAR): enough for the sub-account's storage and one return `ft_transfer_call`?
- Gas: `ft_transfer` / `storage_deposit` get 10 Tgas each, callbacks 10 Tgas, `on_account_created` 45 Tgas. Check the real burn of a full `fund_subtask`, `top_up` and `close_task`, and the gas a sub-account's return `ft_transfer_call` needs.
- `STORAGE_DEPOSIT` (0.00125 NEAR) is the mainnet USDC value read on 2026-11-07; the mock token's own bound may differ (the deposit uses `registration_only`, so any excess is refunded to the contract).
