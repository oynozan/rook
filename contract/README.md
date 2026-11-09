# Rook contracts

Cargo workspace with two NEAR contracts (near-sdk 5.30.1):

- `budget/` (`rook-budget`): the budget contract, design A from [docs/build-plan.md](../docs/build-plan.md) "Budget contract" and [docs/x402-payments-plan.md](../docs/x402-payments-plan.md) section 4.1. It holds each task's USDC, funds one sub-account per subtask with exactly the cap the owner approved, under a key the signer registered, takes leftovers back, records receipts and refunds the funder on close. The accounting rule is documented at the top of `budget/src/lib.rs`.
- `mock-ft/` (`rook-mock-ft`): a minimal NEP-141 + NEP-145 token (6 decimals, whole supply minted to `owner_id` at init) that stands in for USDC on testnet.

## Build and test

```sh
cd contract
RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s" cargo build --workspace --target wasm32-unknown-unknown --release
# target/wasm32-unknown-unknown/release/rook_budget.wasm, rook_mock_ft.wasm
```

PowerShell: `$env:RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s"` before the same `cargo build`.

Unit tests (near-sdk `unit-testing`, mocked blockchain, callbacks simulated by setting promise results; 75 tests):

```sh
cargo test -p rook-budget
```

On Windows without NASM, the test build of `aws-lc-sys` (pulled in by near-sdk's mocked VM) fails; set `AWS_LC_SYS_PREBUILT_NASM=1` for that command. The wasm build does not need it.

**Wasm features.** `-C target-cpu=mvp` keeps our own code MVP, but the precompiled Rust std for `wasm32-unknown-unknown` (rustc 1.97) still brings `memory.copy` / `memory.fill` (bulk memory) and sign-extension opcodes. nearcore enables bulk memory, sign extension, reference types and saturating float-to-int, and disables multi-value (`runtime/near-vm-runner/src/features.rs` on master, read 2026-11-09). Both wasm files validate under exactly that set and have no multi-value function types. The first testnet call settles it: if a call fails with a `CompilationError` / `PrepareError`, rebuild std as MVP (nightly `-Zbuild-std` with `-C target-cpu=mvp`) or lower the opcodes with a binaryen newer than 116 (`--signext-lowering --llvm-memory-copy-fill-lowering`).

**Size.** The release profile is size-optimised (`opt-level = "z"`, which beat `"s"` at 364 KB and `"3"` at 380 KB, plus `lto`, `codegen-units = 1`, `panic = "abort"` and `strip`). Then run `wasm-opt` (the `wasm-opt` crate 0.116.1 builds in about 3.5 minutes with a C++ compiler; `cargo install wasm-opt --version 0.116.1 --locked`). Deploy the `.opt.wasm` files:

```sh
W=target/wasm32-unknown-unknown/release
F="--mvp-features --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --enable-reference-types --enable-mutable-globals"
for c in rook_budget rook_mock_ft; do wasm-opt $F -Oz --strip-debug --strip-producers $W/$c.wasm -o $W/$c.opt.wasm; done
```

| File | cargo | after `wasm-opt -Oz` | Storage stake (1 NEAR per 100 KB) |
| --- | --- | --- | --- |
| `rook_budget` | 340,310 bytes | 273,809 bytes | 2.74 NEAR |
| `rook_mock_ft` | 181,026 bytes | 150,457 bytes | 1.50 NEAR |

Measured 2026-11-09 (after open funding). `wasm-opt` kept all 25 exports. The optimised binary has not run on a NEAR node yet; the testnet run below is its first.

## Methods (`rook-budget`)

Amounts are USDC atomic units as decimal strings. Task ids are short base-36 strings assigned by the contract (`"0"`, `"1"`, ...).

| Method | Caller | Gas to attach | Does |
| --- | --- | --- | --- |
| `new(owner, orchestrator, signer, usdc)` | deployer (init) | | Sets the four accounts; orchestrator and signer must differ |
| `ft_on_transfer(sender_id, amount, msg)` | USDC contract only (panics otherwise) | | `{"create_task":{"reserve_bps":2000,"caps":["300000","200000"]}}` from any account opens a task with that account as its funder: budget at least `min_budget` (1 USDC until the owner changes it), at most `max_open_tasks` (5) of the funder's tasks open at once, reserve at most 9000 bps, 1 to 32 caps, each > 0, summing to at most budget - reserve. Cap n (1-based) is the only amount subtask n can ever be funded with. `{"return":{"task_id":"0","n":1}}` from that subtask's sub-account credits the task (also after the subtask was marked Returned). Anything else, a `create_task` that breaks a limit, from a subtask account, or while killed: full refund |
| `register_subtask_key(task_id, n, public_key)` | signer | 30 Tgas | Sets the full-access key of sub-account n. Task open and not killed, `n` within the approved caps, the subtask new or Failed with attempts left; once per funding attempt (a key left by a previous signer is overwritten). Event `subtask_key_registered` |
| `fund_subtask(task_id, n)` | orchestrator | 100 Tgas | Panics unless the current signer registered a key for n (the key is used up). Takes the approved `caps[n-1]` from the unallocated budget, creates `t<task_id>-<n>.<contract>` with the registered key and 0.01 NEAR, then in one receipt on USDC: `storage_deposit` (0.00125 NEAR) and `ft_transfer` of the cap (1 yocto). Rolls back on any failure: the subtask becomes Failed and its cap goes back to the pool. A Failed n can be retried (3 attempts in all) after the signer registers a new key; retry k creates `t<task_id>-<n>-<k>.<contract>` and the subtask's `attempt` says which one is current. Refused unless the contract has 0.01625 NEAR free above its storage stake; if the storage deposit cannot be paid when the callback runs, the funding fails and rolls back |
| `top_up(task_id, n, amount)` | orchestrator | 50 Tgas | Sends `amount` from the task's reserve to a funded sub-account; restores the reserve if the transfer fails |
| `mark_empty(task_id, n)` | orchestrator, owner or the task's funder | 50 Tgas | For a subtask that is Funded (not Funding or ToppingUp) on a task that is not Closing or Closed (killed is fine): reads USDC `ft_balance_of` of the current attempt's sub-account. The callback `on_mark_empty` marks the subtask Returned with 0 credited and emits `returned` with `"amount":"0","empty":true` only when the balance is exactly `"0"` and the subtask is unchanged (still Funded, same attempt, no top-up started since). Otherwise, including a failed balance read, nothing changes and the call returns `false`; it returns `true` when marked |
| `record_receipt(task_id, n, receipt)` | orchestrator | 30 Tgas | Appends `{a2a_task_id, agent_handle, amount, verdict: "pass"/"fail"/null, attestation_hash, payment_hash}`; strings at most 128 bytes, 64 receipts per task. On a closing or closed task, only for a subtask still Funded. Returns the seq |
| `close_task(task_id)` | orchestrator, owner or the task's funder | 50 Tgas | Needs every subtask Returned or Failed (an emptied sub-account becomes Returned through `mark_empty`), then refunds what the contract holds for the task to the funder. The funder or the owner may close a killed task with unreturned subtasks; later returns can be refunded by closing again. A task closed with no subtask ever funded is deleted once its refund lands (`task_closed` carries `"deleted":true`), and a first close frees one of the funder's open-task slots. If the refund fails, the task goes back to its status before that close (Open, or Closed for a re-close) |
| `kill()` (owner), `kill_task(task_id)` (owner or the task's funder) | | | Blocks `register_subtask_key`, `fund_subtask`, `top_up` and new tasks. Returns, `mark_empty` and close still work. No deposit needed, so a wallet sign-in key can kill (it can only stop funding) |
| `set_orchestrator(account_id)`, `set_signer(account_id)` | owner, 1 yoctoNEAR | | Key rotation (the two must stay different accounts). `set_signer` also voids every key registered so far for subtasks not yet funded; the new signer registers its own. The deposit means only a full-access key can call it, not a wallet sign-in key |
| `resolve_stuck(task_id, n?, arrived)` | owner, 1 yoctoNEAR | | Repair for a callback that never completed, allowed 10,000 blocks after the transfer started. With `n`: a subtask stuck in Funding or ToppingUp becomes Funded (`arrived: true`) or rolls back. Without `n`: a task stuck in Closing becomes Closed or rolls back. Read the USDC receipt outcome on chain before choosing `arrived` |
| `set_limits(min_budget, max_open_tasks)` | owner, 1 yoctoNEAR | | Both positive. Defaults 1 USDC (`"1000000"`) and 5 |
| `get_config()` (with `min_budget`, `max_open_tasks`), `get_open_tasks(account_id)`, `get_task(task_id)` (with `caps`), `get_subtasks(task_id)` (with each `public_key`), `get_receipts(task_id, from?, limit?)`, `ledger_check(task_id)` | anyone (views) | | `get_receipts` pages at most 50. `ledger_check` recomputes the accounting |

Orchestrator and signer methods take no attached deposit (a function-call key cannot attach NEAR). The contract pays sub-account NEAR and storage deposits from its own balance, so keep it funded: about 0.01125 NEAR per subtask plus its own state storage (about 0.006 NEAR per receipt at the string limits).

**Empty sub-accounts (gap closed 2026-11-09).** NEP-141 refuses a 0-amount transfer, so a sub-account that paid out its whole balance can never send its `return`, and `close_task` used to stay blocked for that task. `mark_empty` closes the gap and replaces the services' workaround of leaving 1 atomic unit in every sub-account. A return that still arrives for a Returned subtask is credited as usual (a Closed task can then be closed again), so a mark that raced an incoming transfer loses nothing. ponytail: the balance is read in a separate receipt; the `since` and status checks catch a top-up or return that started after the read, and a late-arriving return is still credited. Unit tests cover: refused when not Funded, for a wrong caller and on a Closing or Closed task; balance 0 marks Returned, `ledger_check` holds and `close_task` succeeds; a balance above 0, a failed read or a malformed result change nothing; stale callbacks change nothing.

**Trust model.** Any account can fund a task; its funder approves every subtask's cap and the reserve in that one transfer, can stop it (`kill_task`) and close it, and is the only account a refund ever goes to. The orchestrator and the signer are separate accounts with separate keys (design A). The contract pays each funded subtask's NEAR (about 0.01625) from its own balance; `min_budget`, `max_open_tasks` and deleting never-funded tasks on close keep strangers from filling its storage.

- Orchestrator key alone: can only fund approved caps into sub-accounts whose key the signer registered, top them up from the task's reserve, record receipts, mark a sub-account that holds 0 USDC as returned, and close (the refund always goes to the funder). It cannot pick a sub-account key or send USDC anywhere else.
- Signer key alone: can only register keys for unfunded subtasks. It holds the sub-account keys, so it can spend what is already in funded sub-accounts: at most the approved caps plus top-ups. Rotating it with `set_signer` cuts it off from every subtask not yet funded.
- Both: bounded by the approved caps plus the reserve of open tasks. `kill()` / `kill_task` stop further funding and top-ups.
- A full-access key on the contract account itself can move every token the contract holds and replace its code. See the mainnet section.

Design C (Chain Signatures) later removes the signer's key custody.

Events are NEP-297 logs, `EVENT_JSON:{"standard":"rook","version":"1.0.0","event":...,"data":[...]}`: `task_created` (with `task_id`, `funder`, `budget`, `reserve`, `caps`; the web app reads the task id from it), `subtask_key_registered`, `subtask_funded`, `subtask_funding_failed`, `top_up` (with `ok`), `returned` (`"empty": true` when written by `mark_empty`), `receipt`, `task_closed` (with `ok`), `killed`.

## Testnet deploy runbook (needs the owner's go-ahead)

Nothing here has been deployed. Testnet NEAR is free, but every command below except views sends a real transaction, so it runs only after the owner says yes. Commands use [near-cli-rs](https://github.com/near/near-cli-rs) (syntax checked against its `docs/GUIDE.en.md` on 2026-11-09). Replace `you.testnet` everywhere. Keep the contract name short: sub-account ids `t<task>-<n>-<k>.<contract>` must fit in 64 characters.

Build first (section "Build and test", including `wasm-opt`), then from `contract/`:

```sh
W=target/wasm32-unknown-unknown/release

# 0. Your testnet account (owner and funder), if you have none: created and funded by the faucet
near account create-account sponsor-by-faucet-service you.testnet autogenerate-new-keypair save-to-keychain network-config testnet create

# 1. Accounts: budget contract, mock USDC, orchestrator role, signer role (about 7 NEAR in all)
#    rook: 2.74 NEAR code stake + ~80 subtasks at 0.01625; usdc: 1.5 NEAR code stake; roles: gas only
near account create-account fund-myself rook.you.testnet '4 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send
near account create-account fund-myself usdc.you.testnet '2 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send
near account create-account fund-myself orch.you.testnet '0.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send
near account create-account fund-myself signer.you.testnet '0.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as you.testnet network-config testnet sign-with-keychain send

# 2. Mock token: 1,000,000 mUSDC minted to you.testnet (which is registered on the token by init)
near contract deploy usdc.you.testnet use-file $W/rook_mock_ft.opt.wasm with-init-call new json-args '{"owner_id":"you.testnet","total_supply":"1000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# 3. Budget contract
near contract deploy rook.you.testnet use-file $W/rook_budget.opt.wasm with-init-call new json-args '{"owner":"you.testnet","orchestrator":"orch.you.testnet","signer":"signer.you.testnet","usdc":"usdc.you.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# 4. Token registration. Read the bound first; attach its "min" (0.00125 NEAR for mainnet USDC)
near contract call-function as-read-only usdc.you.testnet storage_balance_bounds json-args '{}' network-config testnet now
near contract call-function as-transaction usdc.you.testnet storage_deposit json-args '{"account_id":"rook.you.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send
#    Any other funder:
#    register it, then send it mUSDC (ft_transfer needs exactly 1 yoctoNEAR)
near contract call-function as-transaction usdc.you.testnet storage_deposit json-args '{"account_id":"alice.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction usdc.you.testnet ft_transfer json-args '{"receiver_id":"alice.testnet","amount":"20000000"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as you.testnet network-config testnet sign-with-keychain send

# 5. Role keys: function-call keys limited to this contract and exactly these methods.
#    save-to-legacy-keychain writes ~/.near-credentials/testnet/<account>/<public key>.json; its private_key is
#    ROOK_ORCHESTRATOR_KEY / ROOK_SIGNER_KEY. Keep it out of the repo. Each call reserves its prepaid gas
#    against the allowance (100 Tgas is about 0.01 NEAR at the minimum gas price).
near account add-key orch.you.testnet grant-function-call-access --allowance '0.5 NEAR' --contract-account-id rook.you.testnet --function-names 'fund_subtask, top_up, record_receipt, close_task, mark_empty' autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-keychain send
near account add-key signer.you.testnet grant-function-call-access --allowance '0.25 NEAR' --contract-account-id rook.you.testnet --function-names 'register_subtask_key' autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-keychain send
#    The full-access keys of orch/signer stay in your keychain and never go to the services.

# 6. Fund a task: 5 mUSDC, 20% reserve (1 mUSDC), two subtasks capped at 2 and 1.5 mUSDC (sum 3.5 <= 5 - 1).
#    This is the owner's one signature per task; the web app sends the same call from the wallet.
near contract call-function as-transaction usdc.you.testnet ft_transfer_call json-args '{"receiver_id":"rook.you.testnet","amount":"5000000","msg":"{\"create_task\":{\"reserve_bps\":2000,\"caps\":[\"2000000\",\"1500000\"]}}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as you.testnet network-config testnet sign-with-keychain send
#    The transaction logs carry EVENT_JSON {"standard":"rook","event":"task_created","data":[{"task_id":"0",...}]}
near contract call-function as-read-only rook.you.testnet get_task json-args '{"task_id":"0"}' network-config testnet now
```

### One task by hand (payments plan step 2, build plan verify item 8)

Every step's transaction hash goes into the measurement table below. Two sub-account key pairs, generated offline (testnet only: the private keys print to the terminal):

```sh
(cd ../services && npx tsx -e "import {KeyPair} from 'near-api-js'; for (const n of [1, 2]) { const k = KeyPair.fromRandom('ed25519'); console.log(n, k.getPublicKey().toString(), k.toString()) }")
# PK1/SK1, PK2/SK2 below

# Subtask 1: register, fund, top up, spend everything, mark empty
near contract call-function as-transaction rook.you.testnet register_subtask_key json-args '{"task_id":"0","n":1,"public_key":"PK1"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as signer.you.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction rook.you.testnet fund_subtask json-args '{"task_id":"0","n":1}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as orch.you.testnet network-config testnet sign-with-keychain send
near contract call-function as-read-only usdc.you.testnet ft_balance_of json-args '{"account_id":"t0-1.rook.you.testnet"}' network-config testnet now
near account view-account-summary t0-1.rook.you.testnet network-config testnet now
near contract call-function as-transaction rook.you.testnet top_up json-args '{"task_id":"0","n":1,"amount":"500000"}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as orch.you.testnet network-config testnet sign-with-keychain send
#   stands in for an x402 payment that uses the whole balance (2.5 mUSDC)
near contract call-function as-transaction usdc.you.testnet ft_transfer json-args '{"receiver_id":"you.testnet","amount":"2500000"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as t0-1.rook.you.testnet network-config testnet sign-with-plaintext-private-key --signer-public-key PK1 --signer-private-key SK1 send
near contract call-function as-transaction rook.you.testnet mark_empty json-args '{"task_id":"0","n":1}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as orch.you.testnet network-config testnet sign-with-keychain send
#   expect the result true and a "returned" event with "empty":true

# Subtask 2: register, fund, receipt, return the leftover
near contract call-function as-transaction rook.you.testnet register_subtask_key json-args '{"task_id":"0","n":2,"public_key":"PK2"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as signer.you.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction rook.you.testnet fund_subtask json-args '{"task_id":"0","n":2}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as orch.you.testnet network-config testnet sign-with-keychain send
#   mark_empty on subtask 2 now returns false and changes nothing (it holds 1.5 mUSDC)
near contract call-function as-transaction rook.you.testnet mark_empty json-args '{"task_id":"0","n":2}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as orch.you.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction rook.you.testnet record_receipt json-args '{"task_id":"0","n":2,"receipt":{"a2a_task_id":"manual-1","agent_handle":"manual","amount":"0","verdict":null,"attestation_hash":null,"payment_hash":"none"}}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as orch.you.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction usdc.you.testnet ft_transfer_call json-args '{"receiver_id":"rook.you.testnet","amount":"1500000","msg":"{\"return\":{\"task_id\":\"0\",\"n\":2}}"}' prepaid-gas '50 Tgas' attached-deposit '1 yoctoNEAR' sign-as t0-2.rook.you.testnet network-config testnet sign-with-plaintext-private-key --signer-public-key PK2 --signer-private-key SK2 send

# Close: refund 5 - 2 - 1.5 - 0.5 + 1.5 = 2.5 mUSDC to you.testnet
near contract call-function as-transaction rook.you.testnet close_task json-args '{"task_id":"0"}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as orch.you.testnet network-config testnet sign-with-keychain send
near contract call-function as-read-only rook.you.testnet ledger_check json-args '{"task_id":"0"}' network-config testnet now
near contract call-function as-read-only rook.you.testnet get_subtasks json-args '{"task_id":"0"}' network-config testnet now

# Cheap refusals worth seeing once: fund after kill_task (refused), a return from you.testnet (refunded)
```

Then the services against testnet (payments plan step 3), with the simulated market and real testnet transactions: `ROOK_LEDGER=chain ROOK_MARKET=sim NEAR_NETWORK=testnet NEAR_RPC_URL=<testnet RPC> ROOK_CONTRACT_ID=rook.you.testnet ROOK_ORCHESTRATOR_ACCOUNT=orch.you.testnet ROOK_ORCHESTRATOR_KEY=ed25519:... ROOK_SIGNER_ACCOUNT=signer.you.testnet ROOK_SIGNER_KEY=ed25519:... SIM_PAYMENT_NETWORK=near:testnet SIM_USDC_ID=usdc.you.testnet SIM_PAY_TO=<any testnet account> pnpm dev` (with `ROOK_LLM=near` and `NEARAI_API_KEY`, since `canned` is refused unless the market and the ledger are both `sim`). Then `pnpm rook run "<task>" --budget 3`, send the printed `ft_transfer_call` from `you.testnet`, then `pnpm rook funded <task_id> <contract_task_id>`.

### What to measure (verify item 8)

Read each transaction with `near transaction view-status <hash> network-config testnet` (or testnet.nearblocks.io): sum `gas_burnt` and `tokens_burnt` over the transaction and all its receipt outcomes. Balances and storage bytes come from `near account view-account-summary <account> network-config testnet now`; the remaining key allowances from `near account list-keys <account> network-config testnet now`.

| Measure | Compare with | Update |
| --- | --- | --- |
| `rook` storage bytes after deploy, after `create_task`, per subtask, per receipt | 266 KB code; ~0.006 NEAR per receipt; `STATE_MARGIN` 0.005 NEAR | README numbers, `STATE_MARGIN` |
| `fund_subtask`: total gas burnt (attached 100 Tgas); `rook`'s NEAR balance change | `GAS_ON_ACCOUNT_CREATED` 45 Tgas; 0.01 + 0.00125 NEAR out | gas constants |
| `t0-1` after funding: NEAR balance and storage bytes; NEAR burnt by its return `ft_transfer_call` | `SUBACCOUNT_NEAR` 0.01 NEAR must cover its storage stake plus the return | `SUBACCOUNT_NEAR` |
| `register_subtask_key`, `top_up`, `mark_empty`, `record_receipt`, `close_task`: gas burnt | attached 30 / 50 / 50 / 30 / 50 Tgas | gas to attach in the table above |
| Mock token `storage_balance_bounds.min` | 0.00125 NEAR (mainnet USDC) | step 4 |
| Allowance used by the orch / signer keys over one task | 0.5 / 0.25 NEAR | step 5 |

Record the results in [docs/x402-payments-plan.md](../docs/x402-payments-plan.md) section 6.

## Mainnet variant (needs the owner's explicit yes)

Every command here spends real NEAR, and step M5 spends real USDC. Nothing runs without the owner's explicit yes. Same commands as testnet with `network-config mainnet`, accounts under the owner's `you.near`, and **no mock token**: the asset is native USDC, `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (the marketplace's x402 asset, read 2026-11-07).

- **M1. Accounts:** `rook.you.near` (short name, about 3 NEAR: 2.74 NEAR code stake for the optimised wasm, or 3.40 NEAR unoptimised, plus 0.01625 NEAR per subtask and receipts), plus `orch.you.near` and `signer.you.near` (0.5 NEAR each).
- **M2. Deploy and init:** `rook_budget.opt.wasm` with `new` and `{"owner":"you.near","orchestrator":"orch.you.near","signer":"signer.you.near","usdc":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}`.
- **M3. Register the contract on USDC:** read `storage_balance_bounds` on the USDC id (min = max = 0.00125 NEAR on 2026-11-07), then `storage_deposit` `{"account_id":"rook.you.near","registration_only":true}` with that deposit. The funder already holds USDC, so it is registered.
- **M4. Role keys:** step 5 with the mainnet names; orchestrator methods `fund_subtask, top_up, record_receipt, close_task, mark_empty`, signer `register_subtask_key`.
- **M5. First task, one real hire** (payments plan step 7): budget 0.20 USDC, reserve 20%, one subtask capped at 0.10 USDC. That is `ft_transfer_call` on the USDC id with `{"receiver_id":"rook.you.near","amount":"200000","msg":"{\"create_task\":{\"reserve_bps\":2000,\"caps\":[\"100000\"]}}"}`, 100 Tgas, 1 yoctoNEAR, `sign-as you.near`.
- **M6. Services:** `pnpm live` with `ROOK_MARKET=live ROOK_LEDGER=chain ROOK_LLM=near NEAR_NETWORK=mainnet NEAR_RPC_URL=<mainnet RPC> ROOK_CONTRACT_ID=rook.you.near`, the role accounts and keys, `NEARAI_API_KEY` and `ROOK_SERVICE_TOKEN`.
- **Owner decision, contract key:** while `rook.you.near` keeps its full-access key, whoever holds that key can move every USDC the contract holds and replace its code. Once the testnet and first mainnet runs pass, consider deleting that key (`near account delete-keys`). The cost: the code can then never be upgraded; a fix means a new contract.
