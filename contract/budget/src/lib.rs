//! Rook budget contract, design A (docs/build-plan.md "Budget contract", docs/x402-payments-plan.md 4.1).
//!
//! The owner funds a task with USDC `ft_transfer_call`, approving one cap per subtask in the same
//! message. The signer registers a public key for subtask n; the orchestrator then funds sub-account n
//! with exactly `caps[n-1]` under that key. The signer holds the sub-account key and pays agents from
//! it, then returns the leftover with `ft_transfer_call` + `{"return":..}`. The owner gets the rest
//! back on close.
//!
//! Accounting, per task, in USDC atomic units:
//!
//! ```text
//! budget + returned == unallocated + reserve_remaining   (held by this contract for the task)
//!                    + allocated + topped_up              (sent, or being sent, to sub-accounts)
//!                    + refunded                           (sent back to the funder)
//! reserve_remaining + topped_up <= reserve   (equal until the first refund, which empties the reserve)
//! ```
//!
//! Every token the task received (its budget plus any returns) is either still here, out in a
//! sub-account (spent or not), or refunded. Steps:
//! - create: `unallocated = budget - reserve`, `reserve_remaining = reserve`, `sum(caps) <= unallocated`.
//! - fund_subtask(n): `unallocated -= caps[n-1]`, `allocated += caps[n-1]`, before the promise; undone
//!   if funding fails. Only a Failed n is funded again (fresh key and account, at most MAX_ATTEMPTS
//!   in all), so at most one attempt per n holds its cap and `allocated <= sum(caps)`.
//! - top_up: `reserve_remaining -= amount`, `topped_up += amount`, before the promise; undone on failure.
//! - return: `returned += amount`, `unallocated += amount` (leftovers can fund later subtasks, like the
//!   phase-1 ledger in services/src/orchestrator/ledger.ts).
//! - close: `refunded += unallocated + reserve_remaining`, both set to 0; undone if the refund fails,
//!   and the task goes back to the status it had before that close (Open, or Closed for a re-close).
//!
//! `ledger_check` recomputes `allocated`, `topped_up` and `returned` from the subtasks, checks both lines
//! and that every subtask's cap is its approved cap.
//!
//! If a callback never completes (its changes are undone, for example out of gas), the subtask or task
//! stays in flight. After `RESOLVE_AFTER_BLOCKS` the owner settles it with `resolve_stuck`.
//!
//! Trust model (keys split between two accounts, design A; see contract/README.md):
//! - Orchestrator key alone: can only fund approved caps into sub-accounts keyed by the signer, top
//!   them up from the reserve, record receipts and close (the refund always goes to the funder). It
//!   cannot send USDC anywhere else.
//! - Signer key alone: can only register keys for unfunded subtasks. It holds the sub-account keys, so
//!   it can spend what is already in funded sub-accounts: at most the approved caps plus top-ups.
//!   `set_signer` voids every key the old signer registered for a subtask not yet funded.
//! - Both: bounded by the approved caps plus the reserve of open tasks. `kill` / `kill_task` stop
//!   further funding. Design C (Chain Signatures) later removes the signer's key custody.
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, PublicKey,
};

/// NEAR given to each sub-account: its own storage (~0.002 NEAR for a minimal account with one key)
/// plus gas for one return `ft_transfer_call`. A first guess: measure on testnet (payments plan step 2).
pub const SUBACCOUNT_NEAR: NearToken = NearToken::from_millinear(10);
/// USDC `storage_balance_bounds` min = max = 0.00125 NEAR, read on mainnet 2026-11-07.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Free NEAR `fund_subtask` keeps on top of SUBACCOUNT_NEAR + STORAGE_DEPOSIT, for the ~350 bytes of
/// state the call adds, so the deposit `on_account_created` attaches is still there.
const STATE_MARGIN: NearToken = NearToken::from_millinear(5);
/// Blocks after a transfer started before the owner may settle it with `resolve_stuck` (about 3 hours).
/// A callback that will still run lands within a few blocks.
pub const RESOLVE_AFTER_BLOCKS: u64 = 10_000;

// Gas. NEP-141 `ft_transfer` and NEP-145 `storage_deposit` use a few Tgas each; 10 leaves headroom.
// Our callbacks only read and write a few entries and log. The callback that sends the USDC calls
// carries their gas too. Attach 100 Tgas to fund_subtask and 50 Tgas to top_up / close_task.
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_ON_ACCOUNT_CREATED: Gas =
    Gas::from_tgas(10 + 10 + 10 + 10 + 5); // own work + storage_deposit + ft_transfer + on_subtask_funded + receipt overhead

const MAX_RESERVE_BPS: u16 = 9_000;
/// Bounds per task: `close_task` walks the subtasks (at most one per approved cap), and receipts are
/// stored at this contract's cost (about 0.006 NEAR each at the string limits).
const MAX_SUBTASKS: usize = 32;
const MAX_RECEIPTS: u32 = 64;
const MAX_STR: usize = 128;
const MAX_PAGE: u32 = 50;
/// Funding attempts per subtask, first try included: a Failed n can be retried with a new key and account.
const MAX_ATTEMPTS: u32 = 3;

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
enum Msg {
    CreateTask { reserve_bps: u16, caps: Vec<U128> },
    Return { task_id: String, n: u32 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TaskStatus {
    Open,
    Closing,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SubtaskStatus {
    Funding,
    Funded,
    ToppingUp,
    Returned,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Task {
    pub funder: AccountId,
    #[serde(with = "dec")]
    pub budget: u128,
    #[serde(with = "dec")]
    pub reserve: u128,
    #[serde(with = "dec")]
    pub unallocated: u128,
    #[serde(with = "dec")]
    pub reserve_remaining: u128,
    #[serde(with = "dec")]
    pub allocated: u128,
    #[serde(with = "dec")]
    pub topped_up: u128,
    #[serde(with = "dec")]
    pub returned: u128,
    #[serde(with = "dec")]
    pub refunded: u128,
    /// Caps the owner approved at create: subtask n can only be funded with `caps[n-1]`.
    pub caps: Vec<U128>,
    pub status: TaskStatus,
    pub killed: bool,
    pub subtasks: Vec<u32>,
    pub receipts: u32,
    /// Set while the status is Closing.
    pub closing: Option<Closing>,
}

/// A refund in flight: what to put back, and where, if it fails.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Closing {
    /// Block height when close_task sent the refund.
    pub since: u64,
    #[serde(with = "dec")]
    pub unallocated: u128,
    #[serde(with = "dec")]
    pub reserve: u128,
    /// Status before this close: Open, or Closed when closing again after late returns.
    pub restore: TaskStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Subtask {
    pub n: u32,
    pub account_id: AccountId,
    /// The full-access key the signer registered; the sub-account was created with it.
    pub public_key: PublicKey,
    #[serde(with = "dec")]
    pub cap: u128,
    #[serde(with = "dec")]
    pub topped_up: u128,
    #[serde(with = "dec")]
    pub returned: u128,
    pub status: SubtaskStatus,
    /// 0 on the first funding; a retry of a Failed subtask uses account `t<task_id>-<n>-<attempt>`.
    pub attempt: u32,
    /// The sub-account was created. Stays true after a failed funding whose account creation succeeded:
    /// that account keeps its SUBACCOUNT_NEAR but holds no USDC.
    pub account_exists: bool,
    /// Block height when the last funding or top-up started.
    pub since: u64,
    /// The top-up amount in flight while ToppingUp, else 0.
    #[serde(with = "dec")]
    pub pending_top_up: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub a2a_task_id: String,
    pub agent_handle: String,
    #[serde(with = "dec")]
    pub amount: u128,
    /// "pass", "fail" or null (never judged).
    pub verdict: Option<String>,
    pub attestation_hash: Option<String>,
    pub payment_hash: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ReceiptEntry {
    pub seq: u32,
    pub n: u32,
    pub receipt: Receipt,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub orchestrator: AccountId,
    pub signer: AccountId,
    pub usdc: AccountId,
    pub killed: bool,
    pub tasks: u64,
}

/// u128 as a decimal string in JSON (same wire format as `U128`).
mod dec {
    use near_sdk::serde::{de::Error, Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        String::deserialize(d)?.parse().map_err(D::Error::custom)
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    orchestrator: AccountId,
    signer: AccountId,
    /// Bumped by `set_signer`: keys registered under an older epoch cannot be used.
    signer_epoch: u32,
    usdc: AccountId,
    killed: bool,
    next_task: u64,
    tasks: LookupMap<String, Task>,
    subtasks: LookupMap<(String, u32), Subtask>,
    /// (task id, n) -> (signer epoch, key) registered for the next funding of n; moved into the Subtask.
    keys: LookupMap<(String, u32), (u32, PublicKey)>,
    /// Sub-account id -> (task id, n), for every attempt's account: one from a failed attempt can still
    /// return USDC to subtask n.
    accounts: LookupMap<AccountId, (String, u32)>,
    /// (task id, seq) -> receipt.
    receipts: LookupMap<(String, u32), ReceiptEntry>,
}

fn emit(event: &str, data: Value) {
    let log = json!({ "standard": "rook", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

fn base36(mut v: u64) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(v % 36) as usize]);
        v /= 36;
        if v == 0 {
            break;
        }
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

/// True when the single promise this callback waits on succeeded (its return value is ignored).
fn promise_ok() -> bool {
    env::promise_results_count() == 1
        && !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

/// NEAR this account can spend without going below its storage stake.
fn free_near() -> u128 {
    let staked = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
    env::account_balance().as_yoctonear().saturating_sub(staked)
}

fn task_mut<'a>(tasks: &'a mut LookupMap<String, Task>, id: &str) -> &'a mut Task {
    tasks.get_mut(id).unwrap_or_else(|| env::panic_str("unknown task"))
}

fn sub_mut<'a>(subs: &'a mut LookupMap<(String, u32), Subtask>, id: &str, n: u32) -> &'a mut Subtask {
    subs.get_mut(&(id.to_string(), n)).unwrap_or_else(|| env::panic_str("unknown subtask"))
}

fn check_str(name: &str, s: &str, allow_empty: bool) {
    require!(s.len() <= MAX_STR, format!("{name} longer than {MAX_STR} bytes"));
    require!(allow_empty || !s.is_empty(), format!("{name} is empty"));
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, orchestrator: AccountId, signer: AccountId, usdc: AccountId) -> Self {
        require!(orchestrator != signer, "orchestrator and signer must be different accounts");
        Self {
            owner,
            orchestrator,
            signer,
            signer_epoch: 0,
            usdc,
            killed: false,
            next_task: 0,
            tasks: LookupMap::new(b"t"),
            subtasks: LookupMap::new(b"s"),
            keys: LookupMap::new(b"k"),
            accounts: LookupMap::new(b"a"),
            receipts: LookupMap::new(b"r"),
        }
    }

    // ---------- NEP-141 receiver ----------

    /// Keeps the tokens (returns 0) for a valid `create_task` or `return`; refunds everything else.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only the USDC contract can call this");
        let result = match serde_json::from_str::<Msg>(&msg) {
            Ok(Msg::CreateTask { reserve_bps, caps }) => self.create_task(sender_id, amount.0, reserve_bps, caps),
            Ok(Msg::Return { task_id, n }) => self.credit_return(&sender_id, task_id, n, amount.0),
            Err(_) => Err("msg is not a create_task or return".into()),
        };
        match result {
            Ok(()) => PromiseOrValue::Value(U128(0)),
            Err(reason) => {
                env::log_str(&format!("refunding {}: {reason}", amount.0));
                PromiseOrValue::Value(amount)
            }
        }
    }

    // ---------- signer ----------

    /// Registers the full-access key subtask n's sub-account will be created with, once per funding
    /// attempt and before it: the task must be open, `n` within its approved caps, and the subtask new or
    /// Failed with attempts left. A key registered by a previous signer is overwritten.
    pub fn register_subtask_key(&mut self, task_id: String, n: u32, public_key: PublicKey) {
        require!(env::predecessor_account_id() == self.signer, "only the signer");
        let task = self.tasks.get(&task_id).unwrap_or_else(|| env::panic_str("unknown task"));
        assert_open(task, self.killed);
        approved_cap(task, n);
        let key = (task_id.clone(), n);
        self.next_attempt(&key);
        let epoch = self.signer_epoch;
        require!(self.keys.get(&key).is_none_or(|(e, _)| *e != epoch), "key already registered");
        emit("subtask_key_registered", json!({ "task_id": task_id, "n": n, "public_key": public_key }));
        self.keys.insert(key, (epoch, public_key));
    }

    // ---------- orchestrator ----------

    /// Creates `t<task_id>-<n>.<this contract>` (`t<task_id>-<n>-<attempt>` on a retry) with the key the
    /// current signer registered, registers it on USDC and sends the approved `caps[n-1]`. Attach 100 Tgas. The allocation is taken now and given back if
    /// any step fails. Refused unless the contract has free NEAR for the account, the USDC storage deposit
    /// and its own state.
    pub fn fund_subtask(&mut self, task_id: String, n: u32) -> Promise {
        self.assert_orchestrator();
        let need = SUBACCOUNT_NEAR.as_yoctonear() + STORAGE_DEPOSIT.as_yoctonear() + STATE_MARGIN.as_yoctonear();
        require!(free_near() >= need, "not enough free NEAR on the contract to fund a subtask");
        let key = (task_id.clone(), n);
        let attempt = self.next_attempt(&key);
        let retry = if attempt == 0 { String::new() } else { format!("-{attempt}") };
        let account_id: AccountId = format!("t{task_id}-{n}{retry}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("sub-account id is invalid or longer than 64 characters"));
        let killed = self.killed;
        let task = task_mut(&mut self.tasks, &task_id);
        assert_open(task, killed);
        let cap = approved_cap(task, n);
        let (epoch, public_key) =
            self.keys.remove(&key).unwrap_or_else(|| env::panic_str("no key registered for this subtask"));
        require!(epoch == self.signer_epoch, "key was registered by a previous signer");
        require!(cap <= task.unallocated, "cap exceeds the unallocated budget");
        task.unallocated -= cap;
        task.allocated += cap;
        if attempt == 0 {
            task.subtasks.push(n);
        }
        self.subtasks.insert(
            key.clone(),
            Subtask {
                n,
                account_id: account_id.clone(),
                public_key: public_key.clone(),
                cap,
                topped_up: 0,
                returned: 0,
                status: SubtaskStatus::Funding,
                attempt,
                account_exists: false,
                since: env::block_height(),
                pending_top_up: 0,
            },
        );
        self.accounts.insert(account_id.clone(), key);
        Promise::new(account_id)
            .create_account()
            .add_full_access_key(public_key)
            .transfer(SUBACCOUNT_NEAR)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_ACCOUNT_CREATED).on_account_created(task_id, n, attempt))
    }

    /// Moves `amount` from the task's reserve to a funded sub-account. Attach 50 Tgas.
    pub fn top_up(&mut self, task_id: String, n: u32, amount: U128) -> Promise {
        self.assert_orchestrator();
        let killed = self.killed;
        let task = task_mut(&mut self.tasks, &task_id);
        assert_open(task, killed);
        require!(amount.0 > 0, "amount must be positive");
        require!(amount.0 <= task.reserve_remaining, "amount exceeds the remaining reserve");
        let sub = sub_mut(&mut self.subtasks, &task_id, n);
        require!(sub.status == SubtaskStatus::Funded, "subtask is not funded");
        task.reserve_remaining -= amount.0;
        task.topped_up += amount.0;
        sub.topped_up += amount.0;
        sub.status = SubtaskStatus::ToppingUp;
        sub.since = env::block_height();
        sub.pending_top_up = amount.0;
        let account_id = sub.account_id.clone();
        self.ft_transfer(&account_id, amount.0, format!("rook top-up t{task_id}-{n}"))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_top_up(task_id, n))
    }

    /// Appends a receipt for a paid hire; returns its seq. Works on killed tasks. On a closing or closed
    /// task only for a subtask still Funded (an owner-closed killed task), whose payments may still settle.
    pub fn record_receipt(&mut self, task_id: String, n: u32, receipt: Receipt) -> u32 {
        self.assert_orchestrator();
        let sub_status = self
            .subtasks
            .get(&(task_id.clone(), n))
            .map(|s| s.status)
            .unwrap_or_else(|| env::panic_str("unknown subtask"));
        check_str("a2a_task_id", &receipt.a2a_task_id, false);
        check_str("agent_handle", &receipt.agent_handle, false);
        check_str("payment_hash", &receipt.payment_hash, false);
        check_str("attestation_hash", receipt.attestation_hash.as_deref().unwrap_or(""), true);
        require!(
            matches!(receipt.verdict.as_deref(), None | Some("pass") | Some("fail")),
            "verdict must be pass, fail or null"
        );
        let task = task_mut(&mut self.tasks, &task_id);
        require!(
            task.status == TaskStatus::Open || sub_status == SubtaskStatus::Funded,
            "task is closed and this subtask holds no funds"
        );
        require!(task.receipts < MAX_RECEIPTS, "too many receipts");
        let seq = task.receipts;
        task.receipts += 1;
        emit(
            "receipt",
            json!({ "task_id": task_id, "n": n, "seq": seq, "agent_handle": receipt.agent_handle,
                    "amount": receipt.amount.to_string(), "verdict": receipt.verdict, "payment_hash": receipt.payment_hash }),
        );
        self.receipts.insert((task_id, seq), ReceiptEntry { seq, n, receipt });
        seq
    }

    /// Sends what the contract holds for the task back to the funder. Attach 50 Tgas.
    /// Needs every subtask Returned or Failed. The owner may close a killed task with subtasks still
    /// Funded: what they hold comes back only through returns, after which the task can be closed again.
    pub fn close_task(&mut self, task_id: String) -> PromiseOrValue<U128> {
        let caller = env::predecessor_account_id();
        let by_owner = caller == self.owner;
        require!(by_owner || caller == self.orchestrator, "only the owner or orchestrator can close");
        let task = task_mut(&mut self.tasks, &task_id);
        require!(task.status != TaskStatus::Closing, "task is closing");
        let killed = self.killed || task.killed;
        for n in &task.subtasks {
            let sub = self.subtasks.get(&(task_id.clone(), *n)).unwrap();
            match sub.status {
                SubtaskStatus::Returned | SubtaskStatus::Failed => {}
                SubtaskStatus::Funded if by_owner && killed => {}
                SubtaskStatus::Funded => env::panic_str(&format!("subtask {n} has not returned its leftover")),
                _ => env::panic_str(&format!("subtask {n} has a transfer in flight")),
            }
        }
        let (unallocated, reserve) = (task.unallocated, task.reserve_remaining);
        let refund = unallocated + reserve;
        require!(task.status == TaskStatus::Open || refund > 0, "task is already closed");
        task.unallocated = 0;
        task.reserve_remaining = 0;
        task.refunded += refund;
        if refund == 0 {
            task.status = TaskStatus::Closed;
            emit("task_closed", json!({ "task_id": task_id, "funder": task.funder, "refund": "0", "ok": true }));
            return PromiseOrValue::Value(U128(0));
        }
        task.closing = Some(Closing { since: env::block_height(), unallocated, reserve, restore: task.status });
        task.status = TaskStatus::Closing;
        let funder = task.funder.clone();
        self.ft_transfer(&funder, refund, format!("rook refund task {task_id}"))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_task_closed(task_id))
            .into()
    }

    // ---------- owner ----------

    pub fn kill(&mut self) {
        self.assert_owner();
        self.killed = true;
        emit("killed", json!({ "task_id": null }));
    }

    pub fn kill_task(&mut self, task_id: String) {
        self.assert_owner();
        task_mut(&mut self.tasks, &task_id).killed = true;
        emit("killed", json!({ "task_id": task_id }));
    }

    /// Key rotation. Attach 1 yoctoNEAR, so only a full-access key can do it (not a wallet sign-in key).
    #[payable]
    pub fn set_orchestrator(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        require!(account_id != self.signer, "orchestrator and signer must be different accounts");
        self.orchestrator = account_id;
    }

    /// Signer key rotation, like `set_orchestrator`. Voids every key registered so far for a subtask not
    /// yet funded: `fund_subtask` refuses them, and the new signer registers its own.
    #[payable]
    pub fn set_signer(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        require!(account_id != self.orchestrator, "orchestrator and signer must be different accounts");
        self.signer = account_id;
        self.signer_epoch += 1;
    }

    /// Settles a transfer whose callback never completed. `n` picks a subtask stuck in Funding or
    /// ToppingUp; without `n`, the task stuck in Closing. `arrived` says whether the USDC transfer
    /// reached its receiver: read its receipt outcome on chain first. Allowed RESOLVE_AFTER_BLOCKS after
    /// the transfer started. Attach 1 yoctoNEAR.
    #[payable]
    pub fn resolve_stuck(&mut self, task_id: String, n: Option<u32>, arrived: bool) {
        assert_one_yocto();
        self.assert_owner();
        let now = env::block_height();
        let Some(n) = n else {
            let task = task_mut(&mut self.tasks, &task_id);
            let since = task.closing.as_ref().map(|c| c.since).unwrap_or_else(|| env::panic_str("task is not closing"));
            require!(now >= since + RESOLVE_AFTER_BLOCKS, "too early: the callback may still run");
            self.finish_close(&task_id, arrived);
            return;
        };
        let sub = sub_mut(&mut self.subtasks, &task_id, n);
        require!(now >= sub.since + RESOLVE_AFTER_BLOCKS, "too early: the callback may still run");
        let (status, account_exists) = (sub.status, sub.account_exists);
        match status {
            // account_exists is set only by on_account_created, in the receipt that sends the USDC calls.
            SubtaskStatus::Funding if !account_exists => {
                require!(!arrived, "no USDC was sent: on_account_created never completed");
                self.fail_funding(&task_id, n, false, "resolved by the owner before the USDC transfer");
            }
            SubtaskStatus::Funding if arrived => self.finish_funding(&task_id, n),
            SubtaskStatus::Funding => self.fail_funding(&task_id, n, true, "resolved by the owner: transfer failed"),
            SubtaskStatus::ToppingUp => {
                self.finish_top_up(&task_id, n, arrived);
            }
            s => env::panic_str(&format!("subtask is {s:?}, nothing in flight")),
        }
    }

    // ---------- callbacks ----------

    #[private]
    pub fn on_account_created(&mut self, task_id: String, n: u32, attempt: u32) -> PromiseOrValue<bool> {
        self.assert_attempt(&task_id, n, attempt);
        let created = promise_ok();
        let task_killed = self.tasks.get(&task_id).is_none_or(|t| t.killed);
        if !created || self.killed || task_killed {
            let reason = if created { "killed before the transfer" } else { "create_account failed" };
            self.fail_funding(&task_id, n, created, reason);
            return PromiseOrValue::Value(false);
        }
        // Fail cleanly rather than panic on BalanceExceeded / LackBalanceForState, which would undo this
        // callback and leave the subtask in Funding. This callback adds no state, so the deposit is enough.
        if free_near() < STORAGE_DEPOSIT.as_yoctonear() + ONE_YOCTO.as_yoctonear() {
            self.fail_funding(&task_id, n, true, "not enough free NEAR for the USDC storage deposit");
            return PromiseOrValue::Value(false);
        }
        let sub = sub_mut(&mut self.subtasks, &task_id, n);
        require!(sub.status == SubtaskStatus::Funding, "subtask is not funding");
        sub.account_exists = true;
        // One receipt with both actions: if ft_transfer fails, storage_deposit is undone and both
        // deposits come back to this contract.
        let deposit = json!({ "account_id": sub.account_id, "registration_only": true });
        let transfer = json!({ "receiver_id": sub.account_id, "amount": U128(sub.cap), "memo": format!("rook t{task_id}-{n}") });
        Promise::new(self.usdc.clone())
            .function_call("storage_deposit", deposit.to_string(), STORAGE_DEPOSIT, GAS_STORAGE_DEPOSIT)
            .function_call("ft_transfer", transfer.to_string(), ONE_YOCTO, GAS_FT_TRANSFER)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_subtask_funded(task_id, n, attempt))
            .into()
    }

    #[private]
    pub fn on_subtask_funded(&mut self, task_id: String, n: u32, attempt: u32) -> bool {
        self.assert_attempt(&task_id, n, attempt);
        if !promise_ok() {
            self.fail_funding(&task_id, n, true, "storage_deposit or ft_transfer failed");
            return false;
        }
        self.finish_funding(&task_id, n);
        true
    }

    #[private]
    pub fn on_top_up(&mut self, task_id: String, n: u32) -> bool {
        self.finish_top_up(&task_id, n, promise_ok())
    }

    #[private]
    pub fn on_task_closed(&mut self, task_id: String) -> bool {
        self.finish_close(&task_id, promise_ok())
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            orchestrator: self.orchestrator.clone(),
            signer: self.signer.clone(),
            usdc: self.usdc.clone(),
            killed: self.killed,
            tasks: self.next_task,
        }
    }

    pub fn get_task(&self, task_id: String) -> Option<Task> {
        self.tasks.get(&task_id).cloned()
    }

    pub fn get_subtasks(&self, task_id: String) -> Vec<Subtask> {
        let Some(task) = self.tasks.get(&task_id) else { return vec![] };
        task.subtasks.iter().filter_map(|n| self.subtasks.get(&(task_id.clone(), *n)).cloned()).collect()
    }

    pub fn get_receipts(&self, task_id: String, from: Option<u32>, limit: Option<u32>) -> Vec<ReceiptEntry> {
        let Some(task) = self.tasks.get(&task_id) else { return vec![] };
        let from = from.unwrap_or(0);
        let to = from.saturating_add(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE)).min(task.receipts);
        (from..to).filter_map(|seq| self.receipts.get(&(task_id.clone(), seq)).cloned()).collect()
    }

    /// Recomputes the task's accounting from its subtasks (see the top of this file).
    pub fn ledger_check(&self, task_id: String) -> bool {
        let Some(t) = self.tasks.get(&task_id) else { return false };
        let (mut allocated, mut topped_up, mut returned, mut caps_ok) = (0u128, 0u128, 0u128, true);
        for sub in self.get_subtasks(task_id) {
            if sub.status != SubtaskStatus::Failed {
                allocated += sub.cap;
            }
            topped_up += sub.topped_up;
            returned += sub.returned;
            caps_ok &= t.caps.get(sub.n as usize - 1).map(|c| c.0) == Some(sub.cap);
        }
        caps_ok
            && allocated == t.allocated
            && topped_up == t.topped_up
            && returned == t.returned
            && t.reserve_remaining + t.topped_up <= t.reserve
            && (t.refunded > 0 || t.reserve_remaining + t.topped_up == t.reserve)
            && t.budget + t.returned == t.unallocated + t.reserve_remaining + t.allocated + t.topped_up + t.refunded
    }
}

fn assert_open(task: &Task, contract_killed: bool) {
    require!(!contract_killed, "contract is killed");
    require!(!task.killed, "task is killed");
    require!(task.status == TaskStatus::Open, "task is not open");
}

/// The cap the owner approved for subtask `n` (1-based).
fn approved_cap(task: &Task, n: u32) -> u128 {
    let i = (n as usize).checked_sub(1).filter(|i| *i < task.caps.len());
    i.map(|i| task.caps[i].0).unwrap_or_else(|| env::panic_str("n is not an approved subtask"))
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    fn assert_orchestrator(&self) {
        require!(env::predecessor_account_id() == self.orchestrator, "only the orchestrator");
    }

    /// The next funding attempt for (task id, n): 0 for a new subtask, +1 for a Failed one.
    fn next_attempt(&self, key: &(String, u32)) -> u32 {
        match self.subtasks.get(key) {
            None => 0,
            Some(s) if s.status == SubtaskStatus::Failed => {
                require!(s.attempt + 1 < MAX_ATTEMPTS, "no funding attempts left for this subtask");
                s.attempt + 1
            }
            Some(_) => env::panic_str("subtask already exists"),
        }
    }

    /// A funding callback must belong to the subtask's current attempt, not one resolved and retried since.
    fn assert_attempt(&self, task_id: &str, n: u32, attempt: u32) {
        let current = self.subtasks.get(&(task_id.to_string(), n)).map(|s| s.attempt);
        require!(current == Some(attempt), "callback for an earlier funding attempt");
    }

    fn ft_transfer(&self, receiver_id: &AccountId, amount: u128, memo: String) -> Promise {
        let args = json!({ "receiver_id": receiver_id, "amount": U128(amount), "memo": memo });
        Promise::new(self.usdc.clone()).function_call("ft_transfer", args.to_string(), ONE_YOCTO, GAS_FT_TRANSFER)
    }

    fn create_task(&mut self, funder: AccountId, amount: u128, reserve_bps: u16, caps: Vec<U128>) -> Result<(), String> {
        if self.killed {
            return Err("contract is killed".into());
        }
        if funder != self.owner {
            return Err("only the owner funds tasks".into());
        }
        if amount == 0 || reserve_bps > MAX_RESERVE_BPS {
            return Err(format!("need amount > 0 and reserve_bps <= {MAX_RESERVE_BPS}"));
        }
        let reserve = amount.checked_mul(reserve_bps.into()).ok_or("amount too large")? / 10_000;
        if caps.is_empty() || caps.len() > MAX_SUBTASKS || caps.iter().any(|c| c.0 == 0) {
            return Err(format!("need 1 to {MAX_SUBTASKS} caps, each > 0"));
        }
        let total = caps.iter().try_fold(0u128, |s, c| s.checked_add(c.0));
        if total.is_none_or(|t| t > amount - reserve) {
            return Err("caps add up to more than budget - reserve".into());
        }
        let task_id = base36(self.next_task);
        self.next_task += 1;
        emit(
            "task_created",
            json!({ "task_id": task_id, "funder": funder, "budget": amount.to_string(), "reserve": reserve.to_string(), "caps": caps }),
        );
        self.tasks.insert(
            task_id,
            Task {
                funder,
                budget: amount,
                reserve,
                unallocated: amount - reserve,
                reserve_remaining: reserve,
                allocated: 0,
                topped_up: 0,
                returned: 0,
                refunded: 0,
                caps,
                status: TaskStatus::Open,
                killed: false,
                subtasks: vec![],
                receipts: 0,
                closing: None,
            },
        );
        Ok(())
    }

    fn credit_return(&mut self, sender: &AccountId, task_id: String, n: u32, amount: u128) -> Result<(), String> {
        let key = (task_id, n);
        if self.accounts.get(sender) != Some(&key) {
            return Err("sender is not that subtask's account".into());
        }
        let task = self.tasks.get_mut(&key.0).ok_or("unknown task")?;
        if task.status == TaskStatus::Closing {
            return Err("task is closing".into());
        }
        let sub = self.subtasks.get_mut(&key).ok_or("unknown subtask")?;
        if !matches!(sub.status, SubtaskStatus::Funded | SubtaskStatus::Returned) {
            return Err(format!("subtask is {:?}", sub.status));
        }
        sub.returned += amount;
        sub.status = SubtaskStatus::Returned;
        task.returned += amount;
        task.unallocated += amount;
        emit("returned", json!({ "task_id": key.0, "n": n, "account_id": sender, "amount": amount.to_string() }));
        Ok(())
    }

    fn finish_funding(&mut self, task_id: &str, n: u32) {
        let sub = sub_mut(&mut self.subtasks, task_id, n);
        require!(sub.status == SubtaskStatus::Funding, "subtask is not funding");
        sub.status = SubtaskStatus::Funded;
        emit(
            "subtask_funded",
            json!({ "task_id": task_id, "n": n, "account_id": sub.account_id, "cap": sub.cap.to_string() }),
        );
    }

    fn finish_top_up(&mut self, task_id: &str, n: u32, ok: bool) -> bool {
        let sub = sub_mut(&mut self.subtasks, task_id, n);
        require!(sub.status == SubtaskStatus::ToppingUp, "subtask is not topping up");
        let amount = std::mem::take(&mut sub.pending_top_up);
        sub.status = SubtaskStatus::Funded;
        if !ok {
            sub.topped_up -= amount;
            let task = task_mut(&mut self.tasks, task_id);
            task.topped_up -= amount;
            task.reserve_remaining += amount;
        }
        emit("top_up", json!({ "task_id": task_id, "n": n, "amount": amount.to_string(), "ok": ok }));
        ok
    }

    fn finish_close(&mut self, task_id: &str, ok: bool) -> bool {
        let task = task_mut(&mut self.tasks, task_id);
        require!(task.status == TaskStatus::Closing, "task is not closing");
        let c = task.closing.take().unwrap_or_else(|| env::panic_str("task is not closing"));
        let refund = c.unallocated + c.reserve;
        if ok {
            task.status = TaskStatus::Closed;
        } else {
            task.status = c.restore;
            task.refunded -= refund;
            task.unallocated += c.unallocated;
            task.reserve_remaining += c.reserve;
        }
        emit(
            "task_closed",
            json!({ "task_id": task_id, "funder": task.funder, "refund": refund.to_string(), "ok": ok }),
        );
        ok
    }

    fn fail_funding(&mut self, task_id: &str, n: u32, account_exists: bool, reason: &str) {
        let sub = sub_mut(&mut self.subtasks, task_id, n);
        require!(sub.status == SubtaskStatus::Funding, "subtask is not funding");
        sub.status = SubtaskStatus::Failed;
        sub.account_exists = account_exists;
        let task = task_mut(&mut self.tasks, task_id);
        task.allocated -= sub.cap;
        task.unallocated += sub.cap;
        emit(
            "subtask_funding_failed",
            json!({ "task_id": task_id, "n": n, "account_id": sub.account_id, "account_exists": account_exists, "reason": reason }),
        );
    }
}

#[cfg(test)]
mod tests;
